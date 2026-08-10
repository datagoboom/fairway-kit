import { describe, expect, it } from "vitest";
import { parseFrame } from "../src/stream";

describe("parseFrame", () => {
  it("parses a data frame", () => {
    expect(parseFrame('data: {"seq":1,"type":"text","ts":"t","content":"x"}')).toEqual({
      seq: 1,
      type: "text",
      ts: "t",
      content: "x",
    });
  });
  it("skips heartbeat comments", () => {
    expect(parseFrame(": hb")).toBeNull();
  });
  it("skips malformed JSON without throwing", () => {
    expect(parseFrame("data: {oops")).toBeNull();
  });
  it("rejects frames missing the envelope", () => {
    expect(parseFrame('data: {"type":"text"}')).toBeNull();
  });
});
