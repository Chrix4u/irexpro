from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

PAIRS = ("AUDUSD", "EURUSD", "GBPUSD", "USDCAD", "USDCHF", "USDJPY")
USD_BASE_PAIRS = frozenset({"USDCAD", "USDCHF", "USDJPY"})
USD_QUOTE_PAIRS = frozenset({"AUDUSD", "EURUSD", "GBPUSD"})


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
