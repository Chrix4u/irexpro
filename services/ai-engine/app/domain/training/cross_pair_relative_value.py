from __future__ import annotations

import json
from collections.abc import Callable, Mapping
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from app.domain.training.short_horizon_barrier_calibrated import (
    _barrier_metrics,
    _split_barrier_train_calibration,
    collapse_non_overlapping_barrier_signals,
)
from app.domain.training.train_multitimeframe import load_and_prepare_corpora
from app.domain.training.validation import iter_purged_walk_forward_time_splits

PAIRS = ("AUDUSD", "EURUSD", "GBPUSD", "USDCAD", "USDCHF", "USDJPY")
USD_BASE_PAIRS = frozenset({"USDCAD", "USDCHF", "USDJPY"})
USD_QUOTE_PAIRS = frozenset({"AUDUSD", "EURUSD", "GBPUSD"})
FROZEN_CORPUS_SHA256 = {
    "AUDUSD": "3531aeaf9e690674efb07eedbd1ade20ee51ee8d785bbc34a7c43ae8d3ad1d3a",
    "EURUSD": "ee1934c2d58e23689e8a0b12a8c479bb2fa36f9236b9d99100eea66749c52375",
    "GBPUSD": "e2faad48912271a0a3a5edc72624974c247fbb8aaec3bf25605c7c574ddd0348",
    "USDCAD": "17fec4b7825e46f0c9c58cb5666b038f25f9f5b80763e7d518e292d47f17181b",
    "USDCHF": "1649d1f1cc4816ef2b0bb419b0b4d69a125276b918a0da0457bbb3d857b62bce",
    "USDJPY": "3601e7a92bda8ac36fd99a983f38827da435848bb12ee17afda8b3b02ff785db",
}
PARTICIPATION_TARGET_PER_DAY = 24.0


def build_cross_pair_residual_frame(
    frame: pd.DataFrame,
    *,
    rolling_window: int = 60,
) -> pd.DataFrame:
    """Build causal leave-one-out USD-factor residual features for synchronized six-pair rows."""
    required = {"decision_time", "instrument", "m1_simple_return"}
    missing = sorted(required.difference(frame.columns))
    if missing:
        raise ValueError(f"cross-pair frame missing columns: {missing}")
    if rolling_window < 1:
        raise ValueError("rolling_window must be positive")

    result = frame.copy()
    result["decision_time"] = pd.to_datetime(result["decision_time"], utc=True, errors="raise")
    result["instrument"] = result["instrument"].astype(str).str.upper()
    result = result.loc[result["instrument"].isin(PAIRS)].copy()
    if result.duplicated(["decision_time", "instrument"]).any():
        raise ValueError("cross-pair input requires one row per decision_time/instrument")

    counts = result.groupby("decision_time")["instrument"].nunique()
    complete_times = counts.index[counts.eq(len(PAIRS))]
    result = result.loc[result["decision_time"].isin(complete_times)].copy()
    if result.empty:
        return result.assign(
            usd_signed_return=pd.Series(dtype=float),
            peer_usd_median_return=pd.Series(dtype=float),
            cross_pair_residual=pd.Series(dtype=float),
            cross_pair_residual_mean=pd.Series(dtype=float),
            cross_pair_residual_std=pd.Series(dtype=float),
            cross_pair_residual_z=pd.Series(dtype=float),
        )

    pair_return = pd.to_numeric(result["m1_simple_return"], errors="raise").to_numpy(dtype=float)
    base = result["instrument"].isin(USD_BASE_PAIRS).to_numpy()
    result["usd_signed_return"] = np.where(base, pair_return, -pair_return)

    wide = result.pivot(
        index="decision_time",
        columns="instrument",
        values="usd_signed_return",
    ).reindex(columns=PAIRS)
    peer_parts: list[pd.DataFrame] = []
    for pair in PAIRS:
        peer_median = wide.drop(columns=pair).median(axis=1)
        peer_parts.append(
            pd.DataFrame(
                {
                    "decision_time": peer_median.index,
                    "instrument": pair,
                    "peer_usd_median_return": peer_median.to_numpy(dtype=float),
                }
            )
        )
    peers = pd.concat(peer_parts, ignore_index=True)
    result = result.merge(
        peers,
        on=["decision_time", "instrument"],
        how="inner",
        validate="one_to_one",
    )
    result["cross_pair_residual"] = (
        result["usd_signed_return"] - result["peer_usd_median_return"]
    )
    result = result.sort_values(["instrument", "decision_time"]).reset_index(drop=True)

    means = pd.Series(index=result.index, dtype=float)
    stds = pd.Series(index=result.index, dtype=float)
    for _, indexes in result.groupby("instrument", sort=False).groups.items():
        values = result.loc[indexes, "cross_pair_residual"]
        rolling = values.rolling(window=rolling_window, min_periods=rolling_window)
        means.loc[indexes] = rolling.mean().to_numpy(dtype=float)
        stds.loc[indexes] = rolling.std(ddof=0).to_numpy(dtype=float)
    result["cross_pair_residual_mean"] = means
    result["cross_pair_residual_std"] = stds
    safe_std = result["cross_pair_residual_std"].where(result["cross_pair_residual_std"] > 0.0)
    result["cross_pair_residual_z"] = (
        result["cross_pair_residual"] - result["cross_pair_residual_mean"]
    ) / safe_std

    return result.sort_values(["decision_time", "instrument"]).reset_index(drop=True)


