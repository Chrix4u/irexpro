"""Six-pair source/pip research never changes executable or trained models."""

from __future__ import annotations

from pathlib import Path

import pandas as pd
import pytest
from test_ood_shadow_candidate import example

from app.domain.training.ood_shadow_candidate import SIX_PAIR_RESEARCH_PAIRS
from app.domain.training.ood_six_pair_shadow import RESEARCH_ARTIFACT, study_from_csv


def test_all_six_pairs_are_reported_without_fit_or_execution(tmp_path: Path) -> None:
    observations = []
    for pair in SIX_PAIR_RESEARCH_PAIRS:
        row = example()
        row["instrument"] = pair
        if pair == "USDJPY":
            row.update({
                "entry_bid": 150.00,
                "entry_ask": 150.02,
                "future_bid_15m": 150.09,
                "future_ask_15m": 150.11,
                "stop_distance": 0.2,
            })
        observations.append(row)
    cohort = tmp_path / "six-pair.csv"
    pd.DataFrame(observations).to_csv(cohort, index=False)
    report = study_from_csv(cohort)
    assert report["artifact"] == RESEARCH_ARTIFACT
    assert report["authority"] == "NONE"
    assert report["model_fitted"] is False
    assert report["execution_allowed"] is False
    assert report["promotion_allowed"] is False
    assert report["broker_net_pnl_verified"] is False
    assert report["data_quality"]["causally_verified_records"] == 6
    assert set(report["independent_ood_condition_outcomes"]["pair_outcomes"]) == set(
        SIX_PAIR_RESEARCH_PAIRS
    )
    jpy = report["independent_ood_condition_outcomes"]["pair_outcomes"]["USDJPY"]
    assert jpy["mean_proxy_pips"] == pytest.approx(6.0)


def test_readonly_sql_has_no_writes_and_covers_all_six_pairs() -> None:
    text = (
        Path(__file__).parents[1]
        / "app/domain/training/ood_six_pair_cohort_readonly.sql"
    ).read_text()
    assert "'USDJPY'" in text and "'USDCHF'" in text and "'USDCAD'" in text
    assert "broker.broker_connections" in text
    assert "last_quote_sample_at" in text
    assert "INSERT INTO" not in text.upper()
    assert "DELETE FROM" not in text.upper()
    assert "UPDATE " not in text.upper()
