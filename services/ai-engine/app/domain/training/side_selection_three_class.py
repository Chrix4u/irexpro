"""Research-only KEEP / FLIP / ABSTAIN side-selection model.

The live collector ranks BUY/SELL candidates by candidate score before evaluating
both sides. This research model mirrors that shape: one sample per de-overlapped
market episode, higher-score candidate as PRIMARY, the other as OPPOSITE, and a
relative target KEEP / FLIP / ABSTAIN. All predictors are pre-entry data.
"""
from __future__ import annotations

import argparse
import json
import math
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator

import numpy as np
import pandas as pd
from sklearn.compose import ColumnTransformer
from sklearn.impute import SimpleImputer
from sklearn.metrics import balanced_accuracy_score, precision_recall_fscore_support
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder
from sklearn.utils.class_weight import compute_sample_weight
from xgboost import XGBClassifier

LABELS = ("KEEP", "FLIP", "ABSTAIN")
LABEL_TO_CLASS = {label: index for index, label in enumerate(LABELS)}
CLASS_TO_LABEL = {index: label for label, index in LABEL_TO_CLASS.items()}
CONFIDENCE_FLOOR = 0.60

BASE_CATEGORICAL_FEATURES = (
    "instrument",
    "direction",
    "policy_version",
    "strategy_route",
    "pair_side_route",
    "drift_state",
    "event_risk",
    "sleeve_state",
    "adaptive_market_state",
    "adaptive_evidence_class",
    "trained_expert_state",
    "trained_expert_direction",
    "calibration_conflict_state",
    "calibration_conflict_reason",
    "calibration_raw_preferred_direction",
    "market_state_session",
    "market_state_volatility_state",
    "edge_evidence_class",
    "edge_maturity",
    "edge_recent_status",
    "shadow_pulse_status",
    "shadow_pulse_quality",
    "prediction_calibration_maturity",
    "prediction_calibration_reason",
)

BASE_NUMERIC_FEATURES = (
    "candidate_score",
    "direction_quality",
    "trade_quality",
    "exit_quality",
    "pair_side_quality",
    "session_quality",
    "portfolio_quality",
    "portfolio_risk_score",
    "open_position_count",
    "same_instrument_count",
    "same_instrument_directional_lots",
    "mtf_strength",
    "ema_separation",
    "extension_atr",
    "rsi14",
    "volatility_score",
    "short_horizon_momentum_atr",
    "governance_gross_expected_r",
    "governance_net_expected_r",
    "execution_cost_r",
    "adaptive_net_expected_r",
    "adaptive_raw_net_expected_r",
    "adaptive_risk_multiplier",
    "pre_adaptive_scan_rank",
    "adaptive_scan_rank",
    "calibration_candidate_directional_probability",
    "calibration_opposite_directional_probability",
    "calibration_directional_edge",
    "calibrated_net_expected_r",
    "calibrated_win_probability",
    "calibration_samples",
    "trained_expert_confidence",
    "trained_expert_opportunity_probability",
    "trained_expert_long_votes",
    "trained_expert_short_votes",
    "market_state_higher_timeframe_agreement",
    "market_state_h4_alignment",
    "market_state_reversal_score",
    "market_state_transition_score",
    "market_state_trend_strength",
    "market_state_state_confidence",
    "market_state_trading_confidence",
    "opportunity_score",
    "edge_smoothed_expected_r",
    "edge_smoothed_win_rate",
    "edge_profit_factor",
    "edge_sharpe",
    "edge_average_realized_r",
    "edge_average_mfe_r",
    "edge_average_mae_r",
    "edge_average_execution_cost_r",
    "edge_average_profit_giveback_r",
    "edge_calibration_gap",
    "edge_positive_window_fraction",
    "edge_max_drawdown",
    "edge_closed_trades",
    "edge_prospective_samples",
    "shadow_pulse_advantage_r",
    "shadow_pulse_candidate_weighted_r",
    "shadow_pulse_opposite_weighted_r",
    "shadow_pulse_candidate_samples",
    "shadow_pulse_opposite_samples",
    "prediction_calibrated_net_expected_r",
    "prediction_calibrated_win_probability",
    "prediction_confidence_correction",
    "prediction_empirical_win_rate",
    "prediction_profit_factor",
    "prediction_raw_confidence",
    "prediction_raw_net_expected_r",
    "prediction_samples",
    "exposure_diversification_quality",
    "exposure_correlated_exposure_score",
    "exposure_largest_aligned_currency_concentration",
    "exposure_same_instrument_directional_risk",
)

