/**
 * Event constructors + validation — the write side a runner uses to emit
 * protocol events. The event TYPES and the fold come from @fairway-kit/protocol
 * (shared with clients); this module is the producer half. The envelope
 * (seq, ts) is stamped by the store at persist time, never by producers.
 */

import type { ChatEvent, PermissionDecision } from "@fairway-kit/protocol";
export { isTerminal, PROTOCOL_VERSION } from "@fairway-kit/protocol";
export type { ChatEvent } from "@fairway-kit/protocol";

/** An event as emitted by a runner: no seq/ts yet (the store stamps them). */
export type EmitEvent = Omit<ChatEvent, "seq" | "ts"> & Record<string, unknown>;

export const messageStart = (messageId: string): EmitEvent => ({
  type: "message_start",
  message_id: messageId,
});
export const text = (content: string): EmitEvent => ({ type: "text", content });
export const textBlock = (content: string): EmitEvent => ({ type: "text_block", content });
export const thinking = (content: string): EmitEvent => ({ type: "thinking", content });

export const toolCall = (
  id: string,
  tool: string,
  kind: string,
  label: string,
  detail?: string,
  input?: Record<string, unknown>,
): EmitEvent => {
  const e: EmitEvent = { type: "tool_call", id, tool, kind, label };
  if (detail !== undefined) e.detail = detail;
  if (input !== undefined) e.input = input;
  return e;
};

export const toolResult = (
  id: string,
  ok: boolean,
  summary?: string,
  detail?: string,
): EmitEvent => {
  const e: EmitEvent = { type: "tool_result", id, ok };
  if (summary !== undefined) e.summary = summary;
  if (detail !== undefined) e.detail = detail;
  return e;
};

export const permissionRequest = (
  id: string,
  tool: string,
  kind: string,
  label: string,
  detail?: string,
  input?: Record<string, unknown>,
): EmitEvent => {
  const e: EmitEvent = { type: "permission_request", id, tool, kind, label };
  if (detail !== undefined) e.detail = detail;
  if (input !== undefined) e.input = input;
  return e;
};

export const permissionResolved = (id: string, decision: PermissionDecision): EmitEvent => ({
  type: "permission_resolved",
  id,
  decision,
});

export const done = (messageId: string, reason?: string): EmitEvent => {
  const e: EmitEvent = { type: "done", message_id: messageId };
  if (reason !== undefined) e.reason = reason;
  return e;
};

export const errorEvent = (message: string, messageId?: string): EmitEvent => {
  const e: EmitEvent = { type: "error", message };
  if (messageId !== undefined) e.message_id = messageId;
  return e;
};

export const cancelled = (messageId?: string): EmitEvent => {
  const e: EmitEvent = { type: "cancelled" };
  if (messageId !== undefined) e.message_id = messageId;
  return e;
};

const PERMISSION_DECISIONS = new Set(["allow", "allow_session", "deny"]);

/** Cheap structural check for producer mistakes (mirrors the Python validate). */
export function validate(ev: EmitEvent): void {
  const t = ev.type;
  if (typeof t !== "string" || !t) throw new Error(`event missing type: ${JSON.stringify(ev)}`);
  if ((t === "text" || t === "text_block" || t === "thinking") && typeof ev.content !== "string")
    throw new Error(`${t} event missing content`);
  if (t === "tool_call" && !["id", "tool", "kind", "label"].every((k) => typeof ev[k] === "string"))
    throw new Error("tool_call missing id/tool/kind/label");
  if (t === "tool_result" && (typeof ev.id !== "string" || typeof ev.ok !== "boolean"))
    throw new Error("tool_result missing id/ok");
  if (
    t === "permission_request" &&
    !["id", "tool", "kind", "label"].every((k) => typeof ev[k] === "string")
  )
    throw new Error("permission_request missing id/tool/kind/label");
  if (
    t === "permission_resolved" &&
    (typeof ev.id !== "string" || !PERMISSION_DECISIONS.has(ev.decision as string))
  )
    throw new Error("permission_resolved missing id/decision");
  if (t === "done" && typeof ev.message_id !== "string") throw new Error("done missing message_id");
  if (t === "error" && typeof ev.message !== "string") throw new Error("error missing message");
}
