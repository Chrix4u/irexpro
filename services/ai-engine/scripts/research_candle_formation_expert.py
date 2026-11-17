"""Causal next-M1/M5 candlestick expert -- RESEARCH ONLY, never order authority.

Training inputs are exact-owner broker-native, COMPLETED OHLC candles exported
by apps/api/scripts/export-owner-demo-candle-training-corpus.cjs.
For base candle [open_t, close_t], all features must be available at close_t.
The target is the *next* full candle's direction/body/range. No future label
or current partly-forming candle enters prediction features.

Historical OHLC alone cannot recreate an intrabar 'forming candle' snapshot.
A separate as-of tick archival dataset is required for that later capability.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from datetime import datetime, timezone

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier, HistGradientBoostingRegressor
from sklearn.metrics import balanced_accuracy_score, accuracy_score, f1_score, mean_absolute_error

ARTIFACT = "irexpro-candle-formation-expert-research-v1"
MINUTES = {"M1": 1, "M5": 5, "M15": 15, "H1": 60, "H4": 240}
FOCUS = ("EURUSD", "AUDUSD", "USDJPY", "USDCAD")
TRAIN_TARGETS = ("M1", "M5")
LABELS = {0: "RED_OR_DOWN", 1: "SMALL_BODY_OR_FLAT", 2: "GREEN_OR_UP"}
CONTEXTS = {"M1": ("M5", "M15", "H1", "H4"),
            "M5": ("M15", "H1", "H4")}
FEATURE_NAMES = (
    "instrument_id", "body_atr", "range_atr", "upper_wick_fraction",
    "lower_wick_fraction", "close_location", "atr_over_price",
    "spread_atr", "momentum3_atr", "momentum5_atr",
    "body_mean3_atr", "body_mean10_atr", "body_streak3",
    "range_compression", "body_expansion", "inside_bar", "engulfing_body",
    "hour_sin", "hour_cos", "day_of_week",
    "ctx_m5_body_atr", "ctx_m5_momentum3", "ctx_m5_streak",
    "ctx_m15_body_atr", "ctx_m15_momentum3", "ctx_m15_streak",
    "ctx_h1_body_atr", "ctx_h1_momentum3", "ctx_h1_streak",
    "ctx_h4_body_atr", "ctx_h4_momentum3", "ctx_h4_streak",
)


def _positive_finite(x: pd.Series) -> pd.Series:
    return pd.to_numeric(x, errors="coerce").replace([np.inf, -np.inf], np.nan)


def read_broker_candles(path: str | Path) -> pd.DataFrame:
    df = pd.read_csv(path)
    required = {"instrument", "timeframe", "bucket_time", "open", "high", "low",
                "close", "bid_close", "ask_close", "spread_close",
                "sample_count", "positive_quote_sample_count"}
    if not required.issubset(df.columns):
        raise ValueError("MISSING_BROKER_CANDLE_COLUMNS")
    if not df["instrument"].isin(FOCUS).all() or not df["timeframe"].isin(MINUTES).all():
        raise ValueError("UNAPPROVED_CANDLE_SYMBOL_OR_TIMEFRAME")
    df["bucket_time"] = pd.to_datetime(df["bucket_time"], utc=True, errors="coerce")
    for col in ("open", "high", "low", "close", "bid_close", "ask_close",
                "spread_close", "sample_count", "positive_quote_sample_count"):
        df[col] = _positive_finite(df[col])
    if df["bucket_time"].isna().any():
        raise ValueError("INVALID_NATIVE_CANDLE_TIME")
    duration = df["timeframe"].map(MINUTES)
    df["available_at"] = df["bucket_time"] + pd.to_timedelta(duration, unit="m")
    # Fail closed: duplicate same minute, missing quotes or incomplete extrema
    # are not resolved by selecting whichever is most profitable.
    duplicate = df.duplicated(["instrument", "timeframe", "bucket_time"], keep=False)
    if duplicate.any():
        df = df.loc[~duplicate].copy()
    good = (df["open"] > 0) & (df["low"] > 0) & (df["close"] > 0)
    good &= df["high"] >= df[["open", "close"]].max(axis=1)
    good &= df["low"] <= df[["open", "close"]].min(axis=1)
    quote_m1 = df["timeframe"] == "M1"
    # Higher-timeframe provider trend bars have verified OHLC but no
    # independent bid/ask quotes. Cost is recovered strictly from earlier
    # completed native M1 bars by decision time, never invented as zero.
    good &= ((~quote_m1) | (df["ask_close"] >= df["bid_close"]))
    good &= ((~quote_m1) | (df["bid_close"] > 0))
    good &= df["sample_count"] >= 2
    good &= ((~quote_m1) | (df["positive_quote_sample_count"] >= 2))
    good &= ((~quote_m1) | (df["spread_close"] >= 0))
    df = df.loc[good].copy()
    return df.sort_values(["instrument", "timeframe", "bucket_time"]).reset_index(drop=True)


def _frame_features(bars: pd.DataFrame) -> pd.DataFrame:
    """All rolling calculations use this or earlier COMPLETED candles only."""
    x = bars.sort_values("bucket_time").copy().reset_index(drop=True)
    x["bucket_time"] = pd.to_datetime(x["bucket_time"], utc=True)
    if "available_at" not in x.columns:
        x["available_at"] = x["bucket_time"] + pd.to_timedelta(
            MINUTES[str(x["timeframe"].iloc[0])], unit="m"
        )
    eps = 1e-10
    o, h, l, c = (x[k] for k in ("open", "high", "low", "close"))
    tr = pd.concat([(h-l), (h-c.shift(1)).abs(), (l-c.shift(1)).abs()], axis=1).max(axis=1)
    atr = tr.rolling(14, min_periods=10).mean()
    x["atr"] = atr
    x["body_atr"] = (c-o) / atr.clip(lower=eps)
    x["range_atr"] = (h-l) / atr.clip(lower=eps)
    x["upper_wick_fraction"] = (h-pd.concat([o,c],axis=1).max(axis=1)) / (h-l).clip(lower=eps)
    x["lower_wick_fraction"] = (pd.concat([o,c],axis=1).min(axis=1)-l) / (h-l).clip(lower=eps)
    x["close_location"] = (c-l) / (h-l).clip(lower=eps)
    x["atr_over_price"] = atr / c
    x["spread_atr"] = x["spread_close"] / atr.clip(lower=eps)
    x["momentum3_atr"] = (c-c.shift(3)) / atr.clip(lower=eps)
    x["momentum5_atr"] = (c-c.shift(5)) / atr.clip(lower=eps)
    x["body_mean3_atr"] = (c-o).rolling(3,min_periods=3).mean() / atr.clip(lower=eps)
    x["body_mean10_atr"] = (c-o).rolling(10,min_periods=10).mean() / atr.clip(lower=eps)
    direction = np.sign(c-o)
    x["body_streak3"] = direction.rolling(3,min_periods=3).sum()
    x["range_compression"] = (h-l).rolling(3,min_periods=3).mean() / (
        (h-l).rolling(10,min_periods=10).mean().clip(lower=eps)
    )
    x["body_expansion"] = (c-o).abs() / (
        (c-o).abs().rolling(5,min_periods=5).mean().clip(lower=eps)
    )
    x["inside_bar"] = ((h<h.shift(1)) & (l>l.shift(1))).astype(float)
    x["engulfing_body"] = ((pd.concat([o,c],axis=1).min(axis=1) <
                            pd.concat([o.shift(1),c.shift(1)],axis=1).min(axis=1)) &
                           (pd.concat([o,c],axis=1).max(axis=1) >
                            pd.concat([o.shift(1),c.shift(1)],axis=1).max(axis=1))).astype(float)
    clock = x["available_at"].dt.hour + x["available_at"].dt.minute/60
    x["hour_sin"] = np.sin(2*np.pi*clock/24)
    x["hour_cos"] = np.cos(2*np.pi*clock/24)
    x["day_of_week"] = x["available_at"].dt.dayofweek.astype(float)
    return x


def build_next_candle_dataset(corpus: pd.DataFrame, target: str) -> pd.DataFrame:
    """Causal as-of MTF features; next bar labels never leak into X."""
    if target not in TRAIN_TARGETS:
        raise ValueError("M1_OR_M5_TRAINING_ONLY")
    all_rows = []
    for instrument in FOCUS:
        raw = corpus[(corpus.instrument == instrument) & (corpus.timeframe == target)]
        if len(raw) < 80:
            continue
        base = _frame_features(raw)
        base["instrument_id"] = FOCUS.index(instrument)
        # Both M1 and M5 forecast cost evidence are derived from completed
        # M1 bid/ask observations. Native M5+ bars have no bid/ask. We use
        # the causal p90 of >=5 earlier *positive* spreads in the last 60
        # real M1 samples, and refuse missing/stale quote evidence.
        m1_raw = corpus[(corpus.instrument == instrument) &
                        (corpus.timeframe == "M1")].sort_values("bucket_time").copy()
        if len(m1_raw) < 40:
            continue
        if "available_at" not in m1_raw.columns:
            m1_raw["bucket_time"] = pd.to_datetime(m1_raw["bucket_time"], utc=True)
            m1_raw["available_at"] = m1_raw["bucket_time"] + pd.Timedelta(minutes=1)
        m1_cost = m1_raw[["available_at","spread_close"]].copy()
        m1_cost["observed_positive_spread"] = m1_cost["spread_close"].where(
            m1_cost["spread_close"] > 0
        )
        m1_cost["conservative_spread_budget"] = (
            m1_cost["observed_positive_spread"]
            .rolling(60, min_periods=5).quantile(.90)
        )
        base = pd.merge_asof(
            base.sort_values("available_at"),
            m1_cost[["available_at","conservative_spread_budget"]].sort_values("available_at"),
            on="available_at",direction="backward",
            tolerance=pd.Timedelta(minutes=2),
        )
        base["spread_atr"] = base["conservative_spread_budget"] / base["atr"].clip(lower=1e-10)
        # Only consecutive real broker bars can have a next-candle label.
        next_start = base["bucket_time"].shift(-1)
        next_open = base["open"].shift(-1)
        next_close = base["close"].shift(-1)
        next_high = base["high"].shift(-1)
        next_low = base["low"].shift(-1)
        consecutive = next_start == base["available_at"]
        move = next_close - next_open
        cost_threshold = np.maximum(base["conservative_spread_budget"], 0.05*base["atr"])
        base["label"] = np.select(
            [move < -cost_threshold, move > cost_threshold],
            [0,2], default=1,
        ).astype(int)
        base["target_body_atr"] = move.abs() / base["atr"].clip(lower=1e-10)
        base["target_range_atr"] = (next_high-next_low) / base["atr"].clip(lower=1e-10)
        base["next_price_move"] = move
        base["next_spread_at_entry"] = base["conservative_spread_budget"]
        base["has_contiguous_next"] = consecutive
        for tf in CONTEXTS[target]:
            context = corpus[(corpus.instrument == instrument) & (corpus.timeframe == tf)]
            if len(context) < 15:
                continue
            right = _frame_features(context)
            right = right[["available_at","body_atr","momentum3_atr","body_streak3"]].rename(
                columns={"body_atr":f"ctx_{tf.lower()}_body_atr",
                         "momentum3_atr":f"ctx_{tf.lower()}_momentum3",
                         "body_streak3":f"ctx_{tf.lower()}_streak"})
            # At decision t, every context bar must have FINISHED by t. A
            # still-forming H1 bar is NOT taken from its future completed OHLC.
            base = pd.merge_asof(
                base.sort_values("available_at"),
                right.sort_values("available_at"),
                on="available_at", direction="backward",
                tolerance=pd.Timedelta(minutes=MINUTES[tf]*2),
            )
        keep = base["has_contiguous_next"] & base["atr"].gt(0)
        keep &= base["conservative_spread_budget"].gt(0)
        keep &= base["target_body_atr"].notna() & base["target_range_atr"].notna()
        base = base.loc[keep].copy()
        for tf in ("M5","M15","H1","H4"):
            for tail in ("body_atr","momentum3","streak"):
                col=f"ctx_{tf.lower()}_{tail}"
                if col not in base.columns:
                    base[col]=np.nan
        all_rows.append(base)
    if not all_rows:
        raise ValueError("INSUFFICIENT_COMPLETED_BROKER_CANDLES")
    d=pd.concat(all_rows,ignore_index=True)
    return d.replace([np.inf,-np.inf],np.nan).sort_values("available_at").reset_index(drop=True)


def chronological_splits(d: pd.DataFrame, timeframe: str):
    """Global-time split across pairs; purges hours around boundaries."""
    unique = d["available_at"].drop_duplicates().sort_values().reset_index(drop=True)
    if len(unique) < 400:
        raise ValueError("INSUFFICIENT_DISTINCT_DECISION_TIMES")
    t1,t2 = unique.iloc[int(.60*len(unique))],unique.iloc[int(.80*len(unique))]
    # Higher-timeframe history is causal, but embargo guards dependence
    # around nearby market episodes and bar labels.
    gap=pd.Timedelta(hours=1)
    train=d[d.available_at < t1-gap].copy()
    validation=d[(d.available_at > t1+gap)&(d.available_at < t2-gap)].copy()
    test=d[d.available_at > t2+gap].copy()
    if min(len(train),len(validation),len(test)) < 120:
        raise ValueError("INSUFFICIENT_CHRONOLOGICAL_SPLIT")
    return train,validation,test,{"trainCutoff":t1.isoformat(),
        "validationCutoff":t2.isoformat(),"embargoHours":1}


def score(model, magnitude, span, d, baseline_class):
    X=d.loc[:,list(FEATURE_NAMES)]
    probs=model.predict_proba(X)
    labels=model.classes_
    predicted=labels[np.argmax(probs,axis=1)]
    confidence=np.max(probs,axis=1)
    baseline=np.full(len(d),baseline_class)
    p_dict={int(label):probs[:,i] for i,label in enumerate(labels)}
    selected=((predicted==0)|(predicted==2))&(confidence>=.65)
    # Mid OHLC and observed spread are merely a directional *proxy*;
    # NO commissions, broker stops, actual fills, or FX conversion.
    sign=np.where(predicted==2,1,-1)
    spread_only_move=sign*d["next_price_move"].to_numpy()-d["next_spread_at_entry"].to_numpy()
    body_pred=np.maximum(magnitude.predict(X),0)
    range_pred=np.maximum(span.predict(X),0)
    truth=d["label"].to_numpy()
    return {
      "observations":len(d),
      "classCounts":{LABELS[k]:int((truth==k).sum()) for k in LABELS},
      "accuracy":round(float(accuracy_score(truth,predicted)),4),
      "balancedAccuracy":round(float(balanced_accuracy_score(truth,predicted)),4),
      "macroF1":round(float(f1_score(truth,predicted,average="macro",zero_division=0)),4),
      "majorityBaselineAccuracy":round(float(accuracy_score(truth,baseline)),4),
      "majorityBaselineBalancedAccuracy":round(float(balanced_accuracy_score(truth,baseline)),4),
      "highConfidenceDirectionalCoverage":round(float(selected.mean()),4),
      "highConfidenceDirectionalCount":int(selected.sum()),
      "highConfidenceColorHitRate":round(float((predicted[selected]==truth[selected]).mean()),4)
        if selected.any() else None,
      "highConfidenceSpreadOnlyPositiveRate":round(float((spread_only_move[selected]>0).mean()),4)
        if selected.any() else None,
      "meanHighConfidenceSpreadOnlyPriceMove":round(float(spread_only_move[selected].mean()),8)
        if selected.any() else None,
      "predictedNextBodyAtrMAE":round(float(mean_absolute_error(d["target_body_atr"],body_pred)),4),
      "predictedNextRangeAtrMAE":round(float(mean_absolute_error(d["target_range_atr"],range_pred)),4),
      "predictionCostStatus":"SPREAD_ONLY_NO_COMMISSION_OR_SLIPPAGE",
    }


def train_expert(input_csv: str|Path, out: str|Path, model_dir: str|Path|None=None):
    from joblib import dump
    data=read_broker_candles(input_csv)
    result={
        "artifact":ARTIFACT,
        "trainedAt":datetime.now(timezone.utc).isoformat(),
        "mode":"RESEARCH_ONLY",
        "modifiesExecution":False,
        "notActiveTradingAuthority":True,
        "formingCandlePredictionsAvailable":False,
        "modelKind":"HistGradientBoostingClassifier_three_class_plus_body_range_regressors",
        "targetDefinition":"next fully closed candle RED/FLAT/GREEN; flat if next mid-price body is smaller than current observed spread or 0.05 ATR",
        "timeframes":{},
        "limitations":[
          "Completed broker mid OHLC cannot train an in-progress candle forecaster without archived as-of intrabar snapshots.",
          "This model predicts statistical possibilities, not known next-candle colors or exact candle heights.",
          "Higher-timeframe M5/M15/H1/H4 OHLC have no direct bid/ask; cost proxy uses an as-of rolling p90 of positive completed native M1 spreads.",
          "Spread-only proxy is not executable P&L and excludes round-trip commission, slippage, margin and stop-loss path.",
          "One short market window and one chronological test block cannot establish persistent edge across volatility regimes.",
          "No broker execution integration. Promotion requires later unseen out-of-sample and costs-inclusive evidence.",
        ],
    }
    for tf in TRAIN_TARGETS:
        try:
            d=build_next_candle_dataset(data,tf)
            tr,val,te,boundaries=chronological_splits(d,tf)
            X_tr=tr.loc[:,list(FEATURE_NAMES)]
            y_tr=tr["label"]
            if len(np.unique(y_tr))<3:
                raise ValueError("TRAINING_TARGET_CLASS_COVERAGE_INSUFFICIENT")
            model=HistGradientBoostingClassifier(max_iter=90, max_leaf_nodes=13,
                    min_samples_leaf=70,l2_regularization=5.0,
                    learning_rate=.045,early_stopping=False,random_state=19)
            model.fit(X_tr,y_tr)
            mag=HistGradientBoostingRegressor(max_iter=75,max_leaf_nodes=12,
                    min_samples_leaf=70,l2_regularization=5.0,early_stopping=False,random_state=19)
            mag.fit(X_tr,tr["target_body_atr"])
            span=HistGradientBoostingRegressor(max_iter=75,max_leaf_nodes=12,
                    min_samples_leaf=70,l2_regularization=5.0,early_stopping=False,random_state=19)
            span.fit(X_tr,tr["target_range_atr"])
            report={"status":"TRAINED_RESEARCH_NOT_PROMOTED",
                    "sampleCount":len(d),"trainSamples":len(tr),
                    "validationSamples":len(val),"testSamples":len(te),
                    "boundaries":boundaries,
                    "validation":score(model,mag,span,val,int(y_tr.value_counts().idxmax())),
                    "untouchedChronologicalTest":score(model,mag,span,te,int(y_tr.value_counts().idxmax())),
                    "featureCount":len(FEATURE_NAMES),
                    "instruments":list(FOCUS)}
            result["timeframes"][tf]=report
            if model_dir is not None:
                target=Path(model_dir)
                target.mkdir(parents=True,exist_ok=True)
                f=target/f"candle_formation_{tf.lower()}_RESEARCH_ONLY.joblib"
                dump({"artifact":ARTIFACT,"frame":tf,"model":model,"bodyModel":mag,
                      "rangeModel":span,"features":FEATURE_NAMES,"boundaries":boundaries,
                      "researchOnly":True},f)
                f.chmod(0o600)
        except (ValueError,KeyError) as exc:
            result["timeframes"][tf]={"status":"NOT_TRAINED","reason":str(exc)}
    destination=Path(out)
    if not str(destination.resolve()).startswith("/tmp/"):
        raise ValueError("PRIVATE_TMP_REPORT_REQUIRED")
    destination.write_text(json.dumps(result,indent=2)+"\n",encoding="utf8")
    destination.chmod(0o600)
    return result


def main():
    p=argparse.ArgumentParser()
    p.add_argument("--input",required=True)
    p.add_argument("--out",required=True)
    p.add_argument("--models")
    a=p.parse_args()
    print(json.dumps(train_expert(a.input,a.out,a.models),indent=2))


if __name__=="__main__":
    main()