RESIDUAL_QUANTILES = (0.70, 0.80, 0.90, 0.95)
HYPOTHESES = ("mean_reversion", "continuation")


@dataclass(frozen=True)
class RelativeValuePolicy:
    passed: bool
    reason: str
    hypothesis: str | None
    quantile: float | None
    min_abs_residual_z: float | None
    active_rows: int
    density: float
    mean_net_return: float
    profit_factor: float | None
    profit_throughput: float
    long_fraction: float
    short_fraction: float


def _profit_factor(values: np.ndarray) -> float | None:
    gains = float(values[values > 0.0].sum())
    losses = float(-values[values < 0.0].sum())
    return gains / losses if losses > 0.0 else None


def _predicted_long_for_hypothesis(frame: pd.DataFrame, hypothesis: str) -> np.ndarray:
    if hypothesis not in HYPOTHESES:
        raise ValueError(f"unsupported relative-value hypothesis: {hypothesis}")
    residual = pd.to_numeric(frame["cross_pair_residual_z"], errors="raise").to_numpy(dtype=float)
    residual_sign = np.sign(residual)
    hypothesis_sign = -1.0 if hypothesis == "mean_reversion" else 1.0
    desired_usd_sign = hypothesis_sign * residual_sign
    base_orientation = frame["instrument"].astype(str).str.upper().isin(USD_BASE_PAIRS).to_numpy()
    pair_orientation = np.where(base_orientation, 1.0, -1.0)
    desired_pair_sign = desired_usd_sign * pair_orientation
    return desired_pair_sign > 0.0


def _route_with_parameters(
    frame: pd.DataFrame,
    *,
    hypothesis: str,
    min_abs_residual_z: float,
) -> pd.DataFrame:
    result = frame.copy()
    residual = pd.to_numeric(result["cross_pair_residual_z"], errors="coerce").to_numpy(dtype=float)
    finite = np.isfinite(residual)
    active = finite & (np.abs(residual) >= float(min_abs_residual_z))
    predicted_long = _predicted_long_for_hypothesis(result, hypothesis)
    long_return = pd.to_numeric(result["long_net_return"], errors="raise").to_numpy(dtype=float)
    short_return = pd.to_numeric(result["short_net_return"], errors="raise").to_numpy(dtype=float)
    selected = np.where(predicted_long, long_return, short_return)
    result["active_trade"] = active
    result["predicted_long"] = predicted_long
    result["selected_net_return"] = np.where(active, selected, 0.0)
    return result


