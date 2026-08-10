/** SQLite backend via better-sqlite3 (synchronous under the hood; wrapped in the
 * async Backend interface so Postgres/MySQL can slot in later, exactly like the
 * Python side). */

import Database from "better-sqlite3";
import type { Backend } from "../types.js";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS sessions (
     id TEXT PRIMARY KEY,
     name TEXT,
     provider_session_id TEXT,
     allowed_tools_json TEXT,
     created_at TEXT NOT NULL
   )`,
  // `ordinal` is the monotonic insertion order and the sole ORDER BY key:
  // `created_at` is millisecond-resolution, so a user row and its assistant
  // row can share a timestamp, and the id tiebreak is a random uuid. The
  // surrogate ordinal keeps replay order deterministic regardless of clock.
  `CREATE TABLE IF NOT EXISTS messages (
     ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
     id TEXT NOT NULL UNIQUE,
     session_id TEXT NOT NULL,
     role TEXT NOT NULL,
     content TEXT NOT NULL,
     events_json TEXT,
     streaming INTEGER NOT NULL DEFAULT 0,
     attachments_json TEXT,
     created_at TEXT NOT NULL,
     FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
   )`,
  `CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, ordinal)`,
  `CREATE TABLE IF NOT EXISTS jobs (
     id TEXT PRIMARY KEY,
     session_id TEXT NOT NULL,
     status TEXT NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
   )`,
  `CREATE INDEX IF NOT EXISTS idx_jobs_session ON jobs(session_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS attachments (
     id TEXT PRIMARY KEY,
     session_id TEXT NOT NULL,
     name TEXT NOT NULL,
     media_type TEXT NOT NULL,
     size INTEGER NOT NULL,
     path TEXT NOT NULL,
     created_at TEXT NOT NULL,
     FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
   )`,
  `CREATE TABLE IF NOT EXISTS job_events (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     job_id TEXT NOT NULL,
     seq INTEGER NOT NULL,
     event_json TEXT NOT NULL,
     created_at TEXT NOT NULL,
     UNIQUE (job_id, seq),
     FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
   )`,
];

export class SQLiteBackend implements Backend {
  readonly dialect = "sqlite";
  private db: Database.Database | null = null;

  constructor(private path: string) {}

  private get conn(): Database.Database {
    if (!this.db) throw new Error("backend not opened");
    return this.db;
  }

  async open(): Promise<void> {
    this.db = new Database(this.path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
  }

  async close(): Promise<void> {
    this.db?.close();
    this.db = null;
  }

  async ensureSchema(): Promise<void> {
    for (const stmt of SCHEMA) this.conn.exec(stmt);
    // Additive migration for databases created before allowed_tools_json.
    const cols = this.conn.prepare("PRAGMA table_info(sessions)").all() as { name: string }[];
    if (!cols.some((c) => c.name === "allowed_tools_json")) {
      this.conn.exec("ALTER TABLE sessions ADD COLUMN allowed_tools_json TEXT");
    }
  }

  async execute(sql: string, params: unknown[] = []): Promise<void> {
    this.conn.prepare(sql).run(...(params as never[]));
  }

  async fetchOne(sql: string, params: unknown[] = []): Promise<Record<string, unknown> | null> {
    const row = this.conn.prepare(sql).get(...(params as never[]));
    return (row as Record<string, unknown>) ?? null;
  }

  async fetchAll(sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
    return this.conn.prepare(sql).all(...(params as never[])) as Record<string, unknown>[];
  }
}

export function backendFromUrl(urlOrPath: string): Backend {
  const scheme = urlOrPath.includes("://") ? urlOrPath.split("://", 1)[0].toLowerCase() : "";
  if (scheme === "sqlite") {
    const rest = urlOrPath.slice("sqlite://".length);
    const path = rest.startsWith("/") ? rest.slice(1) : rest;
    return new SQLiteBackend(path || ":memory:");
  }
  if (scheme === "postgresql" || scheme === "postgres" || scheme === "mysql") {
    throw new Error(`${scheme} backend not implemented yet; use SQLite for now`);
  }
  return new SQLiteBackend(urlOrPath);
}
