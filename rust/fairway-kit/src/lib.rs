//! fairway-kit — Rust implementation of the fairway Agent Chat Protocol
//! (docs/PROTOCOL.md, draft v0.3). Third implementation after the Python and
//! Node servers, pinned by the same conformance vectors.
//!
//! Built to be *embedded*: a desktop app (e.g. a Tauri shell) mounts the
//! router in-process on a loopback port and keeps `@fairway-kit/client`
//! unchanged in its webview — no sidecar, no CORS, no Node runtime.
//!
//! ```no_run
//! use std::sync::Arc;
//! use fairway_kit::{create_agent_chat, AgentChatOptions, EchoRunner};
//!
//! #[tokio::main]
//! async fn main() {
//!     let chat = create_agent_chat(AgentChatOptions {
//!         db_path: Some("./chat.db".into()),
//!         runner: Arc::new(EchoRunner),
//!         ..Default::default()
//!     })
//!     .unwrap();
//!     // Mount into a host axum app under /api/chat, or serve standalone:
//!     let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
//!     println!("port: {}", listener.local_addr().unwrap().port());
//!     axum::serve(listener, chat.into_router("/api/chat")).await.unwrap();
//! }
//! ```

pub mod claude_code;
pub mod events;
pub mod fold;
pub mod jobs;
pub mod router;
pub mod runner;
pub mod store;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

pub use claude_code::{ClaudeCodeConfig, ClaudeCodeRunner};
pub use events::PROTOCOL_VERSION;
pub use jobs::{
    JobRegistry, PermissionOutcome, PermissionRequest, Runner, TurnContext, TurnHandle, TurnResult,
};
pub use runner::EchoRunner;
pub use store::{Message, Store};

pub struct AgentChatOptions {
    /// SQLite file path; None = in-memory (tests).
    pub db_path: Option<PathBuf>,
    pub runner: Arc<dyn Runner>,
    pub stop_grace: Option<Duration>,
}

impl Default for AgentChatOptions {
    fn default() -> Self {
        AgentChatOptions { db_path: None, runner: Arc::new(EchoRunner), stop_grace: None }
    }
}

pub struct AgentChat {
    pub store: Arc<Store>,
    pub registry: Arc<JobRegistry>,
    pub runner: Arc<dyn Runner>,
}

/// Open the store, run the startup orphan sweep (PROTOCOL.md §10), and return
/// the pieces. Call `into_router(prefix)` to get the HTTP surface.
pub fn create_agent_chat(opts: AgentChatOptions) -> Result<AgentChat, String> {
    let store = Arc::new(match &opts.db_path {
        Some(p) => Store::open(p)?,
        None => Store::open_in_memory()?,
    });
    let registry = Arc::new(JobRegistry::new(store.clone(), opts.stop_grace));
    registry.startup_sweep()?;
    Ok(AgentChat { store, registry, runner: opts.runner })
}

impl AgentChat {
    pub fn into_router(self, prefix: &str) -> axum::Router {
        let inner = router::router(router::AppState {
            store: self.store,
            registry: self.registry,
            runner: self.runner,
        });
        if prefix.is_empty() || prefix == "/" {
            inner
        } else {
            axum::Router::new().nest(prefix, inner)
        }
    }
}
