"""Tests for six-pair research source selection."""
from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

import pytest

from app.domain.models.multitimeframe_features import (
    MULTITIMEFRAME_BACKTEST_POLICY,
    MULTITIMEFRAME_LABEL_SELECTION_POLICY,
    MULTITIMEFRAME_RESEARCH_VALIDATION_POLICY,
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
    capsys: pytest.CaptureFixture[str],
):
    monkeypatch.setattr(runner, "INITIAL_FOREX_UNIVERSE", ("EURUSD",))
    monkeypatch.setenv("IREXPRO_RESEARCH_PROGRESS", "1")

    collected: list[str] = []
    observed_lookbacks: list[int] = []

    def fake_collect(
        *,
        instrument: str,
        target_rows: int,
        output_path,
        now=None,
        cache_dir=None,
        max_lookback_days=90,
    ):
        del target_rows, now, cache_dir
        collected.append(instrument)
        observed_lookbacks.append(max_lookback_days)
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
        dukascopy_max_lookback_days=180,
        target_rows=250,
        horizons=(5,),
    )

    assert collected == ["EURUSD"]
    assert observed_lookbacks == [180]
    assert result["data_source"] == "dukascopy"
    assert (
        result["label_selection_policy"]
        == MULTITIMEFRAME_LABEL_SELECTION_POLICY
    )
    assert (
        result["backtest_evaluation_policy"]
        == MULTITIMEFRAME_BACKTEST_POLICY
    )
    assert (
        result["research_validation_policy"]
        == MULTITIMEFRAME_RESEARCH_VALIDATION_POLICY
    )
    assert result["collection_manifests"]["EURUSD"]["source"] == (
        "dukascopy_public_datafeed_ticks"
    )
    assert Path(result["summary_path"]).is_file()
    assert result["qualification_window"]["research_fraction"] == 0.80
    assert result["qualification_window"]["decision_time_before"] == (
        qualification_cutoff.isoformat()
    )

    progress = capsys.readouterr().err
    assert "RESEARCH_PROGRESS stage=collect instrument=EURUSD status=started" in progress
    assert "RESEARCH_PROGRESS stage=collect instrument=EURUSD status=completed" in progress
    assert "RESEARCH_PROGRESS stage=mtf_build instrument=EURUSD status=completed" in progress
    assert "RESEARCH_PROGRESS stage=horizon horizon=5m status=completed" in progress
    assert "RESEARCH_PROGRESS stage=study status=completed" in progress


def test_six_pair_runner_rejects_invalid_dukascopy_lookback(tmp_path: Path):
    with pytest.raises(ValueError, match="dukascopy_max_lookback_days"):
        runner.run_first_six_pair_study(
            output_dir=tmp_path / "research",
            source="dukascopy",
            dukascopy_max_lookback_days=1,
            target_rows=250,
            horizons=(5,),
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



def test_resume_reuses_verified_pair_and_horizon_checkpoints(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setattr(runner, "INITIAL_FOREX_UNIVERSE", ("EURUSD",))
    monkeypatch.setenv(
        "IREXPRO_RESEARCH_CANDIDATE_SHA",
        "a" * 40,
    )

    calls = {"collect": 0, "build": 0, "evaluate": 0}
    observed_before: list[datetime | None] = []

    def fake_collect(
        *,
        instrument: str,
        target_rows: int,
        output_path,
        now=None,
        cache_dir=None,
        max_lookback_days=90,
    ):
        del target_rows, cache_dir, max_lookback_days
        calls["collect"] += 1
        observed_before.append(now)
        frame = "timestamp,open,high,low,close,volume,tick_volume,spread_points,price_digits\n"
        Path(output_path).write_text(frame, encoding="utf-8")
        return {
            "instrument": instrument,
            "source": "dukascopy_public_datafeed_ticks",
            "row_count": 250,
            "dataset_sha256": "raw-dataset",
            "friction_data_complete": True,
        }

    def fake_build(*, m1_path, output_path, instrument):
        del m1_path, instrument
        calls["build"] += 1
        Path(output_path).write_text(
            "decision_time\n2026-01-01T00:00:00Z\n",
            encoding="utf-8",
        )
        return {
            "friction_data_complete": True,
            "dataset_sha256": "corpus-dataset",
            "row_count": 250,
        }

    qualification_cutoff = datetime(2026, 1, 2, 0, 0, tzinfo=UTC)

    def fake_evaluate(datasets, *, report_path, predictions_path=None, **kwargs):
        del datasets, kwargs
        calls["evaluate"] += 1
        report = _fake_evaluation(report_path)
        report_path = Path(report_path)
        report_path.write_text(
            runner.json.dumps(
                {key: value for key, value in report.items() if key != "report_path"},
                indent=2,
                sort_keys=True,
            ),
            encoding="utf-8",
        )
        predictions = Path(predictions_path)
        predictions.parent.mkdir(parents=True, exist_ok=True)
        predictions.write_text(
            "decision_time,instrument,target,long_net_return,short_net_return,"
            "m1_spread_bps,positive_probability,predicted_long,confidence,"
            "active_trade,selected_net_return,fold\n"
            "2026-01-01T00:00:00Z,EURUSD,1,0.001,-0.001,0.8,0.7,"
            "True,0.7,True,0.001,1\n",
            encoding="utf-8",
        )
        return {
            **report,
            "validation_predictions_path": str(predictions),
        }

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

    output = tmp_path / "research"
    first = runner.run_first_six_pair_study(
        output_dir=output,
        source="dukascopy",
        target_rows=250,
        horizons=(5,),
        resume=True,
    )
    second = runner.run_first_six_pair_study(
        output_dir=output,
        source="dukascopy",
        target_rows=250,
        horizons=(5,),
        resume=True,
    )

    assert Path(first["summary_path"]).is_file()
    assert Path(second["summary_path"]).is_file()
    assert calls == {"collect": 1, "build": 1, "evaluate": 1}
    assert len(observed_before) == 1
    state = runner._read_json(output / "checkpoints" / "study-state.json")
    assert state is not None
    assert state["candidate_sha"] == "a" * 40
    assert state["study_complete"] is True


def test_resume_rejects_incompatible_candidate_checkpoint(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setattr(runner, "INITIAL_FOREX_UNIVERSE", ("EURUSD",))
    monkeypatch.setenv("IREXPRO_RESEARCH_CANDIDATE_SHA", "a" * 40)

    output = tmp_path / "research"
    checkpoint = output / "checkpoints" / "study-state.json"
    runner._write_json_atomic(
        checkpoint,
        {
            "state_version": runner.RESUME_STATE_VERSION,
            "resume_fingerprint": "wrong",
            "candidate_sha": "b" * 40,
            "effective_before": "2026-01-01T00:00:00+00:00",
            "study_complete": False,
        },
    )

    with pytest.raises(ValueError, match="incompatible"):
        runner.run_first_six_pair_study(
            output_dir=output,
            source="dukascopy",
            target_rows=250,
            horizons=(5,),
            resume=True,
        )
