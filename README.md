# fairway

[![ci](https://github.com/datagoboom/fairway/actions/workflows/ci.yml/badge.svg)](https://github.com/datagoboom/fairway/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**A dev kit for building local, agent-backed applications.** Two small
libraries — a Python backend and a TypeScript frontend — connected by a written
wire protocol, so the app you're building on your own machine can have an agent
streaming text and tool calls into a live chat UI without the usual failure
modes.

fairway is for the tools you run yourself: personal dashboards, homelab
utilities, internal single-team apps, agent experiments — anywhere the "users"
are you and the people you sit near. It is deliberately **not** a foundation
for production chatbots or multi-tenant SaaS, and it never phones home: your
events, sessions, and transcripts live in a SQLite file next to your app.

If you've built an agent chat app, you've probably hit these:

- Refreshing mid-response wipes the conversation, or leaves the UI stuck on a
  spinner forever.
- Events that rendered live are gone after a reconnect, because streaming and
  persistence were two different code paths.
- The "merge streamed deltas into messages" reducer exists in three hand-synced
  copies that slowly drift apart.
- Stopping a response needs dueling client/server timeouts; killing the server
  mid-turn strands jobs in a running state.

fairway is those bugs, fixed once, behind a small API.

## How it works

```
POST /sessions/{id}/send ─▶ persist user msg + assistant stub ─▶ start job ─▶ 202 {job_id}
                                             │
                          your runner (any agent SDK or LLM loop)
                                             │ emit(event)
                          append to event log (durable, per-job seq)  ◀── the log IS the stream
                                             │
GET /jobs/{id}/stream?since=N ─▶ replay persisted events > N, then tail live (SSE)
```

Every event is persisted **before** any client sees it and carries a monotonic
sequence number, so a client can reconnect at any moment — mid-token, after a
refresh, after a server restart — and resume from where it left off with
`?since=`. The UI folds events into rendered messages with a single pure
function used identically for live streaming and replay, so what you see after
a refresh is byte-for-byte what you saw streaming.

**Guarantees** (spelled out in [PROTOCOL.md](PROTOCOL.md)):

1. Per-job monotonic `seq` on every event; persist-before-fan-out; resumable via `?since=`.
2. One durability class — no "stream-only" events that vanish on reconnect.
3. The assistant row exists before the first token and is committed before the
   terminal event fires (which carries its `message_id`) — the UI never polls
   and prays.
4. Live rendering and replay use the same fold, pinned by shared conformance
   vectors that both language test suites run.
5. Server restarts convert orphaned jobs into terminal errors on startup, so
   reconnecting clients always unlock.

## Packages

| Package | What it is |
|---|---|
| `fairway` (Python) | FastAPI router factory, SQLite-backed event log + job registry, runner interface, Claude Agent SDK adapter |
| `fairway-kit` (TypeScript) | SSE stream client with seq resume, the fold, typed REST client, React hook + headless components |
| [`PROTOCOL.md`](PROTOCOL.md) | The versioned wire + storage contract both packages implement |

Not yet published to PyPI/npm — consume from source for now (see the example app).

## Backend quickstart

```python
from fastapi import FastAPI
from fairway import mount_agent_chat
from fairway.adapters.claude_sdk import ClaudeSDKRunner

app = FastAPI()

store, registry = mount_agent_chat(
    app,
    db_path="./chat.db",
    runner=ClaudeSDKRunner(
        model="claude-opus-4-8",
        auth="subscription",          # or "api" (ANTHROPIC_API_KEY) or "inherit"
        tools=["Read", "Glob", "Grep", "WebSearch"],
        strict_mcp_config=True,
        system_prompt=lambda ctx: "You are a helpful assistant.",
    ),
)
```

That one call mounts the whole HTTP surface: sessions, send, SSE streaming with
replay, active-job reattach, server-owned stop escalation, and the startup
sweep.

**Bring your own agent.** The Claude Agent SDK adapter is included, but a runner
is just an async callable — wrap any SDK or a raw LLM loop:

```python
async def my_runner(ctx, emit):
    await emit({"type": "text", "content": "thinking about "})
    await emit({"type": "tool_call", "id": "t1", "tool": "search",
                "kind": "web", "label": "Search"})
    await emit({"type": "tool_result", "id": "t1", "ok": True})
    await emit({"type": "text_block", "content": "Here's what I found…"})
    return TurnResult(content="Here's what I found…")
```

Durability, sequencing, fan-out, persistence, and lifecycle are handled around
you — a runner only emits.

## Frontend quickstart

```tsx
import { AgentChatClient } from "fairway-kit";
import { ChatProvider, ChatPanel, ChatInput } from "fairway-kit/react";
import "fairway-kit/react/styles.css";   // optional default look

const client = new AgentChatClient("/api/chat");

function Chat({ sessionId }: { sessionId: string }) {
  return (
    <ChatProvider client={client} sessionId={sessionId}>
      <div style={{ flex: 1, minHeight: 0 }}>
        <ChatPanel />        {/* messages only; fills its container */}
      </div>
      <ChatInput />
    </ChatProvider>
  );
}
```

Out of the box: token-level streaming, tool-call pills, a typing indicator,
stick-to-bottom scrolling with a jump-to-latest affordance, optimistic sends,
automatic reattach to in-flight responses on mount/refresh, and stop.

**Headless by design.** Components render semantic DOM with stable
`data-fairway-*` attributes and no styling opinions — use the optional
stylesheet, restyle via CSS, or replace rendering entirely:

- Per-item-type overrides: `<ChatPanel components={{ Text: MarkdownText, Tool: MyChip }} />`
  (markdown renderer available at `fairway-kit/react/markdown`; keys also
  accept protocol extension event types).
- Full bubble control via render prop: `<ChatPanel>{(row) => <MyBubble row={row} />}</ChatPanel>`.
- Or drop the components and build on `useAgentChat` / `useChatContext` —
  everything below React (fold, stream client, REST client) is framework-free.

React is an optional peer dependency; the core has zero runtime dependencies.

## Example app

[`examples/chat`](examples/chat) is a full FastAPI + React chat app (MUI-themed
to demonstrate customization) with an offline echo mode. Use it to see the
failure modes this project exists for: refresh mid-response and watch the UI
reattach to the live stream; kill the backend mid-turn and watch reconnecting
clients unlock.

## Status & scope

Early (`0.x`, protocol `0.1`) — APIs may still move. Implemented and tested:
the full protocol surface, Claude Agent SDK adapter (API-key and subscription
auth), React components. On the roadmap: file/image attachments,
human-in-the-loop tool approval, event-log retention, additional backend
implementations.

**Scope, stated plainly:** single process, single user, SQLite, no auth — by
design, permanently in spirit. The durability machinery exists so *your local
app* survives refreshes, restarts, and long agent turns, not so you can put it
on the public internet. If you need multi-tenant chat infrastructure, you want
a different tool.

## License

[MIT](LICENSE)
