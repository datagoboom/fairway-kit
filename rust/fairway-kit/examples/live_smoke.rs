//! Live smoke test: one real turn through ClaudeCodeRunner and the full HTTP
//! path. Needs a `claude` CLI login; costs one small model call.
//!
//!   cargo run --example live_smoke -- [path-to-claude]

use std::sync::Arc;

use fairway_kit::{create_agent_chat, AgentChatOptions, ClaudeCodeConfig, ClaudeCodeRunner};
use futures::StreamExt;
use serde_json::{json, Value};

#[tokio::main]
async fn main() {
    let binary = std::env::args().nth(1).unwrap_or_else(|| "claude".into());
    let chat = create_agent_chat(AgentChatOptions {
        runner: Arc::new(ClaudeCodeRunner::new(ClaudeCodeConfig {
            binary,
            model: Some("claude-haiku-4-5-20251001".into()),
            ..Default::default()
        })),
        ..Default::default()
    })
    .unwrap();
    let router = chat.into_router("/api/chat");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/api/chat", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });

    let client = reqwest::Client::new();
    let session: Value = client
        .post(format!("{base}/sessions"))
        .json(&json!({"name": "smoke"}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let sid = session["session"]["id"].as_str().unwrap();
    let sent: Value = client
        .post(format!("{base}/sessions/{sid}/send"))
        .json(&json!({"content": "Reply with exactly the single word: pineapple"}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let job = sent["job_id"].as_str().unwrap();
    println!("job: {job}");

    let resp = client.get(format!("{base}/jobs/{job}/stream")).send().await.unwrap();
    let mut buf = Vec::new();
    let mut body = resp.bytes_stream();
    'outer: while let Some(chunk) = body.next().await {
        buf.extend_from_slice(&chunk.unwrap());
        while let Some(pos) = buf.windows(2).position(|w| w == b"\n\n") {
            let frame = String::from_utf8_lossy(&buf[..pos]).to_string();
            buf.drain(..pos + 2);
            for line in frame.lines() {
                if let Some(data) = line.strip_prefix("data: ") {
                    let ev: Value = serde_json::from_str(data).unwrap();
                    println!("event: {ev}");
                    if fairway_kit::events::is_terminal(&ev) {
                        break 'outer;
                    }
                }
            }
        }
    }

    let msgs: Value = client
        .get(format!("{base}/sessions/{sid}/messages"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let last = msgs["messages"].as_array().unwrap().last().unwrap();
    println!("final assistant content: {:?}", last["content"]);
    let session_after: Value = client
        .get(format!("{base}/sessions"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    println!(
        "provider_session_id: {:?}",
        session_after["sessions"][0]["provider_session_id"]
    );
}
