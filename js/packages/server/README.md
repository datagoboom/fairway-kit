# @fairway-kit/server

The Node/TypeScript backend for [fairway](https://github.com/datagoboom/fairway-kit),
a dev kit for building local, agent-backed applications with durable, resumable
chat. Implements the [Agent Chat Protocol](https://github.com/datagoboom/fairway-kit/blob/main/PROTOCOL.md)
and depends on [`@fairway-kit/protocol`](https://www.npmjs.com/package/@fairway-kit/protocol)
for the shared event types and fold. Pair it with
[`@fairway-kit/client`](https://www.npmjs.com/package/@fairway-kit/client) for an
all-Node (Node + React) stack, or use the `fairway-kit` Python package instead —
the wire protocol is identical.

```ts
import http from "node:http";
import { createAgentChat, EchoRunner } from "@fairway-kit/server";

const chat = createAgentChat({ dbUrl: "./chat.db", runner: EchoRunner });
await chat.start();          // opens the store, runs the startup orphan sweep
await chat.listen(8500);     // or: http.createServer(chat.handler).listen(8500)
```

Mount into an existing server instead — the handler is framework-agnostic
`node:http` (Express req/res are node req/res):

```ts
app.use(async (req, res, next) => {
  if (!(await chat.handler(req, res))) next();
});
```

## Runners

A runner is any `async (ctx, emit) => TurnResult`. Emit protocol events as the
turn progresses; the registry persists each one before fan-out, so live
streaming and replay are byte-identical and a refresh reattaches to an in-flight
response. `EchoRunner` exercises the whole path with no credentials.

The bundled Claude adapter drives a turn with the
[Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)
(an optional peer dependency — install it to use the adapter):

```ts
import { claudeSDKRunner } from "@fairway-kit/server/claude";

const chat = createAgentChat({
  dbUrl: "./chat.db",
  runner: claudeSDKRunner({ model: "claude-opus-4-8", auth: "api" }),
});
```

It maps SDK messages to protocol events (coalesced text/thinking deltas,
authoritative text blocks, tool calls and results), rounds the provider session
id back through `resume` for continuity, wires the human-in-the-loop permission
gate into the SDK's `canUseTool`, and interrupts the live turn on stop. Auth
modes: `"api"` (per-token via `ANTHROPIC_API_KEY`), `"subscription"` (the CLI's
stored login, optionally a `claude setup-token` token), or `"inherit"`.

## Storage

SQLite by default (zero extra dependencies, via `better-sqlite3`). Postgres and
MySQL are drop-in via the database URL — install the driver you use:

```ts
createAgentChat({ dbUrl: "postgresql://user:pass@host/db", runner });  // needs `pg`
createAgentChat({ dbUrl: "mysql://user:pass@host/db", runner });       // needs `mysql2`
```

fairway is **single-writer by design** — one process, one logical writer
serialized by an in-process lock. The database is a storage choice, not a way to
run multiple processes: the live job registry, SSE fan-out, and permission-gate
futures all live in process memory. This is a dev kit for local agent-backed
apps, not production multi-tenant chat infrastructure.

## Attachments

Uploads land on local disk (independent of the database), default next to a
SQLite file or `./fairway-attachments` for a networked database. Files are served
back as forced downloads with `X-Content-Type-Options: nosniff`, confined to the
attachments directory. Pass `attachmentsDir: null` to disable uploads.

Full docs and a complete example app live in the
[repository](https://github.com/datagoboom/fairway-kit).