_PAIR_CATEGORICAL_BASE = tuple(
    name for name in BASE_CATEGORICAL_FEATURES if name not in {"instrument", "direction", "policy_version"}
)
EPISODE_CATEGORICAL_FEATURES = (
    "instrument",
    "policy_version",
    "primary_direction",
    *tuple(f"primary__{name}" for name in _PAIR_CATEGORICAL_BASE),
    *tuple(f"opposite__{name}" for name in _PAIR_CATEGORICAL_BASE),
)
EPISODE_NUMERIC_FEATURES = tuple(
    name
    for base in BASE_NUMERIC_FEATURES
    for name in (f"primary__{base}", f"opposite__{base}", f"delta__{base}")
)

LOCKED_GATE = {
    "min_balanced_accuracy": 0.52,
    "min_sharpe_ratio": 1.0,
    "min_profit_factor": 1.15,
    "max_drawdown": 0.12,
    "min_positive_fold_fraction": 0.60,
    "min_positive_instrument_fraction": 0.67,
    "confidence_floor": CONFIDENCE_FLOOR,
}


@dataclass(frozen=True)
class OperationalPredictions:
    labels: np.ndarray
    confidence: np.ndarray
    raw_labels: np.ndarray


@dataclass
class FittedSideSelectionModel:
    preprocessor: ColumnTransformer
    model: XGBClassifier

    def predict_proba(self, frame: pd.DataFrame) -> np.ndarray:
        features = model_feature_columns(frame)
        matrix = self.preprocessor.transform(frame[features])
        probabilities = np.asarray(self.model.predict_proba(matrix), dtype=float)
        if probabilities.shape != (len(frame), len(LABELS)):
            raise ValueError("side-selection model returned unexpected probability shape")
        return probabilities


def _finite(value: Any) -> float | None:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if math.isfinite(result) else None


def _normalize_direction_frame(frame: pd.DataFrame) -> pd.DataFrame:
    required = {
        "episode_id",
        "decision_time",
        "market_bar_time",
        "target_resolved_at",
        "instrument",
        "direction",
        "policy_version",
        "label",
        "target_original_net_r",
        "target_opposite_net_r",
    }
    missing = sorted(required - set(frame.columns))
    if missing:
        raise ValueError(f"side-selection dataset missing required columns: {','.join(missing)}")
    result = frame.copy()
    for name in ("decision_time", "market_bar_time", "target_resolved_at"):
        result[name] = pd.to_datetime(result[name], utc=True, errors="coerce")
    if result[["decision_time", "market_bar_time", "target_resolved_at"]].isna().any().any():
        raise ValueError("side-selection dataset contains invalid timestamps")
    result["label"] = result["label"].astype(str).str.upper()
    if not result["label"].isin(LABELS).all():
        raise ValueError("side-selection dataset contains invalid labels")
    result["direction"] = result["direction"].astype(str).str.upper()
    if not result["direction"].isin(("BUY", "SELL")).all():
        raise ValueError("side-selection dataset contains invalid directions")
    for name in BASE_CATEGORICAL_FEATURES:
        if name not in result:
            result[name] = "UNKNOWN"
        result[name] = result[name].fillna("UNKNOWN").astype(str)
    for name in BASE_NUMERIC_FEATURES:
        if name not in result:
            result[name] = np.nan
        result[name] = pd.to_numeric(result[name], errors="coerce")
    for name in ("target_original_net_r", "target_opposite_net_r"):
        result[name] = pd.to_numeric(result[name], errors="coerce")
    if result[["target_original_net_r", "target_opposite_net_r"]].isna().any().any():
        raise ValueError("side-selection dataset contains invalid target returns")
    if result.duplicated(subset=["episode_id", "direction"], keep=False).any():
        raise ValueError("side-selection dataset contains duplicate episode-direction rows")
    sizes = result.groupby("episode_id")["direction"].nunique()
    if not sizes[sizes != 2].empty:
        raise ValueError("side-selection dataset requires paired BUY/SELL rows per episode")
    return result.sort_values(["decision_time", "episode_id", "direction"]).reset_index(drop=True)


