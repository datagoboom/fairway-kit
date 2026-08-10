/** Thin REST client for the HTTP surface (PROTOCOL.md section 11). */

import type { ChatEvent } from "./events.js";

export interface Session {
  id: string;
  name: string | null;
  provider_session_id?: string | null;
  created_at: string;
}

export interface Message {
  id: string;
  session_id: string;
  role: "user" | "assistant";
  content: string;
  events: ChatEvent[] | null;
  streaming: boolean;
  attachments?: unknown[] | null;
  created_at: string;
}

export interface SendResult {
  job_id: string;
  user_message_id: string;
  assistant_message_id: string;
}

export class ConflictError extends Error {
  constructor(public activeJobId: string) {
    super(`session has a running job: ${activeJobId}`);
  }
}

export class AgentChatClient {
  private fetchFn: typeof fetch;

  constructor(
    /** e.g. "/api/chat" or "http://localhost:8000/api/chat" */
    public baseUrl: string,
    fetchFn?: typeof fetch
  ) {
    // Wrap rather than store bare: calling a stored `fetch` as `this.fetchFn(...)`
    // rebinds `this` to the client and throws "Illegal invocation" in browsers.
    this.fetchFn = fetchFn ?? ((...args) => fetch(...args));
  }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const resp = await this.fetchFn(`${this.baseUrl}${path}`, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (resp.status === 409) {
      const err = (await resp.json()) as { detail?: { active_job_id?: string } };
      throw new ConflictError(err.detail?.active_job_id ?? "");
    }
    if (!resp.ok) throw new Error(`${method} ${path}: HTTP ${resp.status}`);
    return resp.status === 204 ? (undefined as T) : ((await resp.json()) as T);
  }

  createSession(name?: string): Promise<{ session: Session }> {
    return this.req("POST", "/sessions", { name });
  }
  listSessions(): Promise<{ sessions: Session[] }> {
    return this.req("GET", "/sessions");
  }
  deleteSession(id: string): Promise<void> {
    return this.req("DELETE", `/sessions/${id}`);
  }
  listMessages(sessionId: string): Promise<{ messages: Message[] }> {
    return this.req("GET", `/sessions/${sessionId}/messages`);
  }
  activeJob(sessionId: string): Promise<{ job_id: string | null; status?: string }> {
    return this.req("GET", `/sessions/${sessionId}/active-job`);
  }
  send(sessionId: string, content: string, attachments?: unknown[]): Promise<SendResult> {
    return this.req("POST", `/sessions/${sessionId}/send`, { content, attachments });
  }
  stop(jobId: string): Promise<{ status: string }> {
    return this.req("POST", `/jobs/${jobId}/stop`);
  }
  events(jobId: string, since = 0): Promise<{ events: ChatEvent[]; terminal: boolean }> {
    return this.req("GET", `/jobs/${jobId}/events?since=${since}`);
  }
}
