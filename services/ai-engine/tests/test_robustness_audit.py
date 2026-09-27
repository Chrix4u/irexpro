from __future__ import annotations

import pytest

from app.domain.training.robustness_audit import (
    assess_trade_evidence,
    cost_stress_frontier,
    deflated_sharpe_ratio,
    expected_maximum_sharpe,
    probabilistic_sharpe_ratio,
    robustness_snapshot,
)


def test_trade_evidence_flags_small_sample() -> None:
    result = assess_trade_evidence(11)
    assert result.sufficient_for_inference is False
    assert result.preferred_evidence_reached is False
    assert "11 active trades" in (result.warning or "")


def test_trade_evidence_accepts_larger_sample() -> None:
    result = assess_trade_evidence(120)
    assert result.sufficient_for_inference is True
    assert result.preferred_evidence_reached is True
    assert result.warning is None


def test_psr_rewards_positive_consistent_returns() -> None:
    returns = [
        0.0010, 0.0008, 0.0012, -0.0002, 0.0009,
        0.0011, 0.0007, -0.0001, 0.0010, 0.0006,
    ]
    result = probabilistic_sharpe_ratio(returns)
    assert result["sample_count"] == 10.0
    assert result["sample_sharpe_unannualized"] > 0
    assert 0.5 < result["probabilistic_sharpe_ratio"] <= 1.0


def test_expected_maximum_sharpe_increases_with_trial_dispersion() -> None:
    result = expected_maximum_sharpe([-0.8, -0.6, 1.5, 5.6, 5.7])
    assert result["trial_count"] == 5.0
    assert result["expected_maximum_sharpe"] > result["trial_sharpe_mean"]


def test_snapshot_does_not_fake_multiple_testing_without_ledger() -> None:
    returns = [0.001, 0.0005, -0.0002, 0.0008]
    result = robustness_snapshot(returns)
    assert result["multiple_testing"]["status"] == "TRIAL_LEDGER_REQUIRED"
    assert result["multiple_testing"]["expected_maximum_sharpe"] is None


def test_psr_rejects_zero_variance() -> None:
    with pytest.raises(ValueError, match="non-zero sample variance"):
        probabilistic_sharpe_ratio([0.001, 0.001, 0.001])


def test_cost_stress_frontier_reduces_edge() -> None:
    result = cost_stress_frontier([0.0010, -0.0002, 0.0008], extra_cost_bps=[0.0, 1.0])
    base, stressed = result["scenarios"]
    assert stressed["mean_return_bps"] < base["mean_return_bps"]
    assert result["break_even_extra_cost_bps_by_mean"] > 0.0


def test_deflated_sharpe_penalizes_multiple_trials() -> None:
    returns = [
        0.0010, 0.0008, 0.0012, -0.0002, 0.0009,
        0.0011, 0.0007, -0.0001, 0.0010, 0.0006,
    ]
    psr = probabilistic_sharpe_ratio(returns)["probabilistic_sharpe_ratio"]
    dsr = deflated_sharpe_ratio(
        returns,
        comparable_trial_sharpes=[-0.4, 0.1, 0.4, 0.8, 1.2],
    )["deflated_sharpe_ratio"]
    assert 0.0 <= dsr <= 1.0
    assert dsr < psr


def test_deflated_sharpe_requires_trial_dispersion() -> None:
    with pytest.raises(ValueError, match="non-zero dispersion"):
        deflated_sharpe_ratio(
            [0.0010, 0.0008, -0.0002, 0.0009],
            comparable_trial_sharpes=[0.5, 0.5],
        )
