# fairway-kit (Rust)

Rust implementation of the fairway [Agent Chat Protocol](../../docs/PROTOCOL.md)
(draft v0.3) — the third implementation alongside the Python (`fairway-kit` on
PyPI) and Node (`@fairway-kit/server`) backends, pinned by the same
[conformance vectors](../../protocol/fold-vectors.json).

Built to be **embedded**. A desktop app (a Tauri shell, for example) mounts the
router in-process on a loopback port, and `@fairway-kit/client` runs unchanged
in the webview — no sidecar process, no Node runtime to bundle, no CORS.

```rust
use std::sync::Arc;
use fairway_kit::{create_agent_chat, AgentChatOptions, ClaudeCodeConfig, ClaudeCodeRunner};

#[tokio::main]
async fn main() {
    let chat = create_agent_chat(AgentChatOptions {
        db_path: Some("./chat.db".into()),
        runner: Arc::new(ClaudeCodeRunner::new(ClaudeCodeConfig {
            model: Some("claude-opus-4-8".into()),
            allowed_tools: vec!["Read".into(), "Glob".into(), "Grep".into()],
            ..Default::default()
        })),
        ..Default::default()
    })
    .unwrap();

    // Port 0 = pick a free loopback port; hand it to your webview.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    println!("chat on port {}", listener.local_addr().unwrap().port());
    axum::serve(listener, chat.into_router("/api/chat")).await.unwrap();
}
```

## What's implemented (v0.1)

- The full durability kernel: per-job seq event log (persist before fan-out),
  the §7 message lifecycle ordering, post-terminal delta compaction, stop
  escalation with a server-owned grace timer, the startup orphan sweep, and
  the session allow-memory permission broker.
- The normative fold (server-side use: deriving `content` from events), passing
  all shared conformance vectors.
- HTTP surface per §11 via axum: sessions, messages, send (with the 409
  cardinality rule), SSE stream with `?since=` replay-then-tail and 20s
  heartbeats, non-streaming events fetch, stop, permission resolution, meta.
- Storage: SQLite (rusqlite, bundled). Postgres/MySQL may follow behind
  feature flags if anyone needs them.
- Runners: the `Runner` trait (§13), `EchoRunner`, and `ClaudeCodeRunner`
  driving the `claude` CLI over `--output-format stream-json`.

## Known deltas vs the Node/Python servers

- **Attachments are not implemented yet** — uploads answer 400, matching the
  reference server's disabled-attachments mode.
- **ClaudeCodeRunner has no interactive HITL gate yet.** Pre-approve with
  `allowed_tools`, block with `disallowed_tools`, or set a `permission_mode`
  the host trusts. The registry-level permission broker (`request_permission`
  on `TurnHandle`) is fully implemented and tested — custom runners can use it
  today; wiring it to the CLI's permission callback is future work.
- `stop` uses a `CancellationToken` as the graceful interrupt (there is no
  separate SDK `interrupt()` hook); the forced `cancelled` after the grace
  window is identical to the JS behavior.

## Tests

```
cargo test
```

- `tests/fold_vectors.rs` — every shared vector, plus incremental-fold parity.
- `tests/integration.rs` — real-HTTP protocol tests: send → stream → replay
  fold-equality (compaction invisible), cursor resume, the 409 rule,
  active-job reattach, stop escalation, the permission gate holding a turn and
  remembering `allow_session`, and the startup sweep.
