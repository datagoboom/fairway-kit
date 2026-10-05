/** End-to-end protocol flow over the real node:http server + EchoRunner,
 * mirroring the Python test_protocol_flow: send ordering, SSE replay-then-tail,
 * ?since= resume, active-job reattach, done carries message_id, 409 on
 * concurrent send, replay==live (fold), and the restart sweep. */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { foldAll } from "@fairway-kit/protocol";
import { createAgentChat, EchoRunner, type AgentChat } from "../src/index.js";

let chat: AgentChat;
let server: http.Server;
let base: string;
let dbPath: string;

async function boot() {
  chat = createAgentChat({ dbPath, runner: EchoRunner });
  await chat.start();
  server = await chat.listen(0);
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  base = `http://127.0.0.1:${port}/api/chat`;
}

beforeEach(async () => {
  dbPath = join(tmpdir(), `fairway-${randomUUID()}.db`);
  await boot();
});
afterEach(async () => {
  await new Promise((r) => server.close(r));
  await chat.close();
});

const post = (p: string, body?: unknown) =>
  fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
const get = (p: string) => fetch(base + p);

async function readSse(jobId: string, since = 0): Promise<Record<string, unknown>[]> {
  const res = await fetch(`${base}/jobs/${jobId}/stream?since=${since}`);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const events: Record<string, unknown>[] = [];
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (frame.startsWith("data:")) {
        const ev = JSON.parse(frame.slice(5).trim());
        events.push(ev);
        if (["done", "error", "cancelled"].includes(ev.type)) {
          void reader.cancel();
          return events;
        }
      }
    }
  }
  return events;
}

async function newSession(): Promise<string> {
  return (await (await post("/sessions", {})).json()).session.id;
}

describe("protocol flow", () => {
  it("meta reports the protocol version", async () => {
    const meta = await (await get("/meta")).json();
    expect(meta.protocol_version).toMatch(/^\d+\.\d+$/);
  });

  it("rename: PATCH updates the name, 404 on unknown session", async () => {
    const sid = await newSession();
    const patch = (p: string, body: unknown) =>
      fetch(base + p, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const renamed = await patch(`/sessions/${sid}`, { name: "ops log" });
    expect(renamed.status).toBe(200);
    expect((await renamed.json()).session.name).toBe("ops log");
    const list = (await (await get("/sessions")).json()).sessions;
    expect(list.find((s: { id: string }) => s.id === sid)?.name).toBe("ops log");
    expect((await patch("/sessions/nope", { name: "x" })).status).toBe(404);
  });

  it("full turn: ordered events, done carries message_id, message readable immediately", async () => {
    const sid = await newSession();
    const sent = await post(`/sessions/${sid}/send`, { content: "hello world" });
    expect(sent.status).toBe(202);
    const { job_id, assistant_message_id } = await sent.json();

    const events = await readSse(job_id);
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("message_start");
    expect(types.at(-1)).toBe("done");
    expect(events.at(-1)!.message_id).toBe(assistant_message_id);
    const seqs = events.map((e) => e.seq as number);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);

    const msgs = (await (await get(`/sessions/${sid}/messages`)).json()).messages;
    expect(msgs.map((m: { role: string }) => m.role)).toEqual(["user", "assistant"]);
    expect(msgs[1].content).toBe("You said: hello world");
    expect(msgs[1].events).toBeTruthy();
  });

  it("replay folds identically to live; ?since= returns only the tail", async () => {
    const sid = await newSession();
    const { job_id } = await (await post(`/sessions/${sid}/send`, { content: "x" })).json();
    const live = await readSse(job_id);
    const replay = await readSse(job_id); // terminal -> compacted DB replay
    expect(foldAll(live as never)).toEqual(foldAll(replay as never));
    const mid = live[Math.floor(live.length / 2)].seq as number;
    const tail = await readSse(job_id, mid);
    expect(tail.every((e) => (e.seq as number) > mid)).toBe(true);
    expect(tail.at(-1)!.type).toBe("done");
  });

  it("409 on concurrent send carries active_job_id", async () => {
    const slow = createAgentChat({
      dbPath: join(tmpdir(), `fairway-${randomUUID()}.db`),
      runner: async (ctx, emit) => {
        await new Promise((r) => setTimeout(r, 150));
        return EchoRunner(ctx, emit);
      },
    });
    await slow.start();
    const srv = await slow.listen(0);
    const p = (srv.address() as { port: number }).port;
    const b = `http://127.0.0.1:${p}/api/chat`;
    const sid = (await (await fetch(b + "/sessions", { method: "POST" })).json()).session.id;
    const first = await (await fetch(`${b}/sessions/${sid}/send`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: "a" }) })).json();
    const second = await fetch(`${b}/sessions/${sid}/send`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: "b" }) });
    expect(second.status).toBe(409);
    expect((await second.json()).error.active_job_id).toBe(first.job_id);
    await new Promise((r) => srv.close(r));
    await slow.close();
  });

  it("active-job is null before and after a turn", async () => {
    const sid = await newSession();
    expect((await (await get(`/sessions/${sid}/active-job`)).json()).job_id).toBeNull();
    const { job_id } = await (await post(`/sessions/${sid}/send`, { content: "x" })).json();
    await readSse(job_id);
    expect((await (await get(`/sessions/${sid}/active-job`)).json()).job_id).toBeNull();
  });

  it("restart sweep terminates an orphaned running job", async () => {
    const sid = await newSession();
    // Manually create an orphaned running job with a stub message_start, no terminal.
    const jobId = await chat.store.createJob(sid);
    const mid = await chat.store.addMessage(sid, "assistant", "", { streaming: true });
    await chat.store.appendEvent(jobId, { type: "message_start", message_id: mid });
    // Re-run the sweep (as a restart would).
    await chat.registry.startupSweep();
    const job = await chat.store.getJob(jobId);
    expect(job!.status).toBe("error");
    const evs = await chat.store.getEvents(jobId);
    expect(evs.at(-1)!.type).toBe("error");
  });
});
