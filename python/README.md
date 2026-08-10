# fairway (backend)

The Python half of [fairway](https://github.com/datagoboom/fairway-kit) — a dev kit
for building local, agent-backed applications with durable, resumable chat.

```python
from fastapi import FastAPI
from fairway import mount_agent_chat
from fairway.adapters.claude_sdk import ClaudeSDKRunner

app = FastAPI()
store, registry = mount_agent_chat(
    app,
    db_path="./chat.db",
    runner=ClaudeSDKRunner(model="claude-opus-4-8", auth="subscription"),
)
```

One call mounts the full HTTP surface: sessions, send, SSE streaming with
seq-cursor replay, active-job reattach, server-owned stop, and restart-safe
job recovery. Any agent can drive it — a runner is just an async callable that
emits protocol events.

Pairs with [`fairway-kit`](https://github.com/datagoboom/fairway-kit/tree/main/js)
on the frontend. Full docs, the wire protocol, and a complete example app live
in the [repository](https://github.com/datagoboom/fairway-kit).
