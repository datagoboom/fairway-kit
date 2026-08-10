/** Attachment upload/serve/reference round-trip over the real HTTP handler. */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createAgentChat, type AgentChat, type Runner } from "../src/index.js";

let chat: AgentChat;
let server: http.Server;
let base: string;
let workdir: string;
let seenAttachments: unknown[] = [];

const captureRunner: Runner = async (ctx, emit) => {
  seenAttachments = ctx.attachments;
  await emit({ type: "text_block", content: "ok" });
  return { content: "ok" };
};

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "fairway-att-"));
  seenAttachments = [];
  chat = createAgentChat({
    dbPath: join(workdir, "chat.db"),
    attachmentsDir: join(workdir, "blobs"),
    runner: captureRunner,
  });
  await chat.start();
  server = await chat.listen(0);
  const { port } = server.address() as { port: number };
  base = `http://127.0.0.1:${port}/api/chat`;
});
afterEach(async () => {
  await new Promise((r) => server.close(r));
  await chat.close();
  await rm(workdir, { recursive: true, force: true });
});

async function newSession(): Promise<string> {
  const r = await fetch(base + "/sessions", { method: "POST" });
  return (await r.json()).session.id;
}

async function upload(sid: string, name: string, type: string, body: Uint8Array) {
  const form = new FormData();
  form.append("file", new Blob([body], { type }), name);
  return fetch(`${base}/sessions/${sid}/attachments`, { method: "POST", body: form });
}

describe("attachments", () => {
  it("uploads, references in send, exposes an absolute path to the runner", async () => {
    const sid = await newSession();
    const res = await upload(sid, "notes.txt", "text/plain", new TextEncoder().encode("hello"));
    expect(res.status).toBe(201);
    const att = await res.json();
    expect(att).toMatchObject({ name: "notes.txt", media_type: "text/plain", size: 5 });
    expect(att.id).toBeTruthy();

    const sent = await fetch(`${base}/sessions/${sid}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "see file", attachments: [{ id: att.id }] }),
    });
    expect(sent.status).toBe(202);
    // Let the runner (which captured ctx.attachments) run.
    const { job_id } = await sent.json();
    await pollJobDone(job_id);

    expect(seenAttachments).toHaveLength(1);
    const a = seenAttachments[0] as { id: string; name: string; path: string };
    expect(a.id).toBe(att.id);
    expect(a.name).toBe("notes.txt");
    expect(a.path).toMatch(/blobs\//); // absolute path under the attachments dir

    // The persisted user message keeps the public shape (no path leaked).
    const msgs = (await (await fetch(`${base}/sessions/${sid}/messages`)).json()).messages;
    const user = msgs.find((m: { role: string }) => m.role === "user");
    expect(user.attachments).toHaveLength(1);
    expect(user.attachments[0]).not.toHaveProperty("path");
    expect(user.attachments[0].id).toBe(att.id);
  });

  it("serves the file back with download + nosniff headers", async () => {
    const sid = await newSession();
    const att = await (await upload(sid, "d.txt", "text/plain", new TextEncoder().encode("payload"))).json();
    const res = await fetch(`${base}/attachments/${att.id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    expect(await res.text()).toBe("payload");
  });

  it("404s an unknown attachment and rejects a foreign-session reference", async () => {
    const sid = await newSession();
    const other = await newSession();
    const att = await (await upload(other, "x.txt", "text/plain", new TextEncoder().encode("x"))).json();
    expect((await fetch(`${base}/attachments/does-not-exist`)).status).toBe(404);
    const sent = await fetch(`${base}/sessions/${sid}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "x", attachments: [{ id: att.id }] }),
    });
    expect(sent.status).toBe(400);
  });

  it("400s uploads when attachments are disabled", async () => {
    const off = createAgentChat({
      dbPath: join(workdir, "off.db"),
      attachmentsDir: null,
      runner: captureRunner,
    });
    await off.start();
    const srv = await off.listen(0);
    const b = `http://127.0.0.1:${(srv.address() as { port: number }).port}/api/chat`;
    const sid = (await (await fetch(b + "/sessions", { method: "POST" })).json()).session.id;
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array([1])]), "f.bin");
    const res = await fetch(`${b}/sessions/${sid}/attachments`, { method: "POST", body: form });
    expect(res.status).toBe(400);
    await new Promise((r) => srv.close(r));
    await off.close();
  });
});

async function pollJobDone(jobId: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    const { terminal } = await (await fetch(`${base}/jobs/${jobId}/events`)).json();
    if (terminal) return;
    await new Promise((r) => setTimeout(r, 10));
  }
}
