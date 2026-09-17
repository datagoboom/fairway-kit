//! Protocol event constructors + validation (PROTOCOL.md §2–3) — the producer
//! half. Events are plain JSON objects (`serde_json::Value`) so `x_*`
//! extension events and unknown future types flow through untouched, exactly
//! as the spec requires. The envelope (`seq`, `ts`) is stamped by the store at
//! persist time, never by producers.

use serde_json::{json, Map, Value};

pub const PROTOCOL_VERSION: &str = "0.3";

/// An event as emitted by a runner: no `seq`/`ts` yet.
pub type EmitEvent = Value;
/// An event after the store stamped `seq` and `ts`.
pub type StampedEvent = Value;

pub fn is_terminal(ev: &Value) -> bool {
    matches!(ev.get("type").and_then(Value::as_str), Some("done" | "error" | "cancelled"))
}

pub fn seq_of(ev: &Value) -> i64 {
    ev.get("seq").and_then(Value::as_i64).unwrap_or(0)
}

pub fn message_start(message_id: &str) -> EmitEvent {
    json!({ "type": "message_start", "message_id": message_id })
}
pub fn text(content: &str) -> EmitEvent {
    json!({ "type": "text", "content": content })
}
pub fn text_block(content: &str) -> EmitEvent {
    json!({ "type": "text_block", "content": content })
}
pub fn thinking(content: &str) -> EmitEvent {
    json!({ "type": "thinking", "content": content })
}

pub fn tool_call(
    id: &str,
    tool: &str,
    kind: &str,
    label: &str,
    detail: Option<&str>,
    input: Option<Value>,
) -> EmitEvent {
    let mut e = Map::new();
    e.insert("type".into(), "tool_call".into());
    e.insert("id".into(), id.into());
    e.insert("tool".into(), tool.into());
    e.insert("kind".into(), kind.into());
    e.insert("label".into(), label.into());
    if let Some(d) = detail {
        e.insert("detail".into(), d.into());
    }
    if let Some(i) = input {
        e.insert("input".into(), i);
    }
    Value::Object(e)
}

pub fn tool_result(id: &str, ok: bool, summary: Option<&str>, detail: Option<&str>) -> EmitEvent {
    let mut e = Map::new();
    e.insert("type".into(), "tool_result".into());
    e.insert("id".into(), id.into());
    e.insert("ok".into(), ok.into());
    if let Some(s) = summary {
        e.insert("summary".into(), s.into());
    }
    if let Some(d) = detail {
        e.insert("detail".into(), d.into());
    }
    Value::Object(e)
}

pub fn permission_request(
    id: &str,
    tool: &str,
    kind: &str,
    label: &str,
    detail: Option<&str>,
    input: Option<Value>,
) -> EmitEvent {
    let mut e = Map::new();
    e.insert("type".into(), "permission_request".into());
    e.insert("id".into(), id.into());
    e.insert("tool".into(), tool.into());
    e.insert("kind".into(), kind.into());
    e.insert("label".into(), label.into());
    if let Some(d) = detail {
        e.insert("detail".into(), d.into());
    }
    if let Some(i) = input {
        e.insert("input".into(), i);
    }
    Value::Object(e)
}

pub fn permission_resolved(id: &str, decision: &str) -> EmitEvent {
    json!({ "type": "permission_resolved", "id": id, "decision": decision })
}

pub fn done(message_id: &str, reason: Option<&str>) -> EmitEvent {
    let mut e = Map::new();
    e.insert("type".into(), "done".into());
    e.insert("message_id".into(), message_id.into());
    if let Some(r) = reason {
        e.insert("reason".into(), r.into());
    }
    Value::Object(e)
}

pub fn error_event(message: &str, message_id: Option<&str>) -> EmitEvent {
    let mut e = Map::new();
    e.insert("type".into(), "error".into());
    e.insert("message".into(), message.into());
    if let Some(m) = message_id {
        e.insert("message_id".into(), m.into());
    }
    Value::Object(e)
}

pub fn cancelled(message_id: Option<&str>) -> EmitEvent {
    let mut e = Map::new();
    e.insert("type".into(), "cancelled".into());
    if let Some(m) = message_id {
        e.insert("message_id".into(), m.into());
    }
    Value::Object(e)
}

/// Cheap structural check for producer mistakes (mirrors the JS/Python validate).
pub fn validate(ev: &EmitEvent) -> Result<(), String> {
    let t = ev
        .get("type")
        .and_then(Value::as_str)
        .filter(|t| !t.is_empty())
        .ok_or_else(|| format!("event missing type: {ev}"))?;
    let s = |k: &str| ev.get(k).map(|v| v.is_string()).unwrap_or(false);
    match t {
        "text" | "text_block" | "thinking" if !s("content") => {
            Err(format!("{t} event missing content"))
        }
        "tool_call" | "permission_request"
            if !["id", "tool", "kind", "label"].iter().all(|k| s(k)) =>
        {
            Err(format!("{t} missing id/tool/kind/label"))
        }
        "tool_result" if !s("id") || !ev.get("ok").map(Value::is_boolean).unwrap_or(false) => {
            Err("tool_result missing id/ok".into())
        }
        "permission_resolved" => {
            let ok_decision = matches!(
                ev.get("decision").and_then(Value::as_str),
                Some("allow" | "allow_session" | "deny")
            );
            if !s("id") || !ok_decision {
                Err("permission_resolved missing id/decision".into())
            } else {
                Ok(())
            }
        }
        "done" if !s("message_id") => Err("done missing message_id".into()),
        "error" if !s("message") => Err("error missing message".into()),
        _ => Ok(()),
    }
}
