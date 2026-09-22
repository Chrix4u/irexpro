"""Friction-aware pooled multi-timeframe XGBoost walk-forward evaluation."""
from __future__ import annotations

import argparse
import gc
import hashlib
import json
import os
import sys
import time
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
from xgboost import XGBClassifier

from app.domain.models.multitimeframe_features import (
    CROSS_TIMEFRAME_FEATURE_COLUMNS,
    INITIAL_FOREX_UNIVERSE,
    MULTITIMEFRAME_BACKTEST_POLICY,
    MULTITIMEFRAME_FEATURE_COLUMNS,
    MULTITIMEFRAME_LABEL_SELECTION_POLICY,
    MULTITIMEFRAME_RESEARCH_VALIDATION_POLICY,
    RUNTIME_TIMEFRAMES,
)
from app.domain.training.multitimeframe_corpus import validate_no_lookahead
from app.domain.training.qualification_diagnostics import (
    causal_regime_diagnostics,
    diagnose_directional_predictions,
    evidence_sufficiency_warnings,
    feature_gain_diagnostics,
)
from app.domain.training.validation import (
    compute_backtest_metrics,
    iter_purged_walk_forward_time_splits,
)

TARGET_COLUMN = "target"
LONG_NET_RETURN_COLUMN = "long_net_return"
SHORT_NET_RETURN_COLUMN = "short_net_return"
CLASS_BALANCE_SAMPLE_WEIGHT_POLICY = "sqrt_inverse_frequency_normalized_v1"
ECONOMIC_SAMPLE_WEIGHT_POLICY = "class_balanced_positive_net_edge_q75_capped_v2"
RESEARCH_PROGRESS_ENV = "IREXPRO_RESEARCH_PROGRESS"
XGBOOST_N_JOBS_ENV = "IREXPRO_XGB_N_JOBS"
MAX_XGBOOST_N_JOBS = 4
QUALIFICATION_REGIME_COLUMNS = ("m1_volatility_20", "h1_rsi_14")


def _research_progress(message: str) -> None:
    enabled = os.getenv(RESEARCH_PROGRESS_ENV, "").strip().lower()
    if enabled in {"1", "true", "yes", "on"}:
        print(f"RESEARCH_PROGRESS {message}", file=sys.stderr, flush=True)


def _xgboost_n_jobs() -> int:
    raw = os.getenv(XGBOOST_N_JOBS_ENV, "").strip()
    if not raw:
        return 1
    try:
        requested = int(raw)
    except ValueError as exc:
        raise ValueError(f"{XGBOOST_N_JOBS_ENV} must be an integer") from exc
    if requested < 1:
        raise ValueError(f"{XGBOOST_N_JOBS_ENV} must be at least 1")
    available = max(1, os.cpu_count() or 1)
    return min(requested, MAX_XGBOOST_N_JOBS, available)


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _atomic_write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(content, encoding="utf-8")
    temporary.replace(path)


def _fold_checkpoint_paths(
    checkpoint_dir: Path,
    fold_index: int,
) -> tuple[Path, Path]:
    stem = checkpoint_dir / f"fold-{fold_index:02d}"
    return stem.with_suffix(".json"), stem.with_suffix(".csv")


def _load_fold_checkpoint(
    checkpoint_dir: Path,
    *,
    fold_index: int,
    fingerprint: str,
    expected: dict[str, Any],
) -> tuple[dict[str, Any], pd.DataFrame] | None:
    metadata_path, predictions_path = _fold_checkpoint_paths(
        checkpoint_dir,
        fold_index,
    )
    if not metadata_path.is_file() or not predictions_path.is_file():
        return None
    try:
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        if metadata.get("fingerprint") != fingerprint:
            return None
        if metadata.get("expected") != expected:
            return None
        if metadata.get("predictions_sha256") != _sha256_file(predictions_path):
            return None
        predictions = pd.read_csv(predictions_path)
        if len(predictions) != int(expected["validation_rows"]):
            return None
        required = {
            "decision_time",
            "instrument",
            TARGET_COLUMN,
            LONG_NET_RETURN_COLUMN,
            SHORT_NET_RETURN_COLUMN,
            "m1_spread_bps",
            "positive_probability",
            "predicted_long",
            "confidence",
            "active_trade",
            "selected_net_return",
            "fold",
        }
        if not required.issubset(predictions.columns):
            return None
        predictions["decision_time"] = pd.to_datetime(
            predictions["decision_time"],
            utc=True,
            errors="raise",
        )
        for column in ("predicted_long", "active_trade"):
            if predictions[column].dtype == object:
                predictions[column] = predictions[column].map(
                    {"True": True, "False": False, True: True, False: False}
                )
            if predictions[column].isna().any():
                return None
            predictions[column] = predictions[column].astype(bool)
        fold_report = metadata.get("fold_report")
        if not isinstance(fold_report, dict):
            return None
        return fold_report, predictions
    except Exception:
        return None


def _write_fold_checkpoint(
    checkpoint_dir: Path,
    *,
    fold_index: int,
    fingerprint: str,
    expected: dict[str, Any],
    fold_report: dict[str, Any],
    predictions: pd.DataFrame,
) -> None:
    checkpoint_dir.mkdir(parents=True, exist_ok=True)
    metadata_path, predictions_path = _fold_checkpoint_paths(
        checkpoint_dir,
        fold_index,
    )
    predictions_tmp = predictions_path.with_suffix(".csv.tmp")
    predictions.to_csv(predictions_tmp, index=False)
    predictions_tmp.replace(predictions_path)
    payload = {
        "checkpoint_version": 1,
        "fingerprint": fingerprint,
        "expected": expected,
        "predictions_sha256": _sha256_file(predictions_path),
        "fold_report": fold_report,
    }
    _atomic_write_text(
        metadata_path,
        json.dumps(payload, indent=2, sort_keys=True),
    )


