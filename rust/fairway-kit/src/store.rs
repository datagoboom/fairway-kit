//! Persistence (PROTOCOL.md §7, §12) over SQLite (rusqlite, bundled).
//!
//! Single-writer: the whole connection sits behind one mutex, which serializes
//! the seq-critical section (SELECT MAX(seq)+1 → INSERT) and the allow-tool
//! read-modify-write for free. Calls are short local SQLite operations; this
//! is a local dev kit, not a throughput story. `UNIQUE(job_id, seq)` is the
//! backstop.

use std::path::Path;
use std::sync::Mutex;

use chrono::{SecondsFormat, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Map, Value};

use crate::events::StampedEvent;

pub type Result<T> = std::result::Result<T, String>;

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

pub fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub fn new_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct Message {
    pub id: String,
    pub session_id: String,
    pub role: String,
    pub content: String,
    pub events: Option<Vec<StampedEvent>>,
    pub streaming: bool,
    pub attachments: Option<Value>,
    pub created_at: String,
}

pub struct Store {
    conn: Mutex<Connection>,
}

const SCHEMA: &[&str] = &[
    "CREATE TABLE IF NOT EXISTS sessions (
       id TEXT PRIMARY KEY,
       name TEXT,
       provider_session_id TEXT,
       allowed_tools_json TEXT,
       created_at TEXT NOT NULL
     )",
    "CREATE TABLE IF NOT EXISTS messages (
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
     )",
    "CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, ordinal)",
    "CREATE TABLE IF NOT EXISTS jobs (
       id TEXT PRIMARY KEY,
       session_id TEXT NOT NULL,
       status TEXT NOT NULL,
       created_at TEXT NOT NULL,
       updated_at TEXT NOT NULL,
       FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
     )",
    "CREATE INDEX IF NOT EXISTS idx_jobs_session ON jobs(session_id, created_at)",
    "CREATE TABLE IF NOT EXISTS attachments (
       id TEXT PRIMARY KEY,
       session_id TEXT NOT NULL,
       name TEXT NOT NULL,
       media_type TEXT NOT NULL,
       size INTEGER NOT NULL,
       path TEXT NOT NULL,
       created_at TEXT NOT NULL,
       FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
     )",
    "CREATE TABLE IF NOT EXISTS job_events (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       job_id TEXT NOT NULL,
       seq INTEGER NOT NULL,
       event_json TEXT NOT NULL,
       created_at TEXT NOT NULL,
       UNIQUE (job_id, seq),
       FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
     )",
];

impl Store {
    pub fn open(db_path: &Path) -> Result<Store> {
        let conn = Connection::open(db_path).map_err(err)?;
        Self::init(conn)
    }

    pub fn open_in_memory() -> Result<Store> {
        Self::init(Connection::open_in_memory().map_err(err)?)
    }

    fn init(conn: Connection) -> Result<Store> {
        conn.pragma_update(None, "journal_mode", "WAL").ok();
        conn.pragma_update(None, "foreign_keys", "ON").map_err(err)?;
        for stmt in SCHEMA {
            conn.execute(stmt, []).map_err(err)?;
        }
        Ok(Store { conn: Mutex::new(conn) })
    }

    fn with<T>(&self, f: impl FnOnce(&Connection) -> rusqlite::Result<T>) -> Result<T> {
        let conn = self.conn.lock().map_err(err)?;
        f(&conn).map_err(err)
    }

    // -- sessions ------------------------------------------------------------

    pub fn create_session(&self, name: Option<&str>) -> Result<Value> {
        let id = new_id();
        self.with(|c| {
            c.execute(
                "INSERT INTO sessions (id, name, created_at) VALUES (?1, ?2, ?3)",
                params![id, name, now()],
            )
        })?;
        self.get_session(&id)?.ok_or_else(|| "session vanished".into())
    }

    pub fn get_session(&self, id: &str) -> Result<Option<Value>> {
        self.with(|c| {
            c.query_row("SELECT * FROM sessions WHERE id = ?1", params![id], session_row)
                .optional()
        })
    }

    pub fn list_sessions(&self) -> Result<Vec<Value>> {
        self.with(|c| {
            c.prepare("SELECT * FROM sessions ORDER BY created_at DESC")?
                .query_map([], session_row)?
                .collect()
        })
    }

    pub fn delete_session(&self, id: &str) -> Result<()> {
        self.with(|c| c.execute("DELETE FROM sessions WHERE id = ?1", params![id]))?;
        Ok(())
    }

