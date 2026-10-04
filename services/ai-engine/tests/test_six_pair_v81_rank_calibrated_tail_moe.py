from __future__ import annotations

import numpy as np
import pandas as pd

from app.domain.training.six_pair_v81_rank_calibrated_tail_moe import (
    _apply,
    _calibration_stability,
    _ecdf_percentile,
    _ecdf_reference,
    _rank_calibrate,
)


def test_ecdf_maps_raw_scores_to_scale_invariant_percentiles():
    reference = _ecdf_reference(pd.Series([0.10, 0.20, 0.30, 0.40]))
    values = pd.Series([0.05, 0.20, 0.25, 0.50])
    percentiles = _ecdf_percentile(values, reference)

    assert np.allclose(percentiles, [0.0, 0.5, 0.5, 1.0])


def test_rank_calibration_uses_frozen_reference_not_outer_distribution():
    calibration_reference = np.array([0.10, 0.20, 0.30, 0.40])
    margin_reference = np.array([0.01, 0.02, 0.03, 0.04])
    outer = pd.DataFrame(
        {
            "_conservative_tail_p": [0.35, 0.45],
            "_probability_margin": [0.025, 0.05],
        }
    )
    ranked = _rank_calibrate(
        outer,
        score_reference=calibration_reference,
        margin_reference=margin_reference,
    )

    assert ranked["_tail_score_percentile"].tolist() == [0.75, 1.0]
    assert ranked["_margin_percentile"].tolist() == [0.5, 1.0]


def _ranked_rows() -> pd.DataFrame:
    return pd.DataFrame(
        {
            "_horizon_agreement": [True, True, True, True],
            "_tail_score_percentile": [0.96, 0.90, 0.80, 0.60],
            "_margin_percentile": [0.90, 0.80, 0.70, 0.60],
            "quote_coverage_60s": [0.90] * 4,
            "spread_to_atr_ratio": [0.30] * 4,
            "decision_time": pd.to_datetime(
                [
                    "2026-10-05T12:00:00Z",
                    "2026-10-05T12:05:00Z",
                    "2026-10-05T12:10:00Z",
                    "2026-10-05T12:15:00Z",
                ],
                utc=True,
            ),
            "selected_net_return": [0.002, 0.001, -0.001, -0.002],
            "predicted_long": [True, False, True, False],
            "_actionable_target": [True, True, False, False],
            "_regime": ["active_clean"] * 4,
        }
    )


def test_rank_gate_is_independent_of_raw_probability_scale():
    frame = _ranked_rows()
    out = _apply(
        frame,
        {
            "score_quantile": 0.85,
            "margin_quantile": 0.75,
            "coverage_floor": 0.50,
            "spread_atr_cap": 0.75,
        },
    )

    assert out["active_trade"].tolist() == [True, True, False, False]


def test_calibration_stability_requires_both_halves_positive():
    stable = _ranked_rows().copy()
    stable["active_trade"] = True
    stable["selected_net_return"] = [0.002, 0.001, 0.002, 0.001]
    stable_result = _calibration_stability(stable)
    assert stable_result["passed"] is True

    unstable = stable.copy()
    unstable.loc[2:, "selected_net_return"] = [-0.003, -0.002]
    unstable_result = _calibration_stability(unstable)
    assert unstable_result["passed"] is False
