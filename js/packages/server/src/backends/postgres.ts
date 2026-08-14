/** Postgres backend via `pg` (an optional dependency - installed only when you
 * use a postgres:// URL). Reads run against a small pool; the seq-critical
 * section stays serialized by Store's mutex, so single-statement autocommit
 * writes are enough (no cross-statement transactions under single-writer). */

import type { Backend } from "../types.js";
import { schema } from "./schema.js";

/** Rewrite `?` placeholders to `$1, $2, ...` (our SQL never contains a literal
 * `?` inside a string literal, so a positional count is safe). */
function toPg(sql: string): string {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
}

export class PostgresBackend implements Backend {
  readonly dialect = "postgres";
  private pool: { query: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>; end: () => Promise<void> } | null = null;

  constructor(private dsn: string) {}

  private get p() {
    if (!this.pool) throw new Error("backend not opened");
    return this.pool;
  }

  async open(): Promise<void> {
    // Variable specifier so tsc doesn't require `pg` to be installed to build:
    // it's an optional dependency, installed only when a postgres:// URL is used.
    const spec = "pg";
    let pg: { Pool: new (cfg: unknown) => unknown; default?: { Pool: new (cfg: unknown) => unknown } };
    try {
      pg = await import(spec);
    } catch {
      throw new Error('Postgres backend needs the "pg" package: npm install pg');
    }
    const Pool = (pg.default ?? pg).Pool;
    this.pool = new Pool({ connectionString: this.dsn, min: 1, max: 8 }) as never;
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }

  async ensureSchema(): Promise<void> {
    // Fresh databases only: there is no legacy pre-allowed_tools_json Postgres db.
    for (const stmt of schema({ idType: "TEXT", serial: "BIGSERIAL PRIMARY KEY" }))
      await this.p.query(stmt);
  }

  async execute(sql: string, params: unknown[] = []): Promise<void> {
    await this.p.query(toPg(sql), params);
  }

  async fetchOne(sql: string, params: unknown[] = []): Promise<Record<string, unknown> | null> {
    const { rows } = await this.p.query(toPg(sql), params);
    return rows[0] ?? null;
  }

  async fetchAll(sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
    const { rows } = await this.p.query(toPg(sql), params);
    return rows;
  }
}
