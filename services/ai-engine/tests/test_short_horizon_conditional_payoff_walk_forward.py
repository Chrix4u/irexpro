from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

import numpy as np
import pandas as pd

from app.domain.training.short_horizon_conditional_payoff import (
    ConditionalPayoffPairExpert,
    ConditionalSeverityModels,
)

PAIRS = ("EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCAD", "USDCHF")


class _FeatureClassifier:
    def __init__(self, side: str) -> None:
        self.side = side

    def predict_proba(self, features: pd.DataFrame) -> np.ndarray:
        signed = pd.to_numeric(features["feature"], errors="raise").to_numpy(dtype=float)
        magnitude = np.clip(np.abs(signed), 0.0, 1.0)
        long_probability = np.where(
            signed >= 0.0,
            0.50 + 0.40 * magnitude,
            0.50 - 0.40 * magnitude,
        )
        positive = long_probability if self.side == "long" else 1.0 - long_probability
        return np.column_stack([1.0 - positive, positive])


class _ConstantRegressor:
    def __init__(self, value: float) -> None:
        self.value = value

    def predict(self, features: pd.DataFrame) -> np.ndarray:
        return np.full(len(features), self.value, dtype=float)


def _frame(periods: int = 1100) -> pd.DataFrame:
    times = pd.date_range("2026-01-05T00:00:00Z", periods=periods, freq="min")
    rows: list[dict[str, object]] = []
    for offset, decision_time in enumerate(times):
        magnitude = ((offset % 100) + 1) / 100.0
        for pair_index, instrument in enumerate(PAIRS):
            true_long = (offset + pair_index) % 2 == 0
            signed_feature = magnitude if true_long else -magnitude
            selected = -0.00005 if offset % 11 == 0 else 0.00020
            rows.append(
                {
                    "decision_time": decision_time,
                    "instrument": instrument,
                    "target": int(true_long),
                    "event_actionable_target": 1,
                    "event_direction_target": int(true_long),
                    "event_barrier_return": 0.00010,
                    "event_long_net_return": selected if true_long else -0.00015,
                    "event_short_net_return": -0.00015 if true_long else selected,
                    "feature": signed_feature,
                }
            )
    return pd.DataFrame.from_records(rows)


def _fake_fitter(calls: list[dict[str, object]]) -> Callable[..., ConditionalPayoffPairExpert]:
    def fit(
        training_frame: pd.DataFrame,
        *,
        instrument: str,
        horizon_bars: int,
        **_: object,
    ) -> ConditionalPayoffPairExpert:
        calls.append(
            {
                "instrument": instrument,
                "horizon_bars": horizon_bars,
                "train_min": pd.Timestamp(training_frame["decision_time"].min()),
                "train_max": pd.Timestamp(training_frame["decision_time"].max()),
            }
        )
        return ConditionalPayoffPairExpert(
            instrument=instrument,
            long_model=_FeatureClassifier("long"),
            short_model=_FeatureClassifier("short"),
            severity_models=ConditionalSeverityModels(
                long_favorable=_ConstantRegressor(2.0),
                long_adverse=_ConstantRegressor(0.5),
                short_favorable=_ConstantRegressor(2.0),
                short_adverse=_ConstantRegressor(0.5),
            ),
            feature_columns=("feature",),
        )

    return fit


def test_walk_forward_uses_six_pairs_train_only_calibration_and_governance() -> None:
    from app.domain.training.short_horizon_conditional_payoff import (
        evaluate_conditional_payoff_frame,
    )

    calls: list[dict[str, object]] = []
    report = evaluate_conditional_payoff_frame(
        _frame(),
        horizon_bars=1,
        min_train_periods=300,
        validation_periods=720,
        max_splits=1,
        calibration_min_rows=20,
        expert_fitter=_fake_fitter(calls),
    )

    assert {call["instrument"] for call in calls} == set(PAIRS)
    assert len(calls) == 6
    fold = report["folds"][0]
    calibration_start = pd.Timestamp(fold["calibration_start"])
    validation_start = pd.Timestamp(fold["validation_start"])
    assert all(pd.Timestamp(call["train_max"]) < calibration_start for call in calls)
    assert pd.Timestamp(fold["calibration_end"]) < validation_start
    assert set(fold["pair_calibrations"]) == set(PAIRS)
    assert all(item["passed"] for item in fold["pair_calibrations"].values())
    assert report["protocol"]["purge_periods"] == 1
    assert report["protocol"]["embargo_periods"] == 1
    assert report["protocol"]["inner_calibration_train_only"] is True
    assert report["approved_for_paper"] is False
    assert report["approved_for_demo"] is False
    assert report["approved_for_live"] is False


def test_walk_forward_collapses_simultaneous_pair_signals_conservatively() -> None:
    from app.domain.training.short_horizon_conditional_payoff import (
        evaluate_conditional_payoff_frame,
    )

    report = evaluate_conditional_payoff_frame(
        _frame(),
        horizon_bars=1,
        min_train_periods=300,
        validation_periods=720,
        max_splits=1,
        calibration_min_rows=20,
        expert_fitter=_fake_fitter([]),
    )

    participation = report["participation"]
    assert participation["raw_active_signals"] > participation["non_overlapping_opportunities"]
    assert participation["raw_active_signals"] == (
        participation["non_overlapping_opportunities"] * len(PAIRS)
    )
    assert participation["opportunities_per_validation_day"] >= 24.0
    assert report["classification"]["balanced_accuracy"] == 1.0


def test_corpora_wrapper_persists_json_evidence(
    tmp_path: Path,
    monkeypatch,
) -> None:
    import app.domain.training.short_horizon_conditional_payoff as module

    frame = _frame()
    hashes = {pair: f"hash-{pair}" for pair in PAIRS}
    monkeypatch.setattr(module, "load_and_prepare_corpora", lambda *args, **kwargs: (frame, hashes))
    monkeypatch.setattr(module, "fit_pair_conditional_payoff_expert", _fake_fitter([]))
    output = tmp_path / "conditional-payoff-v6.json"

    report = module.evaluate_conditional_payoff_corpora(
        {pair: tmp_path / f"{pair}.csv" for pair in PAIRS},
        horizon_bars=1,
        report_path=output,
        min_train_periods=300,
        validation_periods=720,
        max_splits=1,
        calibration_min_rows=20,
    )

    assert output.is_file()
    persisted = output.read_text(encoding="utf-8")
    assert '"candidate": "six-pair-conditional-payoff-v6"' in persisted
    assert report["dataset_sha256"] == hashes
    assert report["report_path"] == str(output)
