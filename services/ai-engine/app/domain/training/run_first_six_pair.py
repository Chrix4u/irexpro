"""One-command first six-pair causal/friction-aware XGBoost research run."""
from __future__ import annotations

import argparse
import json
import os
from datetime import datetime
from pathlib import Path
from typing import Any

from app.domain.training.collect_historical import collect_historical_corpus
from app.domain.training.multitimeframe_corpus import (
    build_multitimeframe_corpus_from_m1_csv,
)
from app.domain.training.train_multitimeframe import (
    INITIAL_FOREX_UNIVERSE,
    evaluate_multi_pair_corpora,
)

DEFAULT_HORIZONS = (1, 5, 10)
DEFAULT_RESEARCH_GATE = {
    "min_balanced_accuracy": 0.52,
    "min_sharpe_ratio": 1.0,
    "min_profit_factor": 1.15,
    "max_drawdown": 0.12,
    "min_positive_fold_fraction": 0.60,
    "min_positive_instrument_fraction": 0.67,
}


def _research_gate(report: dict[str, Any]) -> dict[str, Any]:
    overall = report["overall"]
    classification = overall["classification"]
    trading = overall["trading"]
    folds = report["folds"]
    by_instrument = report["by_instrument"]

    positive_folds = sum(
        1
        for fold in folds
        if float(fold["aggregate"]["trading"]["total_return"]) > 0.0
    )
    positive_instruments = sum(
        1
        for metrics in by_instrument.values()
        if float(metrics["trading"]["total_return"]) > 0.0
    )
    fold_fraction = positive_folds / len(folds) if folds else 0.0
    instrument_fraction = (
        positive_instruments / len(by_instrument) if by_instrument else 0.0
    )

    values = {
        "balanced_accuracy": classification["balanced_accuracy"],
        "sharpe_ratio": trading["sharpe_ratio"],
        "profit_factor": trading["profit_factor"],
        "max_drawdown": trading["max_drawdown"],
        "positive_fold_fraction": fold_fraction,
        "positive_instrument_fraction": instrument_fraction,
    }
    checks = {
        "balanced_accuracy": (
            values["balanced_accuracy"] is not None
            and values["balanced_accuracy"]
            >= DEFAULT_RESEARCH_GATE["min_balanced_accuracy"]
        ),
        "sharpe_ratio": (
            values["sharpe_ratio"] is not None
            and values["sharpe_ratio"] >= DEFAULT_RESEARCH_GATE["min_sharpe_ratio"]
        ),
        "profit_factor": (
            values["profit_factor"] is not None
            and values["profit_factor"] >= DEFAULT_RESEARCH_GATE["min_profit_factor"]
        ),
        "max_drawdown": (
            values["max_drawdown"] is not None
            and values["max_drawdown"] <= DEFAULT_RESEARCH_GATE["max_drawdown"]
        ),
        "positive_fold_fraction": (
            fold_fraction >= DEFAULT_RESEARCH_GATE["min_positive_fold_fraction"]
        ),
        "positive_instrument_fraction": (
            instrument_fraction
            >= DEFAULT_RESEARCH_GATE["min_positive_instrument_fraction"]
        ),
    }
    return {
        "thresholds": DEFAULT_RESEARCH_GATE,
        "observed": values,
        "checks": checks,
        "research_gate_passed": all(checks.values()),
        "approved_for_staging": False,
        "approved_for_live": False,
        "note": "Passing this research gate requires human review before any staging promotion.",
    }