def _primary_and_opposite(group: pd.DataFrame) -> tuple[pd.Series, pd.Series]:
    ranked = group.copy()
    ranked["_primary_score"] = pd.to_numeric(ranked["candidate_score"], errors="coerce").fillna(
        -np.inf
    )
    ranked["_secondary_score"] = pd.to_numeric(
        ranked["governance_net_expected_r"], errors="coerce"
    ).fillna(-np.inf)
    ranked["_direction_tie"] = (ranked["direction"] == "BUY").astype(int)
    ranked = ranked.sort_values(
        ["_primary_score", "_secondary_score", "_direction_tie"],
        ascending=[False, False, False],
    )
    return ranked.iloc[0], ranked.iloc[1]


def build_episode_dataset(direction_frame: pd.DataFrame) -> pd.DataFrame:
    source = _normalize_direction_frame(direction_frame)
    rows: list[dict[str, Any]] = []
    for episode_id, group in source.groupby("episode_id", sort=False):
        primary, opposite = _primary_and_opposite(group)
        decision_time = max(primary["decision_time"], opposite["decision_time"])
        resolved_at = max(primary["target_resolved_at"], opposite["target_resolved_at"])
        row: dict[str, Any] = {
            "episode_id": episode_id,
            "decision_time": decision_time,
            "market_bar_time": primary["market_bar_time"],
            "target_resolved_at": resolved_at,
            "instrument": primary["instrument"],
            "policy_version": primary["policy_version"],
            "primary_direction": primary["direction"],
            "label": primary["label"],
            "target_keep_r": float(primary["target_original_net_r"]),
            "target_flip_r": float(primary["target_opposite_net_r"]),
        }
        for name in _PAIR_CATEGORICAL_BASE:
            row[f"primary__{name}"] = str(primary[name])
            row[f"opposite__{name}"] = str(opposite[name])
        for name in BASE_NUMERIC_FEATURES:
            primary_value = _finite(primary[name])
            opposite_value = _finite(opposite[name])
            row[f"primary__{name}"] = primary_value
            row[f"opposite__{name}"] = opposite_value
            row[f"delta__{name}"] = (
                primary_value - opposite_value
                if primary_value is not None and opposite_value is not None
                else None
            )
        rows.append(row)
    return pd.DataFrame(rows).sort_values(["decision_time", "episode_id"]).reset_index(drop=True)


def load_dataset(path: str | Path) -> pd.DataFrame:
    source = Path(path)
    if not source.exists():
        raise ValueError("side-selection dataset path does not exist")
    direction_frame = pd.read_json(source, lines=True)
    if direction_frame.empty:
        raise ValueError("side-selection dataset is empty")
    return build_episode_dataset(direction_frame)


def model_feature_columns(frame: pd.DataFrame | None = None) -> list[str]:
    columns = list(EPISODE_CATEGORICAL_FEATURES) + list(EPISODE_NUMERIC_FEATURES)
    if frame is not None:
        missing = [name for name in columns if name not in frame.columns]
        if missing:
            raise ValueError(f"episode dataset missing model features: {','.join(missing)}")
    return columns


def build_preprocessor() -> ColumnTransformer:
    numeric = Pipeline(
        [("imputer", SimpleImputer(strategy="median", keep_empty_features=True))]
    )
    categorical = Pipeline(
        [
            ("imputer", SimpleImputer(strategy="most_frequent", keep_empty_features=True)),
            ("onehot", OneHotEncoder(handle_unknown="ignore", sparse_output=False, dtype=np.float32)),
        ]
    )
    return ColumnTransformer(
        [
            ("numeric", numeric, list(EPISODE_NUMERIC_FEATURES)),
            ("categorical", categorical, list(EPISODE_CATEGORICAL_FEATURES)),
        ],
        remainder="drop",
        sparse_threshold=0.0,
    )


