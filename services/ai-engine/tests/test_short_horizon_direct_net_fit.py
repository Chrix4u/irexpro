from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd
import pytest

import app.domain.training.short_horizon_direct_net as direct_net_module
from app.domain.training.short_horizon_direct_net import (
    DirectNetCalibration,
    fit_pair_direct_net_experts,
)
from app.domain.training.train_multitimeframe import (
    LONG_NET_RETURN_COLUMN,
    SHORT_NET_RETURN_COLUMN,
)


@dataclass
class _FitRecord:
    minimum_feature: float
    maximum_feature: float
    early_rows: int


class _RecordingRegressor:
    def __init__(
        self,
        *,
        instrument: str,
        side: str,
        records: dict[str, _FitRecord],
    ) -> None:
        self.instrument = instrument
        self.side = side
        self.records = records

    def fit(
        self,
        frame: pd.DataFrame,
        target: np.ndarray,
        *,
        eval_set: list[tuple[pd.DataFrame, np.ndarray]],
        verbose: bool,
    ) -> _RecordingRegressor:
        del target, verbose
        early_frame, _ = eval_set[0]
        self.records[f"{self.instrument}::{self.side}"] = _FitRecord(
            minimum_feature=float(frame["feature_x"].min()),
            maximum_feature=float(frame["feature_x"].max()),
            early_rows=len(early_frame),
        )
        return self

    def predict(self, frame: pd.DataFrame) -> np.ndarray:
        base = frame["feature_x"].to_numpy(dtype=float)
        if self.side == "long":
            return base / 100.0 + 1.0
        return 1.5 - base / 200.0


def _training_frame() -> pd.DataFrame:
    times = pd.date_range("2026-01-01T00:00:00Z", periods=500, freq="min")
    rows: list[dict[str, object]] = []
    for index, decision_time in enumerate(times):
        for instrument, offset in (("EURUSD", 0.0), ("USDJPY", 100.0)):
            feature = offset + index / 500.0
            rows.append(
                {
                    "decision_time": decision_time,
                    "instrument": instrument,
                    "feature_x": feature,
                    LONG_NET_RETURN_COLUMN: 0.0002 + index * 1e-8,
                    SHORT_NET_RETURN_COLUMN: -0.0001 + index * 1e-8,
                }
            )
    return pd.DataFrame(rows)


def _passed_calibration() -> DirectNetCalibration:
    return DirectNetCalibration(
        passed=True,
        threshold_bps=1.0,
        reason="CALIBRATED",
        rows=250,
        density=0.10,
        mean_realized_bps=0.3,
        profit_factor=1.3,
        long_fraction=0.5,
        short_fraction=0.5,
        candidate_count=10,
    )


def test_fit_uses_pair_specific_models_and_inner_tail_for_calibration(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    records: dict[str, _FitRecord] = {}
    calibration_rows: list[int] = []

    def make_regressor(*, instrument: str, side: str, horizon_bars: int):
        assert horizon_bars == 5
        return _RecordingRegressor(instrument=instrument, side=side, records=records)

    def calibrate(
        predicted_best_bps: np.ndarray,
        predicted_long: np.ndarray,
        realized_selected_bps: np.ndarray,
    ) -> DirectNetCalibration:
        assert len(predicted_best_bps) == len(predicted_long) == len(realized_selected_bps)
        calibration_rows.append(len(predicted_best_bps))
        return _passed_calibration()

    monkeypatch.setattr(direct_net_module, "_make_direct_net_regressor", make_regressor)
    monkeypatch.setattr(direct_net_module, "select_density_budgeted_threshold", calibrate)

    models, calibrations, counts = fit_pair_direct_net_experts(
        _training_frame(),
        horizon_bars=5,
        feature_columns=["feature_x"],
    )

    assert set(models) == {
        "EURUSD::long",
        "EURUSD::short",
        "USDJPY::long",
        "USDJPY::short",
    }
    assert set(calibrations) == {"EURUSD", "USDJPY"}
    assert counts["pair_count"] == 2
    assert records["EURUSD::long"].maximum_feature < 10.0
    assert records["EURUSD::short"].maximum_feature < 10.0
    assert records["USDJPY::long"].minimum_feature > 90.0
    assert records["USDJPY::short"].minimum_feature > 90.0
    assert all(0 < rows < 500 for rows in calibration_rows)
    assert len(calibration_rows) == 2


def test_fit_rejects_unsupported_horizon() -> None:
    with pytest.raises(ValueError, match="unsupported direct-net horizon"):
        fit_pair_direct_net_experts(
            _training_frame(),
            horizon_bars=15,
            feature_columns=["feature_x"],
        )
