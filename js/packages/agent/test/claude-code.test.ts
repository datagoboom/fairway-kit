/** Claude Code adapter mapping, driven by a fake queryFn (no SDK, no
 * credentials). Verifies SDK-message -> AgentEvent -> protocol-event
 * translation, delta coalescing, the session-id round-trip, the permission
 * gate, and error propagation. */

import { describe, expect, it } from "vitest";
import { claudeCodeRunner, DEFAULT_TOOL_META, type SdkMessage } from "../src/adapters/claude-code.js";
import type { StampedEvent } from "../src/index.js";
import { harness } from "./harness.js";

const fakeQuery = (msgs: SdkMessage[]) => async function* () {
  for (const m of msgs) yield m;
};

describe("claude-code adapter", () => {
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
    const result = await claudeCodeRunner({ queryFn: fakeQuery(msgs) as never })(ctx, emit);

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
    await claudeCodeRunner({ queryFn: queryFn as never })(ctx, emit);
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
    await claudeCodeRunner({ queryFn: queryFn as never, permissionMode: "bypassPermissions" })(ctx, emit);
    expect(hadCallback).toBe(false);
  });

  it("passes allowed/disallowed tool sets through to the SDK options", async () => {
    let opts: Record<string, unknown> | undefined;
    const queryFn = async function* (args: { options: Record<string, unknown> }) {
      opts = args.options;
      yield { type: "result", subtype: "success", result: "", session_id: "s" } as SdkMessage;
    };
    const { ctx, emit } = harness();
    await claudeCodeRunner({
      queryFn: queryFn as never,
      allowedTools: ["Read"],
      disallowedTools: ["Bash", "Write"],
      maxTurns: 7,
    })(ctx, emit);
    expect(opts?.allowedTools).toEqual(["Read"]);
    expect(opts?.disallowedTools).toEqual(["Bash", "Write"]);
    expect(opts?.maxTurns).toBe(7);
  });

  it("throws on an error result", async () => {
    const msgs: SdkMessage[] = [{ type: "result", subtype: "error_max_turns", session_id: "s" }];
    const { ctx, emit } = harness();
    await expect(claudeCodeRunner({ queryFn: fakeQuery(msgs) as never })(ctx, emit)).rejects.toThrow(
      /error_max_turns/,
    );
  });

  it("injects a history block only when there is no resume token", async () => {
    let prompt: unknown;
    const queryFn = async function* (args: { prompt: unknown }) {
      prompt = args.prompt;
      yield { type: "result", subtype: "success", result: "", session_id: "s" } as SdkMessage;
    };
    const h1 = harness({
      messages: [
        { id: "m1", session_id: "s1", role: "user", content: "earlier", events: null, streaming: false, created_at: "t" },
      ],
    });
    await claudeCodeRunner({ queryFn: queryFn as never })(h1.ctx, h1.emit);
    expect(String(prompt)).toContain("conversation_history");
    expect(String(prompt)).toContain("earlier");

    const h2 = harness({ providerSessionId: "sess", messages: h1.ctx.messages });
    await claudeCodeRunner({ queryFn: queryFn as never })(h2.ctx, h2.emit);
    expect(String(prompt)).not.toContain("conversation_history");
  });

  it("exposes the default tool metadata", () => {
    expect(DEFAULT_TOOL_META.Bash.kind).toBe("shell");
    expect(DEFAULT_TOOL_META.Read.detail?.({ file_path: "/a" })).toBe("/a");
  });
});