def operational_labels(
    probabilities: np.ndarray, *, confidence_floor: float = CONFIDENCE_FLOOR
) -> OperationalPredictions:
    probabilities = np.asarray(probabilities, dtype=float)
    if probabilities.ndim != 2 or probabilities.shape[1] != len(LABELS):
        raise ValueError("side-selection probabilities must have shape (n, 3)")
    if not np.isfinite(probabilities).all():
        raise ValueError("side-selection probabilities must be finite")
    if confidence_floor < CONFIDENCE_FLOOR or confidence_floor > 1:
        raise ValueError("confidence floor must remain between 0.60 and 1.00")
    raw_indices = probabilities.argmax(axis=1)
    raw = np.asarray([CLASS_TO_LABEL[int(index)] for index in raw_indices], dtype=object)
    confidence = probabilities.max(axis=1)
    labels = raw.copy()
    labels[confidence < confidence_floor] = "ABSTAIN"
    return OperationalPredictions(labels=labels, confidence=confidence, raw_labels=raw)


def policy_actions(
    frame: pd.DataFrame, predicted_labels: np.ndarray, confidence: np.ndarray
) -> pd.DataFrame:
    if len(frame) != len(predicted_labels) or len(frame) != len(confidence):
        raise ValueError("policy predictions must align with episode rows")
    result = frame[["episode_id", "decision_time", "instrument", "primary_direction"]].copy()
    result["action"] = np.asarray(predicted_labels, dtype=object)
    result["confidence"] = np.asarray(confidence, dtype=float)
    keep_r = frame["target_keep_r"].to_numpy(dtype=float)
    flip_r = frame["target_flip_r"].to_numpy(dtype=float)
    action = result["action"].to_numpy(dtype=object)
    result["realized_r"] = np.where(action == "KEEP", keep_r, np.where(action == "FLIP", flip_r, 0.0))
    result["absolute_side"] = np.where(
        action == "KEEP",
        frame["primary_direction"],
        np.where(
            action == "FLIP",
            np.where(frame["primary_direction"].to_numpy() == "BUY", "SELL", "BUY"),
            "ABSTAIN",
        ),
    )
    return result.reset_index(drop=True)


def split_research_holdout(
    frame: pd.DataFrame,
    *,
    holdout_fraction: float = 0.20,
    min_holdout_rows: int = 250,
) -> tuple[pd.DataFrame, pd.DataFrame, pd.Timestamp]:
    if not 0 < holdout_fraction < 0.5:
        raise ValueError("holdout fraction must be between 0 and 0.5")
    if min_holdout_rows < 1:
        raise ValueError("minimum holdout episodes must be positive")
    normalized = frame.copy()
    normalized["decision_time"] = pd.to_datetime(normalized["decision_time"], utc=True)
    normalized["target_resolved_at"] = pd.to_datetime(normalized["target_resolved_at"], utc=True)
    times = np.asarray(sorted(pd.unique(normalized["decision_time"])))
    if len(times) < 3:
        raise ValueError("side-selection dataset requires at least three decision periods")
    split_index = max(1, min(int(math.floor(len(times) * (1 - holdout_fraction))), len(times) - 1))
    boundary = pd.Timestamp(times[split_index])
    holdout = normalized.loc[normalized["decision_time"] >= boundary].copy()
    if len(holdout) < min_holdout_rows:
        raise ValueError(f"future holdout requires at least {min_holdout_rows} episodes")
    research = normalized.loc[
        (normalized["decision_time"] < boundary)
        & (normalized["target_resolved_at"] < boundary)
    ].copy()
    if research.empty:
        raise ValueError("causal research partition is empty after label-resolution purge")
    return research.reset_index(drop=True), holdout.reset_index(drop=True), boundary


