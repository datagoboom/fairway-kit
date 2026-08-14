/** The Runner contract: what an app (or an adapter) implements to drive a turn,
 * and the context + emit surface the host hands it. This is the integration
 * boundary - @fairway-kit/server invokes a Runner; it never dictates how one is
 * built. Storage types (Backend, the seq mutex) live in the server, not here. */

import type { EmitEvent } from "./events.js";

export type { EmitEvent } from "./events.js";

/** A stamped event (seq + ts added by the store at persist time). */
export type StampedEvent = EmitEvent & { seq: number; ts: string };

/** emit(event) -> stamped event. Await it: the event is durable when it returns. */
export type Emit = (ev: EmitEvent) => Promise<StampedEvent>;

/** A persisted message the runner sees in ctx.messages (history). */
export interface Message {
  id: string;
  session_id: string;
  role: "user" | "assistant";
  content: string;
  events: StampedEvent[] | null;
  streaming: boolean;
  attachments?: unknown[] | null;
  created_at: string;
}

/** What a runner passes to ctx.requestPermission to open the HITL gate. */
export interface PermissionRequest {
  tool: string;
  kind?: string;
  label?: string;
  detail?: string;
  input?: Record<string, unknown>;
}

/** The gate's answer: "allow" (this call), "allow_session" (remember for the
 * session), or "deny". */
export type PermissionOutcome = "allow" | "allow_session" | "deny";

/** What the runner produces. The host finalizes the assistant row from this
 * BEFORE emitting the terminal event (PROTOCOL.md 7). `content` may be empty -
 * the host then derives it from the folded event log. */
export interface TurnResult {
  content: string;
  reason?: string;
}

export interface TurnContext {
  session: Record<string, unknown>;
  /** Persisted history (oldest first), excluding the new user/assistant pair. */
  messages: Message[];
  userContent: string;
  userMessageId: string;
  assistantMessageId: string;
  jobId: string;
  attachments: unknown[];
  /** Aborts when the turn is stopped; a cooperative runner should check it. */
  signal: AbortSignal;
  providerSessionId?: string | null;
  /** Set by the runner when the provider hands back a resume token. */
  newProviderSessionId?: string | null;
  /** Host-provided interrupt hook (e.g. an SDK client's interrupt). */
  gracefulStop?: () => Promise<void>;
  /** Host-provided HITL gate: resolves once the user (or a remembered session
   * allow) answers. Present only while the turn is live. */
  requestPermission?: (req: PermissionRequest) => Promise<PermissionOutcome>;
}

export type Runner = (ctx: TurnContext, emit: Emit) => Promise<TurnResult>;

/** Optional self-description an adapter can publish so a host can reason about
 * what a given runner supports. Everything is best-effort; the only hard
 * requirement on a Runner is that it eventually returns (or throws). */
export interface RunnerCapabilities {
  /** Emits thinking deltas. */
  thinking?: boolean;
  /** Emits tool_call/tool_result events. */
  tools?: boolean;
  /** Honors ctx.signal / gracefulStop to interrupt a live turn. */
  interrupt?: boolean;
  /** Round-trips a provider session id (stateful); if false, the host feeds
   * history from its own store each turn (stateless). */
  session?: boolean;
  /** Routes tool calls through ctx.requestPermission (the HITL gate). */
  permissionGate?: boolean;
}
