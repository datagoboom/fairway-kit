# Agent Chat Protocol — draft v0.2

*A wire + storage contract for integrating a streaming agent with an API backend and a live-chat UI. Distilled from five production implementations of this pattern, each of which fixed a different subset of the same recurring bugs. Server and client libraries implement this spec; apps extend it only through the declared extension points.*

Keywords MUST / SHOULD / MAY are used in the RFC-2119 sense.

---

## 1. Model

- **Session** — a conversation thread. Owns messages and jobs. May carry a provider resume token (e.g. Claude Agent SDK session id) as an opaque string.
- **Message** — a persisted turn: `role ∈ {user, assistant}`, final `content` (markdown), and `events` (the ordered event subsequence that produced an assistant turn, enabling rich re-render).
- **Job** — one assistant turn in execution. `status ∈ {running, done, error, cancelled}`. Exactly the terminal statuses correspond to terminal events.
- **Event** — an append-only, sequence-numbered record streamed to clients and persisted to the job's event log.

**Cardinality rule:** a session has **at most one `running` job** at a time. `send` against a session with a running job MUST fail with `409` carrying `{active_job_id}`. (Queueing/interrupt-and-resend is a client-side behavior built on `stop` + retry.)

## 2. Event envelope

Every event is a flat JSON object:

```json
{ "seq": 42, "type": "text", "ts": "2026-08-10T17:03:22.114Z", ...fields }
```

- `seq` — integer, **per-job**, strictly increasing, starting at 1, assigned by the event log at persist time. No gaps required, no gaps guaranteed after compaction (§6).
- `type` — string discriminator. Core types in §3. Types beginning `x_` are extensions (§8).
- `ts` — ISO-8601 UTC, assigned server-side.

Unknown `type` values MUST be passed through by transports and stores, and treated as opaque items by the fold (§5) — never dropped, never fatal.

## 3. Core event types

### Content
| type | fields | semantics |
|---|---|---|
| `message_start` | `message_id` | First event of every job. Announces the pre-created assistant row (§7). |
| `text` | `content` | Text delta. Appends to the current text run. |
| `text_block` | `content` | Authoritative full text of the **current run** (all `text` deltas since the last non-`text` content event). Replaces that run on fold. Emitted at the end of each run. |
| `thinking` | `content` | Reasoning delta. Folds like `text` but into a separate `thinking` item. MAY be truncated server-side. |

### Tools
| type | fields | semantics |
|---|---|---|
| `tool_call` | `id`, `tool`, `kind`, `label`, `detail?`, `input?` | Tool invocation started. `id` is the provider's tool-use id (unique within the job). `kind`/`label`/`detail` are **derived server-side** from the tool registry — clients MUST NOT maintain their own name→label maps (styling by `kind` is fine). |
| `tool_result` | `id`, `ok` (bool), `summary?`, `detail?` | Tool finished. **Matched to `tool_call` by `id`**, never by "most recent undone." An unmatched `tool_result` folds to an orphan item (visible, flagged), not an error. |

### Permissions (human-in-the-loop tool approval)
| type | fields | semantics |
|---|---|---|
| `permission_request` | `id`, `tool`, `kind`, `label`, `detail?`, `input?` | The agent wants to run a tool that needs approval. The turn **holds indefinitely** until resolved — there is no timeout. `id` is unique within the job. Metadata is server-derived, same as `tool_call`. |
| `permission_resolved` | `id`, `decision` | The user decided: `"allow"` (this call), `"allow_session"` (this call + auto-allow this tool for the rest of the session), or `"deny"`. Matched to `permission_request` by `id`. |

**Session allow memory:** on `allow_session`, the server records the tool name
against the session. Later requests for that tool in the same session are
auto-allowed silently — no `permission_request` is emitted (the `tool_call`
event still shows the action). The set persists across restarts with the
session.

**Stop interaction:** `POST /jobs/{id}/stop` resolves all pending permission
requests as `deny` before interrupting, so a held turn can always be stopped.

### Terminal (exactly one per job, always last)
| type | fields | semantics |
|---|---|---|
| `done` | `message_id`, `reason?` | Success. `message_id` is the finalized assistant row, **committed before this event is emitted** (§7). |
| `error` | `message`, `message_id?` | Failure. `message_id` present iff partial content was persisted. |
| `cancelled` | `message_id?` | Stop escalated to hard cancel (§9). |

### Never persisted
Heartbeats are **SSE comments** (`: hb\n\n`), not events. They carry no `seq`, MUST NOT enter the event log, and MUST be ignored by parsers. Interval: 20s while a stream is idle.

## 4. Durability invariants (the core of the spec)

