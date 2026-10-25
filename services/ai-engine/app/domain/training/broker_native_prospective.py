from __future__ import annotations

from collections.abc import Callable, Sequence

import numpy as np
import pandas as pd
from sklearn.metrics import balanced_accuracy_score

PAIRS = ("EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCAD", "USDCHF")
SPREAD_FLOOR_POINTS = {
    "EURUSD": 10.0,
    "GBPUSD": 12.0,
    "USDJPY": 10.0,
    "AUDUSD": 10.0,
    "USDCAD": 12.0,
    "USDCHF": 12.0,
}
ATR_MULTIPLIER = 1.0
SPREAD_MULTIPLIER = 2.0
SLIPPAGE_SPREAD_FRACTION = 0.25
EPS = 1e-12

BASE_FEATURES = (
    "ret1_bps",
    "ret2_bps",
    "ret5_bps",
    "ret10_bps",
    "range_bps",
    "body_bps",
    "close_location",
    "atr_pct_14",
    "vol10_bps",
    "vol20_bps",
    "vol60_bps",
    "ema5_20_bps",
    "ema10_40_bps",
    "rsi14",
    "hour_sin",
    "hour_cos",
    "dow_sin",
    "dow_cos",
)


def contiguous_context_mask(
    timestamps: pd.Series,
    *,
    lookback_bars: int,
    horizon_bars: int,
) -> pd.Series:
    """Keep rows whose full past-context and future-label window is minute-contiguous."""
    values = pd.to_datetime(timestamps, utc=True, errors="coerce")
    one_minute = pd.Timedelta(minutes=1)
    step_ok = values.diff().eq(one_minute).to_numpy(dtype=bool)
    bad_steps = (~step_ok).astype(np.int64)
    if len(bad_steps):
        bad_steps[0] = 0
    bad_prefix = np.cumsum(bad_steps)
    valid = np.zeros(len(values), dtype=bool)
    for index in range(lookback_bars, len(values) - horizon_bars):
        first_step = index - lookback_bars + 1
        last_step = index + horizon_bars
        failures = bad_prefix[last_step] - (
            bad_prefix[first_step - 1] if first_step > 0 else 0
        )
        valid[index] = failures == 0
    return pd.Series(valid, index=timestamps.index)


