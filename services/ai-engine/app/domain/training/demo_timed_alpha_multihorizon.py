"""Exploratory only: first chronological M1 1/3/5/10-minute broker-mark models.

Consumes a research dataset that was created from persisted as-of M1 signals and
broker-native quotes AFTER signal persistence, with historical as-of commissions.
This is NOT a tick-first-touch backtest, nor a broker execution authority.

The classifier and net-payoff model are fit only to earlier UTC-day training
examples, with a 20-minute label-window purge and a fully untouched later day.
Zero weights are written or published. Nothing in this module can submit orders.
"""
from __future__ import annotations

import argparse
import json
import math
import os
from datetime import UTC, datetime, timedelta
from pathlib import Path

import numpy as np
from sklearn.feature_extraction import DictVectorizer
from sklearn.linear_model import LogisticRegression, Ridge
from sklearn.metrics import brier_score_loss, log_loss
from sklearn.preprocessing import StandardScaler

ARTIFACT = "irexpro-timed-alpha-chronological-research-v1"
HORIZONS = (1, 3, 5, 10)
EMBARGO_MINUTES = 20  # longer than max horizon + broker quote lag
MIN_EXPLORATORY_TRAIN = 40
MIN_EXPLORATORY_HOLDOUT = 20
MIN_TRAIN_WINS = 8
MIN_TRAIN_LOSSES = 8
MIN_QUALIFICATION_TRAIN_DAYS = 10
MIN_QUALIFICATION_HOLDOUT_DAYS = 3
MAX_ROW_COUNT = 10000
ALLOWED_INSTRUMENTS = frozenset(
    ("EURUSD", "GBPUSD", "AUDUSD", "USDCHF", "USDJPY", "USDCAD")
)
ALLOWED_ROUTES = frozenset(("M1_TREND_CONTINUATION", "M1_EARLY_TRANSITION"))
ALLOWED_FEATURES = frozenset(
    (
        "atr", "score", "confidence", "directionQuality", "grossExpectedR",
        "alignedEmaSeparationAtr", "alignedEmaSlopeAtr",
        "alignedM5Momentum1Atr", "alignedM5Momentum3Atr",
        "alignedMomentum1Atr", "alignedMomentum3Atr", "alignedMomentum5Atr",
        "alignedM5BodyPressure3", "alignedHigherTimeframeAgreement",
        "alignedM30DirectionalEfficiency", "breakoutAtr", "m5BodyExpansionRatio",
        "planBMetaProbability", "planBExpectedR", "planBDirectionQuality",
        "planBTradeQuality", "planBExitQuality",
    )
)


def _parse_time(value: object) -> datetime:
    if not isinstance(value, str):
        raise ValueError("Invalid persisted decision timestamp")
    t = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if t.tzinfo is None or t.utcoffset() != timedelta():
        raise ValueError("Research timestamps must be timezone-aware UTC")
    return t.astimezone(UTC)