def _xgb_n_jobs() -> int:
    try:
        requested = int(os.getenv("IREXPRO_XGB_N_JOBS", "2"))
    except ValueError:
        requested = 2
    return max(1, min(requested, 4))


def make_model() -> XGBClassifier:
    return XGBClassifier(
        objective="multi:softprob",
        num_class=3,
        eval_metric="mlogloss",
        n_estimators=450,
        learning_rate=0.025,
        max_depth=4,
        min_child_weight=4.0,
        subsample=0.85,
        colsample_bytree=0.80,
        reg_alpha=0.08,
        reg_lambda=1.4,
        random_state=42,
        n_jobs=_xgb_n_jobs(),
        tree_method="hist",
    )


def fit_model(frame: pd.DataFrame) -> FittedSideSelectionModel:
    features = model_feature_columns(frame)
    y = frame["label"].map(LABEL_TO_CLASS).to_numpy(dtype=int)
    if set(np.unique(y)) != {0, 1, 2}:
        raise ValueError("training partition requires KEEP, FLIP and ABSTAIN")
    preprocessor = build_preprocessor()
    matrix = preprocessor.fit_transform(frame[features])
    model = make_model()
    model.fit(matrix, y, sample_weight=compute_sample_weight("balanced", y), verbose=False)
    return FittedSideSelectionModel(preprocessor, model)


def _classification_metrics(
    frame: pd.DataFrame, probabilities: np.ndarray, *, confidence_floor: float
) -> tuple[dict[str, Any], OperationalPredictions]:
    predictions = operational_labels(probabilities, confidence_floor=confidence_floor)
    y_true = frame["label"].to_numpy(dtype=object)
    precision, recall, f1, support = precision_recall_fscore_support(
        y_true, predictions.labels, labels=list(LABELS), zero_division=0
    )
    by_class = {
        label: {
            "precision": float(precision[i]),
            "recall": float(recall[i]),
            "f1": float(f1[i]),
            "support": int(support[i]),
        }
        for i, label in enumerate(LABELS)
    }
    actionable = predictions.labels != "ABSTAIN"
    return (
        {
            "balanced_accuracy": float(balanced_accuracy_score(y_true, predictions.labels)),
            "mean_confidence": float(np.mean(predictions.confidence)),
            "confident_fraction": float(np.mean(predictions.confidence >= confidence_floor)),
            "action_accuracy": float(np.mean(predictions.labels[actionable] == y_true[actionable]))
            if actionable.any()
            else None,
            "by_class": by_class,
        },
        predictions,
    )


def _trading_metrics(actions: pd.DataFrame) -> dict[str, Any]:
    executed = actions.loc[actions["action"] != "ABSTAIN", "realized_r"].to_numpy(dtype=float)
    gross_profit = float(executed[executed > 0].sum()) if len(executed) else 0.0
    gross_loss = float(-executed[executed < 0].sum()) if len(executed) else 0.0
    pf = gross_profit / gross_loss if gross_loss > 0 else None
    sharpe = None
    if len(executed) >= 2:
        sd = float(np.std(executed, ddof=1))
        if sd > 0:
            sharpe = float(math.sqrt(len(executed)) * float(np.mean(executed)) / sd)
    equity = 100.0
    peak = equity
    max_dd = 0.0
    for value in actions["realized_r"].to_numpy(dtype=float):
        equity += float(value)
        peak = max(peak, equity)
        if peak > 0:
            max_dd = max(max_dd, (peak - equity) / peak)
    by_instrument = actions.groupby("instrument")["realized_r"].sum()
    return {
        "episodes": int(len(actions)),
        "actions": int(len(executed)),
        "action_rate": float(len(executed) / len(actions)) if len(actions) else 0.0,
        "wins": int((executed > 0).sum()),
        "losses": int((executed < 0).sum()),
        "total_r": float(executed.sum()) if len(executed) else 0.0,
        "average_r": float(executed.mean()) if len(executed) else 0.0,
        "profit_factor": float(pf) if pf is not None else None,
        "sharpe_ratio": sharpe,
        "max_drawdown": float(max_dd),
        "positive_instrument_fraction": float((by_instrument > 0).mean()) if len(by_instrument) else 0.0,
    }