def chronological_fit_calibration_split(
    frame: pd.DataFrame,
    *,
    horizon_bars: int,
    calibration_fraction: float = 0.20,
    min_calibration_rows: int = 500,
) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Chronological train/calibration split with a horizon-sized purge."""
    if frame.empty:
        raise ValueError("development frame is empty")
    ordered = frame.sort_values("timestamp").copy()
    split = int(len(ordered) * (1.0 - calibration_fraction))
    split = min(max(split, 1), len(ordered) - 1)
    if len(ordered) - split < min_calibration_rows:
        split = len(ordered) - min_calibration_rows
    if split <= horizon_bars or split <= 0:
        raise ValueError("insufficient rows for purged fit/calibration split")
    fit = ordered.iloc[: split - horizon_bars].copy()
    calibration = ordered.iloc[split:].copy()
    if len(calibration) < min_calibration_rows:
        raise ValueError("insufficient calibration rows")
    return fit, calibration


def _rsi(series: pd.Series, periods: int = 14) -> pd.Series:
    delta = series.diff()
    up = delta.clip(lower=0).rolling(periods, min_periods=periods).mean()
    down = (-delta.clip(upper=0)).rolling(periods, min_periods=periods).mean()
    ratio = up / (down + EPS)
    return 100.0 - 100.0 / (1.0 + ratio)


def _prepare_raw(frame: pd.DataFrame, pair: str) -> pd.DataFrame:
    result = frame.copy()
    result["timestamp"] = pd.to_datetime(result["timestamp"], utc=True, errors="raise")
    for column in ("open", "high", "low", "close", "tickVolume", "spreadPoints", "priceDigits"):
        result[column] = pd.to_numeric(result[column], errors="coerce")
    result = result.sort_values("timestamp").drop_duplicates("timestamp").reset_index(drop=True)
    result["instrument"] = pair
    return result


def _add_base_features(frame: pd.DataFrame, pair: str) -> pd.DataFrame:
    result = frame.copy()
    close = result["close"].astype(float)
    previous = close.shift(1)
    true_range = pd.concat(
        [
            result["high"] - result["low"],
            (result["high"] - previous).abs(),
            (result["low"] - previous).abs(),
        ],
        axis=1,
    ).max(axis=1)
    atr = true_range.rolling(14, min_periods=14).mean()
    result["atr_pct_14"] = atr / (close.abs() + EPS)

    digits = int(result["priceDigits"].dropna().mode().iloc[0])
    point = 10.0 ** (-digits)
    observed_spread_price = result["spreadPoints"].fillna(0).clip(lower=0) * point
    floor_spread_price = SPREAD_FLOOR_POINTS[pair] * point
    result["effective_spread_price"] = np.maximum(observed_spread_price, floor_spread_price)
    result["effective_spread_bps"] = result["effective_spread_price"] / close * 10000.0

    for periods in (1, 2, 5, 10):
        result[f"ret{periods}_bps"] = (close / close.shift(periods) - 1.0) * 10000.0
    result["range_bps"] = (result["high"] - result["low"]) / (close.abs() + EPS) * 10000.0
    result["body_bps"] = (result["close"] - result["open"]) / (result["open"].abs() + EPS) * 10000.0
    result["close_location"] = (result["close"] - result["low"]) / (
        (result["high"] - result["low"]).abs() + EPS
    )
    for periods in (10, 20, 60):
        result[f"vol{periods}_bps"] = result["ret1_bps"].rolling(periods, min_periods=periods).std()
    result["ema5_20_bps"] = (
        close.ewm(span=5, adjust=False).mean() / close.ewm(span=20, adjust=False).mean() - 1.0
    ) * 10000.0
    result["ema10_40_bps"] = (
        close.ewm(span=10, adjust=False).mean() / close.ewm(span=40, adjust=False).mean() - 1.0
    ) * 10000.0
    result["rsi14"] = _rsi(close)
    hour = result["timestamp"].dt.hour + result["timestamp"].dt.minute / 60.0
    day = result["timestamp"].dt.day_of_week
    result["hour_sin"] = np.sin(2 * np.pi * hour / 24.0)
    result["hour_cos"] = np.cos(2 * np.pi * hour / 24.0)
    result["dow_sin"] = np.sin(2 * np.pi * day / 7.0)
    result["dow_cos"] = np.cos(2 * np.pi * day / 7.0)
    for candidate in PAIRS:
        result[f"pair_{candidate}"] = float(pair == candidate)
    return result


def _add_event_labels(frame: pd.DataFrame, horizon_bars: int) -> pd.DataFrame:
    result = frame.copy()
    close = result["close"].astype(float)
    spread_price = result["effective_spread_price"].astype(float)
    spread_bps = result["effective_spread_bps"].astype(float)
    atr_pct = result["atr_pct_14"].astype(float)
    barrier = np.maximum(
        ATR_MULTIPLIER * atr_pct.to_numpy(),
        SPREAD_MULTIPLIER * spread_bps.to_numpy() / 10000.0,
    )
    barrier = np.maximum(barrier, 1e-8)

    n = len(result)
    actionable = np.zeros(n, dtype=int)
    direction = np.zeros(n, dtype=int)
    event_step = np.full(n, horizon_bars, dtype=int)
    unresolved = np.ones(n, dtype=bool)
    long_entry = close + spread_price / 2.0
    short_entry = close - spread_price / 2.0
    horizon_close = close.shift(-horizon_bars)
    horizon_spread = spread_price.shift(-horizon_bars)
    extra_cost = SLIPPAGE_SPREAD_FRACTION * spread_bps / 10000.0
    horizon_long = (horizon_close - horizon_spread / 2.0) / long_entry - 1.0 - extra_cost
    horizon_short = (short_entry - (horizon_close + horizon_spread / 2.0)) / short_entry - extra_cost
    event_long = horizon_long.to_numpy(dtype=float).copy()
    event_short = horizon_short.to_numpy(dtype=float).copy()

    for step in range(1, horizon_bars + 1):
        future_close = close.shift(-step)
        future_spread = spread_price.shift(-step)
        long_return = (
            (future_close - future_spread / 2.0) / long_entry - 1.0 - extra_cost
        ).to_numpy(dtype=float)
        short_return = (
            (short_entry - (future_close + future_spread / 2.0)) / short_entry - extra_cost
        ).to_numpy(dtype=float)
        finite = np.isfinite(long_return) & np.isfinite(short_return)
        long_hit = unresolved & finite & (long_return >= barrier)
        short_hit = unresolved & finite & (short_return >= barrier)
        ambiguous = long_hit & short_hit
        unresolved[ambiguous] = False
        event_step[ambiguous] = step
        only_long = long_hit & ~short_hit
        actionable[only_long] = 1
        direction[only_long] = 1
        event_step[only_long] = step
        event_long[only_long] = long_return[only_long]
        event_short[only_long] = short_return[only_long]
        unresolved[only_long] = False
        only_short = short_hit & ~long_hit
        actionable[only_short] = 1
        direction[only_short] = 0
        event_step[only_short] = step
        event_long[only_short] = long_return[only_short]
        event_short[only_short] = short_return[only_short]
        unresolved[only_short] = False

    result[f"actionable_{horizon_bars}"] = actionable
    result[f"direction_long_{horizon_bars}"] = direction
    result[f"event_step_{horizon_bars}"] = event_step
    result[f"barrier_return_{horizon_bars}"] = barrier
    result[f"event_long_{horizon_bars}"] = event_long
    result[f"event_short_{horizon_bars}"] = event_short
    return result


def _required_columns(horizon_bars: int) -> Sequence[str]:
    return (
        *BASE_FEATURES,
        f"event_long_{horizon_bars}",
        f"event_short_{horizon_bars}",
        f"barrier_return_{horizon_bars}",
    )


def build_prospective_pair_frame(
    development_raw: pd.DataFrame,
    holdout_raw: pd.DataFrame,
    *,
    pair: str,
    cutoff: pd.Timestamp,
    horizon_bars: int = 5,
    lookback_bars: int = 60,
) -> dict[str, pd.DataFrame]:
    """Prepare frozen development and strictly post-cutoff prospective rows."""
    if pair not in PAIRS:
        raise ValueError(f"unsupported pair: {pair}")
    cutoff = pd.Timestamp(cutoff)
    cutoff = cutoff.tz_localize("UTC") if cutoff.tzinfo is None else cutoff.tz_convert("UTC")
    development_raw = _prepare_raw(development_raw, pair)
    holdout_raw = _prepare_raw(holdout_raw, pair)
    development_raw = development_raw[development_raw["timestamp"] <= cutoff].copy()
    holdout_raw = holdout_raw[holdout_raw["timestamp"] > cutoff].copy()
    if development_raw.empty or holdout_raw.empty:
        raise ValueError("development and holdout must both contain eligible rows")

    development = _add_event_labels(_add_base_features(development_raw, pair), horizon_bars)
    development = development.dropna(subset=list(_required_columns(horizon_bars))).reset_index(drop=True)

    combined = pd.concat([development_raw, holdout_raw], ignore_index=True)
    combined = combined.sort_values("timestamp").drop_duplicates("timestamp").reset_index(drop=True)
    combined = _add_event_labels(_add_base_features(combined, pair), horizon_bars)
    contiguous = contiguous_context_mask(
        combined["timestamp"],
        lookback_bars=lookback_bars,
        horizon_bars=horizon_bars,
    )
    holdout = combined[(combined["timestamp"] > cutoff) & contiguous].copy()
    holdout = holdout.dropna(subset=list(_required_columns(horizon_bars))).reset_index(drop=True)
    return {"development": development, "holdout": holdout}


ACTIONABILITY_FLOOR = 0.55
DIRECTION_CONFIDENCE_FLOOR = 0.55


def select_fixed_trades(
    frame: pd.DataFrame,
    *,
    action_probability: np.ndarray,
    direction_long_probability: np.ndarray,
    horizon_bars: int = 5,
) -> pd.DataFrame:
    """Apply the predeclared v84 thresholds and same-pair non-overlap policy."""
    if len(frame) != len(action_probability) or len(frame) != len(direction_long_probability):
        raise ValueError("probability arrays must match frame length")
    result = frame.copy()
    if "pair" not in result.columns:
        result["pair"] = result["instrument"].astype(str)
    result["p_action"] = np.asarray(action_probability, dtype=float)
    result["p_direction_long"] = np.asarray(direction_long_probability, dtype=float)
    result["direction_confidence"] = np.maximum(
        result["p_direction_long"], 1.0 - result["p_direction_long"]
    )
    result["predicted_long"] = result["p_direction_long"] >= 0.5
    result = result[
        (result["p_action"] >= ACTIONABILITY_FLOOR)
        & (result["direction_confidence"] >= DIRECTION_CONFIDENCE_FLOOR)
    ].copy()
    result["net_return"] = np.where(
        result["predicted_long"],
        result[f"event_long_{horizon_bars}"],
        result[f"event_short_{horizon_bars}"],
    )

    kept: list[int] = []
    for _, group in result.sort_values("timestamp").groupby("pair", sort=False):
        next_allowed: pd.Timestamp | None = None
        for index, row in group.iterrows():
            timestamp = pd.Timestamp(row["timestamp"])
            if next_allowed is not None and timestamp < next_allowed:
                continue
            kept.append(index)
            wait_minutes = max(1, int(row[f"event_step_{horizon_bars}"]))
            next_allowed = timestamp + pd.Timedelta(minutes=wait_minutes)
    if not kept:
        return result.iloc[0:0].copy()
    return result.loc[kept].sort_values("timestamp").reset_index(drop=True)


def build_prospective_report(
    *,
    metrics: dict[str, object],
    positive_fold_fraction: float,
    holdout_rows: int,
    development_cutoff: str,
    holdout_manifest_sha256: str,
) -> dict[str, object]:
    """Build a falsification-only report; sampled holdout can never grant authority."""
    profit_factor = metrics.get("profit_factor")
    sharpe = metrics.get("sharpe")
    max_drawdown = metrics.get("max_drawdown")
    balanced_accuracy = metrics.get("balanced_accuracy")
    positive_instrument_fraction = metrics.get("positive_instrument_fraction")
    median_gap = metrics.get("median_gap_minutes")
    mean_confidence = metrics.get("mean_confidence")
    net_return = metrics.get("net_return")
    checks = {
        "trades_gte_100": int(metrics.get("n") or 0) >= 100,
        "profit_factor_gte_1_15": profit_factor is not None and float(profit_factor) >= 1.15,
        "sharpe_gte_1": sharpe is not None and float(sharpe) >= 1.0,
        "max_drawdown_lte_0_12": max_drawdown is not None and float(max_drawdown) <= 0.12,
        "balanced_accuracy_gte_0_52": balanced_accuracy is not None
        and float(balanced_accuracy) >= 0.52,
        "positive_fold_fraction_gte_0_60": positive_fold_fraction >= 0.60,
        "positive_instrument_fraction_gte_0_67": positive_instrument_fraction is not None
        and float(positive_instrument_fraction) >= 0.67,
        "median_gap_lte_10m": median_gap is not None and float(median_gap) <= 10.0,
        "mean_confidence_gte_0_60": mean_confidence is not None
        and float(mean_confidence) >= 0.60,
        "positive_net_return": net_return is not None and float(net_return) > 0.0,
    }
    passed = all(checks.values())
    return {
        "artifact": "broker-native-v84-base-h5-prospective-v1",
        "mode": "FALSIFICATION_ONLY_UNTOUCHED_POST_CUTOFF",
        "development_cutoff": development_cutoff,
        "holdout_manifest_sha256": holdout_manifest_sha256,
        "holdout_rows": int(holdout_rows),
        "metrics": metrics,
        "positive_fold_fraction": float(positive_fold_fraction),
        "checks": checks,
        "economic_screen_passed": passed,
        "promotion_eligible": False,
        "approved_for_paper": False,
        "approved_for_demo": False,
        "approved_for_live": False,
        "next_action": (
            "RESTORE_OR_FUND_DEEPER_METAAPI_HISTORY_BEFORE_ANY_PROMOTION"
            if passed
            else "REJECT_BASE_5M_BROKER_NATIVE_ARCHITECTURE"
        ),
    }


def chronological_time_fit_calibration_split(
    frame: pd.DataFrame,
    *,
    horizon_bars: int,
    calibration_fraction: float = 0.20,
    min_calibration_timestamps: int = 500,
) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Split pooled multi-pair data by whole timestamps with horizon purge."""
    if frame.empty:
        raise ValueError("development frame is empty")
    ordered = frame.sort_values(["timestamp", "pair"] if "pair" in frame.columns else ["timestamp"])
    times = pd.DatetimeIndex(pd.to_datetime(ordered["timestamp"], utc=True).drop_duplicates())
    if len(times) <= min_calibration_timestamps + horizon_bars + 1:
        raise ValueError("insufficient timestamps for purged fit/calibration split")
    split = int(len(times) * (1.0 - calibration_fraction))
    split = min(max(split, 1), len(times) - 1)
    if len(times) - split < min_calibration_timestamps:
        split = len(times) - min_calibration_timestamps
    calibration_start = pd.Timestamp(times[split])
    fit_boundary = calibration_start - pd.Timedelta(minutes=horizon_bars)
    fit = ordered[pd.to_datetime(ordered["timestamp"], utc=True) < fit_boundary].copy()
    calibration = ordered[pd.to_datetime(ordered["timestamp"], utc=True) >= calibration_start].copy()
    if fit.empty or calibration.empty:
        raise ValueError("purged split produced an empty partition")
    return fit, calibration


