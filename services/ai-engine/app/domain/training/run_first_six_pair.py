"""One-command first six-pair causal/friction-aware XGBoost research run."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pandas as pd

from app.domain.models.multitimeframe_features import (
    MULTITIMEFRAME_BACKTEST_POLICY,
    MULTITIMEFRAME_LABEL_SELECTION_POLICY,
    MULTITIMEFRAME_RESEARCH_VALIDATION_POLICY,
)
from app.domain.training.collect_dukascopy import collect_dukascopy_m1_corpus
from app.domain.training.collect_historical import collect_historical_corpus
from app.domain.training.multitimeframe_corpus import (
    build_multitimeframe_corpus_from_m1_csv,
)
from app.domain.training.train_multitimeframe import (
    INITIAL_FOREX_UNIVERSE,
    evaluate_multi_pair_corpora,
)

DEFAULT_HORIZONS = (1, 5, 10)
RESEARCH_QUALIFICATION_FRACTION = 0.80
RESEARCH_PROGRESS_ENV = "IREXPRO_RESEARCH_PROGRESS"
RESEARCH_CANDIDATE_SHA_ENV = "IREXPRO_RESEARCH_CANDIDATE_SHA"
RESUME_STATE_VERSION = 1


def _stable_hash(payload: Any) -> str:
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, default=str).encode("utf-8")
    ).hexdigest()


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _write_json_atomic(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(payload, indent=2, sort_keys=True, default=str),
        encoding="utf-8",
    )
    temporary.replace(path)


def _read_json(path: Path) -> dict[str, Any] | None:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None
    return payload if isinstance(payload, dict) else None


def _research_progress(message: str) -> None:
    enabled = os.getenv(RESEARCH_PROGRESS_ENV, "").strip().lower()
    if enabled in {"1", "true", "yes", "on"}:
        print(f"RESEARCH_PROGRESS {message}", file=sys.stderr, flush=True)


DEFAULT_RESEARCH_GATE = {
    "min_balanced_accuracy": 0.52,
    "min_sharpe_ratio": 1.0,
    "min_profit_factor": 1.15,
    "max_drawdown": 0.12,
    "min_positive_fold_fraction": 0.60,
    "min_positive_instrument_fraction": 0.67,
}



def _research_qualification_cutoff(
    corpora: dict[str, str | Path],
    *,
    fraction: float = RESEARCH_QUALIFICATION_FRACTION,
) -> pd.Timestamp:
    """Return an exclusive time cutoff that reserves a future tail from research."""
    if not 0.60 <= fraction <= 0.85:
        raise ValueError("research qualification fraction must be in [0.60, 0.85]")
    if not corpora:
        raise ValueError("At least one corpus is required for qualification cutoff")

    time_indexes: list[pd.Series] = []
    for raw_path in corpora.values():
        times = pd.read_csv(raw_path, usecols=["decision_time"])["decision_time"]
        parsed = pd.to_datetime(times, utc=True, errors="coerce")
        if parsed.isna().any():
            raise ValueError("Corpus contains invalid decision_time values")
        time_indexes.append(parsed)

    all_times = pd.Index(
        sorted(pd.concat(time_indexes, ignore_index=True).drop_duplicates())
    )
    if len(all_times) < 500:
        raise ValueError(
            "At least 500 unique decision periods are required to reserve "
            "an untouched future test tail"
        )

    cutoff_index = int(len(all_times) * fraction)
    if cutoff_index <= 250 or cutoff_index >= len(all_times):
        raise ValueError("Invalid research qualification cutoff")
    return pd.Timestamp(all_times[cutoff_index])



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
        "note": (
            "Passing this research gate is necessary but not sufficient for paper/UAT "
            "promotion; the final untouched-test gate must also pass. Live approval "
            "remains prohibited."
        ),
    }


def run_first_six_pair_study(
    *,
    output_dir: str | Path,
    source: str = "dukascopy",
    api_base_url: str | None = None,
    internal_api_key: str = "",
    user_id: str | None = None,
    broker_connection_id: str | None = None,
    dukascopy_cache_dir: str | Path | None = None,
    dukascopy_max_lookback_days: int = 90,
    target_rows: int = 250_000,
    horizons: tuple[int, ...] = DEFAULT_HORIZONS,
    before: datetime | None = None,
    confidence_threshold: float = 0.60,
    commission_bps: float = 0.0,
    slippage_bps: float = 0.0,
    min_net_return_bps: float = 0.0,
    max_splits: int = 5,
    resume: bool = False,
) -> dict[str, Any]:
    """Collect, build and evaluate the approved initial six-pair universe."""
    normalized_source = source.strip().lower()
    if normalized_source not in {"dukascopy", "metaapi"}:
        raise ValueError("source must be either 'dukascopy' or 'metaapi'")
    if normalized_source == "metaapi":
        if not internal_api_key.strip():
            raise ValueError("internal_api_key is required for metaapi source")
        if not api_base_url or not user_id or not broker_connection_id:
            raise ValueError(
                "api_base_url, user_id and broker_connection_id are required "
                "for metaapi source"
            )
    if target_rows < 250:
        raise ValueError("target_rows must be at least 250")
    if dukascopy_max_lookback_days < 2:
        raise ValueError("dukascopy_max_lookback_days must be at least 2")
    if min_net_return_bps != 0:
        raise ValueError(
            "min_net_return_bps must be 0 because future-profitability row "
            "selection is prohibited"
        )
    if not horizons or any(horizon < 1 for horizon in horizons):
        raise ValueError("horizons must contain positive M1 bar counts")

    root = Path(output_dir)
    raw_dir = root / "raw"
    corpus_dir = root / "corpora"
    report_dir = root / "reports"
    checkpoint_dir = root / "checkpoints"
    for directory in (raw_dir, corpus_dir, report_dir):
        directory.mkdir(parents=True, exist_ok=True)
    if resume:
        checkpoint_dir.mkdir(parents=True, exist_ok=True)

    candidate_sha = os.getenv(RESEARCH_CANDIDATE_SHA_ENV, "").strip() or None
    requested_before = before.isoformat() if before is not None else None
    resume_config = {
        "state_version": RESUME_STATE_VERSION,
        "candidate_sha": candidate_sha,
        "source": normalized_source,
        "dukascopy_max_lookback_days": dukascopy_max_lookback_days,
        "target_rows": target_rows,
        "horizons": list(horizons),
        "requested_before": requested_before,
        "confidence_threshold": confidence_threshold,
        "commission_bps": commission_bps,
        "slippage_bps": slippage_bps,
        "min_net_return_bps": min_net_return_bps,
        "max_splits": max_splits,
        "instruments": list(INITIAL_FOREX_UNIVERSE),
    }
    resume_fingerprint = _stable_hash(resume_config)
    state_path = checkpoint_dir / "study-state.json"
    effective_before = before

    if resume:
        existing_state = _read_json(state_path) if state_path.is_file() else None
        if existing_state is not None:
            if existing_state.get("resume_fingerprint") != resume_fingerprint:
                raise ValueError(
                    "Existing research checkpoint is incompatible with the current "
                    "candidate/configuration; refusing to mix research states"
                )
            stored_before = existing_state.get("effective_before")
            if not isinstance(stored_before, str) or not stored_before:
                raise ValueError("Existing research checkpoint is missing effective_before")
            effective_before = datetime.fromisoformat(
                stored_before.replace("Z", "+00:00")
            )
            _research_progress(
                "stage=resume status=loaded "
                f"candidate={candidate_sha or 'unknown'} "
                f"effective_before={effective_before.isoformat()}"
            )
        else:
            effective_before = before or datetime.now(UTC)
            _write_json_atomic(
                state_path,
                {
                    "state_version": RESUME_STATE_VERSION,
                    "resume_fingerprint": resume_fingerprint,
                    "candidate_sha": candidate_sha,
                    "effective_before": effective_before.isoformat(),
                    "study_complete": False,
                },
            )
            _research_progress(
                "stage=resume status=initialized "
                f"candidate={candidate_sha or 'unknown'} "
                f"effective_before={effective_before.isoformat()}"
            )

    corpora: dict[str, str] = {}
    collection_manifests: dict[str, dict[str, Any]] = {}
    corpus_manifests: dict[str, dict[str, Any]] = {}
    corpus_file_hashes: dict[str, str] = {}
    study_started = time.monotonic()

    for instrument in INITIAL_FOREX_UNIVERSE:
        instrument_started = time.monotonic()
        raw_path = raw_dir / f"{instrument}_M1.csv"
        corpus_path = corpus_dir / f"{instrument}_MTF.csv"
        pair_checkpoint_path = checkpoint_dir / "pairs" / f"{instrument}.json"

        if resume and pair_checkpoint_path.is_file():
            pair_checkpoint = _read_json(pair_checkpoint_path)
            if (
                pair_checkpoint is not None
                and pair_checkpoint.get("resume_fingerprint") == resume_fingerprint
                and raw_path.is_file()
                and corpus_path.is_file()
                and pair_checkpoint.get("raw_sha256") == _sha256_file(raw_path)
                and pair_checkpoint.get("corpus_sha256") == _sha256_file(corpus_path)
                and isinstance(pair_checkpoint.get("collection_manifest"), dict)
                and isinstance(pair_checkpoint.get("corpus_manifest"), dict)
            ):
                collection = dict(pair_checkpoint["collection_manifest"])
                corpus = dict(pair_checkpoint["corpus_manifest"])
                if not corpus.get("friction_data_complete"):
                    raise ValueError(
                        f"{instrument} resumed MTF corpus lost friction metadata"
                    )
                collection_manifests[instrument] = collection
                corpus_manifests[instrument] = corpus
                corpora[instrument] = str(corpus_path)
                corpus_file_hashes[instrument] = str(
                    pair_checkpoint["corpus_sha256"]
                )
                _research_progress(
                    f"stage=pair instrument={instrument} status=resumed "
                    f"rows={collection.get('row_count', 'unknown')}"
                )
                continue

        _research_progress(
            f"stage=collect instrument={instrument} status=started "
            f"source={normalized_source} target_rows={target_rows}"
        )
        if normalized_source == "dukascopy":
            collection = collect_dukascopy_m1_corpus(
                instrument=instrument,
                target_rows=target_rows,
                output_path=raw_path,
                now=effective_before,
                cache_dir=dukascopy_cache_dir,
                max_lookback_days=dukascopy_max_lookback_days,
            )
        else:
            collection = collect_historical_corpus(
                api_base_url=str(api_base_url),
                internal_api_key=internal_api_key,
                user_id=str(user_id),
                broker_connection_id=str(broker_connection_id),
                instrument=instrument,
                timeframe="M1",
                target_rows=target_rows,
                output_path=raw_path,
                before=effective_before,
                require_friction=True,
            )
        collection_manifests[instrument] = {
            key: value
            for key, value in collection.items()
            if key not in {"broker_connection_id"}
        }
        _research_progress(
            " ".join(
                [
                    "stage=collect",
                    f"instrument={instrument}",
                    "status=completed",
                    f"rows={collection.get('row_count', 'unknown')}",
                    f"hours_requested={collection.get('hours_requested', 'unknown')}",
                    f"bytes_downloaded={collection.get('bytes_downloaded', 'unknown')}",
                    f"elapsed_seconds={time.monotonic() - instrument_started:.1f}",
                ]
            )
        )

        corpus_started = time.monotonic()
        _research_progress(
            f"stage=mtf_build instrument={instrument} status=started "
            "timeframes=M1,M5,M15,H1,H4"
        )
        corpus = build_multitimeframe_corpus_from_m1_csv(
            m1_path=raw_path,
            output_path=corpus_path,
            instrument=instrument,
        )
        if not corpus["friction_data_complete"]:
            raise ValueError(f"{instrument} MTF corpus lost friction metadata")
        corpus_manifests[instrument] = corpus
        corpora[instrument] = str(corpus_path)
        raw_sha256 = _sha256_file(raw_path)
        corpus_sha256 = _sha256_file(corpus_path)
        corpus_file_hashes[instrument] = corpus_sha256
        if resume:
            _write_json_atomic(
                pair_checkpoint_path,
                {
                    "checkpoint_version": 1,
                    "resume_fingerprint": resume_fingerprint,
                    "instrument": instrument,
                    "raw_sha256": raw_sha256,
                    "corpus_sha256": corpus_sha256,
                    "collection_manifest": collection_manifests[instrument],
                    "corpus_manifest": corpus_manifests[instrument],
                },
            )
        _research_progress(
            " ".join(
                [
                    "stage=mtf_build",
                    f"instrument={instrument}",
                    "status=completed",
                    f"rows={corpus.get('row_count', 'unknown')}",
                    f"elapsed_seconds={time.monotonic() - corpus_started:.1f}",
                ]
            )
        )

    qualification_cutoff = _research_qualification_cutoff(corpora)

    horizon_reports: dict[str, Any] = {}
    for horizon in horizons:
        horizon_started = time.monotonic()
        report_path = report_dir / f"six_pair_walkforward_{horizon}m.json"
        predictions_path = (
            report_dir / f"six_pair_walkforward_{horizon}m_predictions.csv"
        )
        horizon_checkpoint_path = (
            checkpoint_dir / "horizons" / f"{horizon}m.json"
        )
        horizon_fingerprint = _stable_hash(
            {
                "resume_fingerprint": resume_fingerprint,
                "horizon": horizon,
                "qualification_cutoff": qualification_cutoff.isoformat(),
                "corpus_sha256": corpus_file_hashes,
            }
        )

        report = None
        if (
            resume
            and horizon_checkpoint_path.is_file()
            and report_path.is_file()
            and predictions_path.is_file()
        ):
            horizon_checkpoint = _read_json(horizon_checkpoint_path)
            if (
                horizon_checkpoint is not None
                and horizon_checkpoint.get("horizon_fingerprint")
                == horizon_fingerprint
                and horizon_checkpoint.get("report_sha256")
                == _sha256_file(report_path)
                and horizon_checkpoint.get("predictions_sha256")
                == _sha256_file(predictions_path)
            ):
                loaded_report = _read_json(report_path)
                if loaded_report is not None:
                    report = {
                        **loaded_report,
                        "report_path": str(report_path),
                    }
                    _research_progress(
                        f"stage=horizon horizon={horizon}m status=resumed "
                        f"folds={report.get('fold_count', 'unknown')}"
                    )

        if report is None:
            _research_progress(
                f"stage=horizon horizon={horizon}m status=started "
                f"max_splits={max_splits}"
            )
            report = evaluate_multi_pair_corpora(
                corpora,
                horizon_bars=horizon,
                report_path=report_path,
                confidence_threshold=confidence_threshold,
                min_net_return_bps=min_net_return_bps,
                commission_bps=commission_bps,
                slippage_bps=slippage_bps,
                max_splits=max_splits,
                decision_time_before=qualification_cutoff,
                predictions_path=predictions_path,
                checkpoint_dir=(
                    checkpoint_dir / "folds" / f"{horizon}m"
                    if resume
                    else None
                ),
            )
            if resume:
                _write_json_atomic(
                    horizon_checkpoint_path,
                    {
                        "checkpoint_version": 1,
                        "horizon_fingerprint": horizon_fingerprint,
                        "report_sha256": _sha256_file(report_path),
                        "predictions_sha256": _sha256_file(predictions_path),
                    },
                )

        research_gate = _research_gate(report)
        horizon_reports[f"{horizon}m"] = {
            "report_path": report["report_path"],
            "validation_predictions_path": report.get("validation_predictions_path"),
            "overall": report["overall"],
            "by_instrument": report["by_instrument"],
            "fold_count": report["fold_count"],
            "walk_forward": report["walk_forward"],
            "research_gate": research_gate,
        }
        _research_progress(
            " ".join(
                [
                    "stage=horizon",
                    f"horizon={horizon}m",
                    "status=completed",
                    f"folds={report['fold_count']}",
                    f"gate={'PASS' if research_gate['research_gate_passed'] else 'HOLD'}",
                    f"elapsed_seconds={time.monotonic() - horizon_started:.1f}",
                ]
            )
        )

    summary = {
        "report_version": 2,
        "study": "irexpro_initial_six_pair_multitimeframe_walkforward",
        "data_source": normalized_source,
        "instruments": list(INITIAL_FOREX_UNIVERSE),
        "horizons_minutes": list(horizons),
        "target_m1_rows_per_instrument": target_rows,
        "dukascopy_max_lookback_days": (
            dukascopy_max_lookback_days if normalized_source == "dukascopy" else None
        ),
        "label_selection_policy": MULTITIMEFRAME_LABEL_SELECTION_POLICY,
        "backtest_evaluation_policy": MULTITIMEFRAME_BACKTEST_POLICY,
        "research_validation_policy": MULTITIMEFRAME_RESEARCH_VALIDATION_POLICY,
        "qualification_window": {
            "research_fraction": RESEARCH_QUALIFICATION_FRACTION,
            "reserved_future_fraction": 1.0 - RESEARCH_QUALIFICATION_FRACTION,
            "decision_time_before": qualification_cutoff.isoformat(),
            "semantics": (
                "Research and horizon selection may use only decision times before "
                "this exclusive cutoff. The final untouched-test gate must start "
                "at or after this cutoff."
            ),
        },
        "cost_model": {
            "historical_spread_required": True,
            "commission_bps_round_trip": commission_bps,
            "slippage_bps_round_trip": slippage_bps,
            "minimum_net_return_bps_for_label": min_net_return_bps,
            "future_profitability_row_filtering": "prohibited",
        },
        "collection_manifests": collection_manifests,
        "corpus_manifests": corpus_manifests,
        "horizon_reports": horizon_reports,
        "governance": {
            "paper_uat_promotion": (
                "eligible_only_after_research_gate_and_untouched_test_gate"
            ),
            "automatic_live_promotion": False,
        },
    }
    summary_path = report_dir / "six_pair_walkforward_summary.json"
    _write_json_atomic(summary_path, summary)
    if resume:
        _write_json_atomic(
            state_path,
            {
                "state_version": RESUME_STATE_VERSION,
                "resume_fingerprint": resume_fingerprint,
                "candidate_sha": candidate_sha,
                "effective_before": effective_before.isoformat()
                if effective_before is not None
                else None,
                "study_complete": True,
                "summary_sha256": _sha256_file(summary_path),
            },
        )
    _research_progress(
        f"stage=study status=completed elapsed_seconds={time.monotonic() - study_started:.1f}"
    )
    return {**summary, "summary_path": str(summary_path)}


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Collect and evaluate the first six-pair iRexPro XGBoost research corpus"
    )
    parser.add_argument(
        "--source",
        choices=("dukascopy", "metaapi"),
        default="dukascopy",
        help="Historical corpus source. Default: dukascopy",
    )
    parser.add_argument("--api-base-url")
    parser.add_argument("--user-id")
    parser.add_argument("--broker-connection-id")
    parser.add_argument("--dukascopy-cache-dir")
    parser.add_argument("--dukascopy-max-lookback-days", type=int, default=90)
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
    parser.add_argument(
        "--resume",
        action="store_true",
        help="Reuse verified same-candidate pair, horizon, and fold checkpoints",
    )
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
        output_dir=args.output_dir,
        source=args.source,
        api_base_url=args.api_base_url,
        internal_api_key=internal_api_key,
        user_id=args.user_id,
        broker_connection_id=args.broker_connection_id,
        dukascopy_cache_dir=args.dukascopy_cache_dir,
        dukascopy_max_lookback_days=args.dukascopy_max_lookback_days,
        target_rows=args.target_rows,
        horizons=horizons,
        before=before,
        confidence_threshold=args.confidence_threshold,
        commission_bps=args.commission_bps,
        slippage_bps=args.slippage_bps,
        min_net_return_bps=args.min_net_return_bps,
        max_splits=args.max_splits,
        resume=args.resume,
    )
    print(json.dumps(result, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