def _causal_walk_forward_splits(
    frame: pd.DataFrame, *, max_splits: int
) -> Iterator[tuple[pd.DataFrame, pd.DataFrame]]:
    times = np.asarray(sorted(pd.unique(frame["decision_time"])))
    if len(times) < 30:
        return
    minimum_train = max(20, int(math.floor(len(times) * 0.55)))
    validation_size = max(10, int(math.floor(len(times) * 0.12)))
    yielded = 0
    start = minimum_train
    while start < len(times) and yielded < max_splits:
        end = min(len(times), start + validation_size)
        validation_start = pd.Timestamp(times[start])
        validation_end = pd.Timestamp(times[end]) if end < len(times) else None
        train = frame.loc[
            (frame["decision_time"] < validation_start)
            & (frame["target_resolved_at"] < validation_start)
        ].copy()
        mask = frame["decision_time"] >= validation_start
        if validation_end is not None:
            mask &= frame["decision_time"] < validation_end
        valid = frame.loc[mask].copy()
        if not train.empty and not valid.empty and set(train["label"].unique()) == set(LABELS):
            yield train, valid
            yielded += 1
        start = end


def _evaluate_partition(
    fitted: FittedSideSelectionModel, frame: pd.DataFrame, *, confidence_floor: float
) -> dict[str, Any]:
    probs = fitted.predict_proba(frame)
    classification, predictions = _classification_metrics(
        frame, probs, confidence_floor=confidence_floor
    )
    actions = policy_actions(frame, predictions.labels, predictions.confidence)
    return {
        "classification": classification,
        "trading": _trading_metrics(actions),
        "predictions": predictions,
        "probabilities": probs,
        "actions": actions,
    }


def _scorecard(
    classification: dict[str, Any], trading: dict[str, Any], positive_fold_fraction: float
) -> dict[str, Any]:
    checks = {
        "balanced_accuracy": classification["balanced_accuracy"] >= LOCKED_GATE["min_balanced_accuracy"],
        "sharpe_ratio": trading["sharpe_ratio"] is not None
        and trading["sharpe_ratio"] >= LOCKED_GATE["min_sharpe_ratio"],
        "profit_factor": trading["profit_factor"] is not None
        and trading["profit_factor"] >= LOCKED_GATE["min_profit_factor"],
        "max_drawdown": trading["max_drawdown"] <= LOCKED_GATE["max_drawdown"],
        "positive_fold_fraction": positive_fold_fraction >= LOCKED_GATE["min_positive_fold_fraction"],
        "positive_instrument_fraction": trading["positive_instrument_fraction"]
        >= LOCKED_GATE["min_positive_instrument_fraction"],
    }
    return {"checks": checks, "passed": bool(all(checks.values()))}