def calculate_performance(
    trades: pd.DataFrame,
    *,
    horizon_bars: int = 5,
    expected_pairs: Sequence[str] = PAIRS,
) -> dict[str, object]:
    """Compute v84-style trade metrics with six-pair breadth denominator."""
    if trades.empty:
        return {
            "n": 0,
            "profit_factor": None,
            "sharpe": None,
            "max_drawdown": None,
            "net_return": 0.0,
            "win_rate": None,
            "balanced_accuracy": None,
            "positive_instrument_fraction": 0.0,
            "median_gap_minutes": None,
            "mean_confidence": None,
            "by_instrument": {pair: 0.0 for pair in expected_pairs},
        }
    values = pd.to_numeric(trades["net_return"], errors="raise").to_numpy(dtype=float)
    gains = float(values[values > 0].sum())
    losses = float(-values[values < 0].sum())
    profit_factor = gains / losses if losses > 0 else None
    std = float(np.std(values, ddof=1)) if len(values) > 1 else 0.0
    sharpe = float(np.sqrt(len(values)) * np.mean(values) / std) if std > 0 else None
    equity = 1.0
    peak = 1.0
    max_drawdown = 0.0
    for value in values:
        equity *= 1.0 + value
        peak = max(peak, equity)
        max_drawdown = max(max_drawdown, (peak - equity) / peak if peak else 0.0)

    by_pair_series = trades.groupby("pair")["net_return"].sum().reindex(expected_pairs, fill_value=0.0)
    unique_times = pd.Series(pd.to_datetime(trades["timestamp"], utc=True).sort_values().unique())
    gaps = unique_times.diff().dt.total_seconds().dropna() / 60.0
    actual = trades[f"direction_long_{horizon_bars}"].astype(int).to_numpy()
    predicted = trades["predicted_long"].astype(int).to_numpy()
    balanced_accuracy = (
        float(balanced_accuracy_score(actual, predicted)) if len(np.unique(actual)) > 1 else None
    )
    return {
        "n": int(len(trades)),
        "profit_factor": float(profit_factor) if profit_factor is not None else None,
        "sharpe": sharpe,
        "max_drawdown": float(max_drawdown),
        "net_return": float(values.sum()),
        "win_rate": float((values > 0).mean()),
        "balanced_accuracy": balanced_accuracy,
        "positive_instrument_fraction": float((by_pair_series > 0).mean()),
        "median_gap_minutes": float(gaps.median()) if len(gaps) else None,
        "mean_confidence": float(pd.to_numeric(trades["p_action"], errors="raise").mean()),
        "by_instrument": {pair: float(by_pair_series.loc[pair]) for pair in expected_pairs},
    }