def calibrate_relative_value_policy(
    calibration_frame: pd.DataFrame,
    *,
    min_active_rows: int = 200,
    min_side_fraction: float = 0.05,
) -> RelativeValuePolicy:
    """Choose one bounded residual-tail rule using calibration data only."""
    required = {
        "instrument",
        "cross_pair_residual_z",
        "long_net_return",
        "short_net_return",
    }
    missing = sorted(required.difference(calibration_frame.columns))
    if missing:
        raise ValueError(f"relative-value calibration missing columns: {missing}")
    z = pd.to_numeric(calibration_frame["cross_pair_residual_z"], errors="coerce")
    finite_abs = z.abs().replace([np.inf, -np.inf], np.nan).dropna()
    if len(finite_abs) < min_active_rows:
        return RelativeValuePolicy(
            False,
            "INSUFFICIENT_CALIBRATION_EVIDENCE",
            None,
            None,
            None,
            0,
            0.0,
            0.0,
            None,
            0.0,
            0.0,
            0.0,
        )

    candidates: list[RelativeValuePolicy] = []
    for hypothesis in HYPOTHESES:
        for quantile in RESIDUAL_QUANTILES:
            floor = float(finite_abs.quantile(quantile))
            routed = _route_with_parameters(
                calibration_frame,
                hypothesis=hypothesis,
                min_abs_residual_z=floor,
            )
            active = routed.loc[routed["active_trade"]].copy()
            active_rows = int(len(active))
            if active_rows == 0:
                continue
            values = pd.to_numeric(active["selected_net_return"], errors="raise").to_numpy(dtype=float)
            predicted_long = active["predicted_long"].astype(bool).to_numpy()
            long_fraction = float(predicted_long.mean())
            short_fraction = 1.0 - long_fraction
            mean_net = float(values.mean())
            pf = _profit_factor(values)
            density = float(active_rows / len(calibration_frame))
            throughput = float(values.sum() / len(calibration_frame))
            eligible = bool(
                active_rows >= min_active_rows
                and long_fraction >= min_side_fraction
                and short_fraction >= min_side_fraction
                and mean_net > 0.0
                and pf is not None
                and pf >= 1.10
            )
            candidates.append(
                RelativeValuePolicy(
                    eligible,
                    "PASSED" if eligible else "NO_ECONOMIC_RESIDUAL_TAIL",
                    hypothesis,
                    float(quantile),
                    floor,
                    active_rows,
                    density,
                    mean_net,
                    pf,
                    throughput,
                    long_fraction,
                    short_fraction,
                )
            )

    eligible = [candidate for candidate in candidates if candidate.passed]
    if eligible:
        return max(
            eligible,
            key=lambda candidate: (
                candidate.profit_throughput,
                candidate.profit_factor or 0.0,
                candidate.active_rows,
            ),
        )
    if candidates:
        best = max(
            candidates,
            key=lambda candidate: (
                candidate.profit_throughput,
                candidate.profit_factor or -1.0,
                candidate.active_rows,
            ),
        )
        return RelativeValuePolicy(
            False,
            "NO_ECONOMIC_RESIDUAL_TAIL",
            best.hypothesis,
            best.quantile,
            best.min_abs_residual_z,
            best.active_rows,
            best.density,
            best.mean_net_return,
            best.profit_factor,
            best.profit_throughput,
            best.long_fraction,
            best.short_fraction,
        )
    return RelativeValuePolicy(
        False,
        "NO_ECONOMIC_RESIDUAL_TAIL",
        None,
        None,
        None,
        0,
        0.0,
        0.0,
        None,
        0.0,
        0.0,
        0.0,
    )


def route_relative_value_signals(
    frame: pd.DataFrame,
    policy: RelativeValuePolicy,
) -> pd.DataFrame:
    """Apply a frozen calibration policy; failed/missing calibration abstains."""
    if not policy.passed or policy.hypothesis is None or policy.min_abs_residual_z is None:
        result = frame.copy()
        result["active_trade"] = False
        result["predicted_long"] = False
        result["selected_net_return"] = 0.0
        return result
    return _route_with_parameters(
        frame,
        hypothesis=policy.hypothesis,
        min_abs_residual_z=policy.min_abs_residual_z,
    )



def _relative_value_balanced_accuracy(predictions: pd.DataFrame) -> float | None:
    active = predictions.loc[predictions["active_trade"].astype(bool)].copy()
    if active.empty:
        return None
    long_return = pd.to_numeric(active["long_net_return"], errors="raise").to_numpy(dtype=float)
    short_return = pd.to_numeric(active["short_net_return"], errors="raise").to_numpy(dtype=float)
    truth = long_return >= short_return
    predicted = active["predicted_long"].astype(bool).to_numpy()
    if len(np.unique(truth)) < 2:
        return None
    recalls: list[float] = []
    for klass in (False, True):
        mask = truth == klass
        recalls.append(float((predicted[mask] == klass).mean()))
    return float(np.mean(recalls))


