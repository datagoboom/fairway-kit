# fairway example chat

End-to-end test bed for the whole stack: FastAPI + `mount_agent_chat` +
`ClaudeSDKRunner` on the back, Vite/React + `useAgentChat` on the front (consumed
straight from `../../js/src` via a Vite alias — no build step for the lib).

## Run

Backend (from this directory):

```sh
uv run --with fastapi --with aiosqlite --with "uvicorn[standard]" \
  --with-editable ../../python --with claude-agent-sdk \
  uvicorn server:app --port 8500 --reload
```

- Offline (no credentials needed): prefix with `FAIRWAY_RUNNER=echo`.
- Subscription mode: `FAIRWAY_AUTH=subscription` (uses your `claude login`).
- API mode: `FAIRWAY_AUTH=api` with `ANTHROPIC_API_KEY` set.

Frontend:

```sh
cd web && npm install && npm run dev   # http://localhost:5173
```

## What to test

- Send a message; watch token-level streaming and tool pills.
- **Refresh mid-response** — the page reloads history, finds the active job, and
  reattaches to the live stream (the bug class this library exists to kill).
- Stop mid-response — server-owned escalation, terminal event unlocks the UI.
- Kill and restart the backend mid-response — the startup sweep appends a
  terminal `error` event; reconnecting clients unlock instead of spinning.
- Two tabs on one session — second `send` gets a 409 and reattaches to the
  running job.