def evaluate(
    dataset_path: str | Path,
    *,
    confidence_floor: float = CONFIDENCE_FLOOR,
    holdout_fraction: float = 0.20,
    min_holdout_rows: int = 250,
    max_splits: int = 3,
) -> dict[str, Any]:
    if confidence_floor < CONFIDENCE_FLOOR:
        raise ValueError("confidence floor must remain >= 0.60")
    frame = load_dataset(dataset_path)
    base = {
        "artifact": "side-selection-pairwise-three-class-research-v2",
        "mode": "RESEARCH_ONLY",
        "executionAuthority": "NONE",
        "modifiesExecution": False,
        "approvedForDemo": False,
        "approvedForLive": False,
        "confidenceFloor": confidence_floor,
        "episodes": int(len(frame)),
        "classCounts": {k: int(v) for k, v in frame["label"].value_counts().items()},
        "featureCount": len(model_feature_columns(frame)),
        "lockedGate": LOCKED_GATE,
    }
    try:
        research, holdout, boundary = split_research_holdout(
            frame, holdout_fraction=holdout_fraction, min_holdout_rows=min_holdout_rows
        )
    except ValueError as error:
        return {
            **base,
            "evidenceSufficient": False,
            "evidenceReason": str(error),
            "qualification": None,
            "futureHoldout": None,
            "researchCandidate": False,
        }

    folds: list[dict[str, Any]] = []
    validation_frames: list[pd.DataFrame] = []
    validation_probs: list[np.ndarray] = []
    for fold, (train, valid) in enumerate(
        _causal_walk_forward_splits(research, max_splits=max_splits), start=1
    ):
        fitted = fit_model(train)
        result = _evaluate_partition(fitted, valid, confidence_floor=confidence_floor)
        validation_frames.append(valid.copy())
        validation_probs.append(result["probabilities"])
        folds.append(
            {
                "fold": fold,
                "trainEpisodes": int(len(train)),
                "validationEpisodes": int(len(valid)),
                "classification": result["classification"],
                "trading": result["trading"],
            }
        )
    if not folds:
        return {
            **base,
            "evidenceSufficient": False,
            "evidenceReason": "no causal walk-forward folds with all three training classes",
            "qualification": None,
            "futureHoldout": None,
            "researchCandidate": False,
        }

    qframe = pd.concat(validation_frames, ignore_index=True)
    qprobs = np.vstack(validation_probs)
    qclassification, qpred = _classification_metrics(
        qframe, qprobs, confidence_floor=confidence_floor
    )
    qactions = policy_actions(qframe, qpred.labels, qpred.confidence)
    qtrading = _trading_metrics(qactions)
    positive_fold_fraction = float(np.mean([fold["trading"]["total_r"] > 0 for fold in folds]))
    scorecard = _scorecard(qclassification, qtrading, positive_fold_fraction)

    final = fit_model(research)
    future = _evaluate_partition(final, holdout, confidence_floor=confidence_floor)
    future_checks = {
        "balanced_accuracy": future["classification"]["balanced_accuracy"] >= LOCKED_GATE["min_balanced_accuracy"],
        "sharpe_ratio": future["trading"]["sharpe_ratio"] is not None
        and future["trading"]["sharpe_ratio"] >= LOCKED_GATE["min_sharpe_ratio"],
        "profit_factor": future["trading"]["profit_factor"] is not None
        and future["trading"]["profit_factor"] >= LOCKED_GATE["min_profit_factor"],
        "max_drawdown": future["trading"]["max_drawdown"] <= LOCKED_GATE["max_drawdown"],
        "positive_instrument_fraction": future["trading"]["positive_instrument_fraction"]
        >= LOCKED_GATE["min_positive_instrument_fraction"],
    }
    future_passed = bool(all(future_checks.values()))
    return {
        **base,
        "evidenceSufficient": True,
        "holdoutBoundary": boundary.isoformat(),
        "researchEpisodes": int(len(research)),
        "holdoutEpisodes": int(len(holdout)),
        "qualification": {
            "folds": folds,
            "classification": qclassification,
            "trading": qtrading,
            "positiveFoldFraction": positive_fold_fraction,
            "scorecard": scorecard,
        },
        "futureHoldout": {
            "classification": future["classification"],
            "trading": future["trading"],
            "checks": future_checks,
            "passed": future_passed,
        },
        "researchCandidate": bool(scorecard["passed"] and future_passed),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--report", required=True)
    parser.add_argument("--confidence-floor", type=float, default=CONFIDENCE_FLOOR)
    parser.add_argument("--holdout-fraction", type=float, default=0.20)
    parser.add_argument("--min-holdout-rows", type=int, default=250)
    parser.add_argument("--max-splits", type=int, default=3)
    args = parser.parse_args()
    report = evaluate(
        args.dataset,
        confidence_floor=args.confidence_floor,
        holdout_fraction=args.holdout_fraction,
        min_holdout_rows=args.min_holdout_rows,
        max_splits=args.max_splits,
    )
    output = Path(args.report)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2, sort_keys=True), encoding="utf-8")
    print(json.dumps(report, sort_keys=True))


if __name__ == "__main__":
    main()
