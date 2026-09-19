"""Tests for the real offline XGBoost training pipeline."""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd

from app.domain.models.baseline_xgboost import (
    MODEL_METADATA_PATH_ENV,
    MODEL_PATH_ENV,
    BaselineXGBoostModel,
)
from app.domain.models.feature_engineering import FEATURE_COLUMNS, compute_features
from app.domain.models.registry import MODEL_BUNDLE_PATH_ENV, build_default_registry
from app.domain.training.dataset_builder import (
    build_supervised_dataset,
    detect_future_leakage,
)
from app.domain.training.train_xgboost import (
    default_model_artifact_path,
    default_model_metadata_path,
    train_offline,
)
from app.domain.training.validation import time_ordered_split


def _write_training_fixture(path: Path, rows: int = 600) -> pd.DataFrame:
    index = np.arange(rows, dtype=float)
    close = 1.10 + 0.008 * np.sin(index / 7.0) + 0.003 * np.sin(index / 19.0)
    open_ = close + 0.0004 * np.sin(index / 3.0)
    high = np.maximum(open_, close) + 0.0008
    low = np.minimum(open_, close) - 0.0008
    volume = 1000.0 + 150.0 * (1.0 + np.sin(index / 11.0))

    frame = pd.DataFrame(
        {
            "timestamp": pd.date_range("2024-01-01", periods=rows, freq="h", tz="UTC"),
            "open": open_,
            "high": high,
            "low": low,
            "close": close,
            "volume": volume,
        }
    )
    frame.to_csv(path, index=False)
    return frame


def test_time_ordered_split_with_purge_gap():
    df = pd.DataFrame({"value": list(range(20))})
    train, val = time_ordered_split(df, train_ratio=0.8, purge_gap=3)
    assert train["value"].tolist() == list(range(13))
    assert val["value"].tolist() == list(range(16, 20))


def test_rejects_dataset_with_leakage_indicators():
    feature_df = pd.DataFrame({"target_index": [2, 1, 0]})
    assert detect_future_leakage(feature_df) is True


def test_supervised_targets_are_future_only_and_features_exclude_target():
    rows = 80
    index = np.arange(rows, dtype=float)
    frame = pd.DataFrame(
        {
            "timestamp": pd.date_range("2025-01-01", periods=rows, freq="h", tz="UTC"),
            "open": 1.0 + index * 0.001,
            "high": 1.002 + index * 0.001,
            "low": 0.998 + index * 0.001,
            "close": 1.0 + index * 0.001,
            "volume": 100.0 + index,
        }
    )

    supervised = build_supervised_dataset(
        frame,
        horizon_bars=2,
        neutral_return_threshold=0.0,
    )

    assert "target" not in FEATURE_COLUMNS
    assert "future_return" not in FEATURE_COLUMNS
    first = supervised.iloc[0]
    source_index = int(first["target_index"])
    expected = frame.iloc[source_index + 2]["close"] / frame.iloc[source_index]["close"] - 1.0
    assert np.isclose(float(first["future_return"]), expected)


def test_model_artifact_paths_are_generated_safely():
    artifact = default_model_artifact_path("../../offline/xgboost")
    metadata = default_model_metadata_path("../../offline/xgboost")
    assert artifact.parent == Path("models")
    assert metadata.parent == Path("models")
    assert ".." not in artifact.name
    assert ".." not in metadata.name


def test_real_xgboost_training_artifact_loads_and_registers(tmp_path, monkeypatch):
    dataset_path = tmp_path / "eurusd_h1.csv"
    source = _write_training_fixture(dataset_path)
    output_dir = tmp_path / "models"

    result = train_offline(
        str(dataset_path),
        "xgboost-eurusd-h1-test-v1",
        instrument="EURUSD",
        timeframe="H1",
        horizon_bars=3,
        neutral_return_threshold=0.00001,
        output_dir=output_dir,
        approve_for_paper=True,
        min_samples=200,
    )

    artifact_path = Path(result["artifact_path"])
    metadata_path = Path(result["metadata_path"])
    assert artifact_path.is_file()
    assert metadata_path.is_file()
    assert result["approved_for_live"] is False
    assert result["approved_for_paper"] is True
    assert result["validation_rows"] > 0
    assert "accuracy" in result["metrics"]
    assert "log_loss" in result["metrics"]

    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    assert metadata["model_type"] == "xgboost_binary_direction_classifier"
    assert metadata["model_version"] == "xgboost-eurusd-h1-test-v1"
    assert metadata["feature_columns"] == FEATURE_COLUMNS
    assert metadata["approved_for_paper"] is True
    assert metadata["approved_for_live"] is False
    assert metadata["artifact_sha256"] == result["artifact_sha256"]

    monkeypatch.setenv(MODEL_PATH_ENV, str(artifact_path))
    monkeypatch.setenv(MODEL_METADATA_PATH_ENV, str(metadata_path))

    model = BaselineXGBoostModel()
    assert model.load_model() is True
    runtime_metadata = model.get_model_metadata()
    assert runtime_metadata["loaded"] is True
    assert runtime_metadata["mode"] == "trained_xgboost"
    assert runtime_metadata["version"] == "xgboost-eurusd-h1-test-v1"
    assert runtime_metadata["approved_for_paper"] is True
    assert runtime_metadata["approved_for_live"] is False

    latest_features = {
        name: float(compute_features(source).iloc[-1][name])
        for name in FEATURE_COLUMNS
    }
    prediction = model.predict_signal(latest_features)
    assert prediction.model_version == "xgboost-eurusd-h1-test-v1"
    assert prediction.direction in {"BUY", "SELL"}
    assert 0.5 <= prediction.confidence_score <= 1.0
    assert prediction.explainability["method"] == "xgboost_predict_proba"

    registry = build_default_registry()
    active = registry.get_active_model()
    governance = registry.get_governance(active.get_model_version())
    assert active.get_model_version() == "xgboost-eurusd-h1-test-v1"
    assert governance.approved_for_paper is True
    assert governance.approved_for_live is False

    # Prove the same verified artifact can be routed only to its declared pair
    # through a bundle while other instruments retain the truthful fallback.
    monkeypatch.delenv(MODEL_PATH_ENV)
    monkeypatch.delenv(MODEL_METADATA_PATH_ENV)
    bundle_path = output_dir / "candidate.bundle.json"
    bundle_path.write_text(
        json.dumps(
            {
                "bundle_version": 1,
                "models": [
                    {
                        "instrument": "EURUSD",
                        "timeframe": "H1",
                        "artifact_path": artifact_path.name,
                        "metadata_path": metadata_path.name,
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv(MODEL_BUNDLE_PATH_ENV, str(bundle_path))

    routed_registry = build_default_registry()
    eurusd_model = routed_registry.get_model_for("EURUSD", "H1")
    gbpusd_model = routed_registry.get_model_for("GBPUSD", "H1")
    assert eurusd_model.get_model_version() == "xgboost-eurusd-h1-test-v1"
    assert eurusd_model.get_model_metadata()["mode"] == "trained_xgboost"
    assert gbpusd_model.get_model_version() == "baseline-xgboost-v0.1.0"
    assert gbpusd_model.get_model_metadata()["mode"] == "heuristic_placeholder"


def test_live_approval_remains_false():
    from app.domain.models.governance import create_baseline_governance

    governance = create_baseline_governance()
    assert governance.approved_for_live is False