def load_research_cohort(raw: dict) -> list[dict]:
    if (
        not isinstance(raw, dict)
        or raw.get("artifact") != "irexpro-offline-1-3-5-10m-research-cohort-v1"
        or raw.get("trainingAuthority") != "NONE"
        or raw.get("promotionAllowed") is not False
        or raw.get("brokerOrders") != 0
    ):
        raise ValueError("Only private non-promoting iRexPro research datasets are permitted")
    rows = raw.get("rows")
    if not isinstance(rows, list) or not 0 < len(rows) <= MAX_ROW_COUNT:
        raise ValueError("Invalid or oversized research cohort")
    parsed: list[dict] = []
    for source in rows:
        if not isinstance(source, dict):
            continue
        instrument, direction, route = (
            source.get("instrument"), source.get("direction"), source.get("route")
        )
        if instrument not in ALLOWED_INSTRUMENTS or direction not in ("BUY", "SELL"):
            continue
        if route not in ALLOWED_ROUTES:
            continue
        date = _parse_time(source.get("persistedDecisionAt"))
        features = source.get("features")
        if not isinstance(features, dict):
            continue
        # Do NOT use any unlisted source fields, realized labels or future
        # quote timestamps as model inputs. Missing values have indicators.
        asof = {}
        for key in sorted(ALLOWED_FEATURES):
            val = features.get(key)
            if isinstance(val, bool) or val is None:
                asof[key] = 0.0
                asof[key + "_missing"] = 1.0
            else:
                try:
                    num = float(val)
                except (TypeError, ValueError, OverflowError):
                    num = math.nan
                asof[key] = max(-1000.0, min(1000.0, num)) if math.isfinite(num) else 0.0
                asof[key + "_missing"] = 0.0 if math.isfinite(num) else 1.0
        asof["instrument_" + instrument] = 1.0
        asof["direction_" + direction] = 1.0
        asof["route_" + route] = 1.0
        asof["planBAdmitted"] = 1.0 if source.get("planBAdmitted") is True else 0.0
        regime = source.get("researchRegime")
        if isinstance(regime, str) and regime in (
            "TREND_HEALTHY", "TREND_WEAK", "TREND_EXTENDED", "RANGE",
            "TRANSITION", "REVERSAL", "HIGH_VOLATILITY", "ROLLOVER_RISK"
        ):
            asof["regime_" + regime] = 1.0
        def validated_labels(raw_labels: object) -> dict:
            output = {}
            if not isinstance(raw_labels, dict):
                return output
            for h in HORIZONS:
                label = raw_labels.get(str(h))
                if not isinstance(label, dict):
                    continue
                try:
                    net = float(label["netUsd1Lot"])
                    pips = float(label["signedPips"])
                    lag = float(label["markLagSec"])
                except (KeyError, ValueError, TypeError, OverflowError):
                    continue
                if not all(math.isfinite(v) for v in (net, pips, lag)) or not 0 <= lag <= 90:
                    continue
                if not -10000 < net < 10000 or not -500 < pips < 500:
                    continue
                output[h] = {"net": net, "pips": pips, "positive": net > 0}
            return output

        outputs = validated_labels(source.get("labels"))
        opposite = validated_labels(source.get("oppositeLabels"))
        parsed.append({
            "time": date, "features": asof, "labels": outputs,
            "oppositeLabels": opposite,
            "planBAdmitted": source.get("planBAdmitted") is True,
            "instrument": instrument, "direction": direction, "route": route,
        })
    return sorted(parsed, key=lambda r: r["time"])


def chronological_holdout(
    rows: list[dict], horizon: int, embargo_minutes: int = EMBARGO_MINUTES
) -> tuple[list[dict], list[dict], dict]:
    if horizon not in HORIZONS or embargo_minutes < 13:
        raise ValueError("Invalid horizon or unsafe label embargo")
    observed = [r for r in rows if horizon in r["labels"]]
    days = sorted({r["time"].date() for r in observed})
    if len(days) < 2:
        return [], [], {"reason": "NEED_AT_LEAST_TWO_DISTINCT_UTC_DAYS", "days": len(days)}
    last = days[-1]
    holdout_start = datetime(last.year, last.month, last.day, tzinfo=UTC)
    cutoff = holdout_start - timedelta(minutes=embargo_minutes)
    # The model cannot learn from a row whose potential +10m future labels
    # could cross the holdout day's boundary. Use full UTC day only.
    train = [r for r in observed if r["time"] < cutoff]
    holdout = [r for r in observed if r["time"] >= holdout_start]
    return train, holdout, {
        "reason": "CHRONOLOGICAL_UTC_DAY_SPLIT",
        "trainDays": len({r["time"].date() for r in train}),
        "holdoutDays": len({r["time"].date() for r in holdout}),
        "holdoutDateUTC": last.isoformat(),
        "embargoMinutes": embargo_minutes,
        "lastTrainTime": train[-1]["time"].isoformat() if train else None,
        "firstHoldoutTime": holdout[0]["time"].isoformat() if holdout else None,
    }


