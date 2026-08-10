/** Claude Agent SDK runner adapter (Node).
 *
 * Maps Claude Agent SDK messages -> protocol events (PROTOCOL.md 3):
 *
 *   stream_event content_block_delta/text_delta      -> text (coalesced)
 *   stream_event content_block_delta/thinking_delta  -> thinking (coalesced)
 *   assistant / TextBlock                            -> text_block (authoritative)
 *   assistant / ToolUseBlock                         -> tool_call (metadata from toolMeta)
 *   user / ToolResultBlock                           -> tool_result (matched by tool_use id)
 *   result                                           -> TurnResult + session-id round-trip
 *
 * Cancellation flows through an AbortController wired to ctx.signal and exposed
 * as ctx.gracefulStop, so JobRegistry.stop() interrupts the live turn.
 *
 * `@anthropic-ai/claude-agent-sdk` is an optional dependency — install it only
 * to use this adapter (npm install @anthropic-ai/claude-agent-sdk).
 *
 * ## Auth modes
 *
 * The SDK spawns the `claude` CLI, which resolves credentials from its
 * subprocess environment: an ANTHROPIC_API_KEY wins over the CLI's stored
 * subscription login. The subprocess inherits this process's env and merges
 * options.env over it, so:
 *
 * - auth="api"          — pass apiKey (or the inherited ANTHROPIC_API_KEY);
 *                         throws if neither is available.
 * - auth="subscription" — blank ANTHROPIC_API_KEY so an exported key can't
 *                         shadow the CLI's OAuth login; optionally pass
 *                         oauthToken (from `claude setup-token`).
 * - auth="inherit"      — (default) leave the environment alone.
 */

import { readFile } from "node:fs/promises";
import * as E from "../events.js";
import type { Emit, Runner, TurnContext } from "../types.js";

export type AuthMode = "api" | "subscription" | "inherit";

// Coalesce streamed deltas so the wire (and therefore the event log — they are
// the same, PROTOCOL.md 4.3) isn't one event per token.
const FLUSH_INTERVAL_MS = 150;
const FLUSH_MIN_CHARS = 48;
const HISTORY_FALLBACK_TURNS = 20;
// Images above this size are dropped with a note: the CLI's JSON message buffer
// rejects oversized payloads, and base64 inflates by ~4/3.
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;

/** Display metadata for one tool, injected into tool_call events so clients
 * never keep their own name->label maps (PROTOCOL.md 3). */
export interface ToolMeta {
  kind: string;
  label: string;
  detail?: (input: Record<string, unknown>) => string | null | undefined;
}

export const DEFAULT_TOOL_META: Record<string, ToolMeta> = {
  Read: { kind: "file", label: "Read file", detail: (i) => str(i.file_path) },
  Write: { kind: "file-write", label: "Write file", detail: (i) => str(i.file_path) },
  Edit: { kind: "file-write", label: "Edit file", detail: (i) => str(i.file_path) },
  Bash: { kind: "shell", label: "Run command", detail: (i) => str(i.command)?.slice(0, 80) || null },
  Glob: { kind: "search", label: "Find files", detail: (i) => str(i.pattern) },
  Grep: { kind: "search", label: "Search code", detail: (i) => str(i.pattern) },
  WebSearch: { kind: "web", label: "Web search", detail: (i) => str(i.query) },
  WebFetch: { kind: "web", label: "Fetch page", detail: (i) => str(i.url) },
};

export interface ClaudeRunnerConfig {
  model?: string;
  auth?: AuthMode;
  apiKey?: string; // auth="api": explicit key (else inherited env)
  oauthToken?: string; // auth="subscription": `claude setup-token` output
  allowedTools?: string[]; // pre-approved by the SDK before the gate runs
  maxTurns?: number;
  permissionMode?: string;
  cwd?: string;
  systemPrompt?: (ctx: TurnContext) => string;
  toolMeta?: Record<string, ToolMeta>;
  mcpServers?: Record<string, unknown>;
  // Safe by default: strict mode stops the CLI loading user/project MCP servers,
  // which would silently widen the agent's tool surface beyond what the app declared.
  strictMcpConfig?: boolean;
  env?: Record<string, string>; // extra subprocess env
  flushIntervalMs?: number;
  flushMinChars?: number;
  // Test seam: replaces the SDK's query(). Async generator over SDK messages.
  queryFn?: (args: { prompt: unknown; options: Record<string, unknown> }) => AsyncIterable<SdkMessage>;
}

