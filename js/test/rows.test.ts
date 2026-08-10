import { describe, expect, it } from "vitest";
import { buildRows } from "../src/react/context";
import type { Message } from "../src/client";
import type { StreamItem } from "../src/fold";

const user = (id: string, content: string): Message => ({
  id, session_id: "s", role: "user", content, events: null, streaming: false, created_at: "",
});

const assistant = (id: string, events: Message["events"], content = ""): Message => ({
  id, session_id: "s", role: "assistant", content, events, streaming: false, created_at: "",
});

describe("buildRows", () => {
  it("user messages become a single closed text item", () => {
    const rows = buildRows([user("u1", "hi")], []);
    expect(rows).toHaveLength(1);
    expect(rows[0].items).toEqual([{ type: "text", content: "hi", open: false }]);
    expect(rows[0].live).toBe(false);
  });

  it("assistant messages fold their events", () => {
    const rows = buildRows(
      [
        assistant("a1", [
          { seq: 1, type: "message_start", message_id: "a1", ts: "" },
          { seq: 2, type: "text_block", content: "done.", ts: "" },
        ] as any),
      ],
      []
    );
    expect(rows[0].items).toEqual([{ type: "text", content: "done.", open: false }]);
  });

  it("assistant without events falls back to plain content", () => {
    const rows = buildRows([assistant("a1", null, "plain")], []);
    expect(rows[0].items[0]).toEqual({ type: "text", content: "plain", open: false });
  });

  it("live items append as a trailing live row; empty live adds nothing", () => {
    const liveItems: StreamItem[] = [{ type: "text", content: "streaming", open: true }];
    const rows = buildRows([user("u1", "q")], liveItems);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ id: "__live__", role: "assistant", live: true });
    expect(buildRows([user("u1", "q")], [])).toHaveLength(1);
  });

  it("streaming with no items yet yields an empty typing row", () => {
    const rows = buildRows([user("u1", "q")], [], true);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ live: true, typing: true, items: [] });
  });

  it("typing is false while a text run is open, true when it closes or a tool runs", () => {
    const open: StreamItem[] = [{ type: "text", content: "typing…", open: true }];
    expect(buildRows([], open, true)[0].typing).toBe(false);

    const closed: StreamItem[] = [{ type: "text", content: "done.", open: false }];
    expect(buildRows([], closed, true)[0].typing).toBe(true);

    const tool: StreamItem[] = [
      { type: "text", content: "checking", open: false },
      { type: "tool", id: "t1", status: "running" },
    ];
    expect(buildRows([], tool, true)[0].typing).toBe(true);
  });

  it("no typing row after the turn ends", () => {
    expect(buildRows([], [], false)).toHaveLength(0);
  });
});
