/**
 * The normative fold: events -> render items (PROTOCOL.md section 5).
 *
 * The SAME function is used for live streaming and for replaying a persisted
 * message's `events` - the single implementation that replaces the hand-synced
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
/**
 * Fold an event we cannot faithfully interpret.
 *
 * Used when a field whose ABSENCE WOULD MISLEAD is missing — not merely when
 * the schema marks a field required. "Required to emit" and "required to
 * interpret" are different questions: a tool_call without `kind` is a correct
 * card with less metadata, while a tool_call without `id` can never pair with
 * its result and would render as an interrupted call that never existed.
 * (paranoid-132)
 */
function opaque(items: StreamItem[], ev: ChatEvent): StreamItem[] {
  items.push({ type: "opaque", event: { ...(ev as object) } } as StreamItem);
  return items;
}

export function fold(prev: readonly StreamItem[], ev: ChatEvent): StreamItem[] {
  const items = prev.map((i) => ({ ...i })) as StreamItem[];
  const last = items[items.length - 1];
  const t = ev.type;

  if (t === "message_start") return items;

  if (t === "text" || t === "thinking") {
    if ((ev as Record<string, unknown>).content === undefined) return opaque(items, ev);
    if (last && last.type === t && (last as TextItem).open) {
      (last as TextItem).content += (ev as { content: string }).content;
    } else {
      items.push({ type: t, content: (ev as { content: string }).content, open: true });
    }
    return items;
  }

  if (t === "text_block") {
    if ((ev as Record<string, unknown>).content === undefined) return opaque(items, ev);
    if (last && last.type === "text" && (last as TextItem).open) {
      (last as TextItem).content = (ev as { content: string }).content;
      (last as TextItem).open = false;
    } else {
      items.push({ type: "text", content: (ev as { content: string }).content, open: false });
    }
    return items;
  }

  if (t === "tool_call") {
    const e0 = ev as Record<string, unknown>;
    // `id` absent is MISLEADING (can never pair -> renders as a phantom
    // interrupted call). tool/kind/label absent are merely INCOMPLETE and are
    // tolerated, so migrated legacy events still fold to named cards.
    if (e0.id === undefined) return opaque(items, ev);
    closeTrailing(items);
    const e = ev as Extract<ChatEvent, { type: "tool_call" }>;
    const item: ToolItem = {
      type: "tool",
      id: e.id,
      tool: e.tool ?? null,
      kind: e.kind ?? null,
      label: e.label ?? null,
      status: "running",
    };
    if (e.detail !== undefined) item.detail = e.detail;
    items.push(item);
    return items;
  }

  if (t === "tool_result") {
    const e = ev as Extract<ChatEvent, { type: "tool_result" }>;
    const e0 = ev as Record<string, unknown>;
    // paranoid-132: this line used to read `e.ok ? "ok" : "err"`, so a
    // tool_result with NO `ok` field rendered as a red failure on a tool that
    // may well have SUCCEEDED — inventing a verdict from an absent one. An
    // outcome we do not know is not an outcome we may guess.
    if (e0.id === undefined || e0.ok === undefined) return opaque(items, ev);
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
    if ((ev as Record<string, unknown>).id === undefined) return opaque(items, ev);
    closeTrailing(items);
    const e = ev as Extract<ChatEvent, { type: "permission_request" }>;
    const item: PermissionItem = {
      type: "permission",
      id: e.id,
      tool: e.tool ?? null,
      kind: e.kind ?? null,
      label: e.label ?? null,
      status: "pending",
    };
    if (e.detail !== undefined) item.detail = e.detail;
    items.push(item);
    return items;
  }

  if (t === "permission_resolved") {
    const p0 = ev as Record<string, unknown>;
    if (p0.id === undefined || p0.decision === undefined) return opaque(items, ev);
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
