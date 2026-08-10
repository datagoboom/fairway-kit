"""Permission gate: hold-until-resolved, session allow memory, deny, stop-deny,
and endpoint errors — through the real router.

Note on transport: httpx's ASGITransport buffers responses, so a live SSE tail
can't be consumed while the job is held at the gate. Tests therefore watch the
job via GET /jobs/{id}/events (polling), resolve the gate, and then assert on
the fully-replayed stream — same protocol surface, no deadlock.
"""

import asyncio
import json

import httpx
import pytest
from fastapi import FastAPI

from fairway import mount_agent_chat, events as E
from fairway.runner import TurnResult

TERMINAL = {"done", "error", "cancelled"}


class GatedRunner:
    """Asks permission for WebSearch, then acts on the decision."""

    def __init__(self):
        self.decisions: list[str] = []

    async def __call__(self, ctx, emit):
        decision = await ctx.request_permission(
            tool="WebSearch", kind="web", label="Web search", detail="test query"
        )
        self.decisions.append(decision)
        if decision in ("allow", "allow_session"):
            await emit(E.tool_call("t1", "WebSearch", "web", "Web search"))
            await emit(E.tool_result("t1", True, summary="3 results"))
            await emit(E.text_block("searched"))
            return TurnResult(content="searched")
        await emit(E.text_block("skipped"))
        return TurnResult(content="skipped")


@pytest.fixture
async def app_client(tmp_path):
    app = FastAPI()
    runner = GatedRunner()
    store, registry = mount_agent_chat(
        app, db_path=str(tmp_path / "test.db"), runner=runner
    )
    async with httpx.ASGITransport(app=app) as transport:
        async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
            await store.open()
            await registry.startup_sweep()
            yield c, runner
            await store.close()


async def send(client, session_id, content="go"):
    r = await client.post(f"/api/chat/sessions/{session_id}/send", json={"content": content})
    assert r.status_code == 202
    return r.json()


async def wait_for_event(client, job_id, event_type, timeout=5.0):
    """Poll the non-streaming event log until an event of event_type appears."""
    async with asyncio.timeout(timeout):
        while True:
            body = (await client.get(f"/api/chat/jobs/{job_id}/events")).json()
            for ev in body["events"]:
                if ev["type"] == event_type:
                    return ev
            await asyncio.sleep(0.02)


async def wait_terminal(client, job_id, timeout=5.0):
    async with asyncio.timeout(timeout):
        while True:
            body = (await client.get(f"/api/chat/jobs/{job_id}/events")).json()
            if body["terminal"]:
                return body["events"]
            await asyncio.sleep(0.02)


async def read_stream(client, job_id):
    """Full replay of a terminal job over SSE (buffered by ASGITransport)."""
    events = []
    async with client.stream("GET", f"/api/chat/jobs/{job_id}/stream") as r:
        async for line in r.aiter_lines():
            if line.startswith("data: "):
                events.append(json.loads(line[6:]))
    return events


async def resolve(client, job_id, request_id, decision):
    return await client.post(
        f"/api/chat/jobs/{job_id}/permission",
        json={"request_id": request_id, "decision": decision},
    )


async def test_allow_session_flow_and_memory(app_client):
    client, runner = app_client
    session = (await client.post("/api/chat/sessions", json={})).json()["session"]

    job = await send(client, session["id"])
    req = await wait_for_event(client, job["job_id"], "permission_request")
    assert req["tool"] == "WebSearch" and req["label"] == "Web search"
    assert (await resolve(client, job["job_id"], req["id"], "allow_session")).status_code == 200
    await wait_terminal(client, job["job_id"])

    events = await read_stream(client, job["job_id"])  # SSE replay of the whole turn
    types = [e["type"] for e in events]
    assert types.index("permission_request") < types.index("permission_resolved") < types.index("tool_call")
    resolved = next(e for e in events if e["type"] == "permission_resolved")
    assert resolved["decision"] == "allow_session"
    assert events[-1]["type"] == "done"

    # Second turn: the session allow set auto-approves — no gate events at all.
    job2 = await send(client, session["id"])
    events2 = await wait_terminal(client, job2["job_id"])
    types2 = [e["type"] for e in events2]
    assert "permission_request" not in types2
    assert "tool_call" in types2
    assert runner.decisions == ["allow_session", "allow"]


async def test_deny_flow(app_client):
    client, runner = app_client
    session = (await client.post("/api/chat/sessions", json={})).json()["session"]
    job = await send(client, session["id"])
    req = await wait_for_event(client, job["job_id"], "permission_request")
    await resolve(client, job["job_id"], req["id"], "deny")
    events = await wait_terminal(client, job["job_id"])

    assert runner.decisions == ["deny"]
    assert not any(e["type"] == "tool_call" for e in events)
    final = (await client.get(f"/api/chat/sessions/{session['id']}/messages")).json()["messages"][-1]
    assert final["content"] == "skipped"
    # The approval history is durable: the persisted events include the gate.
    ev_types = [e["type"] for e in final["events"]]
    assert "permission_request" in ev_types and "permission_resolved" in ev_types


async def test_stop_resolves_pending_as_deny(app_client):
    client, runner = app_client
    session = (await client.post("/api/chat/sessions", json={})).json()["session"]
    job = await send(client, session["id"])
    await wait_for_event(client, job["job_id"], "permission_request")

    r = await client.post(f"/api/chat/jobs/{job['job_id']}/stop")
    assert r.status_code == 202
    events = await wait_terminal(client, job["job_id"])

    resolved = next(e for e in events if e["type"] == "permission_resolved")
    assert resolved["decision"] == "deny"
    assert runner.decisions == ["deny"]
    assert events[-1]["type"] in TERMINAL  # the held turn always terminates


async def test_unknown_request_conflicts(app_client):
    client, _ = app_client
    session = (await client.post("/api/chat/sessions", json={})).json()["session"]
    job = await send(client, session["id"])
    req = await wait_for_event(client, job["job_id"], "permission_request")

    assert (await resolve(client, job["job_id"], "nope", "allow")).status_code == 409
    assert (await resolve(client, job["job_id"], req["id"], "allow")).status_code == 200
    await wait_terminal(client, job["job_id"])
    # Resolving again after resolution also conflicts.
    assert (await resolve(client, job["job_id"], req["id"], "deny")).status_code == 409
