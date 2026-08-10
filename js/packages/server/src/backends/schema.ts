/** Shared logical schema (PROTOCOL.md 12). The tables are identical across
 * dialects; only the key-column type, the autoincrement clause, and the
 * timestamp type differ, so each backend substitutes them below.
 *
 * `messages.ordinal` is a monotonic surrogate and the sole message ORDER BY key:
 * created_at is millisecond-resolution, so a user row and its assistant row can
 * share a timestamp and the random-uuid id makes the tiebreak non-deterministic.
 * The ordinal keeps replay order stable regardless of clock.
 *
 * JSON columns are TEXT-family everywhere (no native JSON type is needed — the
 * store serializes with JSON.stringify). Key columns must be bounded VARCHAR on
 * MySQL (TEXT is not indexable without a prefix length), so `idType` varies.
 */
export function schema(opts: {
  /** Type for uuid/key columns (TEXT, or VARCHAR(64) on MySQL). */
  idType: string;
  /** Autoincrement PK clause for job_events.id and messages.ordinal. */
  serial: string;
  /** Type for ISO-timestamp columns (bounded on MySQL since some are indexed). */
  tsType?: string;
  /** Optional table suffix (e.g. " ENGINE=InnoDB"). */
  engine?: string;
}): string[] {
  const t = opts.idType;
  const serial = opts.serial;
  const ts = opts.tsType ?? "TEXT";
  const engine = opts.engine ?? "";
  const blob = engine ? "LONGTEXT" : "TEXT"; // big JSON blobs: LONGTEXT on MySQL
  // Foreign keys are table-level constraints, never inline REFERENCES: MySQL
  // silently ignores the inline column-level form, so the cascade is never made.
  const fk = "FOREIGN KEY";
  return [
    `CREATE TABLE IF NOT EXISTS sessions (
       id ${t} PRIMARY KEY,
       name TEXT,
       provider_session_id TEXT,
       allowed_tools_json TEXT,
       created_at ${ts} NOT NULL
     )${engine}`,
    `CREATE TABLE IF NOT EXISTS messages (
       ordinal ${serial},
       id ${t} NOT NULL UNIQUE,
       session_id ${t} NOT NULL,
       role TEXT NOT NULL,
       content ${blob} NOT NULL,
       events_json ${blob},
       streaming INTEGER NOT NULL DEFAULT 0,
       attachments_json ${blob},
       created_at ${ts} NOT NULL,
       ${fk} (session_id) REFERENCES sessions(id) ON DELETE CASCADE
     )${engine}`,
    `CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, ordinal)`,
    `CREATE TABLE IF NOT EXISTS jobs (
       id ${t} PRIMARY KEY,
       session_id ${t} NOT NULL,
       status TEXT NOT NULL,
       created_at ${ts} NOT NULL,
       updated_at ${ts} NOT NULL,
       ${fk} (session_id) REFERENCES sessions(id) ON DELETE CASCADE
     )${engine}`,
    `CREATE INDEX IF NOT EXISTS idx_jobs_session ON jobs(session_id, created_at)`,
    `CREATE TABLE IF NOT EXISTS attachments (
       id ${t} PRIMARY KEY,
       session_id ${t} NOT NULL,
       name TEXT NOT NULL,
       media_type TEXT NOT NULL,
       size INTEGER NOT NULL,
       path TEXT NOT NULL,
       created_at ${ts} NOT NULL,
       ${fk} (session_id) REFERENCES sessions(id) ON DELETE CASCADE
     )${engine}`,
    `CREATE TABLE IF NOT EXISTS job_events (
       id ${serial},
       job_id ${t} NOT NULL,
       seq INTEGER NOT NULL,
       event_json ${blob} NOT NULL,
       created_at ${ts} NOT NULL,
       UNIQUE (job_id, seq),
       ${fk} (job_id) REFERENCES jobs(id) ON DELETE CASCADE
     )${engine}`,
  ];
}
