/** Agent Chat Protocol event types (PROTOCOL.md sections 2-3). */

export const PROTOCOL_VERSION = "0.3";

export interface EventBase {
  /** Per-job monotonic sequence, assigned at persist time. */
  seq: number;
  type: string;
  ts: string;
}

export interface MessageStartEvent extends EventBase {
  type: "message_start";
  message_id: string;
}
export interface TextEvent extends EventBase {
  type: "text";
  content: string;
}
export interface TextBlockEvent extends EventBase {
  type: "text_block";
  content: string;
}
export interface ThinkingEvent extends EventBase {
  type: "thinking";
  content: string;
}
export interface ToolCallEvent extends EventBase {
  type: "tool_call";
  id: string;
  tool: string;
  /** Server-derived display metadata — clients must not keep their own maps. */
  kind: string;
  label: string;
  detail?: string;
  input?: Record<string, unknown>;
}
export interface ToolResultEvent extends EventBase {
  type: "tool_result";
  id: string;
  ok: boolean;
  summary?: string;
  detail?: string;
}
export type PermissionDecision = "allow" | "allow_session" | "deny";

export interface PermissionRequestEvent extends EventBase {
  type: "permission_request";
  id: string;
  tool: string;
  kind: string;
  label: string;
  detail?: string;
  input?: Record<string, unknown>;
}
export interface PermissionResolvedEvent extends EventBase {
  type: "permission_resolved";
  id: string;
  decision: PermissionDecision;
}
export interface DoneEvent extends EventBase {
  type: "done";
  /** Finalized assistant row, committed before this event was emitted. */
  message_id: string;
  reason?: string;
}
export interface ErrorEvent extends EventBase {
  type: "error";
  message: string;
  message_id?: string;
}
export interface CancelledEvent extends EventBase {
  type: "cancelled";
  message_id?: string;
}
/** x_* extensions and unknown future types — opaque to the fold. */
export interface OpaqueEvent extends EventBase {
  [key: string]: unknown;
}

export type ChatEvent =
  | MessageStartEvent
  | TextEvent
  | TextBlockEvent
  | ThinkingEvent
  | ToolCallEvent
  | ToolResultEvent
  | PermissionRequestEvent
  | PermissionResolvedEvent
  | DoneEvent
  | ErrorEvent
  | CancelledEvent
  | OpaqueEvent;

export type TerminalEvent = DoneEvent | ErrorEvent | CancelledEvent;

const TERMINAL = new Set(["done", "error", "cancelled"]);

export function isTerminal(ev: ChatEvent): ev is TerminalEvent {
  return TERMINAL.has(ev.type);
}
