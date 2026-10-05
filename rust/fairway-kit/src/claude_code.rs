//! Claude Code runner: drives the `claude` CLI in `--output-format
//! stream-json` mode and maps its message stream onto protocol events —
//! the Rust counterpart of the TS adapter (which rides the JS Agent SDK; the
//! SDK itself spawns this same CLI, so the two speak to the same engine).
//!
//! Mapping (mirrors adapters/claude-code.ts):
//!   stream_event content_block_delta / text_delta      → text (coalesced)
//!   stream_event content_block_delta / thinking_delta  → thinking (coalesced)
//!   assistant message text block                       → text_block (authoritative)
//!   assistant message tool_use block                   → tool_call
//!   user message tool_result block                     → tool_result
//!   result                                             → resume token + final content
//!
//! Capability delta vs the TS adapter, v0.1: no interactive HITL permission
//! gate (the CLI's control-protocol permission callback isn't wired yet) —
//! pre-approve with `allowed_tools` / block with `disallowed_tools`, or run a
//! `permission_mode` the host trusts. Interrupt is supported: cancelling the
//! turn kills the subprocess.
//!
//! Auth is inherited from the environment, exactly like running `claude`
//! yourself: a stored subscription login, or ANTHROPIC_API_KEY. `env` entries
//! override the inherited environment per spawn.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

use crate::events as ev;
use crate::jobs::{Runner, TurnContext, TurnHandle, TurnResult};

const FLUSH_INTERVAL: Duration = Duration::from_millis(150);
const FLUSH_MIN_CHARS: usize = 48;
const RESULT_SUMMARY_MAX: usize = 200;

type SystemPromptFn = dyn Fn(&TurnContext) -> String + Send + Sync;

pub struct ClaudeCodeConfig {
    pub model: Option<String>,
    pub cwd: Option<std::path::PathBuf>,
    /// Pre-approved by the CLI before any gate would run.
    pub allowed_tools: Vec<String>,
    /// Blocked entirely (never offered to the agent).
    pub disallowed_tools: Vec<String>,
    pub permission_mode: Option<String>,
    pub system_prompt: Option<Arc<SystemPromptFn>>,
    /// Extra subprocess environment (overrides inherited entries).
    pub env: HashMap<String, String>,
    /// Path to the CLI binary. Default: "claude" on PATH.
    pub binary: String,
    /// MCP server config JSON, passed via --mcp-config (as inline JSON).
    pub mcp_config: Option<Value>,
    pub tool_meta: HashMap<String, ToolMeta>,
}

impl Default for ClaudeCodeConfig {
    fn default() -> Self {
        ClaudeCodeConfig {
            model: None,
            cwd: None,
            allowed_tools: Vec::new(),
            disallowed_tools: Vec::new(),
            permission_mode: None,
            system_prompt: None,
            env: HashMap::new(),
            binary: "claude".into(),
            mcp_config: None,
            tool_meta: default_tool_meta(),
        }
    }
}

/// Display metadata for a tool (PROTOCOL.md §3: server-derived, never client maps).
#[derive(Clone)]
pub struct ToolMeta {
    pub kind: &'static str,
    pub label: &'static str,
    /// Input key whose value becomes the `detail` field (truncated).
    pub detail_key: Option<&'static str>,
}

pub fn default_tool_meta() -> HashMap<String, ToolMeta> {
    // Mirrors DEFAULT_TOOL_META in js/packages/agent/src/toolkit.ts.
    let mut m = HashMap::new();
    let mut ins = |name: &str, kind, label, key| {
        m.insert(name.to_string(), ToolMeta { kind, label, detail_key: key });
    };
    ins("Read", "file", "Read file", Some("file_path"));
    ins("Write", "file-write", "Write file", Some("file_path"));
    ins("Edit", "file-write", "Edit file", Some("file_path"));
    ins("Bash", "shell", "Run command", Some("command"));
    ins("Glob", "search", "Find files", Some("pattern"));
    ins("Grep", "search", "Search code", Some("pattern"));
    ins("WebSearch", "web", "Web search", Some("query"));
    ins("WebFetch", "web", "Fetch page", Some("url"));
    m
}

pub struct ClaudeCodeRunner {
    config: ClaudeCodeConfig,
}

impl ClaudeCodeRunner {
    pub fn new(config: ClaudeCodeConfig) -> Self {
        ClaudeCodeRunner { config }
    }
}

