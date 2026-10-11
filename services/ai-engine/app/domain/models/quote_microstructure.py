"""LIVE-reproducible one-second quote microstructure features."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Iterable

import numpy as np
import pandas as pd

QUOTE_MICROSTRUCTURE_FEATURE_COLUMNS = (
    "quote_samples_60s",
    "quote_coverage_60s",
    "quote_mid_return_5s",
    "quote_mid_return_15s",
    "quote_mid_return_30s",
    "quote_mid_return_60s",
    "quote_realized_vol_60s",
    "quote_mid_range_bps_60s",
    "quote_spread_last_bps",
    "quote_spread_mean_bps_60s",
    "quote_spread_max_bps_60s",
    "quote_spread_change_15s",
    "quote_direction_imbalance_60s",
    "quote_max_abs_1s_return_bps_60s",
)


@dataclass(frozen=True)
class QuoteSnapshot:
    timestamp: datetime
    bid: float
    ask: float


def _utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


def snapshots_from_dukascopy_ticks(
    ticks: Iterable[tuple[datetime, float, float, float, float, int]],
) -> list[QuoteSnapshot]:
    """Downsample raw Dukascopy ticks to the last quote observed each UTC second."""
    by_second: dict[datetime, QuoteSnapshot] = {}
    for timestamp, ask, bid, _ask_volume, _bid_volume, _spread_points in ticks:
        ts = _utc(timestamp)
        second = ts.replace(microsecond=0)
        snap = QuoteSnapshot(timestamp=ts, bid=float(bid), ask=float(ask))
        prior = by_second.get(second)
        if prior is None or ts >= prior.timestamp:
            by_second[second] = snap
    return [by_second[key] for key in sorted(by_second)]


def compute_quote_microstructure_features(
    snapshots: Iterable[QuoteSnapshot],
    *,
    decision_time: datetime,
) -> dict[str, float]:
    """Compute features from quotes in [decision_time-60s, decision_time)."""
    decision = _utc(decision_time)
    start = decision - timedelta(seconds=60)
    rows = [s for s in snapshots if start <= _utc(s.timestamp) < decision]
    if not rows:
        raise ValueError("No quote snapshots available in the preceding 60 seconds")

    records = []
    for snapshot in rows:
        ts = _utc(snapshot.timestamp)
        bid = float(snapshot.bid)
        ask = float(snapshot.ask)
        if bid <= 0 or ask <= 0 or ask < bid:
            raise ValueError("Invalid bid/ask quote geometry")
        mid = (bid + ask) / 2.0
        spread_bps = (ask - bid) / mid * 10_000.0
        records.append((ts, bid, ask, mid, spread_bps))

    frame = pd.DataFrame(
        records,
        columns=["timestamp", "bid", "ask", "mid", "spread_bps"],
    ).sort_values("timestamp")
    frame["second"] = frame["timestamp"].dt.floor("s")
    frame = frame.groupby("second", as_index=False).tail(1).sort_values("second")
    frame = frame.set_index("second")

    full_index = pd.date_range(
        start=start.replace(microsecond=0),
        end=(decision - timedelta(seconds=1)).replace(microsecond=0),
        freq="1s",
        tz=UTC,
    )
    sampled = frame.reindex(full_index)
    observed = int(sampled["mid"].notna().sum())
    sampled[["mid", "spread_bps"]] = sampled[["mid", "spread_bps"]].ffill()
    sampled = sampled.dropna(subset=["mid", "spread_bps"])
    if len(sampled) < 5:
        raise ValueError("Insufficient quote coverage for microstructure features")

    mid = sampled["mid"].astype(float)
    spread = sampled["spread_bps"].astype(float)
    eps = 1e-12

    def lag_return(seconds: int) -> float:
        if len(mid) <= seconds:
            return 0.0
        base = float(mid.iloc[-1 - seconds])
        return float(mid.iloc[-1] / max(abs(base), eps) - 1.0)

    one_sec_returns = mid.pct_change().dropna()
    signs = np.sign(one_sec_returns.to_numpy(float))
    directional = signs[signs != 0]
    direction_imbalance = float(directional.mean()) if len(directional) else 0.0

    values = {
        "quote_samples_60s": float(observed),
        "quote_coverage_60s": float(observed / 60.0),
        "quote_mid_return_5s": lag_return(5),
        "quote_mid_return_15s": lag_return(15),
        "quote_mid_return_30s": lag_return(30),
        "quote_mid_return_60s": lag_return(min(59, len(mid) - 1)),
        "quote_realized_vol_60s": (
            float(one_sec_returns.std(ddof=0)) if len(one_sec_returns) else 0.0
        ),
        "quote_mid_range_bps_60s": float(
            (mid.max() - mid.min()) / max(abs(mid.iloc[-1]), eps) * 10_000.0
        ),
        "quote_spread_last_bps": float(spread.iloc[-1]),
        "quote_spread_mean_bps_60s": float(spread.mean()),
        "quote_spread_max_bps_60s": float(spread.max()),
        "quote_spread_change_15s": (
            float(spread.iloc[-1] - spread.iloc[-16]) if len(spread) >= 16 else 0.0
        ),
        "quote_direction_imbalance_60s": direction_imbalance,
        "quote_max_abs_1s_return_bps_60s": (
            float(one_sec_returns.abs().max() * 10_000.0)
            if len(one_sec_returns)
            else 0.0
        ),
    }
    array = np.asarray(list(values.values()), dtype=float)
    if not np.isfinite(array).all():
        raise ValueError("Quote microstructure feature vector contains non-finite values")
    return values
