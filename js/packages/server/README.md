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

A runner is any `async (ctx, emit) => TurnResult` — the integration seam.
`createAgentChat` invokes it; it never dictates how one is built, so you can plug
in any agent. Runners, the toolkit for building them, and the bundled adapters
live in [`@fairway-kit/agent`](https://www.npmjs.com/package/@fairway-kit/agent).
`EchoRunner` (re-exported here for convenience) exercises the whole path with no
credentials.

```ts
import { createAgentChat } from "@fairway-kit/server";
import { claudeCodeRunner } from "@fairway-kit/agent/claude-code";

const chat = createAgentChat({
  dbUrl: "./chat.db",
  runner: claudeCodeRunner({ model: "claude-opus-4-8", auth: "api" }),
});
```

See `@fairway-kit/agent` for the Runner contract, the `runnerFromStream` pump for
writing your own adapter in ~30 lines, and the permission-gate helpers.

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
