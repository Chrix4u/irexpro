"""Causal multi-timeframe corpus construction for iRexPro.

M1 broker candles are the canonical raw source. Higher timeframes are derived
from M1 on UTC boundaries, and every derived feature row carries an
`available_at` timestamp. A decision row can only join to a higher-timeframe
bar whose `available_at <= decision_time`.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from app.domain.models.feature_engineering import FEATURE_COLUMNS, compute_features
from app.domain.models.multitimeframe_features import (
    MULTITIMEFRAME_DIRECT_FEATURE_COLUMNS,
)
from app.domain.training.dataset_builder import REQUIRED_OHLCV_COLUMNS, load_ohlcv_csv

TIMEFRAME_MINUTES = {
    "M1": 1,
    "M5": 5,
    "M15": 15,
    "H1": 60,
    "H4": 240,
}
TIMEFRAME_RULES = {
    "M1": "1min",
    "M5": "5min",
    "M15": "15min",
    "H1": "1h",
    "H4": "4h",
}
CONTEXT_TIMEFRAMES = ("M5", "M15", "H1", "H4")
ALL_TIMEFRAMES = ("M1", *CONTEXT_TIMEFRAMES)


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def normalize_m1_frame(frame: pd.DataFrame) -> pd.DataFrame:
    """Normalize raw M1 OHLCV to canonical UTC minute-open timestamps."""
    missing = REQUIRED_OHLCV_COLUMNS - set(frame.columns)
    if missing:
        raise ValueError(f"M1 dataset missing columns: {sorted(missing)}")

    base_columns = ["timestamp", "open", "high", "low", "close", "volume"]
    optional_columns = [
        "tick_volume",
        "trade_volume",
        "spread_points",
        "price_digits",
        "broker_time",
    ]
    present_optional = [column for column in optional_columns if column in frame.columns]
    result = frame.loc[:, [*base_columns, *present_optional]].copy()
    result["timestamp"] = pd.to_datetime(result["timestamp"], utc=True, errors="coerce")
    if result["timestamp"].isna().any():
        raise ValueError("M1 dataset contains invalid timestamps")

    result = result.sort_values("timestamp").reset_index(drop=True)
    if result.empty:
        raise ValueError("M1 dataset is empty")
    if result["timestamp"].duplicated().any():
        raise ValueError("M1 dataset contains duplicate timestamps")
    if not (result["timestamp"] == result["timestamp"].dt.floor("min")).all():
        raise ValueError("M1 timestamps must be aligned to exact UTC minute boundaries")

    numeric_columns = ["open", "high", "low", "close", "volume"]
    optional_numeric = [
        column
        for column in ["tick_volume", "trade_volume", "spread_points", "price_digits"]
        if column in result.columns
    ]
    for column in [*numeric_columns, *optional_numeric]:
        result[column] = pd.to_numeric(result[column], errors="coerce")

    if result[numeric_columns].isna().any().any():
        raise ValueError("M1 dataset contains non-numeric OHLCV values")
    if not np.isfinite(result[numeric_columns].to_numpy(dtype=float)).all():
        raise ValueError("M1 dataset contains non-finite OHLCV values")
    if (result[["open", "high", "low", "close"]] <= 0).any().any():
        raise ValueError("M1 OHLC prices must be greater than zero")
    if (result["volume"] < 0).any():
        raise ValueError("M1 volume cannot be negative")
    for column in ["tick_volume", "trade_volume", "spread_points"]:
        if column in result.columns and (result[column].dropna() < 0).any():
            raise ValueError(f"M1 {column} cannot be negative")
    if "price_digits" in result.columns:
        digits = result["price_digits"].dropna()
        if ((digits % 1) != 0).any() or (digits < 0).any() or (digits > 12).any():
            raise ValueError("M1 price_digits must be an integer between 0 and 12")
    if (result["high"] < result[["open", "close", "low"]].max(axis=1)).any():
        raise ValueError("M1 dataset contains invalid candle highs")
    if (result["low"] > result[["open", "close", "high"]].min(axis=1)).any():
        raise ValueError("M1 dataset contains invalid candle lows")

    if {"spread_points", "price_digits"}.issubset(result.columns):
        point_size = np.power(10.0, -result["price_digits"].astype(float))
        result["spread_price"] = result["spread_points"].astype(float) * point_size
        result["spread_bps"] = (
            result["spread_price"] / result["close"].astype(float)
        ) * 10_000.0

    return result


def derive_closed_bars(m1_frame: pd.DataFrame, timeframe: str) -> pd.DataFrame:
    """Derive complete UTC-aligned bars from canonical M1 candles."""
    normalized = normalize_m1_frame(m1_frame)
    normalized_timeframe = timeframe.upper()
    if normalized_timeframe not in TIMEFRAME_MINUTES:
        raise ValueError(f"Unsupported timeframe: {timeframe}")

    duration_minutes = TIMEFRAME_MINUTES[normalized_timeframe]
    if normalized_timeframe == "M1":
        result = normalized.copy()
        result["m1_count"] = 1
    else:
        rule = TIMEFRAME_RULES[normalized_timeframe]
        indexed = normalized.set_index("timestamp")
        grouped = indexed.resample(
            rule,
            label="left",
            closed="left",
            origin="epoch",
        )
        aggregations: dict[str, str] = {
            "open": "first",
            "high": "max",
            "low": "min",
            "close": "last",
            "volume": "sum",
        }
        for column in ["tick_volume", "trade_volume"]:
            if column in normalized.columns:
                aggregations[column] = "sum"
        for column in ["spread_points", "spread_price", "spread_bps", "price_digits"]:
            if column in normalized.columns:
                aggregations[column] = "last"

        result = grouped.agg(aggregations)
        if "spread_points" in normalized.columns:
            result["spread_points_mean"] = grouped["spread_points"].mean()
            result["spread_points_max"] = grouped["spread_points"].max()
        result["m1_count"] = grouped["close"].count()
        result = result[result["m1_count"] == duration_minutes]
        result = result.dropna(subset=["open", "high", "low", "close", "volume"])
        result = result.reset_index()

    result["bar_open_time"] = result["timestamp"]
    result["available_at"] = result["bar_open_time"] + pd.Timedelta(minutes=duration_minutes)
    return result.reset_index(drop=True)


def _timeframe_feature_frame(m1_frame: pd.DataFrame, timeframe: str) -> pd.DataFrame:
    bars = derive_closed_bars(m1_frame, timeframe)
    featured = compute_features(bars)
    prefix = timeframe.lower()

    result = pd.DataFrame(
        {
            f"{prefix}_source_bar_open": bars["bar_open_time"],
            f"{prefix}_available_at": bars["available_at"],
            f"{prefix}_open": bars["open"].astype(float),
            f"{prefix}_high": bars["high"].astype(float),
            f"{prefix}_low": bars["low"].astype(float),
            f"{prefix}_close": bars["close"].astype(float),
            f"{prefix}_volume": bars["volume"].astype(float),
        }
    )
    for field in [
        "tick_volume",
        "trade_volume",
        "spread_points",
        "spread_price",
        "spread_bps",
        "spread_points_mean",
        "spread_points_max",
        "price_digits",
    ]:
        if field in bars.columns:
            result[f"{prefix}_{field}"] = pd.to_numeric(
                bars[field], errors="coerce"
            ).astype(float)
    for feature_name in (*FEATURE_COLUMNS, *MULTITIMEFRAME_DIRECT_FEATURE_COLUMNS):
        result[f"{prefix}_{feature_name}"] = featured[feature_name].astype(float)
    return result


def validate_no_lookahead(corpus: pd.DataFrame) -> None:
    """Fail closed when any feature source becomes available after decision_time."""
    if "decision_time" not in corpus.columns:
        raise ValueError("Corpus is missing decision_time")
    if corpus.empty:
        raise ValueError("Corpus is empty")
    if corpus["decision_time"].isna().any():
        raise ValueError("Corpus contains null decision_time values")
    if not corpus["decision_time"].is_monotonic_increasing:
        raise ValueError("Corpus decision_time must be chronological")

    for timeframe in ALL_TIMEFRAMES:
        prefix = timeframe.lower()
        available_column = f"{prefix}_available_at"
        source_column = f"{prefix}_source_bar_open"
        if available_column not in corpus.columns or source_column not in corpus.columns:
            raise ValueError(f"Corpus is missing {timeframe} provenance columns")
        if corpus[[available_column, source_column]].isna().any().any():
            raise ValueError(f"Corpus contains unaligned {timeframe} provenance")

        duration = pd.Timedelta(minutes=TIMEFRAME_MINUTES[timeframe])
        expected_available = corpus[source_column] + duration
        if not (expected_available == corpus[available_column]).all():
            raise ValueError(f"{timeframe} available_at does not match canonical bar close")
        if (corpus[available_column] > corpus["decision_time"]).any():
            raise ValueError(f"Lookahead detected: {timeframe} feature available after decision")
        if (corpus[source_column] >= corpus["decision_time"]).any():
            raise ValueError(f"Lookahead detected: {timeframe} source bar is not fully historical")


def build_multitimeframe_feature_corpus(
    m1_frame: pd.DataFrame,
    *,
    drop_unaligned: bool = True,
) -> pd.DataFrame:
    """Build M1 decision rows with causal M5/M15/H1/H4 context."""
    normalized = normalize_m1_frame(m1_frame)
    corpus = _timeframe_feature_frame(normalized, "M1")
    corpus["decision_time"] = corpus["m1_available_at"]
    corpus = corpus.sort_values("decision_time").reset_index(drop=True)

    for timeframe in CONTEXT_TIMEFRAMES:
        prefix = timeframe.lower()
        available_column = f"{prefix}_available_at"
        higher = _timeframe_feature_frame(normalized, timeframe).sort_values(available_column)
        corpus = pd.merge_asof(
            corpus.sort_values("decision_time"),
            higher,
            left_on="decision_time",
            right_on=available_column,
            direction="backward",
            allow_exact_matches=True,
        )

    corpus = corpus.sort_values("decision_time").reset_index(drop=True)
    if drop_unaligned:
        provenance_columns = [
            f"{timeframe.lower()}_available_at"
            for timeframe in ALL_TIMEFRAMES
        ]
        corpus = corpus.dropna(subset=provenance_columns).reset_index(drop=True)

    validate_no_lookahead(corpus)
    return corpus


def build_multitimeframe_corpus_from_m1_csv(
    *,
    m1_path: str | Path,
    output_path: str | Path,
    instrument: str,
    source: str = "irexpro_metaapi_broker_m1",
) -> dict[str, Any]:
    """Build, validate, persist, and fingerprint a causal multi-timeframe corpus."""
    source_path = Path(m1_path)
    source_frame = load_ohlcv_csv(source_path)
    corpus = build_multitimeframe_feature_corpus(source_frame)

    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)
    # Atomic replacement: an interrupted build must never leave a corpus a
    # future stage could mistake for complete.
    corpus_tmp = output.with_suffix(output.suffix + ".tmp")
    corpus.to_csv(corpus_tmp, index=False)
    corpus_tmp.replace(output)

    friction_columns = [
        "m1_spread_points",
        "m1_spread_bps",
        "m1_tick_volume",
        "m1_price_digits",
    ]
    friction_coverage = {
        column: (
            float(corpus[column].notna().mean())
            if column in corpus.columns and len(corpus)
            else 0.0
        )
        for column in friction_columns
    }

    manifest = {
        "manifest_version": 1,
        "instrument": instrument.upper(),
        "source": source,
        "source_timeframe": "M1",
        "derived_timeframes": list(CONTEXT_TIMEFRAMES),
        "row_count": len(corpus),
        "start_decision_time": corpus["decision_time"].iloc[0].isoformat(),
        "end_decision_time": corpus["decision_time"].iloc[-1].isoformat(),
        "built_at": datetime.now(UTC).isoformat(),
        "alignment_method": "backward_asof_on_available_at",
        "timestamp_semantics": "bar_open_utc",
        "decision_time_semantics": "m1_bar_close_utc",
        "closed_bars_only": True,
        "canonical_utc_boundaries": True,
        "lookahead_validation": "passed",
        "friction_data_complete": all(value == 1.0 for value in friction_coverage.values()),
        "friction_coverage": friction_coverage,
        "raw_m1_sha256": _sha256_file(source_path),
        "dataset_sha256": _sha256_file(output),
    }
    manifest_path = output.with_suffix(".manifest.json")
    manifest_tmp = manifest_path.with_suffix(manifest_path.suffix + ".tmp")
    manifest_tmp.write_text(
        json.dumps(manifest, indent=2, sort_keys=True), encoding="utf-8"
    )
    manifest_tmp.replace(manifest_path)
    return {
        **manifest,
        "dataset_path": str(output),
        "manifest_path": str(manifest_path),
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Build causal M1/M5/M15/H1/H4 training corpus from raw M1 broker history"
    )
    parser.add_argument("--m1-dataset", required=True)
    parser.add_argument("--instrument", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument(
        "--source",
        default="irexpro_metaapi_broker_m1",
        help="Human-readable upstream source recorded in the manifest",
    )
    args = parser.parse_args()

    result = build_multitimeframe_corpus_from_m1_csv(
        m1_path=args.m1_dataset,
        output_path=args.output,
        instrument=args.instrument,
        source=args.source,
    )
    print(json.dumps(result, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
