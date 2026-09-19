"""Tests for causal multi-timeframe historical corpus construction."""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from app.domain.training.multitimeframe_corpus import (
    build_multitimeframe_corpus_from_m1_csv,
    build_multitimeframe_feature_corpus,
    validate_no_lookahead,
)


def _m1_fixture(periods: int = 12 * 60) -> pd.DataFrame:
    index = np.arange(periods, dtype=float)
    close = 1.10 + index * 0.000001 + 0.0002 * np.sin(index / 17.0)
    open_ = close - 0.00003
    return pd.DataFrame(
        {
            "timestamp": pd.date_range(
                "2026-01-01T00:00:00Z",
                periods=periods,
                freq="min",
            ),
            "open": open_,
            "high": close + 0.0001,
            "low": open_ - 0.0001,
            "close": close,
            "volume": 1000.0 + (index % 37),
        }
    )


def test_multitimeframe_alignment_uses_only_fully_closed_context():
    corpus = build_multitimeframe_feature_corpus(_m1_fixture())
    decision_time = pd.Timestamp("2026-01-01T10:15:00Z")
    row = corpus.loc[corpus["decision_time"] == decision_time].iloc[0]

    assert row["m1_source_bar_open"] == pd.Timestamp("2026-01-01T10:14:00Z")
    assert row["m1_available_at"] == decision_time

    assert row["m5_source_bar_open"] == pd.Timestamp("2026-01-01T10:10:00Z")
    assert row["m5_available_at"] == decision_time

    assert row["m15_source_bar_open"] == pd.Timestamp("2026-01-01T10:00:00Z")
    assert row["m15_available_at"] == decision_time

    assert row["h1_source_bar_open"] == pd.Timestamp("2026-01-01T09:00:00Z")
    assert row["h1_available_at"] == pd.Timestamp("2026-01-01T10:00:00Z")

    assert row["h4_source_bar_open"] == pd.Timestamp("2026-01-01T04:00:00Z")
    assert row["h4_available_at"] == pd.Timestamp("2026-01-01T08:00:00Z")


def test_incomplete_h1_bar_is_dropped_instead_of_forward_leaked():
    source = _m1_fixture()
    source = source[source["timestamp"] != pd.Timestamp("2026-01-01T09:30:00Z")]

    corpus = build_multitimeframe_feature_corpus(source)
    decision_time = pd.Timestamp("2026-01-01T10:15:00Z")
    row = corpus.loc[corpus["decision_time"] == decision_time].iloc[0]

    assert row["h1_source_bar_open"] == pd.Timestamp("2026-01-01T08:00:00Z")
    assert row["h1_available_at"] == pd.Timestamp("2026-01-01T09:00:00Z")


def test_leakage_validator_rejects_future_higher_timeframe_feature():
    corpus = build_multitimeframe_feature_corpus(_m1_fixture())
    broken = corpus.iloc[[100]].copy()
    broken["h1_source_bar_open"] = broken["decision_time"]
    broken["h1_available_at"] = broken["decision_time"] + pd.Timedelta(hours=1)

    with pytest.raises(ValueError, match="Lookahead detected"):
        validate_no_lookahead(broken)


def test_builder_normalizes_offset_timestamp_input_to_utc():
    source = _m1_fixture(6 * 60).copy()
    source["timestamp"] = source["timestamp"].dt.tz_convert("Europe/London")

    corpus = build_multitimeframe_feature_corpus(source)

    assert str(corpus["decision_time"].dt.tz) == "UTC"
    assert str(corpus["h4_available_at"].dt.tz) == "UTC"


def test_multitimeframe_corpus_writes_reproducible_manifest(tmp_path: Path):
    source_path = tmp_path / "EURUSD_M1.csv"
    output_path = tmp_path / "EURUSD_multitimeframe.csv"
    _m1_fixture(8 * 60).to_csv(source_path, index=False)

    result = build_multitimeframe_corpus_from_m1_csv(
        m1_path=source_path,
        output_path=output_path,
        instrument="EURUSD",
    )

    manifest_path = Path(result["manifest_path"])
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

    assert output_path.is_file()
    assert manifest_path.is_file()
    assert manifest["source_timeframe"] == "M1"
    assert manifest["derived_timeframes"] == ["M5", "M15", "H1", "H4"]
    assert manifest["alignment_method"] == "backward_asof_on_available_at"
    assert manifest["canonical_utc_boundaries"] is True
    assert manifest["lookahead_validation"] == "passed"
    assert manifest["dataset_sha256"] == result["dataset_sha256"]
