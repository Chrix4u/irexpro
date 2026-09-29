"""USDJPY v38 microstructure-rich 10-minute triple-barrier scalper research.

Research only. Each side is simulated from the decision close with observed
entry/exit spread. First barrier within 10 minutes determines side outcome:
TP +1.0 bps, SL -1.5 bps; otherwise timeout at minute 10.
The classification target is LONG/SHORT only when that side's first barrier is
TP, otherwise NO_TRADE. Added lag features are strictly causal.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
from xgboost import XGBClassifier

from app.domain.models.multitimeframe_features import MULTITIMEFRAME_FEATURE_COLUMNS
from app.domain.training.model_qualification import ACTIONABLE_TARGET_COLUMN, _summarize_predictions
from app.domain.training.train_multitimeframe import (
    EVENT_ACTIONABLE_TARGET_COLUMN,
    EVENT_BARRIER_RETURN_COLUMN,
    EVENT_DIRECTION_TARGET_COLUMN,
    EVENT_LONG_NET_RETURN_COLUMN,
    EVENT_SHORT_NET_RETURN_COLUMN,
    EVENT_STEP_COLUMN,
    LONG_NET_RETURN_COLUMN,
    QUALIFICATION_REGIME_COLUMNS,
    SHORT_NET_RETURN_COLUMN,
    TARGET_COLUMN,
    _split_internal_early_stopping_tail,
    _xgboost_n_jobs,
    load_and_prepare_corpora,
)
from app.domain.training.validation import iter_purged_walk_forward_time_splits

EXPERIMENT = "v38_microstructure_triple_barrier_10m_tp1_sl1p5"
HORIZON_BARS = 10
TP_BPS = 1.0
SL_BPS = 1.5
TP = TP_BPS / 10_000.0
SL = SL_BPS / 10_000.0
SHORT_CLASS = 0
NO_TRADE_CLASS = 1
LONG_CLASS = 2
CLASS_CONFIDENCE_FLOOR = 0.40
SUMMARY_CONFIDENCE_THRESHOLD = 0.60

GATE = {
    "min_sharpe_ratio": 1.0,
    "min_profit_factor": 1.15,
    "max_drawdown": 0.12,
    "min_positive_fold_fraction": 0.60,
    "min_trade_evidence": 500,
    "min_trade_density": 0.20,
    "max_median_minutes_between_entries": 2.0,
}

MICRO_BASES = (
    "m1_simple_return",
    "m1_signed_candle_body",
    "m1_spread_bps",
    "m1_volume_zscore_20",
    "m1_momentum_3",
)
MICRO_LAGS = (1, 2, 3, 4, 5)


def _add_micro_features(frame: pd.DataFrame) -> tuple[pd.DataFrame, list[str]]:
    out = frame.sort_values("decision_time").copy()
    feature_cols = list(MULTITIMEFRAME_FEATURE_COLUMNS)
    dt = pd.to_datetime(out["decision_time"], utc=True)
    for base in MICRO_BASES:
        values = pd.to_numeric(out[base], errors="raise")
        for lag in MICRO_LAGS:
            name = f"v38_{base}_lag_{lag}"
            shifted_time = dt.shift(lag)
            exact = (dt - shifted_time) == pd.Timedelta(minutes=lag)
            shifted = values.shift(lag)
            out[name] = np.where(exact, shifted, 0.0)
            feature_cols.append(name)
    return out, feature_cols


def _side_path_returns(frame: pd.DataFrame) -> dict[str, np.ndarray]:
    close = pd.to_numeric(frame["m1_close"], errors="raise")
    spread_bps = pd.to_numeric(frame["m1_spread_bps"], errors="raise")
    spread_price = close * spread_bps / 10_000.0
    dt = pd.to_datetime(frame["decision_time"], utc=True)
    long_entry = close + spread_price / 2.0
    short_entry = close - spread_price / 2.0
    n = len(frame)

    long_done = np.zeros(n, dtype=bool)
    short_done = np.zeros(n, dtype=bool)
    long_tp = np.zeros(n, dtype=bool)
    short_tp = np.zeros(n, dtype=bool)
    long_step = np.full(n, HORIZON_BARS, dtype=int)
    short_step = np.full(n, HORIZON_BARS, dtype=int)
    long_out = np.full(n, np.nan)
    short_out = np.full(n, np.nan)

    last_long = np.full(n, np.nan)
    last_short = np.full(n, np.nan)

    for step in range(1, HORIZON_BARS + 1):
        fc = close.shift(-step)
        fs = spread_price.shift(-step)
        ft = dt.shift(-step)
        exact = ((ft - dt) == pd.Timedelta(minutes=step)).to_numpy()
        lr = (((fc - fs / 2.0) / long_entry) - 1.0).to_numpy(float)
        sr = ((short_entry - (fc + fs / 2.0)) / short_entry).to_numpy(float)
        finite = exact & np.isfinite(lr) & np.isfinite(sr)
        last_long[finite] = lr[finite]
        last_short[finite] = sr[finite]

        l_hit = (~long_done) & finite & ((lr >= TP) | (lr <= -SL))
        s_hit = (~short_done) & finite & ((sr >= TP) | (sr <= -SL))
        if l_hit.any():
            long_done[l_hit] = True
            long_tp[l_hit] = lr[l_hit] >= TP
            long_step[l_hit] = step
            long_out[l_hit] = lr[l_hit]
        if s_hit.any():
            short_done[s_hit] = True
            short_tp[s_hit] = sr[s_hit] >= TP
            short_step[s_hit] = step
            short_out[s_hit] = sr[s_hit]

    # Timeout closes exactly at 10 minutes.
    long_out[~long_done] = last_long[~long_done]
    short_out[~short_done] = last_short[~short_done]

    valid = np.isfinite(long_out) & np.isfinite(short_out)
    return {
        "valid": valid,
        "long_tp": long_tp,
        "short_tp": short_tp,
        "long_step": long_step,
        "short_step": short_step,
        "long_out": long_out,
        "short_out": short_out,
    }


def _attach_target(frame: pd.DataFrame) -> pd.DataFrame:
    out = frame.copy()
    path = _side_path_returns(out)
    target = np.full(len(out), NO_TRADE_CLASS, dtype=int)

    long_ok = path["valid"] & path["long_tp"]
    short_ok = path["valid"] & path["short_tp"]
    long_first = long_ok & (~short_ok | (path["long_step"] < path["short_step"]))
    short_first = short_ok & (~long_ok | (path["short_step"] < path["long_step"]))
    target[long_first] = LONG_CLASS
    target[short_first] = SHORT_CLASS

    out["v38_target"] = target
    out["v38_actionable"] = (target != NO_TRADE_CLASS).astype(int)
    out["v38_long_outcome_return"] = path["long_out"]
    out["v38_short_outcome_return"] = path["short_out"]
    out["v38_long_event_step"] = path["long_step"]
    out["v38_short_event_step"] = path["short_step"]
    out["v38_path_valid"] = path["valid"]
    return out.loc[path["valid"]].reset_index(drop=True)


def _weights(labels: pd.Series) -> np.ndarray:
    y = labels.to_numpy(dtype=int)
    counts = np.bincount(y, minlength=3).astype(float)
    if (counts <= 0).any():
        raise ValueError(f"v38 requires all classes: {counts.tolist()}")
    total = float(len(y))
    per_class = np.sqrt(total / (3.0 * counts))
    weights = np.clip(per_class[y], 0.40, 2.75)
    return (weights / weights.mean()).astype(float)


def _model() -> XGBClassifier:
    return XGBClassifier(
        objective="multi:softprob",
        num_class=3,
        eval_metric="mlogloss",
        n_estimators=900,
        learning_rate=0.02,
        max_depth=5,
        min_child_weight=4.0,
        subsample=0.85,
        colsample_bytree=0.82,
        reg_alpha=0.10,
        reg_lambda=1.50,
        random_state=42,
        n_jobs=_xgboost_n_jobs(),
        tree_method="hist",
        early_stopping_rounds=70,
    )


def _fit(training: pd.DataFrame):
    enriched, features = _add_micro_features(training)
    labeled = _attach_target(enriched)
    fit, early = _split_internal_early_stopping_tail(labeled, horizon_bars=HORIZON_BARS)
    for name, part in (("fit", fit), ("early", early)):
        if set(part["v38_target"].unique()) != {SHORT_CLASS, NO_TRADE_CLASS, LONG_CLASS}:
            raise ValueError(f"v38 {name} partition lacks all classes")
    model = _model()
    model.fit(
        fit[features],
        fit["v38_target"].astype(int),
        sample_weight=_weights(fit["v38_target"]),
        eval_set=[(early[features], early["v38_target"].astype(int))],
        sample_weight_eval_set=[_weights(early["v38_target"])],
        verbose=False,
    )
    return model, features, {
        "fit_rows": int(len(fit)),
        "early_rows": int(len(early)),
        "fit_class_counts": {
            "SHORT": int((fit.v38_target == SHORT_CLASS).sum()),
            "NO_TRADE": int((fit.v38_target == NO_TRADE_CLASS).sum()),
            "LONG": int((fit.v38_target == LONG_CLASS).sum()),
        },
    }


def _predict(source: pd.DataFrame, model, features: list[str], fold: int) -> pd.DataFrame:
    enriched, feature_cols = _add_micro_features(source)
    if feature_cols != features:
        raise ValueError("v38 feature contract mismatch")
    labeled = _attach_target(enriched)
    prob = np.asarray(model.predict_proba(labeled[features]), dtype=float)
    short_p, no_p, long_p = prob[:, 0], prob[:, 1], prob[:, 2]
    pred_class = prob.argmax(axis=1)
    class_conf = prob.max(axis=1)
    pred_long = long_p >= short_p
    active = (pred_class != NO_TRADE_CLASS) & (class_conf >= CLASS_CONFIDENCE_FLOOR)

    cols = [
        "decision_time", "instrument",
        EVENT_DIRECTION_TARGET_COLUMN, EVENT_ACTIONABLE_TARGET_COLUMN,
        EVENT_LONG_NET_RETURN_COLUMN, EVENT_SHORT_NET_RETURN_COLUMN,
        EVENT_STEP_COLUMN, EVENT_BARRIER_RETURN_COLUMN, "m1_spread_bps",
    ]
    cols += [c for c in QUALIFICATION_REGIME_COLUMNS if c in labeled.columns]
    out = labeled[cols].copy()
    true_long = labeled["v38_target"].to_numpy(int) == LONG_CLASS
    out[TARGET_COLUMN] = true_long.astype(int)
    out[ACTIONABLE_TARGET_COLUMN] = labeled["v38_actionable"].astype(int)
    out[LONG_NET_RETURN_COLUMN] = labeled["v38_long_outcome_return"].astype(float)
    out[SHORT_NET_RETURN_COLUMN] = labeled["v38_short_outcome_return"].astype(float)
    side_sum = np.maximum(long_p + short_p, 1e-12)
    direction_p = np.clip(long_p / side_sum, 1e-7, 1 - 1e-7)
    out["raw_positive_probability"] = direction_p
    out["positive_probability"] = direction_p
    out["predicted_long"] = pred_long
    out["direction_confidence"] = np.maximum(long_p, short_p)
    out["opportunity_probability"] = 1.0 - no_p
    out["predicted_opportunity"] = pred_class != NO_TRADE_CLASS
    out["confidence"] = class_conf
    out["active_trade"] = active
    out["selected_net_return"] = np.where(
        pred_long,
        labeled["v38_long_outcome_return"].to_numpy(float),
        labeled["v38_short_outcome_return"].to_numpy(float),
    )
    out["v38_true_class"] = labeled["v38_target"].astype(int)
    out["v38_predicted_class"] = pred_class
    out["v38_short_probability"] = short_p
    out["v38_no_trade_probability"] = no_p
    out["v38_long_probability"] = long_p
    out["fold"] = fold
    out["experiment"] = EXPERIMENT
    out["model_variant"] = EXPERIMENT
    out["calibration_method"] = "none"
    out["decision_threshold"] = 0.5
    out["confidence_floor"] = CLASS_CONFIDENCE_FLOOR
    out["confidence_policy"] = "non_no_trade_argmax_and_class_probability_gte_0_40"
    out["actionable_label_policy"] = f"10m_first_barrier_tp_{TP_BPS}_bps_sl_{SL_BPS}_bps"
    out["event_label_policy"] = out["actionable_label_policy"]
    return out


def _density(pred: pd.DataFrame) -> dict[str, Any]:
    active = pred.loc[pred.active_trade.astype(bool)].sort_values("decision_time")
    long_count = int(active.predicted_long.astype(bool).sum())
    short_count = int(len(active) - long_count)
    med = mean = None
    if len(active) > 1:
        d = pd.to_datetime(active.decision_time, utc=True).diff().dropna().dt.total_seconds() / 60
        med, mean = float(d.median()), float(d.mean())
    return {
        "rows": int(len(pred)),
        "trades": int(len(active)),
        "trade_density": float(len(active) / len(pred)) if len(pred) else 0.0,
        "long_trades": long_count,
        "short_trades": short_count,
        "median_calendar_minutes_between_entries": med,
        "mean_calendar_minutes_between_entries": mean,
    }


def run(dataset: Path, cutoff: str, output: Path) -> dict[str, Any]:
    pooled, hashes = load_and_prepare_corpora(
        {"USDJPY": dataset},
        horizon_bars=HORIZON_BARS,
        decision_time_before=cutoff,
        min_net_return_bps=0.0,
        commission_bps=0.0,
        slippage_bps=0.0,
    )
    raw_price = pd.read_csv(dataset, usecols=["decision_time", "m1_close"])
    raw_price["decision_time"] = pd.to_datetime(
        raw_price["decision_time"], utc=True, errors="raise"
    )
    pooled = pooled.merge(
        raw_price.drop_duplicates("decision_time"),
        on="decision_time",
        how="left",
        validate="many_to_one",
    )
    if pooled["m1_close"].isna().any():
        raise ValueError("v38 could not bind causal M1 close by decision_time")
    periods = int(pooled.decision_time.nunique())
    min_train = max(250, int(periods * 0.60))
    validation = max(100, int(periods * 0.07))
    splits = list(iter_purged_walk_forward_time_splits(
        pooled,
        time_column="decision_time",
        min_train_periods=min_train,
        validation_periods=validation,
        purge_periods=HORIZON_BARS,
        embargo_periods=HORIZON_BARS,
        max_splits=3,
    ))
    output.parent.mkdir(parents=True, exist_ok=True)
    cp_dir = output.parent / "checkpoints"
    cp_dir.mkdir(parents=True, exist_ok=True)

    folds=[]; all_pred=[]
    for fold,(train,valid) in enumerate(splits,1):
        model,features,counts=_fit(train)
        pred=_predict(valid,model,features,fold)
        cp=cp_dir/f"fold-{fold:02d}-v38.csv"
        pred.to_csv(cp,index=False)
        summary=_summarize_predictions(
            pred,horizon_bars=HORIZON_BARS,
            confidence_threshold=SUMMARY_CONFIDENCE_THRESHOLD,
        )
        folds.append({
            "fold":fold,
            "training_counts":counts,
            "density":_density(pred),
            "trading":summary["trading"],
            "classification":summary["classification"],
            "checkpoint":str(cp),
        })
        all_pred.append(pred)

    combined=pd.concat(all_pred,ignore_index=True)
    overall=_summarize_predictions(
        combined,horizon_bars=HORIZON_BARS,
        confidence_threshold=SUMMARY_CONFIDENCE_THRESHOLD,
    )
    density=_density(combined); trading=overall["trading"]
    pff=sum(float(f["trading"]["total_return"])>0 for f in folds)/len(folds)
    checks={
        "sharpe_ratio": trading["sharpe_ratio"] is not None and float(trading["sharpe_ratio"])>=GATE["min_sharpe_ratio"],
        "profit_factor": trading["profit_factor"] is not None and float(trading["profit_factor"])>=GATE["min_profit_factor"],
        "max_drawdown": float(trading["max_drawdown"])<=GATE["max_drawdown"],
        "positive_fold_fraction": pff>=GATE["min_positive_fold_fraction"],
        "minimum_trade_evidence": int(trading["trade_or_period_count"])>=GATE["min_trade_evidence"],
        "trade_density": density["trade_density"]>=GATE["min_trade_density"],
        "median_entry_interval": density["median_calendar_minutes_between_entries"] is not None and float(density["median_calendar_minutes_between_entries"])<=GATE["max_median_minutes_between_entries"],
        "two_sided_execution": density["long_trades"]>0 and density["short_trades"]>0,
    }
    report={
        "experiment":EXPERIMENT,
        "research_only":True,
        "approved_for_paper":False,
        "approved_for_live":False,
        "dataset_sha256":hashes,
        "qualification_decision_time_before":cutoff,
        "horizon_bars":HORIZON_BARS,
        "barriers":{"take_profit_bps":TP_BPS,"stop_loss_bps":SL_BPS},
        "microstructure_features":[c for c in all_pred[0].columns if c.startswith("v38_")],
        "policy":{"class_confidence_floor":CLASS_CONFIDENCE_FLOOR,"outer_validation_used_for_threshold_selection":False},
        "folds":folds,
        "overall":overall,
        "density":density,
        "positive_fold_fraction":pff,
        "research_gate":{"thresholds":GATE,"checks":checks,"research_gate_passed":all(checks.values())},
    }
    output.write_text(json.dumps(report,indent=2,default=str))
    print(json.dumps({
        "output":str(output),
        "trading":trading,
        "density":density,
        "positive_fold_fraction":pff,
        "folds":[{"fold":f["fold"],"density":f["density"],"trading":f["trading"]} for f in folds],
        "research_gate":report["research_gate"],
    },indent=2,default=str))
    return report


def main()->int:
    parser=argparse.ArgumentParser()
    parser.add_argument("--dataset",required=True)
    parser.add_argument("--cutoff",required=True)
    parser.add_argument("--output",required=True)
    args=parser.parse_args()
    run(Path(args.dataset),args.cutoff,Path(args.output))
    return 0


if __name__=="__main__":
    raise SystemExit(main())
