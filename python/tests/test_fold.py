"""Fold conformance against the shared vectors (protocol/fold-vectors.json)."""

import json
from pathlib import Path

import pytest

from fairway.fold import fold_all

VECTORS = json.loads(
    (Path(__file__).resolve().parents[2] / "protocol" / "fold-vectors.json").read_text()
)


@pytest.mark.parametrize("case", VECTORS["cases"], ids=[c["name"] for c in VECTORS["cases"]])
def test_fold_vector(case):
    assert fold_all(case["events"]) == case["items"]


@pytest.mark.parametrize("case", VECTORS["cases"], ids=[c["name"] for c in VECTORS["cases"]])
def test_fold_is_incremental(case):
    """Folding event-by-event from any prefix equals folding all at once."""
    from fairway.fold import fold

    items = []
    for ev in case["events"]:
        items = fold(items, ev)
    assert items == case["items"]