/** Build a Runner from config. Pass it as the `runner` to createAgentChat. */
export function claudeSDKRunner(config: ClaudeRunnerConfig = {}): Runner {
  const toolMeta = config.toolMeta ?? DEFAULT_TOOL_META;
  const flushMs = config.flushIntervalMs ?? FLUSH_INTERVAL_MS;
  const flushChars = config.flushMinChars ?? FLUSH_MIN_CHARS;

  return async function run(ctx, emit) {
    const queryFn = config.queryFn ?? (await loadQuery());
    const controller = new AbortController();
    // Both the graceful interrupt and a hard stop map to abort() here.
    ctx.gracefulStop = async () => controller.abort();
    if (ctx.signal.aborted) controller.abort();
    else ctx.signal.addEventListener("abort", () => controller.abort(), { once: true });

    const coalescer = new Coalescer(emit, flushMs, flushChars);
    const textParts: string[] = [];
    let errorResult: string | null = null;

    const prompt = await buildPrompt(ctx, config);
    const options: Record<string, unknown> = {
      model: config.model ?? "claude-opus-4-8",
      allowedTools: config.allowedTools ?? [],
      maxTurns: config.maxTurns ?? 100,
      permissionMode: config.permissionMode ?? "default",
      cwd: config.cwd,
      mcpServers: config.mcpServers ?? {},
      strictMcpConfig: config.strictMcpConfig ?? true,
      systemPrompt: config.systemPrompt ? config.systemPrompt(ctx) : undefined,
      resume: ctx.providerSessionId ?? undefined,
      includePartialMessages: true, // stream_event deltas for live typing
      env: buildEnv(config),
      abortController: controller,
      canUseTool: buildCanUseTool(ctx, toolMeta, config.permissionMode ?? "default"),
    };

    try {
      for await (const msg of queryFn({ prompt, options })) {
        if (msg.type === "stream_event") {
          await onStreamEvent(msg, coalescer);
        } else if (msg.type === "assistant") {
          for (const block of msg.message?.content ?? []) {
            if (block.type === "text" && typeof block.text === "string") {
              coalescer.dropPending("text");
              textParts.push(block.text);
              await emit(E.textBlock(block.text));
            } else if (block.type === "thinking") {
              coalescer.dropPending("thinking");
            } else if (block.type === "tool_use") {
              await coalescer.flush();
              await emit(toolCallEvent(block, toolMeta));
            }
          }
        } else if (msg.type === "user") {
          const content = Array.isArray(msg.message?.content) ? msg.message!.content : [];
          for (const block of content) {
            if (block.type === "tool_result") {
              await coalescer.flush();
              await emit(
                E.toolResult(
                  String(block.tool_use_id),
                  !block.is_error,
                  summarizeResult(block.content) ?? undefined,
                ),
              );
            }
          }
        } else if (msg.type === "result") {
          if (msg.session_id) ctx.newProviderSessionId = msg.session_id;
          if (msg.subtype && msg.subtype !== "success")
            errorResult = msg.result || `agent error (${msg.subtype})`;
        }
      }
    } finally {
      ctx.gracefulStop = undefined;
      await coalescer.flush();
    }

    if (errorResult !== null) throw new Error(errorResult);
    return { content: textParts.filter(Boolean).join("\n\n") };
  };
}

// -- SDK loading + auth -------------------------------------------------------

type QueryFn = (args: { prompt: unknown; options: Record<string, unknown> }) => AsyncIterable<SdkMessage>;

async function loadQuery(): Promise<QueryFn> {
  // Variable specifier so tsc doesn't require the SDK to be installed to build:
  // it's an optional dependency, installed only to use this adapter.
  const spec = "@anthropic-ai/claude-agent-sdk";
  let sdk: { query?: QueryFn };
  try {
    sdk = await import(spec);
  } catch {
    throw new Error(
      "claudeSDKRunner needs @anthropic-ai/claude-agent-sdk: npm install @anthropic-ai/claude-agent-sdk",
    );
  }
  if (typeof sdk.query !== "function") throw new Error("claude-agent-sdk has no query() export");
  return sdk.query;
}

