/** Storage-side types. The Runner contract (TurnContext, Emit, Runner, ...) and
 * the event constructors live in @fairway-kit/agent - the server consumes a
 * Runner, it doesn't define how one is built. This module is just the backend
 * driver interface and the seq mutex. */

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

/** Minimal FIFO async mutex - serializes the seq-critical section and the
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