    pub fn set_provider_session_id(&self, id: &str, provider: &str) -> Result<()> {
        self.with(|c| {
            c.execute(
                "UPDATE sessions SET provider_session_id = ?1 WHERE id = ?2",
                params![provider, id],
            )
        })?;
        Ok(())
    }

    pub fn get_allowed_tools(&self, id: &str) -> Result<Vec<String>> {
        let raw: Option<Option<String>> = self.with(|c| {
            c.query_row(
                "SELECT allowed_tools_json FROM sessions WHERE id = ?1",
                params![id],
                |r| r.get(0),
            )
            .optional()
        })?;
        Ok(raw
            .flatten()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default())
    }

    pub fn add_allowed_tool(&self, id: &str, tool: &str) -> Result<()> {
        // Read-modify-write serialized by the connection mutex (single-writer).
        let mut tools = self.get_allowed_tools(id)?;
        if !tools.iter().any(|t| t == tool) {
            tools.push(tool.to_string());
            tools.sort();
        }
        let raw = serde_json::to_string(&tools).map_err(err)?;
        self.with(|c| {
            c.execute("UPDATE sessions SET allowed_tools_json = ?1 WHERE id = ?2", params![raw, id])
        })?;
        Ok(())
    }

    // -- messages ------------------------------------------------------------

    pub fn add_message(
        &self,
        session_id: &str,
        role: &str,
        content: &str,
        streaming: bool,
        attachments: Option<&Value>,
    ) -> Result<String> {
        let id = new_id();
        let att = attachments.map(|a| a.to_string());
        self.with(|c| {
            c.execute(
                "INSERT INTO messages (id, session_id, role, content, streaming, attachments_json, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![id, session_id, role, content, streaming as i64, att, now()],
            )
        })?;
        Ok(id)
    }

    pub fn flush_assistant(&self, message_id: &str, content: &str, events: &[StampedEvent]) -> Result<()> {
        let ev = serde_json::to_string(events).map_err(err)?;
        self.with(|c| {
            c.execute(
                "UPDATE messages SET content = ?1, events_json = ?2 WHERE id = ?3",
                params![content, ev, message_id],
            )
        })?;
        Ok(())
    }

    pub fn finalize_assistant(&self, message_id: &str, content: &str, events: &[StampedEvent]) -> Result<()> {
        let ev = serde_json::to_string(events).map_err(err)?;
        self.with(|c| {
            c.execute(
                "UPDATE messages SET content = ?1, events_json = ?2, streaming = 0 WHERE id = ?3",
                params![content, ev, message_id],
            )
        })?;
        Ok(())
    }

    pub fn delete_message(&self, message_id: &str) -> Result<()> {
        self.with(|c| c.execute("DELETE FROM messages WHERE id = ?1", params![message_id]))?;
        Ok(())
    }

    pub fn list_messages(&self, session_id: &str, include_streaming: bool, limit: i64) -> Result<Vec<Message>> {
        let q = if include_streaming {
            "SELECT * FROM messages WHERE session_id = ?1 ORDER BY ordinal LIMIT ?2"
        } else {
            "SELECT * FROM messages WHERE session_id = ?1 AND streaming = 0 ORDER BY ordinal LIMIT ?2"
        };
        self.with(|c| c.prepare(q)?.query_map(params![session_id, limit], message_row)?.collect())
    }

    pub fn get_message(&self, message_id: &str) -> Result<Option<Message>> {
        self.with(|c| {
            c.query_row("SELECT * FROM messages WHERE id = ?1", params![message_id], message_row)
                .optional()
        })
    }

    // -- jobs ----------------------------------------------------------------

    pub fn create_job(&self, session_id: &str) -> Result<String> {
        let id = new_id();
        let t = now();
        self.with(|c| {
            c.execute(
                "INSERT INTO jobs (id, session_id, status, created_at, updated_at) VALUES (?1, ?2, 'running', ?3, ?4)",
                params![id, session_id, t, t],
            )
        })?;
        Ok(id)
    }

    pub fn set_job_status(&self, job_id: &str, status: &str) -> Result<()> {
        self.with(|c| {
            c.execute(
                "UPDATE jobs SET status = ?1, updated_at = ?2 WHERE id = ?3",
                params![status, now(), job_id],
            )
        })?;
        Ok(())
    }

