"""paranoid-132 item 3: the fold-completeness guard.

Every test here is paired: one asserting the guard FIRES on the real drift, one
asserting it stays SILENT on conforming data. A guard that always fires is
noise, and a guard that never fires is decoration — this bug class survived for
months precisely because nothing in the system could tell the two apart.
"""

from __future__ import annotations

import pytest

from fairway.health import assert_folds_cleanly, fold_health

CONFORMING = [
    {"seq": 1, "type": "message_start", "message_id": "m1"},
    {"seq": 2, "type": "text", "content": "checking"},
    {"seq": 3, "type": "tool_call", "id": "t1", "tool": "grep", "kind": "read",
     "label": "grep", "detail": '{"q":"x"}'},
    {"seq": 4, "type": "tool_result", "id": "t1", "ok": True, "summary": "3 hits"},
]

# The actual drift: `tool` where the protocol says `tool_call`. Structurally
# fine, passes every write, folds to nothing usable.
DRIFTED = [
    {"seq": 1, "type": "message_start", "message_id": "m1"},
    {"seq": 2, "type": "tool", "id": "cc_0", "summary": '{"q":"x"}'},
]


def test_conforming_history_is_healthy():
    h = fold_health([CONFORMING])
    assert h.healthy
    assert h["opaque"] == 0 and h["orphan"] == 0
    assert h["tools"] == 1 and h["named"] == 1


def test_drifted_vocabulary_is_caught():
    """The months-long silent failure, detected."""
    h = fold_health([DRIFTED])
    assert not h.healthy
    assert h["opaque"] == 1


def test_assert_raises_on_drift_and_says_why():
    with pytest.raises(AssertionError, match="cannot interpret"):
        assert_folds_cleanly([DRIFTED])


def test_assert_is_silent_on_conforming():
    """CONTROL. If this raised, the guard would be unusable and would be
    disabled by whoever hit it first — which is how guards die."""
    h = assert_folds_cleanly([CONFORMING, CONFORMING])
    assert h["messages"] == 2


def test_orphan_is_caught_even_though_nothing_is_opaque():
    """A tool_result whose call never arrived folds to a perfectly clean-looking
    item with NO opaque events at all. Counting only `opaque` would miss it,
    and an orphan renders as an interrupted call that never happened."""
    evs = [{"seq": 1, "type": "message_start", "message_id": "m1"},
           {"seq": 2, "type": "tool_result", "id": "nope", "ok": True}]
    h = fold_health([evs])
    assert h["opaque"] == 0        # the trap: looks fine by that measure alone
    assert h["orphan"] == 1
    assert not h.healthy


def test_pairing_is_scoped_per_message():
    """Ids are namespaced per message, so flattening every message into one
    stream would let one turn's result pair with another turn's call and hide a
    real orphan. This is the -51/-128 collision in a measuring instrument."""
    call_only = [{"seq": 1, "type": "message_start", "message_id": "m1"},
                 {"seq": 2, "type": "tool_call", "id": "cc_0", "tool": "a",
                  "kind": "k", "label": "a"}]
    result_only = [{"seq": 1, "type": "message_start", "message_id": "m2"},
                   {"seq": 2, "type": "tool_result", "id": "cc_0", "ok": True}]
    h = fold_health([call_only, result_only])
    # Two separate messages -> two unpaired items. If they were flattened they
    # would pair up and report healthy, which would be a false clean bill.
    assert h["orphan"] >= 1
    assert not h.healthy


def test_empty_input_is_healthy_not_an_error():
    """No history is not broken history."""
    assert fold_health([]).healthy
    assert fold_health([[], None]).healthy
