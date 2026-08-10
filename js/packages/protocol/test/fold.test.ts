/** Fold conformance against the shared vectors (protocol/fold-vectors.json). */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { fold, foldAll, type StreamItem } from "../src/fold";
import type { ChatEvent } from "../src/events";

const here = dirname(fileURLToPath(import.meta.url));
// repo root: packages/protocol/test -> ../../../.. -> then protocol/fold-vectors.json
const vectors = JSON.parse(
  readFileSync(join(here, "..", "..", "..", "..", "protocol", "fold-vectors.json"), "utf8")
) as { cases: { name: string; events: ChatEvent[]; items: StreamItem[] }[] };

describe("fold conformance vectors", () => {
  for (const c of vectors.cases) {
    it(c.name, () => {
      expect(foldAll(c.events)).toEqual(c.items);
    });
    it(`${c.name} (incremental)`, () => {
      let items: StreamItem[] = [];
      for (const ev of c.events) items = fold(items, ev);
      expect(items).toEqual(c.items);
    });
  }
});

describe("purity", () => {
  it("fold never mutates its input", () => {
    const ev1 = { seq: 1, type: "text", content: "a", ts: "" } as ChatEvent;
    const items1 = fold([], ev1);
    const snapshot = JSON.parse(JSON.stringify(items1));
    fold(items1, { seq: 2, type: "text", content: "b", ts: "" } as ChatEvent);
    expect(items1).toEqual(snapshot);
  });
});
