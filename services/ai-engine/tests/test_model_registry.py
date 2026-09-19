"""Tests for ModelRegistry and baseline model governance."""
from __future__ import annotations

import pytest

from app.core.errors import ModelNotFoundError
from app.domain.models.baseline_xgboost import MODEL_VERSION, BaselineXGBoostModel
from app.domain.models.governance import create_baseline_governance
from app.domain.models.registry import ModelRegistry, build_default_registry


def test_baseline_model_returns_paper_only_metadata():
    model = BaselineXGBoostModel()
    model.load_model()
    metadata = model.get_model_metadata()

    assert metadata["approved_for_live"] is False
    assert metadata["approved_for_paper"] is True
    assert metadata["mode"] == "heuristic_placeholder"
    assert metadata["trained_model_active"] is False
    assert metadata["load_status"] == "not_configured"
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
