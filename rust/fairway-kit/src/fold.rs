//! The normative fold: events → render items (PROTOCOL.md §5).
//!
//! Third implementation of the fold, after js/packages/protocol/src/fold.ts
//! and python/src/fairway/fold.py, pinned by the same conformance vectors
//! (protocol/fold-vectors.json). Items are built as `serde_json::Value` so
//! output compares byte-for-byte with the vectors: absent `tool`/`kind`/`label`
//! on a call become explicit `null` (an incomplete card), while optional
//! `detail`/`summary` are omitted entirely — matching the reference exactly.

use serde_json::{json, Map, Value};


/// Fold an event we cannot faithfully interpret. Used when a field whose
/// ABSENCE WOULD MISLEAD is missing — not merely when the schema marks a field
/// required (a `tool_call` without `kind` is a correct card with less
/// metadata; one without `id` can never pair with its result).
fn opaque(items: &mut Vec<Value>, ev: &Value) {
    items.push(json!({ "type": "opaque", "event": ev }));
}

fn close_trailing(items: &mut [Value]) {
    if let Some(last) = items.last_mut() {
        let t = last.get("type").and_then(Value::as_str);
        if matches!(t, Some("text" | "thinking"))
            && last.get("open").and_then(Value::as_bool) == Some(true)
        {
            last["open"] = json!(false);
        }
    }
}

fn str_or_null(ev: &Value, key: &str) -> Value {
    ev.get(key).cloned().unwrap_or(Value::Null)
}

/// Pure: takes the previous items by value, returns the new items.
pub fn fold(mut items: Vec<Value>, ev: &Value) -> Vec<Value> {
    let t = ev.get("type").and_then(Value::as_str).unwrap_or("");

    match t {
        "message_start" => items,

        "text" | "thinking" => {
            let Some(content) = ev.get("content").and_then(Value::as_str) else {
                opaque(&mut items, ev);
                return items;
            };
            let appended = items.last_mut().is_some_and(|last| {
                if last.get("type").and_then(Value::as_str) == Some(t)
                    && last.get("open").and_then(Value::as_bool) == Some(true)
                {
                    let existing = last["content"].as_str().unwrap_or("").to_string();
                    last["content"] = json!(existing + content);
                    true
                } else {
                    false
                }
            });
            if !appended {
                items.push(json!({ "type": t, "content": content, "open": true }));
            }
            items
        }

        "text_block" => {
            let Some(content) = ev.get("content").and_then(Value::as_str) else {
                opaque(&mut items, ev);
                return items;
            };
            let replaced = items.last_mut().is_some_and(|last| {
                if last.get("type").and_then(Value::as_str) == Some("text")
                    && last.get("open").and_then(Value::as_bool) == Some(true)
                {
                    last["content"] = json!(content);
                    last["open"] = json!(false);
                    true
                } else {
                    false
                }
            });
            if !replaced {
                items.push(json!({ "type": "text", "content": content, "open": false }));
            }
            items
        }

        "tool_call" => {
            if ev.get("id").is_none() {
                opaque(&mut items, ev);
                return items;
            }
            close_trailing(&mut items);
            let mut item = Map::new();
            item.insert("type".into(), "tool".into());
            item.insert("id".into(), ev["id"].clone());
            item.insert("tool".into(), str_or_null(ev, "tool"));
            item.insert("kind".into(), str_or_null(ev, "kind"));
            item.insert("label".into(), str_or_null(ev, "label"));
            item.insert("status".into(), "running".into());
            if let Some(d) = ev.get("detail") {
                item.insert("detail".into(), d.clone());
            }
            items.push(Value::Object(item));
            items
        }

        "tool_result" => {
            // A tool_result with no `ok` must never render as a failure the
            // tool may not have had — an outcome we do not know is not an
            // outcome we may guess.
            let (Some(id), Some(ok)) = (ev.get("id"), ev.get("ok").and_then(Value::as_bool))
            else {
                opaque(&mut items, ev);
                return items;
            };
            let status = if ok { "ok" } else { "err" };
            for it in items.iter_mut().rev() {
                if it.get("type").and_then(Value::as_str) == Some("tool")
                    && it.get("id") == Some(id)
                    && it.get("status").and_then(Value::as_str) == Some("running")
                {
                    it["status"] = json!(status);
                    if let Some(s) = ev.get("summary") {
                        it["summary"] = s.clone();
                    }
                    if let Some(d) = ev.get("detail") {
                        it["result_detail"] = d.clone();
                    }
                    return items;
                }
            }
            let mut orphan = Map::new();
            orphan.insert("type".into(), "tool".into());
            orphan.insert("id".into(), id.clone());
            orphan.insert("status".into(), status.into());
            orphan.insert("orphan".into(), true.into());
            if let Some(s) = ev.get("summary") {
                orphan.insert("summary".into(), s.clone());
            }
            items.push(Value::Object(orphan));
            items
        }

        "permission_request" => {
            if ev.get("id").is_none() {
                opaque(&mut items, ev);
                return items;
            }
            close_trailing(&mut items);
            let mut item = Map::new();
            item.insert("type".into(), "permission".into());
            item.insert("id".into(), ev["id"].clone());
            item.insert("tool".into(), str_or_null(ev, "tool"));
            item.insert("kind".into(), str_or_null(ev, "kind"));
            item.insert("label".into(), str_or_null(ev, "label"));
            item.insert("status".into(), "pending".into());
            if let Some(d) = ev.get("detail") {
                item.insert("detail".into(), d.clone());
            }
            items.push(Value::Object(item));
            items
        }

        "permission_resolved" => {
            let (Some(id), Some(decision)) =
                (ev.get("id"), ev.get("decision").and_then(Value::as_str))
            else {
                opaque(&mut items, ev);
                return items;
            };
            let status = if decision == "deny" { "denied" } else { "allowed" };
            for it in items.iter_mut().rev() {
                if it.get("type").and_then(Value::as_str) == Some("permission")
                    && it.get("id") == Some(id)
                    && it.get("status").and_then(Value::as_str) == Some("pending")
                {
                    it["status"] = json!(status);
                    if decision == "allow_session" {
                        it["scope"] = json!("session");
                    }
                    return items;
                }
            }
            items.push(json!({ "type": "permission", "id": id, "status": status, "orphan": true }));
            items
        }

        "done" | "error" | "cancelled" => {
            close_trailing(&mut items);
            for it in items.iter_mut() {
                let ty = it.get("type").and_then(Value::as_str).map(String::from);
                let st = it.get("status").and_then(Value::as_str).map(String::from);
                if (ty.as_deref() == Some("tool") && st.as_deref() == Some("running"))
                    || (ty.as_deref() == Some("permission") && st.as_deref() == Some("pending"))
                {
                    it["status"] = json!("interrupted");
                }
            }
            if t == "error" {
                let mut item = Map::new();
                item.insert("type".into(), "error".into());
                if let Some(m) = ev.get("message") {
                    item.insert("message".into(), m.clone());
                }
                items.push(Value::Object(item));
            }
            items
        }

        // x_* extensions and unknown types: opaque, app-rendered.
        _ => {
            opaque(&mut items, ev);
            items
        }
    }
}

