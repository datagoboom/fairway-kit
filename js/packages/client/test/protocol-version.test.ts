import { describe, expect, it } from "vitest";
import { protocolWarning } from "../src/client.js";

describe("protocolWarning", () => {
  it("null when identical", () => {
    expect(protocolWarning("0.2", "0.2")).toBeNull();
  });
  it("soft warning on minor skew (either direction)", () => {
    expect(protocolWarning("0.2", "0.1")).toMatch(/version skew/);
    expect(protocolWarning("0.1", "0.2")).toMatch(/version skew/);
  });
  it("hard warning on major mismatch", () => {
    expect(protocolWarning("1.0", "0.2")).toMatch(/MAJOR version mismatch/);
    expect(protocolWarning("0.2", "1.0")).toMatch(/MAJOR version mismatch/);
  });
});