def _parse_corpus_dates(frame: pd.DataFrame) -> pd.DataFrame:
    result = frame.copy()
    date_columns = [
        column
        for column in result.columns
        if column == "decision_time"
        or column.endswith("_available_at")
        or column.endswith("_source_bar_open")
    ]
    for column in date_columns:
        result[column] = pd.to_datetime(result[column], utc=True, errors="coerce")
        if result[column].isna().any():
            raise ValueError(f"Corpus contains invalid timestamp values in {column}")
    return result


def prepare_instrument_corpus(
    corpus: pd.DataFrame,
    *,
    instrument: str,
    horizon_bars: int,
    min_net_return_bps: float = 0.0,
    commission_bps: float = 0.0,
    slippage_bps: float = 0.0,
) -> pd.DataFrame:
    """
    Convert a causal MTF corpus into a friction-aware supervised dataset.

    Historical spread is charged as half-spread at entry plus half-spread at
    exit. Commission/slippage are optional extra round-trip costs in bps.
    Future prices/spreads are used only for labels/evaluation, never features.
    Every exact-horizon finite row remains eligible; future profitability must
    never decide whether a row exists in the supervised dataset.
    """
    if instrument not in INITIAL_FOREX_UNIVERSE:
        raise ValueError(f"Unsupported initial-universe instrument: {instrument}")
    if horizon_bars < 1:
        raise ValueError("horizon_bars must be at least 1")
    if min_net_return_bps != 0:
        raise ValueError(
            "min_net_return_bps must be 0: filtering supervised rows by future "
            "profitability is prohibited; use the inference confidence threshold "
            "for no-trade selection"
        )
    if commission_bps < 0 or slippage_bps < 0:
        raise ValueError("commission_bps/slippage_bps cannot be negative")

    frame = _parse_corpus_dates(corpus)
    validate_no_lookahead(frame)

    required_friction = [
        "m1_close",
        "m1_spread_points",
        "m1_spread_bps",
        "m1_price_digits",
        "m1_tick_volume",
    ]
    missing = [column for column in required_friction if column not in frame.columns]
    if missing:
        raise ValueError(f"Corpus missing required real-friction fields: {missing}")
    if frame[required_friction].isna().any().any():
        raise ValueError("Corpus contains missing real-friction values")

    for timeframe in RUNTIME_TIMEFRAMES:
        prefix = timeframe.lower()
        required = [
            f"{prefix}_high",
            f"{prefix}_low",
            f"{prefix}_close",
            f"{prefix}_ma_5",
            f"{prefix}_ma_10",
            f"{prefix}_ma_20",
            f"{prefix}_simple_return",
            f"{prefix}_price_vs_ma20",
            f"{prefix}_volatility_10",
            f"{prefix}_candle_body",
            f"{prefix}_volume_change",
            f"{prefix}_tick_volume",
        ]
        absent = [column for column in required if column not in frame.columns]
        if absent:
            raise ValueError(f"Corpus missing {timeframe} model fields: {absent}")

        eps = 1e-12
        frame[f"{prefix}_range_pct"] = (
            (frame[f"{prefix}_high"] - frame[f"{prefix}_low"])
            / frame[f"{prefix}_close"].abs().clip(lower=eps)
        )
        frame[f"{prefix}_ma5_vs_ma20"] = (
            frame[f"{prefix}_ma_5"] / frame[f"{prefix}_ma_20"].abs().clip(lower=eps)
        ) - 1.0
        frame[f"{prefix}_ma10_vs_ma20"] = (
            frame[f"{prefix}_ma_10"] / frame[f"{prefix}_ma_20"].abs().clip(lower=eps)
        ) - 1.0
        frame[f"{prefix}_log_tick_volume"] = np.log1p(
            pd.to_numeric(frame[f"{prefix}_tick_volume"], errors="coerce").clip(lower=0.0)
        )

    decision_time = frame["decision_time"]
    minute_of_day = decision_time.dt.hour * 60 + decision_time.dt.minute
    frame["minute_of_day_sin"] = np.sin(2.0 * np.pi * minute_of_day / 1440.0)
    frame["minute_of_day_cos"] = np.cos(2.0 * np.pi * minute_of_day / 1440.0)
    day_of_week = decision_time.dt.dayofweek
    frame["day_of_week_sin"] = np.sin(2.0 * np.pi * day_of_week / 7.0)
    frame["day_of_week_cos"] = np.cos(2.0 * np.pi * day_of_week / 7.0)

    trend_columns = [
        f"{timeframe.lower()}_price_vs_ma20" for timeframe in RUNTIME_TIMEFRAMES
    ]
    momentum_columns = [
        f"{timeframe.lower()}_momentum_5" for timeframe in RUNTIME_TIMEFRAMES
    ]
    frame["trend_alignment_score"] = np.sign(frame[trend_columns]).mean(axis=1)
    frame["momentum_alignment_score"] = np.sign(frame[momentum_columns]).mean(axis=1)
    if set(CROSS_TIMEFRAME_FEATURE_COLUMNS) != {
        "trend_alignment_score",
        "momentum_alignment_score",
    }:
        raise ValueError("Cross-timeframe training/runtime feature contract diverged")

    for candidate in INITIAL_FOREX_UNIVERSE:
        frame[f"instrument_{candidate}"] = 1.0 if candidate == instrument else 0.0
    frame["instrument"] = instrument

    current_close = pd.to_numeric(frame["m1_close"], errors="coerce")
    current_spread_price = (
        current_close * pd.to_numeric(frame["m1_spread_bps"], errors="coerce") / 10_000.0
    )
    future_close = current_close.shift(-horizon_bars)
    future_spread_price = current_spread_price.shift(-horizon_bars)
    future_decision_time = decision_time.shift(-horizon_bars)
    expected_horizon = pd.Timedelta(minutes=horizon_bars)
    exact_horizon = (future_decision_time - decision_time) == expected_horizon

    long_entry = current_close + current_spread_price / 2.0
    long_exit = future_close - future_spread_price / 2.0
    short_entry = current_close - current_spread_price / 2.0
    short_exit = future_close + future_spread_price / 2.0

    extra_cost = (commission_bps + slippage_bps) / 10_000.0
    frame[LONG_NET_RETURN_COLUMN] = (long_exit / long_entry) - 1.0 - extra_cost
    frame[SHORT_NET_RETURN_COLUMN] = (short_entry - short_exit) / short_entry - extra_cost

    # Do NOT filter rows using either future directional return. Doing so
    # would let hindsight decide which market periods the model is evaluated
    # on and would overstate runtime performance. The binary target remains
    # "which direction was better after friction"; confidence decides whether
    # the runtime trades at all.
    frame = frame[
        exact_horizon
        & np.isfinite(frame[LONG_NET_RETURN_COLUMN])
        & np.isfinite(frame[SHORT_NET_RETURN_COLUMN])
    ].copy()
    frame[TARGET_COLUMN] = (
        frame[LONG_NET_RETURN_COLUMN] > frame[SHORT_NET_RETURN_COLUMN]
    ).astype(int)

    feature_values = frame[MULTITIMEFRAME_FEATURE_COLUMNS].apply(
        pd.to_numeric, errors="coerce"
    )
    finite_mask = np.isfinite(feature_values.to_numpy(dtype=float)).all(axis=1)
    frame.loc[:, MULTITIMEFRAME_FEATURE_COLUMNS] = feature_values
    frame = frame.loc[finite_mask].copy()

    if frame.empty:
        raise ValueError(f"No supervised samples remain for {instrument}")
    return frame.sort_values("decision_time").reset_index(drop=True)


