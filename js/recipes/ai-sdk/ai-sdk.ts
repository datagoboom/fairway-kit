/**
 * RECIPE — Vercel AI SDK adapter.
 *
 * NOT a shipped, guaranteed adapter. Copy this file into your app, install
 * `ai` + a provider (`@ai-sdk/anthropic`, `@ai-sdk/openai`, …), and verify it
 * against your provider. It's typed against the AI SDK's real `fullStream` part
 * union, so the field mapping is compile-checked — but only you can confirm it
 * against a live model. The same conformance harness that tests fairway's
 * shipped adapter validates this one (see ai-sdk.test.ts).
 *
 * One AI SDK adapter covers every provider the SDK supports (Anthropic, OpenAI,
 * Google, Mistral, Bedrock, Groq, Ollama, …) — that's the leverage. It's also
 * *stateless*: the SDK holds no server session, so fairway feeds history from
 * its own store each turn (contrast claude-code, which round-trips a resume id).
 *
 *   import { anthropic } from "@ai-sdk/anthropic";
 *   const runner = aiSdkRunner({ model: anthropic("claude-opus-4-8") });
 */

import { streamText, type LanguageModel, type ModelMessage, type TextStreamPart, type ToolSet } from "ai";
import {
  runnerFromStream,
  type AgentEvent,
  type Runner,
  type RunnerCapabilities,
  type TurnContext,
} from "@fairway-kit/agent";

export const capabilities: RunnerCapabilities = {
  thinking: true,
  tools: true,
  interrupt: true,
  session: false, // stateless: fairway replays history each turn
  // Tools are app-defined here, so gate them with @fairway-kit/agent's `gateTool`
  // inside each tool's `execute` (see the note at the bottom).
  permissionGate: true,
};

export interface AiSdkRunnerConfig {
  model: LanguageModel;
  system?: string;
  tools?: ToolSet;
}

export function aiSdkRunner(config: AiSdkRunnerConfig): Runner {
  return runnerFromStream({
    start: (ctx, signal) => aiSdkStream(ctx, config, signal),
  });
}

async function* aiSdkStream(
  ctx: TurnContext,
  config: AiSdkRunnerConfig,
  signal: AbortSignal,
): AsyncGenerator<AgentEvent> {
  const result = streamText({
    model: config.model,
    system: config.system,
    messages: toModelMessages(ctx),
    tools: config.tools,
    abortSignal: signal, // the pump aborts this when the turn is stopped
  });
  for await (const part of result.fullStream) {
    const ev = mapPart(part);
    if (ev) yield ev;
  }
  // No "session" event — stateless (see toModelMessages).
}

/** The entire adapter is this map from AI SDK stream parts to AgentEvents.
 * Everything else — coalescing, the text-block supersede, tool-meta, terminal,
 * cancellation — is the pump. Exported so the test can exercise it directly. */
export function mapPart<TOOLS extends ToolSet>(part: TextStreamPart<TOOLS>): AgentEvent | null {
  switch (part.type) {
    case "text-delta":
      return { type: "text-delta", text: part.text };
    case "reasoning-delta":
      return { type: "thinking-delta", text: part.text };
    case "tool-call":
      return { type: "tool-call", id: part.toolCallId, name: part.toolName, input: asRecord(part.input) };
    case "tool-result":
      return { type: "tool-result", id: part.toolCallId, ok: true, summary: summarize(part.output) };
    case "tool-error":
      return { type: "tool-result", id: part.toolCallId, ok: false, summary: errText(part.error) };
    case "error":
      return { type: "error", message: errText(part.error) };
    default:
      // start / finish / *-start / *-end / step / source / file / raw / abort —
      // not protocol events. Terminal is implicit (the stream ending = done).
      return null;
  }
}

/** Stateless providers get the full history each turn (fairway holds the log). */
function toModelMessages(ctx: TurnContext): ModelMessage[] {
  const history = ctx.messages
    .filter((m) => m.content)
    .map((m) => ({ role: m.role, content: m.content }) as ModelMessage);
  return [...history, { role: "user", content: ctx.userContent }];
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
}
function summarize(v: unknown, limit = 200): string {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > limit ? s.slice(0, limit) + "…" : s;
}
function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/*
 * Permission gate note: the AI SDK runs app-defined tools itself, so wrap each
 * tool's `execute` with @fairway-kit/agent's `gateTool(ctx, meta, name, execute)`
 * to route it through fairway's HITL gate before it runs. `ctx` is available in
 * the `start` closure above; thread it into where you build `config.tools`.
 */
