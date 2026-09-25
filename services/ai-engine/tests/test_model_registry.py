"""Tests for ModelRegistry and baseline model governance."""
from __future__ import annotations

import hashlib
import json
from unittest.mock import MagicMock

import pandas as pd
import pytest
from xgboost import XGBClassifier

from app.core.errors import ModelNotFoundError
from app.domain.models.baseline_xgboost import (
    DUAL_ACTION_MARGIN_FLOOR_RUNTIME,
    EVENT_DUAL_ACTIONABILITY_EXPERIMENT_RUNTIME,
    EVENT_LABEL_POLICY_RUNTIME,
    EVENT_PAIR_BUNDLE_MODEL_TYPE,
    EVENT_PAIR_REGIME_ROUTER_POLICY_RUNTIME,
    MODEL_METADATA_PATH_ENV,
    MODEL_PATH_ENV,
    MODEL_VERSION,
    MULTITIMEFRAME_MODEL_TYPE,
    BaselineXGBoostModel,
)
from app.domain.models.governance import create_baseline_governance
from app.domain.models.multitimeframe_features import (
    INITIAL_FOREX_UNIVERSE,
    MULTITIMEFRAME_BACKTEST_POLICY,
    MULTITIMEFRAME_FEATURE_COLUMNS,
    MULTITIMEFRAME_LABEL_SELECTION_POLICY,
    MULTITIMEFRAME_RESEARCH_VALIDATION_POLICY,
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

def _write_mtf_artifact(
    tmp_path,
    *,
    mutate_schema: bool = False,
    include_label_policy: bool = True,
    include_backtest_policy: bool = True,
    include_research_validation_policy: bool = True,
):
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
    if include_label_policy:
        metadata["label_selection_policy"] = MULTITIMEFRAME_LABEL_SELECTION_POLICY
    if include_backtest_policy:
        metadata["backtest_evaluation_policy"] = MULTITIMEFRAME_BACKTEST_POLICY
    if include_research_validation_policy:
        metadata["research_validation_policy"] = (
            MULTITIMEFRAME_RESEARCH_VALIDATION_POLICY
        )
    metadata_path.write_text(json.dumps(metadata), encoding="utf-8")
    return model_path, metadata_path

def _write_event_pair_bundle(tmp_path):
    feature_columns = list(MULTITIMEFRAME_FEATURE_COLUMNS)
    rows = [
        {
            column: float((index + position) % 7) / 10.0
            for position, column in enumerate(feature_columns)
        }
        for index in range(12)
    ]
    frame = pd.DataFrame(rows, columns=feature_columns)
    target = [0, 1] * 6

    opportunity_path = tmp_path / "opportunity.json"
    opportunity = XGBClassifier(
        n_estimators=2,
        max_depth=1,
        learning_rate=0.1,
        n_jobs=1,
        tree_method="hist",
        random_state=42,
    )
    opportunity.fit(frame, target)
    opportunity.save_model(str(opportunity_path))

    direction = {}
    for instrument in INITIAL_FOREX_UNIVERSE:
        child_path = tmp_path / f"direction-{instrument}.json"
        child = XGBClassifier(
            n_estimators=2,
            max_depth=1,
            learning_rate=0.1,
            n_jobs=1,
            tree_method="hist",
            random_state=42,
        )
        child.fit(frame, target)
        child.save_model(str(child_path))
        direction[instrument] = {
            "path": child_path.name,
            "sha256": _artifact_sha(child_path),
            "kind": "xgboost_classifier",
        }

    manifest = {
        "bundle_version": 1,
        "model_type": EVENT_PAIR_BUNDLE_MODEL_TYPE,
        "experiment": "event_barrier_pair_experts",
        "event_label_policy": EVENT_LABEL_POLICY_RUNTIME,
        "opportunity": {
            "path": opportunity_path.name,
            "sha256": _artifact_sha(opportunity_path),
            "kind": "xgboost_classifier",
        },
        "direction": direction,
    }
    model_path = tmp_path / "event-pair-model.json"
    model_path.write_text(json.dumps(manifest), encoding="utf-8")

    metadata = {
        "metadata_version": 4,
        "model_type": EVENT_PAIR_BUNDLE_MODEL_TYPE,
        "runtime_feature_profile": MULTITIMEFRAME_RUNTIME_PROFILE,
        "research_experiment": "event_barrier_pair_experts",
        "event_label_policy": EVENT_LABEL_POLICY_RUNTIME,
        "backtest_evaluation_policy": MULTITIMEFRAME_BACKTEST_POLICY,
        "research_validation_policy": MULTITIMEFRAME_RESEARCH_VALIDATION_POLICY,
        "model_version": "event-pair-test-v1",
        "artifact_sha256": _artifact_sha(model_path),
        "feature_columns": feature_columns,
        "feature_schema_hash": _schema_hash(feature_columns),
        "approved_for_paper": True,
        "approved_for_live": False,
        "validation_status": "untouched_test_passed",
        "horizon_bars": 5,
        "instruments": list(INITIAL_FOREX_UNIVERSE),
    }
    metadata_path = tmp_path / "event-pair-model.metadata.json"
    metadata_path.write_text(json.dumps(metadata), encoding="utf-8")
    return model_path, metadata_path, direction



def _write_event_dual_actionability_bundle(tmp_path):
    feature_columns = list(MULTITIMEFRAME_FEATURE_COLUMNS)
    rows = [
        {
            column: float((index + position) % 7) / 10.0
            for position, column in enumerate(feature_columns)
        }
        for index in range(12)
    ]
    frame = pd.DataFrame(rows, columns=feature_columns)
    target = [0, 1] * 6

    def save_classifier(name):
        path = tmp_path / name
        fitted = XGBClassifier(
            n_estimators=2,
            max_depth=1,
            learning_rate=0.1,
            n_jobs=1,
            tree_method="hist",
            random_state=42,
        )
        fitted.fit(frame, target)
        fitted.save_model(str(path))
        return path

    long_path = save_classifier("long-action.json")
    short_path = save_classifier("short-action.json")
    manifest = {
        "bundle_version": 1,
        "model_type": EVENT_PAIR_BUNDLE_MODEL_TYPE,
        "experiment": EVENT_DUAL_ACTIONABILITY_EXPERIMENT_RUNTIME,
        "event_label_policy": EVENT_LABEL_POLICY_RUNTIME,
        "dual_actionability": {
            "kind": "xgboost_dual_actionability",
            "action_margin_floor": DUAL_ACTION_MARGIN_FLOOR_RUNTIME,
            "long": {
                "path": long_path.name,
                "sha256": _artifact_sha(long_path),
                "kind": "xgboost_classifier",
            },
            "short": {
                "path": short_path.name,
                "sha256": _artifact_sha(short_path),
                "kind": "xgboost_classifier",
            },
        },
    }
    model_path = tmp_path / "event-dual-actionability-model.json"
    model_path.write_text(json.dumps(manifest), encoding="utf-8")

    metadata = {
        "metadata_version": 4,
        "model_type": EVENT_PAIR_BUNDLE_MODEL_TYPE,
        "runtime_feature_profile": MULTITIMEFRAME_RUNTIME_PROFILE,
        "research_experiment": EVENT_DUAL_ACTIONABILITY_EXPERIMENT_RUNTIME,
        "event_label_policy": EVENT_LABEL_POLICY_RUNTIME,
        "backtest_evaluation_policy": MULTITIMEFRAME_BACKTEST_POLICY,
        "research_validation_policy": MULTITIMEFRAME_RESEARCH_VALIDATION_POLICY,
        "model_version": "event-dual-actionability-test-v1",
        "artifact_sha256": _artifact_sha(model_path),
        "feature_columns": feature_columns,
        "feature_schema_hash": _schema_hash(feature_columns),
        "approved_for_paper": True,
        "approved_for_live": False,
        "validation_status": "untouched_test_passed",
        "horizon_bars": 10,
        "instruments": list(INITIAL_FOREX_UNIVERSE),
        "action_margin_floor": DUAL_ACTION_MARGIN_FLOOR_RUNTIME,
    }
    metadata_path = tmp_path / "event-dual-actionability-model.metadata.json"
    metadata_path.write_text(json.dumps(metadata), encoding="utf-8")
    return model_path, metadata_path, manifest



def _write_event_pair_regime_bundle(tmp_path):
    feature_columns = list(MULTITIMEFRAME_FEATURE_COLUMNS)
    rows = [
        {
            column: float((index + position) % 7) / 10.0
            for position, column in enumerate(feature_columns)
        }
        for index in range(12)
    ]
    frame = pd.DataFrame(rows, columns=feature_columns)
    target = [0, 1] * 6

    def save_classifier(name):
        path = tmp_path / name
        fitted = XGBClassifier(
            n_estimators=2,
            max_depth=1,
            learning_rate=0.1,
            n_jobs=1,
            tree_method="hist",
            random_state=42,
        )
        fitted.fit(frame, target)
        fitted.save_model(str(path))
        return path

    opportunity_path = save_classifier("regime-opportunity.json")
    direction = {}
    for instrument in INITIAL_FOREX_UNIVERSE:
        fallback_path = save_classifier(f"direction-{instrument}-fallback.json")
        calm_path = save_classifier(f"direction-{instrument}-calm.json")
        direction[instrument] = {
            "kind": "xgboost_regime_classifier_router",
            "router": {
                "policy": EVENT_PAIR_REGIME_ROUTER_POLICY_RUNTIME,
                "m1_volatility_20_median": 0.5,
                "m1_spread_bps_median": 1.0,
            },
            "fallback": {
                "path": fallback_path.name,
                "sha256": _artifact_sha(fallback_path),
                "kind": "xgboost_classifier",
            },
            "regimes": {
                "calm": {
                    "path": calm_path.name,
                    "sha256": _artifact_sha(calm_path),
                    "kind": "xgboost_classifier",
                }
            },
        }

    manifest = {
        "bundle_version": 1,
        "model_type": EVENT_PAIR_BUNDLE_MODEL_TYPE,
        "experiment": "event_barrier_pair_regime_experts",
        "event_label_policy": EVENT_LABEL_POLICY_RUNTIME,
        "opportunity": {
            "path": opportunity_path.name,
            "sha256": _artifact_sha(opportunity_path),
            "kind": "xgboost_classifier",
        },
        "direction": direction,
    }
    model_path = tmp_path / "event-pair-regime-model.json"
    model_path.write_text(json.dumps(manifest), encoding="utf-8")

    metadata = {
        "metadata_version": 4,
        "model_type": EVENT_PAIR_BUNDLE_MODEL_TYPE,
        "runtime_feature_profile": MULTITIMEFRAME_RUNTIME_PROFILE,
        "research_experiment": "event_barrier_pair_regime_experts",
        "event_label_policy": EVENT_LABEL_POLICY_RUNTIME,
        "backtest_evaluation_policy": MULTITIMEFRAME_BACKTEST_POLICY,
        "research_validation_policy": MULTITIMEFRAME_RESEARCH_VALIDATION_POLICY,
        "model_version": "event-pair-regime-test-v1",
        "artifact_sha256": _artifact_sha(model_path),
        "feature_columns": feature_columns,
        "feature_schema_hash": _schema_hash(feature_columns),
        "approved_for_paper": True,
        "approved_for_live": False,
        "validation_status": "untouched_test_passed",
        "horizon_bars": 5,
        "instruments": list(INITIAL_FOREX_UNIVERSE),
    }
    metadata_path = tmp_path / "event-pair-regime-model.metadata.json"
    metadata_path.write_text(json.dumps(metadata), encoding="utf-8")
    return model_path, metadata_path


def test_verified_event_dual_actionability_bundle_enforces_side_margin(
    tmp_path,
    monkeypatch,
):
    model_path, metadata_path, _ = _write_event_dual_actionability_bundle(tmp_path)
    monkeypatch.setenv(MODEL_PATH_ENV, str(model_path))
    monkeypatch.setenv(MODEL_METADATA_PATH_ENV, str(metadata_path))

    model = BaselineXGBoostModel()
    assert model.load_model() is True
    metadata = model.get_model_metadata()
    assert metadata["mode"] == "trained_xgboost_mtf"
    assert (
        metadata["research_experiment"]
        == EVENT_DUAL_ACTIONABILITY_EXPERIMENT_RUNTIME
    )

    features = {column: 0.0 for column in MULTITIMEFRAME_FEATURE_COLUMNS}
    features["instrument_EURUSD"] = 1.0

    long_model = MagicMock()
    short_model = MagicMock()
    long_model.predict_proba.return_value = [[0.18, 0.82]]
    short_model.predict_proba.return_value = [[0.79, 0.21]]
    model._bundle["dual_actionability"]["long"] = long_model
    model._bundle["dual_actionability"]["short"] = short_model

    eligible = model.predict_signal(features)
    assert eligible.direction == "BUY"
    assert eligible.confidence_score == pytest.approx(0.82)
    assert eligible.raw_scores["action_probability_margin"] == pytest.approx(0.61)
    assert eligible.explainability["signal_eligible"] is True

    long_model.predict_proba.return_value = [[0.35, 0.65]]
    short_model.predict_proba.return_value = [[0.42, 0.58]]
    blocked = model.predict_signal(features)
    assert blocked.direction == "BUY"
    assert blocked.confidence_score == pytest.approx(0.65)
    assert blocked.raw_scores["action_probability_margin"] == pytest.approx(0.07)
    assert blocked.explainability["signal_eligible"] is False
    assert (
        blocked.explainability["signal_gate_reason"]
        == "action_probability_margin_below_floor"
    )


def test_event_dual_actionability_child_hash_mismatch_fails_closed(
    tmp_path,
    monkeypatch,
):
    model_path, metadata_path, manifest = _write_event_dual_actionability_bundle(tmp_path)
    child_path = tmp_path / manifest["dual_actionability"]["long"]["path"]
    child_path.write_bytes(child_path.read_bytes() + b"tamper")

    monkeypatch.setenv(MODEL_PATH_ENV, str(model_path))
    monkeypatch.setenv(MODEL_METADATA_PATH_ENV, str(metadata_path))

    model = BaselineXGBoostModel()
    assert model.load_model() is False
    assert model.get_model_metadata()["mode"] == "heuristic_placeholder"


def test_verified_event_pair_regime_bundle_routes_and_falls_back(
    tmp_path,
    monkeypatch,
):
    model_path, metadata_path = _write_event_pair_regime_bundle(tmp_path)
    monkeypatch.setenv(MODEL_PATH_ENV, str(model_path))
    monkeypatch.setenv(MODEL_METADATA_PATH_ENV, str(metadata_path))

    model = BaselineXGBoostModel()
    assert model.load_model() is True

    calm_features = {column: 0.0 for column in MULTITIMEFRAME_FEATURE_COLUMNS}
    calm_features["instrument_EURUSD"] = 1.0
    calm_features["m1_volatility_20"] = 0.1
    calm_features["m1_spread_bps"] = 0.5
    calm = model.predict_signal(calm_features)
    assert calm.explainability["market_regime"] == "calm"
    assert calm.explainability["regime_fallback_used"] is False

    stressed_features = dict(calm_features)
    stressed_features["m1_spread_bps"] = 2.0
    stressed = model.predict_signal(stressed_features)
    assert stressed.explainability["market_regime"] == "stressed"
    assert stressed.explainability["regime_fallback_used"] is True
    assert stressed.explainability["regime_router_policy"] == (
        EVENT_PAIR_REGIME_ROUTER_POLICY_RUNTIME
    )


def test_verified_event_pair_bundle_loads_and_routes_one_instrument(
    tmp_path,
    monkeypatch,
):
    model_path, metadata_path, _ = _write_event_pair_bundle(tmp_path)
    monkeypatch.setenv(MODEL_PATH_ENV, str(model_path))
    monkeypatch.setenv(MODEL_METADATA_PATH_ENV, str(metadata_path))

    model = BaselineXGBoostModel()
    assert model.load_model() is True
    metadata = model.get_model_metadata()
    assert metadata["mode"] == "trained_xgboost_mtf"
    assert metadata["model_type"] == EVENT_PAIR_BUNDLE_MODEL_TYPE
    assert metadata["research_experiment"] == "event_barrier_pair_experts"
    assert metadata["approved_for_paper"] is True
    assert metadata["approved_for_live"] is False

    features = {column: 0.0 for column in MULTITIMEFRAME_FEATURE_COLUMNS}
    features["instrument_EURUSD"] = 1.0
    prediction = model.predict_signal(features)

    assert prediction.direction in {"BUY", "SELL"}
    assert 0.0 <= prediction.confidence_score <= 1.0
    assert prediction.explainability["instrument_expert"] == "EURUSD"
    assert prediction.explainability["approved_for_live"] is False


def test_event_pair_bundle_child_hash_mismatch_fails_closed(tmp_path, monkeypatch):
    model_path, metadata_path, direction = _write_event_pair_bundle(tmp_path)
    child_path = tmp_path / direction["EURUSD"]["path"]
    child_path.write_bytes(child_path.read_bytes() + b"tamper")

    monkeypatch.setenv(MODEL_PATH_ENV, str(model_path))
    monkeypatch.setenv(MODEL_METADATA_PATH_ENV, str(metadata_path))

    model = BaselineXGBoostModel()
    assert model.load_model() is False
    assert model.get_model_metadata()["mode"] == "heuristic_placeholder"


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
    assert (
        metadata["label_selection_policy"]
        == MULTITIMEFRAME_LABEL_SELECTION_POLICY
    )
    assert (
        metadata["backtest_evaluation_policy"]
        == MULTITIMEFRAME_BACKTEST_POLICY
    )
    assert (
        metadata["research_validation_policy"]
        == MULTITIMEFRAME_RESEARCH_VALIDATION_POLICY
    )
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


def test_legacy_mtf_artifact_without_unbiased_label_policy_fails_closed(
    tmp_path,
    monkeypatch,
):
    model_path, metadata_path = _write_mtf_artifact(
        tmp_path,
        include_label_policy=False,
    )
    monkeypatch.setenv(MODEL_PATH_ENV, str(model_path))
    monkeypatch.setenv(MODEL_METADATA_PATH_ENV, str(metadata_path))

    model = BaselineXGBoostModel()
    assert model.load_model() is False
    assert model.get_model_metadata()["mode"] == "heuristic_placeholder"


def test_registry_falls_back_to_baseline_governance_for_legacy_mtf_artifact(
    tmp_path,
    monkeypatch,
):
    model_path, metadata_path = _write_mtf_artifact(
        tmp_path,
        include_label_policy=False,
    )
    monkeypatch.setenv(MODEL_PATH_ENV, str(model_path))
    monkeypatch.setenv(MODEL_METADATA_PATH_ENV, str(metadata_path))

    registry = build_default_registry()
    active = registry.get_active_model()
    governance = registry.get_governance(active.get_model_version())

    assert active.get_model_version() == MODEL_VERSION
    assert active.get_model_metadata()["mode"] == "heuristic_placeholder"
    assert governance.validation_status == "scaffold_only_not_validated"
    assert governance.approved_for_paper is True
    assert governance.approved_for_live is False


def test_mtf_artifact_without_conservative_backtest_policy_fails_closed(
    tmp_path,
    monkeypatch,
):
    model_path, metadata_path = _write_mtf_artifact(
        tmp_path,
        include_backtest_policy=False,
    )
    monkeypatch.setenv(MODEL_PATH_ENV, str(model_path))
    monkeypatch.setenv(MODEL_METADATA_PATH_ENV, str(metadata_path))

    model = BaselineXGBoostModel()
    assert model.load_model() is False
    assert model.get_model_metadata()["mode"] == "heuristic_placeholder"



def test_mtf_artifact_with_reused_outer_validation_policy_fails_closed(
    tmp_path,
    monkeypatch,
):
    model_path, metadata_path = _write_mtf_artifact(
        tmp_path,
        include_research_validation_policy=False,
    )
    monkeypatch.setenv(MODEL_PATH_ENV, str(model_path))
    monkeypatch.setenv(MODEL_METADATA_PATH_ENV, str(metadata_path))

    model = BaselineXGBoostModel()
    assert model.load_model() is False
    assert model.get_model_metadata()["mode"] == "heuristic_placeholder"
