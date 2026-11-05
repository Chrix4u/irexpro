"""Research-only XGBoost study of historically OOD broker-DEMO M1 decisions.

The collector SQL is strictly read-only. Inputs are features persisted *at*
decision time; labels use independent 15-minute-ahead bid/ask quotes.
The target deducts a conservative EXTRA 1 pip for slippage/commission proxy,
but this is NOT independently verified realised broker P&L.

No model is imported into the running strategy, published, serialized to an
execution directory, or authorized for PAPER/DEMO/LIVE by this module.
Training fails closed without a multi-day, label-complete out-of-time cohort.
"""

from __future__ import annotations

import argparse
import json
from collections import Counter
from datetime import timedelta
from pathlib import Path

import numpy as np
import pandas as pd

SHADOW_VERSION = "ood-price-15m-research-shadow-v1"
APPROVED_PAIRS = ("AUDUSD", "EURUSD", "GBPUSD")
APPROVED_ROUTES = ("M1_TREND_CONTINUATION", "M1_EARLY_TRANSITION")
NUMERIC_FEATURES = (
    "confidence",
    "score",
    "direction_quality",
    "atr",
    "breakout_atr",
    "aligned_ema_separation_atr",
    "aligned_ema_slope_atr",
    "higher_timeframe_agreement",
    "momentum_1_atr",
    "momentum_3_atr",
    "momentum_5_atr",
    "m5_momentum_1_atr",
    "m5_momentum_3_atr",
    "m30_efficiency",
    "m30_momentum_atr",
    "m5_directional_run",
    "m5_body_pressure",
    "m5_body_expansion",
    "stop_distance",
)
CATEGORICAL_FEATURES = ("instrument", "route", "direction")
REQUIRED = (
    *CATEGORICAL_FEATURES,
    "decision_time_utc",
    "signal_bar_time_utc",
    "entry_observed_at_utc",
    "future_observed_at_utc",
    "diagnostics_json",
    "entry_bid",
    "entry_ask",
    "future_bid_15m",
    "future_ask_15m",
    *NUMERIC_FEATURES,
)
HORIZON_MINUTES = 15
EXTRA_FRICTION_PIPS = 1.0
MIN_TRADING_DAYS = 12
MIN_ROWS_PER_QUALIFIED_DAY = 120
MIN_ROWS_PER_PAIR = 600
MIN_SPLIT_ROWS = 150
MIN_UNIQUE_LABELS = 2
# Extra protection against adjacent labels overlapping 15-minute horizons.
PURGE_MINUTES = 60
KNOWN_DIAGNOSTICS = (
    "confidence:HARD_LOW",
    "confidence:HARD_HIGH",
    "extensionAtr:HARD_LOW",
    "extensionAtr:HARD_HIGH",
    "emaSeparation:HARD_LOW",
    "emaSeparation:HARD_HIGH",
    "mtfStrength:HARD_LOW",
    "mtfStrength:HARD_HIGH",
    "rsi14:HARD_LOW",
    "rsi14:HARD_HIGH",
    "volatilityScore:HARD_LOW",
    "volatilityScore:HARD_HIGH",
    "directionalMomentumAtr:HARD_LOW",
    "directionalMomentumAtr:HARD_HIGH",
)


