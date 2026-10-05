/** Claude Agent SDK ("Claude Code") runner adapter.
 *
 * Maps Claude Agent SDK messages onto the normalized AgentEvent stream; the
 * pump (runnerFromStream) turns that into protocol events:
 *
 *   stream_event content_block_delta/text_delta      -> text-delta (coalesced)
 *   stream_event content_block_delta/thinking_delta  -> thinking-delta (coalesced)
 *   assistant / TextBlock                            -> text-block (authoritative)
 *   assistant / ToolUseBlock                         -> tool-call
 *   user / ToolResultBlock                           -> tool-result
 *   result                                           -> session + (maybe) error
 *
 * `@anthropic-ai/claude-agent-sdk` is an optional peer dependency - install it
 * only to use this adapter (npm install @anthropic-ai/claude-agent-sdk).
 *
 * ## Auth modes
 *
 * The SDK spawns the `claude` CLI, which resolves credentials from its
 * subprocess environment: an ANTHROPIC_API_KEY wins over the CLI's stored
 * subscription login. The subprocess inherits this process's env and merges
 * options.env over it, so:
 *
 * - auth="api"          - pass apiKey (or the inherited ANTHROPIC_API_KEY);
 *                         throws if neither is available.
 * - auth="subscription" - blank ANTHROPIC_API_KEY so an exported key can't
 *                         shadow the CLI's OAuth login; optionally pass
 *                         oauthToken (from `claude setup-token`).
 * - auth="inherit"      - (default) leave the environment alone.
 */

import { readFile } from "node:fs/promises";
import {
  DEFAULT_TOOL_META,
  requestToolPermission,
  runnerFromStream,
  stripMcpPrefix,
  type AgentEvent,
  type ToolMeta,
} from "../toolkit.js";
import type { Runner, RunnerCapabilities, TurnContext } from "../types.js";

export { DEFAULT_TOOL_META } from "../toolkit.js";
export type { ToolMeta } from "../toolkit.js";

export type AuthMode = "api" | "subscription" | "inherit";

const HISTORY_FALLBACK_TURNS = 20;
// Images above this size are dropped with a note: the CLI's JSON message buffer
// rejects oversized payloads, and base64 inflates by ~4/3.
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;

export const capabilities: RunnerCapabilities = {
  thinking: true,
  tools: true,
  interrupt: true,
  session: true,
  permissionGate: true,
};

export interface ClaudeCodeConfig {
  model?: string;
  auth?: AuthMode;
  apiKey?: string; // auth="api": explicit key (else inherited env)
  oauthToken?: string; // auth="subscription": `claude setup-token` output
  allowedTools?: string[]; // pre-approved by the SDK before the gate runs
  disallowedTools?: string[]; // blocked entirely (never offered to the agent)
  maxTurns?: number;
  permissionMode?: string;
  cwd?: string;
  systemPrompt?: (ctx: TurnContext) => string;
  toolMeta?: Record<string, ToolMeta>;
  mcpServers?: Record<string, unknown>;
  // Safe by default: strict mode stops the CLI loading user/project MCP servers,
  // which would silently widen the agent's tool surface beyond what the app declared.
  strictMcpConfig?: boolean;
  // Which filesystem setting sources to load. Omit -> SDK/CLI default (all
  // sources, incl. global ~/.claude). Pass ['project'] to load only cwd's
  // .claude + CLAUDE.md (no global leakage); pass [] to disable entirely.
  settingSources?: string[];
  // Skills to enable: 'all', a name list, or omit for the CLI default. Skills
  // are a context filter, not a sandbox - their files stay readable via
  // Read/Bash, so never put secrets in skill files.
  skills?: string[] | "all";
  env?: Record<string, string>; // extra subprocess env
  flushIntervalMs?: number;
  flushMinChars?: number;
  // Test seam: replaces the SDK's query(). Async generator over SDK messages.
  queryFn?: (args: { prompt: unknown; options: Record<string, unknown> }) => AsyncIterable<SdkMessage>;
}

/** Build a Runner from config. Pass it as the `runner` to createAgentChat. */
export function claudeCodeRunner(config: ClaudeCodeConfig = {}): Runner {
  const toolMeta = config.toolMeta ?? DEFAULT_TOOL_META;
  return runnerFromStream({
    toolMeta,
    flushIntervalMs: config.flushIntervalMs,
    flushMinChars: config.flushMinChars,
    start: (ctx, signal) => claudeStream(ctx, config, toolMeta, signal),
  });
}

