//! End-to-end protocol tests over real HTTP: send → SSE stream → replay,
//! the 409 cardinality rule, stop escalation, the permission gate, and the
//! startup orphan sweep. EchoRunner and purpose-built runners; no credentials.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use fairway_kit::{
    create_agent_chat, events as ev, AgentChat, AgentChatOptions, EchoRunner, Runner, TurnHandle,
    TurnResult,
};
use serde_json::{json, Value};

mod util {
    use super::*;

    pub async fn serve(chat: AgentChat) -> String {
        let router = chat.into_router("/api/chat");
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        format!("http://{addr}/api/chat")
    }

    pub async fn create_session(base: &str) -> String {
        let resp: Value = reqwest::Client::new()
            .post(format!("{base}/sessions"))
            .json(&json!({ "name": "t" }))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        resp["session"]["id"].as_str().unwrap().to_string()
    }

    pub async fn send(base: &str, session: &str, content: &str) -> Value {
        reqwest::Client::new()
            .post(format!("{base}/sessions/{session}/send"))
            .json(&json!({ "content": content }))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap()
    }

    /// Read SSE frames until a terminal event (or the stream ends).
    pub async fn read_stream(base: &str, job_id: &str, since: i64) -> Vec<Value> {
        let resp = reqwest::Client::new()
            .get(format!("{base}/jobs/{job_id}/stream?since={since}"))
            .send()
            .await
            .unwrap();
        let mut events = Vec::new();
        let mut buf = Vec::new();
        let mut body = resp.bytes_stream();
        use futures::StreamExt;
        while let Some(chunk) = body.next().await {
            buf.extend_from_slice(&chunk.unwrap());
            while let Some(pos) = find_frame_end(&buf) {
                let frame = String::from_utf8_lossy(&buf[..pos]).to_string();
                buf.drain(..pos + 2);
                for line in frame.lines() {
                    if let Some(data) = line.strip_prefix("data: ") {
                        let ev: Value = serde_json::from_str(data).unwrap();
                        let terminal = fairway_kit::events::is_terminal(&ev);
                        events.push(ev);
                        if terminal {
                            return events;
                        }
                    }
                }
            }
        }
        events
    }

    fn find_frame_end(buf: &[u8]) -> Option<usize> {
        buf.windows(2).position(|w| w == b"\n\n")
    }
}

fn echo_chat() -> AgentChat {
    create_agent_chat(AgentChatOptions { runner: Arc::new(EchoRunner), ..Default::default() })
        .unwrap()
}

