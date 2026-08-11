/** The pump (runnerFromStream) is the framework-agnostic core every adapter
 * reuses. These tests drive it with hand-written AgentEvent streams — no
 * framework at all — which is exactly the surface a new adapter targets. */

import { describe, expect, it } from "vitest";
import {
  runnerFromStream,
  gateTool,
  resolveToolMeta,
  type AgentEvent,
} from "../src/index.js";
import type { Emit, StampedEvent, TurnContext } from "../src/index.js";

function harness(overrides: Partial<TurnContext> = {}) {
  const emitted: StampedEvent[] = [];
  let seq = 0;
  const emit: Emit = async (ev) => {
    const stamped = { ...ev, seq: ++seq, ts: "t" } as StampedEvent;
    emitted.push(stamped);
    return stamped;
  };
  const ctx: TurnContext = {
    session: { id: "s1" },
    messages: [],
    userContent: "hi",
    userMessageId: "u1",
    assistantMessageId: "a1",
    jobId: "j1",
    attachments: [],
    signal: new AbortController().signal,
    providerSessionId: null,
    ...overrides,
  };
  return { ctx, emit, emitted };
}

const streamOf = (events: AgentEvent[]) => async function* () {
  for (const e of events) yield e;
};

describe("runnerFromStream", () => {
  it("coalesces text deltas and supersedes them with a text-block", async () => {
    const { ctx, emit, emitted } = harness();
    const result = await runnerFromStream({
      start: streamOf([
        { type: "text-delta", text: "Hel" },
        { type: "text-delta", text: "lo" },
        { type: "text-block", text: "Hello" },
      ]),
    })(ctx, emit);
    // deltas coalesced into >=1 text event, then the authoritative block
    expect(emitted.filter((e) => e.type === "text").length).toBeGreaterThanOrEqual(1);
    expect(emitted.at(-1)).toMatchObject({ type: "text_block", content: "Hello" });
    expect(result.content).toBe("Hello");
  });

  it("returns empty content for a delta-only stream (host derives it from the fold)", async () => {
    const { ctx, emit, emitted } = harness();
    const result = await runnerFromStream({
      start: streamOf([{ type: "text-delta", text: "just streamed" }]),
    })(ctx, emit);
    expect(emitted.some((e) => e.type === "text")).toBe(true);
    expect(result.content).toBe(""); // no authoritative block -> empty; host folds the log
  });

  it("enriches tool calls with meta and emits tool results", async () => {
    const { ctx, emit, emitted } = harness();
    await runnerFromStream({
      start: streamOf([
        { type: "tool-call", id: "t1", name: "Bash", input: { command: "ls -la" } },
        { type: "tool-result", id: "t1", ok: true, summary: "done" },
      ]),
    })(ctx, emit);
    expect(emitted[0]).toMatchObject({ type: "tool_call", tool: "Bash", kind: "shell", label: "Run command", detail: "ls -la" });
    expect(emitted[1]).toMatchObject({ type: "tool_result", id: "t1", ok: true, summary: "done" });
  });

  it("rounds a session id into ctx.newProviderSessionId", async () => {
    const { ctx, emit } = harness();
    await runnerFromStream({ start: streamOf([{ type: "session", id: "sess-9" }]) })(ctx, emit);
    expect(ctx.newProviderSessionId).toBe("sess-9");
  });

  it("throws on an in-band error event", async () => {
    const { ctx, emit } = harness();
    await expect(
      runnerFromStream({ start: streamOf([{ type: "error", message: "boom" }]) })(ctx, emit),
    ).rejects.toThrow(/boom/);
  });

  it("wires ctx.signal to the stream's abort signal", async () => {
    const ac = new AbortController();
    const { ctx, emit } = harness({ signal: ac.signal });
    let sawAbort = false;
    const runner = runnerFromStream({
      start: async function* (_ctx, signal) {
        ac.abort(); // host stops the turn
        // eslint-disable-next-line @typescript-eslint/await-thenable
        await Promise.resolve();
        sawAbort = signal.aborted;
        yield { type: "text-delta", text: "x" } as AgentEvent;
      },
    });
    await runner(ctx, emit);
    expect(sawAbort).toBe(true);
  });

  it("gracefulStop is exposed while the turn runs", async () => {
    const { ctx, emit } = harness();
    let hadStop = false;
    await runnerFromStream({
      start: async function* () {
        hadStop = typeof ctx.gracefulStop === "function";
      },
    })(ctx, emit);
    expect(hadStop).toBe(true);
    expect(ctx.gracefulStop).toBeUndefined(); // cleared after the turn
  });
});

describe("toolkit helpers", () => {
  it("resolveToolMeta strips the mcp prefix and computes detail", () => {
    const m = resolveToolMeta("mcp__server__Read", undefined, { file_path: "/a" });
    expect(m).toMatchObject({ name: "Read", kind: "file", detail: "/a" });
  });

  it("gateTool asks the gate and blocks on deny", async () => {
    const { ctx } = harness({ requestPermission: async () => "deny" });
    const wrapped = gateTool(ctx, {}, "danger", async () => "ran");
    await expect(wrapped({})).rejects.toThrow(/Permission denied/);
  });

  it("gateTool runs the tool on allow", async () => {
    const { ctx } = harness({ requestPermission: async () => "allow" });
    const wrapped = gateTool(ctx, {}, "safe", async () => "ran");
    expect(await wrapped({})).toBe("ran");
  });
});
