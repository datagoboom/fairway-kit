//! Job registry: pub/sub fan-out over the write-ahead event log, replay-then-
//! tail streaming, terminal ordering, stop escalation, permission broker,
//! startup orphan sweep, and post-terminal compaction (PROTOCOL.md §4, §7,
//! §9, §10). Third port of this kernel, after python jobs.py and js jobs.ts.
//!
//! Rust cannot cancel an arbitrary future from outside, so "hard cancel" is
//! cooperative-plus-forced, same as JS: cancel the token (a well-behaved
//! runner stops), and after a grace window force the terminal event and mark
//! the job finished so a still-running runner's later emits become no-ops.
//! Either way the job always reaches a terminal event (§4.4).

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use serde_json::Value;
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;

use crate::events::{self as ev, EmitEvent, StampedEvent};
use crate::fold::{compactable_delta_seqs, final_text, fold_all};
use crate::store::{new_id, Message, Store};

pub const HEARTBEAT: Duration = Duration::from_secs(20);

/// The start of a replay-then-tail stream: persisted replay, the live tail
/// receiver (None when the log already ends in a terminal), and the highest
/// seq in the replay for tail dedupe.
pub type StreamStart = (Vec<StampedEvent>, Option<mpsc::UnboundedReceiver<StampedEvent>>, i64);
const STOP_GRACE_DEFAULT: Duration = Duration::from_secs(5);

// -- the runner contract -----------------------------------------------------

#[derive(Debug, Clone)]
pub struct TurnContext {
    pub session: Value,
    /// Persisted history (oldest first), excluding the new user/assistant pair.
    pub messages: Vec<Message>,
    pub user_content: String,
    pub user_message_id: String,
    pub assistant_message_id: String,
    pub job_id: String,
    pub provider_session_id: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct TurnResult {
    /// May be empty — the host then derives content from the folded event log.
    pub content: String,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermissionOutcome {
    Allow,
    AllowSession,
    Deny,
}

pub struct PermissionRequest {
    pub tool: String,
    pub kind: Option<String>,
    pub label: Option<String>,
    pub detail: Option<String>,
    pub input: Option<Value>,
}

/// The only app-supplied backend code (PROTOCOL.md §13). A runner drives one
/// turn: emit events through the handle, return the final content (or Err —
/// the host maps it to an `error`/`cancelled` terminal).
#[async_trait]
pub trait Runner: Send + Sync + 'static {
    async fn run(&self, turn: &TurnHandle) -> Result<TurnResult, String>;
}

// -- live-job state ----------------------------------------------------------

struct LiveJob {
    subscribers: Mutex<Vec<mpsc::UnboundedSender<StampedEvent>>>,
    emitted: Mutex<Vec<StampedEvent>>,
    pending_permissions: Mutex<HashMap<String, oneshot::Sender<String>>>,
    cancel: CancellationToken,
    finished: AtomicBool,
    assistant_message_id: String,
    job_id: String,
    session_id: String,
    new_provider_session_id: Mutex<Option<String>>,
}

impl LiveJob {
    fn fan_out(&self, stamped: &StampedEvent) {
        let mut subs = self.subscribers.lock().unwrap();
        subs.retain(|s| s.send(stamped.clone()).is_ok());
    }
}

/// Handed to the runner for the duration of the turn: the emit surface, the
/// permission gate, cancellation, and the turn's context.
pub struct TurnHandle {
    ctx: TurnContext,
    store: Arc<Store>,
    live: Arc<LiveJob>,
}

impl TurnHandle {
    pub fn ctx(&self) -> &TurnContext {
        &self.ctx
    }

    /// Cancelled when the turn is stopped; a cooperative runner should watch it.
    pub fn cancel_token(&self) -> CancellationToken {
        self.live.cancel.clone()
    }

    /// Set when the provider hands back a resume token; persisted at turn end.
    pub fn set_provider_session_id(&self, id: String) {
        *self.live.new_provider_session_id.lock().unwrap() = Some(id);
    }

    /// emit(event) → stamped event. Durable when it returns (§4.2: persist
    /// before fan-out). Runners must not emit terminal events.
    pub async fn emit(&self, event: EmitEvent) -> Result<StampedEvent, String> {
        ev::validate(&event)?;
        if ev::is_terminal(&event) {
            return Err("runners must not emit terminal events; return TurnResult".into());
        }
        let stamped = self.store.append_event(&self.live.job_id, &event)?;
        if self.live.finished.load(Ordering::SeqCst) {
            return Ok(stamped); // forced-cancel already terminated the job
        }
        let snapshot = {
            let mut emitted = self.live.emitted.lock().unwrap();
            emitted.push(stamped.clone());
            emitted.clone()
        };
        // Flush partial content per event so a crash mid-turn loses nothing (§7).
        self.store.flush_assistant(
            &self.live.assistant_message_id,
            &final_text(&snapshot),
            &snapshot,
        )?;
        self.live.fan_out(&stamped);
        Ok(stamped)
    }

