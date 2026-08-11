# @fairway-kit/agent

**Claude Code native.** The one bundled, tested runner is the Claude Agent SDK
adapter; a small toolkit adapts any other harness in ~30 lines, and
[recipes](https://github.com/datagoboom/fairway-kit) give you a starting point.

The agent integration layer for [fairway](https://github.com/datagoboom/fairway-kit),
a dev kit for building local, agent-backed applications with durable, resumable
chat. Two things live here: the **Runner contract** (what you implement to drive
a turn) and the **adapter toolkit** (helpers that turn any agent's stream into
durable protocol events). [`@fairway-kit/server`](https://www.npmjs.com/package/@fairway-kit/server)
consumes a Runner — it never dictates how one is built, so you can plug in any
agent framework or a remote agent service.

> **What we guarantee:** the Claude Code adapter is dogfooded and tested. Recipes
> are honest starting points — copy, wire to your provider, and the same
> conformance harness that tests our adapter validates yours. We ship what we
> run; everything else is a recipe.

## The Runner contract

A runner is `async (ctx, emit) => TurnResult`. Emit protocol events as the turn
progresses (`ctx` carries history, the user message, attachments, an
`AbortSignal`, and an optional permission gate); the host persists each event
before fan-out, so live streaming and replay are byte-identical.

## The toolkit

Most adapters don't touch `emit` directly — they map their framework's stream
onto a normalized `AgentEvent` union and hand it to `runnerFromStream`, which
owns coalescing, the authoritative-block supersede, tool-call metadata, the
session-id round-trip, terminal handling, and cancellation:

```ts
import { runnerFromStream } from "@fairway-kit/agent";

const runner = runnerFromStream({
  start: async function* (ctx, signal) {
    for await (const part of myAgent(ctx.userContent, { signal })) {
      if (part.kind === "text") yield { type: "text-delta", text: part.text };
      if (part.kind === "tool") yield { type: "tool-call", id: part.id, name: part.name, input: part.args };
    }
  },
});
```

That is the whole adapter. `AgentEvent` covers `text-delta`, `text-block` (the
authoritative block that supersedes the streamed run on fold), `thinking-delta`,
`tool-call`, `tool-result`, `session` (round-tripped as the provider resume
token), and `error`. Terminal is implicit: the stream ending is "done".

Also exported: `Coalescer`, `DEFAULT_TOOL_META` / `resolveToolMeta`, and the
permission-gate helpers — `requestToolPermission` (for `canUseTool`-style hooks)
and `gateTool` (wrap an app-owned tool's `execute` so it asks before running).

## Bundled adapters

Adapters are subpath exports; their SDKs are optional peer dependencies, so you
install only what you use.

```ts
import { claudeCodeRunner } from "@fairway-kit/agent/claude-code"; // needs @anthropic-ai/claude-agent-sdk
```

`claudeCodeRunner` maps the Claude Agent SDK's stream to protocol events, rounds
the provider session id through `resume`, wires the human-in-the-loop permission
gate into the SDK's `canUseTool`, and interrupts the live turn on stop. Auth
modes: `"api"` (per-token via `ANTHROPIC_API_KEY`), `"subscription"` (the CLI's
stored login, optionally a `claude setup-token` token), or `"inherit"`.

Full docs and a complete example app live in the
[repository](https://github.com/datagoboom/fairway-kit).