function buildEnv(config: ClaudeRunnerConfig): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...config.env };
  if (config.auth === "api") {
    const key = config.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error("claudeSDKRunner({auth:'api'}) requires apiKey or ANTHROPIC_API_KEY");
    env.ANTHROPIC_API_KEY = key;
  } else if (config.auth === "subscription") {
    // An exported API key would win over the CLI's subscription login; blank it.
    env.ANTHROPIC_API_KEY = "";
    if (config.oauthToken) env.CLAUDE_CODE_OAUTH_TOKEN = config.oauthToken;
  }
  return env;
}

// -- permission gate ----------------------------------------------------------

function buildCanUseTool(
  ctx: TurnContext,
  toolMeta: Record<string, ToolMeta>,
  permissionMode: string,
) {
  // Only meaningful when the mode leaves decisions to the callback; the SDK
  // shadows it under bypassPermissions/dontAsk.
  if (!ctx.requestPermission || permissionMode === "bypassPermissions" || permissionMode === "dontAsk")
    return undefined;
  const requestPermission = ctx.requestPermission;
  return async function canUseTool(toolName: string, input: unknown) {
    const name = stripMcpPrefix(toolName);
    const meta = toolMeta[name] ?? { kind: "unknown", label: name };
    const inputObj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
    let detail: string | null | undefined;
    try {
      detail = meta.detail?.(inputObj);
    } catch {
      detail = undefined; // detail is cosmetic
    }
    const decision = await requestPermission({
      tool: name,
      kind: meta.kind,
      label: meta.label,
      detail: detail ?? undefined,
      input: inputObj,
    });
    if (decision === "allow" || decision === "allow_session")
      return { behavior: "allow" as const, updatedInput: inputObj };
    return { behavior: "deny" as const, message: "The user denied permission for this tool call." };
  };
}

// -- prompt building ----------------------------------------------------------

async function buildPrompt(ctx: TurnContext, config: ClaudeRunnerConfig): Promise<unknown> {
  const text = withFileNotes(baseText(ctx), ctx);
  const images = ctx.attachments.filter(
    (a): a is Att => isAtt(a) && !!a.path && String(a.media_type ?? "").startsWith("image/"),
  );
  if (!images.length) return text;
  return imageContentPrompt(text, images);
}

function baseText(ctx: TurnContext): string {
  // SDK-side session resume is the primary continuity mechanism; inject a compact
  // history block ONLY when there is no resume token (doing both double-feeds).
  if (ctx.providerSessionId || !ctx.messages.length) return ctx.userContent;
  const recent = ctx.messages.slice(-HISTORY_FALLBACK_TURNS);
  const lines = recent
    .filter((m) => m.content)
    .map((m) => `${cap(m.role)}: ${m.content}`);
  return `<conversation_history>\n${lines.join("\n")}\n</conversation_history>\n\n${ctx.userContent}`;
}

function withFileNotes(prompt: string, ctx: TurnContext): string {
  const files = ctx.attachments.filter(
    (a): a is Att => isAtt(a) && !!a.path && !String(a.media_type ?? "").startsWith("image/"),
  );
  if (!files.length) return prompt;
  const notes = files.map((a) => `- ${a.name ?? "file"} (${a.media_type ?? "?"}): ${a.path}`).join("\n");
  return `${prompt}\n\n<attached_files>\n${notes}\n</attached_files>`;
}

/** Wrap the prompt as the SDK's streaming-input shape so image content blocks
 * can ride along with the text. */
async function* imageContentPrompt(text: string, images: Att[]): AsyncGenerator<unknown> {
  const blocks: Record<string, unknown>[] = [];
  for (const att of images) {
    let data: Buffer;
    try {
      data = await readFile(att.path!);
    } catch {
      blocks.push({ type: "text", text: `[Attached image missing: ${att.name}]` });
      continue;
    }
    if (data.length > MAX_IMAGE_BYTES) {
      blocks.push({ type: "text", text: `[Attached image too large to inline: ${att.name} at ${att.path}]` });
      continue;
    }
    blocks.push({
      type: "image",
      source: { type: "base64", media_type: att.media_type ?? "image/png", data: data.toString("base64") },
    });
  }
  blocks.push({ type: "text", text });
  yield { type: "user", message: { role: "user", content: blocks }, parent_tool_use_id: null };
}

