//! Fold conformance against the shared vectors (protocol/fold-vectors.json) —
//! the same cases js/test/fold.test.ts and python/tests/test_fold.py run.

use serde_json::Value;

fn vectors() -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../protocol/fold-vectors.json");
    serde_json::from_str(&std::fs::read_to_string(path).expect("read fold-vectors.json"))
        .expect("parse fold-vectors.json")
}

#[test]
fn fold_vectors() {
    let v = vectors();
    let mut failures = Vec::new();
    for case in v["cases"].as_array().expect("cases") {
        let name = case["name"].as_str().unwrap_or("?");
        let events: Vec<Value> = case["events"].as_array().unwrap().to_vec();
        let expected = &case["items"];
        let got = Value::Array(fairway_kit::fold::fold_all(&events));
        if &got != expected {
            failures.push(format!(
                "case '{name}':\n  expected: {expected}\n  got:      {got}"
            ));
        }
    }
    assert!(failures.is_empty(), "\n{}", failures.join("\n\n"));
}

#[test]
fn fold_is_incremental() {
    // Folding event-by-event from any prefix equals folding all at once.
    let v = vectors();
    for case in v["cases"].as_array().expect("cases") {
        let name = case["name"].as_str().unwrap_or("?");
        let events: Vec<Value> = case["events"].as_array().unwrap().to_vec();
        let mut items = Vec::new();
        for ev in &events {
            items = fairway_kit::fold::fold(items, ev);
        }
        assert_eq!(Value::Array(items), case["items"], "case '{name}'");
    }
}

#[test]
fn events_validate_against_schema_required_fields() {
    // Structural spot-checks matching events.schema.json's required lists.
    use fairway_kit::events as ev;
    assert!(ev::validate(&ev::text("hi")).is_ok());
    assert!(ev::validate(&ev::tool_call("t1", "Read", "file", "Read file", None, None)).is_ok());
    assert!(ev::validate(&serde_json::json!({"type": "tool_result", "id": "t1"})).is_err());
    assert!(ev::validate(&serde_json::json!({"type": "done"})).is_err());
    assert!(ev::validate(&serde_json::json!({"type": "x_custom", "anything": 1})).is_ok());
}
