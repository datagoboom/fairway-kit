"""The app-facing runner interface (PROTOCOL.md section 13).

Apps implement `Runner` (an async callable); everything else - seq stamping,
persistence, fan-out, message lifecycle, stop escalation - is the library's job.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Protocol

# emit(event_fields) -> stamped event. Await it: the event is durable when it returns.
Emit = Callable[[dict[str, Any]], Awaitable[dict[str, Any]]]


@dataclass
class TurnContext:
    session: dict[str, Any]
    messages: list[dict[str, Any]]  # persisted history, oldest first (excludes the new pair)
    user_content: str
    user_message_id: str
    assistant_message_id: str
    job_id: str
    attachments: list[dict[str, Any]] = field(default_factory=list)
    cancel: asyncio.Event = field(default_factory=asyncio.Event)
    # Round-trip for provider resume tokens (e.g. Claude Agent SDK session id):
    provider_session_id: str | None = None

    # Set by the runner when the provider hands back a (new) resume token; the
    # registry persists it after the turn.
    new_provider_session_id: str | None = None

    # Runner-registered hook for cooperative interruption (e.g.
    # ClaudeSDKClient.interrupt). The registry calls it on stop() before
    # escalating to a hard task cancel (PROTOCOL.md 9).
    graceful_stop: Callable[[], Awaitable[None]] | None = None

    # Registry-provided (PROTOCOL.md, Permissions). Await it to ask the user
    # for tool approval: request_permission(tool=..., kind=..., label=...,
    # detail=None, input=None) -> "allow" | "allow_session" | "deny".
    # Auto-returns "allow" for tools in the session's allow set; otherwise
    # emits permission_request, holds until the user resolves it (indefinite),
    # emits permission_resolved, and records allow_session decisions.
    request_permission: Callable[..., Awaitable[str]] | None = None


@dataclass
class TurnResult:
    """What the runner produced. The registry finalizes the assistant row from this
    BEFORE emitting the terminal event (ordering rule, PROTOCOL.md 7)."""

    content: str  # final markdown (derivable via fold.final_text if runner tracked events)
    reason: str | None = None

    # Token accounting reported by the provider, when it reports any.
    #
    # Optional and additive: existing callers ignore it and nothing behaves
    # differently. Deliberately NOT an event — usage is not part of the render
    # stream, so events.schema.json and the pinned fold-vectors are untouched.
    #
    # Exists because a runner is the only place this data is visible, and
    # without somewhere to put it a host that wants cost accounting has to
    # reimplement the runner to see numbers the SDK already handed it. Shape is
    # the provider's own, normalised only in that keys are provider-defined
    # (e.g. {"input_tokens": int, "output_tokens": int}).
    usage: dict[str, Any] | None = None


class Runner(Protocol):
    async def __call__(self, ctx: TurnContext, emit: Emit) -> TurnResult: ...


class GracefulStop(Protocol):
    """Optional companion the registry calls on stop before escalating to hard
    cancel - e.g. ClaudeSDKClient.interrupt(). Registered per-job by the runner via
    ctx (TODO: wire once the SDK adapter lands)."""

    async def __call__(self) -> None: ...
