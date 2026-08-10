"""FastAPI router factory implementing the HTTP surface (PROTOCOL.md section 11)."""

from __future__ import annotations

import json
import re
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, FastAPI, HTTPException, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel

MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024

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


class PermissionBody(BaseModel):
    request_id: str
    decision: Literal["allow", "allow_session", "deny"]


def build_router(
    store: Store,
    registry: JobRegistry,
    runner: Runner,
    attachments_dir: Path | None = None,
) -> APIRouter:
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

    @r.post("/sessions/{session_id}/attachments", status_code=201)
    async def upload_attachment(session_id: str, file: UploadFile) -> dict[str, Any]:
        if attachments_dir is None:
            raise HTTPException(400, "attachments are not enabled on this server")
        if not await store.get_session(session_id):
            raise HTTPException(404, "session not found")
        data = await file.read()
        if len(data) > MAX_ATTACHMENT_BYTES:
            raise HTTPException(413, "attachment too large")
        name = re.sub(r"[^\w.\- ]", "_", file.filename or "file")[:120] or "file"
        suffix = Path(name).suffix[:16]
        blob_name = f"{uuid.uuid4().hex}{suffix}"
        attachments_dir.mkdir(parents=True, exist_ok=True)
        (attachments_dir / blob_name).write_bytes(data)
        return await store.add_attachment(
            session_id,
            name=name,
            media_type=file.content_type or "application/octet-stream",
            size=len(data),
            path=blob_name,
        )

    @r.get("/attachments/{attachment_id}")
    async def get_attachment(attachment_id: str) -> FileResponse:
        att = await store.get_attachment(attachment_id)
        if not att or attachments_dir is None:
            raise HTTPException(404, "attachment not found")
        full = attachments_dir / att["path"]
        if not full.is_file():
            raise HTTPException(404, "attachment file missing")
        return FileResponse(full, media_type=att["media_type"], filename=att["name"])

    @r.post("/sessions/{session_id}/send", status_code=202)
    async def send(session_id: str, body: SendBody) -> dict[str, Any]:
        session = await store.get_session(session_id)
        if not session:
            raise HTTPException(404, "session not found")
        active = await store.active_job_for_session(session_id)
        if active:
            raise HTTPException(409, detail={"active_job_id": active["id"]})

        # Resolve attachment references (uploaded earlier) into full records;
        # runners get absolute paths, persisted messages keep the public shape.
        resolved: list[dict[str, Any]] = []
        for ref in body.attachments or []:
            att = await store.get_attachment(str(ref.get("id", "")))
            if not att or att["session_id"] != session_id:
                raise HTTPException(400, f"unknown attachment: {ref.get('id')}")
            resolved.append(att)
        public_refs = [
            {"id": a["id"], "name": a["name"], "media_type": a["media_type"], "size": a["size"]}
            for a in resolved
        ]
        runner_attachments = [
            {**pub, "path": str((attachments_dir / a["path"]).resolve())}
            for pub, a in zip(public_refs, resolved)
        ] if attachments_dir is not None else []

        # PROTOCOL.md 7 send ordering: history snapshot, user row, streaming
        # assistant row, job row — all durable before we respond or start the runner.
        history = await store.list_messages(session_id)
        user_message_id = await store.add_message(
            session_id, "user", body.content, attachments=public_refs or None
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
            attachments=runner_attachments,
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

    @r.post("/jobs/{job_id}/permission")
    async def permission(job_id: str, body: PermissionBody) -> dict[str, Any]:
        if not await store.get_job(job_id):
            raise HTTPException(404, "job not found")
        if not registry.resolve_permission(job_id, body.request_id, body.decision):
            raise HTTPException(409, "no such pending permission request")
        return {"status": "resolved"}

    return r


def mount_agent_chat(
    app: FastAPI,
    *,
    db_path: str,
    runner: Runner,
    prefix: str = "/api/chat",
    retention_days: float | None = 7.0,
    flush_interval: float = 0.0,
    attachments_dir: str | Path | None = None,
) -> tuple[Store, JobRegistry]:
    """One-call integration: opens the store, runs the startup sweep, mounts routes.

    retention_days: on startup, drop event logs of terminal jobs older than
    this (their finalized events_json on the message is the durable copy).
    None disables pruning. flush_interval: minimum seconds between mid-turn
    assistant-row flushes (0 = flush on every event; raise under heavy load).
    attachments_dir: where uploaded files land; defaults to a directory next to
    the database (<db>-attachments). Pass explicitly to relocate it.

    Returns (store, registry) so apps can register graceful-stop hooks, extension
    emitters, etc.
    """
    store = Store(db_path)
    registry = JobRegistry(store, flush_interval=flush_interval)
    if attachments_dir is None:
        p = Path(db_path)
        attachments_dir = p.parent / f"{p.stem}-attachments"
    attachments_path = Path(attachments_dir)

    # Wrap the app's lifespan rather than using deprecated on_event hooks, so
    # fairway composes with whatever lifespan the app already has.
    existing_lifespan = app.router.lifespan_context

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        await store.open()
        await registry.startup_sweep()
        if retention_days is not None:
            await store.prune_terminal_event_logs(older_than_days=retention_days)
        async with existing_lifespan(app):
            yield
        await store.close()

    app.router.lifespan_context = lifespan

    app.include_router(
        build_router(store, registry, runner, attachments_dir=attachments_path),
        prefix=prefix,
    )
    return store, registry
