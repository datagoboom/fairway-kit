"""The app-facing runner interface (PROTOCOL.md section 13).

Apps implement `Runner` (an async callable); everything else — seq stamping,
persistence, fan-out, message lifecycle, stop escalation — is the library's job.
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


@dataclass
class TurnResult:
    """What the runner produced. The registry finalizes the assistant row from this
    BEFORE emitting the terminal event (ordering rule, PROTOCOL.md 7)."""

    content: str  # final markdown (derivable via fold.final_text if runner tracked events)
    reason: str | None = None


class Runner(Protocol):
    async def __call__(self, ctx: TurnContext, emit: Emit) -> TurnResult: ...


class GracefulStop(Protocol):
    """Optional companion the registry calls on stop before escalating to hard
    cancel — e.g. ClaudeSDKClient.interrupt(). Registered per-job by the runner via
    ctx (TODO: wire once the SDK adapter lands)."""

    async def __call__(self) -> None: ...
