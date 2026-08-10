"""SQLite persistence (PROTOCOL.md sections 7, 12).

One aiosqlite connection, WAL mode, serialized writes via an asyncio lock.
append_event assigns the per-job seq inside the write transaction — the write-ahead
guarantee lives here, the fan-out lives in jobs.JobRegistry.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from datetime import datetime, timezone
from typing import Any

import aiosqlite

SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    name TEXT,
    provider_session_id TEXT,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL DEFAULT '',
    events_json TEXT,
    streaming INTEGER NOT NULL DEFAULT 0,
    attachments_json TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);
CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('running', 'done', 'error', 'cancelled')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_session ON jobs(session_id, created_at);
CREATE TABLE IF NOT EXISTS job_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    event_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (job_id, seq)
);
"""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _new_id() -> str:
    return uuid.uuid4().hex


class Store:
    def __init__(self, path: str):
        self._path = path
        self._db: aiosqlite.Connection | None = None
        self._write_lock = asyncio.Lock()

    async def open(self) -> None:
        self._db = await aiosqlite.connect(self._path)
        self._db.row_factory = aiosqlite.Row
        await self._db.execute("PRAGMA journal_mode=WAL")
        await self._db.execute("PRAGMA foreign_keys=ON")
        await self._db.executescript(SCHEMA)
        await self._db.commit()

    async def close(self) -> None:
        if self._db:
            await self._db.close()
            self._db = None

    @property
    def db(self) -> aiosqlite.Connection:
        assert self._db is not None, "Store.open() not called"
        return self._db

    # -- sessions ------------------------------------------------------------

    async def create_session(self, name: str | None = None) -> dict[str, Any]:
        sid = _new_id()
        async with self._write_lock:
            await self.db.execute(
                "INSERT INTO sessions (id, name, created_at) VALUES (?, ?, ?)",
                (sid, name, _now()),
            )
            await self.db.commit()
        return await self.get_session(sid)  # type: ignore[return-value]

    async def get_session(self, session_id: str) -> dict[str, Any] | None:
        cur = await self.db.execute("SELECT * FROM sessions WHERE id = ?", (session_id,))
        row = await cur.fetchone()
        return dict(row) if row else None

    async def list_sessions(self) -> list[dict[str, Any]]:
        cur = await self.db.execute("SELECT * FROM sessions ORDER BY created_at DESC")
        return [dict(r) for r in await cur.fetchall()]

    async def delete_session(self, session_id: str) -> None:
        async with self._write_lock:
            await self.db.execute("DELETE FROM sessions WHERE id = ?", (session_id,))
            await self.db.commit()

    async def set_provider_session_id(self, session_id: str, provider_session_id: str) -> None:
        async with self._write_lock:
            await self.db.execute(
                "UPDATE sessions SET provider_session_id = ? WHERE id = ?",
                (provider_session_id, session_id),
            )
            await self.db.commit()

    # -- messages ------------------------------------------------------------

    async def add_message(
        self,
        session_id: str,
        role: str,
        content: str = "",
        *,
        streaming: bool = False,
        attachments: list[dict[str, Any]] | None = None,
    ) -> str:
        mid = _new_id()
        async with self._write_lock:
            await self.db.execute(
                "INSERT INTO messages (id, session_id, role, content, streaming, attachments_json, created_at)"
                " VALUES (?, ?, ?, ?, ?, ?, ?)",
                (
                    mid,
                    session_id,
                    role,
                    content,
                    1 if streaming else 0,
                    json.dumps(attachments) if attachments else None,
                    _now(),
                ),
            )
            await self.db.commit()
        return mid

    async def flush_assistant(
        self, message_id: str, content: str, events: list[dict[str, Any]]
    ) -> None:
        """Incremental crash-safety flush during a run (PROTOCOL.md 7). Keeps streaming=1."""
        async with self._write_lock:
            await self.db.execute(
                "UPDATE messages SET content = ?, events_json = ? WHERE id = ?",
                (content, json.dumps(events), message_id),
            )
            await self.db.commit()

    async def finalize_assistant(
        self, message_id: str, content: str, events: list[dict[str, Any]]
    ) -> None:
        """Step 5 of the completion ordering: MUST be committed before the terminal
        event is broadcast."""
        async with self._write_lock:
            await self.db.execute(
                "UPDATE messages SET content = ?, events_json = ?, streaming = 0 WHERE id = ?",
                (content, json.dumps(events), message_id),
            )
            await self.db.commit()

    async def delete_message(self, message_id: str) -> None:
        async with self._write_lock:
            await self.db.execute("DELETE FROM messages WHERE id = ?", (message_id,))
            await self.db.commit()

    async def list_messages(
        self, session_id: str, *, include_streaming: bool = False, limit: int = 200
    ) -> list[dict[str, Any]]:
        q = "SELECT * FROM messages WHERE session_id = ?"
        if not include_streaming:
            q += " AND streaming = 0"
        q += " ORDER BY created_at, id LIMIT ?"
        cur = await self.db.execute(q, (session_id, limit))
        out = []
        for r in await cur.fetchall():
            m = dict(r)
            m["events"] = json.loads(m.pop("events_json")) if m.get("events_json") else None
            m["attachments"] = (
                json.loads(m.pop("attachments_json")) if m.get("attachments_json") else None
            )
            m["streaming"] = bool(m["streaming"])
            out.append(m)
        return out

    async def get_message(self, message_id: str) -> dict[str, Any] | None:
        cur = await self.db.execute("SELECT * FROM messages WHERE id = ?", (message_id,))
        row = await cur.fetchone()
        if not row:
            return None
        m = dict(row)
        m["events"] = json.loads(m.pop("events_json")) if m.get("events_json") else None
        m["streaming"] = bool(m["streaming"])
        return m

    # -- jobs ----------------------------------------------------------------

    async def create_job(self, session_id: str) -> str:
        jid = _new_id()
        now = _now()
        async with self._write_lock:
            await self.db.execute(
                "INSERT INTO jobs (id, session_id, status, created_at, updated_at) VALUES (?, ?, 'running', ?, ?)",
                (jid, session_id, now, now),
            )
            await self.db.commit()
        return jid

    async def set_job_status(self, job_id: str, status: str) -> None:
        async with self._write_lock:
            await self.db.execute(
                "UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?",
                (status, _now(), job_id),
            )
            await self.db.commit()

    async def get_job(self, job_id: str) -> dict[str, Any] | None:
        cur = await self.db.execute("SELECT * FROM jobs WHERE id = ?", (job_id,))
        row = await cur.fetchone()
        return dict(row) if row else None

    async def active_job_for_session(self, session_id: str) -> dict[str, Any] | None:
        cur = await self.db.execute(
            "SELECT * FROM jobs WHERE session_id = ? AND status = 'running'"
            " ORDER BY created_at DESC LIMIT 1",
            (session_id,),
        )
        row = await cur.fetchone()
        return dict(row) if row else None

    async def orphaned_running_jobs(self) -> list[dict[str, Any]]:
        cur = await self.db.execute("SELECT * FROM jobs WHERE status = 'running'")
        return [dict(r) for r in await cur.fetchall()]

    # -- event log -----------------------------------------------------------

    async def append_event(self, job_id: str, event: dict[str, Any]) -> dict[str, Any]:
        """Assign seq + ts and persist. Returns the stamped event. This MUST be
        awaited before the event is offered to any subscriber (write-ahead rule)."""
        async with self._write_lock:
            cur = await self.db.execute(
                "SELECT COALESCE(MAX(seq), 0) + 1 FROM job_events WHERE job_id = ?", (job_id,)
            )
            (seq,) = await cur.fetchone()  # type: ignore[misc]
            stamped = {**event, "seq": seq, "ts": _now()}
            await self.db.execute(
                "INSERT INTO job_events (job_id, seq, event_json, created_at) VALUES (?, ?, ?, ?)",
                (job_id, seq, json.dumps(stamped), stamped["ts"]),
            )
            await self.db.commit()
        return stamped

    async def get_events(self, job_id: str, since: int = 0) -> list[dict[str, Any]]:
        cur = await self.db.execute(
            "SELECT event_json FROM job_events WHERE job_id = ? AND seq > ? ORDER BY seq",
            (job_id, since),
        )
        return [json.loads(r["event_json"]) for r in await cur.fetchall()]

    async def prune_events(self, job_id: str) -> None:
        """Optional retention (PROTOCOL.md 12): drop the log for a terminal job once
        events_json is finalized. TODO: call from a retention sweep with a grace window."""
        async with self._write_lock:
            await self.db.execute("DELETE FROM job_events WHERE job_id = ?", (job_id,))
            await self.db.commit()
