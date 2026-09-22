"""Tests for leakage-safe model qualification diagnostics."""
from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from app.domain.training.qualification_diagnostics import (
    causal_regime_diagnostics,
    diagnose_directional_predictions,
    evidence_sufficiency_warnings,
    feature_gain_diagnostics,
)


def _predictions() -> pd.DataFrame:
    probabilities = np.array([0.88, 0.76, 0.61, 0.56, 0.44, 0.39, 0.24, 0.12])
    predicted_long = probabilities >= 0.50
    confidence = np.maximum(probabilities, 1.0 - probabilities)
    return pd.DataFrame(
        {
            "decision_time": pd.date_range(
                "2026-01-01T00:00:00Z",
                periods=len(probabilities),
                freq="min",
            ),
            "instrument": ["EURUSD"] * len(probabilities),
            "target": [1, 1, 0, 1, 0, 1, 0, 0],
            "positive_probability": probabilities,
            "predicted_long": predicted_long,
            "confidence": confidence,
            "active_trade": confidence >= 0.60,
            "selected_net_return": [0.01, 0.02, -0.01, 0.01, 0.005, -0.02, 0.01, 0.02],
            "m1_volatility_20": np.linspace(0.001, 0.008, len(probabilities)),
            "h1_rsi_14": [35.0, 38.0, 45.0, 50.0, 55.0, 62.0, 66.0, 70.0],
        }
    )


def test_directional_diagnostics_report_bias_calibration_and_confidence_coverage():
    report = diagnose_directional_predictions(
        _predictions(),
        confidence_threshold=0.60,
        decision_threshold=0.50,
    )

    assert report["true_class_distribution"]["LONG"]["count"] == 4
    assert report["predicted_class_distribution"]["LONG"]["count"] == 4
    assert report["confusion_matrix"] == {
        "true_short_pred_short": 3,
        "true_short_pred_long": 1,
        "true_long_pred_short": 1,
        "true_long_pred_long": 3,
    }
    assert report["sensitivity"] == pytest.approx(0.75)
    assert report["specificity"] == pytest.approx(0.75)
    assert report["balanced_accuracy"] == pytest.approx(0.75)
    assert 0.0 <= report["brier_score"] <= 1.0
    assert report["probability_quantiles"]
    assert report["confidence_quantiles"]
    assert report["confidence_coverage"]["count"] == 6
    assert report["high_confidence_signal_counts"] == {"LONG": 3, "SHORT": 3}
    assert report["calibration_bins"]


def test_directional_diagnostics_never_accept_confidence_floor_below_060():
    with pytest.raises(ValueError, match="remain >= 0.60"):
        diagnose_directional_predictions(
            _predictions(),
            confidence_threshold=0.59,
        )


def test_evidence_sufficiency_flags_high_sharpe_from_tiny_sample_without_new_gate():
    warnings = evidence_sufficiency_warnings(
        trade_or_period_count=13,
        sharpe_ratio=2.18,
        confidence_coverage=0.02,
        by_instrument_period_counts={
            "EURUSD": 4,
            "GBPUSD": 1,
            "USDJPY": 3,
            "AUDUSD": 2,
            "USDCAD": 2,
            "USDCHF": 1,
        },
    )

    assert "very_small_non_overlapping_trade_sample" in warnings
    assert "high_sharpe_with_small_trade_sample" in warnings
    assert "low_confidence_coverage" in warnings
    assert any(item.startswith("sparse_instrument_trade_evidence:") for item in warnings)


def test_feature_gain_diagnostics_is_deterministic_and_normalized():
    class Booster:
        def get_score(self, importance_type):
            assert importance_type == "gain"
            return {"f0": 3.0, "f1": 1.0}

    class Model:
        def get_booster(self):
            return Booster()

    first = feature_gain_diagnostics(Model(), ["alpha", "beta"], top_n=2)
    second = feature_gain_diagnostics(Model(), ["alpha", "beta"], top_n=2)

    assert first == second
    assert first[0]["feature"] == "alpha"
    assert first[0]["normalized_gain"] == pytest.approx(0.75)
    assert sum(float(row["normalized_gain"]) for row in first) == pytest.approx(1.0)


def test_regime_diagnostics_only_reports_sufficient_already_causal_slices():
    frame = pd.concat([_predictions()] * 12, ignore_index=True)
    frame["decision_time"] = pd.date_range(
        "2026-01-01T00:00:00Z",
        periods=len(frame),
        freq="min",
    )

    report = causal_regime_diagnostics(frame, confidence_threshold=0.60)

    assert "m1_volatility_20" in report
    assert "boundaries" in report["m1_volatility_20"]
    assert "h1_rsi_14" in report
