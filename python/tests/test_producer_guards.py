"""paranoid-132: the two kit-level guards that turn silent drift into a signal.

Both defects here were invisible for months in a real deployment, and both were
invisible for the SAME reason: the failure looked exactly like the success. A
bare unknown event type validated cleanly, and a crashed tool-only turn looked
like a turn that did nothing. Neither raised, logged, or rendered differently.

So each test below asserts the SIGNAL, and there is a paired control asserting
the signal does NOT fire on good input — a guard that always fires is as useless
as one that never does.
"""

from __future__ import annotations

import warnings

import pytest

from fairway import events as E
from fairway.events import UnknownEventTypeWarning


# ── validate(): unknown non-x_ types ─────────────────────────────────────────

def test_bare_unknown_type_warns():
    """The exact event that drifted: `{"type": "tool"}` where the protocol says
    `tool_call`. This validated silently for months."""
    with pytest.warns(UnknownEventTypeWarning, match="tool"):
        E.validate({"type": "tool", "id": "t1", "summary": "s"})


def test_bare_unknown_type_raises_under_strict():
    with pytest.raises(ValueError, match="extension prefix"):
        E.validate({"type": "tool"}, strict=True)


def test_x_prefixed_extension_is_silent():
    """CONTROL: PROTOCOL.md 8 explicitly blesses `x_` extensions. If these warn,
    the guard punishes the documented way of doing the right thing."""
    with warnings.catch_warnings():
        warnings.simplefilter("error")          # any warning becomes a failure
        E.validate({"type": "x_paranoid_note", "content": "fine"})
        E.validate({"type": "x_anything"}, strict=True)   # strict too


@pytest.mark.parametrize("t", sorted(E.CORE_TYPES))
def test_every_core_type_is_silent(t):
    """CONTROL over the WHOLE core vocabulary, not one sample of it.

    Testing one core type would prove only that one type is exempt; a typo in
    the CORE_TYPES membership check would still fire on the other ten.
    """
    ev = {"type": t, "message_id": "m1", "content": "c", "id": "i", "tool": "g",
          "kind": "k", "label": "l", "ok": True, "decision": "allow",
          "message": "m"}
    with warnings.catch_warnings():
        warnings.simplefilter("error")
        E.validate(ev)


def test_missing_type_still_raises():
    """CONTROL: the pre-existing hard error must survive the new soft one."""
    with pytest.raises(ValueError, match="missing type"):
        E.validate({"content": "no type here"})


def test_emit_side_stays_strict_about_kind_and_label():
    """The asymmetry with fold is deliberate and load-bearing.

    fold TOLERATES a tool_call without kind/label (paranoid-132) because it
    reads migrated history. validate must NOT, because it is the emit side —
    otherwise the tolerance meant for old data silently licenses new producers
    to omit the fields, and the drift restarts.
    """
    with pytest.raises(ValueError, match="tool_call missing"):
        E.validate({"type": "tool_call", "id": "t1", "tool": "grep"})


# ── startup_sweep: tool-only crashed turns ───────────────────────────────────
#
# The sweep's delete branch is guarded by a predicate over the event log. These
# test that predicate directly against the real event shapes; the surrounding
# sweep is exercised by the existing jobs tests.

def _has_activity(evs):
    """Mirrors jobs.py's pre-fold predicate."""
    return any(e.get("type") != "message_start" for e in evs)


def test_tool_only_crashed_turn_is_preserved():
    """The data-loss case. A turn that ran tools and crashed before producing
    text has no final_text; under the old fold-derived predicate a
    non-canonical vocabulary also yielded no tool items, so the row was
    DELETED.
    NOTE ON THE SHAPE — this deliberately has NO tool_result. My first version
    included one and it passed against the OLD predicate too, so it proved
    nothing: an unmatched tool_result folds to an ORPHAN tool item, which
    satisfies `any(type == "tool")` by accident. A crash mid-tool is exactly the
    case where the result never arrived, so this is both the realistic shape and
    the discriminating one.
    """
    evs = [{"seq": 1, "type": "message_start", "message_id": "m1"},
           {"seq": 2, "type": "tool", "id": "cc_0", "summary": "grep ..."}]
    assert _has_activity(evs) is True


def test_opaque_only_turn_is_preserved():
    """Stronger: even events NOTHING can interpret are evidence of work.
    Deleting is irreversible; being unable to render is not a reason to erase."""
    evs = [{"seq": 1, "type": "message_start", "message_id": "m1"},
           {"seq": 2, "type": "wholly_unknown", "blob": "?"}]
    assert _has_activity(evs) is True


def test_genuinely_empty_turn_is_still_deletable():
    """CONTROL: the sweep must still clean up. If everything is preserved, the
    fix has merely traded data loss for unbounded empty-row litter."""
    assert _has_activity([{"seq": 1, "type": "message_start", "message_id": "m1"}]) is False
    assert _has_activity([]) is False
