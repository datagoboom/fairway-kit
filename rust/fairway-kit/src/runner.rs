//! Trivial reference runner for demos and tests: echoes the user message with
//! one fake tool call. Exercises the whole protocol path with no credentials —
//! the smallest possible example of the Runner contract. Mirrors js echo.ts.

use async_trait::async_trait;

use crate::events as ev;
use crate::jobs::{Runner, TurnHandle, TurnResult};

pub struct EchoRunner;

#[async_trait]
impl Runner for EchoRunner {
    async fn run(&self, turn: &TurnHandle) -> Result<TurnResult, String> {
        let user = turn.ctx().user_content.clone();
        let detail: String = user.chars().take(60).collect();
        turn.emit(ev::tool_call("echo-1", "echo", "system", "Echo", Some(&detail), None))
            .await?;
        turn.emit(ev::tool_result("echo-1", true, Some("ok"), None)).await?;
        let reply = format!("You said: {user}");
        for word in reply.split(' ') {
            turn.emit(ev::text(&format!("{word} "))).await?;
        }
        turn.emit(ev::text_block(&reply)).await?;
        Ok(TurnResult { content: reply, reason: None })
    }
}