PAIR_FEATURES = tuple(f"pair_{pair}" for pair in PAIRS)
FIXED_MODEL_PARAMS = {
    "n_estimators": 160,
    "max_depth": 3,
    "learning_rate": 0.035,
    "min_child_weight": 20,
    "subsample": 0.8,
    "colsample_bytree": 0.8,
    "reg_lambda": 10.0,
    "reg_alpha": 0.1,
    "objective": "binary:logistic",
    "eval_metric": "logloss",
    "tree_method": "hist",
    "n_jobs": 2,
    "random_state": 20261004,
}


def _calibration_apply(raw_probability: np.ndarray, target: np.ndarray) -> Callable[[np.ndarray], np.ndarray]:
    from sklearn.isotonic import IsotonicRegression

    raw = np.asarray(raw_probability, dtype=float)
    labels = np.asarray(target, dtype=int)
    if len(raw) < 200 or len(np.unique(labels)) < 2 or len(np.unique(raw)) < 2:
        return lambda values: np.asarray(values, dtype=float)
    model = IsotonicRegression(y_min=0.001, y_max=0.999, out_of_bounds="clip")
    model.fit(raw, labels)
    return lambda values: model.predict(np.asarray(values, dtype=float))


def fit_fixed_base_predictions(
    development: pd.DataFrame,
    holdout: pd.DataFrame,
    *,
    horizon_bars: int = 5,
    min_calibration_timestamps: int = 500,
    classifier_factory: Callable[[], object] | None = None,
) -> dict[str, object]:
    """Fit the frozen v84 base architecture using development data only."""
    dev = development.copy()
    future = holdout.copy()
    if "pair" not in dev.columns:
        dev["pair"] = dev["instrument"].astype(str)
    if "pair" not in future.columns:
        future["pair"] = future["instrument"].astype(str)
    features = list(BASE_FEATURES + PAIR_FEATURES)
    missing = [column for column in features if column not in dev.columns or column not in future.columns]
    if missing:
        raise ValueError(f"missing fixed base features: {missing}")

    fit, calibration = chronological_time_fit_calibration_split(
        dev,
        horizon_bars=horizon_bars,
        calibration_fraction=0.20,
        min_calibration_timestamps=min_calibration_timestamps,
    )
    if classifier_factory is None:
        from xgboost import XGBClassifier

        def default_classifier_factory() -> object:
            return XGBClassifier(**FIXED_MODEL_PARAMS)

        classifier_factory = default_classifier_factory

    action_model = classifier_factory()
    action_model.fit(fit[features], fit[f"actionable_{horizon_bars}"])
    action_cal_raw = action_model.predict_proba(calibration[features])[:, 1]
    action_apply = _calibration_apply(
        action_cal_raw,
        calibration[f"actionable_{horizon_bars}"].to_numpy(dtype=int),
    )
    action_probability = np.clip(
        action_apply(action_model.predict_proba(future[features])[:, 1]),
        0.001,
        0.999,
    )

    direction_fit = fit[fit[f"actionable_{horizon_bars}"] == 1].copy()
    direction_calibration = calibration[calibration[f"actionable_{horizon_bars}"] == 1].copy()
    direction_target = f"direction_long_{horizon_bars}"
    if len(direction_fit) < 200 or len(np.unique(direction_fit[direction_target])) < 2:
        raise ValueError("insufficient development-only actionable direction evidence")
    direction_model = classifier_factory()
    direction_model.fit(direction_fit[features], direction_fit[direction_target])
    direction_cal_raw = direction_model.predict_proba(direction_calibration[features])[:, 1]
    direction_apply = _calibration_apply(
        direction_cal_raw,
        direction_calibration[direction_target].to_numpy(dtype=int),
    )
    direction_long_probability = np.clip(
        direction_apply(direction_model.predict_proba(future[features])[:, 1]),
        0.001,
        0.999,
    )

    return {
        "action_probability": action_probability,
        "direction_long_probability": direction_long_probability,
        "feature_columns": features,
        "fit_rows": int(len(fit)),
        "calibration_rows": int(len(calibration)),
        "direction_fit_rows": int(len(direction_fit)),
        "direction_calibration_rows": int(len(direction_calibration)),
        "fit_start": pd.Timestamp(fit["timestamp"].min()).isoformat(),
        "fit_end": pd.Timestamp(fit["timestamp"].max()).isoformat(),
        "calibration_start": pd.Timestamp(calibration["timestamp"].min()).isoformat(),
        "calibration_end": pd.Timestamp(calibration["timestamp"].max()).isoformat(),
    }


