"""Tests for final multi-timeframe candidate packaging gates."""
from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta

import pandas as pd
import pytest

from app.domain.models.multitimeframe_features import (
    MULTITIMEFRAME_BACKTEST_POLICY,
    MULTITIMEFRAME_LABEL_SELECTION_POLICY,
)
from app.domain.training.train_final_multitimeframe import (
    _chronological_final_split,
    _final_gate,
    _load_research_qualification,
)

def _split_frame(periods: int = 700) -> pd.DataFrame:
    start = datetime(2026, 1, 5, 0, 0, tzinfo=UTC)
    return pd.DataFrame(
        {
            "decision_time": [
                start + timedelta(minutes=index) for index in range(periods)
            ],
            "instrument": [
                "EURUSD" if index % 2 == 0 else "GBPUSD"
                for index in range(periods)
            ],
            "target": [index % 2 for index in range(periods)],
        }
    )

def test_final_split_is_chronological_disjoint_and_purged():
    train, validation, test = _chronological_final_split(
        _split_frame(),
        horizon_bars=5,
    )

    assert train["decision_time"].max() < validation["decision_time"].min()
    assert validation["decision_time"].max() < test["decision_time"].min()

    train_gap = (
        validation["decision_time"].min() - train["decision_time"].max()
    ).total_seconds() / 60.0
    test_gap = (
        test["decision_time"].min() - validation["decision_time"].max()
    ).total_seconds() / 60.0

    assert train_gap > 5
    assert test_gap > 5
    assert set(train["decision_time"]).isdisjoint(validation["decision_time"])
    assert set(validation["decision_time"]).isdisjoint(test["decision_time"])

def test_final_split_rejects_too_few_periods():
    with pytest.raises(ValueError, match="At least 500 unique decision periods"):
        _chronological_final_split(
            _split_frame(periods=300),
            horizon_bars=5,
        )

def test_final_gate_requires_all_metrics_to_pass():
    passing = {
        "classification": {"balanced_accuracy": 0.55},
        "trading": {
            "sharpe_ratio": 1.2,
            "profit_factor": 1.25,
            "max_drawdown": 0.08,
        },
    }
    assert _final_gate(passing)["passed"] is True

    failing = {
        "classification": {"balanced_accuracy": 0.51},
        "trading": {
            "sharpe_ratio": 1.2,
            "profit_factor": 1.25,
            "max_drawdown": 0.08,
        },
    }
    result = _final_gate(failing)
    assert result["passed"] is False
    assert result["checks"]["balanced_accuracy"] is False


def _qualification_payload(
    *,
    label_policy: str | None,
    backtest_policy: str | None = MULTITIMEFRAME_BACKTEST_POLICY,
) -> dict:
    payload = {
        "target_m1_rows_per_instrument": 25_000,
        "qualification_window": {
            "decision_time_before": "2026-01-20T00:00:00+00:00",
        },
        "horizon_reports": {
            "5m": {
                "research_gate": {
                    "research_gate_passed": True,
                }
            }
        },
    }
    if label_policy is not None:
        payload["label_selection_policy"] = label_policy
    if backtest_policy is not None:
        payload["backtest_evaluation_policy"] = backtest_policy
    return payload

def test_final_packaging_accepts_only_current_label_selection_policy(tmp_path):
    summary = tmp_path / "summary.json"
    summary.write_text(
        json.dumps(
            _qualification_payload(
                label_policy=MULTITIMEFRAME_LABEL_SELECTION_POLICY
            )
        ),
        encoding="utf-8",
    )

    gate, cutoff, target_rows = _load_research_qualification(
        summary,
        horizon_bars=5,
    )

    assert gate is not None and gate["research_gate_passed"] is True
    assert cutoff is not None
    assert target_rows == 25_000

@pytest.mark.parametrize("legacy_policy", [None, "future_profitable_rows_only_v1"])
def test_final_packaging_rejects_legacy_label_selection_policy(
    tmp_path,
    legacy_policy,
):
    summary = tmp_path / "legacy-summary.json"
    summary.write_text(
        json.dumps(_qualification_payload(label_policy=legacy_policy)),
        encoding="utf-8",
    )

    with pytest.raises(ValueError, match="label-selection policy"):
        _load_research_qualification(summary, horizon_bars=5)


@pytest.mark.parametrize(
    "legacy_backtest_policy",
    [None, "serial_full_capital_active_signals_v0"],
)
def test_final_packaging_rejects_legacy_backtest_evaluation_policy(
    tmp_path,
    legacy_backtest_policy,
):
    summary = tmp_path / "legacy-backtest-summary.json"
    summary.write_text(
        json.dumps(
            _qualification_payload(
                label_policy=MULTITIMEFRAME_LABEL_SELECTION_POLICY,
                backtest_policy=legacy_backtest_policy,
            )
        ),
        encoding="utf-8",
    )

    with pytest.raises(ValueError, match="backtest-evaluation policy"):
        _load_research_qualification(summary, horizon_bars=5)
