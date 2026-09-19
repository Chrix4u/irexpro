"""Walk-forward validation for fitted XGBoost direction candidates."""
from __future__ import annotations

from typing import Any

from xgboost import XGBClassifier

from app.domain.models.feature_engineering import FEATURE_COLUMNS
from app.domain.training.dataset_builder import TARGET_COLUMN
from app.domain.training.validation import (
    compute_classification_metrics,
    paper_evaluation_eligibility,
    summarize_walk_forward_metrics,
    walk_forward_splits,
)


def _fixed_validation_model() -> XGBClassifier:
    """
    Build the fixed-parameter model used only for walk-forward evaluation.

    Early stopping is deliberately disabled here so each validation window is
    not also used to choose its own training length.
    """
    return XGBClassifier(
        objective="binary:logistic",
        eval_metric="logloss",
        n_estimators=300,
        learning_rate=0.03,
        max_depth=4,
        min_child_weight=2.0,
        subsample=0.85,
        colsample_bytree=0.85,
        reg_alpha=0.05,
        reg_lambda=1.0,
        random_state=42,
        n_jobs=1,
        tree_method="hist",
    )


def _time_range(frame) -> dict[str, str]:
    return {
        "start": frame["timestamp"].iloc[0].isoformat(),
        "end": frame["timestamp"].iloc[-1].isoformat(),
    }


def evaluate_walk_forward(
    supervised,
    *,
    purge_gap: int,
    min_train_size: int | None = None,
    validation_size: int | None = None,
    minimum_windows: int = 3,
) -> dict[str, Any]:
    """
    Evaluate a candidate across expanding chronological validation windows.

    Defaults scale with dataset size but retain practical lower bounds so tiny
    research fixtures cannot accidentally be treated like production evidence.
    """
    row_count = len(supervised)
    resolved_validation_size = validation_size or max(50, row_count // 10)
    resolved_min_train_size = min_train_size or max(200, row_count // 2)

    folds = walk_forward_splits(
        supervised,
        min_train_size=resolved_min_train_size,
        validation_size=resolved_validation_size,
        purge_gap=purge_gap,
        step_size=resolved_validation_size,
    )

    windows: list[dict[str, Any]] = []
    metrics_only: list[dict[str, float | None]] = []

    for index, (train_df, validation_df) in enumerate(folds, start=1):
        if train_df[TARGET_COLUMN].nunique() < 2:
            raise ValueError(
                f"Walk-forward training window {index} does not contain both target classes"
            )

        model = _fixed_validation_model()
        model.fit(
            train_df[FEATURE_COLUMNS],
            train_df[TARGET_COLUMN].astype(int),
            verbose=False,
        )

        probabilities = model.predict_proba(validation_df[FEATURE_COLUMNS])[:, 1]
        metrics = compute_classification_metrics(
            validation_df[TARGET_COLUMN].astype(int),
            probabilities,
        )
        metrics_only.append(metrics)
        windows.append(
            {
                "window": index,
                "train_rows": len(train_df),
                "validation_rows": len(validation_df),
                "train_range": _time_range(train_df),
                "validation_range": _time_range(validation_df),
                "metrics": metrics,
            }
        )

    summary = summarize_walk_forward_metrics(metrics_only)
    eligibility = paper_evaluation_eligibility(
        window_metrics=metrics_only,
        minimum_windows=minimum_windows,
    )

    return {
        "configuration": {
            "min_train_size": resolved_min_train_size,
            "validation_size": resolved_validation_size,
            "purge_gap": purge_gap,
            "step_size": resolved_validation_size,
            "minimum_windows": minimum_windows,
            "early_stopping_used": False,
        },
        "windows": windows,
        "summary": summary,
        "paper_evaluation_eligibility": eligibility,
    }