/// Coalesce rapid deltas before emission (§4.3: before seq assignment, so the
/// wire and the log stay identical).
struct Coalescer<'a> {
    turn: &'a TurnHandle,
    kind: &'static str, // "text" | "thinking"
    buf: String,
    last_flush: Instant,
}

impl<'a> Coalescer<'a> {
    fn new(turn: &'a TurnHandle) -> Self {
        Coalescer { turn, kind: "text", buf: String::new(), last_flush: Instant::now() }
    }

    async fn add(&mut self, kind: &'static str, text: &str) -> Result<(), String> {
        if kind != self.kind && !self.buf.is_empty() {
            self.flush().await?;
        }
        self.kind = kind;
        self.buf.push_str(text);
        if self.buf.len() >= FLUSH_MIN_CHARS || self.last_flush.elapsed() >= FLUSH_INTERVAL {
            self.flush().await?;
        }
        Ok(())
    }

    async fn flush(&mut self) -> Result<(), String> {
        if self.buf.is_empty() {
            self.last_flush = Instant::now();
            return Ok(());
        }
        let content = std::mem::take(&mut self.buf);
        let event = if self.kind == "thinking" { ev::thinking(&content) } else { ev::text(&content) };
        self.turn.emit(event).await?;
        self.last_flush = Instant::now();
        Ok(())
    }

    /// An authoritative text_block supersedes the streamed tail: drop it.
    fn drop_pending_text(&mut self) {
        if self.kind == "text" {
            self.buf.clear();
        }
    }
}

#[async_trait]
impl Runner for ClaudeCodeRunner {
    async fn run(&self, turn: &TurnHandle) -> Result<TurnResult, String> {
        let ctx = turn.ctx();
        let cfg = &self.config;

        let mut cmd = Command::new(&cfg.binary);
        cmd.arg("--print")
            .arg("--output-format")
            .arg("stream-json")
            .arg("--verbose")
            .arg("--include-partial-messages");
        if let Some(model) = &cfg.model {
            cmd.arg("--model").arg(model);
        }
        if let Some(mode) = &cfg.permission_mode {
            cmd.arg("--permission-mode").arg(mode);
        }
        if !cfg.allowed_tools.is_empty() {
            cmd.arg("--allowed-tools").arg(cfg.allowed_tools.join(","));
        }
        if !cfg.disallowed_tools.is_empty() {
            cmd.arg("--disallowed-tools").arg(cfg.disallowed_tools.join(","));
        }
        if let Some(mcp) = &cfg.mcp_config {
            cmd.arg("--mcp-config").arg(mcp.to_string()).arg("--strict-mcp-config");
        }
        if let Some(sp) = &cfg.system_prompt {
            cmd.arg("--append-system-prompt").arg(sp(ctx));
        }
        if let Some(resume) = &ctx.provider_session_id {
            cmd.arg("--resume").arg(resume);
        }
        if let Some(cwd) = &cfg.cwd {
            cmd.current_dir(cwd);
        }
        for (k, v) in &cfg.env {
            cmd.env(k, v);
        }
        cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        cmd.kill_on_drop(true);

        let mut child = cmd.spawn().map_err(|e| format!("failed to spawn {}: {e}", cfg.binary))?;
        let mut stdin = child.stdin.take().ok_or("no stdin")?;
        let stdout = child.stdout.take().ok_or("no stdout")?;
        let stderr = child.stderr.take().ok_or("no stderr")?;

        stdin
            .write_all(ctx.user_content.as_bytes())
            .await
            .map_err(|e| e.to_string())?;
        drop(stdin);

        // Collect stderr in the background for error reporting.
        let stderr_task = tokio::spawn(async move {
            let mut out = String::new();
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                out.push_str(&line);
                out.push('\n');
            }
            out
        });

        let cancel = turn.cancel_token();
        let mut lines = BufReader::new(stdout).lines();
        let mut coalescer = Coalescer::new(turn);
        let mut final_content = String::new();
        let mut error: Option<String> = None;