def _safe_balanced_accuracy(target: pd.Series, prediction: np.ndarray) -> float | None:
    labels = pd.to_numeric(target, errors="coerce").dropna().astype(int).to_numpy()
    predicted = np.asarray(prediction, dtype=int)
    if len(labels) != len(predicted) or len(labels) == 0 or len(np.unique(labels)) < 2:
        return None
    return float(balanced_accuracy_score(labels, predicted))


def _three_window_returns(trades: pd.DataFrame, holdout: pd.DataFrame) -> list[float]:
    times = pd.DatetimeIndex(pd.to_datetime(holdout["timestamp"], utc=True).drop_duplicates().sort_values())
    if len(times) == 0:
        return [0.0, 0.0, 0.0]
    windows = np.array_split(times, 3)
    trade_times = pd.to_datetime(trades["timestamp"], utc=True) if not trades.empty else pd.Series([], dtype="datetime64[ns, UTC]")
    returns: list[float] = []
    for window in windows:
        if len(window) == 0 or trades.empty:
            returns.append(0.0)
            continue
        start = pd.Timestamp(window[0])
        end = pd.Timestamp(window[-1])
        mask = (trade_times >= start) & (trade_times <= end)
        returns.append(float(pd.to_numeric(trades.loc[mask, "net_return"], errors="coerce").sum()))
    return returns