1. **Single durability class.** Every event (all of §3 except heartbeats, plus all `x_*` events) is persisted. There is no "stream-only" tier. *(A common design splits a persisted `broadcast` path from a `stream_only` path — the direct cause of "events disappear on reconnect."; this spec forbids it.)*
2. **Persist before fan-out.** An event is appended to the log (and `seq` assigned) before any subscriber sees it. The log **is** the stream; replay and live are the same data.
3. **Delta coalescing happens before persistence.** The runner MAY coalesce rapid `text`/`thinking` deltas (e.g. flush every ≥100ms or ≥6 words) — but coalescing occurs *before* seq assignment, so the wire and the log remain identical.
4. **Bounded terminality.** Every job reaches a terminal event in bounded time: runner exit paths, stop escalation (§9), and startup orphan sweep (§10) all append one. A log without a terminal event only ever means "still running."

## 5. Fold: events → render items (normative)

One pure function, shared by live streaming and replay-from-storage. Client libraries ship it; server libraries use the same algorithm when deriving `content` from events.

```
fold(items, event) → items
```

- `message_start` → no item (metadata).
- `text` → if last item is `{type:'text', open:true}` append `content` to it; else push a new open text item.
- `text_block` → replace the trailing open text item's content with `content` and close it; if none, push a closed text item. *(Closed = a later `text` starts a new run.)*
- `thinking` → same as `text`, into an open thinking item.
- `tool_call` → close any open text/thinking item; push `{type:'tool', id, kind, label, detail, status:'running'}`.
- `tool_result` → find item with matching `id`; set `status: ok ? 'ok' : 'err'`, attach `summary`/`detail`. No match → push orphan result item.
- `permission_request` → close any open text/thinking item; push `{type:'permission', id, tool, kind, label, detail?, status:'pending'}`.
- `permission_resolved` → find pending item with matching `id`; set `status` to `allowed` (decision `allow`/`allow_session`; record `scope:'session'` for the latter) or `denied`. No match → push orphan item.
- `done`/`error`/`cancelled` → close all open items; mark any still-`running` tool items and still-`pending` permission items `interrupted`; `error` additionally pushes an error item with `message`.
- unknown / `x_*` → push `{type:'opaque', event}` (apps may override rendering per type).

**Idempotence requirement:** folding a full replay (deltas + `text_block`s) MUST yield the same items as having folded the live stream. This is what makes reconnect-from-zero safe and compaction (§6) invisible.

## 6. Replay, cursors, compaction

- The stream endpoint accepts `?since=<seq>`; the server sends all persisted events with `seq > since` (in order), then tails live. `since=0` (default) is full replay.
- Clients SHOULD track the highest `seq` seen and reconnect with it. Reconnecting without a cursor is always correct (fold from empty).
- **Compaction (optional):** after a job is terminal, the server MAY delete `text`/`thinking` deltas that are covered by a `text_block`. Compaction MUST NOT change fold output. This is why replays may have seq gaps.
- Servers MAY cap replay length only for non-chat event classes; chat jobs MUST replay in full.

## 7. Message lifecycle & ordering (fixes "refresh clears chat")

On `send`, in order, all before the HTTP response:

1. Persist the **user** message row.
2. Create the **assistant** row: empty `content`, `streaming = true`.
3. Create the job row (`running`), start the runner task.
4. Respond `202 {job_id, user_message_id, assistant_message_id}`.

During the run: the server SHOULD flush partial `content` + `events` into the assistant row periodically (per event or per interval) so a crash mid-turn loses nothing.

On completion, in order:

5. Finalize the assistant row: full `content`, full `events`, `streaming = false`. **Committed.**
6. Mark the job terminal.
7. Append + broadcast the terminal event carrying `message_id`.

**Client handoff rule:** on `done`, the client fetches (or already has) the message by `message_id` and atomically swaps the live overlay for the persisted row. Because of ordering 5→7, this read MUST succeed — retry-until-visible loops are a spec violation on the server, not something clients compensate for.

**History rule:** `GET .../messages` excludes rows with `streaming = true` (the live overlay is the only representation of an in-flight turn), UNLESS the owning job is terminal (orphan sweep will have cleared the flag; see §10).

## 8. Extension events

- Types prefixed `x_` (e.g. `x_sync_hint`, `x_viewer_command`, `x_delegate_event`) flow through transport, log, and replay identically to core events.
- Fold treats them as opaque items; client apps register renderers/handlers per type.
- Extensions MUST NOT redefine core semantics (e.g. no alternate terminal events). Cross-cutting features that need protocol support (HITL permission gates, sub-agent delegation) get promoted into core in a future version rather than living as `x_*` forever.

## 9. Stop

`POST /jobs/{id}/stop` → `202 {status}`. Server-owned escalation, one timer:

