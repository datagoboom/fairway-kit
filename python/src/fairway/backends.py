"""Storage backends (PROTOCOL.md section 12).

fairway is single-writer by design: one process, one logical writer serialized
by Store's asyncio write-lock. The database is swappable storage underneath.
This is a storage choice, not a scaling story — running fairway across multiple
processes is out of scope regardless of backend (the live job registry, SSE
fan-out, and permission-gate futures all live in process memory).

A backend normalizes the four things that actually diverge by dialect:
parameter placeholders (the store writes ``?`` everywhere), schema DDL, schema
introspection for the additive migration, and connection/pool setup. Reads run
concurrently against a small pool; the seq-critical section stays serialized by
Store's write-lock, so single-statement autocommit writes are enough — no
cross-statement transactions are required under single-writer.

Backends:
    sqlite  (default, zero extra deps) — aiosqlite, one connection
    postgres (``pip install "fairway-kit[postgres]"``) — asyncpg pool
    mysql    (``pip install "fairway-kit[mysql]"``)    — aiomysql pool
"""

from __future__ import annotations

import re
from typing import Any, Protocol, Sequence
from urllib.parse import unquote, urlparse

# JSON blob columns are TEXT-family across all three dialects for uniformity
# (no native JSONB/JSON): the store already serializes with json.dumps.


class Backend(Protocol):
    dialect: str

    async def open(self) -> None: ...
    async def close(self) -> None: ...
    async def ensure_schema(self) -> None: ...
    async def execute(self, sql: str, params: Sequence[Any] = ()) -> None: ...
    async def fetchone(self, sql: str, params: Sequence[Any] = ()) -> dict[str, Any] | None: ...
    async def fetchall(self, sql: str, params: Sequence[Any] = ()) -> list[dict[str, Any]]: ...


# -- shared schema pieces -----------------------------------------------------
# The logical schema is identical; only the key-column type and the autoincrement
# id differ. Key columns must be bounded VARCHAR on MySQL (TEXT can't be indexed
# without a prefix length), so each dialect substitutes ID_TYPE / SERIAL below.


def _schema(
    id_type: str,
    serial: str,
    ts_type: str = "TEXT",
    engine: str = "",
    message_ordinal: str | None = None,
) -> list[str]:
    """DDL statements (one per element). ``id_type`` types uuid/key columns,
    ``serial`` is the autoincrement PK for job_events.id, ``ts_type`` types the
    ISO-timestamp columns (must be bounded on MySQL since some are indexed),
    ``engine`` is an optional table suffix. Big JSON blobs are LONGTEXT on MySQL,
    TEXT elsewhere.

    ``message_ordinal``: when set (Postgres/MySQL), messages get a monotonic
    ``ordinal`` autoincrement PK and ``id`` becomes UNIQUE, and the store orders
    messages by it. created_at is only microsecond-resolution, so a user row and
    its assistant row can share a timestamp and the random-uuid id makes the
    tiebreak non-deterministic; the ordinal keeps replay order stable. SQLite
    leaves it None and orders by the built-in monotonic ``rowid`` instead (no
    schema change, so existing databases need no migration)."""
    t = id_type
    ts = ts_type
    blob = "LONGTEXT" if engine else "TEXT"
    # Foreign keys are table-level constraints, not inline REFERENCES: MySQL
    # silently ignores inline column-level references, so the cascade would never
    # be created. SQLite and Postgres honor the table-level form equally.
    fk = "FOREIGN KEY"
    if message_ordinal:
        msg_id_line = f"ordinal {message_ordinal},\n            id {t} NOT NULL UNIQUE,"
    else:
        msg_id_line = f"id {t} PRIMARY KEY,"
    return [
        f"""CREATE TABLE IF NOT EXISTS sessions (
            id {t} PRIMARY KEY,
            name TEXT,
            provider_session_id TEXT,
            allowed_tools_json TEXT,
            created_at {ts} NOT NULL
        ){engine}""",
        f"""CREATE TABLE IF NOT EXISTS messages (
            {msg_id_line}
            session_id {t} NOT NULL,
            role TEXT NOT NULL,
            content {blob} NOT NULL,
            events_json {blob},
            streaming INTEGER NOT NULL DEFAULT 0,
            attachments_json {blob},
            created_at {ts} NOT NULL,
            {fk} (session_id) REFERENCES sessions(id) ON DELETE CASCADE
        ){engine}""",
        "CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at)",
        f"""CREATE TABLE IF NOT EXISTS jobs (
            id {t} PRIMARY KEY,
            session_id {t} NOT NULL,
            status TEXT NOT NULL,
            created_at {ts} NOT NULL,
            updated_at {ts} NOT NULL,
            {fk} (session_id) REFERENCES sessions(id) ON DELETE CASCADE
        ){engine}""",
        "CREATE INDEX IF NOT EXISTS idx_jobs_session ON jobs(session_id, created_at)",
        f"""CREATE TABLE IF NOT EXISTS attachments (
            id {t} PRIMARY KEY,
            session_id {t} NOT NULL,
            name TEXT NOT NULL,
            media_type TEXT NOT NULL,
            size INTEGER NOT NULL,
            path TEXT NOT NULL,
            created_at {ts} NOT NULL,
            {fk} (session_id) REFERENCES sessions(id) ON DELETE CASCADE
        ){engine}""",
        f"""CREATE TABLE IF NOT EXISTS job_events (
            id {serial},
            job_id {t} NOT NULL,
            seq INTEGER NOT NULL,
            event_json {blob} NOT NULL,
            created_at {ts} NOT NULL,
            UNIQUE (job_id, seq),
            {fk} (job_id) REFERENCES jobs(id) ON DELETE CASCADE
        ){engine}""",
    ]


