"""The normative fold: events -> render items (PROTOCOL.md section 5).

This is the same algorithm as js/src/fold.ts; both are pinned by
protocol/fold-vectors.json. The server uses it to derive a message's final content
and to sanity-check events_json; clients use it for live streaming AND replay.
Folding a full replay must equal folding the live stream (idempotence rule).
"""

from __future__ import annotations

from typing import Any

from .events import TERMINAL_TYPES

Item = dict[str, Any]


def _opaque(items: list[Item], ev: dict[str, Any]) -> list[Item]:
    """Fold an event we cannot faithfully interpret.

    Used when a field whose ABSENCE WOULD MISLEAD is missing — not merely when
    the schema marks a field required. "Required to emit" and "required to
    interpret" are different questions: a tool_call without `kind` is a correct
    card with less metadata, while a tool_call without `id` can never pair with
    its result and would render as an interrupted call that never existed.
    Opaque says "malformed" and means it, instead of drawing something
    plausible and wrong. (paranoid-132)
    """
    items.append({"type": "opaque", "event": dict(ev)})
    return items


def fold(items: list[Item], ev: dict[str, Any]) -> list[Item]:
    """Pure: returns a new list; never mutates inputs."""
    items = [dict(i) for i in items]
    t = ev.get("type", "")

    if t == "message_start":
        return items

    if t in ("text", "thinking"):
        # A text run with no content cannot be rendered at all — there is
        # nothing to show. Falling through would append an item drawing the
        # empty string, which reads as "the model said nothing" rather than
        # "this event is malformed". (paranoid-132)
        if "content" not in ev:
            return _opaque(items, ev)
        if items and items[-1].get("type") == t and items[-1].get("open"):
            items[-1]["content"] += ev["content"]
        else:
            items.append({"type": t, "content": ev["content"], "open": True})
        return items

    if t == "text_block":
        if "content" not in ev:
            return _opaque(items, ev)
        if items and items[-1].get("type") == "text" and items[-1].get("open"):
            items[-1]["content"] = ev["content"]
            items[-1]["open"] = False
        else:
            items.append({"type": "text", "content": ev["content"], "open": False})
        return items

    if t == "tool_call":
        # `id` is MISLEADING when absent: the item can never pair with its
        # tool_result, so it renders as an orphan — which reads as
        # "interrupted" when the truth is "malformed".
        # tool/kind/label absent are merely INCOMPLETE: the card is correct,
        # just carrying less metadata. Tolerated, because migrated legacy
        # events legitimately lack kind/label (no-synthesis) and must still
        # fold to real, named, correctly-paired cards. (paranoid-132)
        if "id" not in ev:
            return _opaque(items, ev)
        _close_trailing(items)
        item: Item = {
            "type": "tool",
            "id": ev["id"],
            "tool": ev.get("tool"),
            "kind": ev.get("kind"),
            "label": ev.get("label"),
            "status": "running",
        }
        if "detail" in ev:
            item["detail"] = ev["detail"]
        items.append(item)
        return items

    if t == "tool_result":
        # `ok` absent would force us to invent a verdict. Defaulting it either
        # way puts a confident ok/err on a tool whose outcome we do not know —
        # the same fabrication as fold.ts's `e.ok ? "ok" : "err"`. `id` absent
        # cannot be attached to any call. Both are MISLEADING. (paranoid-132)
        if "id" not in ev or "ok" not in ev:
            return _opaque(items, ev)
        status = "ok" if ev["ok"] else "err"
        for item in reversed(items):
            if item.get("type") == "tool" and item.get("id") == ev["id"] and item.get("status") == "running":
                item["status"] = status
                if "summary" in ev:
                    item["summary"] = ev["summary"]
                if "detail" in ev:
                    item["result_detail"] = ev["detail"]
                return items
        orphan: Item = {"type": "tool", "id": ev["id"], "status": status, "orphan": True}
        if "summary" in ev:
            orphan["summary"] = ev["summary"]
        items.append(orphan)
        return items

    if t == "permission_request":
        if "id" not in ev:
            return _opaque(items, ev)
        _close_trailing(items)
        item = {
            "type": "permission",
            "id": ev["id"],
            "tool": ev.get("tool"),
            "kind": ev.get("kind"),
            "label": ev.get("label"),
            "status": "pending",
        }
        if "detail" in ev:
            item["detail"] = ev["detail"]
        items.append(item)
        return items

    if t == "permission_resolved":
        if "id" not in ev or "decision" not in ev:
            return _opaque(items, ev)
        decision = ev["decision"]
        status = "denied" if decision == "deny" else "allowed"
        for item in reversed(items):
            if (
                item.get("type") == "permission"
                and item.get("id") == ev["id"]
                and item.get("status") == "pending"
            ):
                item["status"] = status
                if decision == "allow_session":
                    item["scope"] = "session"
                return items
        orphan = {"type": "permission", "id": ev["id"], "status": status, "orphan": True}
        items.append(orphan)
        return items

    if t in TERMINAL_TYPES:
        _close_trailing(items)
        for item in items:
            if item.get("type") == "tool" and item.get("status") == "running":
                item["status"] = "interrupted"
            if item.get("type") == "permission" and item.get("status") == "pending":
                item["status"] = "interrupted"
        if t == "error":
            items.append({"type": "error", "message": ev.get("message", "")})
        return items

    # Extension (x_*) and unknown types: opaque, rendered/handled by the app.
    items.append({"type": "opaque", "event": dict(ev)})
    return items


def fold_all(events: list[dict[str, Any]]) -> list[Item]:
    items: list[Item] = []
    for ev in events:
        items = fold(items, ev)
    return items


def final_text(events: list[dict[str, Any]]) -> str:
    """Derive a message's plain-markdown content from its events (closed text runs)."""
    return "\n\n".join(
        i["content"] for i in fold_all(events) if i.get("type") == "text" and i.get("content")
    )


def compactable_delta_seqs(events: list[dict[str, Any]]) -> list[int]:
    """Seqs of text deltas that a text_block fully supersedes (PROTOCOL.md 6).

    Deleting exactly these events cannot change fold output: only runs that end
    with an authoritative text_block are eligible. A run cut short by a tool
    call or terminal (its content exists solely in deltas) is kept, and
    thinking deltas are always kept (no authoritative block exists for them).
    """
    compactable: list[int] = []
    current_run: list[int] = []
    pending_permissions: set[str] = set()
    for ev in events:
        t = ev.get("type")
        if t == "text":
            current_run.append(ev["seq"])
        elif t == "text_block":
            compactable.extend(current_run)
            current_run = []
        elif t == "message_start":
            continue
        elif t == "permission_resolved" and ev.get("id") in pending_permissions:
            # Matched resolution mutates an earlier item in place; the trailing
            # text run survives. (An orphan resolution appends an item and
            # breaks the run, so it falls through to the else below.)
            pending_permissions.discard(ev["id"])
            continue
        else:
            if t == "permission_request":
                pending_permissions.add(ev["id"])
            current_run = []  # run closed without a block: deltas are the record
    return compactable


def _close_trailing(items: list[Item]) -> None:
    if items and items[-1].get("type") in ("text", "thinking") and items[-1].get("open"):
        items[-1]["open"] = False