    /// The HITL gate: emits `permission_request`, holds until the user answers
    /// (indefinitely — §3), emits `permission_resolved`, remembers
    /// `allow_session` against the session.
    pub async fn request_permission(&self, req: PermissionRequest) -> Result<PermissionOutcome, String> {
        let session_id = &self.live.session_id;
        if self.store.get_allowed_tools(session_id)?.contains(&req.tool) {
            return Ok(PermissionOutcome::Allow);
        }
        let request_id = new_id();
        let (tx, rx) = oneshot::channel::<String>();
        self.live.pending_permissions.lock().unwrap().insert(request_id.clone(), tx);
        self.emit(ev::permission_request(
            &request_id,
            &req.tool,
            req.kind.as_deref().unwrap_or("unknown"),
            req.label.as_deref().unwrap_or(&req.tool),
            req.detail.as_deref(),
            req.input.clone(),
        ))
        .await?;
        let decision = rx.await.unwrap_or_else(|_| "deny".into());
        self.live.pending_permissions.lock().unwrap().remove(&request_id);
        self.emit(ev::permission_resolved(&request_id, &decision)).await?;
        if decision == "allow_session" {
            self.store.add_allowed_tool(session_id, &req.tool)?;
        }
        Ok(match decision.as_str() {
            "allow" => PermissionOutcome::Allow,
            "allow_session" => PermissionOutcome::AllowSession,
            _ => PermissionOutcome::Deny,
        })
    }
}

// -- registry ----------------------------------------------------------------

pub struct JobRegistry {
    store: Arc<Store>,
    live: Mutex<HashMap<String, Arc<LiveJob>>>,
    stop_grace: Duration,
}

impl JobRegistry {
    pub fn new(store: Arc<Store>, stop_grace: Option<Duration>) -> Self {
        JobRegistry {
            store,
            live: Mutex::new(HashMap::new()),
            stop_grace: stop_grace.unwrap_or(STOP_GRACE_DEFAULT),
        }
    }

    /// §10: every job still `running` at startup gets its assistant row
    /// finalized from the log (or deleted if truly empty), the job marked
    /// `error`, and a terminal appended — so reconnecting clients always unlock.
    pub fn startup_sweep(&self) -> Result<(), String> {
        for job in self.store.orphaned_running_jobs()? {
            let job_id = job["id"].as_str().unwrap_or_default().to_string();
            let evs = self.store.get_events(&job_id, 0)?;
            let mut message_id: Option<String> = evs
                .iter()
                .find(|e| e.get("type").and_then(Value::as_str) == Some("message_start"))
                .and_then(|e| e.get("message_id").and_then(Value::as_str))
                .map(String::from);
            if let Some(mid) = &message_id {
                let content = final_text(&evs);
                let has_tools = fold_all(&evs)
                    .iter()
                    .any(|i| i.get("type").and_then(Value::as_str) == Some("tool"));
                if !content.is_empty() || has_tools {
                    self.store.finalize_assistant(mid, &content, &evs)?;
                } else {
                    self.store.delete_message(mid)?;
                    message_id = None;
                }
            }
            self.store.set_job_status(&job_id, "error")?;
            self.store
                .append_event(&job_id, &ev::error_event("server restarted", message_id.as_deref()))?;
        }
        Ok(())
    }

    /// Start the runner task for a prepared turn (rows already persisted, §7).
    pub fn start(self: &Arc<Self>, ctx: TurnContext, runner: Arc<dyn Runner>) {
        let live = Arc::new(LiveJob {
            subscribers: Mutex::new(Vec::new()),
            emitted: Mutex::new(Vec::new()),
            pending_permissions: Mutex::new(HashMap::new()),
            cancel: CancellationToken::new(),
            finished: AtomicBool::new(false),
            assistant_message_id: ctx.assistant_message_id.clone(),
            job_id: ctx.job_id.clone(),
            session_id: ctx.session["id"].as_str().unwrap_or_default().to_string(),
            new_provider_session_id: Mutex::new(None),
        });
        self.live.lock().unwrap().insert(ctx.job_id.clone(), live.clone());
        let registry = self.clone();
        tokio::spawn(async move { registry.run(live, ctx, runner).await });
    }