#[tokio::test]
async fn send_stream_replay_roundtrip() {
    let base = util::serve(echo_chat()).await;
    let session = util::create_session(&base).await;
    let sent = util::send(&base, &session, "hello world").await;
    let job_id = sent["job_id"].as_str().unwrap();

    // Live stream: message_start first, strictly increasing seq, done last.
    let events = util::read_stream(&base, job_id, 0).await;
    assert_eq!(events[0]["type"], "message_start");
    let seqs: Vec<i64> = events.iter().map(|e| e["seq"].as_i64().unwrap()).collect();
    assert!(seqs.windows(2).all(|w| w[0] < w[1]), "seq not strictly increasing: {seqs:?}");
    let last = events.last().unwrap();
    assert_eq!(last["type"], "done");
    let message_id = last["message_id"].as_str().unwrap();

    // Client handoff rule (§7): the message must be immediately fetchable,
    // finalized, with events whose fold matches the live stream's fold.
    let msgs: Value = reqwest::get(format!("{base}/sessions/{session}/messages"))
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let assistant = msgs["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["id"] == message_id)
        .expect("assistant row visible");
    assert_eq!(assistant["content"], "You said: hello world");
    assert_eq!(assistant["streaming"], false);

    // Replay after compaction folds identically (§6).
    let replay = util::read_stream(&base, job_id, 0).await;
    assert_eq!(
        fairway_kit::fold::fold_all(&events),
        fairway_kit::fold::fold_all(&replay),
        "compacted replay must fold identically to the live stream"
    );

    // Cursor resume: ?since=N yields only seq > N and still ends terminal.
    let mid = seqs[seqs.len() / 2];
    let resumed = util::read_stream(&base, job_id, mid).await;
    assert!(resumed.iter().all(|e| e["seq"].as_i64().unwrap() > mid));
    assert_eq!(resumed.last().unwrap()["type"], "done");
}

struct HangRunner(tokio::sync::Mutex<Option<tokio::sync::oneshot::Receiver<()>>>);

#[async_trait]
impl Runner for HangRunner {
    async fn run(&self, turn: &TurnHandle) -> Result<TurnResult, String> {
        turn.emit(ev::text("working...")).await?;
        let rx = self.0.lock().await.take();
        if let Some(rx) = rx {
            let cancel = turn.cancel_token();
            tokio::select! {
                _ = rx => {}
                _ = cancel.cancelled() => return Err("cancelled".into()),
            }
        }
        Ok(TurnResult { content: "done".into(), reason: None })
    }
}

#[tokio::test]
async fn cardinality_409_and_stop_escalation() {
    let (_tx, rx) = tokio::sync::oneshot::channel::<()>();
    let chat = create_agent_chat(AgentChatOptions {
        runner: Arc::new(HangRunner(tokio::sync::Mutex::new(Some(rx)))),
        stop_grace: Some(Duration::from_millis(200)),
        ..Default::default()
    })
    .unwrap();
    let base = util::serve(chat).await;
    let session = util::create_session(&base).await;
    let sent = util::send(&base, &session, "go").await;
    let job_id = sent["job_id"].as_str().unwrap().to_string();

    // Second send while running → 409 with the active job id (§1).
    let resp = reqwest::Client::new()
        .post(format!("{base}/sessions/{session}/send"))
        .json(&json!({ "content": "again" }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 409);
    let body: Value = resp.json().await.unwrap();
    assert_eq!(body["error"]["active_job_id"].as_str().unwrap(), job_id);

    // active-job reattach surface.
    let active: Value = reqwest::get(format!("{base}/sessions/{session}/active-job"))
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(active["job_id"].as_str().unwrap(), job_id);

    // Stop: cooperative runner sees the token and the job terminates cancelled.
    let resp = reqwest::Client::new()
        .post(format!("{base}/jobs/{job_id}/stop"))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 202);
    let events = util::read_stream(&base, &job_id, 0).await;
    assert_eq!(events.last().unwrap()["type"], "cancelled");
}

struct GatedRunner;

#[async_trait]
impl Runner for GatedRunner {
    async fn run(&self, turn: &TurnHandle) -> Result<TurnResult, String> {
        use fairway_kit::{PermissionOutcome, PermissionRequest};
        let ask = || PermissionRequest {
            tool: "Bash".into(),
            kind: Some("shell".into()),
            label: Some("Run command".into()),
            detail: Some("rm -rf /tmp/x".into()),
            input: None,
        };
        let first = turn.request_permission(ask()).await?;
        // allow_session must be remembered: this second ask auto-allows with
        // NO new permission_request event.
        let second = turn.request_permission(ask()).await?;
        let ok = first == PermissionOutcome::AllowSession && second == PermissionOutcome::Allow;
        turn.emit(ev::text_block(if ok { "gated ok" } else { "gate broken" })).await?;
        Ok(TurnResult { content: String::new(), reason: None })
    }
}

#[tokio::test]
async fn permission_gate_holds_and_remembers_session_allows() {
    let chat = create_agent_chat(AgentChatOptions {
        runner: Arc::new(GatedRunner),
        ..Default::default()
    })
    .unwrap();
    let base = util::serve(chat).await;
    let session = util::create_session(&base).await;
    let sent = util::send(&base, &session, "do it").await;
    let job_id = sent["job_id"].as_str().unwrap().to_string();

    // Poll the log until the permission_request shows up (the turn is holding).
    let request_id = loop {
        let body: Value = reqwest::get(format!("{base}/jobs/{job_id}/events"))
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let found = body["events"].as_array().unwrap().iter().find_map(|e| {
            (e["type"] == "permission_request").then(|| e["id"].as_str().unwrap().to_string())
        });
        if let Some(id) = found {
            break id;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    };

    let resp: Value = reqwest::Client::new()
        .post(format!("{base}/jobs/{job_id}/permission"))
        .json(&json!({ "request_id": request_id, "decision": "allow_session" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(resp["status"], "resolved");

    let events = util::read_stream(&base, &job_id, 0).await;
    assert_eq!(events.last().unwrap()["type"], "done");
    let requests = events.iter().filter(|e| e["type"] == "permission_request").count();
    assert_eq!(requests, 1, "second ask must auto-allow silently");
    assert!(events
        .iter()
        .any(|e| e["type"] == "text_block" && e["content"] == "gated ok"));
}

#[tokio::test]
async fn startup_sweep_terminates_orphans() {
    let dir = std::env::temp_dir().join(format!("fairway-kit-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let db = dir.join("sweep.db");
    let _ = std::fs::remove_file(&db);

    // Manufacture a crashed-mid-turn state directly through the store.
    let (session_id, job_id, assistant_id);
    {
        let store = fairway_kit::Store::open(&db).unwrap();
        let session = store.create_session(Some("s")).unwrap();
        session_id = session["id"].as_str().unwrap().to_string();
        store.add_message(&session_id, "user", "hi", false, None).unwrap();
        assistant_id = store.add_message(&session_id, "assistant", "", true, None).unwrap();
        job_id = store.create_job(&session_id).unwrap();
        store.append_event(&job_id, &ev::message_start(&assistant_id)).unwrap();
        store.append_event(&job_id, &ev::text_block("partial answer")).unwrap();
    }

    // "Restart": create_agent_chat sweeps on open (§10).
    let chat = create_agent_chat(AgentChatOptions {
        db_path: Some(db.clone()),
        runner: Arc::new(EchoRunner),
        ..Default::default()
    })
    .unwrap();
    let job = chat.store.get_job(&job_id).unwrap().unwrap();
    assert_eq!(job["status"], "error");
    let events = chat.store.get_events(&job_id, 0).unwrap();
    let last = events.last().unwrap();
    assert_eq!(last["type"], "error");
    assert_eq!(last["message"], "server restarted");
    // Partial content was finalized, not lost; the row is out of streaming.
    let msg = chat.store.get_message(&assistant_id).unwrap().unwrap();
    assert!(!msg.streaming);
    assert_eq!(msg.content, "partial answer");

    let _ = std::fs::remove_file(&db);
}