def _research_source_columns() -> set[str]:
    """
    Return only columns needed to validate causality and build model inputs.

    The persisted MTF corpus contains additional raw/intermediate columns that
    are useful for audit/debugging but are not consumed by supervised training.
    Avoid loading them into the six-pair pooled research process.
    """
    columns: set[str] = {
        "decision_time",
        "m1_close",
        "m1_spread_points",
        "m1_spread_bps",
        "m1_price_digits",
        "m1_tick_volume",
        *MULTITIMEFRAME_FEATURE_COLUMNS,
    }
    for timeframe in RUNTIME_TIMEFRAMES:
        prefix = timeframe.lower()
        columns.update(
            {
                f"{prefix}_available_at",
                f"{prefix}_source_bar_open",
                f"{prefix}_high",
                f"{prefix}_low",
                f"{prefix}_close",
                f"{prefix}_ma_5",
                f"{prefix}_ma_10",
                f"{prefix}_ma_20",
                f"{prefix}_tick_volume",
            }
        )
    return columns


def _compact_research_frame(frame: pd.DataFrame) -> pd.DataFrame:
    """
    Drop columns no longer needed after causality/friction validation.

    Values and dtypes of retained model/evaluation columns are left untouched,
    so this is a memory-layout optimization rather than a research-semantics
    change.
    """
    retained = list(
        dict.fromkeys(
            [
                "decision_time",
                "instrument",
                TARGET_COLUMN,
                LONG_NET_RETURN_COLUMN,
                SHORT_NET_RETURN_COLUMN,
                "m1_spread_bps",
                *MULTITIMEFRAME_FEATURE_COLUMNS,
            ]
        )
    )
    missing = [column for column in retained if column not in frame.columns]
    if missing:
        raise ValueError(f"Prepared research frame missing required columns: {missing}")
    return frame.loc[:, retained].copy()


def load_and_prepare_corpora(
    datasets: dict[str, str | Path],
    *,
    horizon_bars: int,
    min_net_return_bps: float = 0.0,
    commission_bps: float = 0.0,
    slippage_bps: float = 0.0,
    decision_time_before: str | pd.Timestamp | None = None,
) -> tuple[pd.DataFrame, dict[str, str]]:
    """Load multiple pair corpora and return one pooled chronological dataset."""
    if not datasets:
        raise ValueError("At least one instrument corpus is required")

    cutoff: pd.Timestamp | None = None
    if decision_time_before is not None:
        cutoff = pd.Timestamp(decision_time_before)
        cutoff = (
            cutoff.tz_localize("UTC")
            if cutoff.tzinfo is None
            else cutoff.tz_convert("UTC")
        )

    source_columns = _research_source_columns()
    frames: list[pd.DataFrame] = []
    hashes: dict[str, str] = {}
    for instrument, raw_path in datasets.items():
        path = Path(raw_path)
        frame = pd.read_csv(
            path,
            usecols=lambda column: column in source_columns,
        )
        prepared = prepare_instrument_corpus(
            frame,
            instrument=instrument.upper(),
            horizon_bars=horizon_bars,
            min_net_return_bps=min_net_return_bps,
            commission_bps=commission_bps,
            slippage_bps=slippage_bps,
        )
        if cutoff is not None:
            # The research decision and its horizon outcome must both remain
            # strictly before the reserved future boundary.
            latest_research_decision = cutoff - pd.Timedelta(minutes=horizon_bars)
            prepared = prepared.loc[
                prepared["decision_time"] < latest_research_decision
            ].copy()
            if prepared.empty:
                raise ValueError(
                    f"No research samples remain before qualification cutoff for {instrument}"
                )

        prepared = _compact_research_frame(prepared)
        _research_progress(
            " ".join(
                [
                    "stage=dataset_prepare",
                    f"instrument={instrument.upper()}",
                    f"rows={len(prepared)}",
                    f"columns={len(prepared.columns)}",
                    f"memory_mib={prepared.memory_usage(deep=True).sum() / (1024 * 1024):.1f}",
                ]
            )
        )
        frames.append(prepared)
        hashes[instrument.upper()] = _sha256_file(path)

    pooled = pd.concat(frames, ignore_index=True)
    del frames
    pooled = pooled.sort_values(["decision_time", "instrument"]).reset_index(drop=True)
    _research_progress(
        " ".join(
            [
                "stage=dataset_prepare",
                "instrument=POOLED",
                f"rows={len(pooled)}",
                f"columns={len(pooled.columns)}",
                f"memory_mib={pooled.memory_usage(deep=True).sum() / (1024 * 1024):.1f}",
            ]
        )
    )
    return pooled, hashes