    async fn run(self: Arc<Self>, live: Arc<LiveJob>, ctx: TurnContext, runner: Arc<dyn Runner>) {
        let job_id = ctx.job_id.clone();
        let assistant_id = ctx.assistant_message_id.clone();
        let handle = TurnHandle { ctx, store: self.store.clone(), live: live.clone() };

        let outcome = async {
            handle.emit(ev::message_start(&assistant_id)).await?;
            runner.run(&handle).await
        }
        .await;

        match outcome {
            Ok(result) => {
                let content = if result.content.is_empty() {
                    final_text(&live.emitted.lock().unwrap().clone())
                } else {
                    result.content
                };
                self.finish(&live, ev::done(&assistant_id, result.reason.as_deref()), &content, "done");
            }
            Err(msg) => {
                let content = final_text(&live.emitted.lock().unwrap().clone());
                if live.cancel.is_cancelled() {
                    self.finish(&live, ev::cancelled(Some(&assistant_id)), &content, "cancelled");
                } else {
                    self.finish(&live, ev::error_event(&msg, Some(&assistant_id)), &content, "error");
                }
            }
        }

        // Deny anything still pending, persist a new resume token, drop from live.
        for (_, tx) in live.pending_permissions.lock().unwrap().drain() {
            let _ = tx.send("deny".into());
        }
        if let Some(provider) = live.new_provider_session_id.lock().unwrap().take() {
            let _ = self.store.set_provider_session_id(&live.session_id, &provider);
        }
        self.live.lock().unwrap().remove(&job_id);
    }

    /// §7 completion ordering: finalize row → job status → (compaction) →
    /// terminal event → fan-out. Idempotent via the `finished` flag.
    fn finish(&self, live: &LiveJob, terminal: EmitEvent, content: &str, status: &str) {
        if live.finished.swap(true, Ordering::SeqCst) {
            return;
        }
        let emitted = live.emitted.lock().unwrap().clone();
        let _ = self.store.finalize_assistant(&live.assistant_message_id, content, &emitted);
        let _ = self.store.set_job_status(&live.job_id, status);
        // Compaction before the terminal so every replay sees the same log;
        // failure is safe to skip — events_json is the durable copy.
        let _ = self.store.delete_events_by_seq(&live.job_id, &compactable_delta_seqs(&emitted));
        if let Ok(stamped) = self.store.append_event(&live.job_id, &terminal) {
            live.fan_out(&stamped);
        }
    }

    // -- streaming -----------------------------------------------------------

    /// Replay-then-tail (§6). Subscribes BEFORE reading the replay so no event
    /// can fall between replay and tail; the seq cursor dedupes the overlap.
    /// Returns `(replay, Option<tail receiver>, last_seq)`; a `None` receiver
    /// means the log is complete (terminal present or job not live).
    pub fn stream(&self, job_id: &str, since: i64) -> Result<StreamStart, String> {
        let live = self.live.lock().unwrap().get(job_id).cloned();
        let rx = live.as_ref().map(|l| {
            let (tx, rx) = mpsc::unbounded_channel();
            l.subscribers.lock().unwrap().push(tx);
            rx
        });
        let replay = self.store.get_events(job_id, since)?;
        let mut last_seq = since;
        let mut terminal_seen = false;
        for e in &replay {
            last_seq = last_seq.max(ev::seq_of(e));
            if ev::is_terminal(e) {
                terminal_seen = true;
            }
        }
        Ok((replay, if terminal_seen { None } else { rx }, last_seq))
    }

    // -- stop + permissions ----------------------------------------------------

    /// §9: deny pending permissions, cancel the token (graceful), and after
    /// the grace window force the `cancelled` terminal. Idempotent.
    pub fn stop(self: &Arc<Self>, job_id: &str) -> String {
        let live = match self.live.lock().unwrap().get(job_id).cloned() {
            Some(l) => l,
            None => {
                return self
                    .store
                    .get_job(job_id)
                    .ok()
                    .flatten()
                    .and_then(|j| j["status"].as_str().map(String::from))
                    .unwrap_or_else(|| "unknown".into());
            }
        };
        for (_, tx) in live.pending_permissions.lock().unwrap().drain() {
            let _ = tx.send("deny".into());
        }
        live.cancel.cancel();
        let registry = self.clone();
        let grace = self.stop_grace;
        let job_id = job_id.to_string();
        tokio::spawn(async move {
            tokio::time::sleep(grace).await;
            let still = registry.live.lock().unwrap().get(&job_id).cloned();
            if let Some(l) = still {
                if !l.finished.load(Ordering::SeqCst) {
                    let content = final_text(&l.emitted.lock().unwrap().clone());
                    registry.finish(
                        &l,
                        ev::cancelled(Some(&l.assistant_message_id)),
                        &content,
                        "cancelled",
                    );
                }
            }
        });
        "stopping".into()
    }

    pub fn resolve_permission(&self, job_id: &str, request_id: &str, decision: &str) -> bool {
        let live = match self.live.lock().unwrap().get(job_id).cloned() {
            Some(l) => l,
            None => return false,
        };
        let tx = live.pending_permissions.lock().unwrap().remove(request_id);
        match tx {
            Some(tx) => tx.send(decision.to_string()).is_ok(),
            None => false,
        }
    }
}
