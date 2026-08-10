"""Cross-backend conformance: the same Store operations must behave identically
on SQLite, Postgres, and MySQL.

SQLite always runs. Postgres/MySQL run only when their URL env var is set
(FAIRWAY_TEST_POSTGRES_URL / FAIRWAY_TEST_MYSQL_URL), so the default suite needs
no services; CI or a local docker run opts them in. Each backend gets a fresh,
isolated schema per test (a temp sqlite file, or dropped-and-recreated tables).
"""

import json
import os
import uuid

import pytest

from fairway import events as E
from fairway.backends import backend_from_url
from fairway.store import Store

PG_URL = os.environ.get("FAIRWAY_TEST_POSTGRES_URL")
MYSQL_URL = os.environ.get("FAIRWAY_TEST_MYSQL_URL")

BACKENDS = ["sqlite"]
if PG_URL:
    BACKENDS.append("postgres")
if MYSQL_URL:
    BACKENDS.append("mysql")


async def _reset(backend) -> None:
    """Drop fairway tables so each test starts clean on a shared server."""
    for table in ("job_events", "attachments", "messages", "jobs", "sessions"):
        await backend.execute(f"DROP TABLE IF EXISTS {table}")


@pytest.fixture(params=BACKENDS)
async def store(request, tmp_path):
    kind = request.param
    if kind == "sqlite":
        st = Store(str(tmp_path / f"{uuid.uuid4().hex}.db"))
        await st.open()
    elif kind == "postgres":
        st = Store(backend_from_url(PG_URL))
        await st.backend.open()
        await _reset(st.backend)
        await st.backend.ensure_schema()
    else:  # mysql
        st = Store(backend_from_url(MYSQL_URL))
        await st.backend.open()
        await _reset(st.backend)
        await st.backend.ensure_schema()
    yield st
    await st.close()


async def test_session_crud(store):
    s = await store.create_session("hello")
    assert s["name"] == "hello"
    assert (await store.get_session(s["id"]))["name"] == "hello"
    assert any(x["id"] == s["id"] for x in await store.list_sessions())
    await store.set_provider_session_id(s["id"], "prov-123")
    assert (await store.get_session(s["id"]))["provider_session_id"] == "prov-123"
    await store.delete_session(s["id"])
    assert await store.get_session(s["id"]) is None


async def test_allowed_tools(store):
    s = await store.create_session()
    assert await store.get_allowed_tools(s["id"]) == set()
    await store.add_allowed_tool(s["id"], "WebSearch")
    await store.add_allowed_tool(s["id"], "Read")
    await store.add_allowed_tool(s["id"], "WebSearch")  # idempotent
    assert await store.get_allowed_tools(s["id"]) == {"WebSearch", "Read"}


async def test_messages_and_attachments(store):
    s = await store.create_session()
    att = await store.add_attachment(s["id"], "pic.png", "image/png", 1234, "blob.png")
    assert (await store.get_attachment(att["id"]))["path"] == "blob.png"

    uid = await store.add_message(s["id"], "user", "hi", attachments=[att])
    aid = await store.add_message(s["id"], "assistant", streaming=True)
    await store.finalize_assistant(aid, "done", [{"seq": 1, "type": "text_block", "content": "done"}])

    # Streaming rows are excluded until finalized; attachments round-trip.
    msgs = await store.list_messages(s["id"])
    assert [m["role"] for m in msgs] == ["user", "assistant"]
    assert msgs[0]["attachments"][0]["id"] == att["id"]
    assert msgs[1]["content"] == "done" and msgs[1]["streaming"] is False
    assert msgs[1]["events"][0]["type"] == "text_block"

    got = await store.get_message(uid)
    assert got["content"] == "hi"


async def test_event_log_seq_and_replay(store):
    s = await store.create_session()
    job = await store.create_job(s["id"])
    assert (await store.active_job_for_session(s["id"]))["id"] == job

    stamped = []
    for ev in (E.message_start("m"), E.text("hello "), E.text_block("hello"), E.done("m")):
        stamped.append(await store.append_event(job, ev))
    # Monotonic seq starting at 1, no gaps.
    assert [e["seq"] for e in stamped] == [1, 2, 3, 4]

    replay = await store.get_events(job)
    assert [e["seq"] for e in replay] == [1, 2, 3, 4]
    assert replay[-1]["type"] == "done"
    # since-cursor
    assert [e["seq"] for e in await store.get_events(job, since=2)] == [3, 4]

    await store.set_job_status(job, "done")
    assert (await store.get_job(job))["status"] == "done"
    assert await store.active_job_for_session(s["id"]) is None


async def test_compaction_and_retention(store):
    s = await store.create_session()
    job = await store.create_job(s["id"])
    for ev in (E.message_start("m"), E.text("a"), E.text("b"), E.text_block("ab"), E.done("m")):
        await store.append_event(job, ev)
    await store.set_job_status(job, "done")

    # Delete the two superseded text deltas (seq 2,3); fold-equivalent replay.
    await store.delete_events_by_seq(job, [2, 3])
    assert [e["seq"] for e in await store.get_events(job)] == [1, 4, 5]

    # Retention: a 0-day window prunes the terminal job's remaining log.
    pruned = await store.prune_terminal_event_logs(older_than_days=-0.001)
    assert pruned >= 1
    assert await store.get_events(job) == []


async def test_orphan_sweep_query(store):
    s = await store.create_session()
    j1 = await store.create_job(s["id"])
    await store.set_job_status(j1, "done")
    j2 = await store.create_job(s["id"])
    orphans = {j["id"] for j in await store.orphaned_running_jobs()}
    assert j2 in orphans and j1 not in orphans


async def test_cascade_delete(store):
    """Deleting a session cascades to its messages, jobs, events, attachments."""
    s = await store.create_session()
    await store.add_message(s["id"], "user", "hi")
    job = await store.create_job(s["id"])
    await store.append_event(job, E.message_start("m"))
    await store.add_attachment(s["id"], "f", "text/plain", 1, "b")

    await store.delete_session(s["id"])
    assert await store.list_messages(s["id"]) == []
    assert await store.get_job(job) is None
    assert await store.get_events(job) == []
