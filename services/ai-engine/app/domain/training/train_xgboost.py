"""
Offline XGBoost training pipeline for iRexPro.

Run manually, for example:
    python -m app.domain.training.train_xgboost \
        --dataset path/to/EURUSD_H1.csv \
        --model-version xgboost-eurusd-h1-v1 \
        --instrument EURUSD \
        --timeframe H1

This module trains a real XGBoost classifier from historical OHLCV data. It
never runs at application startup and never grants live-trading approval.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import xgboost as xgb
from xgboost import XGBClassifier

from app.domain.models.feature_engineering import FEATURE_COLUMNS
from app.domain.training.dataset_builder import (
    TARGET_COLUMN,
    build_supervised_dataset,
    load_ohlcv_csv,
)
from app.domain.training.validation import (
    compute_classification_metrics,
    time_ordered_split,
)
from app.domain.training.walk_forward import evaluate_walk_forward


def _safe_model_version(model_version: str) -> str:
    safe = re.sub(r"[^A-Za-z0-9._-]+", "_", model_version).strip("._")
    while ".." in safe:
        safe = safe.replace("..", "_")
    if not safe:
        raise ValueError("model_version must contain at least one safe character")
    return safe


def default_model_artifact_path(
    model_version: str,
    output_dir: str | Path = "models",
) -> Path:
    """Generate a traversal-safe XGBoost artifact path."""
    return Path(output_dir) / f"{_safe_model_version(model_version)}.json"


def default_model_metadata_path(
    model_version: str,
    output_dir: str | Path = "models",
) -> Path:
    """Generate the sidecar metadata path for a model artifact."""
    return Path(output_dir) / f"{_safe_model_version(model_version)}.metadata.json"


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _feature_schema_hash() -> str:
    payload = json.dumps(FEATURE_COLUMNS, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _time_range(frame) -> dict[str, str]:
    return {
        "start": frame["timestamp"].iloc[0].isoformat(),
        "end": frame["timestamp"].iloc[-1].isoformat(),
    }


def train_offline(
    dataset_path: str,
    model_version: str = "offline-xgboost-research",
    *,
    instrument: str = "UNKNOWN",
    timeframe: str = "H1",
    horizon_bars: int = 3,
    neutral_return_threshold: float = 0.0002,
    train_ratio: float = 0.8,
    output_dir: str | Path = "models",
    training_data_source: str = "operator_supplied_historical_ohlcv",
    approve_for_paper: bool = False,
    min_samples: int = 250,
    walk_forward_min_train_size: int | None = None,
    walk_forward_validation_size: int | None = None,
    minimum_walk_forward_windows: int = 3,
) -> dict[str, Any]:
    """
    Train and persist a real XGBoost binary direction classifier.

    Paper approval is explicit and opt-in. Live approval is always false.
    Metrics describe held-out directional classification only; they are not
    claims of profitability or live-trading performance.
    """
    source_path = Path(dataset_path)
    df = load_ohlcv_csv(source_path)
    supervised = build_supervised_dataset(
        df,
        horizon_bars=horizon_bars,
        neutral_return_threshold=neutral_return_threshold,
    )

    if len(supervised) < min_samples:
        raise ValueError(
            f"Insufficient supervised samples: {len(supervised)}; "
            f"at least {min_samples} required"
        )

    walk_forward = evaluate_walk_forward(
        supervised,
        purge_gap=horizon_bars,
        min_train_size=walk_forward_min_train_size,
        validation_size=walk_forward_validation_size,
        minimum_windows=minimum_walk_forward_windows,
    )
    paper_eligibility = walk_forward["paper_evaluation_eligibility"]
    if approve_for_paper and not paper_eligibility["eligible_for_paper_evaluation"]:
        reasons = "; ".join(str(reason) for reason in paper_eligibility["reasons"])
        raise ValueError(
            "Paper evaluation approval requested but walk-forward evidence is "
            f"insufficient: {reasons}"
        )

    train_df, val_df = time_ordered_split(
        supervised,
        train_ratio=train_ratio,
        purge_gap=horizon_bars,
    )

    if train_df[TARGET_COLUMN].nunique() < 2:
        raise ValueError("Training split must contain both directional classes")
    if val_df[TARGET_COLUMN].nunique() < 2:
        raise ValueError("Validation split must contain both directional classes")

    x_train = train_df[FEATURE_COLUMNS]
    y_train = train_df[TARGET_COLUMN].astype(int)
    x_val = val_df[FEATURE_COLUMNS]
    y_val = val_df[TARGET_COLUMN].astype(int)

    model = XGBClassifier(
        objective="binary:logistic",
        eval_metric="logloss",
        n_estimators=500,
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
        early_stopping_rounds=40,
    )
    model.fit(
        x_train,
        y_train,
        eval_set=[(x_val, y_val)],
        verbose=False,
    )

    positive_probabilities = model.predict_proba(x_val)[:, 1]
    metrics = compute_classification_metrics(y_val, positive_probabilities)

    artifact_path = default_model_artifact_path(model_version, output_dir)
    metadata_path = default_model_metadata_path(model_version, output_dir)
    artifact_path.parent.mkdir(parents=True, exist_ok=True)

    model.save_model(str(artifact_path))
    artifact_sha256 = _sha256_file(artifact_path)
    dataset_sha256 = _sha256_file(source_path)

    metadata: dict[str, Any] = {
        "metadata_version": 1,
        "model_version": model_version,
        "model_type": "xgboost_binary_direction_classifier",
        "xgboost_version": xgb.__version__,
        "trained_at": datetime.now(UTC).isoformat(),
        "instrument": instrument.upper(),
        "timeframe": timeframe.upper(),
        "training_data_source": training_data_source,
        "dataset_sha256": dataset_sha256,
        "artifact_sha256": artifact_sha256,
        "feature_columns": FEATURE_COLUMNS,
        "feature_schema_hash": _feature_schema_hash(),
        "label_spec": {
            "type": "forward_return_direction",
            "horizon_bars": horizon_bars,
            "neutral_return_threshold": neutral_return_threshold,
            "positive_class": "future_return_positive",
            "negative_class": "future_return_negative",
        },
        "row_counts": {
            "raw_ohlcv": len(df),
            "supervised": len(supervised),
            "train": len(train_df),
            "validation": len(val_df),
        },
        "time_ranges": {
            "train": _time_range(train_df),
            "validation": _time_range(val_df),
        },
        "validation_status": "walk_forward_and_holdout_validation_complete",
        "validation_metrics": metrics,
        "walk_forward_validation": walk_forward,
        "approved_for_paper": bool(approve_for_paper),
        "approved_for_sandbox": False,
        "approved_for_live": False,
        "confidence_semantics": (
            "Predicted class probability from the fitted XGBoost classifier. "
            "It is not a probability of profit and is not independently calibrated."
        ),
        "notes": (
            "Offline trained model. Live approval is intentionally unavailable. "
            "Paper approval requires the explicit --approve-for-paper operator flag."
        ),
    }

    metadata_path.write_text(
        json.dumps(metadata, indent=2, sort_keys=True),
        encoding="utf-8",
    )

    return {
        "model_version": model_version,
        "artifact_path": str(artifact_path),
        "metadata_path": str(metadata_path),
        "artifact_sha256": artifact_sha256,
        "dataset_sha256": dataset_sha256,
        "train_rows": len(train_df),
        "validation_rows": len(val_df),
        "metrics": metrics,
        "walk_forward_validation": walk_forward,
        "approved_for_paper": bool(approve_for_paper),
        "approved_for_live": False,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Train an offline XGBoost direction model")
    parser.add_argument("--dataset", required=True, help="Historical OHLCV CSV")
    parser.add_argument("--model-version", required=True)
    parser.add_argument("--instrument", required=True)
    parser.add_argument("--timeframe", default="H1")
    parser.add_argument("--horizon-bars", type=int, default=3)
    parser.add_argument("--neutral-return-threshold", type=float, default=0.0002)
    parser.add_argument("--train-ratio", type=float, default=0.8)
    parser.add_argument("--output-dir", default="models")
    parser.add_argument(
        "--training-data-source",
        default="operator_supplied_historical_ohlcv",
    )
    parser.add_argument(
        "--approve-for-paper",
        action="store_true",
        help=(
            "Request paper-evaluation eligibility. This fails closed unless "
            "multi-window walk-forward validation evidence is structurally complete."
        ),
    )
    parser.add_argument("--walk-forward-min-train-size", type=int)
    parser.add_argument("--walk-forward-validation-size", type=int)
    parser.add_argument("--minimum-walk-forward-windows", type=int, default=3)
    args = parser.parse_args()

    result = train_offline(
        args.dataset,
        args.model_version,
        instrument=args.instrument,
        timeframe=args.timeframe,
        horizon_bars=args.horizon_bars,
        neutral_return_threshold=args.neutral_return_threshold,
        train_ratio=args.train_ratio,
        output_dir=args.output_dir,
        training_data_source=args.training_data_source,
        approve_for_paper=args.approve_for_paper,
        walk_forward_min_train_size=args.walk_forward_min_train_size,
        walk_forward_validation_size=args.walk_forward_validation_size,
        minimum_walk_forward_windows=args.minimum_walk_forward_windows,
    )
    print(json.dumps(result, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
