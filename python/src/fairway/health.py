"""Fold-completeness checks — is our stored history actually READABLE?

paranoid-132 item 3. This is the check that would have caught a months-long
event-vocabulary drift on day one, lifted out of the app that eventually needed
it so every adopter gets it for free.

THE FAILURE IT EXISTS TO CATCH. A producer emitting a slightly-wrong vocabulary
(`{"type": "tool"}` where the protocol says `tool_call`) is not loud. Events
persist fine, the API returns them, the turn completes, no exception is raised
anywhere. The only symptom is that the normative fold cannot interpret them, so
they become `opaque` blobs and orphaned items — and nobody looks at the fold's
output until a user reports that their tool calls vanished. By then every stored
turn is affected and a migration is the only way back.

The whole class is detectable in one line: fold everything you have stored and
count what came out UNINTERPRETABLE. That number should be zero, and if it ever
isn't, a producer is drifting.

WHY THIS IS DIFFERENT FROM `events.validate()`. validate() is the EMIT side: it
inspects one event as it is written. This is the READ side: it inspects the
whole corpus as it will actually be rendered. Both were needed here — the
vocabulary drift passed validate() (it was structurally fine, just wrongly
named) and only showed up when folded. A guard on emission and a guard on
interpretation answer different questions.
"""

from __future__ import annotations

from typing import Any, Iterable

from .fold import fold_all


class FoldHealth(dict):
    """Counts describing how well a set of events folds.

    A dict so it prints and serialises usefully, with named accessors because
    `h.healthy` reads better than `h["opaque"] == 0 and h["orphan"] == 0` at
    every call site.
    """

    @property
    def healthy(self) -> bool:
        """True when every stored event was interpretable.

        Deliberately NOT "no exception was raised". The fold never raises on
        malformed input by design — it produces `opaque` instead. So "it folded
        without error" is not evidence of anything; the counts are.
        """
        return self["opaque"] == 0 and self["orphan"] == 0

    @property
    def summary(self) -> str:
        return (
            f"messages={self['messages']} events={self['events']} "
            f"items={self['items']} tools={self['tools']} named={self['named']} "
            f"opaque={self['opaque']} orphan={self['orphan']}"
        )


def fold_health(event_lists: Iterable[Iterable[dict[str, Any]]]) -> FoldHealth:
    """Fold many messages' event streams and count what came out.

    Takes an iterable of event lists (one per message) rather than a flat list,
    because tool pairing is scoped to a message: ids are namespaced per message,
    so flattening would let one message's `tool_result` pair with another
    message's `tool_call` and mask a genuine orphan.

    `opaque` = events the fold could not interpret at all.
    `orphan` = tool items whose call/result never paired.
    `named`  = tool items that can actually display a tool name; a card the
               operator cannot identify is only nominally rendered, which is
               why this is counted separately from `tools`.
    """
    h = FoldHealth(messages=0, events=0, items=0, tools=0, named=0, opaque=0, orphan=0)
    for events in event_lists:
        events = list(events or [])
        if not events:
            continue
        h["messages"] += 1
        h["events"] += len(events)
        for item in fold_all(events):
            h["items"] += 1
            t = item.get("type")
            if t == "opaque":
                h["opaque"] += 1
            elif t == "tool":
                h["tools"] += 1
                if item.get("tool"):
                    h["named"] += 1
                if item.get("orphan"):
                    h["orphan"] += 1
    return h


def assert_folds_cleanly(event_lists: Iterable[Iterable[dict[str, Any]]]) -> FoldHealth:
    """Raise unless every stored event is interpretable. Returns the counts.

    Intended as a standing test in an adopter's own suite, run over real stored
    history rather than fixtures — the drift this catches lives in production
    data, and a fixture written by the same hand that wrote the producer will
    agree with the producer's mistakes.
    """
    h = fold_health(event_lists)
    if not h.healthy:
        raise AssertionError(
            "stored events do not fold cleanly — a producer is emitting a "
            f"vocabulary the normative fold cannot interpret: {h.summary}"
        )
    return h
