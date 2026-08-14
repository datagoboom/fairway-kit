/** The adapter toolkit: turn any agent's stream into fairway protocol events.
 *
 * An adapter's whole job is to map its framework's events onto the normalized
 * `AgentEvent` union and hand a stream of them to `runnerFromStream`. The pump
 * owns everything else that used to be copied into each adapter: delta
 * coalescing, the authoritative-block supersede, tool-call metadata, the
 * session-id round-trip, terminal handling, and cancellation wiring. Writing an
 * adapter is then ~30 lines of `switch (frameworkEvent.type)`. */

import * as E from "./events.js";
import type {
  Emit,
  PermissionOutcome,
  Runner,
  TurnContext,
} from "./types.js";

// -- the normalized stream ----------------------------------------------------

/** The single union every adapter maps its framework's stream onto.
 *
 * `text-delta` streams partial text (coalesced before it hits the durable log);
 * `text-block` is the authoritative closed block that supersedes the streamed
 * run on fold - emit both when the framework provides both (like Claude), or
 * just one when it doesn't. `thinking` is delta-only (the protocol has no
 * thinking block). Terminal is implicit: the stream ending is "done", an
 * `error` event (or a thrown error) is "error". */
export type AgentEvent =
  | { type: "text-delta"; text: string }
  | { type: "text-block"; text: string }
  | { type: "thinking-delta"; text: string }
  | { type: "tool-call"; id: string; name: string; input?: Record<string, unknown> }
  | { type: "tool-result"; id: string; ok: boolean; summary?: string }
  | { type: "session"; id: string }
  | { type: "error"; message: string };

const FLUSH_INTERVAL_MS = 150;
const FLUSH_MIN_CHARS = 48;

export interface RunnerFromStreamOptions {
  /** Produce the normalized stream for one turn. `signal` aborts when the turn
   * is stopped (wired from ctx.signal + gracefulStop) - pass it to your SDK. */
  start: (
    ctx: TurnContext,
    signal: AbortSignal,
  ) => AsyncIterable<AgentEvent> | Promise<AsyncIterable<AgentEvent>>;
  /** Display metadata injected into tool_call events (kind/label/detail). */
  toolMeta?: Record<string, ToolMeta>;
  flushIntervalMs?: number;
  flushMinChars?: number;
}

/** Build a Runner from a normalized `AgentEvent` stream. Handles coalescing,
 * tool-meta enrichment, session round-trip, terminal, and cancellation. */
export function runnerFromStream(opts: RunnerFromStreamOptions): Runner {
  const toolMeta = opts.toolMeta ?? DEFAULT_TOOL_META;
  return async function run(ctx, emit) {
    // One controller drives both the graceful interrupt and a hard stop.
    const controller = new AbortController();
    ctx.gracefulStop = async () => controller.abort();
    if (ctx.signal.aborted) controller.abort();
    else ctx.signal.addEventListener("abort", () => controller.abort(), { once: true });

    const coalescer = new Coalescer(emit, opts.flushIntervalMs ?? FLUSH_INTERVAL_MS, opts.flushMinChars ?? FLUSH_MIN_CHARS);
    const textParts: string[] = [];
    let errorResult: string | null = null;

    try {
      const stream = await opts.start(ctx, controller.signal);
      for await (const ev of stream) {
        switch (ev.type) {
          case "text-delta":
            await coalescer.add("text", ev.text);
            break;
          case "thinking-delta":
            await coalescer.add("thinking", ev.text);
            break;
          case "text-block":
            // Authoritative block: drop the unflushed streamed tail (the block
            // supersedes the run on fold) and emit it.
            coalescer.dropPending("text");
            textParts.push(ev.text);
            await emit(E.textBlock(ev.text));
            break;
          case "tool-call": {
            await coalescer.flush();
            const m = resolveToolMeta(ev.name, toolMeta, ev.input);
            await emit(E.toolCall(ev.id, m.name, m.kind, m.label, m.detail, ev.input));
            break;
          }
          case "tool-result":
            await coalescer.flush();
            await emit(E.toolResult(ev.id, ev.ok, ev.summary));
            break;
          case "session":
            ctx.newProviderSessionId = ev.id;
            break;
          case "error":
            errorResult = ev.message;
            break;
        }
      }
    } finally {
      ctx.gracefulStop = undefined;
      await coalescer.flush();
    }

    // A thrown abort propagates from the loop (the host maps it to cancelled);
    // an in-band error event is surfaced here (the host maps it to error).
    if (errorResult !== null) throw new Error(errorResult);
    // Empty content is fine - the host derives it from the folded log.
    return { content: textParts.filter(Boolean).join("\n\n") };
  };
}

