"""The normative fold: events -> render items (PROTOCOL.md section 5).

This is the same algorithm as js/src/fold.ts; both are pinned by
protocol/fold-vectors.json. The server uses it to derive a message's final content
and to sanity-check events_json; clients use it for live streaming AND replay.
Folding a full replay must equal folding the live stream (idempotence rule).
"""

from __future__ import annotations

from typing import Any

from .events import CORE_TYPES, TERMINAL_TYPES

Item = dict[str, Any]


def fold(items: list[Item], ev: dict[str, Any]) -> list[Item]:
    """Pure: returns a new list; never mutates inputs."""
    items = [dict(i) for i in items]
    t = ev.get("type", "")

    if t == "message_start":
        return items

    if t in ("text", "thinking"):
        if items and items[-1].get("type") == t and items[-1].get("open"):
            items[-1]["content"] += ev["content"]
        else:
            items.append({"type": t, "content": ev["content"], "open": True})
        return items

    if t == "text_block":
        if items and items[-1].get("type") == "text" and items[-1].get("open"):
            items[-1]["content"] = ev["content"]
            items[-1]["open"] = False
        else:
            items.append({"type": "text", "content": ev["content"], "open": False})
        return items

    if t == "tool_call":
        _close_trailing(items)
        item: Item = {
            "type": "tool",
            "id": ev["id"],
            "tool": ev["tool"],
            "kind": ev["kind"],
            "label": ev["label"],
            "status": "running",
        }
        if "detail" in ev:
            item["detail"] = ev["detail"]
        items.append(item)
        return items

    if t == "tool_result":
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

    if t in TERMINAL_TYPES:
        _close_trailing(items)
        for item in items:
            if item.get("type") == "tool" and item.get("status") == "running":
                item["status"] = "interrupted"
        if t == "error":
            items.append({"type": "error", "message": ev["message"]})
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


def _close_trailing(items: list[Item]) -> None:
    if items and items[-1].get("type") in ("text", "thinking") and items[-1].get("open"):
        items[-1]["open"] = False