1. Graceful interrupt to the runner (SDK `interrupt()`, cancellation token, …).
2. If no terminal event within `stop_grace` (default 5s), hard-cancel the task and append `cancelled`.

Clients MUST NOT run their own force-unlock timers; they wait for the terminal event (which §4.4 guarantees). Idempotent: stopping a terminal job is a no-op `200`.

## 10. Restart safety

On server startup: every job still marked `running` is swept — assistant row finalized from its last flush (`streaming = false`; row deleted if truly empty), job marked `error`, and `{type:"error", message:"server restarted", message_id?}` appended to its log. A client reconnecting with `?since=` therefore always receives a terminal event.

## 11. HTTP surface

All under a mount prefix (default `/api/chat`). JSON bodies; errors are `{error: {code, message, ...}}`.

| method & path | req | resp | notes |
|---|---|---|---|
| `POST /sessions` | `{name?}` | `201 {session}` | |
| `GET /sessions` | | `{sessions: [...]}` | |
| `DELETE /sessions/{id}` | | `204` | cascades messages/jobs/events |
| `GET /sessions/{id}/messages` | `?before=&limit=` | `{messages: [...]}` | newest-last; each assistant message includes `events` |
| `POST /sessions/{id}/send` | `{content, attachments?, x_context?}` | `202 {job_id, user_message_id, assistant_message_id}` | `409 {active_job_id}` if a job is running |
| `GET /sessions/{id}/active-job` | | `{job_id, status} \| {job_id: null}` | reattach-on-mount |
| `GET /jobs/{id}/stream` | `?since=` | SSE | replay-then-tail; `data: <json>\n\n`; heartbeat comments |
| `GET /jobs/{id}/events` | `?since=` | `{events: [...], terminal: bool}` | non-streaming fetch of the same log (debugging, polling fallback) |
| `POST /jobs/{id}/stop` | | `202 {status}` | §9 |
| `POST /jobs/{id}/permission` | `{request_id, decision}` | `200 {status}` | resolve a pending `permission_request`; `409` if unknown/already resolved |
| `GET /meta` | | `{protocol_version: "0.2", extensions: [...]}` | capability discovery |

Transport notes: SSE responses set `Cache-Control: no-cache`, `X-Accel-Buffering: no`. Clients use `fetch()` + stream reader (AbortController support); frames split on `\n\n`, `data:` lines JSON-parsed, comment lines skipped. A parse failure on one frame skips the frame, never kills the connection.

## 12. Storage schema (reference)

Names are conventional, not normative; semantics are.

```sql
sessions      (id PK, name, provider_session_id, created_at)
messages      (id PK, session_id FK, role, content, events_json, streaming INT DEFAULT 0,
               attachments_json, created_at)
jobs          (id PK, session_id FK, status, created_at, updated_at)
job_events    (id PK, job_id FK, seq INT, event_json, created_at,
               UNIQUE(job_id, seq))
```

- `messages.events_json` — the job's event list minus `message_start` (and minus compacted deltas); folding it MUST reproduce the rendered turn.
- Retention: `job_events` for terminal jobs MAY be pruned after `events_json` is finalized (the message row is then the durable replay source; the log is only needed while `running` + a grace window for late reconnects).

## 13. Server runner interface (informative)

The only app-supplied backend code:

```python
async def run(ctx: TurnContext, emit: Emit) -> TurnResult:
    ...
```

- `ctx`: session, message history, attachments, app-provided system-prompt/context hooks, cancellation token.
- `emit(type, **fields)`: seq/ts/persistence handled by the library; runner never touches the log or subscribers.
- The library ships adapters: Claude Agent SDK (`ClaudeSDKClient` with interrupt support; SDK message → event mapping; resume token round-trip via `sessions.provider_session_id`), and a raw-provider harness shape later.
- Tool metadata (`kind`, `label`, `detail` templates) is declared in the tool registry alongside the tool definitions and injected into `tool_call` events by the adapter.

## 14. Versioning

- `protocol_version` is semver-ish `MAJOR.MINOR`; additive changes (new event types, new optional fields) bump MINOR and require nothing of clients (unknown types are opaque by rule). Breaking changes bump MAJOR and are surfaced via `GET /meta`.
- Events themselves carry no version field.

---

## Open questions for v0.2
1. **Attachments/images** — upload endpoint + reference format in `send`.
2. **Sub-agent delegation** — `delegate_event`/`task_status` as a core module (task table + transcript endpoint) vs staying `x_*`.
4. **Multi-client concurrency** — multiple tabs on one session: last-writer `send` wins via the 409 rule; do we need presence/typing?
5. **Auth** — out of scope for v0.1 (all five source apps are single-user); define a pluggable principal on `ctx` before any multi-user use.
