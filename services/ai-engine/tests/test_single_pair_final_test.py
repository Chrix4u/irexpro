"""Tests for single-pair untouched final-test governance."""
from __future__ import annotations

import json

import pandas as pd
import pytest

from app.domain.training.model_qualification import EVENT_PAIR_EXPERT_EXPERIMENT_NAME
from app.domain.training.single_pair_final_test import (
    SINGLE_PAIR_FINAL_TEST_POLICY,
    _direction_failure_diagnostics,
    _load_qualified_single_pair,
    _single_pair_final_gate,
)


def _qualification_payload() -> dict[str, object]:
    return {
        "event_label_policy": "first_net_return_barrier_atr1_spread2_timeout_v1",
        "untouched_final_test_used": False,
        "outer_validation_used_for_tuning": False,
        "qualification_decision_time_before": "2026-07-01T00:00:00+00:00",
        "dataset_sha256": {"USDJPY": "abc123"},
        "single_pair_scope": {
            "instrument": "USDJPY",
            "horizon_bars": 1,
            "experiment": EVENT_PAIR_EXPERT_EXPERIMENT_NAME,
        },
        "experiments": {
            EVENT_PAIR_EXPERT_EXPERIMENT_NAME: {
                "research_gate": {"research_gate_passed": True}
            }
        },
    }


def test_load_qualified_single_pair_requires_exact_scope_and_passed_gate(tmp_path):
    path = tmp_path / "qualification.json"
    path.write_text(json.dumps(_qualification_payload()), encoding="utf-8")

    gate, cutoff, hashes = _load_qualified_single_pair(
        path,
        instrument="USDJPY",
        horizon_bars=1,
    )

    assert gate["research_gate_passed"] is True
    assert cutoff == pd.Timestamp("2026-07-01T00:00:00Z")
    assert hashes == {"USDJPY": "abc123"}
    assert SINGLE_PAIR_FINAL_TEST_POLICY.endswith("_v1")


def test_load_qualified_single_pair_rejects_wrong_instrument(tmp_path):
    path = tmp_path / "qualification.json"
    path.write_text(json.dumps(_qualification_payload()), encoding="utf-8")

    with pytest.raises(ValueError, match="instrument"):
        _load_qualified_single_pair(
            path,
            instrument="EURUSD",
            horizon_bars=1,
        )


def test_single_pair_final_gate_requires_direction_opportunity_and_economics():
    test_metrics = {
        "classification": {"balanced_accuracy": 0.54},
        "trading": {
            "sharpe_ratio": 1.8,
            "profit_factor": 1.30,
            "max_drawdown": 0.02,
        },
    }
    opportunity = {"balanced_accuracy": 0.53}

    gate = _single_pair_final_gate(test_metrics, opportunity)

    assert gate["passed"] is True
    assert all(gate["checks"].values())


def test_single_pair_final_gate_holds_when_opportunity_accuracy_misses():
    test_metrics = {
        "classification": {"balanced_accuracy": 0.54},
        "trading": {
            "sharpe_ratio": 1.8,
            "profit_factor": 1.30,
            "max_drawdown": 0.02,
        },
    }
    opportunity = {"balanced_accuracy": 0.51}

    gate = _single_pair_final_gate(test_metrics, opportunity)

    assert gate["passed"] is False
    assert gate["checks"]["balanced_accuracy"] is True
    assert gate["checks"]["opportunity_balanced_accuracy"] is False


def test_direction_failure_diagnostics_reports_confusion_and_temporal_drift():
    frame = pd.DataFrame(
        {
            "decision_time": pd.date_range(
                "2026-07-01", periods=8, freq="min", tz="UTC"
            ),
            "actionable_target": [1] * 8,
            "target": [0, 0, 1, 1, 0, 1, 0, 1],
            "predicted_long": [False, True, True, False, True, True, False, False],
            "positive_probability": [0.2, 0.7, 0.8, 0.3, 0.65, 0.75, 0.4, 0.45],
            "direction_confidence": [0.8, 0.7, 0.8, 0.7, 0.65, 0.75, 0.6, 0.55],
            "active_trade": [False, True, True, False, True, True, False, False],
        }
    )

    diagnostics = _direction_failure_diagnostics(frame)

    assert diagnostics["event_direction_rows"] == 8
    assert diagnostics["confusion"] == {"tn": 2, "fp": 2, "fn": 2, "tp": 2}
    assert diagnostics["balanced_accuracy"] == pytest.approx(0.5)
    assert diagnostics["true_long_fraction"] == pytest.approx(0.5)
    assert diagnostics["predicted_long_fraction"] == pytest.approx(0.5)
    assert len(diagnostics["temporal_quartiles"]) == 4
    assert diagnostics["confidence_bands"]


def test_direction_failure_diagnostics_is_diagnostic_only_for_empty_event_rows():
    frame = pd.DataFrame(
        {
            "decision_time": pd.date_range(
                "2026-07-01", periods=2, freq="min", tz="UTC"
            ),
            "actionable_target": [0, 0],
            "target": [0, 1],
            "predicted_long": [False, True],
            "positive_probability": [0.3, 0.7],
            "direction_confidence": [0.7, 0.7],
            "active_trade": [False, False],
        }
    )

    diagnostics = _direction_failure_diagnostics(frame)

    assert diagnostics["event_direction_rows"] == 0
    assert diagnostics["balanced_accuracy"] is None
    assert diagnostics["confusion"] == {"tn": 0, "fp": 0, "fn": 0, "tp": 0}