def evaluate_relative_value_frame(
    frame: pd.DataFrame,
    *,
    horizon_bars: int = 1,
    min_train_periods: int,
    validation_periods: int,
    max_splits: int = 1,
    rolling_window: int = 60,
    calibration_min_periods: int = 200,
    calibration_min_rows: int = 200,
    calibrator: Callable[..., RelativeValuePolicy] = calibrate_relative_value_policy,
    router: Callable[[pd.DataFrame, RelativeValuePolicy], pd.DataFrame] = route_relative_value_signals,
) -> dict[str, Any]:
    """Run a leak-free one-fold relative-value screen on a prepared six-pair frame."""
    if horizon_bars != 1:
        raise ValueError("cross-pair relative-value v1 is locked to horizon 1")
    if min_train_periods < 1 or validation_periods < 1:
        raise ValueError("train and validation periods must be positive")

    required = {
        "decision_time",
        "instrument",
        "m1_simple_return",
        "long_net_return",
        "short_net_return",
    }
    missing = sorted(required.difference(frame.columns))
    if missing:
        raise ValueError(f"relative-value evaluator missing columns: {missing}")
    observed = set(frame["instrument"].astype(str).str.upper().unique())
    if observed != set(PAIRS):
        raise ValueError(
            "relative-value evaluator requires exact six-pair universe; "
            f"got {sorted(observed)}"
        )

    dataset = build_cross_pair_residual_frame(frame, rolling_window=rolling_window)
    dataset = dataset.dropna(subset=["cross_pair_residual_z"]).copy()
    dataset = dataset.sort_values(["decision_time", "instrument"]).reset_index(drop=True)
    if dataset.empty:
        raise ValueError("relative-value residual frame contains no scorable rows")

    folds: list[dict[str, Any]] = []
    predictions: list[pd.DataFrame] = []
    for fold_index, (outer_train, validation) in enumerate(
        iter_purged_walk_forward_time_splits(
            dataset,
            time_column="decision_time",
            min_train_periods=min_train_periods,
            validation_periods=validation_periods,
            purge_periods=horizon_bars,
            embargo_periods=horizon_bars,
            max_splits=max_splits,
        ),
        start=1,
    ):
        fit_frame, calibration_frame = _split_barrier_train_calibration(
            outer_train,
            horizon_bars=horizon_bars,
            minimum_calibration_periods=calibration_min_periods,
        )
        policy = calibrator(calibration_frame, min_active_rows=calibration_min_rows)
        routed = router(validation.copy(), policy)
        required_route = {"active_trade", "predicted_long", "selected_net_return"}
        missing_route = sorted(required_route.difference(routed.columns))
        if missing_route:
            raise ValueError(f"relative-value router omitted columns: {missing_route}")
        routed["fold"] = fold_index
        fold_periods = collapse_non_overlapping_barrier_signals(
            routed,
            horizon_bars=horizon_bars,
        )
        fold_validation_days = int(
            routed["decision_time"].dt.normalize().drop_duplicates().shape[0]
        )
        fold_metrics = _barrier_metrics(
            fold_periods,
            validation_days=fold_validation_days,
        )
        folds.append(
            {
                "fold": fold_index,
                "fit_start": pd.Timestamp(fit_frame["decision_time"].min()).isoformat(),
                "fit_end": pd.Timestamp(fit_frame["decision_time"].max()).isoformat(),
                "outer_train_end": pd.Timestamp(outer_train["decision_time"].max()).isoformat(),
                "calibration_start": pd.Timestamp(
                    calibration_frame["decision_time"].min()
                ).isoformat(),
                "calibration_end": pd.Timestamp(
                    calibration_frame["decision_time"].max()
                ).isoformat(),
                "validation_start": pd.Timestamp(validation["decision_time"].min()).isoformat(),
                "validation_end": pd.Timestamp(validation["decision_time"].max()).isoformat(),
                "calibration_policy": asdict(policy),
                "active_signals": int(routed["active_trade"].sum()),
                "non_overlapping_opportunities": int(len(fold_periods)),
                "total_return": float(fold_metrics["total_return"]),
            }
        )
        predictions.append(routed)

    if not predictions:
        raise ValueError("relative-value evaluator produced no validation folds")
    all_predictions = pd.concat(predictions, ignore_index=True)
    periods = collapse_non_overlapping_barrier_signals(
        all_predictions,
        horizon_bars=horizon_bars,
    )
    validation_days = int(
        all_predictions["decision_time"].dt.normalize().drop_duplicates().shape[0]
    )
    metrics = _barrier_metrics(periods, validation_days=validation_days)
    opportunities_per_day = float(len(periods) / max(validation_days, 1))
    balanced_accuracy = _relative_value_balanced_accuracy(all_predictions)

    instrument_positive = {pair: False for pair in PAIRS}
    for pair in PAIRS:
        group = all_predictions.loc[all_predictions["instrument"].eq(pair)]
        selected = group.loc[group["active_trade"].astype(bool), "selected_net_return"]
        instrument_positive[pair] = bool(len(selected) and float(selected.sum()) > 0.0)
    positive_instrument_fraction = float(sum(instrument_positive.values()) / len(PAIRS))
    positive_fold_fraction = float(
        sum(float(fold["total_return"]) > 0.0 for fold in folds) / len(folds)
    )

    profit_factor = metrics["profit_factor"]
    sharpe = metrics["sharpe_ratio"]
    max_drawdown = float(metrics["max_drawdown"])
    gates = {
        "participation": opportunities_per_day >= PARTICIPATION_TARGET_PER_DAY,
        "balanced_accuracy": balanced_accuracy is not None and balanced_accuracy >= 0.52,
        "profit_factor": profit_factor is not None and float(profit_factor) >= 1.15,
        "sharpe": sharpe is not None and float(sharpe) >= 1.0,
        "max_drawdown": max_drawdown <= 0.12,
        "positive_fold_fraction": positive_fold_fraction >= 0.60,
        "positive_instrument_fraction": positive_instrument_fraction >= 0.67,
    }
    return {
        "candidate": "cross-pair-relative-value-v1",
        "research_only": True,
        "approved_for_paper": False,
        "approved_for_demo": False,
        "approved_for_live": False,
        "horizon_minutes": horizon_bars,
        "protocol": {
            "purge_periods": horizon_bars,
            "embargo_periods": horizon_bars,
            "inner_calibration_train_only": True,
            "leave_one_out_usd_factor": True,
            "all_six_pairs_required": True,
            "non_overlapping_portfolio_counting": True,
        },
        "folds": folds,
        "classification": {"balanced_accuracy": balanced_accuracy},
        "trading": metrics,
        "participation": {
            "raw_active_signals": int(all_predictions["active_trade"].sum()),
            "non_overlapping_opportunities": int(len(periods)),
            "validation_days": validation_days,
            "opportunities_per_validation_day": opportunities_per_day,
            "target_per_validation_day": PARTICIPATION_TARGET_PER_DAY,
        },
        "robustness": {
            "positive_fold_fraction": positive_fold_fraction,
            "positive_instrument_fraction": positive_instrument_fraction,
            "instrument_positive": instrument_positive,
        },
        "gates": gates,
        "research_gate_passed": all(gates.values()),
    }