def run_first_six_pair_study(
    *,
    api_base_url: str,
    internal_api_key: str,
    user_id: str,
    broker_connection_id: str,
    output_dir: str | Path,
    target_rows: int = 250_000,
    horizons: tuple[int, ...] = DEFAULT_HORIZONS,
    before: datetime | None = None,
    confidence_threshold: float = 0.60,
    commission_bps: float = 0.0,
    slippage_bps: float = 0.0,
    min_net_return_bps: float = 0.0,
    max_splits: int = 5,
) -> dict[str, Any]:
    """Collect, build and evaluate the approved initial six-pair universe."""
    if not internal_api_key.strip():
        raise ValueError("internal_api_key is required")
    if target_rows < 250:
        raise ValueError("target_rows must be at least 250")
    if not horizons or any(horizon < 1 for horizon in horizons):
        raise ValueError("horizons must contain positive M1 bar counts")

    root = Path(output_dir)
    raw_dir = root / "raw"
    corpus_dir = root / "corpora"
    report_dir = root / "reports"
    for directory in (raw_dir, corpus_dir, report_dir):
        directory.mkdir(parents=True, exist_ok=True)

    corpora: dict[str, str] = {}
    collection_manifests: dict[str, dict[str, Any]] = {}
    corpus_manifests: dict[str, dict[str, Any]] = {}

    for instrument in INITIAL_FOREX_UNIVERSE:
        raw_path = raw_dir / f"{instrument}_M1.csv"
        collection = collect_historical_corpus(
            api_base_url=api_base_url,
            internal_api_key=internal_api_key,
            user_id=user_id,
            broker_connection_id=broker_connection_id,
            instrument=instrument,
            timeframe="M1",
            target_rows=target_rows,
            output_path=raw_path,
            before=before,
            require_friction=True,
        )
        collection_manifests[instrument] = {
            key: value
            for key, value in collection.items()
            if key not in {"broker_connection_id"}
        }

        corpus_path = corpus_dir / f"{instrument}_MTF.csv"
        corpus = build_multitimeframe_corpus_from_m1_csv(
            m1_path=raw_path,
            output_path=corpus_path,
            instrument=instrument,
        )
        if not corpus["friction_data_complete"]:
            raise ValueError(f"{instrument} MTF corpus lost friction metadata")
        corpus_manifests[instrument] = corpus
        corpora[instrument] = str(corpus_path)

    horizon_reports: dict[str, Any] = {}
    for horizon in horizons:
        report = evaluate_multi_pair_corpora(
            corpora,
            horizon_bars=horizon,
            report_path=report_dir / f"six_pair_walkforward_{horizon}m.json",
            confidence_threshold=confidence_threshold,
            min_net_return_bps=min_net_return_bps,
            commission_bps=commission_bps,
            slippage_bps=slippage_bps,
            max_splits=max_splits,
        )
        horizon_reports[f"{horizon}m"] = {
            "report_path": report["report_path"],
            "overall": report["overall"],
            "by_instrument": report["by_instrument"],
            "fold_count": report["fold_count"],
            "walk_forward": report["walk_forward"],
            "research_gate": _research_gate(report),
        }

    summary = {
        "report_version": 1,
        "study": "irexpro_initial_six_pair_multitimeframe_walkforward",
        "instruments": list(INITIAL_FOREX_UNIVERSE),
        "horizons_minutes": list(horizons),
        "target_m1_rows_per_instrument": target_rows,
        "cost_model": {
            "historical_spread_required": True,
            "commission_bps_round_trip": commission_bps,
            "slippage_bps_round_trip": slippage_bps,
            "minimum_net_return_bps_for_label": min_net_return_bps,
        },
        "collection_manifests": collection_manifests,
        "corpus_manifests": corpus_manifests,
        "horizon_reports": horizon_reports,
        "governance": {
            "automatic_staging_promotion": False,
            "automatic_live_promotion": False,
        },
    }
    summary_path = report_dir / "six_pair_walkforward_summary.json"
    summary_path.write_text(json.dumps(summary, indent=2, sort_keys=True), encoding="utf-8")
    return {**summary, "summary_path": str(summary_path)}


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Collect and evaluate the first six-pair iRexPro XGBoost research corpus"
    )
    parser.add_argument("--api-base-url", required=True)
    parser.add_argument("--user-id", required=True)
    parser.add_argument("--broker-connection-id", required=True)
    parser.add_argument("--output-dir", default="research/first-six-pair-run")
    parser.add_argument("--target-rows", type=int, default=250_000)
    parser.add_argument(
        "--horizons",
        default="1,5,10",
        help="Comma-separated M1 horizons, default: 1,5,10",
    )
    parser.add_argument("--before")
    parser.add_argument("--confidence-threshold", type=float, default=0.60)
    parser.add_argument("--commission-bps", type=float, default=0.0)
    parser.add_argument("--slippage-bps", type=float, default=0.0)
    parser.add_argument("--min-net-return-bps", type=float, default=0.0)
    parser.add_argument("--max-splits", type=int, default=5)
    args = parser.parse_args()

    internal_api_key = os.getenv("NESTJS_INTERNAL_API_KEY", "")
    horizons = tuple(
        int(value.strip()) for value in args.horizons.split(",") if value.strip()
    )
    before = (
        datetime.fromisoformat(args.before.replace("Z", "+00:00"))
        if args.before
        else None
    )
    result = run_first_six_pair_study(
        api_base_url=args.api_base_url,
        internal_api_key=internal_api_key,
        user_id=args.user_id,
        broker_connection_id=args.broker_connection_id,
        output_dir=args.output_dir,
        target_rows=args.target_rows,
        horizons=horizons,
        before=before,
        confidence_threshold=args.confidence_threshold,
        commission_bps=args.commission_bps,
        slippage_bps=args.slippage_bps,
        min_net_return_bps=args.min_net_return_bps,
        max_splits=args.max_splits,
    )
    print(json.dumps(result, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