def _build_model() -> XGBClassifier:
    return XGBClassifier(
        objective="binary:logistic",
        eval_metric="logloss",
        n_estimators=600,
        learning_rate=0.025,
        max_depth=4,
        min_child_weight=3.0,
        subsample=0.85,
        colsample_bytree=0.8,
        reg_alpha=0.05,
        reg_lambda=1.2,
        random_state=42,
        n_jobs=_xgboost_n_jobs(),
        tree_method="hist",
        early_stopping_rounds=50,
    )


def _class_balance_sample_weights(frame: pd.DataFrame) -> np.ndarray:
    """
    Return moderate inverse-frequency weights for the two directional classes.

    Balanced accuracy is a promotion gate, so the learner and its inner
    early-stopping monitor must not let a modest class skew dominate model
    selection. Square-root inverse-frequency weighting corrects the skew
    without the instability of full inverse-frequency weights. The weights
    are computed only from labels inside the current training/validation
    partition and never from an outer fold.
    """
    target = pd.to_numeric(frame[TARGET_COLUMN], errors="coerce").to_numpy(dtype=float)
    if not np.isfinite(target).all():
        raise ValueError("Class-balance weights require finite targets")
    if not np.isin(target, [0.0, 1.0]).all():
        raise ValueError("Class-balance weights require binary directional targets")

    labels = target.astype(int)
    counts = np.bincount(labels, minlength=2).astype(float)
    if (counts <= 0.0).any():
        raise ValueError("Class-balance weights require both directional classes")

    total = float(len(labels))
    per_class = np.sqrt(total / (2.0 * counts))
    weights = per_class[labels]
    weights = np.clip(weights, 0.5, 2.0)
    return (weights / float(weights.mean())).astype(float)


def _economic_sample_weights(frame: pd.DataFrame) -> np.ndarray:
    """
    Combine class balance with a moderated positive-net-edge training weight.

    Future net returns are legitimate supervised outcomes only inside the
    current training partition. They are never runtime features, never used
    to remove rows, and never used to weight the outer validation fold.

    The v1 policy allowed a 10x economic-weight ratio (0.5..5.0), which could
    improve sparse trading economics while weakening directional balanced
    accuracy. V2 narrows the economic range, multiplies it by moderate
    class-balance weights, normalizes the result, and caps extremes.
    """
    best_net = np.maximum(
        pd.to_numeric(frame[LONG_NET_RETURN_COLUMN], errors="coerce").to_numpy(dtype=float),
        pd.to_numeric(frame[SHORT_NET_RETURN_COLUMN], errors="coerce").to_numpy(dtype=float),
    )
    if not np.isfinite(best_net).all():
        raise ValueError("Training sample weights require finite net returns")

    positive_edge_bps = np.maximum(best_net * 10_000.0, 0.0)
    positive = positive_edge_bps[positive_edge_bps > 0.0]
    if len(positive) == 0:
        scale = 1.0
    else:
        scale = max(float(np.quantile(positive, 0.75)), 0.10)

    # Moderate economics: 0.75..2.50 instead of the v1 0.50..5.00 range.
    economic = 0.75 + np.clip(positive_edge_bps / scale, 0.0, 1.75)
    combined = economic * _class_balance_sample_weights(frame)
    combined = combined / float(combined.mean())
    combined = np.clip(combined, 0.25, 4.0)
    return combined.astype(float)


def _split_internal_early_stopping_tail(
    training_window: pd.DataFrame,
    *,
    horizon_bars: int,
) -> tuple[pd.DataFrame, pd.DataFrame]:
    """
    Split an outer training window into fit + internal early-stopping periods.

    The outer walk-forward validation fold must not influence tree-count
    selection. The internal tail is chronological, and a horizon-sized purge
    separates it from the fit portion so forward-return labels cannot cross
    the boundary.
    """
    if horizon_bars < 1:
        raise ValueError("horizon_bars must be positive")

    times = pd.Series(
        pd.to_datetime(training_window["decision_time"], utc=True, errors="coerce")
    )
    if times.isna().any():
        raise ValueError("training window contains invalid decision_time values")

    unique_times = pd.Index(times.drop_duplicates().sort_values())
    early_stop_periods = max(50, int(len(unique_times) * 0.15))
    early_start_index = len(unique_times) - early_stop_periods
    fit_end_index = early_start_index - horizon_bars
    if fit_end_index < 50:
        raise ValueError(
            "Training window is too small for purged internal early stopping"
        )

    fit_times = unique_times[:fit_end_index]
    early_stop_times = unique_times[early_start_index:]
    fit_frame = training_window.loc[times.isin(fit_times)].copy()
    early_stop_frame = training_window.loc[times.isin(early_stop_times)].copy()
    if fit_frame.empty or early_stop_frame.empty:
        raise ValueError("Internal early-stopping split produced an empty frame")
    if fit_frame[TARGET_COLUMN].nunique() < 2:
        raise ValueError("Internal fit data contains one directional class")
    if early_stop_frame[TARGET_COLUMN].nunique() < 2:
        raise ValueError("Internal early-stopping data contains one directional class")

    return fit_frame, early_stop_frame

