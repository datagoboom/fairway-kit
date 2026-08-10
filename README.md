# fairway

[![ci](https://github.com/datagoboom/fairway-kit/actions/workflows/ci.yml/badge.svg)](https://github.com/datagoboom/fairway-kit/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A dev kit for building local, agent-backed applications. Two small libraries
(a Python backend and a TypeScript frontend) share a written wire protocol, so
the app you run on your own machine can have an agent streaming text and tool
calls into a live chat UI without the usual failure modes.

fairway is for tools you run yourself: personal dashboards, homelab utilities,
internal single-team apps, agent experiments. It is not a foundation for
production chatbots or multi-tenant SaaS, and it never phones home. Your
events, sessions, and transcripts live in a SQLite file next to your app.

If you've built an agent chat app before, some of this will sound familiar:

- Refreshing mid-response wipes the conversation, or leaves the UI stuck on a
  spinner forever.
- Events that rendered live are gone after a reconnect, because streaming and
  persistence were two different code paths.
- The reducer that merges streamed deltas into messages exists in three
  hand-synced copies that slowly drift apart.
- Stopping a response needs dueling client/server timeouts, and killing the
  server mid-turn strands jobs in a running state.

## How it works

```
POST /sessions/{id}/send -> persist user msg + assistant stub -> start job -> 202 {job_id}
                                             |
                          your runner (any agent SDK or LLM loop)
                                             | emit(event)
                          append to event log (durable, per-job seq)  <- the log IS the stream
                                             |
GET /jobs/{id}/stream?since=N -> replay persisted events > N, then tail live (SSE)
```

Every event is persisted before any client sees it and carries a monotonic
sequence number. A client can reconnect at any moment (mid-token, after a
refresh, after a server restart) and resume from where it left off with
`?since=`. The UI folds events into rendered messages with a single pure
function used identically for live streaming and replay, so what you see after
a refresh matches what you saw streaming.

The guarantees:

1. Per-job monotonic `seq` on every event, persisted before fan-out, resumable
   via `?since=`.
2. One durability class. There are no "stream-only" events that vanish on
   reconnect.
3. The assistant row exists before the first token and is committed before the
   terminal event fires (which carries its `message_id`), so the UI never has
   to poll and hope.
4. Live rendering and replay use the same fold, pinned by shared conformance
   vectors that both language test suites run.
5. Server restarts convert orphaned jobs into terminal errors on startup, so
   reconnecting clients always unlock.

## Packages

| Package | What it is |
|---|---|
| `fairway-kit` on PyPI (`import fairway`) | FastAPI router factory, event log and job registry (SQLite, Postgres, or MySQL), runner interface, Claude Agent SDK adapter |
| `@fairway-kit/client` on npm | SSE stream client with seq resume, typed REST client, React hook and headless components |
| `@fairway-kit/protocol` on npm | The wire protocol: event types and the normative fold, shared by clients and servers (a dependency of the client) |

> The npm frontend was previously the unscoped `fairway-kit`; it is now
> `@fairway-kit/client`. The old package is deprecated.

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
        system_prompt=lambda ctx: "You are a helpful assistant.",
    ),
)
```

That one call mounts the whole HTTP surface: sessions, send, SSE streaming
with replay, active-job reattach, server-owned stop escalation, and the
startup sweep.

### Storage backends

The default is a SQLite file, with zero extra dependencies. If you already run
Postgres or MySQL for the rest of your app and would rather not have a stray
SQLite file, pass a database URL instead:

```python
mount_agent_chat(app, db_url="postgresql://user:pass@localhost/mydb", runner=...)   # pip install "fairway-kit[postgres]"
mount_agent_chat(app, db_url="mysql://user:pass@localhost/mydb", runner=...)         # pip install "fairway-kit[mysql]"
mount_agent_chat(app, db_url="sqlite:///./chat.db", runner=...)                      # the default
```

This is a storage choice, not a scaling story. fairway is single-writer on
every backend: one process, one logical writer. It does not become a
multi-process system by pointing several workers at the same Postgres, because
a job's live stream, its permission gate, and its stop hook all live in the
memory of the process that started the turn. Use the database you already have;
don't reach for one expecting horizontal scale.

The Claude Agent SDK adapter is included, but a runner is just an async
callable. Wrap any SDK or a raw LLM loop:

```python
async def my_runner(ctx, emit):
    await emit({"type": "text", "content": "thinking about "})
    await emit({"type": "tool_call", "id": "t1", "tool": "search",
                "kind": "web", "label": "Search"})
    await emit({"type": "tool_result", "id": "t1", "ok": True})
    await emit({"type": "text_block", "content": "Here's what I found"})
    return TurnResult(content="Here's what I found")