# -- sqlite -------------------------------------------------------------------


class SQLiteBackend:
    dialect = "sqlite"

    def __init__(self, path: str):
        self._path = path
        self._db: Any = None
        import asyncio

        self._lock = asyncio.Lock()  # aiosqlite is single-connection; guard its use

    async def open(self) -> None:
        import aiosqlite

        self._db = await aiosqlite.connect(self._path)
        self._db.row_factory = aiosqlite.Row
        await self._db.execute("PRAGMA journal_mode=WAL")
        await self._db.execute("PRAGMA foreign_keys=ON")
        await self._db.commit()

    async def close(self) -> None:
        if self._db:
            await self._db.close()
            self._db = None

    async def ensure_schema(self) -> None:
        for stmt in _schema(id_type="TEXT", serial="INTEGER PRIMARY KEY AUTOINCREMENT"):
            await self._db.execute(stmt)
        await self._db.commit()
        # Additive migration for databases created before allowed_tools_json.
        cur = await self._db.execute("PRAGMA table_info(sessions)")
        cols = {row["name"] for row in await cur.fetchall()}
        if "allowed_tools_json" not in cols:
            await self._db.execute("ALTER TABLE sessions ADD COLUMN allowed_tools_json TEXT")
            await self._db.commit()

    async def execute(self, sql: str, params: Sequence[Any] = ()) -> None:
        async with self._lock:
            await self._db.execute(sql, tuple(params))
            await self._db.commit()

    async def fetchone(self, sql: str, params: Sequence[Any] = ()) -> dict[str, Any] | None:
        async with self._lock:
            cur = await self._db.execute(sql, tuple(params))
            row = await cur.fetchone()
        return dict(row) if row else None

    async def fetchall(self, sql: str, params: Sequence[Any] = ()) -> list[dict[str, Any]]:
        async with self._lock:
            cur = await self._db.execute(sql, tuple(params))
            rows = await cur.fetchall()
        return [dict(r) for r in rows]


# -- postgres -----------------------------------------------------------------


def _to_pg(sql: str) -> str:
    """Rewrite ``?`` placeholders to ``$1, $2, ...`` (our SQL never contains a
    literal ``?`` inside a string, so a positional count is safe)."""
    n = 0

    def repl(_m: re.Match[str]) -> str:
        nonlocal n
        n += 1
        return f"${n}"

    return re.sub(r"\?", repl, sql)


class PostgresBackend:
    dialect = "postgres"

    def __init__(self, dsn: str):
        self._dsn = dsn
        self._pool: Any = None

    async def open(self) -> None:
        import asyncpg

        self._pool = await asyncpg.create_pool(self._dsn, min_size=1, max_size=8)

    async def close(self) -> None:
        if self._pool:
            await self._pool.close()
            self._pool = None

    async def ensure_schema(self) -> None:
        # Fresh databases get the current schema in full; there is no legacy
        # pre-allowed_tools_json Postgres database to migrate.
        async with self._pool.acquire() as conn:
            for stmt in _schema(
                id_type="TEXT",
                serial="BIGSERIAL PRIMARY KEY",
                message_ordinal="BIGSERIAL PRIMARY KEY",
            ):
                await conn.execute(stmt)

    async def execute(self, sql: str, params: Sequence[Any] = ()) -> None:
        async with self._pool.acquire() as conn:
            await conn.execute(_to_pg(sql), *params)  # autocommit outside a tx

    async def fetchone(self, sql: str, params: Sequence[Any] = ()) -> dict[str, Any] | None:
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(_to_pg(sql), *params)
        return dict(row) if row else None

    async def fetchall(self, sql: str, params: Sequence[Any] = ()) -> list[dict[str, Any]]:
        async with self._pool.acquire() as conn:
            rows = await conn.fetch(_to_pg(sql), *params)
        return [dict(r) for r in rows]


# -- mysql --------------------------------------------------------------------