def evaluate_relative_value_corpora(
    datasets: Mapping[str, str | Path],
    *,
    report_path: str | Path,
    decision_time_before: str | pd.Timestamp,
    min_train_periods: int | None = None,
    validation_periods: int = 7200,
    max_splits: int = 1,
    rolling_window: int = 60,
    calibration_min_periods: int = 200,
    calibration_min_rows: int = 200,
    commission_bps: float = 0.0,
    slippage_bps: float = 0.0,
) -> dict[str, Any]:
    """Load the immutable six-pair corpora, verify hashes, evaluate, and write atomically."""
    normalized = {str(key).upper(): value for key, value in datasets.items()}
    if set(normalized) != set(PAIRS):
        raise ValueError(
            "relative-value corpus evaluation requires exact six-pair universe; "
            f"got {sorted(normalized)}"
        )
    pooled, hashes = load_and_prepare_corpora(
        normalized,
        horizon_bars=1,
        commission_bps=commission_bps,
        slippage_bps=slippage_bps,
        decision_time_before=decision_time_before,
    )
    if hashes != FROZEN_CORPUS_SHA256:
        mismatches = {
            pair: {"expected": FROZEN_CORPUS_SHA256.get(pair), "observed": hashes.get(pair)}
            for pair in PAIRS
            if hashes.get(pair) != FROZEN_CORPUS_SHA256.get(pair)
        }
        raise ValueError(f"frozen corpus SHA-256 mismatch: {mismatches}")

    unique_periods = int(pd.to_datetime(pooled["decision_time"], utc=True).nunique())
    train_periods = min_train_periods or max(1000, int(unique_periods * 0.70))
    if train_periods + 1 + validation_periods > unique_periods:
        validation_periods = max(200, unique_periods - train_periods - 1)
    report = evaluate_relative_value_frame(
        pooled,
        horizon_bars=1,
        min_train_periods=train_periods,
        validation_periods=validation_periods,
        max_splits=max_splits,
        rolling_window=rolling_window,
        calibration_min_periods=calibration_min_periods,
        calibration_min_rows=calibration_min_rows,
    )
    # Governance is immutable for v1 even if a test double or future refactor
    # accidentally returns a promotable-looking frame report.
    report["research_only"] = True
    report["approved_for_paper"] = False
    report["approved_for_demo"] = False
    report["approved_for_live"] = False
    report["dataset_sha256"] = hashes
    report["decision_time_before"] = pd.Timestamp(decision_time_before).isoformat()
    report["cost_model"] = {
        "commission_bps_round_trip": float(commission_bps),
        "slippage_bps_round_trip": float(slippage_bps),
        "historical_spread": "half spread at entry + half spread at exit",
    }

    output = Path(report_path)
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(output.suffix + ".tmp")
    temporary.write_text(
        json.dumps(report, indent=2, sort_keys=True, default=str),
        encoding="utf-8",
    )
    temporary.replace(output)
    return {**report, "report_path": str(output)}
