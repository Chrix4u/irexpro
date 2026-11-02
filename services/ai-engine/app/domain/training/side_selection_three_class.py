"""Research-only KEEP / FLIP / ABSTAIN side-selection model.

All predictors are persisted pre-entry fields. Resolved shadow outcomes are used
only as targets/evaluation data. This module never grants execution authority.
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

CATEGORICAL_FEATURES = (
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
)

NUMERIC_FEATURES = (
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
)

TARGET_ONLY_COLUMNS = (
    "label",
    "target_resolved_at",
    "target_original_net_r",
    "target_opposite_net_r",
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
        transformed = self.preprocessor.transform(frame[features])
        probabilities = np.asarray(self.model.predict_proba(transformed), dtype=float)
        if probabilities.shape != (len(frame), len(LABELS)):
            raise ValueError("side-selection model returned unexpected probability shape")
        return probabilities


def model_feature_columns(frame: pd.DataFrame | None = None) -> list[str]:
    columns = list(CATEGORICAL_FEATURES) + list(NUMERIC_FEATURES)
    if frame is not None:
        missing = [name for name in columns if name not in frame.columns]
        if missing:
            raise ValueError(f"side-selection dataset missing features: {','.join(missing)}")
    return columns


def build_preprocessor() -> ColumnTransformer:
    numeric = Pipeline(
        steps=[
            ("imputer", SimpleImputer(strategy="median", keep_empty_features=True)),
        ]
    )
    categorical = Pipeline(
        steps=[
            ("imputer", SimpleImputer(strategy="most_frequent", keep_empty_features=True)),
            (
                "onehot",
                OneHotEncoder(handle_unknown="ignore", sparse_output=False, dtype=np.float32),
            ),
        ]
    )
    return ColumnTransformer(
        transformers=[
            ("numeric", numeric, list(NUMERIC_FEATURES)),
            ("categorical", categorical, list(CATEGORICAL_FEATURES)),
        ],
        remainder="drop",
        sparse_threshold=0.0,
    )


def operational_labels(
    probabilities: np.ndarray,
    *,
    confidence_floor: float = CONFIDENCE_FLOOR,
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
    gated = raw.copy()
    gated[confidence < confidence_floor] = "ABSTAIN"
    return OperationalPredictions(labels=gated, confidence=confidence, raw_labels=raw)


def _normalize_frame(frame: pd.DataFrame) -> pd.DataFrame:
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
    missing_required = sorted(required - set(frame.columns))
    if missing_required:
        raise ValueError(f"side-selection dataset missing required columns: {','.join(missing_required)}")

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

    for name in CATEGORICAL_FEATURES:
        if name not in result:
            result[name] = "UNKNOWN"
        result[name] = result[name].fillna("UNKNOWN").astype(str)
    for name in NUMERIC_FEATURES:
        if name not in result:
            result[name] = np.nan
        result[name] = pd.to_numeric(result[name], errors="coerce")
    for name in ("target_original_net_r", "target_opposite_net_r"):
        result[name] = pd.to_numeric(result[name], errors="coerce")
    if result[["target_original_net_r", "target_opposite_net_r"]].isna().any().any():
        raise ValueError("side-selection dataset contains invalid target returns")

    duplicates = result.duplicated(subset=["episode_id", "direction"], keep=False)
    if duplicates.any():
        raise ValueError("side-selection dataset contains duplicate episode-direction rows")
    episode_sizes = result.groupby("episode_id")["direction"].nunique()
    invalid_episodes = episode_sizes[episode_sizes != 2]
    if not invalid_episodes.empty:
        raise ValueError("side-selection dataset requires paired BUY/SELL rows per episode")

    return result.sort_values(["decision_time", "episode_id", "direction"]).reset_index(drop=True)


def load_dataset(path: str | Path) -> pd.DataFrame:
    source = Path(path)
    if not source.exists():
        raise ValueError("side-selection dataset path does not exist")
    frame = pd.read_json(source, lines=True)
    if frame.empty:
        raise ValueError("side-selection dataset is empty")
    return _normalize_frame(frame)


def split_research_holdout(
    frame: pd.DataFrame,
    *,
    holdout_fraction: float = 0.20,
    min_holdout_rows: int = 250,
) -> tuple[pd.DataFrame, pd.DataFrame, pd.Timestamp]:
    if not 0 < holdout_fraction < 0.5:
        raise ValueError("holdout fraction must be between 0 and 0.5")
    if min_holdout_rows < 1:
        raise ValueError("minimum holdout rows must be positive")
    normalized = frame.copy()
    normalized["decision_time"] = pd.to_datetime(normalized["decision_time"], utc=True)
    normalized["target_resolved_at"] = pd.to_datetime(normalized["target_resolved_at"], utc=True)
    times = np.asarray(sorted(pd.unique(normalized["decision_time"])))
    if len(times) < 3:
        raise ValueError("side-selection dataset requires at least three decision periods")
    split_index = int(math.floor(len(times) * (1.0 - holdout_fraction)))
    split_index = max(1, min(split_index, len(times) - 1))
    boundary = pd.Timestamp(times[split_index])
    holdout = normalized.loc[normalized["decision_time"] >= boundary].copy()
    if len(holdout) < min_holdout_rows:
        raise ValueError(f"future holdout requires at least {min_holdout_rows} rows")
    research = normalized.loc[
        (normalized["decision_time"] < boundary)
        & (normalized["target_resolved_at"] < boundary)
    ].copy()
    if research.empty:
        raise ValueError("causal research partition is empty after label-resolution purge")
    return (
        research.sort_values(["decision_time", "episode_id", "direction"]).reset_index(drop=True),
        holdout.sort_values(["decision_time", "episode_id", "direction"]).reset_index(drop=True),
        boundary,
    )


def _relative_to_absolute(direction: str, label: str) -> str | None:
    if label == "ABSTAIN":
        return None
    if label == "KEEP":
        return direction
    if label == "FLIP":
        return "SELL" if direction == "BUY" else "BUY"
    raise ValueError(f"invalid operational label: {label}")


def episode_policy_actions(
    frame: pd.DataFrame,
    predicted_labels: np.ndarray,
    confidence: np.ndarray,
) -> pd.DataFrame:
    if len(frame) != len(predicted_labels) or len(frame) != len(confidence):
        raise ValueError("episode policy predictions must align with dataset rows")
    working = frame.copy().reset_index(drop=True)
    working["predicted_label"] = np.asarray(predicted_labels, dtype=object)
    working["prediction_confidence"] = np.asarray(confidence, dtype=float)
    rows: list[dict[str, Any]] = []
    for episode_id, group in working.groupby("episode_id", sort=False):
        recommendations: list[tuple[str, float]] = []
        for item in group.itertuples(index=False):
            recommendation = _relative_to_absolute(item.direction, item.predicted_label)
            if recommendation is not None:
                recommendations.append((recommendation, float(item.prediction_confidence)))
        sides = {side for side, _ in recommendations}
        action = next(iter(sides)) if len(sides) == 1 else "ABSTAIN"
        if action == "ABSTAIN":
            action_confidence = 0.0
            realized_r = 0.0
        else:
            action_confidence = min(conf for side, conf in recommendations if side == action)
            direct = group.loc[group["direction"] == action]
            if not direct.empty:
                realized_r = float(direct.iloc[0]["target_original_net_r"])
            else:
                opposite = group.iloc[0]
                realized_r = float(opposite["target_opposite_net_r"])
        first = group.iloc[0]
        rows.append(
            {
                "episode_id": episode_id,
                "decision_time": first["decision_time"],
                "instrument": first["instrument"],
                "action": action,
                "confidence": action_confidence,
                "realized_r": realized_r,
            }
        )
    return pd.DataFrame(rows).sort_values(["decision_time", "episode_id"]).reset_index(drop=True)


def _xgb_n_jobs() -> int:
    try:
        requested = int(os.getenv("IREXPRO_XGB_N_JOBS", "2"))
    except ValueError:
        requested = 2
    return max(1, min(requested, 4))


def make_model() -> XGBClassifier:
    return XGBClassifier(
        objective="multi:softprob",
        num_class=len(LABELS),
        eval_metric="mlogloss",
        n_estimators=350,
        learning_rate=0.03,
        max_depth=4,
        min_child_weight=3.0,
        subsample=0.85,
        colsample_bytree=0.85,
        reg_alpha=0.05,
        reg_lambda=1.2,
        random_state=42,
        n_jobs=_xgb_n_jobs(),
        tree_method="hist",
    )


def fit_model(frame: pd.DataFrame) -> FittedSideSelectionModel:
    features = model_feature_columns(frame)
    y = frame["label"].map(LABEL_TO_CLASS).to_numpy(dtype=int)
    if set(np.unique(y)) != {0, 1, 2}:
        raise ValueError("side-selection training partition requires KEEP, FLIP and ABSTAIN")
    preprocessor = build_preprocessor()
    matrix = preprocessor.fit_transform(frame[features])
    model = make_model()
    weights = compute_sample_weight(class_weight="balanced", y=y)
    model.fit(matrix, y, sample_weight=weights, verbose=False)
    return FittedSideSelectionModel(preprocessor=preprocessor, model=model)


def _classification_metrics(
    frame: pd.DataFrame,
    probabilities: np.ndarray,
    *,
    confidence_floor: float,
) -> tuple[dict[str, Any], OperationalPredictions]:
    predictions = operational_labels(probabilities, confidence_floor=confidence_floor)
    y_true = frame["label"].to_numpy(dtype=object)
    balanced = balanced_accuracy_score(y_true, predictions.labels)
    precision, recall, f1, support = precision_recall_fscore_support(
        y_true,
        predictions.labels,
        labels=list(LABELS),
        zero_division=0,
    )
    by_class = {
        label: {
            "precision": float(precision[index]),
            "recall": float(recall[index]),
            "f1": float(f1[index]),
            "support": int(support[index]),
        }
        for index, label in enumerate(LABELS)
    }
    actionable = predictions.labels != "ABSTAIN"
    action_accuracy = (
        float(np.mean(predictions.labels[actionable] == y_true[actionable]))
        if actionable.any()
        else None
    )
    return (
        {
            "balanced_accuracy": float(balanced),
            "mean_confidence": float(np.mean(predictions.confidence)),
            "confident_fraction": float(np.mean(predictions.confidence >= confidence_floor)),
            "action_accuracy": action_accuracy,
            "by_class": by_class,
        },
        predictions,
    )


def _trading_metrics(actions: pd.DataFrame) -> dict[str, Any]:
    executed = actions.loc[actions["action"] != "ABSTAIN", "realized_r"].to_numpy(dtype=float)
    gross_profit = float(executed[executed > 0].sum()) if len(executed) else 0.0
    gross_loss = float(-executed[executed < 0].sum()) if len(executed) else 0.0
    profit_factor = gross_profit / gross_loss if gross_loss > 0 else None
    sharpe = None
    if len(executed) >= 2:
        sd = float(np.std(executed, ddof=1))
        if sd > 0:
            sharpe = float(math.sqrt(len(executed)) * float(np.mean(executed)) / sd)

    equity = 100.0
    peak = equity
    max_drawdown = 0.0
    for value in actions["realized_r"].to_numpy(dtype=float):
        equity += float(value)
        peak = max(peak, equity)
        if peak > 0:
            max_drawdown = max(max_drawdown, (peak - equity) / peak)

    by_instrument = actions.groupby("instrument", dropna=False)["realized_r"].sum()
    positive_instrument_fraction = (
        float((by_instrument > 0).mean()) if len(by_instrument) else 0.0
    )
    return {
        "episodes": int(len(actions)),
        "actions": int(len(executed)),
        "action_rate": float(len(executed) / len(actions)) if len(actions) else 0.0,
        "wins": int((executed > 0).sum()),
        "losses": int((executed < 0).sum()),
        "total_r": float(executed.sum()) if len(executed) else 0.0,
        "average_r": float(executed.mean()) if len(executed) else 0.0,
        "profit_factor": float(profit_factor) if profit_factor is not None else None,
        "sharpe_ratio": sharpe,
        "max_drawdown": float(max_drawdown),
        "positive_instrument_fraction": positive_instrument_fraction,
    }


def _causal_walk_forward_splits(
    frame: pd.DataFrame,
    *,
    max_splits: int,
) -> Iterator[tuple[pd.DataFrame, pd.DataFrame]]:
    times = np.asarray(sorted(pd.unique(frame["decision_time"])))
    if len(times) < 20:
        return
    minimum_train = max(10, int(math.floor(len(times) * 0.55)))
    validation_size = max(5, int(math.floor(len(times) * 0.12)))
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
        valid_mask = frame["decision_time"] >= validation_start
        if validation_end is not None:
            valid_mask &= frame["decision_time"] < validation_end
        valid = frame.loc[valid_mask].copy()
        if not train.empty and not valid.empty and set(train["label"].unique()) == set(LABELS):
            yield train, valid
            yielded += 1
        start = end


def _scorecard(
    *,
    classification: dict[str, Any],
    trading: dict[str, Any],
    positive_fold_fraction: float,
) -> dict[str, Any]:
    profit_factor = trading["profit_factor"]
    sharpe = trading["sharpe_ratio"]
    checks = {
        "balanced_accuracy": classification["balanced_accuracy"] >= LOCKED_GATE["min_balanced_accuracy"],
        "sharpe_ratio": sharpe is not None and sharpe >= LOCKED_GATE["min_sharpe_ratio"],
        "profit_factor": profit_factor is not None and profit_factor >= LOCKED_GATE["min_profit_factor"],
        "max_drawdown": trading["max_drawdown"] <= LOCKED_GATE["max_drawdown"],
        "positive_fold_fraction": positive_fold_fraction >= LOCKED_GATE["min_positive_fold_fraction"],
        "positive_instrument_fraction": trading["positive_instrument_fraction"]
        >= LOCKED_GATE["min_positive_instrument_fraction"],
    }
    return {"checks": checks, "passed": bool(all(checks.values()))}


def _evaluate_partition(
    model: FittedSideSelectionModel,
    frame: pd.DataFrame,
    *,
    confidence_floor: float,
) -> dict[str, Any]:
    probabilities = model.predict_proba(frame)
    classification, predictions = _classification_metrics(
        frame,
        probabilities,
        confidence_floor=confidence_floor,
    )
    actions = episode_policy_actions(frame, predictions.labels, predictions.confidence)
    trading = _trading_metrics(actions)
    return {
        "classification": classification,
        "trading": trading,
        "actions": actions,
        "predictions": predictions,
        "probabilities": probabilities,
    }


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
    base: dict[str, Any] = {
        "artifact": "side-selection-three-class-research-v1",
        "mode": "RESEARCH_ONLY",
        "executionAuthority": "NONE",
        "modifiesExecution": False,
        "approvedForDemo": False,
        "approvedForLive": False,
        "confidenceFloor": confidence_floor,
        "rows": int(len(frame)),
        "episodes": int(frame["episode_id"].nunique()),
        "classCounts": {key: int(value) for key, value in frame["label"].value_counts().items()},
        "featureCount": len(model_feature_columns(frame)),
        "lockedGate": LOCKED_GATE,
    }
    try:
        research, holdout, boundary = split_research_holdout(
            frame,
            holdout_fraction=holdout_fraction,
            min_holdout_rows=min_holdout_rows,
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

    fold_reports: list[dict[str, Any]] = []
    qualification_frames: list[pd.DataFrame] = []
    qualification_probabilities: list[np.ndarray] = []
    for fold, (train, valid) in enumerate(
        _causal_walk_forward_splits(research, max_splits=max_splits), start=1
    ):
        fitted = fit_model(train)
        result = _evaluate_partition(fitted, valid, confidence_floor=confidence_floor)
        prediction_frame = valid.copy()
        prediction_frame["_predicted_label"] = result["predictions"].labels
        prediction_frame["_prediction_confidence"] = result["predictions"].confidence
        qualification_frames.append(prediction_frame)
        qualification_probabilities.append(result["probabilities"])
        fold_reports.append(
            {
                "fold": fold,
                "trainRows": int(len(train)),
                "validationRows": int(len(valid)),
                "classification": result["classification"],
                "trading": result["trading"],
            }
        )

    if not fold_reports:
        return {
            **base,
            "evidenceSufficient": False,
            "evidenceReason": "no causal walk-forward folds with all three training classes",
            "qualification": None,
            "futureHoldout": None,
            "researchCandidate": False,
        }

    qualification_frame = pd.concat(qualification_frames, ignore_index=True)
    qualification_probs = np.vstack(qualification_probabilities)
    qualification_classification, qualification_predictions = _classification_metrics(
        qualification_frame,
        qualification_probs,
        confidence_floor=confidence_floor,
    )
    qualification_actions = episode_policy_actions(
        qualification_frame,
        qualification_predictions.labels,
        qualification_predictions.confidence,
    )
    qualification_trading = _trading_metrics(qualification_actions)
    positive_fold_fraction = float(
        np.mean([fold["trading"]["total_r"] > 0 for fold in fold_reports])
    )
    qualification_scorecard = _scorecard(
        classification=qualification_classification,
        trading=qualification_trading,
        positive_fold_fraction=positive_fold_fraction,
    )

    final_model = fit_model(research)
    future = _evaluate_partition(final_model, holdout, confidence_floor=confidence_floor)
    future_checks = {
        "balanced_accuracy": future["classification"]["balanced_accuracy"]
        >= LOCKED_GATE["min_balanced_accuracy"],
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
        "researchRows": int(len(research)),
        "holdoutRows": int(len(holdout)),
        "qualification": {
            "folds": fold_reports,
            "classification": qualification_classification,
            "trading": qualification_trading,
            "positiveFoldFraction": positive_fold_fraction,
            "scorecard": qualification_scorecard,
        },
        "futureHoldout": {
            "classification": future["classification"],
            "trading": future["trading"],
            "checks": future_checks,
            "passed": future_passed,
        },
        "researchCandidate": bool(qualification_scorecard["passed"] and future_passed),
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
