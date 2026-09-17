//! HTTP surface (PROTOCOL.md §11) as an axum Router. Mount it into a host app
//! (`Router::nest`) or serve it standalone via `AgentChat::listen`.
//!
//! v0.1 scope: everything except attachments — uploads answer 400 ("not
//! enabled"), matching the reference server's disabled-attachments mode.

use std::convert::Infallible;
use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use futures::stream::Stream;
use serde_json::{json, Value};

use crate::events::{is_terminal, seq_of, PROTOCOL_VERSION};
use crate::jobs::{JobRegistry, Runner, TurnContext, HEARTBEAT};
use crate::store::Store;

#[derive(Clone)]
pub struct AppState {
    pub store: Arc<Store>,
    pub registry: Arc<JobRegistry>,
    pub runner: Arc<dyn Runner>,
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/meta", get(meta))
        .route("/sessions", post(create_session).get(list_sessions))
        .route("/sessions/{id}", delete(delete_session))
        .route("/sessions/{id}/messages", get(list_messages))
        .route("/sessions/{id}/active-job", get(active_job))
        .route("/sessions/{id}/send", post(send))
        .route("/sessions/{id}/attachments", post(upload_disabled))
        .route("/attachments/{id}", get(attachment_disabled))
        .route("/jobs/{id}/stream", get(stream))
        .route("/jobs/{id}/events", get(job_events))
        .route("/jobs/{id}/stop", post(stop))
        .route("/jobs/{id}/permission", post(permission))
        .with_state(state)
}

type Reply = (StatusCode, Json<Value>);

fn err(status: StatusCode, message: &str) -> Reply {
    (status, Json(json!({ "error": { "message": message } })))
}

fn internal<E: std::fmt::Display>(e: E) -> Reply {
    err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string())
}

async fn meta() -> Json<Value> {
    Json(json!({ "protocol_version": PROTOCOL_VERSION, "extensions": [] }))
}

async fn create_session(
    State(st): State<AppState>,
    body: Option<Json<Value>>,
) -> Result<Reply, Reply> {
    let name = body
        .as_ref()
        .and_then(|b| b.get("name"))
        .and_then(Value::as_str)
        .map(String::from);
    let session = st.store.create_session(name.as_deref()).map_err(internal)?;
    Ok((StatusCode::CREATED, Json(json!({ "session": session }))))
}

async fn list_sessions(State(st): State<AppState>) -> Result<Json<Value>, Reply> {
    Ok(Json(json!({ "sessions": st.store.list_sessions().map_err(internal)? })))
}

