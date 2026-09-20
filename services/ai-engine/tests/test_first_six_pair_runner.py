"""Tests for six-pair research source selection."""
from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

import pytest

from app.domain.models.multitimeframe_features import (
    MULTITIMEFRAME_LABEL_SELECTION_POLICY,
)
from app.domain.training import run_first_six_pair as runner


def _fake_evaluation(report_path: str | Path) -> dict:
    report_path = Path(report_path)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text("{}", encoding="utf-8")
    return {
        "report_path": str(report_path),
        "overall": {
            "classification": {
                "balanced_accuracy": 0.55,
                "precision": 0.54,
                "recall": 0.53,
                "f1": 0.535,
                "roc_auc": 0.56,
                "log_loss": 0.68,
                "brier_score": 0.24,
                "accuracy": 0.55,
                "sample_count": 100.0,
                "positive_rate": 0.5,
            },
            "trading": {
                "trade_or_period_count": 100,
                "total_return": 0.02,
                "average_net_return": 0.0002,
                "median_net_return": 0.0001,
                "win_rate": 0.53,
                "profit_factor": 1.2,
                "sharpe_ratio": 1.1,
                "sortino_ratio": 1.2,
                "max_drawdown": 0.05,
            },
            "rows": 100,
            "active_trades": 100,
            "average_spread_bps": 0.8,
            "median_spread_bps": 0.7,
        },
        "by_instrument": {
            "EURUSD": {
                "trading": {"total_return": 0.01},
            }
        },
        "folds": [
            {
                "aggregate": {
                    "trading": {"total_return": 0.01},
                }
            }
        ],
        "fold_count": 1,
        "walk_forward": {
            "unique_periods": 100,
            "min_train_periods": 60,
            "validation_periods": 20,
            "purge_periods": 5,
            "embargo_periods": 5,
            "confidence_threshold": 0.60,
        },
    }


def test_dukascopy_source_requires_no_broker_credentials(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setattr(runner, "INITIAL_FOREX_UNIVERSE", ("EURUSD",))

    collected: list[str] = []

    def fake_collect(
        *,
        instrument: str,
        target_rows: int,
        output_path,
        now=None,
        cache_dir=None,
    ):
        del target_rows, now, cache_dir
        collected.append(instrument)
        Path(output_path).write_text(
            "timestamp,open,high,low,close,volume,tick_volume,spread_points,price_digits\n",
            encoding="utf-8",
        )
        return {
            "instrument": instrument,
            "source": "dukascopy_public_datafeed_ticks",
            "row_count": 250,
            "spread_basis": "last_historical_bid_ask_spread_per_closed_minute",
            "dataset_sha256": "abc123",
            "friction_data_complete": True,
        }

    def fake_build(*, m1_path, output_path, instrument):
        del m1_path, instrument
        Path(output_path).write_text("decision_time\n", encoding="utf-8")
        return {
            "friction_data_complete": True,
            "dataset_sha256": "mtf123",
        }

    qualification_cutoff = datetime(2026, 1, 2, 0, 0, tzinfo=UTC)

    def fake_evaluate(datasets, *, report_path, **kwargs):
        del datasets
        assert kwargs["decision_time_before"] == qualification_cutoff
        return _fake_evaluation(report_path)

    monkeypatch.setattr(runner, "collect_dukascopy_m1_corpus", fake_collect)
    monkeypatch.setattr(
        runner,
        "build_multitimeframe_corpus_from_m1_csv",
        fake_build,
    )
    monkeypatch.setattr(runner, "evaluate_multi_pair_corpora", fake_evaluate)
    monkeypatch.setattr(
        runner,
        "_research_qualification_cutoff",
        lambda corpora: qualification_cutoff,
    )

    result = runner.run_first_six_pair_study(
        output_dir=tmp_path / "research",
        source="dukascopy",
        target_rows=250,
        horizons=(5,),
    )

    assert collected == ["EURUSD"]
    assert result["data_source"] == "dukascopy"
    assert (
        result["label_selection_policy"]
        == MULTITIMEFRAME_LABEL_SELECTION_POLICY
    )
    assert result["collection_manifests"]["EURUSD"]["source"] == (
        "dukascopy_public_datafeed_ticks"
    )
    assert Path(result["summary_path"]).is_file()
    assert result["qualification_window"]["research_fraction"] == 0.80
    assert result["qualification_window"]["decision_time_before"] == (
        qualification_cutoff.isoformat()
    )


def test_metaapi_source_remains_fail_closed_without_credentials(tmp_path: Path):
    with pytest.raises(ValueError, match="internal_api_key"):
        runner.run_first_six_pair_study(
            output_dir=tmp_path / "research",
            source="metaapi",
            target_rows=250,
            horizons=(5,),
        )



def test_six_pair_runner_rejects_future_profitability_row_filter(tmp_path: Path):
    with pytest.raises(ValueError, match="future-profitability"):
        runner.run_first_six_pair_study(
            output_dir=tmp_path / "research",
            source="dukascopy",
            target_rows=250,
            horizons=(5,),
            min_net_return_bps=0.1,
        )