def evaluate_fixed_base_prospective(
    development: pd.DataFrame,
    holdout: pd.DataFrame,
    *,
    development_cutoff: str,
    holdout_manifest_sha256: str,
    horizon_bars: int = 5,
    min_calibration_timestamps: int = 500,
) -> dict[str, object]:
    """Evaluate the frozen v84 base H5 architecture on untouched sampled rows."""
    predictions = fit_fixed_base_predictions(
        development,
        holdout,
        horizon_bars=horizon_bars,
        min_calibration_timestamps=min_calibration_timestamps,
    )
    action_probability = np.asarray(predictions["action_probability"], dtype=float)
    direction_probability = np.asarray(predictions["direction_long_probability"], dtype=float)
    trades = select_fixed_trades(
        holdout,
        action_probability=action_probability,
        direction_long_probability=direction_probability,
        horizon_bars=horizon_bars,
    )
    metrics = calculate_performance(trades, horizon_bars=horizon_bars, expected_pairs=PAIRS)
    window_returns = _three_window_returns(trades, holdout)
    positive_window_fraction = float(sum(value > 0.0 for value in window_returns) / 3.0)
    report = build_prospective_report(
        metrics=metrics,
        positive_fold_fraction=positive_window_fraction,
        holdout_rows=len(holdout),
        development_cutoff=development_cutoff,
        holdout_manifest_sha256=holdout_manifest_sha256,
    )

    actionable_mask = holdout[f"actionable_{horizon_bars}"].astype(int) == 1
    action_ba = _safe_balanced_accuracy(
        holdout[f"actionable_{horizon_bars}"],
        action_probability >= 0.5,
    )
    direction_ba = _safe_balanced_accuracy(
        holdout.loc[actionable_mask, f"direction_long_{horizon_bars}"],
        direction_probability[actionable_mask.to_numpy()] >= 0.5,
    )
    dates = pd.to_datetime(holdout["timestamp"], utc=True).dt.normalize().nunique()
    report.update(
        {
            "architecture": "v84_base_two_stage_actionability_then_direction_h5_purged_refit",
            "threshold_policy": {
                "actionability_floor": ACTIONABILITY_FLOOR,
                "direction_confidence_floor": DIRECTION_CONFIDENCE_FLOOR,
                "threshold_search": "NONE_PREDECLARED_V84",
            },
            "model": FIXED_MODEL_PARAMS,
            "fit_protocol": {
                key: predictions[key]
                for key in (
                    "fit_rows",
                    "calibration_rows",
                    "direction_fit_rows",
                    "direction_calibration_rows",
                    "fit_start",
                    "fit_end",
                    "calibration_start",
                    "calibration_end",
                )
            },
            "holdout_classification": {
                "actionability_balanced_accuracy": action_ba,
                "direction_on_actionable_balanced_accuracy": direction_ba,
            },
            "holdout_stability": {
                "policy": "three_chronological_windows_no_refit_no_selection",
                "window_net_returns": window_returns,
                "positive_window_fraction": positive_window_fraction,
            },
            "participation": {
                "scorable_rows": int(len(holdout)),
                "selected_trades": int(len(trades)),
                "holdout_calendar_days_with_rows": int(dates),
                "trades_per_holdout_day": float(len(trades) / max(1, int(dates))),
            },
            "sampled_holdout_limitations": [
                "post-cutoff rows are locally sampled MetaApi midpoint candles, not full provider historical bars",
                "sample_count is not broker-native tickVolume and is excluded by the base feature contract",
                "success cannot authorize PAPER, DEMO, or LIVE; it only justifies deeper broker-native history",
            ],
        }
    )
    return report