def _non_overlapping_portfolio_periods(
    predictions: pd.DataFrame,
    *,
    horizon_bars: int,
) -> pd.DataFrame:
    """
    Build a conservative portfolio-return stream for trading-gate metrics.

    Signals sharing one decision time are equal-weighted into one portfolio
    period. Once a period is accepted, later decisions are ignored until its
    horizon has elapsed. This prevents simultaneous pairs and overlapping
    M1 decision windows from being compounded as independent full-capital
    returns.
    """
    if horizon_bars < 1:
        raise ValueError("horizon_bars must be positive")

    active = predictions[predictions["active_trade"]].copy()
    if active.empty:
        return pd.DataFrame(
            columns=["decision_time", "portfolio_net_return", "signal_count"]
        )

    active["decision_time"] = pd.to_datetime(
        active["decision_time"],
        utc=True,
        errors="raise",
    )
    grouped = (
        active.groupby("decision_time", sort=True)["selected_net_return"]
        .agg(portfolio_net_return="mean", signal_count="size")
        .reset_index()
        .sort_values("decision_time")
        .reset_index(drop=True)
    )

    accepted: list[dict[str, Any]] = []
    next_available: pd.Timestamp | None = None
    holding_period = pd.Timedelta(minutes=horizon_bars)
    for row in grouped.itertuples(index=False):
        decision_time = pd.Timestamp(row.decision_time)
        if next_available is not None and decision_time < next_available:
            continue
        accepted.append(
            {
                "decision_time": decision_time,
                "portfolio_net_return": float(row.portfolio_net_return),
                "signal_count": int(row.signal_count),
            }
        )
        next_available = decision_time + holding_period

    return pd.DataFrame.from_records(accepted)


def _trade_metrics(
    predictions: pd.DataFrame,
    *,
    horizon_bars: int,
) -> dict[str, Any]:
    raw_active_signals = int(predictions["active_trade"].sum())
    periods = _non_overlapping_portfolio_periods(
        predictions,
        horizon_bars=horizon_bars,
    )
    if periods.empty:
        return {
            "trade_or_period_count": 0,
            "raw_active_signals": raw_active_signals,
            "non_overlapping_periods": 0,
            "backtest_evaluation_policy": MULTITIMEFRAME_BACKTEST_POLICY,
            "total_return": 0.0,
            "average_net_return": 0.0,
            "median_net_return": 0.0,
            "win_rate": 0.0,
            "profit_factor": None,
            "sharpe_ratio": None,
            "sortino_ratio": None,
            "max_drawdown": 0.0,
            "average_winner": None,
            "average_loser": None,
            "gross_profit": 0.0,
            "gross_loss": 0.0,
        }

    start = periods["decision_time"].min()
    end = periods["decision_time"].max()
    span_years = max(
        (end - start).total_seconds() / (365.25 * 24 * 3600),
        1.0 / 365.25,
    )
    periods_per_year = max(float(len(periods)) / span_years, 1.0)
    period_returns = periods["portfolio_net_return"].to_numpy(dtype=float)
    metrics = compute_backtest_metrics(
        period_returns,
        annualization_factor=periods_per_year,
    )
    winners = period_returns[period_returns > 0.0]
    losers = period_returns[period_returns < 0.0]
    return {
        **metrics,
        "raw_active_signals": raw_active_signals,
        "non_overlapping_periods": int(len(periods)),
        "backtest_evaluation_policy": MULTITIMEFRAME_BACKTEST_POLICY,
        "average_winner": float(winners.mean()) if len(winners) else None,
        "average_loser": float(losers.mean()) if len(losers) else None,
        "gross_profit": float(winners.sum()) if len(winners) else 0.0,
        "gross_loss": float(-losers.sum()) if len(losers) else 0.0,
    }


def _summarize_predictions(
    predictions: pd.DataFrame,
    *,
    horizon_bars: int,
    confidence_threshold: float = 0.60,
    decision_threshold: float = 0.50,
) -> dict[str, Any]:
    diagnostics = diagnose_directional_predictions(
        predictions,
        confidence_threshold=confidence_threshold,
        decision_threshold=decision_threshold,
    )
    classification = {
        key: diagnostics[key]
        for key in (
            "accuracy",
            "balanced_accuracy",
            "precision",
            "recall",
            "f1",
            "roc_auc",
            "log_loss",
            "brier_score",
            "sample_count",
            "positive_rate",
        )
    }
    trading = _trade_metrics(predictions, horizon_bars=horizon_bars)
    evidence_warnings = evidence_sufficiency_warnings(
        trade_or_period_count=int(trading["trade_or_period_count"]),
        sharpe_ratio=(
            float(trading["sharpe_ratio"])
            if trading["sharpe_ratio"] is not None
            else None
        ),
        confidence_coverage=float(diagnostics["confidence_coverage"]["fraction"]),
    )
    return {
        "classification": classification,
        "trading": trading,
        "diagnostics": diagnostics,
        "causal_regime_diagnostics": causal_regime_diagnostics(
            predictions,
            confidence_threshold=confidence_threshold,
        ),
        "evidence_sufficiency_warnings": evidence_warnings,
        "rows": int(len(predictions)),
        "active_trades": int(predictions["active_trade"].sum()),
        "average_spread_bps": float(predictions["m1_spread_bps"].mean()),
        "median_spread_bps": float(predictions["m1_spread_bps"].median()),
    }


