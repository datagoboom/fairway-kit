/** Core interfaces: the storage backend and the runner an app supplies. */

import type { EmitEvent } from "./events.js";

/** A stamped event (seq + ts added by the store). */
export type StampedEvent = EmitEvent & { seq: number; ts: string };

/** emit(event) -> stamped event. Await it: the event is durable when it returns. */
export type Emit = (ev: EmitEvent) => Promise<StampedEvent>;

export interface Message {
  id: string;
  session_id: string;
  role: "user" | "assistant";
  content: string;
  events: StampedEvent[] | null;
  streaming: boolean;
  attachments?: unknown[] | null;
  created_at: string;
}

/** What the runner produces. The registry finalizes the assistant row from this
 * BEFORE emitting the terminal event (PROTOCOL.md 7). */
export interface TurnResult {
  content: string;
  reason?: string;
}

export interface TurnContext {
  session: Record<string, unknown>;
  /** Persisted history (oldest first), excluding the new user/assistant pair. */
  messages: Message[];
  userContent: string;
  userMessageId: string;
  assistantMessageId: string;
  jobId: string;
  attachments: unknown[];
  /** Aborts when the turn is stopped; a cooperative runner should check it. */
  signal: AbortSignal;
  providerSessionId?: string | null;
  /** Set by the runner when the provider hands back a resume token. */
  newProviderSessionId?: string | null;
  /** Registry-provided interrupt hook (e.g. an SDK client's interrupt). */
  gracefulStop?: () => Promise<void>;
}

export type Runner = (ctx: TurnContext, emit: Emit) => Promise<TurnResult>;

/** Storage backend. The store writes SQL with "?" placeholders; the backend
 * adapts placeholders/rows per dialect. Async so networked backends fit later;
 * SQLite resolves immediately. */
export interface Backend {
  readonly dialect: string;
  open(): Promise<void>;
  close(): Promise<void>;
  ensureSchema(): Promise<void>;
  execute(sql: string, params?: unknown[]): Promise<void>;
  fetchOne(sql: string, params?: unknown[]): Promise<Record<string, unknown> | null>;
  fetchAll(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
}

/** Minimal FIFO async mutex — serializes the seq-critical section and the
 * allow-tool read-modify-write, exactly like the Python asyncio.Lock. */
export class Mutex {
  private tail: Promise<void> = Promise.resolve();
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((r) => (release = r));
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
