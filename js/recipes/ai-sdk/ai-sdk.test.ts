/** Mapping test for the AI SDK recipe - self-contained (no `ai` runtime, no
 * model, no network), so this file copies cleanly alongside the recipe. It
 * feeds fake `fullStream` parts through the recipe's map and the pump, exactly
 * the way fairway's shipped adapter is tested. */

import { describe, expect, it } from "vitest";
import {
  runnerFromStream,
  type AgentEvent,
  type Emit,
  type StampedEvent,
  type TurnContext,
} from "@fairway-kit/agent";
import { mapPart } from "./ai-sdk.js";

// A minimal driver - the copy-friendly version of the conformance harness.
function makeEmit() {
  const emitted: StampedEvent[] = [];
  let seq = 0;
  const emit: Emit = async (ev) => {
    const s = { ...ev, seq: ++seq, ts: "t" } as StampedEvent;
    emitted.push(s);
    return s;
  };
  return { emit, emitted };
}
function fakeCtx(): TurnContext {
  return {
    session: { id: "s1" },
    messages: [],
    userContent: "hi",
    userMessageId: "u1",
    assistantMessageId: "a1",
    jobId: "j1",
    attachments: [],
    signal: new AbortController().signal,
    providerSessionId: null,
  };
}

// mapPart is typed against TextStreamPart<TOOLS>; in tests we hand it plain
// part-shaped objects, so cast through unknown.
const part = (p: Record<string, unknown>) => mapPart(p as never);

describe("ai-sdk recipe: part mapping", () => {
  it("maps each fullStream part type to the right AgentEvent", () => {
    expect(part({ type: "text-delta", id: "1", text: "Hi" })).toEqual({ type: "text-delta", text: "Hi" });
    expect(part({ type: "reasoning-delta", id: "1", text: "hmm" })).toEqual({ type: "thinking-delta", text: "hmm" });
    expect(part({ type: "tool-call", toolCallId: "t1", toolName: "search", input: { q: "x" } })).toEqual({
      type: "tool-call",
      id: "t1",
      name: "search",
      input: { q: "x" },
    });
    expect(part({ type: "tool-result", toolCallId: "t1", toolName: "search", output: "res" })).toMatchObject({
      type: "tool-result",
      id: "t1",
      ok: true,
      summary: "res",
    });
    expect(part({ type: "tool-error", toolCallId: "t1", toolName: "search", error: new Error("nope") })).toMatchObject({
      type: "tool-result",
      ok: false,
      summary: "nope",
    });
    expect(part({ type: "error", error: new Error("boom") })).toEqual({ type: "error", message: "boom" });
    // Non-protocol parts are dropped.
    expect(part({ type: "finish", finishReason: "stop" })).toBeNull();
    expect(part({ type: "text-start", id: "1" })).toBeNull();
  });
});

describe("ai-sdk recipe: through the pump", () => {
  it("coalesces text and emits a tool call + result", async () => {
    const fullStream = async function* () {
      yield { type: "text-delta", id: "1", text: "Hel" };
      yield { type: "text-delta", id: "1", text: "lo" };
      yield { type: "tool-call", toolCallId: "t1", toolName: "WebSearch", input: { query: "x" } };
      yield { type: "tool-result", toolCallId: "t1", toolName: "WebSearch", output: "ok" };
      yield { type: "finish", finishReason: "stop" };
    };
    const runner = runnerFromStream({
      start: async function* (): AsyncGenerator<AgentEvent> {
        for await (const p of fullStream()) {
          const ev = mapPart(p as never);
          if (ev) yield ev;
        }
      },
    });

    const { emit, emitted } = makeEmit();
    await runner(fakeCtx(), emit);
    // Text deltas coalesce (granularity varies), so assert structure, not count:
    // some text, then the tool call + result, and the joined text is right.
    expect(emitted.filter((e) => e.type !== "text").map((e) => e.type)).toEqual(["tool_call", "tool_result"]);
    const text = emitted.filter((e) => e.type === "text").map((e) => e.content).join("");
    expect(text).toBe("Hello");
    const toolCall = emitted.find((e) => e.type === "tool_call") as Record<string, unknown>;
    expect(toolCall).toMatchObject({ tool: "WebSearch", kind: "web", label: "Web search", detail: "x" });
  });
});
