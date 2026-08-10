/** Persistence over a swappable Backend (PROTOCOL.md 7, 12).
 *
 * Single-writer: the seq assignment and allow-tool read-modify-write are
 * serialized by a mutex; every other write is a single atomic statement. */

import { randomUUID } from "node:crypto";
import { foldAll, type StreamItem } from "@fairway-kit/protocol";
import { backendFromUrl } from "./backends/index.js";
import { Mutex, type Backend, type Message, type StampedEvent } from "./types.js";

const now = () => new Date().toISOString();
const newId = () => randomUUID().replace(/-/g, "");

/** Derive a message's plain content from its events (closed text runs). */
export function finalText(events: StampedEvent[]): string {
  const parts: string[] = [];
  for (const item of foldAll(events) as StreamItem[]) {
    if (item.type === "text" && item.content) parts.push(item.content);
  }
  return parts.join("\n\n");
}

export class Store {
  backend: Backend;
  private lock = new Mutex();

  constructor(backend: Backend | string) {
    this.backend = typeof backend === "string" ? backendFromUrl(backend) : backend;
  }

  async open(): Promise<void> {
    await this.backend.open();
    await this.backend.ensureSchema();
  }
  async close(): Promise<void> {
    await this.backend.close();
  }

  // -- sessions ------------------------------------------------------------

  async createSession(name?: string | null): Promise<Record<string, unknown>> {
    const id = newId();
    await this.backend.execute(
      "INSERT INTO sessions (id, name, created_at) VALUES (?, ?, ?)",
      [id, name ?? null, now()],
    );
    return (await this.getSession(id))!;
  }
  getSession(id: string) {
    return this.backend.fetchOne("SELECT * FROM sessions WHERE id = ?", [id]);
  }
  listSessions() {
    return this.backend.fetchAll("SELECT * FROM sessions ORDER BY created_at DESC");
  }
  async deleteSession(id: string): Promise<void> {
    await this.backend.execute("DELETE FROM sessions WHERE id = ?", [id]);
  }
  async setProviderSessionId(id: string, providerSessionId: string): Promise<void> {
    await this.backend.execute("UPDATE sessions SET provider_session_id = ? WHERE id = ?", [
      providerSessionId,
      id,
    ]);
  }
  async getAllowedTools(id: string): Promise<Set<string>> {
    const row = await this.backend.fetchOne("SELECT allowed_tools_json FROM sessions WHERE id = ?", [id]);
    const raw = row?.allowed_tools_json as string | undefined;
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  }
  async addAllowedTool(id: string, tool: string): Promise<void> {
    await this.lock.run(async () => {
      const tools = await this.getAllowedTools(id);
      tools.add(tool);
      await this.backend.execute("UPDATE sessions SET allowed_tools_json = ? WHERE id = ?", [
        JSON.stringify([...tools].sort()),
        id,
      ]);
    });
  }

  // -- messages ------------------------------------------------------------

