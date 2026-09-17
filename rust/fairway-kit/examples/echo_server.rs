//! Standalone echo server for client/UI development: no credentials, the
//! EchoRunner answers every turn. Prints the bound port on stdout.
//!
//!   cargo run --example echo_server [port]

use std::sync::Arc;

use fairway_kit::{create_agent_chat, AgentChatOptions, EchoRunner};
use tower_http::cors::CorsLayer;

#[tokio::main]
async fn main() {
    let port: u16 = std::env::args().nth(1).and_then(|p| p.parse().ok()).unwrap_or(0);
    let chat = create_agent_chat(AgentChatOptions {
        runner: Arc::new(EchoRunner),
        ..Default::default()
    })
    .unwrap();
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await.unwrap();
    println!("{}", listener.local_addr().unwrap().port());
    let router = chat.into_router("/api/chat").layer(CorsLayer::very_permissive());
    axum::serve(listener, router).await.unwrap();
}