// -- stream coalescing --------------------------------------------------------

/** Batches streamed deltas before they hit the (durable) event stream:
 * coalescing happens before seq assignment, so wire == log (PROTOCOL.md 4.3). */
class Coalescer {
  private kind: "text" | "thinking" | null = null;
  private buf: string[] = [];
  private lastFlush = 0;
  constructor(private emit: Emit, private intervalMs: number, private minChars: number) {}

  async add(kind: "text" | "thinking", content: string): Promise<void> {
    if (this.kind !== null && this.kind !== kind) await this.flush();
    this.kind = kind;
    this.buf.push(content);
    const len = this.buf.reduce((n, c) => n + c.length, 0);
    if (len >= this.minChars || this.elapsed() >= this.intervalMs) await this.flush();
  }

  async flush(): Promise<void> {
    if (this.buf.length && this.kind) {
      const content = this.buf.join("");
      await this.emit(this.kind === "text" ? E.text(content) : E.thinking(content));
    }
    this.buf = [];
    this.lastFlush = clock();
  }

  /** Discard buffered deltas of `kind`: the authoritative block for the run has
   * arrived (text_block replaces the streamed run on fold). */
  dropPending(kind: "text" | "thinking"): void {
    if (this.kind === kind) this.buf = [];
    else void this.flush();
  }

  private elapsed(): number {
    return this.lastFlush === 0 ? Infinity : clock() - this.lastFlush;
  }
}

async function onStreamEvent(msg: SdkMessage, coalescer: Coalescer): Promise<void> {
  const ev = msg.event as { type?: string; delta?: Record<string, unknown> } | undefined;
  if (!ev || ev.type !== "content_block_delta") return;
  const delta = ev.delta ?? {};
  if (delta.type === "text_delta" && typeof delta.text === "string" && delta.text)
    await coalescer.add("text", delta.text);
  else if (delta.type === "thinking_delta" && typeof delta.thinking === "string" && delta.thinking)
    await coalescer.add("thinking", delta.thinking);
}

// -- helpers ------------------------------------------------------------------

function toolCallEvent(block: SdkBlock, toolMeta: Record<string, ToolMeta>) {
  const name = stripMcpPrefix(String(block.name));
  const meta = toolMeta[name] ?? { kind: "unknown", label: name };
  const input = (block.input && typeof block.input === "object" ? block.input : {}) as Record<string, unknown>;
  let detail: string | null | undefined;
  try {
    detail = meta.detail?.(input);
  } catch {
    detail = undefined; // detail is cosmetic, never fatal
  }
  return E.toolCall(String(block.id), name, meta.kind, meta.label, detail ?? undefined);
}

function stripMcpPrefix(name: string): string {
  return name.startsWith("mcp__") ? name.split("__").slice(2).join("__") || name : name;
}

function summarizeResult(content: unknown, limit = 200): string | null {
  let text: string;
  if (content == null) return null;
  if (typeof content === "string") text = content;
  else if (Array.isArray(content))
    text = content
      .filter((i): i is { type: string; text?: unknown } => !!i && typeof i === "object" && (i as { type?: unknown }).type === "text")
      .map((i) => String(i.text ?? ""))
      .join(" ");
  else text = String(content);
  text = text.split(/\s+/).filter(Boolean).join(" ");
  if (!text) return null;
  return text.length > limit ? text.slice(0, limit) + "…" : text;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function cap(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}
function clock(): number {
  return Date.now();
}

interface Att {
  path?: string;
  name?: string;
  media_type?: string;
}
function isAtt(a: unknown): a is Att {
  return !!a && typeof a === "object";
}

// -- SDK message shapes (structural; we only touch these fields) --------------

interface SdkBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
}
export interface SdkMessage {
  type: string;
  message?: { content?: SdkBlock[] };
  event?: unknown;
  session_id?: string;
  subtype?: string;
  result?: string;
}
