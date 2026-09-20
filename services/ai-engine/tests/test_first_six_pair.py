"""Tests for the first six-pair real-data research runner."""
from __future__ import annotations

from pathlib import Path

import app.domain.training.run_first_six_pair as study


def test_dukascopy_runner_passes_configured_lookback(tmp_path: Path, monkeypatch):
    collected: list[tuple[str, int]] = []

    def fake_collect(*, instrument, output_path, max_lookback_days, **_kwargs):
        collected.append((instrument, max_lookback_days))
        path = Path(output_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("timestamp,open,high,low,close,volume\n", encoding="utf-8")
        return {
            "instrument": instrument,
            "timeframe": "M1",
            "row_count": 250,
            "dataset_path": str(path),
            "manifest_path": str(path.with_suffix(".manifest.json")),
            "dataset_sha256": "a" * 64,
            "friction_data_complete": True,
        }

    def fake_build(*, output_path, instrument, **_kwargs):
        path = Path(output_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("decision_time\n", encoding="utf-8")
        return {
            "instrument": instrument,
            "friction_data_complete": True,
            "output_path": str(path),
        }

    def fake_evaluate(_corpora, *, horizon_bars, report_path, **_kwargs):
        path = Path(report_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("{}", encoding="utf-8")
        return {
            "report_path": str(path),
            "overall": {
                "classification": {"balanced_accuracy": 0.53},
                "trading": {
                    "total_return": 0.01,
                    "sharpe_ratio": 1.1,
                    "profit_factor": 1.2,
                    "max_drawdown": 0.05,
                },
            },
            "by_instrument": {
                pair: {"trading": {"total_return": 0.01}}
                for pair in study.INITIAL_FOREX_UNIVERSE
            },
            "folds": [
                {"aggregate": {"trading": {"total_return": 0.01}}}
                for _ in range(3)
            ],
            "fold_count": 3,
            "walk_forward": {"horizon_bars": horizon_bars},
        }

    monkeypatch.setattr(study, "collect_dukascopy_m1_corpus", fake_collect)
    monkeypatch.setattr(study, "build_multitimeframe_corpus_from_m1_csv", fake_build)
    monkeypatch.setattr(study, "evaluate_multi_pair_corpora", fake_evaluate)

    result = study.run_first_six_pair_study(
        output_dir=tmp_path,
        source="dukascopy",
        target_rows=250,
        dukascopy_max_lookback_days=420,
        horizons=(1,),
        max_splits=3,
    )

    assert len(collected) == len(study.INITIAL_FOREX_UNIVERSE)
    assert all(days == 420 for _instrument, days in collected)
    assert result["dukascopy_max_lookback_days"] == 420
    assert result["governance"]["automatic_staging_promotion"] is False
    assert result["governance"]["automatic_live_promotion"] is False


def test_dukascopy_runner_rejects_too_short_lookback(tmp_path: Path):
    try:
        study.run_first_six_pair_study(
            output_dir=tmp_path,
            source="dukascopy",
            target_rows=250,
            dukascopy_max_lookback_days=1,
        )
    except ValueError as exc:
        assert "dukascopy_max_lookback_days" in str(exc)
    else:
        raise AssertionError("Expected invalid lookback to fail closed")