    pub fn get_job(&self, job_id: &str) -> Result<Option<Value>> {
        self.with(|c| {
            c.query_row("SELECT * FROM jobs WHERE id = ?1", params![job_id], job_row).optional()
        })
    }

    pub fn active_job_for_session(&self, session_id: &str) -> Result<Option<Value>> {
        self.with(|c| {
            c.query_row(
                "SELECT * FROM jobs WHERE session_id = ?1 AND status = 'running' ORDER BY created_at DESC LIMIT 1",
                params![session_id],
                job_row,
            )
            .optional()
        })
    }

    pub fn orphaned_running_jobs(&self) -> Result<Vec<Value>> {
        self.with(|c| {
            c.prepare("SELECT * FROM jobs WHERE status = 'running'")?
                .query_map([], job_row)?
                .collect()
        })
    }

    // -- event log -----------------------------------------------------------

    /// The seq-critical section: SELECT MAX(seq)+1 → INSERT, serialized by the
    /// connection mutex. Stamps `seq` and `ts` onto the event.
    pub fn append_event(&self, job_id: &str, event: &Value) -> Result<StampedEvent> {
        let conn = self.conn.lock().map_err(err)?;
        let seq: i64 = conn
            .query_row(
                "SELECT COALESCE(MAX(seq), 0) + 1 FROM job_events WHERE job_id = ?1",
                params![job_id],
                |r| r.get(0),
            )
            .map_err(err)?;
        let ts = now();
        let mut stamped = match event {
            Value::Object(m) => m.clone(),
            _ => Map::new(),
        };
        stamped.insert("seq".into(), json!(seq));
        stamped.insert("ts".into(), json!(ts));
        let stamped = Value::Object(stamped);
        conn.execute(
            "INSERT INTO job_events (job_id, seq, event_json, created_at) VALUES (?1, ?2, ?3, ?4)",
            params![job_id, seq, stamped.to_string(), ts],
        )
        .map_err(err)?;
        Ok(stamped)
    }

    pub fn get_events(&self, job_id: &str, since: i64) -> Result<Vec<StampedEvent>> {
        let raws: Vec<String> = self.with(|c| {
            c.prepare("SELECT event_json FROM job_events WHERE job_id = ?1 AND seq > ?2 ORDER BY seq")?
                .query_map(params![job_id, since], |r| r.get(0))?
                .collect()
        })?;
        raws.iter().map(|r| serde_json::from_str(r).map_err(err)).collect()
    }

    pub fn delete_events_by_seq(&self, job_id: &str, seqs: &[i64]) -> Result<()> {
        if seqs.is_empty() {
            return Ok(());
        }
        let marks = seqs.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let sql = format!("DELETE FROM job_events WHERE job_id = ? AND seq IN ({marks})");
        self.with(|c| {
            let mut params: Vec<&dyn rusqlite::ToSql> = vec![&job_id];
            for s in seqs {
                params.push(s);
            }
            c.execute(&sql, params.as_slice())
        })?;
        Ok(())
    }
}

fn session_row(r: &rusqlite::Row) -> rusqlite::Result<Value> {
    Ok(json!({
        "id": r.get::<_, String>("id")?,
        "name": r.get::<_, Option<String>>("name")?,
        "provider_session_id": r.get::<_, Option<String>>("provider_session_id")?,
        "created_at": r.get::<_, String>("created_at")?,
    }))
}

fn job_row(r: &rusqlite::Row) -> rusqlite::Result<Value> {
    Ok(json!({
        "id": r.get::<_, String>("id")?,
        "session_id": r.get::<_, String>("session_id")?,
        "status": r.get::<_, String>("status")?,
        "created_at": r.get::<_, String>("created_at")?,
        "updated_at": r.get::<_, String>("updated_at")?,
    }))
}

fn message_row(r: &rusqlite::Row) -> rusqlite::Result<Message> {
    let events = r
        .get::<_, Option<String>>("events_json")?
        .and_then(|s| serde_json::from_str(&s).ok());
    let attachments = r
        .get::<_, Option<String>>("attachments_json")?
        .and_then(|s| serde_json::from_str(&s).ok());
    Ok(Message {
        id: r.get("id")?,
        session_id: r.get("session_id")?,
        role: r.get("role")?,
        content: r.get("content")?,
        events,
        streaming: r.get::<_, i64>("streaming")? != 0,
        attachments,
        created_at: r.get("created_at")?,
    })
}
