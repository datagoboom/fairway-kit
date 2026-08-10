# fairway example chat

End-to-end test bed for the whole stack: FastAPI + `mount_agent_chat` +
`ClaudeSDKRunner` on the back, Vite/React + the fairway-kit components on the
front (consumed straight from `../../js/src` via a Vite alias, so there is no
build step for the lib).

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
