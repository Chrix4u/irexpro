"""Independent short-horizon BUY/SELL net-alpha shadow challenger.

Executed strictly offline on broker-native historical quotes.
As-of features end at a COMPLETED M1 bar; simulated entry takes place at
the next completed M1 mark, not the feature bar's close. Consecutive M1
bar timestamps are required for each future label.
Every chronological UTC validation day is unknown at fit time.
Model outputs never route into live orders, volume caps or risk gates.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from datetime import datetime, timezone

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression, Ridge
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

from app.domain.training.demo_pepperstone_two_pair_horizon_audit import (
    FEATURES, PIP, enrich, summarize,
)
from app.domain.training.demo_first_touch_horizon_research import first_touch

ARTIFACT = "irexpro-independent-net-alpha-walkforward-v1"
HORIZONS = (1, 3, 5, 10, 30, 60)
RESERVE_PIPS = 1.1  # USD account: approx $9 roundtrip lot + 0.2 pip slippage
MIN_SIGNALS_PER_DAY = 4  # reporting only, not a permission or model threshold
MIN_TRAIN_ROWS = 600
FROZEN_MOVE_PROBABILITY = 0.60
FROZEN_NET_EDGE_BUFFER_PIPS = 0.5
TP_SL_PIPS = {1: (2., 4.), 3: (2., 4.), 5: (3., 5.),
              10: (4., 6.), 30: (6., 8.), 60: (8., 10.)}


def generate_causal_targets(frame: pd.DataFrame, horizon: int) -> pd.DataFrame:
    """Feature bar i -> next fully observed M1 mark i+1 -> exit at i+1+h."""
    if horizon not in HORIZONS:
        raise ValueError("Unsupported frozen horizon")
    df = frame.copy()
    entry = df.shift(-1)
    exit_mark = df.shift(-(horizon + 1))
    valid = (
        (entry.stamp - df.stamp == pd.Timedelta(minutes=1))
        & (exit_mark.stamp - df.stamp == pd.Timedelta(minutes=horizon + 1))
    )
    # If data contains a missing minute *inside* the interval, the i->i+h
    # stamp distance and dataframe shift will disagree; no interpolated fill.
    df["entry_next_at"] = entry.stamp
    df["future_at"] = exit_mark.stamp
    df["future_midmove_pips"] = (
        (exit_mark.mid - entry.mid) / PIP
    ).where(valid)
    df["buy_after_cost_pips"] = (
        (exit_mark.bid - entry.ask) / PIP - RESERVE_PIPS
    ).where(valid)
    df["sell_after_cost_pips"] = (
        (entry.bid - exit_mark.ask) / PIP - RESERVE_PIPS
    ).where(valid)
    return df


def choose_forecast_side(predicted_pips: float, probability_up: float,
                         estimated_spread_pips: float) -> int:
    if not all(np.isfinite(x) for x in (
        predicted_pips, probability_up, estimated_spread_pips,
    )):
        return 0
    if not 0 <= probability_up <= 1 or estimated_spread_pips < 0:
        return 0
    cost_floor = estimated_spread_pips + RESERVE_PIPS + FROZEN_NET_EDGE_BUFFER_PIPS
    if predicted_pips > cost_floor and probability_up >= FROZEN_MOVE_PROBABILITY:
        return 1
    if predicted_pips < -cost_floor and probability_up <= 1 - FROZEN_MOVE_PROBABILITY:
        return -1
    return 0


def results_for_signals(holdout: pd.DataFrame, sides: np.ndarray,
                        horizon: int, *, history: pd.DataFrame,
                        evaluate_touch: bool = True) -> dict:
    """One actual simulated entry per instrument/horizon; pessimistic stop-first."""
    chosen, touched = [], []
    by_date: dict[str, list[float]] = {}
    tp, sl = TP_SL_PIPS[horizon]
    next_eligible = pd.Timestamp("2000-01-01", tz="UTC")
    for index, side in zip(holdout.index, sides):
        row = holdout.loc[index]
        if side == 0 or row.stamp < next_eligible:
            continue
        if not (np.isfinite(row.buy_after_cost_pips)
                and np.isfinite(row.sell_after_cost_pips)):
            continue
        price_return = float(
            row.buy_after_cost_pips if side == 1 else row.sell_after_cost_pips
        )
        # Entry mark at i+1; require real future bars to score first touch.
        tp, sl = TP_SL_PIPS[horizon]
        if evaluate_touch:
            proxy = first_touch(history, int(index) + 1, int(side), tp, sl, horizon)
            if proxy is None:
                continue
            touched.append(float(proxy))
            by_date.setdefault(str(row.stamp.date()), []).append(float(proxy))
        chosen.append(price_return)
        next_eligible = row.stamp + pd.Timedelta(minutes=horizon + 2)
    return {
        "fixedHold": summarize(chosen),
        "firstTouchStopFirst": summarize(touched),
        "byDayFirstTouch": {
            day: summarize(v) for day, v in sorted(by_date.items())
        },
        "firstTouchProxyTpSlPips": {"takeProfit": tp, "stopLoss": sl},
    }


def validate_fold(frame: pd.DataFrame, day: pd.Timestamp,
                  horizon: int) -> dict:
    source = generate_causal_targets(frame, horizon)
    day_start = day.tz_localize("UTC") if day.tzinfo is None else day
    day_end = day_start + pd.Timedelta(days=1)
    # Explicit embargo greater than max target horizon at *training* boundary.
    embargo = pd.Timedelta(minutes=horizon + 2)
    features_ready = source.dropna(subset=list(FEATURES))
    fit = features_ready.loc[
        (features_ready.stamp < day_start - embargo)
        & features_ready.future_at.lt(day_start)
    ].dropna(subset=["future_midmove_pips"])
    test = features_ready.loc[
        (features_ready.stamp >= day_start)
        & (features_ready.stamp < day_end)
    ].dropna(subset=["buy_after_cost_pips", "sell_after_cost_pips"])

    outcome = {
        "holdoutUTC": str(day_start.date()),
        "holdoutDayCompletedUTC": day_end <= pd.Timestamp.now(tz="UTC"),
        "holdoutSource": "pepperstone-ctrader",
        "horizonMinutes": horizon,
        "trainingRows": len(fit), "testRows": len(test),
        "trainingDates": int(fit.stamp.dt.date.nunique()),
        "trainEndsAt": fit.stamp.max().isoformat() if len(fit) else None,
        "forecastAsOfContract": "COMPLETED_M1_BAR__ENTRY_ON_NEXT_COMPLETED_M1_MARK",
        "executionAuthority": "NONE",
    }
    # Broker-native provenance must be auditable, not inferred by timestamp.
    # Archived cTrader quotes may only pretrain this Pepperstone DEMO study.
    if len(test) and not test.source_broker.eq("pepperstone-ctrader").all():
        return {**outcome, "status": "UNVERIFIED_HOLDOUT_BROKER"}
    if len(fit) < MIN_TRAIN_ROWS or len(test) < 60:
        return {**outcome, "status": "INSUFFICIENT_SEQUENTIAL_DATA"}
    train_up = (fit.future_midmove_pips.to_numpy() > 0).astype(int)
    if train_up.sum() < 60 or (1 - train_up).sum() < 60:
        return {**outcome, "status": "INSUFFICIENT_CLASS_BALANCE"}
    reg = make_pipeline(StandardScaler(), Ridge(alpha=100.0))
    reg.fit(fit[list(FEATURES)], fit.future_midmove_pips)
    proba = make_pipeline(
        StandardScaler(), LogisticRegression(C=0.15, solver="liblinear", max_iter=120),
    )
    proba.fit(fit[list(FEATURES)], train_up)
    predicted = reg.predict(test[list(FEATURES)])
    probability = proba.predict_proba(test[list(FEATURES)])[:, 1]
    # No future spread information in the forecast: calibrate the upper
    # quantile from *earlier* training quotes and current as-of quoted spread.
    historical_spread = float(np.quantile(fit.spread_pips, 0.9))
    spread_at_decision = np.maximum(
        historical_spread, test.spread_pips.to_numpy(),
    )
    sides = np.array([
        choose_forecast_side(float(move), float(prob), float(spread))
        for move, prob, spread in zip(predicted, probability, spread_at_decision)
    ], dtype=int)
    outcome.update({
        "status": "WALKFORWARD_RESEARCH_ONLY",
        "historicalSpreadP90Pips": round(historical_spread, 3),
        "signals": {
            "BUY": int((sides == 1).sum()),
            "SELL": int((sides == -1).sum()),
            "ABSTAIN": int((sides == 0).sum()),
        },
        "predictionMAEPips": round(float(
            np.abs(predicted - test.future_midmove_pips).mean()), 3),
        "directionalAccuracyAllBars": round(float(
            ((probability >= 0.5) == (test.future_midmove_pips > 0)).mean()), 3),
        "selected": results_for_signals(test, sides, horizon, history=frame),
        "alwaysBuy": results_for_signals(
            test, np.ones(len(test), dtype=int), horizon, history=frame,
            evaluate_touch=False),
        "alwaysSell": results_for_signals(
            test, -np.ones(len(test), dtype=int), horizon, history=frame,
            evaluate_touch=False),
        "selectedTrades": int((sides != 0).sum()),
        "selectedSignalsMinDailyEvidence": MIN_SIGNALS_PER_DAY,
    })
    return outcome


def run(csv: Path) -> dict:
    raw = pd.read_csv(csv, parse_dates=["stamp"])
    required = {"instrument", "stamp", "bid", "ask", "open", "high", "low", "close", "source_broker"}
    if not required.issubset(raw.columns):
        raise ValueError("Missing required broker-native OHLCV/quote columns")
    for c in ("bid", "ask", "open", "high", "low", "close"):
        raw[c] = pd.to_numeric(raw[c], errors="coerce")
    raw = raw.dropna(subset=list(required))
    raw = raw[
        raw.instrument.isin(("EURUSD", "AUDUSD"))
        & (raw.bid > 0)
        & (raw.ask > raw.bid)
        & raw.source_broker.isin(("ctrader", "pepperstone-ctrader"))
        & (raw.open > 0)
        & (raw.close > 0)
    ]
    report = {
        "artifact": ARTIFACT, "promotionAllowed": False,
        "executionAuthority": "NONE", "brokerOrders": 0,
        "createdAtUTC": datetime.now(timezone.utc).isoformat(),
        "model": "STANDARDIZED_RIDGE_DIRECTIONAL_MOVE_PLUS_LOGISTIC_CALIBRATION",
        "horizonsMinutes": list(HORIZONS),
        "assumptions": {
            "roundtripExtraCommissionSlippagePips": RESERVE_PIPS,
            "brokerBidAskSpreadIncludedInTargets": True,
            "entryNextCompletedMark": True,
            "futureHoldoutLabelsExcludedFromFit": True,
            "testDatePolicy": "FROZEN_LATEST_THREE_UTC_DAYS",
            "frozenProbabilityFloor": FROZEN_MOVE_PROBABILITY,
            "frozenNetEdgeBufferPips": FROZEN_NET_EDGE_BUFFER_PIPS,
            "stopLossTakeProfitFirstTouchModeled": "PROXY_ONLY_STOP_FIRST_SAME_BAR",
            "actualBrokerFillsOrOrders": False,
            "crossBrokerTrainingHistory": True,
            "holdoutBrokerVerified": "pepperstone-ctrader",
            "positiveBidAskSpreadRequired": True,
            "missingSpreadMinuteExcludedNotFilled": True,
            "lastPositiveIntraminuteQuoteIsObservedProxyNotCloseFill": True,
        },
        "results": [], "readiness": "RESEARCH_ONLY",
    }
    for instrument, quotes in raw.groupby("instrument"):
        frame = enrich(quotes).reset_index(drop=True)
        unique_days = sorted(frame.stamp.dt.normalize().unique())
        if len(unique_days) < 5:
            report["results"].append({
                "instrument": instrument, "status": "INSUFFICIENT_DATES",
            })
            continue
        # Freeze the latest THREE UTC dates without searching holdout
        # outcomes to choose a threshold or training algorithm.
        days = unique_days[-3:]
        for horizon in HORIZONS:
            for day in days:
                fold = validate_fold(frame, pd.Timestamp(day), horizon)
                report["results"].append({
                    "instrument": instrument, **fold,
                })
    # The research gate is a REPORT, not an execution gate or auto-promotion.
    # Trading qualification additionally requires prospective independent
    # broker outcomes, real fills and account-level drawdown reconciliation.
    report["qualification"] = assess_challenger_qualification(report)
    return report


def assess_challenger_qualification(report: dict) -> dict:
    """Explain why walk-forward research cannot be promoted to broker DEMO.

    Do not rank/select the best strategy by unseen holdout profits here:
    qualifying many pairs/horizons after examining their results would cause
    multiple-testing selection bias. This is an evidence completeness review.
    """
    required_complete_days = 5
    required_prospectively_marked_trades = 100
    summary = []
    for instrument in ("EURUSD", "AUDUSD"):
        for horizon in HORIZONS:
            folds = [
                row for row in report["results"]
                if row.get("instrument") == instrument
                and row.get("horizonMinutes") == horizon
                and row.get("status") == "WALKFORWARD_RESEARCH_ONLY"
                and row.get("holdoutSource") == "pepperstone-ctrader"
                and row.get("holdoutDayCompletedUTC") is True
            ]
            entries = sum(row["selected"]["firstTouchStopFirst"]["trades"] for row in folds)
            summary.append({
                "instrument": instrument,
                "horizonMinutes": horizon,
                "completedPepperstoneHoldoutDays": len(folds),
                "readOnlyFirstTouchProxyTrades": entries,
                "maturedResearchDayFloorMet": len(folds) >= required_complete_days,
                "prospectiveIndependentBrokerFills": 0,
            })
    return {
        "reviewStatus": "NOT_QUALIFIED_FOR_DEMO_EXECUTION",
        "paperPromotionEligible": False,
        "livePromotionEligible": False,
        "executionAuthority": "NONE",
        "requiredCompletedIndependentHoldoutDays": required_complete_days,
        "requiredProspectiveBrokerValidatedTrades": required_prospectively_marked_trades,
        "reasons": [
            "INSUFFICIENT_COMPLETED_PEPPERSTONE_HOLDOUT_DAYS",
            "INSUFFICIENT_PROSPECTIVE_BROKER_VALIDATED_TRADES",
            "STOP_TP_FIRST_TOUCH_IS_M1_PROXY_NOT_TICK_EXACT",
            "CROSS_BROKER_PRETRAINING_DISTRIBUTION_SHIFT",
            "MULTIPLE_PAIR_HORIZON_SELECTION_BIAS_NOT_RESOLVED",
            "ACCOUNT_LEVEL_DRAWDOWN_AND_REAL_FILL_FEES_NOT_VALIDATED",
        ],
        "candidates": summary,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--csv", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    if (
        args.csv.parent != Path("/tmp")
        or args.out.parent != Path("/tmp")
        or args.out.exists()
        or not args.out.name.startswith("irexpro-")
    ):
        raise ValueError("Require existing private /tmp input and fresh /tmp output")
    report = run(args.csv)
    args.out.write_text(json.dumps(report, indent=2))
    args.out.chmod(0o600)
    brief = []
    for instrument in ("EURUSD", "AUDUSD"):
        for horizon in HORIZONS:
            folds = [
                r for r in report["results"]
                if r.get("instrument") == instrument
                and r.get("horizonMinutes") == horizon
                and r.get("status") == "WALKFORWARD_RESEARCH_ONLY"
            ]
            if not folds:
                continue
            records = [r["selected"]["fixedHold"] for r in folds]
            first_touch_records = [r["selected"]["firstTouchStopFirst"] for r in folds]
            brief.append({
                "instrument": instrument, "horizon": horizon,
                "folds": len(folds),
                "trainingDates": [r["trainingDates"] for r in folds],
                "holdoutDates": [r["holdoutUTC"] for r in folds],
                "trades": sum(r["trades"] for r in records),
                "netPips": round(sum(r["netPipsOneLot"] for r in records), 2),
                "firstTouchNetPips": round(
                    sum(r["netPipsOneLot"] for r in first_touch_records), 2),
                "allDaysPositiveFirstTouch": all(
                    r["netPipsOneLot"] > 0 and r["trades"] >= MIN_SIGNALS_PER_DAY
                    for r in first_touch_records
                ),
                "byDay": {
                    r["holdoutUTC"]: r["selected"]["firstTouchStopFirst"]
                    for r in folds
                },
            })
    print(json.dumps({
        "artifact": ARTIFACT, "executionAuthority": "NONE",
        "outputFile": str(args.out), "summary": brief,
    }, indent=2))


if __name__ == "__main__":
    main()