/** Map the SDK's message stream onto normalized AgentEvents for one turn. */
async function* claudeStream(
  ctx: TurnContext,
  config: ClaudeCodeConfig,
  toolMeta: Record<string, ToolMeta>,
  signal: AbortSignal,
): AsyncGenerator<AgentEvent> {
  const queryFn = config.queryFn ?? (await loadQuery());
  // The SDK wants an AbortController; drive it from the pump's signal.
  const controller = new AbortController();
  if (signal.aborted) controller.abort();
  else signal.addEventListener("abort", () => controller.abort(), { once: true });

  const prompt = await buildPrompt(ctx, config);
  const options: Record<string, unknown> = {
    model: config.model ?? "claude-opus-4-8",
    allowedTools: config.allowedTools ?? [],
    disallowedTools: config.disallowedTools ?? [],
    maxTurns: config.maxTurns ?? 100,
    permissionMode: config.permissionMode ?? "default",
    cwd: config.cwd,
    mcpServers: config.mcpServers ?? {},
    strictMcpConfig: config.strictMcpConfig ?? true,
    ...(config.settingSources !== undefined ? { settingSources: config.settingSources } : {}),
    ...(config.skills !== undefined ? { skills: config.skills } : {}),
    systemPrompt: config.systemPrompt ? config.systemPrompt(ctx) : undefined,
    resume: ctx.providerSessionId ?? undefined,
    includePartialMessages: true, // stream_event deltas for live typing
    env: buildEnv(config),
    abortController: controller,
    canUseTool: buildCanUseTool(ctx, toolMeta, config.permissionMode ?? "default"),
  };

  for await (const msg of queryFn({ prompt, options })) {
    if (msg.type === "stream_event") {
      const delta = streamDelta(msg);
      if (delta) yield delta;
    } else if (msg.type === "assistant") {
      for (const block of msg.message?.content ?? []) {
        if (block.type === "text" && typeof block.text === "string") {
          yield { type: "text-block", text: block.text };
        } else if (block.type === "tool_use") {
          yield {
            type: "tool-call",
            id: String(block.id),
            name: stripMcpPrefix(String(block.name)),
            input: (block.input && typeof block.input === "object" ? block.input : {}) as Record<string, unknown>,
          };
        }
        // ThinkingBlock is ignored: its content already streamed as deltas.
      }
    } else if (msg.type === "user") {
      const content = Array.isArray(msg.message?.content) ? msg.message!.content : [];
      for (const block of content) {
        if (block.type === "tool_result") {
          yield {
            type: "tool-result",
            id: String(block.tool_use_id),
            ok: !block.is_error,
            summary: summarizeResult(block.content) ?? undefined,
          };
        }
      }
    } else if (msg.type === "result") {
      if (msg.session_id) yield { type: "session", id: msg.session_id };
      if (msg.subtype && msg.subtype !== "success")
        yield { type: "error", message: msg.result || `agent error (${msg.subtype})` };
    }
  }
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
      "claudeCodeRunner needs @anthropic-ai/claude-agent-sdk: npm install @anthropic-ai/claude-agent-sdk",
    );
  }
  if (typeof sdk.query !== "function") throw new Error("claude-agent-sdk has no query() export");
  return sdk.query;
}

function buildEnv(config: ClaudeCodeConfig): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...config.env };
  if (config.auth === "api") {
    const key = config.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error("claudeCodeRunner({auth:'api'}) requires apiKey or ANTHROPIC_API_KEY");
    env.ANTHROPIC_API_KEY = key;
  } else if (config.auth === "subscription") {
    // An exported API key would win over the CLI's subscription login; blank it.
    env.ANTHROPIC_API_KEY = "";
    if (config.oauthToken) env.CLAUDE_CODE_OAUTH_TOKEN = config.oauthToken;
  }
  return env;
}

// -- permission gate ----------------------------------------------------------

function buildCanUseTool(ctx: TurnContext, toolMeta: Record<string, ToolMeta>, permissionMode: string) {
  // Only meaningful when the mode leaves decisions to the callback; the SDK
  // shadows it under bypassPermissions/dontAsk.
  if (!ctx.requestPermission || permissionMode === "bypassPermissions" || permissionMode === "dontAsk")
    return undefined;
  return async function canUseTool(toolName: string, input: unknown) {
    const decision = await requestToolPermission(ctx, toolMeta, toolName, input);
    if (decision === "deny")
      return { behavior: "deny" as const, message: "The user denied permission for this tool call." };
    return { behavior: "allow" as const, updatedInput: input };
  };
}

// -- prompt building ----------------------------------------------------------

async function buildPrompt(ctx: TurnContext, config: ClaudeCodeConfig): Promise<unknown> {
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
  const lines = recent.filter((m) => m.content).map((m) => `${cap(m.role)}: ${m.content}`);
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

// -- helpers ------------------------------------------------------------------

function streamDelta(msg: SdkMessage): AgentEvent | null {
  const ev = msg.event as { type?: string; delta?: Record<string, unknown> } | undefined;
  if (!ev || ev.type !== "content_block_delta") return null;
  const delta = ev.delta ?? {};
  if (delta.type === "text_delta" && typeof delta.text === "string" && delta.text)
    return { type: "text-delta", text: delta.text };
  if (delta.type === "thinking_delta" && typeof delta.thinking === "string" && delta.thinking)
    return { type: "thinking-delta", text: delta.thinking };
  return null;
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

function cap(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
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
