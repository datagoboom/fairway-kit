/** Thin REST client for the HTTP surface (PROTOCOL.md section 11). */

import { PROTOCOL_VERSION, type ChatEvent, type PermissionDecision } from "@fairway-kit/protocol";

export interface Session {
  id: string;
  name: string | null;
  provider_session_id?: string | null;
  created_at: string;
}

export interface Attachment {
  id: string;
  name: string;
  media_type: string;
  size: number;
}

export interface Message {
  id: string;
  session_id: string;
  role: "user" | "assistant";
  content: string;
  events: ChatEvent[] | null;
  streaming: boolean;
  attachments?: Attachment[] | null;
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

/** Compare client vs server protocol versions ("MAJOR.MINOR"). Returns a
 * human-readable warning, or null when compatible. Additive-only rule from
 * PROTOCOL.md 14: same major = compatible (unknown event types are opaque),
 * but a version skew is still worth surfacing once. */
export function protocolWarning(clientVersion: string, serverVersion: string): string | null {
  if (clientVersion === serverVersion) return null;
  const [cMaj] = clientVersion.split(".");
  const [sMaj] = serverVersion.split(".");
  if (cMaj !== sMaj) {
    return (
      `fairway protocol MAJOR version mismatch: client speaks ${clientVersion}, ` +
      `server speaks ${serverVersion}. Expect breakage - upgrade the older side.`
    );
  }
  return (
    `fairway protocol version skew: client ${clientVersion}, server ${serverVersion}. ` +
    `Same major, so this should work (unknown events render as opaque), but ` +
    `consider upgrading the older side.`
  );
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
  renameSession(id: string, name: string): Promise<{ session: Session }> {
    return this.req("PATCH", `/sessions/${id}`, { name });
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
  send(sessionId: string, content: string, attachments?: Attachment[]): Promise<SendResult> {
    return this.req("POST", `/sessions/${sessionId}/send`, { content, attachments });
  }
  async uploadAttachment(sessionId: string, file: File | Blob): Promise<Attachment> {
    const form = new FormData();
    form.append("file", file);
    const resp = await this.fetchFn(`${this.baseUrl}/sessions/${sessionId}/attachments`, {
      method: "POST",
      body: form,
    });
    if (!resp.ok) throw new Error(`upload failed: HTTP ${resp.status}`);
    return (await resp.json()) as Attachment;
  }
  /** URL for displaying/downloading an uploaded attachment. */
  attachmentUrl(attachmentId: string): string {
    return `${this.baseUrl}/attachments/${attachmentId}`;
  }
  stop(jobId: string): Promise<{ status: string }> {
    return this.req("POST", `/jobs/${jobId}/stop`);
  }
  meta(): Promise<{ protocol_version: string; extensions: string[] }> {
    return this.req("GET", "/meta");
  }

  private protocolChecked = false;

  /** Fetch server /meta once and compare protocol versions. Returns the
   * warning (also on subsequent calls' first-result basis), or null when
   * compatible or unreachable. Never throws. */
  async checkProtocol(): Promise<string | null> {
    if (this.protocolChecked) return null;
    this.protocolChecked = true;
    try {
      const { protocol_version } = await this.meta();
      return protocolWarning(PROTOCOL_VERSION, protocol_version);
    } catch {
      return null; // meta unreachable - real requests will surface the error
    }
  }

  resolvePermission(
    jobId: string,
    requestId: string,
    decision: PermissionDecision
  ): Promise<{ status: string }> {
    return this.req("POST", `/jobs/${jobId}/permission`, {
      request_id: requestId,
      decision,
    });
  }
  events(jobId: string, since = 0): Promise<{ events: ChatEvent[]; terminal: boolean }> {
    return this.req("GET", `/jobs/${jobId}/events?since=${since}`);
  }
}