def _run_pooled_walk_forward_core(
    dataset: pd.DataFrame,
    *,
    horizon_bars: int,
    confidence_threshold: float = 0.60,
    min_train_periods: int | None = None,
    validation_periods: int | None = None,
    purge_periods: int | None = None,
    embargo_periods: int | None = None,
    max_splits: int = 5,
    checkpoint_dir: str | Path | None = None,
    checkpoint_fingerprint: str | None = None,
) -> tuple[dict[str, Any], pd.DataFrame]:
    """Run expanding pooled walk-forward evaluation and retain validation predictions."""
    if not 0.5 <= confidence_threshold < 1.0:
        raise ValueError("confidence_threshold must be in [0.5, 1.0)")
    if dataset[TARGET_COLUMN].nunique() < 2:
        raise ValueError("Pooled dataset must contain both directional classes")

    unique_periods = dataset["decision_time"].nunique()
    min_train = min_train_periods or max(250, int(unique_periods * 0.60))
    validation = validation_periods or max(100, int(unique_periods * 0.07))
    purge = horizon_bars if purge_periods is None else purge_periods
    embargo = horizon_bars if embargo_periods is None else embargo_periods

    validation_start = min_train + purge
    split_count = 0
    while validation_start + validation <= unique_periods:
        split_count += 1
        if max_splits is not None and split_count >= max_splits:
            break
        validation_start += validation + embargo
    if split_count == 0:
        raise ValueError(
            "Dataset is too small for requested time-based walk-forward configuration"
        )

    fold_reports: list[dict[str, Any]] = []
    prediction_frames: list[pd.DataFrame] = []

    splits = iter_purged_walk_forward_time_splits(
        dataset,
        time_column="decision_time",
        min_train_periods=min_train,
        validation_periods=validation,
        purge_periods=purge,
        embargo_periods=embargo,
        max_splits=max_splits,
    )

    for fold_index, (train, validation_frame) in enumerate(splits, start=1):
        if train[TARGET_COLUMN].nunique() < 2:
            raise ValueError(f"Fold {fold_index} training data contains one class")
        if validation_frame[TARGET_COLUMN].nunique() < 2:
            raise ValueError(f"Fold {fold_index} validation data contains one class")

        fit_train, early_stop_frame = _split_internal_early_stopping_tail(
            train,
            horizon_bars=horizon_bars,
        )
        expected_checkpoint = {
            "fold": fold_index,
            "train_rows": int(len(train)),
            "fit_rows": int(len(fit_train)),
            "internal_early_stopping_rows": int(len(early_stop_frame)),
            "validation_rows": int(len(validation_frame)),
            "train_start": train["decision_time"].min().isoformat(),
            "train_end": train["decision_time"].max().isoformat(),
            "internal_early_stopping_start": early_stop_frame[
                "decision_time"
            ].min().isoformat(),
            "internal_early_stopping_end": early_stop_frame[
                "decision_time"
            ].max().isoformat(),
            "validation_start": validation_frame["decision_time"].min().isoformat(),
            "validation_end": validation_frame["decision_time"].max().isoformat(),
        }

        # fit_train + early_stop_frame now contain the only training rows needed
        # below. Release the larger outer-train copy before model allocation.
        del train

        checkpoint = None
        if checkpoint_dir is not None and checkpoint_fingerprint:
            checkpoint = _load_fold_checkpoint(
                Path(checkpoint_dir),
                fold_index=fold_index,
                fingerprint=checkpoint_fingerprint,
                expected=expected_checkpoint,
            )
        if checkpoint is not None:
            fold_report, predictions = checkpoint
            fold_reports.append(fold_report)
            prediction_frames.append(predictions)
            _research_progress(
                " ".join(
                    [
                        "stage=walk_forward",
                        f"horizon={horizon_bars}m",
                        f"fold={fold_index}/{split_count}",
                        "status=resumed",
                        f"validation_rows={len(predictions)}",
                    ]
                )
            )
            del validation_frame, fit_train, early_stop_frame
            gc.collect()
            continue

        fold_started = time.monotonic()
        _research_progress(
            " ".join(
                [
                    "stage=walk_forward",
                    f"horizon={horizon_bars}m",
                    f"fold={fold_index}/{split_count}",
                    "status=started",
                    f"fit_rows={len(fit_train)}",
                    f"early_stop_rows={len(early_stop_frame)}",
                    f"validation_rows={len(validation_frame)}",
                    f"xgb_n_jobs={_xgboost_n_jobs()}",
                ]
            )
        )
        model = _build_model()
        model.fit(
            fit_train[MULTITIMEFRAME_FEATURE_COLUMNS],
            fit_train[TARGET_COLUMN].astype(int),
            sample_weight=_economic_sample_weights(fit_train),
            eval_set=[
                (
                    early_stop_frame[MULTITIMEFRAME_FEATURE_COLUMNS],
                    early_stop_frame[TARGET_COLUMN].astype(int),
                )
            ],
            sample_weight_eval_set=[
                _class_balance_sample_weights(early_stop_frame)
            ],
            verbose=False,
        )

        probabilities = model.predict_proba(
            validation_frame[MULTITIMEFRAME_FEATURE_COLUMNS]
        )[:, 1]
        prediction_columns = [
            "decision_time",
            "instrument",
            TARGET_COLUMN,
            LONG_NET_RETURN_COLUMN,
            SHORT_NET_RETURN_COLUMN,
            "m1_spread_bps",
        ]
        prediction_columns.extend(
            column
            for column in QUALIFICATION_REGIME_COLUMNS
            if column in validation_frame.columns
        )
        predictions = validation_frame[prediction_columns].copy()
        predictions["positive_probability"] = probabilities
        predictions["predicted_long"] = probabilities >= 0.5
        predictions["confidence"] = np.maximum(probabilities, 1.0 - probabilities)
        predictions["active_trade"] = predictions["confidence"] >= confidence_threshold
        predictions["selected_net_return"] = np.where(
            predictions["predicted_long"],
            predictions[LONG_NET_RETURN_COLUMN],
            predictions[SHORT_NET_RETURN_COLUMN],
        )
        predictions["fold"] = fold_index

        by_instrument = {
            instrument: _summarize_predictions(
                group,
                horizon_bars=horizon_bars,
                confidence_threshold=confidence_threshold,
            )
            for instrument, group in predictions.groupby("instrument", sort=True)
        }
        fold_report = {
            **expected_checkpoint,
            "best_iteration": int(getattr(model, "best_iteration", -1)),
            "feature_importance_gain": feature_gain_diagnostics(
                model,
                MULTITIMEFRAME_FEATURE_COLUMNS,
            ),
            "aggregate": _summarize_predictions(
                predictions,
                horizon_bars=horizon_bars,
                confidence_threshold=confidence_threshold,
            ),
            "by_instrument": by_instrument,
        }
        fold_reports.append(fold_report)
        prediction_frames.append(predictions)

        if checkpoint_dir is not None and checkpoint_fingerprint:
            _write_fold_checkpoint(
                Path(checkpoint_dir),
                fold_index=fold_index,
                fingerprint=checkpoint_fingerprint,
                expected=expected_checkpoint,
                fold_report=fold_report,
                predictions=predictions,
            )

        _research_progress(
            " ".join(
                [
                    "stage=walk_forward",
                    f"horizon={horizon_bars}m",
                    f"fold={fold_index}/{split_count}",
                    "status=completed",
                    f"elapsed_seconds={time.monotonic() - fold_started:.1f}",
                    f"best_iteration={getattr(model, 'best_iteration', 'unknown')}",
                ]
            )
        )
        del model, validation_frame, fit_train, early_stop_frame
        gc.collect()

    all_predictions = pd.concat(prediction_frames, ignore_index=True)
    overall_by_instrument = {
        instrument: _summarize_predictions(
            group,
            horizon_bars=horizon_bars,
            confidence_threshold=confidence_threshold,
        )
        for instrument, group in all_predictions.groupby("instrument", sort=True)
    }
    report = {
        "folds": fold_reports,
        "overall": _summarize_predictions(
            all_predictions,
            horizon_bars=horizon_bars,
            confidence_threshold=confidence_threshold,
        ),
        "by_instrument": overall_by_instrument,
        "fold_count": len(fold_reports),
        "evaluated_rows": int(len(all_predictions)),
        "walk_forward": {
            "unique_periods": int(unique_periods),
            "min_train_periods": int(min_train),
            "validation_periods": int(validation),
            "purge_periods": int(purge),
            "embargo_periods": int(embargo),
            "confidence_threshold": confidence_threshold,
            "training_sample_weight_policy": ECONOMIC_SAMPLE_WEIGHT_POLICY,
            "validation_sample_weight_policy": CLASS_BALANCE_SAMPLE_WEIGHT_POLICY,
        },
    }
    return report, all_predictions.copy()