def prepare_cohort(raw: pd.DataFrame) -> tuple[pd.DataFrame, dict]:
    """Keep only causally valid, independently quoted OOD decisions."""
    missing = sorted(set(REQUIRED) - set(raw.columns))
    if missing:
        raise ValueError(f"Missing required columns: {', '.join(missing)}")
    if raw.empty:
        raise ValueError("No OOD decisions to inspect")
    records = raw.copy()
    total = len(records)
    for name in (
        "decision_time_utc",
        "signal_bar_time_utc",
        "entry_observed_at_utc",
        "future_observed_at_utc",
    ):
        records[name] = pd.to_datetime(records[name], utc=True, errors="coerce")
    for name in (*NUMERIC_FEATURES, "entry_bid", "entry_ask", "future_bid_15m", "future_ask_15m"):
        records[name] = pd.to_numeric(records[name], errors="coerce")
    records = records.replace([np.inf, -np.inf], np.nan)
    valid = (
        records["instrument"].isin(APPROVED_PAIRS)
        & records["route"].isin(APPROVED_ROUTES)
        & records["direction"].isin(("BUY", "SELL"))
        & records[list(NUMERIC_FEATURES)].notna().all(axis=1)
        & records[
            [
                "decision_time_utc",
                "signal_bar_time_utc",
                "entry_observed_at_utc",
                "future_observed_at_utc",
            ]
        ]
        .notna()
        .all(axis=1)
        & records[["entry_bid", "entry_ask", "future_bid_15m", "future_ask_15m"]]
        .notna()
        .all(axis=1)
        & (records["entry_bid"] > 0)
        & (records["entry_ask"] >= records["entry_bid"])
        & (records["future_bid_15m"] > 0)
        & (records["future_ask_15m"] >= records["future_bid_15m"])
        & (records["signal_bar_time_utc"] <= records["decision_time_utc"])
        & (records["entry_observed_at_utc"] <= records["decision_time_utc"])
        & (records["entry_observed_at_utc"] >= records["decision_time_utc"] - timedelta(minutes=4))
        & (
            records["future_observed_at_utc"]
            >= records["decision_time_utc"] + timedelta(minutes=HORIZON_MINUTES)
        )
        & (
            records["future_observed_at_utc"]
            <= records["decision_time_utc"] + timedelta(minutes=HORIZON_MINUTES + 4)
        )
        & (records["stop_distance"] > 0)
    )
    records = records.loc[valid].copy()
    if records.empty:
        raise ValueError("All OOD observations failed causal quote/feature validity")
    pip = 0.0001  # All approved USD-quoted majors use four-decimal pip units.
    records["spread_observed_pips"] = (records["entry_ask"] - records["entry_bid"]) / pip
    raw_return = np.where(
        records["direction"] == "BUY",
        records["future_bid_15m"] - records["entry_ask"],
        records["entry_bid"] - records["future_ask_15m"],
    )
    records["spread_inclusive_pips"] = raw_return / pip
    records["proxy_pips"] = records["spread_inclusive_pips"] - EXTRA_FRICTION_PIPS
    records["label"] = (records["proxy_pips"] > 0).astype(int)
    records["utc_day"] = records["decision_time_utc"].dt.date
    records["utc_hour"] = records["decision_time_utc"].dt.hour
    records["utc_weekday"] = records["decision_time_utc"].dt.dayofweek
    reasons = []
    for raw_codes in records["diagnostics_json"]:
        try:
            codes = json.loads(raw_codes) if isinstance(raw_codes, str) else raw_codes
            if not isinstance(codes, list):
                codes = []
        except (TypeError, ValueError):
            codes = []
        reasons.append(frozenset(x for x in codes if isinstance(x, str)))
    records["diagnostic_set"] = reasons
    records = records.sort_values(["decision_time_utc", "instrument", "route"]).drop_duplicates(
        subset=["decision_time_utc", "instrument", "route", "direction"],
        keep="first",
    )
    quality = {
        "raw_records": int(total),
        "causally_verified_records": int(len(records)),
        "rejected_records": int(total - len(records)),
        "distinct_utc_days": int(records["utc_day"].nunique()),
        "pair_counts": {
            k: int(v) for k, v in records["instrument"].value_counts().to_dict().items()
        },
        "route_counts": {k: int(v) for k, v in records["route"].value_counts().to_dict().items()},
        "earliest_utc": records["decision_time_utc"].min().isoformat(),
        "latest_utc": records["decision_time_utc"].max().isoformat(),
        "positive_proxy_fraction": round(float(records["label"].mean()), 5),
        "mean_proxy_pips": round(float(records["proxy_pips"].mean()), 5),
        "mean_entry_spread_pips": round(float(records["spread_observed_pips"].mean()), 5),
    }
    return records, quality


def input_features(frame: pd.DataFrame) -> pd.DataFrame:
    """All columns were known at decision time; labels and future quotes excluded."""
    features = frame[list(NUMERIC_FEATURES)].copy()
    features["utc_hour"] = frame["utc_hour"].astype(float)
    features["utc_weekday"] = frame["utc_weekday"].astype(float)
    for col in CATEGORICAL_FEATURES:
        for category in (
            APPROVED_PAIRS
            if col == "instrument"
            else APPROVED_ROUTES
            if col == "route"
            else ("BUY", "SELL")
        ):
            features[f"{col}_{category}"] = (frame[col] == category).astype(float)
    for code in KNOWN_DIAGNOSTICS:
        features[f"ood_{code}"] = frame["diagnostic_set"].map(lambda values: float(code in values))
    assert not any(
        token in column
        for column in features.columns
        for token in ("future", "label", "proxy_pips", "exit_")
    )
    return features.astype(float)


