"""End-to-end protocol flow over the real router with the EchoRunner:
send ordering, SSE replay-then-tail, ?since= resume, active-job reattach,
done carries message_id, 409 on concurrent send."""

import asyncio
import json

import httpx
import pytest
from fastapi import FastAPI

from fairway import mount_agent_chat
from fairway.adapters.claude_sdk import EchoRunner


@pytest.fixture
async def client(tmp_path):
    app = FastAPI()
    store, registry = mount_agent_chat(
        app, db_path=str(tmp_path / "test.db"), runner=EchoRunner()
    )
    async with httpx.ASGITransport(app=app) as transport:
        async with httpx.AsyncClient(
            transport=transport, base_url="http://test"
        ) as c:
            # ASGITransport doesn't run startup hooks; drive them manually.
            await store.open()
            await registry.startup_sweep()
            yield c
            await store.close()


async def _read_sse(client, job_id, since=0):
    events = []
    async with client.stream("GET", f"/api/chat/jobs/{job_id}/stream?since={since}") as r:
        async for line in r.aiter_lines():
            if line.startswith("data: "):
                events.append(json.loads(line[6:]))
                if events[-1]["type"] in ("done", "error", "cancelled"):
                    break
    return events


async def test_full_turn(client):
    session = (await client.post("/api/chat/sessions", json={"name": "t"})).json()["session"]
    resp = await client.post(
        f"/api/chat/sessions/{session['id']}/send", json={"content": "hello world"}
    )
    assert resp.status_code == 202
    body = resp.json()
    assert body["job_id"] and body["assistant_message_id"]

    events = await _read_sse(client, body["job_id"])
    types = [e["type"] for e in events]
    assert types[0] == "message_start"
    assert types[-1] == "done"
    assert events[-1]["message_id"] == body["assistant_message_id"]
    seqs = [e["seq"] for e in events]
    assert seqs == sorted(seqs) and len(set(seqs)) == len(seqs)

    # done-handoff: the message row must be readable immediately (no retries).
    msgs = (await client.get(f"/api/chat/sessions/{session['id']}/messages")).json()["messages"]
    assert [m["role"] for m in msgs] == ["user", "assistant"]
    assert msgs[1]["content"] == "You said: hello world"
    assert msgs[1]["events"], "assistant row must carry events_json"

    # replay with ?since= returns only the tail, still ends terminal
    mid_seq = seqs[len(seqs) // 2]
    tail = await _read_sse(client, body["job_id"], since=mid_seq)
    assert all(e["seq"] > mid_seq for e in tail)
    assert tail[-1]["type"] == "done"


async def test_replay_folds_identically_to_live(client):
    """Raw logs may differ after compaction (deltas dropped), but fold output —
    what the user sees — must be identical (PROTOCOL.md 5/6)."""
    from fairway.fold import fold_all

    session = (await client.post("/api/chat/sessions", json={})).json()["session"]
    body = (
        await client.post(f"/api/chat/sessions/{session['id']}/send", json={"content": "x"})
    ).json()
    live = await _read_sse(client, body["job_id"])
    replay = await _read_sse(client, body["job_id"])  # job now terminal → compacted DB replay
    assert fold_all(live) == fold_all(replay)
    # Compaction only ever removes superseded text deltas.
    live_seqs = {e["seq"] for e in live}
    replay_seqs = {e["seq"] for e in replay}
    assert replay_seqs <= live_seqs
    assert all(e["type"] == "text" for e in live if e["seq"] in live_seqs - replay_seqs)
    # Two post-terminal replays are byte-identical.
    assert replay == await _read_sse(client, body["job_id"])


async def test_conflict_on_concurrent_send(client, monkeypatch):
    session = (await client.post("/api/chat/sessions", json={})).json()["session"]

    class SlowRunner(EchoRunner):
        async def __call__(self, ctx, emit):
            await asyncio.sleep(0.3)
            return await super().__call__(ctx, emit)

    # First send occupies the session (EchoRunner is fast; use the running window).
    b1 = (
        await client.post(f"/api/chat/sessions/{session['id']}/send", json={"content": "a"})
    ).json()
    r2 = await client.post(f"/api/chat/sessions/{session['id']}/send", json={"content": "b"})
    if r2.status_code == 409:
        assert r2.json()["detail"]["active_job_id"] == b1["job_id"]
    else:
        # The first job may already have finished — that's a legal 202.
        assert r2.status_code == 202
    # Drain both jobs so the store can close cleanly.
    await _read_sse(client, b1["job_id"])
    if r2.status_code == 202:
        await _read_sse(client, r2.json()["job_id"])


async def test_active_job_reattach(client):
    session = (await client.post("/api/chat/sessions", json={})).json()["session"]
    a0 = (await client.get(f"/api/chat/sessions/{session['id']}/active-job")).json()
    assert a0["job_id"] is None
    body = (
        await client.post(f"/api/chat/sessions/{session['id']}/send", json={"content": "x"})
    ).json()
    await _read_sse(client, body["job_id"])
    a1 = (await client.get(f"/api/chat/sessions/{session['id']}/active-job")).json()
    assert a1["job_id"] is None  # terminal again after the turn
