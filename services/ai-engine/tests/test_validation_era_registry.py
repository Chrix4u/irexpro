from __future__ import annotations

import pytest

from app.domain.training.validation_era_registry import (
    ValidationEra,
    assert_disjoint_validation_era,
    eras_overlap,
)


def test_disjoint_validation_era_passes() -> None:
    old = ValidationEra.from_strings(
        candidate="v14",
        start="2026-09-09T09:57:00Z",
        end="2026-09-21T17:23:00Z",
    )
    new = ValidationEra.from_strings(
        candidate="v15",
        start="2026-09-21T17:24:00Z",
        end="2026-09-25T20:59:00Z",
    )
    assert eras_overlap(old, new) is False
    assert_disjoint_validation_era(new, [old])


def test_overlapping_validation_era_fails() -> None:
    old = ValidationEra.from_strings(
        candidate="v14",
        start="2026-09-09T09:57:00Z",
        end="2026-09-21T17:23:00Z",
    )
    overlapping = ValidationEra.from_strings(
        candidate="v15",
        start="2026-09-20T00:00:00Z",
        end="2026-09-22T00:00:00Z",
    )
    with pytest.raises(ValueError, match="overlaps exposed eras"):
        assert_disjoint_validation_era(overlapping, [old])
