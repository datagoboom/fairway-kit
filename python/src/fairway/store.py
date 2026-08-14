"""Persistence over a swappable storage backend (PROTOCOL.md sections 7, 12).

fairway is single-writer: one process, one logical writer serialized by this
store's asyncio write-lock. The backend (SQLite / Postgres / MySQL) is just
storage - see fairway.backends. The write-lock guards the two places that need
cross-statement atomicity (the per-job seq assignment and the allow-tool
read-modify-write); every other write is a single atomic, autocommitting
statement, so it goes straight to the backend.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from .backends import Backend, backend_from_url


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _new_id() -> str:
    return uuid.uuid4().hex


class Store:
    def __init__(self, backend: Backend | str):
        # Accept a ready backend, or a URL/path for the common case.
        self.backend: Backend = backend if not isinstance(backend, str) else backend_from_url(backend)
        self._write_lock = asyncio.Lock()

    async def open(self) -> None:
        await self.backend.open()
        await self.backend.ensure_schema()

    async def close(self) -> None:
        await self.backend.close()

    # -- sessions ------------------------------------------------------------

    async def create_session(self, name: str | None = None) -> dict[str, Any]:
        sid = _new_id()
        await self.backend.execute(
            "INSERT INTO sessions (id, name, created_at) VALUES (?, ?, ?)",
            (sid, name, _now()),
        )
        return await self.get_session(sid)  # type: ignore[return-value]

    async def get_session(self, session_id: str) -> dict[str, Any] | None:
        return await self.backend.fetchone("SELECT * FROM sessions WHERE id = ?", (session_id,))

    async def list_sessions(self) -> list[dict[str, Any]]:
        return await self.backend.fetchall("SELECT * FROM sessions ORDER BY created_at DESC")

    async def delete_session(self, session_id: str) -> None:
        await self.backend.execute("DELETE FROM sessions WHERE id = ?", (session_id,))

    async def set_provider_session_id(self, session_id: str, provider_session_id: str) -> None:
        await self.backend.execute(
            "UPDATE sessions SET provider_session_id = ? WHERE id = ?",
            (provider_session_id, session_id),
        )

    async def get_allowed_tools(self, session_id: str) -> set[str]:
        row = await self.backend.fetchone(
            "SELECT allowed_tools_json FROM sessions WHERE id = ?", (session_id,)
        )
        raw = row["allowed_tools_json"] if row else None
        return set(json.loads(raw)) if raw else set()

    async def add_allowed_tool(self, session_id: str, tool: str) -> None:
        # Read-modify-write: serialize so a concurrent allow can't clobber it.
        async with self._write_lock:
            tools = await self.get_allowed_tools(session_id)
            tools.add(tool)
            await self.backend.execute(
                "UPDATE sessions SET allowed_tools_json = ? WHERE id = ?",
                (json.dumps(sorted(tools)), session_id),
            )

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
        await self.backend.execute(
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
        return mid

    async def flush_assistant(
        self, message_id: str, content: str, events: list[dict[str, Any]]
    ) -> None:
        """Incremental crash-safety flush during a run (PROTOCOL.md 7). Keeps streaming=1."""
        await self.backend.execute(
            "UPDATE messages SET content = ?, events_json = ? WHERE id = ?",
            (content, json.dumps(events), message_id),
        )

    async def finalize_assistant(
        self, message_id: str, content: str, events: list[dict[str, Any]]
    ) -> None:
        """Step 5 of the completion ordering: MUST be committed before the terminal
        event is broadcast."""
        await self.backend.execute(
            "UPDATE messages SET content = ?, events_json = ?, streaming = 0 WHERE id = ?",
            (content, json.dumps(events), message_id),
        )

    async def delete_message(self, message_id: str) -> None:
        await self.backend.execute("DELETE FROM messages WHERE id = ?", (message_id,))

    async def list_messages(
        self, session_id: str, *, include_streaming: bool = False, limit: int = 200
    ) -> list[dict[str, Any]]:
        q = "SELECT * FROM messages WHERE session_id = ?"
        if not include_streaming:
            q += " AND streaming = 0"
        # Deterministic insertion order: SQLite by the built-in rowid, Postgres/
        # MySQL by the ordinal column (see backends._schema). created_at is only
        # microsecond-resolution, so a user/assistant pair can tie on timestamp.
        q += f" ORDER BY {self._message_order} LIMIT ?"
        out = []
        for m in await self.backend.fetchall(q, (session_id, limit)):
            m.pop("ordinal", None)  # internal ordering key, not part of the message shape
            m["events"] = json.loads(m.pop("events_json")) if m.get("events_json") else None
            m["attachments"] = (
                json.loads(m.pop("attachments_json")) if m.get("attachments_json") else None
            )
            m["streaming"] = bool(m["streaming"])
            out.append(m)
        return out

    @property
    def _message_order(self) -> str:
        return "rowid" if self.backend.dialect == "sqlite" else "ordinal"

    async def get_message(self, message_id: str) -> dict[str, Any] | None:
        m = await self.backend.fetchone("SELECT * FROM messages WHERE id = ?", (message_id,))
        if not m:
            return None
        m.pop("ordinal", None)  # internal ordering key, not part of the message shape
        m["events"] = json.loads(m.pop("events_json")) if m.get("events_json") else None
        m["streaming"] = bool(m["streaming"])
        return m

    # -- attachments ---------------------------------------------------------

    async def add_attachment(
        self, session_id: str, name: str, media_type: str, size: int, path: str
    ) -> dict[str, Any]:
        aid = _new_id()
        await self.backend.execute(
            "INSERT INTO attachments (id, session_id, name, media_type, size, path, created_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?)",
            (aid, session_id, name, media_type, size, path, _now()),
        )
        return {"id": aid, "name": name, "media_type": media_type, "size": size}

    async def get_attachment(self, attachment_id: str) -> dict[str, Any] | None:
        return await self.backend.fetchone(
            "SELECT * FROM attachments WHERE id = ?", (attachment_id,)
        )

    # -- jobs ----------------------------------------------------------------

    async def create_job(self, session_id: str) -> str:
        jid = _new_id()
        now = _now()
        await self.backend.execute(
            "INSERT INTO jobs (id, session_id, status, created_at, updated_at)"
            " VALUES (?, ?, 'running', ?, ?)",
            (jid, session_id, now, now),
        )
        return jid

    async def set_job_status(self, job_id: str, status: str) -> None:
        await self.backend.execute(
            "UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?",
            (status, _now(), job_id),
        )

    async def get_job(self, job_id: str) -> dict[str, Any] | None:
        return await self.backend.fetchone("SELECT * FROM jobs WHERE id = ?", (job_id,))

    async def active_job_for_session(self, session_id: str) -> dict[str, Any] | None:
        return await self.backend.fetchone(
            "SELECT * FROM jobs WHERE session_id = ? AND status = 'running'"
            " ORDER BY created_at DESC LIMIT 1",
            (session_id,),
        )

    async def orphaned_running_jobs(self) -> list[dict[str, Any]]:
        return await self.backend.fetchall("SELECT * FROM jobs WHERE status = 'running'")

    # -- event log -----------------------------------------------------------

    async def append_event(self, job_id: str, event: dict[str, Any]) -> dict[str, Any]:
        """Assign seq + ts and persist. Returns the stamped event. This MUST be
        awaited before the event is offered to any subscriber (write-ahead rule).
        The SELECT MAX(seq)+1 -> INSERT is the one seq-critical section; the
        write-lock serializes it (single-writer), and UNIQUE(job_id, seq) is the
        backstop."""
        async with self._write_lock:
            row = await self.backend.fetchone(
                "SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM job_events WHERE job_id = ?",
                (job_id,),
            )
            seq = row["next_seq"] if row else 1
            stamped = {**event, "seq": seq, "ts": _now()}
            await self.backend.execute(
                "INSERT INTO job_events (job_id, seq, event_json, created_at) VALUES (?, ?, ?, ?)",
                (job_id, seq, json.dumps(stamped), stamped["ts"]),
            )
        return stamped

    async def get_events(self, job_id: str, since: int = 0) -> list[dict[str, Any]]:
        rows = await self.backend.fetchall(
            "SELECT event_json FROM job_events WHERE job_id = ? AND seq > ? ORDER BY seq",
            (job_id, since),
        )
        return [json.loads(r["event_json"]) for r in rows]

    async def prune_events(self, job_id: str) -> None:
        """Drop the whole log for one terminal job (its finalized events_json on
        the message row is the durable replay source, PROTOCOL.md 12)."""
        await self.backend.execute("DELETE FROM job_events WHERE job_id = ?", (job_id,))

    async def prune_terminal_event_logs(self, older_than_days: float) -> int:
        """Retention sweep: delete event logs of terminal jobs whose last update
        is older than the grace window. Returns the number of jobs pruned."""
        cutoff = (datetime.now(timezone.utc) - timedelta(days=older_than_days)).isoformat()
        job_rows = await self.backend.fetchall(
            "SELECT id FROM jobs WHERE status != 'running' AND updated_at < ?",
            (cutoff,),
        )
        job_ids = [row["id"] for row in job_rows]
        if job_ids:
            # Only the placeholder COUNT is interpolated; every value is a bound
            # parameter (standard variable-length IN clause), not injection.
            marks = ",".join("?" * len(job_ids))
            await self.backend.execute(  # nosemgrep: sqlalchemy-execute-raw-query
                f"DELETE FROM job_events WHERE job_id IN ({marks})",  # nosec B608  # noqa: S608
                job_ids,
            )
        return len(job_ids)

    async def delete_events_by_seq(self, job_id: str, seqs: list[int]) -> None:
        if not seqs:
            return
        # Only the placeholder COUNT is interpolated; values are bound.
        marks = ",".join("?" * len(seqs))
        await self.backend.execute(  # nosemgrep: sqlalchemy-execute-raw-query
            f"DELETE FROM job_events WHERE job_id = ? AND seq IN ({marks})",  # nosec B608  # noqa: S608
            [job_id, *seqs],
        )
