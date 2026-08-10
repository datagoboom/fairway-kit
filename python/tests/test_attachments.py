"""Attachments: upload, serve, send-time references, runner paths.
Plus hygiene: compaction correctness and the retention sweep."""

import io

import httpx
import pytest
from fastapi import FastAPI

from fairway import mount_agent_chat, events as E, fold_all
from fairway.fold import compactable_delta_seqs
from fairway.runner import TurnResult

PNG_1PX = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d"
    "49444154789c626001000000ffff03000006000557bfabd40000000049454e44ae426082"
)


class CapturingRunner:
    def __init__(self):
        self.seen_attachments = None

    async def __call__(self, ctx, emit):
        self.seen_attachments = ctx.attachments
        await emit(E.text_block("got it"))
        return TurnResult(content="got it")


@pytest.fixture
async def app_client(tmp_path):
    app = FastAPI()
    runner = CapturingRunner()
    store, registry = mount_agent_chat(
        app,
        db_path=str(tmp_path / "test.db"),
        runner=runner,
        attachments_dir=tmp_path / "atts",
    )
    async with httpx.ASGITransport(app=app) as transport:
        async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
            await store.open()
            await registry.startup_sweep()
            yield c, runner, store
            await store.close()


async def test_upload_send_serve_roundtrip(app_client, tmp_path):
    client, runner, _ = app_client
    session = (await client.post("/api/chat/sessions", json={})).json()["session"]

    up = await client.post(
        f"/api/chat/sessions/{session['id']}/attachments",
        files={"file": ("pixel.png", io.BytesIO(PNG_1PX), "image/png")},
    )
    assert up.status_code == 201
    att = up.json()
    assert att["name"] == "pixel.png" and att["media_type"] == "image/png"
    assert att["size"] == len(PNG_1PX)

    r = await client.post(
        f"/api/chat/sessions/{session['id']}/send",
        json={"content": "what is this?", "attachments": [{"id": att["id"]}]},
    )
    assert r.status_code == 202

    # Runner received the record with an absolute path to the stored bytes.
    import asyncio

    for _ in range(100):
        if runner.seen_attachments is not None:
            break
        await asyncio.sleep(0.02)
    assert runner.seen_attachments and runner.seen_attachments[0]["id"] == att["id"]
    with open(runner.seen_attachments[0]["path"], "rb") as f:
        assert f.read() == PNG_1PX

    # Persisted user message carries the public shape (no path).
    msgs = (await client.get(f"/api/chat/sessions/{session['id']}/messages")).json()["messages"]
    user_msg = next(m for m in msgs if m["role"] == "user")
    assert user_msg["attachments"] == [
        {"id": att["id"], "name": "pixel.png", "media_type": "image/png", "size": len(PNG_1PX)}
    ]

    # Serving returns the original bytes and media type.
    served = await client.get(f"/api/chat/attachments/{att['id']}")
    assert served.status_code == 200
    assert served.content == PNG_1PX
    assert served.headers["content-type"].startswith("image/png")


async def test_send_rejects_foreign_or_unknown_attachment(app_client):
    client, _, _ = app_client
    s1 = (await client.post("/api/chat/sessions", json={})).json()["session"]
    s2 = (await client.post("/api/chat/sessions", json={})).json()["session"]
    up = await client.post(
        f"/api/chat/sessions/{s1['id']}/attachments",
        files={"file": ("a.txt", io.BytesIO(b"hi"), "text/plain")},
    )
    att = up.json()
    # Unknown id
    r = await client.post(
        f"/api/chat/sessions/{s1['id']}/send",
        json={"content": "x", "attachments": [{"id": "nope"}]},
    )
    assert r.status_code == 400
    # Attachment from another session
    r = await client.post(
        f"/api/chat/sessions/{s2['id']}/send",
        json={"content": "x", "attachments": [{"id": att["id"]}]},
    )
    assert r.status_code == 400


# -- hygiene: compaction + retention ------------------------------------------


def test_compactable_delta_seqs_rules():
    events = [
        {"seq": 1, "type": "message_start", "message_id": "m"},
        {"seq": 2, "type": "text", "content": "a"},
        {"seq": 3, "type": "text", "content": "b"},
        {"seq": 4, "type": "text_block", "content": "ab"},   # run 1: compactable
        {"seq": 5, "type": "text", "content": "c"},
        {"seq": 6, "type": "tool_call", "id": "t", "tool": "x", "kind": "k", "label": "L"},
        # run 2 closed by tool_call without a block: NOT compactable
        {"seq": 7, "type": "permission_request", "id": "p", "tool": "W", "kind": "k", "label": "W"},
        {"seq": 8, "type": "text", "content": "d"},
        {"seq": 9, "type": "permission_resolved", "id": "p", "decision": "allow"},
        {"seq": 10, "type": "text", "content": "e"},
        {"seq": 11, "type": "text_block", "content": "de"},  # run 3 spans the matched resolution
        {"seq": 12, "type": "text", "content": "f"},
        {"seq": 13, "type": "permission_resolved", "id": "ghost", "decision": "deny"},
        {"seq": 14, "type": "text", "content": "g"},
        {"seq": 15, "type": "text_block", "content": "g"},
        # orphan resolution breaks run "f", so only "g" (seq 14) compacts
    ]
    compactable = compactable_delta_seqs(events)
    assert compactable == [2, 3, 8, 10, 14]
    # Removing exactly those seqs leaves the fold unchanged.
    kept = [e for e in events if e["seq"] not in set(compactable)]
    assert fold_all(kept) == fold_all(events)


async def test_retention_sweep(app_client, tmp_path):
    client, _, store = app_client
    session = (await client.post("/api/chat/sessions", json={})).json()["session"]
    r = await client.post(f"/api/chat/sessions/{session['id']}/send", json={"content": "x"})
    job_id = r.json()["job_id"]
    # Wait for terminal.
    import asyncio

    for _ in range(100):
        body = (await client.get(f"/api/chat/jobs/{job_id}/events")).json()
        if body["terminal"]:
            break
        await asyncio.sleep(0.02)
    assert await store.get_events(job_id)
    # A 0-day grace window prunes everything terminal immediately.
    pruned = await store.prune_terminal_event_logs(older_than_days=-0.001)
    assert pruned >= 1
    assert await store.get_events(job_id) == []
    # The message row still replays the turn.
    msgs = (await client.get(f"/api/chat/sessions/{session['id']}/messages")).json()["messages"]
    assert msgs[-1]["events"]
