"""ClaudeSDKRunner adapter tests against a scripted fake of claude_agent_sdk.

The adapter imports the SDK lazily inside __call__, so installing fake
`claude_agent_sdk` / `claude_agent_sdk.types` modules in sys.modules is enough -
no real CLI, no network.
"""

import sys
import types
from dataclasses import dataclass, field
from typing import Any

import pytest

from fairway.adapters.claude_sdk import ClaudeSDKRunner, ToolMeta
from fairway.runner import TurnContext


# -- fake SDK ----------------------------------------------------------------


@dataclass
class TextBlock:
    text: str


@dataclass
class ThinkingBlock:
    thinking: str
    signature: str = ""


@dataclass
class ToolUseBlock:
    id: str
    name: str
    input: dict


@dataclass
class ToolResultBlock:
    tool_use_id: str
    content: Any = None
    is_error: bool = False


@dataclass
class AssistantMessage:
    content: list
    model: str = "fake"
    usage: dict | None = None


@dataclass
class UserMessage:
    content: Any


@dataclass
class StreamEvent:
    uuid: str
    session_id: str
    event: dict
    parent_tool_use_id: str | None = None


@dataclass
class ResultMessage:
    subtype: str = "success"
    duration_ms: int = 1
    duration_api_ms: int = 1
    is_error: bool = False
    num_turns: int = 1
    session_id: str = "sess-123"
    result: str | None = None
    usage: dict | None = None


class FakeOptions:
    def __init__(self, **kwargs):
        self.__dict__.update(kwargs)


class ScriptedClient:
    """Async-context-manager client that replays a fixed message script."""

    def __init__(self, script):
        self.script = script
        self.queried_with = None
        self.interrupted = False
        self.graceful_stop_seen_during_run = False

    def __call__(self, options):  # used as client_factory(options)
        self.options = options
        return self

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def query(self, prompt):
        self.queried_with = prompt

    async def interrupt(self):
        self.interrupted = True

    async def receive_response(self):
        for msg in self.script:
            yield msg


@pytest.fixture
def fake_sdk(monkeypatch):
    sdk = types.ModuleType("claude_agent_sdk")
    sdk_types = types.ModuleType("claude_agent_sdk.types")
    for cls in (
        TextBlock,
        ThinkingBlock,
        ToolUseBlock,
        ToolResultBlock,
        AssistantMessage,
        UserMessage,
        StreamEvent,
        ResultMessage,
    ):
        setattr(sdk_types, cls.__name__, cls)
    sdk.ClaudeAgentOptions = FakeOptions
    sdk.ClaudeSDKClient = ScriptedClient([])  # replaced per-test via client_factory
    sdk.types = sdk_types
    monkeypatch.setitem(sys.modules, "claude_agent_sdk", sdk)
    monkeypatch.setitem(sys.modules, "claude_agent_sdk.types", sdk_types)
    return sdk


def make_ctx(**overrides):
    defaults = dict(
        session={"id": "s1"},
        messages=[],
        user_content="hello",
        user_message_id="um1",
        assistant_message_id="am1",
        job_id="j1",
    )
    defaults.update(overrides)
    return TurnContext(**defaults)


def delta(text=None, thinking=None):
    d = (
        {"type": "text_delta", "text": text}
        if text is not None
        else {"type": "thinking_delta", "thinking": thinking}
    )
    return StreamEvent(uuid="u", session_id="s", event={"type": "content_block_delta", "delta": d})


async def run(runner, ctx, script):
    client = ScriptedClient(script)
    runner.client_factory = client
    emitted = []

    async def emit(ev):
        emitted.append(ev)
        return ev

    result = await runner(ctx, emit)
    return client, emitted, result


# -- auth modes ---------------------------------------------------------------


