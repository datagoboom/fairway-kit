/** SQLite backend via better-sqlite3 (synchronous under the hood; wrapped in the
 * async Backend interface so Postgres/MySQL slot in behind the same surface). */

import Database from "better-sqlite3";
import type { Backend } from "../types.js";
import { schema } from "./schema.js";

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
    for (const stmt of schema({ idType: "TEXT", serial: "INTEGER PRIMARY KEY AUTOINCREMENT" }))
      this.conn.exec(stmt);
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