def chronological_split(
    frame: pd.DataFrame,
    *,
    minimum_days: int = MIN_TRADING_DAYS,
) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    """Global time split by entire UTC days with 60m purges at boundaries."""
    days = sorted(frame["utc_day"].unique())
    if len(days) < minimum_days:
        raise ValueError(f"Only {len(days)} independent UTC trading days; need {minimum_days}")
    train_end = days[int(len(days) * 0.6)]
    valid_end = days[int(len(days) * 0.8)]
    train = frame.loc[frame["utc_day"] < train_end].copy()
    valid = frame.loc[(frame["utc_day"] >= train_end) & (frame["utc_day"] < valid_end)].copy()
    test = frame.loc[frame["utc_day"] >= valid_end].copy()
    if train.empty or valid.empty or test.empty:
        raise ValueError("Chronological split has an empty period")
    valid = valid.loc[
        valid["decision_time_utc"]
        > train["decision_time_utc"].max() + timedelta(minutes=PURGE_MINUTES)
    ]
    test = test.loc[
        test["decision_time_utc"]
        > valid["decision_time_utc"].max() + timedelta(minutes=PURGE_MINUTES)
    ]
    if any(len(split) < MIN_SPLIT_ROWS for split in (train, valid, test)):
        raise ValueError("At least one purged split has insufficient evidence")
    if any(split["label"].nunique() < MIN_UNIQUE_LABELS for split in (train, valid, test)):
        raise ValueError("At least one split contains only one proxy label")
    if (
        train["decision_time_utc"].max() + timedelta(minutes=PURGE_MINUTES)
        >= valid["decision_time_utc"].min()
    ):
        raise ValueError("Training and validation timestamps overlap")
    if (
        valid["decision_time_utc"].max() + timedelta(minutes=PURGE_MINUTES)
        >= test["decision_time_utc"].min()
    ):
        raise ValueError("Validation and test timestamps overlap")
    return train, valid, test


def proxy_metrics(frame: pd.DataFrame) -> dict:
    positive = frame.loc[frame["proxy_pips"] > 0, "proxy_pips"].sum()
    negative = -frame.loc[frame["proxy_pips"] < 0, "proxy_pips"].sum()
    return {
        "observations": int(len(frame)),
        "mean_proxy_pips": round(float(frame["proxy_pips"].mean()), 4) if len(frame) else None,
        "positive_proxy_fraction": round(float((frame["proxy_pips"] > 0).mean()), 4)
        if len(frame)
        else None,
        "proxy_profit_factor": round(float(positive / negative), 4) if negative > 0 else None,
    }


def run_study(frame: pd.DataFrame) -> dict:
    """Shadow-only fit; no model artifact, status change or deployment action."""
    from sklearn.metrics import balanced_accuracy_score, brier_score_loss, roc_auc_score
    from xgboost import XGBClassifier

    for pair in APPROVED_PAIRS:
        if int((frame["instrument"] == pair).sum()) < MIN_ROWS_PER_PAIR:
            raise ValueError(f"Insufficient independent OOD labels for {pair}")
    train, valid, test = chronological_split(frame)
    for partition_name, partition in (("train", train), ("validation", valid), ("test", test)):
        for pair in APPROVED_PAIRS:
            if int((partition["instrument"] == pair).sum()) < 75:
                raise ValueError(f"Insufficient {partition_name} OOD outcomes for {pair}")
    clf = XGBClassifier(
        n_estimators=120,
        max_depth=3,
        learning_rate=0.05,
        subsample=0.8,
        colsample_bytree=0.85,
        objective="binary:logistic",
        random_state=1729,
        n_jobs=2,
        tree_method="hist",
    )
    clf.fit(input_features(train), train["label"].to_numpy())

    # Validation is used ONLY to report stability; frozen 0.65 selectivity,
    # never optimized on test data.
    def score(partition: pd.DataFrame) -> dict:
        prob = clf.predict_proba(input_features(partition))[:, 1]
        selected = partition.loc[prob >= 0.65]
        return {
            "count": int(len(partition)),
            "balanced_accuracy": round(
                float(balanced_accuracy_score(partition["label"], prob >= 0.5)), 4
            ),
            "auc": round(float(roc_auc_score(partition["label"], prob)), 4),
            "brier": round(float(brier_score_loss(partition["label"], prob)), 4),
            "selected_at_fixed_0_65": proxy_metrics(selected),
            "unselected_reference": proxy_metrics(partition),
        }

    return {
        "fit_completed": True,
        "train": score(train),
        "validation": score(valid),
        "untouched_test": score(test),
        "training_utc_end": train["decision_time_utc"].max().isoformat(),
        "validation_utc_end": valid["decision_time_utc"].max().isoformat(),
        "test_utc_end": test["decision_time_utc"].max().isoformat(),
        "serialized_model": False,
        "promotion_allowed": False,
    }


