# fairway example chat

End-to-end test bed for the whole stack: an agent backend behind
`createAgentChat` + the Claude adapter, and a Vite/React front end using the
fairway-kit components. Both the front end and the Node backend consume the
libraries straight from `../../js/packages/*` source (via a Vite alias and
tsconfig paths respectively), so there is no build step for the lib — edits
hot-reload into the running example.

## Run (Node backend — `@fairway-kit/server`)

Backend (from `server/`):

```sh
cd server && npm install
FAIRWAY_RUNNER=echo npm run dev        # http://localhost:8500
```

- Offline (no credentials needed): `FAIRWAY_RUNNER=echo`.
- Claude mode is the default (the Claude Agent SDK is already installed with the
  lib) — just start without `FAIRWAY_RUNNER=echo` and provide credentials:
  - Subscription: `FAIRWAY_AUTH=subscription` (uses your `claude login`), or
    `FAIRWAY_AUTH=inherit` if the environment is already logged in.
  - API key: `FAIRWAY_AUTH=api` with `ANTHROPIC_API_KEY` set.
- Storage: defaults to SQLite (`server/fairway-example.db`); set `FAIRWAY_DB` to a
  path or a `postgresql://` / `mysql://` URL (install `pg` or `mysql2` in
  `server/` for those).

Frontend:

```sh
cd web && npm install && npm run dev   # http://localhost:5173 (proxies /api -> :8500)
```

### Python backend (alternative)

The same front end works against the Python `fairway` package. From this
directory:

```sh
uv run --with fastapi --with aiosqlite --with "uvicorn[standard]" \
  --with-editable ../../python --with claude-agent-sdk \
  uvicorn server:app --port 8500 --reload
```

Offline: prefix with `FAIRWAY_RUNNER=echo`.

## What to test

- Send a message and watch token-level streaming and tool pills.
- Ask it to search the web: the turn pauses on an inline approval card.
  "Always allow" remembers the tool for the session.
- Refresh mid-response. The page reloads history, finds the active job, and
  reattaches to the live stream, which is the bug class this library exists
  to kill.
- Stop mid-response: server-owned escalation, terminal event unlocks the UI.
- Kill and restart the backend mid-response. The startup sweep appends a
  terminal error event, and reconnecting clients unlock instead of spinning.
- Open the same session in two tabs and send from both. The second send gets
  a 409 and reattaches to the running job.
- Open Settings and switch the runner, model, auth mode, tools, or the
  available/pre-approved tool split — it rebuilds the runner live for the next
  message.