        loop {
            let line = tokio::select! {
                _ = cancel.cancelled() => {
                    let _ = child.kill().await;
                    return Err("cancelled".into());
                }
                line = lines.next_line() => line.map_err(|e| e.to_string())?,
            };
            let Some(line) = line else { break };
            let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
            let msg_type = msg.get("type").and_then(Value::as_str).unwrap_or("");

            match msg_type {
                "system" => {
                    if msg.get("subtype").and_then(Value::as_str) == Some("init") {
                        if let Some(sid) = msg.get("session_id").and_then(Value::as_str) {
                            turn.set_provider_session_id(sid.to_string());
                        }
                    }
                }
                "stream_event" => {
                    let event = &msg["event"];
                    if event.get("type").and_then(Value::as_str) == Some("content_block_delta") {
                        let delta = &event["delta"];
                        match delta.get("type").and_then(Value::as_str) {
                            Some("text_delta") => {
                                if let Some(t) = delta.get("text").and_then(Value::as_str) {
                                    coalescer.add("text", t).await?;
                                }
                            }
                            Some("thinking_delta") => {
                                if let Some(t) = delta.get("thinking").and_then(Value::as_str) {
                                    coalescer.add("thinking", t).await?;
                                }
                            }
                            _ => {}
                        }
                    }
                }
                "assistant" => {
                    for block in blocks(&msg) {
                        match block.get("type").and_then(Value::as_str) {
                            Some("text") => {
                                if let Some(t) = block.get("text").and_then(Value::as_str) {
                                    coalescer.drop_pending_text();
                                    turn.emit(ev::text_block(t)).await?;
                                }
                            }
                            Some("tool_use") => {
                                coalescer.flush().await?;
                                let id = block.get("id").and_then(Value::as_str).unwrap_or("");
                                let name = block.get("name").and_then(Value::as_str).unwrap_or("");
                                let input = block.get("input").cloned();
                                let (tool, kind, label, detail) =
                                    resolve_meta(name, input.as_ref(), &cfg.tool_meta);
                                turn.emit(ev::tool_call(
                                    id,
                                    &tool,
                                    kind,
                                    &label,
                                    detail.as_deref(),
                                    input,
                                ))
                                .await?;
                            }
                            _ => {}
                        }
                    }
                }
                "user" => {
                    for block in blocks(&msg) {
                        if block.get("type").and_then(Value::as_str) == Some("tool_result") {
                            coalescer.flush().await?;
                            let id =
                                block.get("tool_use_id").and_then(Value::as_str).unwrap_or("");
                            let ok = block.get("is_error").and_then(Value::as_bool) != Some(true);
                            let summary = result_summary(block);
                            turn.emit(ev::tool_result(id, ok, summary.as_deref(), None)).await?;
                        }
                    }
                }
                "result" => {
                    if let Some(sid) = msg.get("session_id").and_then(Value::as_str) {
                        turn.set_provider_session_id(sid.to_string());
                    }
                    let subtype = msg.get("subtype").and_then(Value::as_str).unwrap_or("");
                    if subtype == "success" {
                        final_content = msg
                            .get("result")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string();
                    } else {
                        error = Some(
                            msg.get("result")
                                .and_then(Value::as_str)
                                .map(String::from)
                                .unwrap_or_else(|| format!("claude exited: {subtype}")),
                        );
                    }
                }
                _ => {}
            }
        }
        coalescer.flush().await?;

        let status = child.wait().await.map_err(|e| e.to_string())?;
        if let Some(e) = error {
            return Err(e);
        }
        if !status.success() {
            let stderr_out = stderr_task.await.unwrap_or_default();
            let tail: String = stderr_out.lines().rev().take(5).collect::<Vec<_>>().join(" | ");
            return Err(format!("claude exited with {status}: {tail}"));
        }
        Ok(TurnResult { content: final_content, reason: None })
    }
}

fn blocks(msg: &Value) -> Vec<&Value> {
    msg.get("message")
        .and_then(|m| m.get("content"))
        .and_then(Value::as_array)
        .map(|a| a.iter().collect())
        .unwrap_or_default()
}

/// Resolve a (possibly `mcp__server__tool`-prefixed) name against the meta map.
fn resolve_meta(
    raw: &str,
    input: Option<&Value>,
    meta: &HashMap<String, ToolMeta>,
) -> (String, &'static str, String, Option<String>) {
    let name = raw.rsplit("__").next().unwrap_or(raw).to_string();
    match meta.get(&name) {
        Some(m) => {
            let detail = m
                .detail_key
                .and_then(|k| input.and_then(|i| i.get(k)).and_then(Value::as_str))
                .map(|s| s.chars().take(80).collect());
            (name, m.kind, m.label.to_string(), detail)
        }
        None => (name.clone(), "tool", name, None),
    }
}

fn result_summary(block: &Value) -> Option<String> {
    let text = match block.get("content") {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|p| p.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join(" "),
        _ => return None,
    };
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.chars().take(RESULT_SUMMARY_MAX).collect())
}