async fn delete_session(
    State(st): State<AppState>,
    Path(id): Path<String>,
) -> Result<StatusCode, Reply> {
    st.store.delete_session(&id).map_err(internal)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn list_messages(
    State(st): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, Reply> {
    if st.store.get_session(&id).map_err(internal)?.is_none() {
        return Err(err(StatusCode::NOT_FOUND, "session not found"));
    }
    let messages = st.store.list_messages(&id, false, 200).map_err(internal)?;
    Ok(Json(json!({ "messages": messages })))
}

async fn active_job(
    State(st): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, Reply> {
    let job = st.store.active_job_for_session(&id).map_err(internal)?;
    Ok(Json(match job {
        Some(j) => json!({ "job_id": j["id"], "status": j["status"] }),
        None => json!({ "job_id": null }),
    }))
}

/// §7 send ordering: history snapshot, user row, streaming assistant row, job
/// row — all durable before we respond or start the runner.
async fn send(
    State(st): State<AppState>,
    Path(session_id): Path<String>,
    body: Option<Json<Value>>,
) -> Result<Reply, Reply> {
    let Some(session) = st.store.get_session(&session_id).map_err(internal)? else {
        return Err(err(StatusCode::NOT_FOUND, "session not found"));
    };
    if let Some(active) = st.store.active_job_for_session(&session_id).map_err(internal)? {
        return Err((
            StatusCode::CONFLICT,
            Json(json!({ "error": { "code": 409, "active_job_id": active["id"] } })),
        ));
    }
    let content = body
        .as_ref()
        .and_then(|b| b.get("content"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();

    let history = st.store.list_messages(&session_id, false, 200).map_err(internal)?;
    let user_message_id = st
        .store
        .add_message(&session_id, "user", &content, false, None)
        .map_err(internal)?;
    let assistant_message_id = st
        .store
        .add_message(&session_id, "assistant", "", true, None)
        .map_err(internal)?;
    let job_id = st.store.create_job(&session_id).map_err(internal)?;

    let provider_session_id = session
        .get("provider_session_id")
        .and_then(Value::as_str)
        .map(String::from);
    let ctx = TurnContext {
        session,
        messages: history,
        user_content: content,
        user_message_id: user_message_id.clone(),
        assistant_message_id: assistant_message_id.clone(),
        job_id: job_id.clone(),
        provider_session_id,
    };
    st.registry.start(ctx, st.runner.clone());
    Ok((
        StatusCode::ACCEPTED,
        Json(json!({
            "job_id": job_id,
            "user_message_id": user_message_id,
            "assistant_message_id": assistant_message_id,
        })),
    ))
}

#[derive(serde::Deserialize)]
struct SinceQuery {
    #[serde(default)]
    since: i64,
}

async fn stream(
    State(st): State<AppState>,
    Path(job_id): Path<String>,
    Query(q): Query<SinceQuery>,
) -> Result<Sse<impl Stream<Item = Result<Event, Infallible>>>, Reply> {
    if st.store.get_job(&job_id).map_err(internal)?.is_none() {
        return Err(err(StatusCode::NOT_FOUND, "job not found"));
    }
    let (replay, tail, last_seq) = st.registry.stream(&job_id, q.since).map_err(internal)?;
    Ok(Sse::new(async_stream(replay, tail, last_seq))
        .keep_alive(KeepAlive::new().interval(HEARTBEAT).text("hb")))
}

/// Replay events first, then drain the tail channel (deduping the overlap by
/// seq) until a terminal event ends the stream.
fn async_stream(
    replay: Vec<Value>,
    tail: Option<tokio::sync::mpsc::UnboundedReceiver<Value>>,
    last_seq: i64,
) -> impl Stream<Item = Result<Event, Infallible>> {
    futures::stream::unfold(
        (replay.into_iter(), tail, last_seq, false),
        |(mut replay, mut tail, mut last_seq, ended)| async move {
            if ended {
                return None;
            }
            if let Some(ev) = replay.next() {
                let terminal = is_terminal(&ev);
                return Some((event_frame(&ev), (replay, tail, last_seq, terminal)));
            }
            let rx = tail.as_mut()?;
            loop {
                match rx.recv().await {
                    Some(ev) => {
                        let seq = seq_of(&ev);
                        if seq <= last_seq {
                            continue; // already replayed
                        }
                        last_seq = seq;
                        let terminal = is_terminal(&ev);
                        return Some((event_frame(&ev), (replay, tail, last_seq, terminal)));
                    }
                    None => return None,
                }
            }
        },
    )
}

fn event_frame(ev: &Value) -> Result<Event, Infallible> {
    Ok(Event::default().data(ev.to_string()))
}

async fn job_events(
    State(st): State<AppState>,
    Path(job_id): Path<String>,
    Query(q): Query<SinceQuery>,
) -> Result<Json<Value>, Reply> {
    let Some(job) = st.store.get_job(&job_id).map_err(internal)? else {
        return Err(err(StatusCode::NOT_FOUND, "job not found"));
    };
    let events = st.store.get_events(&job_id, q.since).map_err(internal)?;
    Ok(Json(json!({ "events": events, "terminal": job["status"] != "running" })))
}

async fn stop(State(st): State<AppState>, Path(job_id): Path<String>) -> Result<Reply, Reply> {
    if st.store.get_job(&job_id).map_err(internal)?.is_none() {
        return Err(err(StatusCode::NOT_FOUND, "job not found"));
    }
    let status = st.registry.stop(&job_id);
    Ok((StatusCode::ACCEPTED, Json(json!({ "status": status }))))
}

async fn permission(
    State(st): State<AppState>,
    Path(job_id): Path<String>,
    body: Option<Json<Value>>,
) -> Result<Json<Value>, Reply> {
    if st.store.get_job(&job_id).map_err(internal)?.is_none() {
        return Err(err(StatusCode::NOT_FOUND, "job not found"));
    }
    let get = |k: &str| {
        body.as_ref()
            .and_then(|b| b.get(k))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    };
    let (request_id, decision) = (get("request_id"), get("decision"));
    if !st.registry.resolve_permission(&job_id, &request_id, &decision) {
        return Err(err(StatusCode::CONFLICT, "no such pending permission request"));
    }
    Ok(Json(json!({ "status": "resolved" })))
}

async fn upload_disabled() -> Reply {
    err(StatusCode::BAD_REQUEST, "attachments are not enabled on this server")
}

async fn attachment_disabled() -> Reply {
    err(StatusCode::NOT_FOUND, "attachment not found")
}
