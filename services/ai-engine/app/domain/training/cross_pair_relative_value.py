from __future__ import annotations

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
