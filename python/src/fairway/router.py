"""FastAPI router factory implementing the HTTP surface (PROTOCOL.md section 11)."""

from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from .events import PROTOCOL_VERSION
from .jobs import JobRegistry
from .runner import Runner, TurnContext
from .store import Store

SSE_HEADERS = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}


class SendBody(BaseModel):
    content: str
    attachments: list[dict[str, Any]] | None = None


class CreateSessionBody(BaseModel):
    name: str | None = None


def build_router(store: Store, registry: JobRegistry, runner: Runner) -> APIRouter:
    r = APIRouter()

    @r.get("/meta")
    async def meta() -> dict[str, Any]:
        return {"protocol_version": PROTOCOL_VERSION, "extensions": []}

    @r.post("/sessions", status_code=201)
    async def create_session(body: CreateSessionBody) -> dict[str, Any]:
        return {"session": await store.create_session(body.name)}

    @r.get("/sessions")
    async def list_sessions() -> dict[str, Any]:
        return {"sessions": await store.list_sessions()}

    @r.delete("/sessions/{session_id}", status_code=204)
    async def delete_session(session_id: str) -> None:
        await store.delete_session(session_id)

    @r.get("/sessions/{session_id}/messages")
    async def list_messages(session_id: str, limit: int = 200) -> dict[str, Any]:
        if not await store.get_session(session_id):
            raise HTTPException(404, "session not found")
        return {"messages": await store.list_messages(session_id, limit=limit)}

    @r.get("/sessions/{session_id}/active-job")
    async def active_job(session_id: str) -> dict[str, Any]:
        job = await store.active_job_for_session(session_id)
        return {"job_id": job["id"], "status": job["status"]} if job else {"job_id": None}

    @r.post("/sessions/{session_id}/send", status_code=202)
    async def send(session_id: str, body: SendBody) -> dict[str, Any]:
        session = await store.get_session(session_id)
        if not session:
            raise HTTPException(404, "session not found")
        active = await store.active_job_for_session(session_id)
        if active:
            raise HTTPException(409, detail={"active_job_id": active["id"]})

        # PROTOCOL.md 7 send ordering: history snapshot, user row, streaming
        # assistant row, job row — all durable before we respond or start the runner.
        history = await store.list_messages(session_id)
        user_message_id = await store.add_message(
            session_id, "user", body.content, attachments=body.attachments
        )
        assistant_message_id = await store.add_message(session_id, "assistant", streaming=True)
        job_id = await store.create_job(session_id)

        ctx = TurnContext(
            session=session,
            messages=history,
            user_content=body.content,
            user_message_id=user_message_id,
            assistant_message_id=assistant_message_id,
            job_id=job_id,
            attachments=body.attachments or [],
            provider_session_id=session.get("provider_session_id"),
        )
        registry.start(ctx, runner)
        return {
            "job_id": job_id,
            "user_message_id": user_message_id,
            "assistant_message_id": assistant_message_id,
        }

    @r.get("/jobs/{job_id}/stream")
    async def stream(job_id: str, since: int = 0) -> StreamingResponse:
        if not await store.get_job(job_id):
            raise HTTPException(404, "job not found")

        async def gen():
            async for ev in registry.stream(job_id, since=since):
                if ev is None:
                    yield ": hb\n\n"  # heartbeat comment — never an event (PROTOCOL.md 3)
                else:
                    yield f"data: {json.dumps(ev)}\n\n"

        return StreamingResponse(gen(), media_type="text/event-stream", headers=SSE_HEADERS)

    @r.get("/jobs/{job_id}/events")
    async def events(job_id: str, since: int = 0) -> dict[str, Any]:
        job = await store.get_job(job_id)
        if not job:
            raise HTTPException(404, "job not found")
        evs = await store.get_events(job_id, since=since)
        return {"events": evs, "terminal": job["status"] != "running"}

    @r.post("/jobs/{job_id}/stop", status_code=202)
    async def stop(job_id: str) -> dict[str, Any]:
        if not await store.get_job(job_id):
            raise HTTPException(404, "job not found")
        return {"status": await registry.stop(job_id)}

    return r


def mount_agent_chat(
    app: FastAPI,
    *,
    db_path: str,
    runner: Runner,
    prefix: str = "/api/chat",
) -> tuple[Store, JobRegistry]:
    """One-call integration: opens the store, runs the startup sweep, mounts routes.

    Returns (store, registry) so apps can register graceful-stop hooks, extension
    emitters, etc.
    """
    store = Store(db_path)
    registry = JobRegistry(store)

    @app.on_event("startup")
    async def _startup() -> None:  # TODO: migrate to lifespan-style for FastAPI >=0.110 apps
        await store.open()
        await registry.startup_sweep()

    @app.on_event("shutdown")
    async def _shutdown() -> None:
        await store.close()

    app.include_router(build_router(store, registry, runner), prefix=prefix)
    return store, registry