def study_from_csv(source: Path) -> dict:
    records, quality = prepare_cohort(pd.read_csv(source))
    reasons = Counter(
        (route, code)
        for route, values in zip(records["route"], records["diagnostic_set"])
        for code in values
    )
    report = {
        "version": SHADOW_VERSION,
        "authority": "RESEARCH_ONLY_NO_EXECUTION",
        "auto_promotion": False,
        "promotion_allowed": False,
        "label": "15m post-decision provider-bidask price proxy minus 1 extra pip",
        "label_is_verified_broker_net_pnl": False,
        "data_quality": quality,
        "dominant_ood_dimensions": [
            {"route": route, "dimension": code, "decisions": count}
            for (route, code), count in reasons.most_common(18)
        ],
        "readiness": "NOT_ASSESSED",
    }
    # Count only separately observed market dates with broad enough
    # participation in ALL THREE allowed pairs; a few Sunday ticks must
    # not pretend to be a full additional independent market regime.
    day_groups = records.groupby("utc_day", sort=True)
    qualified_days = [
        day
        for day, group in day_groups
        if len(group) >= MIN_ROWS_PER_QUALIFIED_DAY
        and group["instrument"].nunique() == len(APPROVED_PAIRS)
    ]
    qualified_records = records.loc[records["utc_day"].isin(qualified_days)]
    quality["qualified_multi_pair_utc_days"] = len(qualified_days)
    blockers = []
    if len(qualified_days) < MIN_TRADING_DAYS:
        blockers.append(
            f"Only {len(qualified_days)} multi-pair quoted UTC days; require {MIN_TRADING_DAYS}"
        )
    for pair in APPROVED_PAIRS:
        if int((qualified_records["instrument"] == pair).sum()) < MIN_ROWS_PER_PAIR:
            blockers.append(f"Insufficient qualified-day quoted examples for {pair}")
    if blockers:
        report.update(
            {
                "readiness": "BLOCKED_NOT_ENOUGH_VERIFIED_HISTORY",
                "readiness_blockers": blockers,
                "model_fitted": False,
                "promotion_allowed": False,
            }
        )
        return report
    try:
        report["shadow_training"] = run_study(qualified_records)
        report["readiness"] = "EXPLORATORY_SHADOW_FIT_ONLY"
        report["model_fitted"] = True
    except ValueError as exc:
        report["readiness"] = "BLOCKED_VALIDATION_EVIDENCE"
        report["readiness_blockers"] = [str(exc)]
        report["model_fitted"] = False
        report["promotion_allowed"] = False
    return report


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Strict OOD research shadow; never deploys a model"
    )
    parser.add_argument("--cohort-csv", type=Path, required=True)
    parser.add_argument("--report-json", type=Path, required=True)
    args = parser.parse_args()
    # Caller must not write into a model-serving/runtime artifact directory.
    if any(part in {"models", "artifacts", "production"} for part in args.report_json.parts):
        raise ValueError("Refusing to write study output into a model-serving location")
    report = study_from_csv(args.cohort_csv)
    args.report_json.parent.mkdir(parents=True, exist_ok=True)
    args.report_json.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    print(
        json.dumps(
            {
                "readiness": report["readiness"],
                "raw": report["data_quality"]["raw_records"],
                "verified": report["data_quality"]["causally_verified_records"],
                "trading_days": report["data_quality"]["distinct_utc_days"],
                "model_fitted": report["model_fitted"],
                "promotion_allowed": report.get("promotion_allowed", False),
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
