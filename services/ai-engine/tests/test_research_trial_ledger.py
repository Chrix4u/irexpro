from __future__ import annotations

import json

import pytest

from app.domain.training.research_trial_ledger import (
    ResearchTrial,
    append_trial,
    comparable_sharpes,
    trial_from_report,
)


def _trial(sha: str, sharpe: float | None = 1.2) -> ResearchTrial:
    return ResearchTrial(
        candidate="v14",
        experiment="test",
        candidate_sha=sha,
        outer_era="82-94%",
        trade_count=40,
        long_trades=20,
        short_trades=20,
        sharpe_ratio=sharpe,
        profit_factor=1.3,
        max_drawdown=0.02,
        total_return=0.01,
        research_passed=True,
        approved_for_paper=False,
        approved_for_live=False,
    )


def test_append_trial_is_unique_by_sha(tmp_path) -> None:
    path = tmp_path / "ledger.json"
    rows = append_trial(path, _trial("abc"))
    assert len(rows) == 1
    with pytest.raises(ValueError, match="already recorded"):
        append_trial(path, _trial("abc"))


def test_comparable_sharpes_skips_missing_values(tmp_path) -> None:
    path = tmp_path / "ledger.json"
    append_trial(path, _trial("abc", 1.2))
    rows = append_trial(path, _trial("def", None))
    assert comparable_sharpes(rows) == [1.2]
    assert json.loads(path.read_text())[-1]["sharpe_ratio"] is None


def test_trial_from_report_supports_legacy_flat_aggregate() -> None:
    report = {
        "experiment": "v11",
        "aggregate": {
            "trade_count": 62,
            "long_trades": 22,
            "short_trades": 40,
            "sharpe_ratio": -7.0,
            "profit_factor": 0.61,
            "max_drawdown": 0.01,
            "total_return": -0.006,
        },
        "robustness_gate": {"research_robustness_passed": False},
        "approved_for_paper": False,
        "approved_for_live": False,
    }
    trial = trial_from_report(
        report,
        candidate="v11",
        candidate_sha="legacy",
        outer_era="60-81%",
    )
    assert trial.trade_count == 62
    assert trial.long_trades == 22
    assert trial.short_trades == 40
    assert trial.sharpe_ratio == -7.0
