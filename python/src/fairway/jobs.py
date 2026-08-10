"""Job registry: pub/sub fan-out over the write-ahead event log, replay-then-tail
streaming, terminal ordering, stop escalation, startup orphan sweep.

Invariants enforced here (PROTOCOL.md sections 4, 7, 9, 10):
- append_event (durable, seq-stamped) happens BEFORE any subscriber sees an event.
- finalize_assistant is committed BEFORE the terminal event is appended/broadcast.
- Every job reaches a terminal event: runner success/failure paths, stop
  escalation, and the startup sweep all converge here.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import uuid
from typing import Any, AsyncIterator, Awaitable, Callable

import time

from . import events as E
from .fold import compactable_delta_seqs, final_text, fold_all
from .runner import Runner, TurnContext, TurnResult
from .store import Store

log = logging.getLogger("fairway.jobs")

HEARTBEAT_SECONDS = 20.0
STOP_GRACE_SECONDS = 5.0


class _LiveJob:
    def __init__(self, job_id: str):
        self.job_id = job_id
        self.subscribers: set[asyncio.Queue[dict[str, Any]]] = set()
        self.task: asyncio.Task[None] | None = None
        self.ctx: TurnContext | None = None
        self.graceful_stop: Callable[[], Awaitable[None]] | None = None
        self.terminal = asyncio.Event()
        self.pending_permissions: dict[str, asyncio.Future[str]] = {}


class JobRegistry:
    def __init__(
        self,
        store: Store,
        *,
        stop_grace: float = STOP_GRACE_SECONDS,
        flush_interval: float = 0.0,
    ):
        self._store = store
        self._live: dict[str, _LiveJob] = {}
        self._stop_grace = stop_grace
        self._flush_interval = flush_interval

    # -- lifecycle -----------------------------------------------------------

    async def startup_sweep(self) -> None:
        """PROTOCOL.md 10: convert every orphaned running job into a persisted
        terminal error so reconnecting clients always unlock."""
        for job in await self._store.orphaned_running_jobs():
            job_id = job["id"]
            evs = await self._store.get_events(job_id, since=0)
            message_id = next(
                (e["message_id"] for e in evs if e.get("type") == "message_start"), None
            )
            if message_id:
                items = fold_all(evs)
                content = final_text(evs)
                if content or any(i.get("type") == "tool" for i in items):
                    await self._store.finalize_assistant(message_id, content, evs)
                else:
                    await self._store.delete_message(message_id)
                    message_id = None
            await self._store.set_job_status(job_id, "error")
            await self._store.append_event(
                job_id, E.error("server restarted", message_id=message_id)
            )
            log.warning("swept orphaned job %s", job_id)

    # -- run -----------------------------------------------------------------

    def start(self, ctx: TurnContext, runner: Runner) -> None:
        live = _LiveJob(ctx.job_id)
        live.ctx = ctx
        self._live[ctx.job_id] = live
        live.task = asyncio.create_task(self._run(live, ctx, runner))

    async def _run(self, live: _LiveJob, ctx: TurnContext, runner: Runner) -> None:
        job_id = ctx.job_id
        emitted: list[dict[str, Any]] = []

        last_flush = 0.0

        async def emit(ev: dict[str, Any]) -> dict[str, Any]:
            nonlocal last_flush
            E.validate(ev)
            if E.is_terminal(ev):
                raise ValueError("runners must not emit terminal events; return TurnResult")
            stamped = await self._store.append_event(job_id, ev)  # durable first
            emitted.append(stamped)
            # Crash-safety flush (PROTOCOL.md 7): per-event by default,
            # rate-limited by flush_interval under load. The event log above is
            # already durable either way; this only affects mid-turn message rows.
            now = time.monotonic()
            if self._flush_interval <= 0 or now - last_flush >= self._flush_interval:
                last_flush = now
                await self._store.flush_assistant(
                    ctx.assistant_message_id, final_text(emitted), emitted
                )
            self._fan_out(live, stamped)
            return stamped

        async def request_permission(
            *,
            tool: str,
            kind: str = "unknown",
            label: str | None = None,
            detail: str | None = None,
            input: dict[str, Any] | None = None,
        ) -> str:
            # Session allow memory: previously allow_session'd tools skip the
            # gate silently (the tool_call event still shows the action).
            if tool in await self._store.get_allowed_tools(ctx.session["id"]):
                return "allow"
            request_id = uuid.uuid4().hex
            future: asyncio.Future[str] = asyncio.get_running_loop().create_future()
            live.pending_permissions[request_id] = future
            try:
                await emit(
                    E.permission_request(request_id, tool, kind, label or tool, detail, input)
                )
                decision = await future  # indefinite hold — resolved by the user or by stop()
            finally:
                live.pending_permissions.pop(request_id, None)
            await emit(E.permission_resolved(request_id, decision))
            if decision == "allow_session":
                await self._store.add_allowed_tool(ctx.session["id"], tool)
            return decision

        ctx.request_permission = request_permission

        try:
            await emit(E.message_start(ctx.assistant_message_id))
            result = await runner(ctx, emit)
            await self._finish(live, ctx, emitted, E.done(ctx.assistant_message_id, result.reason),
                               content=result.content or final_text(emitted), status="done")
        except asyncio.CancelledError:
            await self._finish(live, ctx, emitted, E.cancelled(ctx.assistant_message_id),
                               content=final_text(emitted), status="cancelled")
        except Exception as exc:  # noqa: BLE001 — runner failures become protocol errors
            log.exception("runner failed for job %s", job_id)
            await self._finish(live, ctx, emitted,
                               E.error(str(exc), message_id=ctx.assistant_message_id),
                               content=final_text(emitted), status="error")
        finally:
            for future in live.pending_permissions.values():
                if not future.done():
                    future.cancel()
            live.pending_permissions.clear()
            if ctx.new_provider_session_id:
                await self._store.set_provider_session_id(
                    ctx.session["id"], ctx.new_provider_session_id
                )
            live.terminal.set()
            self._live.pop(job_id, None)

    async def _finish(
        self,
        live: _LiveJob,
        ctx: TurnContext,
        emitted: list[dict[str, Any]],
        terminal_ev: dict[str, Any],
        *,
        content: str,
        status: str,
    ) -> None:
        # Ordering per PROTOCOL.md 7: finalize row (5) -> job status (6) -> terminal event (7).
        await self._store.finalize_assistant(ctx.assistant_message_id, content, emitted)
        await self._store.set_job_status(ctx.job_id, status)
        # Compaction (PROTOCOL.md 6): drop text deltas a text_block supersedes.
        # Fold-idempotent by construction. Runs BEFORE the terminal event is
        # appended so every replay that sees the terminal sees the same log;
        # live subscribers already received the deltas. Safe to fail silently —
        # the finalized events_json above is the durable copy.
        with contextlib.suppress(Exception):
            await self._store.delete_events_by_seq(
                ctx.job_id, compactable_delta_seqs(emitted)
            )
        stamped = await self._store.append_event(ctx.job_id, terminal_ev)
        self._fan_out(live, stamped)

    def _fan_out(self, live: _LiveJob, stamped: dict[str, Any]) -> None:
        for q in list(live.subscribers):
            q.put_nowait(stamped)

    # -- streaming -----------------------------------------------------------

    async def stream(self, job_id: str, since: int = 0) -> AsyncIterator[dict[str, Any] | None]:
        """Replay-then-tail. Yields stamped events; yields None as a heartbeat tick
        (the transport layer renders it as an SSE comment). Ends after a terminal
        event. Subscribe-before-read + seq dedupe closes the replay/live gap race.
        """
        live = self._live.get(job_id)
        q: asyncio.Queue[dict[str, Any]] | None = None
        if live is not None:
            q = asyncio.Queue()
            live.subscribers.add(q)
        try:
            last_seq = since
            for ev in await self._store.get_events(job_id, since=since):
                last_seq = max(last_seq, ev["seq"])
                yield ev
                if E.is_terminal(ev):
                    return
            if q is None:
                # Job not live (finished long ago, or swept). Log without a terminal
                # event only ever means "still running" — and it isn't, so the sweep
                # or finish path will have appended one; reaching here is done.
                job = await self._store.get_job(job_id)
                if job and job["status"] == "running":
                    log.error("job %s marked running but not live and no terminal event", job_id)
                return
            while True:
                try:
                    ev = await asyncio.wait_for(q.get(), timeout=HEARTBEAT_SECONDS)
                except asyncio.TimeoutError:
                    yield None  # heartbeat
                    continue
                if ev["seq"] <= last_seq:
                    continue  # already replayed
                last_seq = ev["seq"]
                yield ev
                if E.is_terminal(ev):
                    return
        finally:
            if live is not None and q is not None:
                live.subscribers.discard(q)

    # -- stop ----------------------------------------------------------------

    async def stop(self, job_id: str) -> str:
        """Server-owned escalation (PROTOCOL.md 9): graceful interrupt, then hard
        cancel after stop_grace. Idempotent."""
        live = self._live.get(job_id)
        if live is None:
            job = await self._store.get_job(job_id)
            return job["status"] if job else "unknown"
        # A held permission gate must never make a turn unstoppable: resolve
        # all pending requests as deny before interrupting (PROTOCOL.md).
        for future in live.pending_permissions.values():
            if not future.done():
                future.set_result("deny")
        graceful = live.graceful_stop or (live.ctx.graceful_stop if live.ctx else None)
        if graceful is not None:
            with contextlib.suppress(Exception):
                await graceful()
        if live.ctx is not None:
            live.ctx.cancel.set()
        asyncio.get_running_loop().call_later(self._stop_grace, self._hard_cancel, job_id)
        return "stopping"

    def _hard_cancel(self, job_id: str) -> None:
        live = self._live.get(job_id)
        if live is not None and live.task is not None and not live.terminal.is_set():
            live.task.cancel()  # _run's CancelledError path emits `cancelled`

    def register_graceful_stop(self, job_id: str, fn: Callable[[], Awaitable[None]]) -> None:
        """Called by adapters that support in-flight interrupt (e.g. ClaudeSDKClient)."""
        live = self._live.get(job_id)
        if live is not None:
            live.graceful_stop = fn

    # -- permissions ---------------------------------------------------------

    def resolve_permission(self, job_id: str, request_id: str, decision: str) -> bool:
        """Resolve a pending permission_request. Returns False if the job isn't
        live or the request is unknown/already resolved."""
        live = self._live.get(job_id)
        if live is None:
            return False
        future = live.pending_permissions.get(request_id)
        if future is None or future.done():
            return False
        future.set_result(decision)
        return True
