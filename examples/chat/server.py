"""Fairway example chat server.

Runs the full protocol stack behind a real agent, with a small settings API
(GET/PUT /api/settings) that rebuilds the runner live — a demonstration that a
fairway runner is just a swappable async callable.

    FAIRWAY_RUNNER=echo          start in offline echo mode (no credentials)
    FAIRWAY_AUTH=...             initial auth mode (inherit|subscription|api)
    FAIRWAY_MODEL=...            initial model
    FAIRWAY_DB=./fairway-example.db

    uv run uvicorn server:app --port 8500 --reload
"""

import json
import os
from pathlib import Path
from typing import Literal

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from fairway import mount_agent_chat
from fairway.adapters.claude_sdk import ClaudeSDKRunner, EchoRunner

HERE = Path(__file__).resolve().parent
SETTINGS_PATH = Path(os.environ.get("FAIRWAY_SETTINGS", HERE / "fairway-example-settings.json"))

KNOWN_TOOLS = ["Read", "Glob", "Grep", "Write", "Edit", "Bash", "WebSearch", "WebFetch"]

DEFAULT_SYSTEM_PROMPT = (
    "You are Fairway's demo assistant. Be concise. You may read files in "
    "your working directory and search the web when asked."
)


class Settings(BaseModel):
    runner: Literal["claude", "echo"] = "claude"
    model: str = "claude-opus-4-8"
    auth: Literal["inherit", "subscription", "api"] = "inherit"
    permission_mode: Literal["default", "acceptEdits", "bypassPermissions", "dontAsk"] = "default"
    tools: list[str] = Field(default_factory=lambda: ["Read", "Glob", "Grep", "WebSearch", "WebFetch"])
    allowed_tools: list[str] = Field(default_factory=lambda: ["Read", "Glob", "Grep"])
    system_prompt: str = DEFAULT_SYSTEM_PROMPT
    max_turns: int = Field(default=30, ge=1, le=300)


def load_settings() -> Settings:
    if SETTINGS_PATH.is_file():
        try:
            return Settings.model_validate_json(SETTINGS_PATH.read_text())
        except Exception:
            pass  # fall through to defaults on a corrupt file
    s = Settings()
    if os.environ.get("FAIRWAY_RUNNER") == "echo":
        s.runner = "echo"
    if os.environ.get("FAIRWAY_AUTH") in ("inherit", "subscription", "api"):
        s.auth = os.environ["FAIRWAY_AUTH"]  # type: ignore[assignment]
    if os.environ.get("FAIRWAY_MODEL"):
        s.model = os.environ["FAIRWAY_MODEL"]
    return s


def build_runner(s: Settings):
    if s.runner == "echo":
        return EchoRunner()
    return ClaudeSDKRunner(
        model=s.model,
        auth=s.auth,
        tools=[t for t in s.tools if t in KNOWN_TOOLS],
        allowed_tools=[t for t in s.allowed_tools if t in s.tools],
        permission_mode=s.permission_mode,
        cwd=str(HERE),
        max_turns=s.max_turns,
        system_prompt=lambda ctx: s.system_prompt,
    )


class SwappableRunner:
    """A fairway runner is just an async callable, so live reconfiguration is
    one attribute swap. In-flight turns keep the runner they started with."""

    def __init__(self, settings: Settings):
        self.settings = settings
        self.current = build_runner(settings)

    def apply(self, settings: Settings) -> None:
        self.settings = settings
        self.current = build_runner(settings)

    async def __call__(self, ctx, emit):
        return await self.current(ctx, emit)


settings = load_settings()
runner = SwappableRunner(settings)

app = FastAPI(title="fairway example chat")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],  # vite dev server
    allow_methods=["*"],
    allow_headers=["*"],
)

store, registry = mount_agent_chat(
    app,
    db_path=os.environ.get("FAIRWAY_DB", str(HERE / "fairway-example.db")),
    runner=runner,
)


@app.get("/api/settings")
async def get_settings() -> dict:
    return {"settings": runner.settings.model_dump(), "known_tools": KNOWN_TOOLS}


@app.put("/api/settings")
async def put_settings(body: Settings) -> dict:
    SETTINGS_PATH.write_text(json.dumps(body.model_dump(), indent=2))
    runner.apply(body)
    return {"settings": runner.settings.model_dump(), "known_tools": KNOWN_TOOLS}
