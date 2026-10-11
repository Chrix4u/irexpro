from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from app.domain.models.quote_microstructure import (
    QUOTE_MICROSTRUCTURE_FEATURE_COLUMNS,
    QuoteSnapshot,
    compute_quote_microstructure_features,
    snapshots_from_dukascopy_ticks,
)


def test_feature_contract_is_finite_and_complete():
    decision = datetime(2026, 10, 5, 12, 0, tzinfo=UTC)
    snapshots = [
        QuoteSnapshot(
            timestamp=decision - timedelta(seconds=60 - second),
            bid=1.1000 + second * 0.000001,
            ask=1.1001 + second * 0.000001,
        )
        for second in range(60)
    ]

    features = compute_quote_microstructure_features(
        snapshots,
        decision_time=decision,
    )

    assert tuple(features) == QUOTE_MICROSTRUCTURE_FEATURE_COLUMNS
    assert features["quote_samples_60s"] == 60.0
    assert features["quote_coverage_60s"] == 1.0
    assert all(value == value for value in features.values())


def test_tick_downsampling_keeps_last_quote_in_each_second():
    base = datetime(2026, 10, 5, 12, 0, tzinfo=UTC)
    ticks = [
        (base, 1.1002, 1.1000, 1.0, 1.0, 2),
        (base + timedelta(microseconds=500_000), 1.1003, 1.1001, 1.0, 1.0, 2),
        (base + timedelta(seconds=1), 1.1004, 1.1002, 1.0, 1.0, 2),
    ]

    snapshots = snapshots_from_dukascopy_ticks(ticks)

    assert len(snapshots) == 2
    assert snapshots[0].bid == 1.1001
    assert snapshots[0].ask == 1.1003


def test_invalid_quote_geometry_fails_closed():
    decision = datetime(2026, 10, 5, 12, 0, tzinfo=UTC)
    snapshots = [
        QuoteSnapshot(
            timestamp=decision - timedelta(seconds=10),
            bid=1.1002,
            ask=1.1001,
        )
    ]

    with pytest.raises(ValueError, match="Invalid bid/ask"):
        compute_quote_microstructure_features(
            snapshots,
            decision_time=decision,
        )
