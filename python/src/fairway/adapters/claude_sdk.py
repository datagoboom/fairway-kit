"""Claude Agent SDK runner adapter.

Maps Claude Agent SDK messages -> protocol events (PROTOCOL.md 3):

    StreamEvent content_block_delta/text_delta      -> text (coalesced)
    StreamEvent content_block_delta/thinking_delta  -> thinking (coalesced)
    AssistantMessage / TextBlock                    -> text_block (authoritative)
    AssistantMessage / ToolUseBlock                 -> tool_call (metadata from tool_meta)
    UserMessage / ToolResultBlock                   -> tool_result (matched by tool_use id)
    ResultMessage                                   -> TurnResult + session-id round-trip

Uses ClaudeSDKClient (not query()) so JobRegistry.stop() can interrupt the live
turn via ctx.graceful_stop. Requires the `claude` extra: pip install fairway[claude].

## Auth modes

The SDK spawns the `claude` CLI, which resolves credentials from its subprocess
environment: an ANTHROPIC_API_KEY wins over the CLI's stored subscription login
(`claude login`, Pro/Max OAuth). The subprocess inherits this process's env and
merges ClaudeAgentOptions.env over it, so:

- ``auth="api"``           - bill per-token via the API. Passes ``api_key`` (or the
                             inherited ANTHROPIC_API_KEY) into the subprocess env;
                             raises if neither is available.
- ``auth="subscription"``  - use the Claude subscription. Overrides
                             ANTHROPIC_API_KEY to "" so an exported key in the host
                             process cannot shadow the CLI's stored OAuth login
                             (the CLI treats an empty key as unset). Optionally
                             pass ``oauth_token`` (from ``claude setup-token``) as
                             CLAUDE_CODE_OAUTH_TOKEN for headless hosts with no
                             stored login.
- ``auth="inherit"``       - (default) leave the environment alone; whatever the
                             host process/CLI is configured with applies.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Literal

from .. import events as E
from ..runner import Emit, TurnContext, TurnResult

# Cap for the generic argument rendering below. Bounded because tool_call events
# are PERSISTED and, under a raw-events wire contract, re-sent on every history
# load — an unbounded arg dump (a file write, a pasted blob) would bloat both.
#
# WHY 2000 AND NOT A MEASURED VALUE. I tried to set this from real data and the
# measurement was worthless: across 410 stored tool_calls the detail lengths ran
# min 2, median 120, p99 120, MAX 120 — because the previous emitter had already
# hard-truncated every one of them at 120. The distribution is censored at
# exactly the quantity I was trying to measure past, so "0% would truncate at
# 200" said nothing about real arguments and everything about the old cap. (We
# know ~70% of them WERE truncated: 288/409 sat exactly at 120.)
#
# So this is chosen to be generous rather than fitted: large enough that a
# realistic shell command, path list or JSON body passes through whole, small
# enough to stop a pasted file body. When genuinely uncensored data exists it
# can be revisited — but a number fitted to clipped data would have looked
# evidence-based while being an artefact of the bug we are fixing.
_DETAIL_CAP = 2000


def _default_detail(inp: Any) -> str | None:
    """Render tool arguments for display when no per-tool formatter is set.

    Truncation is MARKED, never silent. A chopped command rendered as though it
    were whole is a lie by omission — the operator cannot tell that what they
    are reading is not what ran. The count of dropped characters is included so
    the omission is legible rather than merely hinted at.
    """
    if not isinstance(inp, dict) or not inp:
        return None
    try:
        s = json.dumps(inp, default=str, separators=(",", ":"), sort_keys=True)
    except Exception:  # noqa: BLE001 — detail is cosmetic, never fatal
        return None
    if len(s) <= _DETAIL_CAP:
        return s
    return f"{s[:_DETAIL_CAP]}… (+{len(s) - _DETAIL_CAP} more chars)"

AuthMode = Literal["api", "subscription", "inherit"]

# Coalesce streamed deltas so the wire (and therefore the event log - they are
# the same, PROTOCOL.md 4.3) isn't one event per token.
FLUSH_INTERVAL_S = 0.15
FLUSH_MIN_CHARS = 48

HISTORY_FALLBACK_TURNS = 20


@dataclass
class ToolMeta:
    """Display metadata for one tool, declared server-side next to the tool
    definitions and injected into tool_call events (PROTOCOL.md 3) so clients
    never keep their own name->label maps."""

    kind: str
    label: str
    detail: Callable[[dict[str, Any]], str | None] | None = None


DEFAULT_TOOL_META: dict[str, ToolMeta] = {
    "Read": ToolMeta("file", "Read file", lambda i: i.get("file_path")),
    "Write": ToolMeta("file-write", "Write file", lambda i: i.get("file_path")),
    "Edit": ToolMeta("file-write", "Edit file", lambda i: i.get("file_path")),
    "Bash": ToolMeta("shell", "Run command", lambda i: (i.get("command") or "")[:80] or None),
    "Glob": ToolMeta("search", "Find files", lambda i: i.get("pattern")),
    "Grep": ToolMeta("search", "Search code", lambda i: i.get("pattern")),
    "WebSearch": ToolMeta("web", "Web search", lambda i: i.get("query")),
    "WebFetch": ToolMeta("web", "Fetch page", lambda i: i.get("url")),
}


@dataclass
class ClaudeSDKRunner:
    """Configure once, pass as the `runner` to mount_agent_chat."""

    model: str = "claude-opus-4-8"
    auth: AuthMode = "inherit"
    api_key: str | None = None  # auth="api": explicit key (else inherited env)
    oauth_token: str | None = None  # auth="subscription": claude setup-token output
    tools: list[str] | None = None  # base built-in tool set; [] disables all
    allowed_tools: list[str] = field(default_factory=list)
    max_turns: int = 100
    permission_mode: str = "default"
    cwd: str | None = None
    system_prompt: Callable[[TurnContext], str] | None = None
    tool_meta: dict[str, ToolMeta] = field(default_factory=lambda: dict(DEFAULT_TOOL_META))
    mcp_servers: dict[str, Any] = field(default_factory=dict)
    # Safe by default: without strict mode the CLI also loads user/project MCP
    # servers, silently widening the agent's tool surface beyond what the app
    # declared. Opt out only if you deliberately want host-level MCP servers.
    strict_mcp_config: bool = True
    env: dict[str, str] = field(default_factory=dict)  # extra subprocess env
    flush_interval_s: float = FLUSH_INTERVAL_S
    flush_min_chars: int = FLUSH_MIN_CHARS
    # Test seam: replaces ClaudeSDKClient. Must be an async-context-manager
    # factory taking options and exposing query/receive_response/interrupt.
    client_factory: Callable[[Any], Any] | None = None

    def build_env(self) -> dict[str, str]:
        """Subprocess env overrides implementing the auth mode (see module doc)."""
        import os

        env = dict(self.env)
        if self.auth == "api":
            key = self.api_key or os.environ.get("ANTHROPIC_API_KEY")
            if not key:
                raise RuntimeError(
                    "ClaudeSDKRunner(auth='api') requires api_key= or ANTHROPIC_API_KEY"
                )
            env["ANTHROPIC_API_KEY"] = key
        elif self.auth == "subscription":
            # The subprocess inherits os.environ; an exported API key would win
            # over the CLI's subscription login. Blank it out (options.env can
            # override inherited vars but not remove them).
            env["ANTHROPIC_API_KEY"] = ""
            if self.oauth_token:
                env["CLAUDE_CODE_OAUTH_TOKEN"] = self.oauth_token
        return env

    def _build_can_use_tool(self, ctx: TurnContext):
        """Wire the protocol permission gate into the SDK's can_use_tool hook.

        Only meaningful when permission_mode leaves decisions to the callback
        ("default"/"acceptEdits"/"plan" - the SDK shadows it under
        "bypassPermissions"/"dontAsk"). Tools listed in `allowed_tools` are
        auto-approved by the SDK before the callback runs, which composes with
        the gate: allowed_tools = pre-approved, everything else asks.
        """
        if ctx.request_permission is None or self.permission_mode in (
            "bypassPermissions",
            "dontAsk",
        ):
            return None
        from claude_agent_sdk.types import PermissionResultAllow, PermissionResultDeny

        request_permission = ctx.request_permission

        async def can_use_tool(tool_name: str, input_data: dict[str, Any], _context: Any):
            name = _strip_mcp_prefix(tool_name)
            meta = self.tool_meta.get(name) or ToolMeta("unknown", name)
            detail = None
            if meta.detail is not None and isinstance(input_data, dict):
                try:
                    detail = meta.detail(input_data)
                except Exception:  # noqa: BLE001 - detail is cosmetic
                    detail = None
            decision = await request_permission(
                tool=name, kind=meta.kind, label=meta.label, detail=detail, input=input_data
            )
            if decision in ("allow", "allow_session"):
                return PermissionResultAllow()
            return PermissionResultDeny(message="The user denied permission for this tool call.")

        return can_use_tool

    async def __call__(self, ctx: TurnContext, emit: Emit) -> TurnResult:
        from claude_agent_sdk import ClaudeAgentOptions, ClaudeSDKClient
        from claude_agent_sdk.types import (
            AssistantMessage,
            ResultMessage,
            StreamEvent,
            TextBlock,
            ThinkingBlock,
            ToolResultBlock,
            ToolUseBlock,
            UserMessage,
        )

        can_use_tool = self._build_can_use_tool(ctx)
        options = ClaudeAgentOptions(
            model=self.model,
            tools=self.tools,
            allowed_tools=self.allowed_tools,
            max_turns=self.max_turns,
            permission_mode=self.permission_mode,
            cwd=self.cwd,
            mcp_servers=self.mcp_servers,
            strict_mcp_config=self.strict_mcp_config,
            system_prompt=self.system_prompt(ctx) if self.system_prompt else None,
            resume=ctx.provider_session_id,
            include_partial_messages=True,  # StreamEvent deltas for live typing
            env=self.build_env(),
            can_use_tool=can_use_tool,
        )

        prompt = self._build_prompt(ctx)
        images = [
            a for a in ctx.attachments
            if a.get("path") and str(a.get("media_type", "")).startswith("image/")
        ]
        if images:
            prompt = _content_block_prompt(prompt, images)
        factory = self.client_factory or ClaudeSDKClient
        coalescer = _Coalescer(emit, self.flush_interval_s, self.flush_min_chars)
        text_parts: list[str] = []
        error_result: str | None = None
        # Token accounting, surfaced on TurnResult. The SDK reports usage on
        # both AssistantMessage and ResultMessage; the ResultMessage figure is
        # the turn total, so prefer it and fall back to accumulating the
        # per-message numbers when it is absent.
        usage_total: dict[str, Any] | None = None
        usage_accum: dict[str, int] = {}

        async with factory(options) as client:
            ctx.graceful_stop = client.interrupt  # PROTOCOL.md 9, graceful phase
            try:
                await client.query(prompt)
                async for msg in client.receive_response():
                    if isinstance(msg, StreamEvent):
                        await self._on_stream_event(msg, coalescer)
                    elif isinstance(msg, AssistantMessage):
                        msg_usage = getattr(msg, "usage", None)
                        if isinstance(msg_usage, dict):
                            for k, v in msg_usage.items():
                                if isinstance(v, int):
                                    usage_accum[k] = usage_accum.get(k, 0) + v
                        for block in msg.content:
                            if isinstance(block, TextBlock):
                                await coalescer.drop_pending("text")
                                text_parts.append(block.text)
                                await emit(E.text_block(block.text))
                            elif isinstance(block, ThinkingBlock):
                                await coalescer.drop_pending("thinking")
                            elif isinstance(block, ToolUseBlock):
                                await coalescer.flush()
                                await emit(self._tool_call_event(block))
                    elif isinstance(msg, UserMessage):
                        content = msg.content if isinstance(msg.content, list) else []
                        for block in content:
                            if isinstance(block, ToolResultBlock):
                                await coalescer.flush()
                                await emit(
                                    E.tool_result(
                                        block.tool_use_id,
                                        ok=not bool(block.is_error),
                                        summary=_summarize_result(block.content),
                                    )
                                )
                    elif isinstance(msg, ResultMessage):
                        if msg.session_id:
                            ctx.new_provider_session_id = msg.session_id
                        result_usage = getattr(msg, "usage", None)
                        if isinstance(result_usage, dict):
                            usage_total = dict(result_usage)
                        if msg.is_error:
                            error_result = msg.result or f"agent error ({msg.subtype})"
            finally:
                ctx.graceful_stop = None
                await coalescer.flush()

        if error_result is not None:
            raise RuntimeError(error_result)
        return TurnResult(
            content="\n\n".join(p for p in text_parts if p),
            usage=usage_total if usage_total is not None else (usage_accum or None),
        )

    # -- helpers -------------------------------------------------------------

    def _build_prompt(self, ctx: TurnContext) -> str:
        """SDK-side session resume is the primary continuity mechanism; inject a
        compact history block ONLY when there is no resume token - doing both
        double-feeds the conversation and bloats the prompt."""
        if ctx.provider_session_id or not ctx.messages:
            return self._append_file_notes(ctx.user_content, ctx)
        recent = ctx.messages[-HISTORY_FALLBACK_TURNS:]
        lines = [f"{m['role'].capitalize()}: {m['content']}" for m in recent if m.get("content")]
        base = (
            "<conversation_history>\n"
            + "\n".join(lines)
            + "\n</conversation_history>\n\n"
            + ctx.user_content
        )
        return self._append_file_notes(base, ctx)

    def _append_file_notes(self, prompt: str, ctx: TurnContext) -> str:
        """Non-image attachments become path notes the agent can Read."""
        files = [
            a for a in ctx.attachments
            if a.get("path") and not str(a.get("media_type", "")).startswith("image/")
        ]
        if not files:
            return prompt
        notes = "\n".join(
            f"- {a.get('name', 'file')} ({a.get('media_type', '?')}): {a['path']}"
            for a in files
        )
        return f"{prompt}\n\n<attached_files>\n{notes}\n</attached_files>"

    def _tool_call_event(self, block: Any) -> dict[str, Any]:
        name = _strip_mcp_prefix(block.name)
        meta = self.tool_meta.get(name) or ToolMeta("unknown", name)
        detail = None
        if meta.detail is not None and isinstance(block.input, dict):
            try:
                detail = meta.detail(block.input)
            except Exception:  # noqa: BLE001 - detail is cosmetic, never fatal
                detail = None
        if detail is None:
            # Fall back to a generic rendering of the arguments.
            #
            # Without this, an adopter who registers no per-tool `detail`
            # callback gets tool_call events carrying no arguments at all, and
            # the operator can see WHICH tool ran but not WITH WHAT. That is a
            # silent capability loss: the cards render, the counts pass, and
            # only someone reading an actual card notices the args are gone.
            # (Found by Claudia on the paranoid-130 deploy — migrated history
            # showed args on 204/204 cards while every new turn showed none.)
            #
            # This is a faithful rendering of the real arguments, not invented
            # metadata: unlike a synthesised `label`, it asserts nothing that
            # was not in the call.
            detail = _default_detail(block.input)
        return E.tool_call(block.id, name, meta.kind, meta.label, detail=detail)

    async def _on_stream_event(self, msg: Any, coalescer: _Coalescer) -> None:
        ev = msg.event
        if ev.get("type") != "content_block_delta":
            return
        delta = ev.get("delta") or {}
        if delta.get("type") == "text_delta" and delta.get("text"):
            await coalescer.add("text", delta["text"])
        elif delta.get("type") == "thinking_delta" and delta.get("thinking"):
            await coalescer.add("thinking", delta["thinking"])


class _Coalescer:
    """Batches streamed deltas before they hit the (durable) event stream:
    coalescing happens before seq assignment, so wire == log (PROTOCOL.md 4.3)."""

    def __init__(self, emit: Emit, interval: float = FLUSH_INTERVAL_S, min_chars: int = FLUSH_MIN_CHARS):
        self._emit = emit
        self._interval = interval
        self._min_chars = min_chars
        self._kind: str | None = None
        self._buf: list[str] = []
        self._last_flush = time.monotonic()

    async def add(self, kind: str, content: str) -> None:
        if self._kind is not None and self._kind != kind:
            await self.flush()
        self._kind = kind
        self._buf.append(content)
        if (
            sum(len(c) for c in self._buf) >= self._min_chars
            or time.monotonic() - self._last_flush >= self._interval
        ):
            await self.flush()

    async def flush(self) -> None:
        if self._buf and self._kind:
            content = "".join(self._buf)
            ev = E.text(content) if self._kind == "text" else E.thinking(content)
            await self._emit(ev)
        self._buf = []
        self._last_flush = time.monotonic()

    async def drop_pending(self, kind: str) -> None:
        """Discard buffered deltas of `kind` - the authoritative block for the
        run has arrived (text_block replaces the streamed run on fold)."""
        if self._kind == kind:
            self._buf = []
        else:
            await self.flush()


# Images above this size are dropped with a note: the CLI's JSON message buffer
# rejects oversized payloads, and base64 inflates by ~4/3.
MAX_IMAGE_BYTES = 3 * 1024 * 1024


def _content_block_prompt(text_prompt: str, images: list[dict[str, Any]]):
    """Wrap the prompt as the SDK's streaming-input shape so image content
    blocks can ride along with the text."""
    import base64
    from pathlib import Path

    async def gen():
        blocks: list[dict[str, Any]] = []
        for att in images:
            path = Path(att["path"])
            if not path.is_file():
                blocks.append({"type": "text", "text": f"[Attached image missing: {att.get('name')}]"})
                continue
            data = path.read_bytes()
            if len(data) > MAX_IMAGE_BYTES:
                blocks.append({
                    "type": "text",
                    "text": f"[Attached image too large to inline: {att.get('name')} at {att['path']}]",
                })
                continue
            blocks.append({
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": att.get("media_type", "image/png"),
                    "data": base64.standard_b64encode(data).decode(),
                },
            })
        blocks.append({"type": "text", "text": text_prompt})
        yield {"type": "user", "message": {"role": "user", "content": blocks}}

    return gen()


def _strip_mcp_prefix(name: str) -> str:
    if name.startswith("mcp__"):
        return name.split("__", 2)[-1]
    return name


def _summarize_result(content: Any, limit: int = 200) -> str | None:
    if content is None:
        return None
    if isinstance(content, str):
        text = content
    elif isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, dict) and item.get("type") == "text":
                parts.append(str(item.get("text", "")))
        text = " ".join(parts)
    else:
        text = str(content)
    text = " ".join(text.split())
    if not text:
        return None
    return text[:limit] + ("…" if len(text) > limit else "")


class EchoRunner:
    """Trivial runner for wiring tests and demos: echoes the user message with one
    fake tool call. Useful to exercise the full protocol path end-to-end."""

    async def __call__(self, ctx: TurnContext, emit: Emit) -> TurnResult:
        await emit(E.tool_call("echo-1", "echo", "system", "Echo", detail=ctx.user_content[:60]))
        await emit(E.tool_result("echo-1", True, summary="ok"))
        reply = f"You said: {ctx.user_content}"
        for word in reply.split(" "):
            await emit(E.text(word + " "))
        await emit(E.text_block(reply))
        return TurnResult(content=reply)