// -- coalescing ---------------------------------------------------------------

/** Batches streamed deltas before they hit the (durable) event stream:
 * coalescing happens before seq assignment, so wire == log (PROTOCOL.md 4.3). */
export class Coalescer {
  private kind: "text" | "thinking" | null = null;
  private buf: string[] = [];
  private lastFlush = 0;
  constructor(private emit: Emit, private intervalMs = FLUSH_INTERVAL_MS, private minChars = FLUSH_MIN_CHARS) {}

  async add(kind: "text" | "thinking", content: string): Promise<void> {
    if (!content) return;
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
    this.lastFlush = Date.now();
  }

  /** Discard buffered deltas of `kind`: the authoritative block for the run has
   * arrived (text_block replaces the streamed run on fold). */
  dropPending(kind: "text" | "thinking"): void {
    if (this.kind === kind) this.buf = [];
    else void this.flush();
  }

  private elapsed(): number {
    return this.lastFlush === 0 ? Infinity : Date.now() - this.lastFlush;
  }
}

// -- tool metadata ------------------------------------------------------------

/** Display metadata for one tool, injected into tool_call events so clients
 * never keep their own name->label maps (PROTOCOL.md 3). */
export interface ToolMeta {
  kind: string;
  label: string;
  detail?: (input: Record<string, unknown>) => string | null | undefined;
}

/** Sensible defaults for the common built-in tool names. */
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

/** Resolve a (possibly MCP-prefixed) tool name against a meta map into the
 * display fields a tool_call / permission event needs. */
export function resolveToolMeta(
  rawName: string,
  metaMap: Record<string, ToolMeta> = DEFAULT_TOOL_META,
  input?: unknown,
): { name: string; kind: string; label: string; detail: string | undefined } {
  const name = stripMcpPrefix(rawName);
  const meta = metaMap[name] ?? { kind: "unknown", label: name };
  const inputObj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  let detail: string | null | undefined;
  try {
    detail = meta.detail?.(inputObj);
  } catch {
    detail = undefined; // detail is cosmetic, never fatal
  }
  return { name, kind: meta.kind, label: meta.label, detail: detail ?? undefined };
}

/** MCP tools arrive as `mcp__<server>__<tool>`; show just the tool name. */
export function stripMcpPrefix(name: string): string {
  return name.startsWith("mcp__") ? name.split("__").slice(2).join("__") || name : name;
}

// -- permission gate helpers --------------------------------------------------

/** Route a tool call through the host's HITL gate, enriched with display meta.
 * Returns "allow" when no gate is wired (the host isn't gating this turn). An
 * adapter maps the outcome onto its framework's permission shape. */
export async function requestToolPermission(
  ctx: TurnContext,
  toolMeta: Record<string, ToolMeta>,
  toolName: string,
  input?: unknown,
): Promise<PermissionOutcome> {
  if (!ctx.requestPermission) return "allow";
  const m = resolveToolMeta(toolName, toolMeta, input);
  const inputObj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  return ctx.requestPermission({ tool: m.name, kind: m.kind, label: m.label, detail: m.detail, input: inputObj });
}

/** Wrap an app-owned tool's execute fn so it asks the gate before running
 * (the natural integration for frameworks where the app defines tools, e.g. the
 * Vercel AI SDK). Throws on deny so the framework reports a failed tool call. */
export function gateTool<A, R>(
  ctx: TurnContext,
  toolMeta: Record<string, ToolMeta>,
  toolName: string,
  execute: (args: A) => Promise<R>,
): (args: A) => Promise<R> {
  return async (args: A) => {
    const decision = await requestToolPermission(ctx, toolMeta, toolName, args as Record<string, unknown>);
    if (decision === "deny") throw new Error(`Permission denied for ${toolName}`);
    return execute(args);
  };
}

// -- misc ---------------------------------------------------------------------

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