class MySQLBackend:
    dialect = "mysql"

    def __init__(self, *, host: str, port: int, user: str, password: str, db: str):
        self._cfg = dict(host=host, port=port, user=user, password=password, db=db)
        self._pool: Any = None

    async def open(self) -> None:
        import aiomysql

        # autocommit=True so each execute commits, matching the single-statement
        # write model (no cross-statement transactions under single-writer).
        self._pool = await aiomysql.create_pool(
            autocommit=True, minsize=1, maxsize=8, **self._cfg
        )

    async def close(self) -> None:
        if self._pool:
            self._pool.close()
            await self._pool.wait_closed()
            self._pool = None

    async def ensure_schema(self) -> None:
        # MySQL: key columns are VARCHAR (TEXT can't be indexed without a prefix
        # length); "IF NOT EXISTS" on CREATE INDEX is unsupported, so guard it.
        stmts = _schema(
            id_type="VARCHAR(64)",
            serial="BIGINT AUTO_INCREMENT PRIMARY KEY",
            ts_type="VARCHAR(40)",  # ISO-8601 UTC is ~32 chars; indexed, so bounded
            engine=" ENGINE=InnoDB",
            message_ordinal="BIGINT AUTO_INCREMENT PRIMARY KEY",
        )
        async with self._pool.acquire() as conn:
            async with conn.cursor() as cur:
                for stmt in stmts:
                    if stmt.strip().upper().startswith("CREATE INDEX"):
                        await self._ensure_index(cur, stmt)
                    else:
                        await cur.execute(stmt)

    @staticmethod
    async def _ensure_index(cur: Any, create_index_sql: str) -> None:
        m = re.match(
            r"CREATE INDEX IF NOT EXISTS (\w+) ON (\w+)", create_index_sql.strip(), re.I
        )
        assert m, create_index_sql
        name, table = m.group(1), m.group(2)
        await cur.execute(
            "SELECT COUNT(*) FROM information_schema.statistics "
            "WHERE table_schema = DATABASE() AND table_name = %s AND index_name = %s",
            (table, name),
        )
        rows = await cur.fetchall()  # plain cursor -> [(count,)]
        if rows[0][0] == 0:
            body = re.sub(r"IF NOT EXISTS ", "", create_index_sql, flags=re.I)
            await cur.execute(body)

    @staticmethod
    def _to_mysql(sql: str) -> str:
        return sql.replace("?", "%s")

    async def execute(self, sql: str, params: Sequence[Any] = ()) -> None:
        async with self._pool.acquire() as conn:
            async with conn.cursor() as cur:
                await cur.execute(self._to_mysql(sql), tuple(params))

    async def fetchone(self, sql: str, params: Sequence[Any] = ()) -> dict[str, Any] | None:
        import aiomysql

        async with self._pool.acquire() as conn:
            async with conn.cursor(aiomysql.DictCursor) as cur:
                await cur.execute(self._to_mysql(sql), tuple(params))
                row = await cur.fetchone()
        return dict(row) if row else None

    async def fetchall(self, sql: str, params: Sequence[Any] = ()) -> list[dict[str, Any]]:
        import aiomysql

        async with self._pool.acquire() as conn:
            async with conn.cursor(aiomysql.DictCursor) as cur:
                await cur.execute(self._to_mysql(sql), tuple(params))
                rows = await cur.fetchall()
        return [dict(r) for r in rows]


# -- factory ------------------------------------------------------------------


def backend_from_url(url_or_path: str) -> Backend:
    """Build a backend from a database URL or a bare SQLite path.

    - ``postgresql://user:pass@host:port/db`` (or ``postgres://``)
    - ``mysql://user:pass@host:port/db``
    - ``sqlite:///relative/or/abs/path.db`` or a bare filesystem path.
    """
    scheme = url_or_path.split("://", 1)[0].lower() if "://" in url_or_path else ""

    if scheme in ("postgresql", "postgres"):
        try:
            import asyncpg  # noqa: F401
        except ImportError as e:
            raise RuntimeError(
                'Postgres backend needs asyncpg: pip install "fairway-kit[postgres]"'
            ) from e
        # asyncpg accepts the postgres:// DSN directly.
        return PostgresBackend(url_or_path.replace("postgresql://", "postgres://", 1))

    if scheme == "mysql":
        try:
            import aiomysql  # noqa: F401
        except ImportError as e:
            raise RuntimeError(
                'MySQL backend needs aiomysql: pip install "fairway-kit[mysql]"'
            ) from e
        u = urlparse(url_or_path)
        return MySQLBackend(
            host=u.hostname or "localhost",
            port=u.port or 3306,
            user=unquote(u.username or "root"),
            password=unquote(u.password or ""),
            db=(u.path or "/").lstrip("/") or "fairway",
        )

    # Bare path or sqlite:// URL. Match SQLAlchemy's convention: after
    # "sqlite://", drop exactly one leading slash (the empty-host separator),
    # so sqlite:///rel.db -> rel.db and sqlite:////abs.db -> /abs.db.
    if scheme == "sqlite":
        rest = url_or_path[len("sqlite://"):]
        path = rest[1:] if rest.startswith("/") else rest
        return SQLiteBackend(path or ":memory:")
    return SQLiteBackend(url_or_path)
