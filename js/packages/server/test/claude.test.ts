/** Claude adapter mapping, driven by a fake queryFn (no SDK, no credentials).
 * Verifies SDK-message -> protocol-event translation, delta coalescing, the
 * session-id round-trip, the permission gate, and error propagation. */

import { describe, expect, it } from "vitest";
import { claudeSDKRunner, DEFAULT_TOOL_META, type SdkMessage } from "../src/adapters/claude.js";
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

const fakeQuery = (msgs: SdkMessage[]) => async function* () {
  for (const m of msgs) yield m;
};

describe("claude adapter", () => {
  it("maps deltas, text_block, tool_use, tool_result, and the session id", async () => {
    const msgs: SdkMessage[] = [
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } } },
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "lo" } } },
      { type: "assistant", message: { content: [{ type: "text", text: "Hello" }] } },
      { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/x" } }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: false, content: "data" }] } },
      { type: "result", subtype: "success", result: "Hello", session_id: "sess-123" },
    ];
    const { ctx, emit, emitted } = harness();
    const runner = claudeSDKRunner({ queryFn: fakeQuery(msgs) as never });
    const result = await runner(ctx, emit);

    const byType = emitted.map((e) => e.type);
    expect(byType).toContain("text"); // coalesced deltas
    const textBlock = emitted.find((e) => e.type === "text_block");
    expect(textBlock?.content).toBe("Hello");
    const toolCall = emitted.find((e) => e.type === "tool_call") as StampedEvent & Record<string, unknown>;
    expect(toolCall).toMatchObject({ tool: "Read", kind: "file", label: "Read file", detail: "/x" });
    const toolResult = emitted.find((e) => e.type === "tool_result") as StampedEvent & Record<string, unknown>;
    expect(toolResult).toMatchObject({ id: "t1", ok: true, summary: "data" });

    expect(result.content).toBe("Hello");
    expect(ctx.newProviderSessionId).toBe("sess-123");
  });

  it("routes tool permission through the gate and denies when the user denies", async () => {
    const decisions: string[] = [];
    let capturedResult: unknown;
    const queryFn = async function* (args: { options: Record<string, unknown> }) {
      const canUseTool = args.options.canUseTool as (t: string, i: unknown) => Promise<unknown>;
      capturedResult = await canUseTool("Bash", { command: "rm -rf /" });
      yield { type: "result", subtype: "success", result: "", session_id: "s" } as SdkMessage;
    };
    const { ctx, emit } = harness({
      requestPermission: async (req) => {
        decisions.push(req.tool);
        return "deny";
      },
    });
    const runner = claudeSDKRunner({ queryFn: queryFn as never });
    await runner(ctx, emit);
    expect(decisions).toEqual(["Bash"]);
    expect(capturedResult).toEqual({
      behavior: "deny",
      message: "The user denied permission for this tool call.",
    });
  });

  it("omits the gate under bypassPermissions", async () => {
    let hadCallback = true;
    const queryFn = async function* (args: { options: Record<string, unknown> }) {
      hadCallback = args.options.canUseTool !== undefined;
      yield { type: "result", subtype: "success", result: "", session_id: "s" } as SdkMessage;
    };
    const { ctx, emit } = harness({ requestPermission: async () => "allow" });
    await claudeSDKRunner({ queryFn: queryFn as never, permissionMode: "bypassPermissions" })(ctx, emit);
    expect(hadCallback).toBe(false);
  });

  it("throws on an error result", async () => {
    const msgs: SdkMessage[] = [
      { type: "result", subtype: "error_max_turns", session_id: "s" },
    ];
    const { ctx, emit } = harness();
    await expect(claudeSDKRunner({ queryFn: fakeQuery(msgs) as never })(ctx, emit)).rejects.toThrow(
      /error_max_turns/,
    );
  });

  it("injects a history block only when there is no resume token", async () => {
    let prompt: unknown;
    const queryFn = async function* (args: { prompt: unknown }) {
      prompt = args.prompt;
      yield { type: "result", subtype: "success", result: "", session_id: "s" } as SdkMessage;
    };
    // No providerSessionId + prior messages -> history injected.
    const h1 = harness({
      messages: [
        { id: "m1", session_id: "s1", role: "user", content: "earlier", events: null, streaming: false, created_at: "t" },
      ],
    });
    await claudeSDKRunner({ queryFn: queryFn as never })(h1.ctx, h1.emit);
    expect(String(prompt)).toContain("conversation_history");
    expect(String(prompt)).toContain("earlier");

    // With a resume token -> no history block (SDK resume carries continuity).
    const h2 = harness({ providerSessionId: "sess", messages: h1.ctx.messages });
    await claudeSDKRunner({ queryFn: queryFn as never })(h2.ctx, h2.emit);
    expect(String(prompt)).not.toContain("conversation_history");
  });

  it("exposes the default tool metadata", () => {
    expect(DEFAULT_TOOL_META.Bash.kind).toBe("shell");
    expect(DEFAULT_TOOL_META.Read.detail?.({ file_path: "/a" })).toBe("/a");
  });
});