  async addMessage(
    sessionId: string,
    role: string,
    content = "",
    opts: { streaming?: boolean; attachments?: unknown[] | null } = {},
  ): Promise<string> {
    const id = newId();
    await this.backend.execute(
      "INSERT INTO messages (id, session_id, role, content, streaming, attachments_json, created_at)" +
        " VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        id,
        sessionId,
        role,
        content,
        opts.streaming ? 1 : 0,
        opts.attachments ? JSON.stringify(opts.attachments) : null,
        now(),
      ],
    );
    return id;
  }
  async flushAssistant(messageId: string, content: string, events: StampedEvent[]): Promise<void> {
    await this.backend.execute("UPDATE messages SET content = ?, events_json = ? WHERE id = ?", [
      content,
      JSON.stringify(events),
      messageId,
    ]);
  }
  async finalizeAssistant(messageId: string, content: string, events: StampedEvent[]): Promise<void> {
    await this.backend.execute(
      "UPDATE messages SET content = ?, events_json = ?, streaming = 0 WHERE id = ?",
      [content, JSON.stringify(events), messageId],
    );
  }
  async deleteMessage(messageId: string): Promise<void> {
    await this.backend.execute("DELETE FROM messages WHERE id = ?", [messageId]);
  }
  async listMessages(sessionId: string, opts: { includeStreaming?: boolean; limit?: number } = {}): Promise<Message[]> {
    let q = "SELECT * FROM messages WHERE session_id = ?";
    if (!opts.includeStreaming) q += " AND streaming = 0";
    q += " ORDER BY ordinal LIMIT ?";
    const rows = await this.backend.fetchAll(q, [sessionId, opts.limit ?? 200]);
    return rows.map((r) => this.hydrateMessage(r));
  }
  async getMessage(messageId: string): Promise<Message | null> {
    const r = await this.backend.fetchOne("SELECT * FROM messages WHERE id = ?", [messageId]);
    return r ? this.hydrateMessage(r) : null;
  }
  private hydrateMessage(r: Record<string, unknown>): Message {
    const events = r.events_json ? (JSON.parse(r.events_json as string) as StampedEvent[]) : null;
    const attachments = r.attachments_json ? (JSON.parse(r.attachments_json as string) as unknown[]) : null;
    return {
      id: r.id as string,
      session_id: r.session_id as string,
      role: r.role as "user" | "assistant",
      content: r.content as string,
      events,
      attachments,
      streaming: !!r.streaming,
      created_at: r.created_at as string,
    };
  }

  // -- attachments ---------------------------------------------------------

  async addAttachment(sessionId: string, name: string, mediaType: string, size: number, path: string) {
    const id = newId();
    await this.backend.execute(
      "INSERT INTO attachments (id, session_id, name, media_type, size, path, created_at)" +
        " VALUES (?, ?, ?, ?, ?, ?, ?)",
      [id, sessionId, name, mediaType, size, path, now()],
    );
    return { id, name, media_type: mediaType, size };
  }
  getAttachment(id: string) {
    return this.backend.fetchOne("SELECT * FROM attachments WHERE id = ?", [id]);
  }

  // -- jobs ----------------------------------------------------------------

  async createJob(sessionId: string): Promise<string> {
    const id = newId();
    const t = now();
    await this.backend.execute(
      "INSERT INTO jobs (id, session_id, status, created_at, updated_at) VALUES (?, ?, 'running', ?, ?)",
      [id, sessionId, t, t],
    );
    return id;
  }
  async setJobStatus(jobId: string, status: string): Promise<void> {
    await this.backend.execute("UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?", [status, now(), jobId]);
  }
  getJob(jobId: string) {
    return this.backend.fetchOne("SELECT * FROM jobs WHERE id = ?", [jobId]);
  }
  activeJobForSession(sessionId: string) {
    return this.backend.fetchOne(
      "SELECT * FROM jobs WHERE session_id = ? AND status = 'running' ORDER BY created_at DESC LIMIT 1",
      [sessionId],
    );
  }
  orphanedRunningJobs() {
    return this.backend.fetchAll("SELECT * FROM jobs WHERE status = 'running'");
  }

  // -- event log -----------------------------------------------------------

  async appendEvent(jobId: string, event: Record<string, unknown>): Promise<StampedEvent> {
    // The seq-critical section: SELECT MAX(seq)+1 -> INSERT, serialized by the
    // mutex (single-writer); UNIQUE(job_id, seq) is the backstop.
    return this.lock.run(async () => {
      const row = await this.backend.fetchOne(
        "SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM job_events WHERE job_id = ?",
        [jobId],
      );
      const seq = (row?.next_seq as number) ?? 1;
      const stamped = { ...event, seq, ts: now() } as StampedEvent;
      await this.backend.execute(
        "INSERT INTO job_events (job_id, seq, event_json, created_at) VALUES (?, ?, ?, ?)",
        [jobId, seq, JSON.stringify(stamped), stamped.ts],
      );
      return stamped;
    });
  }
  async getEvents(jobId: string, since = 0): Promise<StampedEvent[]> {
    const rows = await this.backend.fetchAll(
      "SELECT event_json FROM job_events WHERE job_id = ? AND seq > ? ORDER BY seq",
      [jobId, since],
    );
    return rows.map((r) => JSON.parse(r.event_json as string) as StampedEvent);
  }
  async deleteEventsBySeq(jobId: string, seqs: number[]): Promise<void> {
    if (!seqs.length) return;
    const marks = seqs.map(() => "?").join(",");
    await this.backend.execute(`DELETE FROM job_events WHERE job_id = ? AND seq IN (${marks})`, [jobId, ...seqs]);
  }
  async pruneTerminalEventLogs(olderThanDays: number): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanDays * 86_400_000).toISOString();
    const jobRows = await this.backend.fetchAll(
      "SELECT id FROM jobs WHERE status != 'running' AND updated_at < ?",
      [cutoff],
    );
    const jobIds = jobRows.map((r) => r.id as string);
    if (jobIds.length) {
      const marks = jobIds.map(() => "?").join(",");
      await this.backend.execute(`DELETE FROM job_events WHERE job_id IN (${marks})`, jobIds);
    }
    return jobIds.length;
  }
}
