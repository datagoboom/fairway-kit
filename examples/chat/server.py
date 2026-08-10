"""Fairway example chat server.

Runs the full protocol stack — write-ahead event log, SSE replay-then-tail,
active-job reattach, stop escalation — behind a real agent.

    FAIRWAY_RUNNER=echo          offline echo runner (no CLI, no credentials)
    FAIRWAY_RUNNER=claude        Claude Agent SDK (default)
    FAIRWAY_AUTH=inherit|api|subscription   (default inherit)
    FAIRWAY_MODEL=claude-opus-4-8
    FAIRWAY_DB=./fairway-example.db

    uv run uvicorn server:app --port 8500 --reload
"""

import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from fairway import mount_agent_chat
from fairway.adapters.claude_sdk import ClaudeSDKRunner, EchoRunner


def build_runner():
    if os.environ.get("FAIRWAY_RUNNER", "claude") == "echo":
        return EchoRunner()
    return ClaudeSDKRunner(
        model=os.environ.get("FAIRWAY_MODEL", "claude-opus-4-8"),
        auth=os.environ.get("FAIRWAY_AUTH", "inherit"),  # type: ignore[arg-type]
        # A deliberately small tool surface for the demo. Read-only tools are
        # pre-approved; WebSearch/WebFetch go through the permission gate
        # (inline approval in the chat, with per-session allow memory).
        tools=["Read", "Glob", "Grep", "WebSearch", "WebFetch"],
        allowed_tools=["Read", "Glob", "Grep"],
        permission_mode="default",
        cwd=os.path.dirname(os.path.abspath(__file__)),
        max_turns=30,
        system_prompt=lambda ctx: (
            "You are Fairway's demo assistant. Be concise. You may read files in "
            "your working directory and search the web when asked."
        ),
    )


app = FastAPI(title="fairway example chat")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],  # vite dev server
    allow_methods=["*"],
    allow_headers=["*"],
)

store, registry = mount_agent_chat(
    app,
    db_path=os.environ.get("FAIRWAY_DB", "./fairway-example.db"),
    runner=build_runner(),
)
