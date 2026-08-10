/** Backend conformance: the same Store-level behaviors must hold on every
 * dialect. SQLite always runs; Postgres/MySQL run when FAIRWAY_TEST_POSTGRES_URL
 * / FAIRWAY_TEST_MYSQL_URL are set (CI provides them; local runs are SQLite-only,
 * so this needs no services by default). */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../src/index.js";
import { backendFromUrl } from "../src/backends/index.js";

interface Case {
  name: string;
  makeUrl: () => string;
}

const cases: Case[] = [
  { name: "sqlite", makeUrl: () => join(tmpdir(), `fairway-be-${randomUUID()}.db`) },
];
if (process.env.FAIRWAY_TEST_POSTGRES_URL)
  cases.push({ name: "postgres", makeUrl: () => process.env.FAIRWAY_TEST_POSTGRES_URL! });
if (process.env.FAIRWAY_TEST_MYSQL_URL)
  cases.push({ name: "mysql", makeUrl: () => process.env.FAIRWAY_TEST_MYSQL_URL! });

for (const c of cases) {
  describe(`backend: ${c.name}`, () => {
    let store: Store;

    beforeAll(async () => {
      store = new Store(backendFromUrl(c.makeUrl()));
      await store.open();
      // Networked backends are shared across runs; start from a clean slate.
      if (c.name !== "sqlite") {
        for (const t of ["job_events", "attachments", "messages", "jobs", "sessions"])
          await store.backend.execute(`DELETE FROM ${t}`).catch(() => {});
      }
    });
    afterAll(async () => {
      if (store) await store.close();
    });

    it("round-trips a session and lists it", async () => {
      const s = await store.createSession("hello");
      expect(s.name).toBe("hello");
      const got = await store.getSession(s.id as string);
      expect(got?.id).toBe(s.id);
      const all = await store.listSessions();
      expect(all.some((x) => x.id === s.id)).toBe(true);
    });

    it("orders messages by insertion even when timestamps collide", async () => {
      const s = await store.createSession();
      const sid = s.id as string;
      // Insert user then assistant back-to-back (same millisecond) and confirm order.
      const uid = await store.addMessage(sid, "user", "q");
      const aid = await store.addMessage(sid, "assistant", "a");
      const msgs = await store.listMessages(sid);
      expect(msgs.map((m) => m.id)).toEqual([uid, aid]);
      expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]);
    });

    it("assigns monotonic per-job seq and reads events back in order", async () => {
      const s = await store.createSession();
      const jobId = await store.createJob(s.id as string);
      const a = await store.appendEvent(jobId, { type: "message_start", message_id: "m" });
      const b = await store.appendEvent(jobId, { type: "text", content: "x" });
      const cc = await store.appendEvent(jobId, { type: "text_block", content: "x" });
      expect([a.seq, b.seq, cc.seq]).toEqual([1, 2, 3]);
      const evs = await store.getEvents(jobId);
      expect(evs.map((e) => e.seq)).toEqual([1, 2, 3]);
      const tail = await store.getEvents(jobId, 1);
      expect(tail.map((e) => e.seq)).toEqual([2, 3]);
    });

    it("deletes events by seq (compaction) without disturbing the rest", async () => {
      const s = await store.createSession();
      const jobId = await store.createJob(s.id as string);
      for (let i = 0; i < 4; i++) await store.appendEvent(jobId, { type: "text", content: `${i}` });
      await store.deleteEventsBySeq(jobId, [2, 3]);
      const evs = await store.getEvents(jobId);
      expect(evs.map((e) => e.seq)).toEqual([1, 4]);
    });

    it("remembers allowed tools across the read-modify-write lock", async () => {
      const s = await store.createSession();
      const sid = s.id as string;
      await Promise.all([store.addAllowedTool(sid, "Read"), store.addAllowedTool(sid, "Bash")]);
      const tools = await store.getAllowedTools(sid);
      expect([...tools].sort()).toEqual(["Bash", "Read"]);
    });

    it("cascades job/message/attachment deletes when a session is removed", async () => {
      const s = await store.createSession();
      const sid = s.id as string;
      const jobId = await store.createJob(sid);
      await store.appendEvent(jobId, { type: "text", content: "x" });
      await store.addAttachment(sid, "f", "text/plain", 1, "blob");
      await store.deleteSession(sid);
      expect(await store.getJob(jobId)).toBeNull();
      expect(await store.getEvents(jobId)).toHaveLength(0);
      expect(await store.listMessages(sid)).toHaveLength(0);
    });
  });
}