pub fn fold_all(events: &[Value]) -> Vec<Value> {
    let mut items = Vec::new();
    for ev in events {
        items = fold(items, ev);
    }
    items
}

/// Derive a message's plain content from its events (closed text runs joined
/// by blank lines) — the server-side use of the fold.
pub fn final_text(events: &[Value]) -> String {
    fold_all(events)
        .iter()
        .filter(|i| i.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|i| i.get("content").and_then(Value::as_str))
        .filter(|c| !c.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// Seqs of text deltas a `text_block` fully supersedes (PROTOCOL.md §6).
/// Deleting exactly these cannot change fold output.
pub fn compactable_delta_seqs(events: &[Value]) -> Vec<i64> {
    let mut compactable = Vec::new();
    let mut run: Vec<i64> = Vec::new();
    let mut pending_perms: std::collections::HashSet<String> = Default::default();
    for ev in events {
        let t = ev.get("type").and_then(Value::as_str).unwrap_or("");
        let seq = crate::events::seq_of(ev);
        let id = || ev.get("id").and_then(Value::as_str).unwrap_or("").to_string();
        match t {
            "text" => run.push(seq),
            "text_block" => {
                compactable.append(&mut run);
            }
            "message_start" => {}
            "permission_resolved" if pending_perms.contains(&id()) => {
                pending_perms.remove(&id());
            }
            _ => {
                if t == "permission_request" {
                    pending_perms.insert(id());
                }
                run.clear();
            }
        }
    }
    compactable
}
