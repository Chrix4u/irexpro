"""Tests for ModelRegistry and baseline model governance."""
from __future__ import annotations

import hashlib
import json

import pandas as pd
import pytest
from xgboost import XGBClassifier

from app.core.errors import ModelNotFoundError
from app.domain.models.baseline_xgboost import (
    MODEL_METADATA_PATH_ENV,
    MODEL_PATH_ENV,
    MODEL_VERSION,
    MULTITIMEFRAME_MODEL_TYPE,
    BaselineXGBoostModel,
)
from app.domain.models.governance import create_baseline_governance
from app.domain.models.multitimeframe_features import (
    MULTITIMEFRAME_FEATURE_COLUMNS,
    MULTITIMEFRAME_RUNTIME_PROFILE,
)
from app.domain.models.registry import ModelRegistry, build_default_registry


def test_baseline_model_returns_paper_only_metadata():
    model = BaselineXGBoostModel()
    model.load_model()
    metadata = model.get_model_metadata()

    assert metadata["approved_for_live"] is False
    assert metadata["approved_for_paper"] is True
    assert metadata["mode"] == "heuristic_placeholder"
    assert metadata["version"] == MODEL_VERSION


def test_baseline_governance_not_approved_for_live():
    governance = create_baseline_governance()
    assert governance.approved_for_live is False
    assert governance.approved_for_paper is True
    assert governance.validation_status == "scaffold_only_not_validated"


def test_default_registry_has_baseline_active():
    registry = build_default_registry()
    active = registry.get_active_model()
    assert active.get_model_version() == MODEL_VERSION

    governance = registry.get_governance(MODEL_VERSION)
    assert governance.approved_for_live is False
    assert governance.approved_for_paper is True


def test_registry_list_models_shows_live_not_approved():
    registry = build_default_registry()
    models = registry.list_models()
    assert len(models) >= 1
    baseline = next(m for m in models if m["version"] == MODEL_VERSION)
    assert baseline["approved_for_live"] is False
    assert baseline["approved_for_paper"] is True
    assert baseline["active"] is True


def test_registry_rollback_to_known_version():
    registry = ModelRegistry()
    model = BaselineXGBoostModel()
    governance = create_baseline_governance()
    registry.register_model(model, governance)

    registry.rollback_model(MODEL_VERSION)
    assert registry.get_active_model().get_model_version() == MODEL_VERSION


def test_registry_rollback_unknown_version_raises():
    registry = build_default_registry()
    with pytest.raises(ModelNotFoundError):
        registry.rollback_model("nonexistent-model-v9.9.9")



def _schema_hash(columns: list[str]) -> str:
    payload = json.dumps(columns, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _artifact_sha(path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _write_mtf_artifact(tmp_path, *, mutate_schema: bool = False):
    model_path = tmp_path / "mtf-model.json"
    metadata_path = tmp_path / "mtf-model.metadata.json"

    rows = []
    for index in range(8):
        rows.append(
            {
                column: float((index + position) % 7) / 10.0
                for position, column in enumerate(MULTITIMEFRAME_FEATURE_COLUMNS)
            }
        )
    frame = pd.DataFrame(rows, columns=MULTITIMEFRAME_FEATURE_COLUMNS)
    target = [0, 1, 0, 1, 0, 1, 0, 1]

    fitted = XGBClassifier(
        n_estimators=2,
        max_depth=1,
        learning_rate=0.1,
        n_jobs=1,
        tree_method="hist",
        random_state=42,
    )
    fitted.fit(frame, target)
    fitted.save_model(str(model_path))

    feature_columns = list(MULTITIMEFRAME_FEATURE_COLUMNS)
    if mutate_schema:
        feature_columns[-1] = "instrument_SCHEMA_MISMATCH"

    metadata = {
        "metadata_version": 2,
        "model_type": MULTITIMEFRAME_MODEL_TYPE,
        "runtime_feature_profile": MULTITIMEFRAME_RUNTIME_PROFILE,
        "model_version": "mtf-xgboost-test-v1",
        "artifact_sha256": _artifact_sha(model_path),
        "feature_columns": feature_columns,
        "feature_schema_hash": _schema_hash(feature_columns),
        "approved_for_paper": True,
        "approved_for_live": False,
        "validation_status": "untouched_test_passed",
        "horizon_bars": 5,
        "instruments": ["EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCAD", "USDCHF"],
    }
    metadata_path.write_text(json.dumps(metadata), encoding="utf-8")
    return model_path, metadata_path


def test_verified_mtf_artifact_loads_as_trained_runtime(tmp_path, monkeypatch):
    model_path, metadata_path = _write_mtf_artifact(tmp_path)
    monkeypatch.setenv(MODEL_PATH_ENV, str(model_path))
    monkeypatch.setenv(MODEL_METADATA_PATH_ENV, str(metadata_path))

    model = BaselineXGBoostModel()
    assert model.load_model() is True

    metadata = model.get_model_metadata()
    assert metadata["loaded"] is True
    assert metadata["mode"] == "trained_xgboost_mtf"
    assert metadata["runtime_feature_profile"] == MULTITIMEFRAME_RUNTIME_PROFILE
    assert metadata["feature_count"] == len(MULTITIMEFRAME_FEATURE_COLUMNS)
    assert metadata["approved_for_paper"] is True
    assert metadata["approved_for_live"] is False


def test_mtf_artifact_with_schema_mismatch_fails_closed(tmp_path, monkeypatch):
    model_path, metadata_path = _write_mtf_artifact(
        tmp_path,
        mutate_schema=True,
    )
    monkeypatch.setenv(MODEL_PATH_ENV, str(model_path))
    monkeypatch.setenv(MODEL_METADATA_PATH_ENV, str(metadata_path))

    model = BaselineXGBoostModel()
    assert model.load_model() is False
    assert model.get_model_metadata()["mode"] == "heuristic_placeholder"