def run_pooled_walk_forward(
    dataset: pd.DataFrame,
    *,
    horizon_bars: int,
    confidence_threshold: float = 0.60,
    min_train_periods: int | None = None,
    validation_periods: int | None = None,
    purge_periods: int | None = None,
    embargo_periods: int | None = None,
    max_splits: int = 5,
) -> dict[str, Any]:
    """Run expanding pooled walk-forward evaluation and return detailed metrics."""
    report, _ = _run_pooled_walk_forward_core(
        dataset,
        horizon_bars=horizon_bars,
        confidence_threshold=confidence_threshold,
        min_train_periods=min_train_periods,
        validation_periods=validation_periods,
        purge_periods=purge_periods,
        embargo_periods=embargo_periods,
        max_splits=max_splits,
    )
    return report


def run_pooled_walk_forward_with_predictions(
    dataset: pd.DataFrame,
    *,
    horizon_bars: int,
    confidence_threshold: float = 0.60,
    min_train_periods: int | None = None,
    validation_periods: int | None = None,
    purge_periods: int | None = None,
    embargo_periods: int | None = None,
    max_splits: int = 5,
    checkpoint_dir: str | Path | None = None,
    checkpoint_fingerprint: str | None = None,
) -> tuple[dict[str, Any], pd.DataFrame]:
    """Return metrics plus causal outer-fold predictions for research overlays."""
    return _run_pooled_walk_forward_core(
        dataset,
        horizon_bars=horizon_bars,
        confidence_threshold=confidence_threshold,
        min_train_periods=min_train_periods,
        validation_periods=validation_periods,
        purge_periods=purge_periods,
        embargo_periods=embargo_periods,
        max_splits=max_splits,
        checkpoint_dir=checkpoint_dir,
        checkpoint_fingerprint=checkpoint_fingerprint,
    )