def economics(rows: list[dict], horizon: int, indices: np.ndarray | None = None) -> dict:
    chosen = [rows[int(i)] for i in indices] if indices is not None else rows
    y = np.array([r["labels"][horizon]["net"] for r in chosen], dtype=float)
    if not len(y):
        return {"n": 0, "positive": 0, "positiveShare": None,
                "avgNetUsdOneLot": None, "profitFactor": None}
    profits = y[y > 0].sum()
    losses = -y[y < 0].sum()
    return {
        "n": int(len(y)),
        "positive": int((y > 0).sum()),
        "positiveShare": round(float((y > 0).mean()), 3),
        "avgNetUsdOneLot": round(float(y.mean()), 2),
        "netTotalOneLot": round(float(y.sum()), 2),
        "profitFactor": round(float(profits / losses), 3) if losses > 0 else None,
    }


def evaluate_horizon(rows: list[dict], horizon: int) -> dict:
    train, holdout, split = chronological_holdout(rows, horizon)
    report = {
        "horizonMinutes": horizon,
        "authority": "RESEARCH_ONLY_NO_EXECUTION",
        "modelFitted": False, "promotionAllowed": False, "brokerOrders": 0,
        "readiness": "INSUFFICIENT_DATA",
        "split": split, "training": economics(train, horizon),
        "holdoutAll": economics(holdout, horizon),
        "holdoutPlanBAdmitted": economics(
            [r for r in holdout if r["planBAdmitted"]], horizon
        ),
        "holdoutModelSelected": economics([], horizon),
        "modelDiagnostics": None,
    }
    if (
        len(train) < MIN_EXPLORATORY_TRAIN
        or len(holdout) < MIN_EXPLORATORY_HOLDOUT
        or sum(r["labels"][horizon]["positive"] for r in train) < MIN_TRAIN_WINS
        or sum(not r["labels"][horizon]["positive"] for r in train) < MIN_TRAIN_LOSSES
    ):
        return report
    # All feature names, scaling and predictive parameters fit on train only.
    dv = DictVectorizer(sparse=False)
    fit_x = dv.fit_transform([r["features"] for r in train])
    test_x = dv.transform([r["features"] for r in holdout])
    standardizer = StandardScaler()
    fit_x = standardizer.fit_transform(fit_x)
    test_x = standardizer.transform(test_x)
    fit_y = np.array([r["labels"][horizon]["net"] for r in train], dtype=float)
    test_y = np.array([r["labels"][horizon]["net"] for r in holdout], dtype=float)
    logistic = LogisticRegression(C=0.15, max_iter=500, random_state=19)
    logistic.fit(fit_x, (fit_y > 0).astype(int))
    prob = logistic.predict_proba(test_x)[:, 1]
    regression = Ridge(alpha=40.0, solver="svd")
    # Training-only payoff winsorization avoids sensitivity to large outliers,
    # not used to manipulate holdout realized quotes.
    lower, upper = np.quantile(fit_y, [0.02, 0.98])
    regression.fit(fit_x, np.clip(fit_y, lower, upper))
    expected_net = regression.predict(test_x)
    train_expected = regression.predict(fit_x)
    # A threshold fixed entirely from the training score distribution,
    # plus strictly positive forecast; no future holdout outcome tuning.
    threshold = max(0.0, float(np.quantile(train_expected, 0.8)))
    selected = np.flatnonzero(expected_net > threshold)
    report["modelFitted"] = True
    report["readiness"] = "EXPLORATORY_ONLY_INSUFFICIENT_DAYS"
    report["holdoutModelSelected"] = economics(holdout, horizon, selected)
    report["modelDiagnostics"] = {
        "model": "L2_LOGISTIC_DIRECTION_PLUS_L2_RIDGE_NET_USD",
        "features": len(dv.feature_names_),
        "trainOnlyExpectedNetThreshold": round(threshold, 3),
        "holdoutMeanPredictedNetOneLot": round(float(expected_net.mean()), 2),
        "holdoutMeanActualNetOneLot": round(float(test_y.mean()), 2),
        "brier": round(float(brier_score_loss((test_y > 0).astype(int), prob)), 4),
        "logLoss": round(float(log_loss((test_y > 0).astype(int), prob, labels=[0, 1])), 4),
        "holdoutFixedTop20PctRankNet": economics(
            holdout, horizon,
            np.argsort(-expected_net, kind="stable")[:max(1, len(holdout) // 5)],
        ),
        "explanation": (
            "One-day train plus partial one-day holdout can describe associations "
            "but cannot establish a transferable positive expected-value strategy."
        ),
    }
    return report


def evaluate_side_selection(rows: list[dict], horizon: int) -> dict:
    # Pairs forecast original and opposite broker-net marks using *only* as-of
    # features, returning NO_EDGE when neither is expected positive.
    # This is never a real order router or execution policy.
    paired = [r for r in rows if horizon in r["labels"] and horizon in r["oppositeLabels"]]
    train, holdout, split = chronological_holdout(paired, horizon)
    reverse_rows = [
        {**r, "labels": {horizon: r["oppositeLabels"][horizon]}} for r in holdout
    ]
    report = {
        "horizonMinutes": horizon, "authority": "RESEARCH_ONLY_NO_EXECUTION",
        "promotionAllowed": False, "brokerOrders": 0, "modelFitted": False,
        "readiness": "INSUFFICIENT_DATA", "split": split,
        "holdoutOriginalDirection": economics(holdout, horizon),
        "holdoutAlwaysOpposite": economics(reverse_rows, horizon),
        "holdoutModelChosenSide": economics([], horizon),
        "chosenOriginalCount": 0, "chosenOppositeCount": 0,
        "noEdgeCount": len(holdout), "diagnostics": None,
    }
    if (
        len(train) < MIN_EXPLORATORY_TRAIN
        or len(holdout) < MIN_EXPLORATORY_HOLDOUT
        or sum(r["labels"][horizon]["positive"] for r in train) < MIN_TRAIN_WINS
        or sum(not r["labels"][horizon]["positive"] for r in train) < MIN_TRAIN_LOSSES
    ):
        return report
    dv = DictVectorizer(sparse=False)
    train_x = dv.fit_transform([r["features"] for r in train])
    test_x = dv.transform([r["features"] for r in holdout])
    scaler = StandardScaler()
    train_x = scaler.fit_transform(train_x)
    test_x = scaler.transform(test_x)
    orig_train = np.array([r["labels"][horizon]["net"] for r in train], dtype=float)
    opp_train = np.array([r["oppositeLabels"][horizon]["net"] for r in train], dtype=float)
    orig_low, orig_high = np.quantile(orig_train, [0.02, 0.98])
    opp_low, opp_high = np.quantile(opp_train, [0.02, 0.98])
    orig_model = Ridge(alpha=40.0, solver="svd")
    opp_model = Ridge(alpha=40.0, solver="svd")
    orig_model.fit(train_x, np.clip(orig_train, orig_low, orig_high))
    opp_model.fit(train_x, np.clip(opp_train, opp_low, opp_high))
    orig_prediction = orig_model.predict(test_x)
    opp_prediction = opp_model.predict(test_x)
    chosen = []
    chosen_orig = 0
    chosen_opp = 0
    for i, row in enumerate(holdout):
        original, opposite = float(orig_prediction[i]), float(opp_prediction[i])
        if original <= 0 and opposite <= 0:
            continue
        if original >= opposite:
            chosen_orig += 1
            chosen.append(row)
        else:
            chosen_opp += 1
            chosen.append({**row, "labels": {horizon: row["oppositeLabels"][horizon]}})
    report["modelFitted"] = True
    report["readiness"] = "EXPLORATORY_ONLY_INSUFFICIENT_DAYS"
    report["holdoutModelChosenSide"] = economics(chosen, horizon)
    report["chosenOriginalCount"] = chosen_orig
    report["chosenOppositeCount"] = chosen_opp
    report["noEdgeCount"] = len(holdout) - len(chosen)
    report["diagnostics"] = {
        "model": "PAIRED_L2_RIDGE_ASOF_ORIGINAL_OPPOSITE_NET_USD",
        "features": len(dv.feature_names_),
        "meanPredictedOriginalUSD": round(float(np.mean(orig_prediction)), 2),
        "meanPredictedOppositeUSD": round(float(np.mean(opp_prediction)), 2),
        "caveat": (
            "Not broker execution, not tick-level stop/TP, not independent "
            "multi-day proof; NO_EDGE never suppresses existing Plan B trades."
        ),
    }
    return report


def evaluate(raw: dict) -> dict:
    rows = load_research_cohort(raw)
    report = {
        "artifact": ARTIFACT,
        "authority": "RESEARCH_ONLY_NO_EXECUTION",
        "promotionAllowed": False,
        "modelArtifactSaved": False,
        "brokerOrders": 0,
        "cohortRows": len(rows),
        "utcDays": len({r["time"].date() for r in rows}),
        "minimumIndependentQualification": {
            "trainDays": MIN_QUALIFICATION_TRAIN_DAYS,
            "holdoutDays": MIN_QUALIFICATION_HOLDOUT_DAYS,
        },
        "horizons": [evaluate_horizon(rows, h) for h in HORIZONS],
        "pairedDirection": [evaluate_side_selection(rows, h) for h in HORIZONS],
        "caveats": [
            "M1 broker quote marks are not confirmed broker fills or tick first touches",
            "No slippage or market impact; P90 commission is already deducted from mark labels",
            "Five-minute pair-side episodes still overlap across instruments and sessions",
            "Train-only fit and purged latest UTC day holdout do not provide multi-day stability",
            "No stop/TP/portfolio/rollover execution simulation; cannot promote to DEMO or LIVE",
            "Holdout is latest partial UTC day if dataset collected before its end",
            "New alpha must not suppress qualified original Plan B / M1 trades",
        ],
    }
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description="Non-executable multi-horizon DEMO alpha study")
    parser.add_argument("--cohort-json", required=True, type=Path)
    parser.add_argument("--report-json", required=True, type=Path)
    args = parser.parse_args()
    # Avoid storing broker research files in user-facing app directories or a
    # persistent/auto-loaded model registry. No arbitrary user client path.
    if (
        args.cohort_json.parent != Path("/tmp")
        or not args.cohort_json.name.startswith("irexpro-")
        or args.cohort_json.suffix != ".json"
        or args.report_json.parent != Path("/tmp")
        or not args.report_json.name.startswith("irexpro-")
        or args.report_json.suffix != ".json"
        or args.report_json.exists()
    ):
        raise ValueError("Require fresh private /tmp/irexpro-*.json research paths")
    raw = json.loads(args.cohort_json.read_text())
    report = evaluate(raw)
    # O_EXCL avoids clobbering and O_NOFOLLOW rejects symlinks: never open a
    # model registry/public app path or briefly create world-readable outputs.
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    fd = os.open(args.report_json, flags, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(report, handle, indent=2, sort_keys=True)
        handle.write("\n")
    print(json.dumps({
        "artifact": report["artifact"],
        "cohortRows": report["cohortRows"],
        "utcDays": report["utcDays"],
        "modelFitted": [r["modelFitted"] for r in report["horizons"]],
        "promotionAllowed": False,
        "brokerOrders": 0,
    }, sort_keys=True))


if __name__ == "__main__":
    main()
