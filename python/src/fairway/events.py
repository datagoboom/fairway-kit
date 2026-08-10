"""Event types and constructors (PROTOCOL.md sections 2-3).

Events are plain dicts on the wire and in the log. The constructors here build the
type-specific fields; the envelope (seq, ts) is stamped by the event log at persist
time (Store.append_event), never by producers.
"""

from __future__ import annotations

from typing import Any

PROTOCOL_VERSION = "0.3"

CORE_TYPES = frozenset(
    {
        "message_start",
        "text",
        "text_block",
        "thinking",
        "tool_call",
        "tool_result",
        "permission_request",
        "permission_resolved",
        "done",
        "error",
        "cancelled",
    }
)

PERMISSION_DECISIONS = frozenset({"allow", "allow_session", "deny"})
TERMINAL_TYPES = frozenset({"done", "error", "cancelled"})

Event = dict[str, Any]


def message_start(message_id: str) -> Event:
    return {"type": "message_start", "message_id": message_id}


def text(content: str) -> Event:
    return {"type": "text", "content": content}


def text_block(content: str) -> Event:
    return {"type": "text_block", "content": content}


def thinking(content: str) -> Event:
    return {"type": "thinking", "content": content}


def tool_call(
    id: str,
    tool: str,
    kind: str,
    label: str,
    detail: str | None = None,
    input: dict[str, Any] | None = None,
) -> Event:
    ev: Event = {"type": "tool_call", "id": id, "tool": tool, "kind": kind, "label": label}
    if detail is not None:
        ev["detail"] = detail
    if input is not None:
        ev["input"] = input
    return ev


def tool_result(id: str, ok: bool, summary: str | None = None, detail: str | None = None) -> Event:
    ev: Event = {"type": "tool_result", "id": id, "ok": ok}
    if summary is not None:
        ev["summary"] = summary
    if detail is not None:
        ev["detail"] = detail
    return ev


def permission_request(
    id: str,
    tool: str,
    kind: str,
    label: str,
    detail: str | None = None,
    input: dict[str, Any] | None = None,
) -> Event:
    ev: Event = {"type": "permission_request", "id": id, "tool": tool, "kind": kind, "label": label}
    if detail is not None:
        ev["detail"] = detail
    if input is not None:
        ev["input"] = input
    return ev


def permission_resolved(id: str, decision: str) -> Event:
    return {"type": "permission_resolved", "id": id, "decision": decision}


def done(message_id: str, reason: str | None = None) -> Event:
    ev: Event = {"type": "done", "message_id": message_id}
    if reason is not None:
        ev["reason"] = reason
    return ev


def error(message: str, message_id: str | None = None) -> Event:
    ev: Event = {"type": "error", "message": message}
    if message_id is not None:
        ev["message_id"] = message_id
    return ev


def cancelled(message_id: str | None = None) -> Event:
    ev: Event = {"type": "cancelled"}
    if message_id is not None:
        ev["message_id"] = message_id
    return ev


def is_terminal(ev: Event) -> bool:
    return ev.get("type") in TERMINAL_TYPES


def validate(ev: Event) -> None:
    """Cheap structural check for producer mistakes. Full validation is the JSON
    Schema in protocol/events.schema.json (used in tests, not on the hot path)."""
    t = ev.get("type")
    if not isinstance(t, str) or not t:
        raise ValueError(f"event missing type: {ev!r}")
    if t in {"text", "text_block", "thinking"} and not isinstance(ev.get("content"), str):
        raise ValueError(f"{t} event missing content: {ev!r}")
    if t == "tool_call" and not all(isinstance(ev.get(k), str) for k in ("id", "tool", "kind", "label")):
        raise ValueError(f"tool_call missing id/tool/kind/label: {ev!r}")
    if t == "tool_result" and (not isinstance(ev.get("id"), str) or not isinstance(ev.get("ok"), bool)):
        raise ValueError(f"tool_result missing id/ok: {ev!r}")
    if t == "permission_request" and not all(
        isinstance(ev.get(k), str) for k in ("id", "tool", "kind", "label")
    ):
        raise ValueError(f"permission_request missing id/tool/kind/label: {ev!r}")
    if t == "permission_resolved" and (
        not isinstance(ev.get("id"), str) or ev.get("decision") not in PERMISSION_DECISIONS
    ):
        raise ValueError(f"permission_resolved missing id/decision: {ev!r}")
    if t == "done" and not isinstance(ev.get("message_id"), str):
        raise ValueError(f"done missing message_id: {ev!r}")
    if t == "error" and not isinstance(ev.get("message"), str):
        raise ValueError(f"error missing message: {ev!r}")