```

Durability, sequencing, fan-out, persistence, and lifecycle are handled around
you. A runner only emits.

## Running write-capable agents on your own machine

A local agent runs with your filesystem and your credentials, so the gap
between "reads my notes" and "can delete them" deserves deliberate
configuration. fairway's model has three rings:

```python
runner = ClaudeSDKRunner(
    tools=["Read", "Glob", "Grep", "Write", "Edit", "Bash"],  # ring 3: exists at all
    allowed_tools=["Read", "Glob", "Grep"],                   # ring 1: pre-approved
    permission_mode="default",                                # ring 2: everything else asks
    cwd="/path/to/the/project",   # scope file tools to one directory
)
```

1. `tools` is the outer boundary. Anything not listed doesn't exist for the
   agent. Start minimal and add.
2. `allowed_tools` is the pre-approved set: these run without asking. Reserve
   it for read-only tools.
3. Everything in between goes through the permission gate (with
   `permission_mode="default"`). The turn pauses, an approval card renders
   inline in the chat, and nothing executes until you click Allow. "Always
   allow" remembers the tool for that session. Approvals are recorded in the
   event log, so the transcript shows exactly what you authorized, and a
   paused turn can always be stopped (stop denies pending requests first).

Two settings to leave alone unless you know why you're changing them:
`strict_mcp_config` defaults to `True` so host-level MCP servers from your
personal CLI config can't silently widen the agent's tool surface, and
`permission_mode="bypassPermissions"` disables the gate entirely, which is
fine for a read-only tool set and reckless with `Write` or `Bash`.

For custom runners the same gate is one call:
`decision = await ctx.request_permission(tool="deploy", kind="shell", label="Deploy")`.

## Frontend quickstart

```tsx
import { AgentChatClient } from "@fairway-kit/client";
import { ChatProvider, ChatPanel, ChatInput } from "@fairway-kit/client/react";
import "@fairway-kit/client/react/styles.css";   // optional default look

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

Out of the box: token-level streaming, tool-call pills, inline tool approval,
a typing indicator, stick-to-bottom scrolling with a jump-to-latest button,
optimistic sends, automatic reattach to in-flight responses on mount or
refresh, and stop.

The components are headless. They render semantic DOM with stable
`data-fairway-*` attributes and no styling opinions. Use the optional
stylesheet, restyle via CSS, or replace rendering entirely:

- Per-item-type overrides: `<ChatPanel components={{ Text: MarkdownText, Tool: MyChip }} />`.
  A markdown renderer ships at `fairway-kit/react/markdown`, and the map also
  accepts protocol extension event types as keys.
- Full bubble control via render prop: `<ChatPanel>{(row) => <MyBubble row={row} />}</ChatPanel>`.
- Or skip the components and build on `useAgentChat` / `useChatContext`.
  Everything below React (fold, stream client, REST client) is framework-free.

React is an optional peer dependency. The core has zero runtime dependencies.

## Example app

[`examples/chat`](examples/chat) is a full FastAPI + React chat app, themed
with MUI to show how far the customization goes, with an offline echo mode.
Use it to see the failure modes this project exists for: refresh mid-response
and watch the UI reattach to the live stream, or kill the backend mid-turn and
watch reconnecting clients unlock.

## Status and scope

Early (`0.x`, protocol `0.2`), so APIs may still move. Implemented and tested:
the full protocol surface, human-in-the-loop tool approval (inline in the
chat, indefinite hold, per-session allow memory, recorded in the event log),
the Claude Agent SDK adapter with API-key and subscription auth, and the React
components. On the roadmap: file and image attachments, event-log retention,
additional backend implementations.

The scope is intentional: single process, single user, SQLite, no auth. The
durability machinery exists so your local app survives refreshes, restarts,
and long agent turns, not so you can put it on the public internet. If you
need multi-tenant chat infrastructure, you want a different tool.

## License

[MIT](LICENSE)