def evaluate_multi_pair_corpora(
    datasets: dict[str, str | Path],
    *,
    horizon_bars: int,
    report_path: str | Path,
    confidence_threshold: float = 0.60,
    min_net_return_bps: float = 0.0,
    commission_bps: float = 0.0,
    slippage_bps: float = 0.0,
    max_splits: int = 5,
    decision_time_before: str | pd.Timestamp | None = None,
    predictions_path: str | Path | None = None,
    checkpoint_dir: str | Path | None = None,
) -> dict[str, Any]:
    pooled, hashes = load_and_prepare_corpora(
        datasets,
        horizon_bars=horizon_bars,
        min_net_return_bps=min_net_return_bps,
        commission_bps=commission_bps,
        slippage_bps=slippage_bps,
        decision_time_before=decision_time_before,
    )
    model_params = _build_model().get_params()
    model_params.pop("n_jobs", None)
    checkpoint_payload = {
        "checkpoint_version": 1,
        "dataset_sha256": hashes,
        "horizon_bars": horizon_bars,
        "confidence_threshold": confidence_threshold,
        "min_net_return_bps": min_net_return_bps,
        "commission_bps": commission_bps,
        "slippage_bps": slippage_bps,
        "max_splits": max_splits,
        "decision_time_before": (
            pd.Timestamp(decision_time_before).isoformat()
            if decision_time_before is not None
            else None
        ),
        "feature_columns": MULTITIMEFRAME_FEATURE_COLUMNS,
        "model_params": model_params,
        "label_selection_policy": MULTITIMEFRAME_LABEL_SELECTION_POLICY,
        "backtest_evaluation_policy": MULTITIMEFRAME_BACKTEST_POLICY,
        "research_validation_policy": MULTITIMEFRAME_RESEARCH_VALIDATION_POLICY,
    }
    checkpoint_fingerprint = hashlib.sha256(
        json.dumps(checkpoint_payload, sort_keys=True, default=str).encode("utf-8")
    ).hexdigest()
    evaluation, predictions = run_pooled_walk_forward_with_predictions(
        pooled,
        horizon_bars=horizon_bars,
        confidence_threshold=confidence_threshold,
        max_splits=max_splits,
        checkpoint_dir=checkpoint_dir,
        checkpoint_fingerprint=checkpoint_fingerprint,
    )
    exported_predictions_path: str | None = None
    if predictions_path is not None:
        predictions_output = Path(predictions_path)
        predictions_output.parent.mkdir(parents=True, exist_ok=True)
        predictions_tmp = predictions_output.with_suffix(
            predictions_output.suffix + ".tmp"
        )
        predictions.to_csv(predictions_tmp, index=False)
        predictions_tmp.replace(predictions_output)
        exported_predictions_path = str(predictions_output)
    report: dict[str, Any] = {
        "report_version": 2,
        "model_type": "pooled_multitimeframe_xgboost_research",
        "instruments": sorted(datasets),
        "feature_columns": MULTITIMEFRAME_FEATURE_COLUMNS,
        "feature_count": len(MULTITIMEFRAME_FEATURE_COLUMNS),
        "horizon_bars": horizon_bars,
        "label_selection_policy": MULTITIMEFRAME_LABEL_SELECTION_POLICY,
        "backtest_evaluation_policy": MULTITIMEFRAME_BACKTEST_POLICY,
        "research_validation_policy": MULTITIMEFRAME_RESEARCH_VALIDATION_POLICY,
        "qualification_decision_time_before": (
            pd.Timestamp(decision_time_before).isoformat()
            if decision_time_before is not None
            else None
        ),
        "cost_model": {
            "historical_spread": "half spread at entry + half spread at exit",
            "commission_bps_round_trip": commission_bps,
            "slippage_bps_round_trip": slippage_bps,
            "minimum_net_return_bps_for_label": min_net_return_bps,
        },
        "dataset_sha256": hashes,
        "checkpoint_fingerprint": checkpoint_fingerprint,
        "governance": {
            "lookahead_allowed": False,
            "approved_for_staging": False,
            "approved_for_live": False,
            "purpose": "research walk-forward evaluation only",
        },
        "validation_predictions_path": exported_predictions_path,
        **evaluation,
    }

    output = Path(report_path)
    output.parent.mkdir(parents=True, exist_ok=True)
    report_tmp = output.with_suffix(output.suffix + ".tmp")
    report_tmp.write_text(
        json.dumps(report, indent=2, sort_keys=True), encoding="utf-8"
    )
    report_tmp.replace(output)
    return {**report, "report_path": str(output)}


def _parse_dataset_args(values: list[str]) -> dict[str, str]:
    result: dict[str, str] = {}
    for value in values:
        instrument, separator, path = value.partition("=")
        instrument = instrument.strip().upper()
        if not separator or not path.strip():
            raise ValueError("--dataset values must use INSTRUMENT=/path/to/corpus.csv")
        if instrument in result:
            raise ValueError(f"Duplicate dataset for {instrument}")
        result[instrument] = path.strip()
    return result


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Evaluate pooled causal MTF XGBoost with historical spread costs"
    )
    parser.add_argument(
        "--dataset",
        action="append",
        required=True,
        help="Repeat as INSTRUMENT=/path/to/MTF.csv",
    )
    parser.add_argument("--horizon-bars", type=int, default=5)
    parser.add_argument("--confidence-threshold", type=float, default=0.60)
    parser.add_argument("--min-net-return-bps", type=float, default=0.0)
    parser.add_argument("--commission-bps", type=float, default=0.0)
    parser.add_argument("--slippage-bps", type=float, default=0.0)
    parser.add_argument("--max-splits", type=int, default=5)
    parser.add_argument("--report", required=True)
    parser.add_argument(
        "--predictions",
        help="Optional CSV path for causal outer-fold validation predictions",
    )
    args = parser.parse_args()

    report = evaluate_multi_pair_corpora(
        _parse_dataset_args(args.dataset),
        horizon_bars=args.horizon_bars,
        report_path=args.report,
        confidence_threshold=args.confidence_threshold,
        min_net_return_bps=args.min_net_return_bps,
        commission_bps=args.commission_bps,
        slippage_bps=args.slippage_bps,
        max_splits=args.max_splits,
        predictions_path=args.predictions,
    )
    print(json.dumps(report, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
