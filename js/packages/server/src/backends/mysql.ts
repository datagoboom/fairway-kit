/** MySQL backend via `mysql2` (an optional dependency - installed only when you
 * use a mysql:// URL). mysql2 uses `?` placeholders natively, so no rewrite is
 * needed. autocommit is on by default, matching the single-statement write
 * model (no cross-statement transactions under single-writer). */

import type { Backend } from "../types.js";
import { schema } from "./schema.js";

interface Pool {
  query: (sql: string, params?: unknown[]) => Promise<[unknown, unknown]>;
  end: () => Promise<void>;
}

export interface MySQLConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

export class MySQLBackend implements Backend {
  readonly dialect = "mysql";
  private pool: Pool | null = null;

  constructor(private cfg: MySQLConfig) {}

  private get p(): Pool {
    if (!this.pool) throw new Error("backend not opened");
    return this.pool;
  }

  async open(): Promise<void> {
    // Variable specifier so tsc doesn't require `mysql2` to build: it's an
    // optional dependency, installed only when a mysql:// URL is used.
    const spec = "mysql2/promise";
    let mysql: { createPool: (cfg: unknown) => Pool; default?: { createPool: (cfg: unknown) => Pool } };
    try {
      mysql = await import(spec);
    } catch {
      throw new Error('MySQL backend needs the "mysql2" package: npm install mysql2');
    }
    this.pool = (mysql.default ?? mysql).createPool({
      ...this.cfg,
      waitForConnections: true,
      connectionLimit: 8,
      // dates/decimals come back as strings so ISO timestamps round-trip verbatim.
      dateStrings: true,
    });
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }

  async ensureSchema(): Promise<void> {
    // Key columns are VARCHAR (TEXT can't be indexed without a prefix length);
    // "IF NOT EXISTS" on CREATE INDEX is unsupported, so guard it explicitly.
    const stmts = schema({
      idType: "VARCHAR(64)",
      serial: "BIGINT AUTO_INCREMENT PRIMARY KEY",
      tsType: "VARCHAR(40)", // ISO-8601 UTC is ~32 chars; indexed, so bounded
      engine: " ENGINE=InnoDB",
    });
    for (const stmt of stmts) {
      if (/^\s*CREATE INDEX/i.test(stmt)) await this.ensureIndex(stmt);
      else await this.p.query(stmt);
    }
  }

  private async ensureIndex(createIndexSql: string): Promise<void> {
    const m = /CREATE INDEX IF NOT EXISTS (\w+) ON (\w+)/i.exec(createIndexSql.trim());
    if (!m) throw new Error(`unparseable index DDL: ${createIndexSql}`);
    const [, name, table] = m;
    const [rows] = await this.p.query(
      "SELECT COUNT(*) AS n FROM information_schema.statistics " +
        "WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?",
      [table, name],
    );
    const n = Number((rows as { n: number }[])[0]?.n ?? 0);
    if (n === 0) await this.p.query(createIndexSql.replace(/IF NOT EXISTS /i, ""));
  }

  async execute(sql: string, params: unknown[] = []): Promise<void> {
    await this.p.query(sql, params);
  }

  async fetchOne(sql: string, params: unknown[] = []): Promise<Record<string, unknown> | null> {
    const [rows] = await this.p.query(sql, params);
    return (rows as Record<string, unknown>[])[0] ?? null;
  }

  async fetchAll(sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
    const [rows] = await this.p.query(sql, params);
    return rows as Record<string, unknown>[];
  }
}
