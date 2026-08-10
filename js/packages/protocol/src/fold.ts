/**
 * The normative fold: events -> render items (PROTOCOL.md section 5).
 *
 * The SAME function is used for live streaming and for replaying a persisted
 * message's `events` — the single implementation that replaces the hand-synced
 * reducer copies in every previous app. Pinned by protocol/fold-vectors.json,
 * mirrored by python/src/fairway/fold.py.
 */

import type { ChatEvent } from "./events.js";

export interface TextItem {
  type: "text" | "thinking";
  content: string;
  /** Open = a later delta of the same type appends here. Terminals close everything. */
  open: boolean;
}
export interface ToolItem {
  type: "tool";
  id: string;
  tool?: string;
  kind?: string;
  label?: string;
  detail?: string;
  status: "running" | "ok" | "err" | "interrupted";
  summary?: string;
  result_detail?: string;
  orphan?: boolean;
}
export interface PermissionItem {
  type: "permission";
  id: string;
  tool?: string;
  kind?: string;
  label?: string;
  detail?: string;
  status: "pending" | "allowed" | "denied" | "interrupted";
  /** "session" when resolved with allow_session. */
  scope?: "session";
  orphan?: boolean;
}
export interface ErrorItem {
  type: "error";
  message: string;
}
export interface OpaqueItem {
  type: "opaque";
  event: ChatEvent;
}
export type StreamItem = TextItem | ToolItem | PermissionItem | ErrorItem | OpaqueItem;

const TERMINAL = new Set(["done", "error", "cancelled"]);

/** Pure: returns a new array, never mutates its inputs. */
export function fold(prev: readonly StreamItem[], ev: ChatEvent): StreamItem[] {
  const items = prev.map((i) => ({ ...i })) as StreamItem[];
  const last = items[items.length - 1];
  const t = ev.type;

  if (t === "message_start") return items;

  if (t === "text" || t === "thinking") {
    if (last && last.type === t && (last as TextItem).open) {
      (last as TextItem).content += (ev as { content: string }).content;
    } else {
      items.push({ type: t, content: (ev as { content: string }).content, open: true });
    }
    return items;
  }

  if (t === "text_block") {
    if (last && last.type === "text" && (last as TextItem).open) {
      (last as TextItem).content = (ev as { content: string }).content;
      (last as TextItem).open = false;
    } else {
      items.push({ type: "text", content: (ev as { content: string }).content, open: false });
    }
    return items;
  }

  if (t === "tool_call") {
    closeTrailing(items);
    const e = ev as Extract<ChatEvent, { type: "tool_call" }>;
    const item: ToolItem = {
      type: "tool",
      id: e.id,
      tool: e.tool,
      kind: e.kind,
      label: e.label,
      status: "running",
    };
    if (e.detail !== undefined) item.detail = e.detail;
    items.push(item);
    return items;
  }

  if (t === "tool_result") {
    const e = ev as Extract<ChatEvent, { type: "tool_result" }>;
    const status = e.ok ? "ok" : "err";
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it.type === "tool" && it.id === e.id && it.status === "running") {
        it.status = status;
        if (e.summary !== undefined) it.summary = e.summary;
        if (e.detail !== undefined) it.result_detail = e.detail;
        return items;
      }
    }
    const orphan: ToolItem = { type: "tool", id: e.id, status, orphan: true };
    if (e.summary !== undefined) orphan.summary = e.summary;
    items.push(orphan);
    return items;
  }

  if (t === "permission_request") {
    closeTrailing(items);
    const e = ev as Extract<ChatEvent, { type: "permission_request" }>;
    const item: PermissionItem = {
      type: "permission",
      id: e.id,
      tool: e.tool,
      kind: e.kind,
      label: e.label,
      status: "pending",
    };
    if (e.detail !== undefined) item.detail = e.detail;
    items.push(item);
    return items;
  }

  if (t === "permission_resolved") {
    const e = ev as Extract<ChatEvent, { type: "permission_resolved" }>;
    const status = e.decision === "deny" ? "denied" : "allowed";
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it.type === "permission" && it.id === e.id && it.status === "pending") {
        it.status = status;
        if (e.decision === "allow_session") it.scope = "session";
        return items;
      }
    }
    items.push({ type: "permission", id: e.id, status, orphan: true });
    return items;
  }

  if (TERMINAL.has(t)) {
    closeTrailing(items);
    for (const it of items) {
      if (it.type === "tool" && it.status === "running") it.status = "interrupted";
      if (it.type === "permission" && it.status === "pending") it.status = "interrupted";
    }
    if (t === "error") {
      items.push({ type: "error", message: (ev as { message: string }).message });
    }
    return items;
  }

  // x_* extensions and unknown types: opaque, app-rendered.
  items.push({ type: "opaque", event: { ...ev } });
  return items;
}

export function foldAll(events: readonly ChatEvent[]): StreamItem[] {
  let items: StreamItem[] = [];
  for (const ev of events) items = fold(items, ev);
  return items;
}

function closeTrailing(items: StreamItem[]): void {
  const last = items[items.length - 1];
  if (last && (last.type === "text" || last.type === "thinking") && (last as TextItem).open) {
    (last as TextItem).open = false;
  }
}