def test_api_mode_requires_key(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    with pytest.raises(RuntimeError, match="ANTHROPIC_API_KEY"):
        ClaudeSDKRunner(auth="api").build_env()


def test_api_mode_explicit_key(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    env = ClaudeSDKRunner(auth="api", api_key="sk-test").build_env()
    assert env["ANTHROPIC_API_KEY"] == "sk-test"


def test_api_mode_inherited_key(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-env")
    assert ClaudeSDKRunner(auth="api").build_env()["ANTHROPIC_API_KEY"] == "sk-env"


def test_subscription_mode_blanks_api_key_and_sets_oauth(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-should-not-be-used")
    env = ClaudeSDKRunner(auth="subscription", oauth_token="oat-1").build_env()
    assert env["ANTHROPIC_API_KEY"] == ""  # shadows the exported key in the subprocess
    assert env["CLAUDE_CODE_OAUTH_TOKEN"] == "oat-1"


def test_subscription_mode_without_token(monkeypatch):
    env = ClaudeSDKRunner(auth="subscription").build_env()
    assert env["ANTHROPIC_API_KEY"] == ""
    assert "CLAUDE_CODE_OAUTH_TOKEN" not in env


def test_inherit_mode_touches_nothing(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-env")
    assert ClaudeSDKRunner(auth="inherit").build_env() == {}


# -- event mapping ------------------------------------------------------------


async def test_full_turn_event_mapping(fake_sdk):
    script = [
        delta(text="Let me "),
        delta(text="check."),
        AssistantMessage(
            content=[
                TextBlock("Let me check."),
                ToolUseBlock(id="t1", name="Read", input={"file_path": "a.py"}),
            ]
        ),
        UserMessage(content=[ToolResultBlock(tool_use_id="t1", content="print('hi')")]),
        delta(text="Done: "),
        delta(text="it prints hi."),
        AssistantMessage(content=[TextBlock("Done: it prints hi.")]),
        ResultMessage(session_id="sess-xyz"),
    ]
    runner = ClaudeSDKRunner(auth="inherit", flush_min_chars=1)  # flush every delta
    ctx = make_ctx()
    client, emitted, result = await run(runner, ctx, script)

    types_seq = [e["type"] for e in emitted]
    assert types_seq == [
        "text", "text",  # per-delta flush (flush_min_chars=1)
        "text_block",    # authoritative block 1
        "tool_call",
        "tool_result",
        "text", "text",  # second run
        "text_block",
    ]
    tool_call = emitted[3]
    assert tool_call["id"] == "t1"
    assert tool_call["tool"] == "Read"
    assert tool_call["kind"] == "file"
    assert tool_call["label"] == "Read file"
    assert tool_call["detail"] == "a.py"
    tool_result = emitted[4]
    assert tool_result["id"] == "t1" and tool_result["ok"] is True
    assert tool_result["summary"] == "print('hi')"

    assert result.content == "Let me check.\n\nDone: it prints hi."
    assert ctx.new_provider_session_id == "sess-xyz"
    assert ctx.graceful_stop is None  # cleared after the turn


async def test_thinking_deltas_and_error_result(fake_sdk):
    script = [
        delta(thinking="hmm "),
        delta(thinking="tricky"),
        AssistantMessage(content=[ThinkingBlock("hmm tricky"), TextBlock("answer")]),
        ResultMessage(is_error=True, subtype="error_during_execution", result="boom"),
    ]
    runner = ClaudeSDKRunner()
    with pytest.raises(RuntimeError, match="boom"):
        await run(runner, make_ctx(), script)


async def test_mcp_prefix_stripped_and_unknown_tool_defaults(fake_sdk):
    script = [
        AssistantMessage(
            content=[ToolUseBlock(id="t2", name="mcp__myapp__list_bills", input={})]
        ),
        ResultMessage(),
    ]
    _, emitted, _ = await run(ClaudeSDKRunner(), make_ctx(), script)
    tc = next(e for e in emitted if e["type"] == "tool_call")
    assert tc["tool"] == "list_bills"
    assert tc["kind"] == "unknown" and tc["label"] == "list_bills"


async def test_resume_skips_history_injection(fake_sdk):
    script = [ResultMessage()]
    runner = ClaudeSDKRunner()
    ctx = make_ctx(
        provider_session_id="sess-old",
        messages=[{"role": "user", "content": "earlier"}],
    )
    client, _, _ = await run(runner, ctx, script)
    assert client.queried_with == "hello"
    assert client.options.resume == "sess-old"


async def test_history_fallback_without_resume(fake_sdk):
    script = [ResultMessage()]
    ctx = make_ctx(
        messages=[
            {"role": "user", "content": "earlier question"},
            {"role": "assistant", "content": "earlier answer"},
        ]
    )
    client, _, _ = await run(ClaudeSDKRunner(), ctx, script)
    assert "<conversation_history>" in client.queried_with
    assert "User: earlier question" in client.queried_with
    assert client.queried_with.endswith("hello")
    assert client.options.resume is None


async def test_custom_tool_meta(fake_sdk):
    meta = {"list_bills": ToolMeta("finance", "List bills")}
    script = [
        AssistantMessage(content=[ToolUseBlock(id="t3", name="list_bills", input={})]),
        ResultMessage(),
    ]
    _, emitted, _ = await run(ClaudeSDKRunner(tool_meta=meta), make_ctx(), script)
    tc = next(e for e in emitted if e["type"] == "tool_call")
    assert tc["kind"] == "finance" and tc["label"] == "List bills"


# -- usage accounting (TurnResult.usage) --------------------------------------


async def test_usage_prefers_the_result_message_total(fake_sdk):
    """ResultMessage carries the turn total — prefer it over summing messages.

    Summing per-message usage AND the result total double-counts, which is the
    mistake a host reimplementing this around the adapter would most likely make.
    """
    script = [
        AssistantMessage(content=[TextBlock("hi")], usage={"input_tokens": 10, "output_tokens": 3}),
        ResultMessage(usage={"input_tokens": 10, "output_tokens": 5}),
    ]
    _, _, result = await run(ClaudeSDKRunner(), make_ctx(), script)
    assert result.usage == {"input_tokens": 10, "output_tokens": 5}


async def test_usage_falls_back_to_accumulating_assistant_messages(fake_sdk):
    """Some providers report per-message usage and no total."""
    script = [
        AssistantMessage(content=[TextBlock("a")], usage={"input_tokens": 5, "output_tokens": 1}),
        AssistantMessage(content=[TextBlock("b")], usage={"input_tokens": 4, "output_tokens": 2}),
        ResultMessage(),
    ]
    _, _, result = await run(ClaudeSDKRunner(), make_ctx(), script)
    assert result.usage == {"input_tokens": 9, "output_tokens": 3}


async def test_usage_is_none_when_the_provider_reports_none(fake_sdk):
    """Absent is None, not {} — "not reported" and "reported zero" differ."""
    script = [AssistantMessage(content=[TextBlock("hi")]), ResultMessage()]
    _, _, result = await run(ClaudeSDKRunner(), make_ctx(), script)
    assert result.usage is None


async def test_usage_is_not_an_event(fake_sdk):
    """Usage must not enter the render stream — it is not part of the protocol.

    If it ever became an event, events.schema.json and the pinned fold-vectors
    would need re-pinning, and every consumer of the fold would see it.
    """
    script = [
        AssistantMessage(content=[TextBlock("hi")], usage={"input_tokens": 1, "output_tokens": 1}),
        ResultMessage(usage={"input_tokens": 1, "output_tokens": 1}),
    ]
    _, emitted, _ = await run(ClaudeSDKRunner(), make_ctx(), script)
    assert all("usage" not in ev for ev in emitted), (
        "usage leaked into the event stream"
    )
