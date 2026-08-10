/** Backend factory: build a Backend from a database URL or a bare SQLite path.
 *
 * - postgresql://user:pass@host:port/db  (or postgres://)  — needs `pg`
 * - mysql://user:pass@host:port/db                          — needs `mysql2`
 * - sqlite:///relative/or/abs/path.db  or a bare filesystem path (default)
 *
 * fairway is single-writer regardless of backend — the database is a storage
 * choice, not a way to run multiple processes.
 */

import type { Backend } from "../types.js";
import { SQLiteBackend } from "./sqlite.js";
import { PostgresBackend } from "./postgres.js";
import { MySQLBackend } from "./mysql.js";

export { SQLiteBackend } from "./sqlite.js";
export { PostgresBackend } from "./postgres.js";
export { MySQLBackend } from "./mysql.js";
export { schema } from "./schema.js";

export function backendFromUrl(urlOrPath: string): Backend {
  const scheme = urlOrPath.includes("://") ? urlOrPath.split("://", 1)[0].toLowerCase() : "";

  if (scheme === "postgresql" || scheme === "postgres") {
    // node-postgres accepts the postgres:// / postgresql:// DSN directly.
    return new PostgresBackend(urlOrPath);
  }

  if (scheme === "mysql") {
    const u = new URL(urlOrPath);
    return new MySQLBackend({
      host: u.hostname || "localhost",
      port: u.port ? Number(u.port) : 3306,
      user: decodeURIComponent(u.username) || "root",
      password: decodeURIComponent(u.password) || "",
      database: u.pathname.replace(/^\//, "") || "fairway",
    });
  }

  // Bare path or sqlite:// URL. Match SQLAlchemy's convention: after "sqlite://",
  // drop exactly one leading slash (the empty-host separator), so
  // sqlite:///rel.db -> rel.db and sqlite:////abs.db -> /abs.db.
  if (scheme === "sqlite") {
    const rest = urlOrPath.slice("sqlite://".length);
    const path = rest.startsWith("/") ? rest.slice(1) : rest;
    return new SQLiteBackend(path || ":memory:");
  }
  return new SQLiteBackend(urlOrPath);
}
