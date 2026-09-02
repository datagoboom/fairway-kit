"""paranoid-130 regression: tool_call must carry its arguments.

Found on a live deploy by reading a rendered card, not by any automated check.
Migrated history showed arguments on 204/204 tool cards; every turn through the
newly-deployed adapter showed NONE — the operator could see which tool ran but
not with what. Every count we had still passed, because the counts were over
pre-cutover data.
"""

from __future__ import annotations

import json

from fairway.adapters.claude_sdk import _DETAIL_CAP, _default_detail


def test_arguments_are_rendered():
    d = _default_detail({"package": "com.Slack", "flags": ["-a"]})
    assert d is not None
    assert "com.Slack" in d            # the actual argument, visible


def test_rendering_is_faithful_not_invented():
    """It must be a rendering OF the input, not a description of it.

    The distinction that makes this safe: a synthesised `label` asserts
    metadata that never existed, whereas this asserts only what was in the
    call. Round-tripping proves it carries no additions.
    """
    inp = {"cmd": "ls -la", "timeout": 30}
    assert json.loads(_default_detail(inp)) == inp


def test_truncation_is_marked_never_silent():
    """The -128 lesson. The old harness cut at 120 chars with no marker, so
    ~70% of arguments rendered as though complete."""
    big = {"blob": "x" * 9000}
    d = _default_detail(big)
    assert len(d) < _DETAIL_CAP + 100
    assert "…" in d and "more chars" in d   # the omission is legible
    assert "+" in d                          # and quantified


def test_no_truncation_marker_when_it_fits():
    """CONTROL: if everything is marked truncated, the marker means nothing."""
    d = _default_detail({"a": "b"})
    assert "more chars" not in d
    assert len(d) <= _DETAIL_CAP


def test_empty_and_non_dict_yield_none():
    """Absent is honest for a no-argument call; "{}" would be noise on a card."""
    assert _default_detail({}) is None
    assert _default_detail(None) is None
    assert _default_detail("not a dict") is None


def test_unserialisable_input_does_not_raise():
    """detail is cosmetic; it must never take down a turn."""
    class Weird:
        pass
    assert _default_detail({"obj": Weird()}) is not None   # default=str handles it
