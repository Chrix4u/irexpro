"""One-command first six-pair causal/friction-aware XGBoost research run.

The study supports two execution modes:

``stage="all"`` (default)
    The original monolithic study: collect/build every pair, evaluate every
    horizon, and assemble the summary in one process.

Staged execution (``--stage init|pairs|horizons|summarize``)
    Bounded, independently resumable stages for GitHub-hosted orchestration,
    where a single job must never depend on surviving more than the runner's
    six-hour job ceiling. Every stage consumes and produces the same verified
    checkpoints as the monolithic path and refuses to mix incompatible
    candidate/config/data states. Staged execution requires ``--resume``.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
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
ORCHESTRATION_PLAN_VERSION = 1
STUDY_STAGES = ("init", "pairs", "horizons", "summarize", "all")
ORCHESTRATION_PLAN_FILENAME = "orchestration-plan.json"


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


def _bootstrap_collection_hour(bootstrap_dir: Path | None) -> datetime | None:
    if bootstrap_dir is None or not bootstrap_dir.is_dir():
        return None
    observed: list[datetime] = []
    for instrument in INITIAL_FOREX_UNIVERSE:
        manifest_path = (
            bootstrap_dir / "raw" / f"{instrument}_M1.manifest.json"
        )
        manifest = _read_json(manifest_path) if manifest_path.is_file() else None
        collected_at = manifest.get("collected_at") if manifest else None
        if not isinstance(collected_at, str):
            continue
        try:
            timestamp = datetime.fromisoformat(collected_at.replace("Z", "+00:00"))
        except ValueError:
            continue
        if timestamp.tzinfo is None:
            timestamp = timestamp.replace(tzinfo=UTC)
        observed.append(timestamp.astimezone(UTC))
    if not observed:
        return None
    earliest = min(observed)
    return earliest


def _validated_bootstrap_pair(
    bootstrap_dir: Path,
    *,
    instrument: str,
    target_rows: int,
    effective_before: datetime,
) -> tuple[Path, Path, dict[str, Any], dict[str, Any]] | None:
    raw_path = bootstrap_dir / "raw" / f"{instrument}_M1.csv"
    raw_manifest_path = raw_path.with_suffix(".manifest.json")
    corpus_path = bootstrap_dir / "corpora" / f"{instrument}_MTF.csv"
    corpus_manifest_path = corpus_path.with_suffix(".manifest.json")
    if not all(
        path.is_file()
        for path in (
            raw_path,
            raw_manifest_path,
            corpus_path,
            corpus_manifest_path,
        )
    ):
        return None

    raw_manifest = _read_json(raw_manifest_path)
    corpus_manifest = _read_json(corpus_manifest_path)
    if raw_manifest is None or corpus_manifest is None:
        return None

    try:
        collected_at = datetime.fromisoformat(
            str(raw_manifest["collected_at"]).replace("Z", "+00:00")
        )
        if collected_at.tzinfo is None:
            collected_at = collected_at.replace(tzinfo=UTC)
        collected_at = collected_at.astimezone(UTC)
    except (KeyError, ValueError):
        return None

    if collected_at.replace(minute=0, second=0, microsecond=0) != (
        effective_before.astimezone(UTC).replace(minute=0, second=0, microsecond=0)
    ):
        return None

    raw_sha256 = _sha256_file(raw_path)
    corpus_sha256 = _sha256_file(corpus_path)
    if (
        raw_manifest.get("instrument") != instrument
        or raw_manifest.get("source") != "dukascopy_public_datafeed_ticks"
        or int(raw_manifest.get("row_count", 0)) != target_rows
        or raw_manifest.get("friction_data_complete") is not True
        or raw_manifest.get("dataset_sha256") != raw_sha256
        or corpus_manifest.get("instrument") != instrument
        or corpus_manifest.get("friction_data_complete") is not True
        or corpus_manifest.get("lookahead_validation") != "passed"
        or corpus_manifest.get("raw_m1_sha256") != raw_sha256
        or corpus_manifest.get("dataset_sha256") != corpus_sha256
        or int(corpus_manifest.get("row_count", 0)) <= 0
    ):
        return None

    return raw_path, corpus_path, raw_manifest, corpus_manifest


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


def _resolve_study_state(
    *,
    resume: bool,
    state_path: Path,
    resume_fingerprint: str,
    candidate_sha: str | None,
    before: datetime | None,
    bootstrap_before: datetime | None,
) -> datetime | None:
    """Load or initialize the frozen ``effective_before`` study cutoff."""
    if not resume:
        return before

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
        return effective_before

    effective_before = before or bootstrap_before or datetime.now(UTC)
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
    return effective_before


def _orchestration_plan_payload(
    *,
    candidate_sha: str | None,
    resume_fingerprint: str,
    effective_before: datetime | None,
    normalized_source: str,
    dukascopy_max_lookback_days: int,
    target_rows: int,
    horizons: tuple[int, ...],
    confidence_threshold: float,
    commission_bps: float,
    slippage_bps: float,
    min_net_return_bps: float,
    max_splits: int,
    bootstrap_root: Path | None,
) -> dict[str, Any]:
    return {
        "plan_version": ORCHESTRATION_PLAN_VERSION,
        "candidate_sha": candidate_sha,
        "resume_fingerprint": resume_fingerprint,
        "effective_before": (
            effective_before.isoformat() if effective_before is not None else None
        ),
        "source": normalized_source,
        "dukascopy_max_lookback_days": dukascopy_max_lookback_days,
        "target_rows": target_rows,
        "horizons": list(horizons),
        "confidence_threshold": confidence_threshold,
        "commission_bps": commission_bps,
        "slippage_bps": slippage_bps,
        "min_net_return_bps": min_net_return_bps,
        "max_splits": max_splits,
        "instruments": list(INITIAL_FOREX_UNIVERSE),
        "bootstrap_dir": str(bootstrap_root) if bootstrap_root is not None else None,
    }


def _verify_orchestration_plan(
    plan_path: Path,
    *,
    expected_resume_fingerprint: str,
    expected_candidate_sha: str | None,
) -> dict[str, Any]:
    """Fail closed unless the persisted stage plan matches this exact study."""
    plan = _read_json(plan_path) if plan_path.is_file() else None
    if plan is None:
        raise ValueError(
            "Staged execution requires an orchestration plan from the init stage; "
            f"missing or unreadable: {plan_path}"
        )
    if plan.get("plan_version") != ORCHESTRATION_PLAN_VERSION:
        raise ValueError("Orchestration plan version is incompatible")
    if plan.get("resume_fingerprint") != expected_resume_fingerprint:
        raise ValueError(
            "Orchestration plan fingerprint does not match the current "
            "candidate/configuration; refusing to mix research states"
        )
    if (
        expected_candidate_sha is not None
        and plan.get("candidate_sha") != expected_candidate_sha
    ):
        raise ValueError(
            "Orchestration plan was initialized for a different candidate SHA; "
            "refusing to mix research states"
        )
    return plan


def _process_instrument(
    instrument: str,
    *,
    root: Path,
    raw_dir: Path,
    corpus_dir: Path,
    checkpoint_dir: Path,
    resume: bool,
    resume_fingerprint: str,
    effective_before: datetime | None,
    normalized_source: str,
    target_rows: int,
    dukascopy_cache_dir: str | Path | None,
    dukascopy_max_lookback_days: int,
    api_base_url: str | None,
    internal_api_key: str,
    user_id: str | None,
    broker_connection_id: str | None,
    bootstrap_root: Path | None,
) -> tuple[dict[str, Any], dict[str, Any], str, str, str]:
    """Collect/build one pair (or resume its verified checkpoint).

    Returns ``(collection_manifest, corpus_manifest, corpus_path,
    corpus_sha256, resume_source)``.
    """
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
            # Data provenance is stable across resumes: it records how the
            # pair's data came to exist, not how this particular run
            # obtained it (this run resumed it from a verified checkpoint).
            resume_source = "bootstrap" if "bootstrap_source" in pair_checkpoint else str(
                pair_checkpoint.get("resume_source", "collected")
            )
            _research_progress(
                f"stage=pair instrument={instrument} status=resumed "
                f"resume_source=checkpoint provenance={resume_source} "
                f"rows={collection.get('row_count', 'unknown')}"
            )
            return collection, corpus, str(corpus_path), str(
                pair_checkpoint["corpus_sha256"]
            ), resume_source

    if (
        resume
        and normalized_source == "dukascopy"
        and bootstrap_root is not None
        and effective_before is not None
    ):
        bootstrapped = _validated_bootstrap_pair(
            bootstrap_root,
            instrument=instrument,
            target_rows=target_rows,
            effective_before=effective_before,
        )
        if bootstrapped is not None:
            (
                bootstrap_raw,
                bootstrap_corpus,
                collection,
                corpus,
            ) = bootstrapped
            raw_path.parent.mkdir(parents=True, exist_ok=True)
            corpus_path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(bootstrap_raw, raw_path)
            shutil.copy2(
                bootstrap_raw.with_suffix(".manifest.json"),
                raw_path.with_suffix(".manifest.json"),
            )
            shutil.copy2(bootstrap_corpus, corpus_path)
            shutil.copy2(
                bootstrap_corpus.with_suffix(".manifest.json"),
                corpus_path.with_suffix(".manifest.json"),
            )
            raw_sha256 = _sha256_file(raw_path)
            corpus_sha256 = _sha256_file(corpus_path)
            if resume:
                _write_json_atomic(
                    pair_checkpoint_path,
                    {
                        "checkpoint_version": 1,
                        "resume_fingerprint": resume_fingerprint,
                        "instrument": instrument,
                        "raw_sha256": raw_sha256,
                        "corpus_sha256": corpus_sha256,
                        "collection_manifest": collection,
                        "corpus_manifest": corpus,
                        "bootstrap_source": str(bootstrap_root),
                        "resume_source": "bootstrap",
                    },
                )
            _research_progress(
                f"stage=pair instrument={instrument} status=bootstrapped "
                f"resume_source=bootstrap "
                f"rows={collection.get('row_count', 'unknown')} "
                f"source={bootstrap_root}"
            )
            return dict(collection), dict(corpus), str(corpus_path), corpus_sha256, (
                "bootstrap"
            )

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
            progress=_research_progress,
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
    collection = {
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
                "resume_source=collected",
                f"rows={collection.get('row_count', 'unknown')}",
                f"hours_requested={collection.get('hours_requested', 'unknown')}",
                f"chunk_hits={collection.get('m1_chunk_hits', 0)}",
                f"chunks_built={collection.get('m1_chunks_built', 0)}",
                f"decode_hours_avoided={collection.get('decode_hours_avoided', 0)}",
                f"raw_cache_hits={collection.get('raw_cache_hits', 0)}",
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
    raw_sha256 = _sha256_file(raw_path)
    corpus_sha256 = _sha256_file(corpus_path)
    if resume:
        _write_json_atomic(
            pair_checkpoint_path,
            {
                "checkpoint_version": 1,
                "resume_fingerprint": resume_fingerprint,
                "instrument": instrument,
                "raw_sha256": raw_sha256,
                "corpus_sha256": corpus_sha256,
                "collection_manifest": collection,
                "corpus_manifest": corpus,
                "resume_source": "collected",
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
    return collection, corpus, str(corpus_path), corpus_sha256, "collected"


def _verified_pair_state(
    *,
    checkpoint_dir: Path,
    corpus_dir: Path,
    resume_fingerprint: str,
    target_rows: int,
) -> tuple[dict[str, str], dict[str, dict[str, Any]], dict[str, dict[str, Any]], dict[str, str]]:
    """Revalidate every pair checkpoint; fail closed if any pair is missing."""
    corpora: dict[str, str] = {}
    collection_manifests: dict[str, dict[str, Any]] = {}
    corpus_manifests: dict[str, dict[str, Any]] = {}
    corpus_file_hashes: dict[str, str] = {}

    for instrument in INITIAL_FOREX_UNIVERSE:
        pair_checkpoint_path = checkpoint_dir / "pairs" / f"{instrument}.json"
        corpus_path = corpus_dir / f"{instrument}_MTF.csv"
        pair_checkpoint = (
            _read_json(pair_checkpoint_path) if pair_checkpoint_path.is_file() else None
        )
        if (
            pair_checkpoint is None
            or pair_checkpoint.get("resume_fingerprint") != resume_fingerprint
            or not corpus_path.is_file()
            or pair_checkpoint.get("corpus_sha256") != _sha256_file(corpus_path)
            or not isinstance(pair_checkpoint.get("collection_manifest"), dict)
            or not isinstance(pair_checkpoint.get("corpus_manifest"), dict)
            or not pair_checkpoint["corpus_manifest"].get("friction_data_complete")
        ):
            raise ValueError(
                f"Stage requires a verified pair checkpoint for {instrument}; "
                "run its pair stage first"
            )
        corpora[instrument] = str(corpus_path)
        collection_manifests[instrument] = dict(
            pair_checkpoint["collection_manifest"]
        )
        corpus_manifests[instrument] = dict(pair_checkpoint["corpus_manifest"])
        corpus_file_hashes[instrument] = str(pair_checkpoint["corpus_sha256"])

    if not corpora:
        raise ValueError("Stage requires at least one verified pair corpus")
    del target_rows
    return corpora, collection_manifests, corpus_manifests, corpus_file_hashes


def _process_horizon(
    horizon: int,
    *,
    report_dir: Path,
    checkpoint_dir: Path,
    resume: bool,
    resume_fingerprint: str,
    qualification_cutoff: pd.Timestamp,
    corpus_file_hashes: dict[str, str],
    corpora: dict[str, str],
    confidence_threshold: float,
    commission_bps: float,
    slippage_bps: float,
    min_net_return_bps: float,
    max_splits: int,
) -> dict[str, Any]:
    """Evaluate one horizon (or resume its verified checkpoint)."""
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
    resume_source = "evaluated"
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
                resume_source = "checkpoint"
                _research_progress(
                    f"stage=horizon horizon={horizon}m status=resumed "
                    f"resume_source=checkpoint "
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
    horizon_report = {
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
                f"resume_source={resume_source}",
                f"folds={report['fold_count']}",
                f"gate={'PASS' if research_gate['research_gate_passed'] else 'HOLD'}",
                f"elapsed_seconds={time.monotonic() - horizon_started:.1f}",
            ]
        )
    )
    return horizon_report


def _assemble_summary(
    *,
    normalized_source: str,
    target_rows: int,
    dukascopy_max_lookback_days: int,
    horizons: tuple[int, ...],
    confidence_threshold: float,
    commission_bps: float,
    slippage_bps: float,
    min_net_return_bps: float,
    qualification_cutoff: pd.Timestamp,
    collection_manifests: dict[str, dict[str, Any]],
    corpus_manifests: dict[str, dict[str, Any]],
    horizon_reports: dict[str, Any],
    pair_resume_sources: dict[str, str],
    report_dir: Path,
    state_path: Path,
    resume: bool,
    candidate_sha: str | None,
    resume_fingerprint: str,
    effective_before: datetime | None,
) -> dict[str, Any]:
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
        "pair_resume_sources": pair_resume_sources,
        "horizon_reports": horizon_reports,
        "governance": {
            "paper_uat_promotion": (
                "eligible_only_after_research_gate_and_untouched_test_gate"
            ),
            "automatic_live_promotion": False,
        },
    }
    del confidence_threshold
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
    return {**summary, "summary_path": str(summary_path)}


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
    bootstrap_dir: str | Path | None = None,
    stage: str = "all",
    stage_instruments: tuple[str, ...] | None = None,
    stage_horizons: tuple[int, ...] | None = None,
) -> dict[str, Any]:
    """Collect, build and evaluate the approved initial six-pair universe."""
    normalized_stage = stage.strip().lower()
    if normalized_stage not in STUDY_STAGES:
        raise ValueError(f"stage must be one of {sorted(STUDY_STAGES)}")
    if normalized_stage != "all" and not resume:
        raise ValueError(
            "Staged execution requires --resume so every stage consumes and "
            "produces verified same-candidate checkpoints"
        )

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

    selected_instruments = list(stage_instruments) if stage_instruments else list(
        INITIAL_FOREX_UNIVERSE
    )
    if normalized_stage in {"pairs", "all"}:
        for instrument in selected_instruments:
            if instrument not in INITIAL_FOREX_UNIVERSE:
                raise ValueError(
                    f"stage instrument {instrument} is not in the approved "
                    "six-pair universe"
                )
    selected_horizons = list(stage_horizons) if stage_horizons else list(horizons)
    if normalized_stage in {"horizons", "summarize", "all"}:
        for horizon in selected_horizons:
            if horizon not in horizons:
                raise ValueError(
                    f"stage horizon {horizon}m is not part of the study horizons"
                )

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
    bootstrap_root = Path(bootstrap_dir) if bootstrap_dir is not None else None
    bootstrap_before = (
        _bootstrap_collection_hour(bootstrap_root)
        if resume and before is None
        else None
    )
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
    plan_path = checkpoint_dir / ORCHESTRATION_PLAN_FILENAME

    effective_before = _resolve_study_state(
        resume=resume,
        state_path=state_path,
        resume_fingerprint=resume_fingerprint,
        candidate_sha=candidate_sha,
        before=before,
        bootstrap_before=bootstrap_before,
    )

    if normalized_stage == "init":
        plan = _orchestration_plan_payload(
            candidate_sha=candidate_sha,
            resume_fingerprint=resume_fingerprint,
            effective_before=effective_before,
            normalized_source=normalized_source,
            dukascopy_max_lookback_days=dukascopy_max_lookback_days,
            target_rows=target_rows,
            horizons=horizons,
            confidence_threshold=confidence_threshold,
            commission_bps=commission_bps,
            slippage_bps=slippage_bps,
            min_net_return_bps=min_net_return_bps,
            max_splits=max_splits,
            bootstrap_root=bootstrap_root,
        )
        _write_json_atomic(plan_path, plan)
        _research_progress(
            f"stage=init status=completed candidate={candidate_sha or 'unknown'} "
            f"effective_before={effective_before.isoformat() if effective_before else 'none'} "
            f"bootstrap={'yes' if bootstrap_root is not None else 'none'}"
        )
        return {**plan, "plan_path": str(plan_path)}

    if normalized_stage in {"pairs", "horizons", "summarize"}:
        _verify_orchestration_plan(
            plan_path,
            expected_resume_fingerprint=resume_fingerprint,
            expected_candidate_sha=candidate_sha,
        )

    if normalized_stage == "pairs":
        pair_resume_sources: dict[str, str] = {}
        for instrument in selected_instruments:
            _collection, _corpus, _path, _sha, resume_source = (
                _process_instrument(
                    instrument,
                    root=root,
                    raw_dir=raw_dir,
                    corpus_dir=corpus_dir,
                    checkpoint_dir=checkpoint_dir,
                    resume=resume,
                    resume_fingerprint=resume_fingerprint,
                    effective_before=effective_before,
                    normalized_source=normalized_source,
                    target_rows=target_rows,
                    dukascopy_cache_dir=dukascopy_cache_dir,
                    dukascopy_max_lookback_days=dukascopy_max_lookback_days,
                    api_base_url=api_base_url,
                    internal_api_key=internal_api_key,
                    user_id=user_id,
                    broker_connection_id=broker_connection_id,
                    bootstrap_root=bootstrap_root,
                )
            )
            pair_resume_sources[instrument] = resume_source
        _research_progress(
            f"stage=pairs status=completed instruments={','.join(selected_instruments)} "
            f"resume_sources={','.join(f'{k}:{v}' for k, v in pair_resume_sources.items())}"
        )
        return {
            "stage": "pairs",
            "instruments": selected_instruments,
            "pair_resume_sources": pair_resume_sources,
        }

    # The horizon and summarize stages (and the monolithic path) require every
    # verified pair corpus.
    if normalized_stage == "all":
        pair_resume_sources = {}
        collection_manifests: dict[str, dict[str, Any]] = {}
        corpus_manifests: dict[str, dict[str, Any]] = {}
        corpora: dict[str, str] = {}
        corpus_file_hashes: dict[str, str] = {}
        for instrument in INITIAL_FOREX_UNIVERSE:
            (
                collection,
                corpus,
                corpus_path,
                corpus_sha256,
                resume_source,
            ) = _process_instrument(
                instrument,
                root=root,
                raw_dir=raw_dir,
                corpus_dir=corpus_dir,
                checkpoint_dir=checkpoint_dir,
                resume=resume,
                resume_fingerprint=resume_fingerprint,
                effective_before=effective_before,
                normalized_source=normalized_source,
                target_rows=target_rows,
                dukascopy_cache_dir=dukascopy_cache_dir,
                dukascopy_max_lookback_days=dukascopy_max_lookback_days,
                api_base_url=api_base_url,
                internal_api_key=internal_api_key,
                user_id=user_id,
                broker_connection_id=broker_connection_id,
                bootstrap_root=bootstrap_root,
            )
            collection_manifests[instrument] = collection
            corpus_manifests[instrument] = corpus
            corpora[instrument] = corpus_path
            corpus_file_hashes[instrument] = corpus_sha256
            pair_resume_sources[instrument] = resume_source
    else:
        (
            corpora,
            collection_manifests,
            corpus_manifests,
            corpus_file_hashes,
        ) = _verified_pair_state(
            checkpoint_dir=checkpoint_dir,
            corpus_dir=corpus_dir,
            resume_fingerprint=resume_fingerprint,
            target_rows=target_rows,
        )
        pair_resume_sources = {}
        for instrument in INITIAL_FOREX_UNIVERSE:
            pair_checkpoint = _read_json(
                checkpoint_dir / "pairs" / f"{instrument}.json"
            )
            pair_resume_sources[instrument] = str(
                (pair_checkpoint or {}).get("resume_source", "checkpoint")
            )

    qualification_cutoff = _research_qualification_cutoff(corpora)

    horizon_reports: dict[str, Any] = {}
    # The summarize stage is pure verification + assembly: it never evaluates
    # a missing horizon, it fails closed demanding its horizon stage first.
    horizons_to_run = (
        selected_horizons
        if normalized_stage == "horizons"
        else list(horizons)
        if normalized_stage == "all"
        else []
    )
    for horizon in horizons_to_run:
        horizon_reports[f"{horizon}m"] = _process_horizon(
            horizon,
            report_dir=report_dir,
            checkpoint_dir=checkpoint_dir,
            resume=resume,
            resume_fingerprint=resume_fingerprint,
            qualification_cutoff=qualification_cutoff,
            corpus_file_hashes=corpus_file_hashes,
            corpora=corpora,
            confidence_threshold=confidence_threshold,
            commission_bps=commission_bps,
            slippage_bps=slippage_bps,
            min_net_return_bps=min_net_return_bps,
            max_splits=max_splits,
        )

    if normalized_stage == "horizons":
        _research_progress(
            "stage=horizons status=completed "
            f"horizons={','.join(str(h) for h in horizons_to_run)}"
        )
        return {
            "stage": "horizons",
            "horizons": [f"{horizon}m" for horizon in horizons_to_run],
            "qualification_decision_time_before": qualification_cutoff.isoformat(),
        }

    if normalized_stage == "summarize":
        # Revalidate every study horizon checkpoint and rebuild the summary
        # from the verified report files exactly as a monolithic resume would.
        for horizon in horizons:
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
            horizon_checkpoint = (
                _read_json(horizon_checkpoint_path)
                if horizon_checkpoint_path.is_file()
                else None
            )
            if (
                horizon_checkpoint is None
                or horizon_checkpoint.get("horizon_fingerprint")
                != horizon_fingerprint
                or not report_path.is_file()
                or not predictions_path.is_file()
                or horizon_checkpoint.get("report_sha256")
                != _sha256_file(report_path)
                or horizon_checkpoint.get("predictions_sha256")
                != _sha256_file(predictions_path)
            ):
                raise ValueError(
                    f"Summarize stage requires a verified horizon checkpoint for "
                    f"{horizon}m; run its horizon stage first"
                )
            report = _read_json(report_path)
            if report is None:
                raise ValueError(
                    f"Summarize stage could not load the verified report for "
                    f"{horizon}m"
                )
            horizon_reports[f"{horizon}m"] = {
                "report_path": str(report_path),
                "validation_predictions_path": report.get(
                    "validation_predictions_path"
                ),
                "overall": report["overall"],
                "by_instrument": report["by_instrument"],
                "fold_count": report["fold_count"],
                "walk_forward": report["walk_forward"],
                "research_gate": _research_gate(report),
            }

    study_started = time.monotonic()
    result = _assemble_summary(
        normalized_source=normalized_source,
        target_rows=target_rows,
        dukascopy_max_lookback_days=dukascopy_max_lookback_days,
        horizons=horizons,
        confidence_threshold=confidence_threshold,
        commission_bps=commission_bps,
        slippage_bps=slippage_bps,
        min_net_return_bps=min_net_return_bps,
        qualification_cutoff=qualification_cutoff,
        collection_manifests=collection_manifests,
        corpus_manifests=corpus_manifests,
        horizon_reports=horizon_reports,
        pair_resume_sources=pair_resume_sources,
        report_dir=report_dir,
        state_path=state_path,
        resume=resume,
        candidate_sha=candidate_sha,
        resume_fingerprint=resume_fingerprint,
        effective_before=effective_before,
    )
    _research_progress(
        f"stage=study status=completed elapsed_seconds={time.monotonic() - study_started:.1f}"
    )
    return result


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
        help="Comma-separated study M1 horizons, default: 1,5,10",
    )
    parser.add_argument(
        "--stage",
        choices=STUDY_STAGES,
        default="all",
        help=(
            "Execution stage. 'all' runs the original monolithic study; "
            "init/pairs/horizons/summarize are the bounded resumable stages "
            "for multi-job orchestration."
        ),
    )
    parser.add_argument(
        "--stage-instruments",
        help="Comma-separated instrument subset for --stage pairs",
    )
    parser.add_argument(
        "--stage-horizons",
        help="Comma-separated horizon subset for --stage horizons",
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
    parser.add_argument(
        "--bootstrap-dir",
        help="Optional ancestor research directory for validated pair import",
    )
    args = parser.parse_args()

    internal_api_key = os.getenv("NESTJS_INTERNAL_API_KEY", "")
    horizons = tuple(
        int(value.strip()) for value in args.horizons.split(",") if value.strip()
    )
    stage_instruments = (
        tuple(
            value.strip().upper()
            for value in args.stage_instruments.split(",")
            if value.strip()
        )
        if args.stage_instruments
        else None
    )
    stage_horizons = (
        tuple(
            int(value.strip())
            for value in args.stage_horizons.split(",")
            if value.strip()
        )
        if args.stage_horizons
        else None
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
        bootstrap_dir=args.bootstrap_dir,
        stage=args.stage,
        stage_instruments=stage_instruments,
        stage_horizons=stage_horizons,
    )
    print(json.dumps(result, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
