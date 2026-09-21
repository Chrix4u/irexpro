"""
Tests for the operator-controlled model LIVE promotion foundation.

Covers:
- ModelPromotionRecord schema (fail-closed validation, no secret fields).
- Registry live activation: valid record activates; missing/tampered/
  duplicate/malformed records never activate (truthful reasons).
- Artifact byte-exactness (different-artifact sha never activates).
- LIVE activation feature gate in SignalGenerator (env gate + promotion gate).
- approved_for_live stays False in every artifact/governance surface after
  promotion (the promotion record is the ONLY live-granting mechanism).
- Trainer source-scan: no training script can write/reference the promotion
  directory (no training-script self-approval).
- Rollback semantics: removing a record deactivates on the next check;
  rollback_model() behavior is unchanged.
"""
from __future__ import annotations

import hashlib
import json
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pandas as pd
import pytest
from xgboost import XGBClassifier

import app.core.config as config_module
from app.core.errors import LiveModeNotSupportedError, ModelNotFoundError
from app.domain.market_data.schemas import OHLCVCandle
from app.domain.models.baseline_xgboost import (
    MODEL_METADATA_PATH_ENV,
    MODEL_PATH_ENV,
    BaselineXGBoostModel,
)
from app.domain.models.feature_engineering import FEATURE_COLUMNS
from app.domain.models.governance import (
    create_baseline_governance,
    create_trained_model_governance,
)
from app.domain.models.promotion import (
    PROMOTION_DIR_ENV,
    ModelPromotionRecord,
    load_promotion_records,
)
from app.domain.models.registry import ModelRegistry, build_default_registry
from app.domain.signals.signal_generator import SignalGenerator

ENGINE_ROOT = Path(__file__).resolve().parents[1]

# Identifiers that must NEVER appear in trainer/model-loader source. Note the
# deliberate specificity: the bare word "promotion" is NOT scanned because
# train_final_multitimeframe.py mentions "MIN_PAPER_PROMOTION_*" constants
# which are unrelated paper-qualification thresholds.
PROMOTION_DIR_IDENTIFIERS = (
    "model-promotions",
    "model_promotions",
    "AI_MODEL_PROMOTION_DIR",
    "app.domain.models.promotion",
    "app/domain/models/promotion",
    "PROMOTION_DIR_ENV",
    "ModelPromotionRecord",
    "load_promotion_records",
    "find_promotion_for_model",
    "resolve_promotion_dir",
    "DEFAULT_PROMOTION_DIR",
)


@pytest.fixture(autouse=True)
def _isolate_settings_and_promotion_env(monkeypatch):
    """Prevent cached-settings and promotion-dir leakage between tests."""
    monkeypatch.delenv(PROMOTION_DIR_ENV, raising=False)
    config_module._settings = None
    yield
    config_module._settings = None


def _apply_env(monkeypatch, **overrides):
    """Set engine env vars and drop the cached Settings singleton."""
    values = {
        "AI_SIGNAL_MODE": "paper",
        "AI_ENGINE_ALLOW_LIVE_MODEL": "false",
        **overrides,
    }
    for key, value in values.items():
        monkeypatch.setenv(key, value)
    config_module._settings = None


def _schema_hash(columns: list[str]) -> str:
    payload = json.dumps(columns, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _artifact_sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _candles(count: int = 30, base: float = 1.10) -> list[OHLCVCandle]:
    """Deterministic closed candles (no future timestamps)."""
    now = datetime.now(UTC)
    first = now - timedelta(hours=count + 2)
    candles = []
    for index in range(count):
        close = base + 0.00001 * index
        candles.append(
            OHLCVCandle(
                timestamp=first + timedelta(hours=index),
                open=close - 0.00002,
                high=close + 0.00005,
                low=close - 0.00005,
                close=close,
                volume=100 + index,
                instrument="EURUSD",
                timeframe="H1",
                source="mock",
            )
        )
    return candles


def _feature_frame(candles: list[OHLCVCandle]) -> pd.DataFrame:
    """Compute the exact runtime feature rows the generator will extract."""
    from app.domain.models.feature_engineering import (
        candles_to_dataframe,
        compute_features,
    )

    featured = compute_features(candles_to_dataframe(candles))
    return featured[FEATURE_COLUMNS]


def _write_trained_artifact(
    tmp_path: Path,
    model_version: str = "xgboost-live-promotion-test-v1",
):
    """Write a verified single-timeframe trained artifact + sidecar."""
    tmp_path.mkdir(parents=True, exist_ok=True)
    model_path = tmp_path / "live-promotion-model.json"
    metadata_path = tmp_path / "live-promotion-model.metadata.json"

    # Perfectly separable training rows built from REAL runtime feature
    # distributions (so candle-derived inference features classify as class 1
    # with high confidence): EURUSD-scale candles vs 0.90-scale candles.
    class_one = _feature_frame(_candles())
    class_zero = _feature_frame(_candles(base=0.90))
    frame = pd.concat([class_one, class_zero], ignore_index=True)
    target = [1] * len(class_one) + [0] * len(class_zero)

    fitted = XGBClassifier(
        n_estimators=10,
        max_depth=2,
        learning_rate=0.3,
        n_jobs=1,
        tree_method="hist",
        random_state=42,
    )
    fitted.fit(frame, target)
    fitted.save_model(str(model_path))

    metadata = {
        "metadata_version": 1,
        "model_type": "xgboost_binary_direction_classifier",
        "model_version": model_version,
        "artifact_sha256": _artifact_sha(model_path),
        "feature_columns": list(FEATURE_COLUMNS),
        "feature_schema_hash": _schema_hash(list(FEATURE_COLUMNS)),
        "approved_for_paper": True,
        "approved_for_live": False,
        "validation_status": "untouched_test_passed",
        "instrument": "EURUSD",
        "timeframe": "H1",
    }
    metadata_path.write_text(json.dumps(metadata), encoding="utf-8")
    return model_path, metadata_path, metadata["artifact_sha256"]


def _trained_registry(
    tmp_path: Path,
    monkeypatch,
    promotion_dir: Path | None = None,
    model_version: str = "xgboost-live-promotion-test-v1",
) -> tuple[ModelRegistry, Path, Path, str]:
    """Build a registry whose active model is a verified trained artifact."""
    model_path, metadata_path, artifact_sha = _write_trained_artifact(
        tmp_path, model_version=model_version
    )
    monkeypatch.setenv(MODEL_PATH_ENV, str(model_path))
    monkeypatch.setenv(MODEL_METADATA_PATH_ENV, str(metadata_path))

    model = BaselineXGBoostModel()
    assert model.load_model() is True

    registry = ModelRegistry(promotion_dir=promotion_dir)
    governance = create_trained_model_governance(model.get_artifact_metadata())
    registry.register_model(model, governance)
    return registry, model_path, metadata_path, artifact_sha


def _write_promotion_record(
    promotion_dir: Path,
    model_version: str,
    artifact_sha256: str,
    record_id: str | None = None,
    filename: str | None = None,
    **overrides,
) -> Path:
    """Author an operator promotion record OUT-OF-BAND (test simulates the operator)."""
    promotion_dir.mkdir(parents=True, exist_ok=True)
    record = {
        "record_id": record_id or str(uuid.uuid4()),
        "model_version": model_version,
        "artifact_sha256": artifact_sha256,
        "promoted_by": "ops-engineer@irexpro.example",
        "approved_by": "compliance@irexpro.example",
        "reason": "Operator-approved supervised live evaluation after review",
        "created_at": "2025-01-15T10:00:00+00:00",
        "supersedes": None,
    }
    record.update(overrides)
    path = promotion_dir / (filename or f"{record['record_id']}.json")
    path.write_text(json.dumps(record), encoding="utf-8")
    return path


# ─── Promotion record schema (fail-closed, no secrets) ─────────────────────


def test_promotion_record_accepts_valid_payload():
    record = ModelPromotionRecord.model_validate(
        {
            "record_id": str(uuid.uuid4()),
            "model_version": "xgboost-live-promotion-test-v1",
            "artifact_sha256": "a" * 64,
            "promoted_by": "ops",
            "approved_by": "compliance",
            "reason": "reviewed",
            "created_at": "2025-01-15T10:00:00+00:00",
            "supersedes": None,
        }
    )
    assert record.model_version == "xgboost-live-promotion-test-v1"
    assert record.artifact_sha256 == "a" * 64


def test_promotion_record_rejects_unknown_fields_so_no_secrets_can_ride_along():
    payload = {
        "record_id": str(uuid.uuid4()),
        "model_version": "v1",
        "artifact_sha256": "b" * 64,
        "promoted_by": "ops",
        "approved_by": "compliance",
        "reason": "reviewed",
        "created_at": "2025-01-15T10:00:00+00:00",
        "api_token": "super-secret",  # unknown field — must invalidate
    }
    with pytest.raises(Exception):
        ModelPromotionRecord.model_validate(payload)


@pytest.mark.parametrize(
    "field,value",
    [
        ("record_id", "not-a-uuid"),
        ("record_id", "f47ac10b-58cc-11d2-a567-0e02b2c3d479"),  # UUID1, not UUID4
        ("model_version", "  "),
        ("artifact_sha256", "xyz"),
        ("artifact_sha256", "a" * 63),
        ("promoted_by", ""),
        ("approved_by", "   "),
        ("reason", ""),
        ("created_at", "not-a-date"),
    ],
)
def test_promotion_record_rejects_malformed_fields(field, value):
    payload = {
        "record_id": str(uuid.uuid4()),
        "model_version": "v1",
        "artifact_sha256": "a" * 64,
        "promoted_by": "ops",
        "approved_by": "compliance",
        "reason": "reviewed",
        "created_at": "2025-01-15T10:00:00+00:00",
    }
    payload[field] = value
    with pytest.raises(Exception):
        ModelPromotionRecord.model_validate(payload)


# ─── Promotion directory loading (fail-closed) ──────────────────────────────


def test_malformed_json_record_is_invalid(tmp_path):
    (tmp_path / "broken.json").write_text("{not json", encoding="utf-8")
    state = load_promotion_records(tmp_path)
    assert state.valid_records == []
    assert [entry.reason for entry in state.invalid_records] == ["MALFORMED_JSON"]


def test_schema_invalid_record_is_reported_with_reason(tmp_path):
    _write_promotion_record(
        tmp_path,
        "xgboost-live-promotion-test-v1",
        "short-sha",
    )
    state = load_promotion_records(tmp_path)
    assert state.valid_records == []
    assert [entry.reason for entry in state.invalid_records] == [
        "SCHEMA_VALIDATION_FAILED"
    ]


def test_duplicate_record_id_invalidates_every_occurrence(tmp_path):
    shared_id = str(uuid.uuid4())
    _write_promotion_record(
        tmp_path,
        "xgboost-live-promotion-test-v1",
        "a" * 64,
        record_id=shared_id,
        filename="first-copy.json",
    )
    _write_promotion_record(
        tmp_path,
        "xgboost-live-promotion-test-v1",
        "b" * 64,
        record_id=shared_id,
        filename="second-copy.json",
    )
    state = load_promotion_records(tmp_path)
    assert state.valid_records == []
    assert len(state.invalid_records) == 2
    assert {entry.reason for entry in state.invalid_records} == {"DUPLICATE_RECORD_ID"}


def test_missing_directory_is_empty_not_an_error(tmp_path):
    state = load_promotion_records(tmp_path / "does-not-exist")
    assert state.valid_records == []
    assert state.invalid_records == []


# ─── Registry live activation ───────────────────────────────────────────────


def test_valid_promotion_record_activates_live(tmp_path, monkeypatch):
    promotion_dir = tmp_path / "promotions"
    registry, _, _, artifact_sha = _trained_registry(
        tmp_path, monkeypatch, promotion_dir=promotion_dir
    )
    version = registry.get_active_model().get_model_version()
    assert registry.get_live_activation()["activated"] is False

    _write_promotion_record(promotion_dir, version, artifact_sha)

    activation = registry.get_live_activation()
    assert activation["activated"] is True
    assert activation["model_version"] == version
    assert activation["artifact_sha256"] == artifact_sha
    assert activation["record_id"]
    assert activation["promoted_by"] == "ops-engineer@irexpro.example"
    assert activation["approved_by"] == "compliance@irexpro.example"
    assert activation["activated_at"]
    assert activation["reason"] is None


def test_missing_record_or_dir_means_not_activated(tmp_path, monkeypatch):
    # Missing directory entirely.
    registry, _, _, _ = _trained_registry(
        tmp_path, monkeypatch, promotion_dir=tmp_path / "promotions"
    )
    activation = registry.get_live_activation()
    assert activation["activated"] is False
    assert activation["reason"] == "NO_VALID_PROMOTION_RECORD"

    # Directory present but no record file.
    promotion_dir = tmp_path / "promotions2"
    promotion_dir.mkdir()
    registry2, _, _, _ = _trained_registry(
        tmp_path / "second", monkeypatch, promotion_dir=promotion_dir
    )
    assert registry2.get_live_activation()["reason"] == "NO_VALID_PROMOTION_RECORD"


def test_record_with_different_artifact_sha_never_activates(tmp_path, monkeypatch):
    promotion_dir = tmp_path / "promotions"
    registry, _, _, _ = _trained_registry(
        tmp_path, monkeypatch, promotion_dir=promotion_dir
    )
    version = registry.get_active_model().get_model_version()

    # A record binding the sha of a DIFFERENT artifact (byte-identical rule).
    other_artifact = tmp_path / "other.bin"
    other_artifact.write_bytes(b"different artifact bytes")
    _write_promotion_record(
        promotion_dir, version, _artifact_sha(other_artifact)
    )

    activation = registry.get_live_activation()
    assert activation["activated"] is False
    assert activation["reason"] == "NO_VALID_PROMOTION_RECORD"


def test_record_for_other_model_version_never_activates(tmp_path, monkeypatch):
    promotion_dir = tmp_path / "promotions"
    registry, _, _, artifact_sha = _trained_registry(
        tmp_path, monkeypatch, promotion_dir=promotion_dir
    )
    _write_promotion_record(
        promotion_dir, "some-other-model-v9.9.9", artifact_sha
    )
    activation = registry.get_live_activation()
    assert activation["activated"] is False
    assert activation["reason"] == "NO_VALID_PROMOTION_RECORD"


def test_tampered_binding_field_deactivates_on_next_check(tmp_path, monkeypatch):
    promotion_dir = tmp_path / "promotions"
    registry, _, _, artifact_sha = _trained_registry(
        tmp_path, monkeypatch, promotion_dir=promotion_dir
    )
    version = registry.get_active_model().get_model_version()
    record_path = _write_promotion_record(promotion_dir, version, artifact_sha)

    assert registry.get_live_activation()["activated"] is True

    # Operator record is edited after authoring (binding field tampered).
    payload = json.loads(record_path.read_text(encoding="utf-8"))
    payload["artifact_sha256"] = "c" * 64
    record_path.write_text(json.dumps(payload), encoding="utf-8")

    activation = registry.get_live_activation()
    assert activation["activated"] is False
    assert activation["reason"] == "NO_VALID_PROMOTION_RECORD"


def test_malformed_record_file_never_activates(tmp_path, monkeypatch):
    promotion_dir = tmp_path / "promotions"
    registry, _, _, _ = _trained_registry(
        tmp_path, monkeypatch, promotion_dir=promotion_dir
    )
    # The only record file present is malformed JSON.
    promotion_dir.mkdir(parents=True, exist_ok=True)
    (promotion_dir / "garbage.json").write_text("]]] not json [[[", encoding="utf-8")

    activation = registry.get_live_activation()
    assert activation["activated"] is False
    assert activation["reason"] == "NO_VALID_PROMOTION_RECORD"


def test_duplicate_record_id_never_activates(tmp_path, monkeypatch):
    promotion_dir = tmp_path / "promotions"
    registry, _, _, artifact_sha = _trained_registry(
        tmp_path, monkeypatch, promotion_dir=promotion_dir
    )
    version = registry.get_active_model().get_model_version()
    shared_id = str(uuid.uuid4())
    _write_promotion_record(
        promotion_dir, version, artifact_sha, record_id=shared_id, filename="a.json"
    )
    _write_promotion_record(
        promotion_dir, version, artifact_sha, record_id=shared_id, filename="b.json"
    )

    activation = registry.get_live_activation()
    assert activation["activated"] is False
    assert activation["reason"] == "NO_VALID_PROMOTION_RECORD"


def test_unknown_record_field_never_activates(tmp_path, monkeypatch):
    promotion_dir = tmp_path / "promotions"
    registry, _, _, artifact_sha = _trained_registry(
        tmp_path, monkeypatch, promotion_dir=promotion_dir
    )
    version = registry.get_active_model().get_model_version()
    _write_promotion_record(
        promotion_dir,
        version,
        artifact_sha,
        api_token="secret-that-must-not-ride-along",
    )

    activation = registry.get_live_activation()
    assert activation["activated"] is False
    assert activation["reason"] == "NO_VALID_PROMOTION_RECORD"


def test_scaffold_model_never_activates(tmp_path):
    registry = ModelRegistry(promotion_dir=tmp_path / "promotions")
    model = BaselineXGBoostModel()
    registry.register_model(model, create_baseline_governance())
    # Even a promotion record naming the scaffold version cannot activate it:
    # there is no verified artifact to bind byte-exactly.
    _write_promotion_record(
        tmp_path / "promotions", model.get_model_version(), "d" * 64
    )
    activation = registry.get_live_activation()
    assert activation["activated"] is False
    assert activation["reason"] == "NO_VERIFIED_ARTIFACT"


def test_artifact_mutated_after_load_fails_closed(tmp_path, monkeypatch):
    promotion_dir = tmp_path / "promotions"
    registry, model_path, _, artifact_sha = _trained_registry(
        tmp_path, monkeypatch, promotion_dir=promotion_dir
    )
    version = registry.get_active_model().get_model_version()
    _write_promotion_record(promotion_dir, version, artifact_sha)
    assert registry.get_live_activation()["activated"] is True

    # Artifact bytes are mutated after load — binding must break.
    model_path.write_bytes(model_path.read_bytes() + b"\n")

    activation = registry.get_live_activation()
    assert activation["activated"] is False
    assert activation["reason"] == "ARTIFACT_SHA_MISMATCH"


def test_artifact_deleted_after_load_fails_closed(tmp_path, monkeypatch):
    promotion_dir = tmp_path / "promotions"
    registry, model_path, _, artifact_sha = _trained_registry(
        tmp_path, monkeypatch, promotion_dir=promotion_dir
    )
    version = registry.get_active_model().get_model_version()
    _write_promotion_record(promotion_dir, version, artifact_sha)
    assert registry.get_live_activation()["activated"] is True

    model_path.unlink()

    activation = registry.get_live_activation()
    assert activation["activated"] is False
    assert activation["reason"] == "ARTIFACT_FILE_MISSING"


def test_record_removal_deactivates_on_next_check(tmp_path, monkeypatch):
    promotion_dir = tmp_path / "promotions"
    registry, _, _, artifact_sha = _trained_registry(
        tmp_path, monkeypatch, promotion_dir=promotion_dir
    )
    version = registry.get_active_model().get_model_version()
    record_path = _write_promotion_record(promotion_dir, version, artifact_sha)
    assert registry.get_live_activation()["activated"] is True

    # Operator rollback: delete the promotion record.
    record_path.unlink()

    activation = registry.get_live_activation()
    assert activation["activated"] is False
    assert activation["reason"] == "NO_VALID_PROMOTION_RECORD"


def test_evaluate_live_activation_unknown_version(tmp_path):
    registry = ModelRegistry(promotion_dir=tmp_path / "promotions")
    activation = registry.evaluate_live_activation("never-registered-v0")
    assert activation["activated"] is False
    assert activation["reason"] == "MODEL_NOT_REGISTERED"


def test_empty_registry_reports_no_active_model(tmp_path):
    registry = ModelRegistry(promotion_dir=tmp_path / "promotions")
    activation = registry.get_live_activation()
    assert activation["activated"] is False
    assert activation["reason"] == "NO_ACTIVE_MODEL"


def test_list_models_includes_truthful_live_activation_block(tmp_path, monkeypatch):
    promotion_dir = tmp_path / "promotions"
    registry, _, _, artifact_sha = _trained_registry(
        tmp_path, monkeypatch, promotion_dir=promotion_dir
    )
    models = registry.list_models()
    assert len(models) == 1
    entry = models[0]
    assert entry["live_activation"]["activated"] is False
    assert entry["live_activation"]["reason"] == "NO_VALID_PROMOTION_RECORD"
    # approved_for_live in the governance surface stays False regardless.
    assert entry["approved_for_live"] is False

    version = registry.get_active_model().get_model_version()
    _write_promotion_record(promotion_dir, version, artifact_sha)
    entry = registry.list_models()[0]
    assert entry["live_activation"]["activated"] is True
    assert entry["approved_for_live"] is False


def test_rollback_model_behavior_unchanged(tmp_path, monkeypatch):
    promotion_dir = tmp_path / "promotions"
    registry, _, _, artifact_sha = _trained_registry(
        tmp_path, monkeypatch, promotion_dir=promotion_dir
    )
    version = registry.get_active_model().get_model_version()
    _write_promotion_record(promotion_dir, version, artifact_sha)
    assert registry.get_live_activation()["activated"] is True

    # Register the scaffold as a second, rollback target.
    scaffold = BaselineXGBoostModel()
    registry.register_model(scaffold, create_baseline_governance())

    registry.rollback_model(scaffold.get_model_version())
    assert registry.get_active_model().get_model_version() == scaffold.get_model_version()
    activation = registry.get_live_activation()
    assert activation["activated"] is False
    assert activation["reason"] == "NO_VERIFIED_ARTIFACT"

    with pytest.raises(ModelNotFoundError):
        registry.rollback_model("nonexistent-model-v9.9.9")


def test_promotion_does_not_mutate_artifact_surfaces(tmp_path, monkeypatch):
    promotion_dir = tmp_path / "promotions"
    registry, _, metadata_path, artifact_sha = _trained_registry(
        tmp_path, monkeypatch, promotion_dir=promotion_dir
    )
    version = registry.get_active_model().get_model_version()
    _write_promotion_record(promotion_dir, version, artifact_sha)
    assert registry.get_live_activation()["activated"] is True

    # 1. Sidecar file on disk keeps approved_for_live=False.
    sidecar = json.loads(metadata_path.read_text(encoding="utf-8"))
    assert sidecar["approved_for_live"] is False

    model = registry.get_active_model()
    # 2. Runtime model metadata surface keeps approved_for_live=False.
    assert model.get_model_metadata()["approved_for_live"] is False
    # 3. Governance surface keeps approved_for_live=False.
    assert registry.get_governance(version).approved_for_live is False
    # 4. list_models surface keeps approved_for_live=False.
    assert registry.list_models()[0]["approved_for_live"] is False


# ─── LIVE activation feature gate (SignalGenerator) ─────────────────────────


def _make_generator(registry: ModelRegistry) -> SignalGenerator:
    return SignalGenerator(ohlcv_service=None, model_registry=registry)  # type: ignore[arg-type]


@pytest.mark.asyncio
async def test_live_mode_rejected_when_env_gate_closed(tmp_path, monkeypatch):
    promotion_dir = tmp_path / "promotions"
    registry, _, _, artifact_sha = _trained_registry(
        tmp_path, monkeypatch, promotion_dir=promotion_dir
    )
    version = registry.get_active_model().get_model_version()
    _write_promotion_record(promotion_dir, version, artifact_sha)

    # Valid record exists, but the env feature gate is OFF.
    _apply_env(monkeypatch, AI_SIGNAL_MODE="live", AI_ENGINE_ALLOW_LIVE_MODEL="false")

    with pytest.raises(LiveModeNotSupportedError) as excinfo:
        await _make_generator(registry).generate(
            user_id="u1",
            trading_session_id="s1",
            broker_connection_id="c1",
            instrument="EURUSD",
            timeframe="H1",
            candles=_candles(),
        )
    assert "AI_ENGINE_ALLOW_LIVE_MODEL" in str(excinfo.value)


@pytest.mark.asyncio
async def test_live_mode_rejected_when_no_promotion_record(tmp_path, monkeypatch):
    promotion_dir = tmp_path / "promotions"
    registry, _, _, _ = _trained_registry(
        tmp_path, monkeypatch, promotion_dir=promotion_dir
    )

    # Env gate ON, but no promotion record exists for the active model.
    _apply_env(monkeypatch, AI_SIGNAL_MODE="live", AI_ENGINE_ALLOW_LIVE_MODEL="true")

    with pytest.raises(LiveModeNotSupportedError) as excinfo:
        await _make_generator(registry).generate(
            user_id="u1",
            trading_session_id="s1",
            broker_connection_id="c1",
            instrument="EURUSD",
            timeframe="H1",
            candles=_candles(),
        )
    message = str(excinfo.value)
    assert "promotion record" in message
    assert "NO_VALID_PROMOTION_RECORD" in message


@pytest.mark.asyncio
async def test_paper_mode_unaffected_by_live_gates(tmp_path, monkeypatch):
    promotion_dir = tmp_path / "promotions"
    registry, _, _, artifact_sha = _trained_registry(
        tmp_path, monkeypatch, promotion_dir=promotion_dir
    )
    version = registry.get_active_model().get_model_version()
    _write_promotion_record(promotion_dir, version, artifact_sha)

    # Promotion record exists and the env gate could be on, but mode is paper:
    # generation proceeds exactly as before (existing paper gate untouched).
    _apply_env(monkeypatch, AI_SIGNAL_MODE="paper", AI_ENGINE_ALLOW_LIVE_MODEL="true")

    result = await _make_generator(registry).generate(
        user_id="u1",
        trading_session_id="s1",
        broker_connection_id="c1",
        instrument="EURUSD",
        timeframe="H1",
        candles=_candles(),
    )
    assert result.mode == "paper"


@pytest.mark.asyncio
async def test_all_gates_open_live_generation_proceeds(tmp_path, monkeypatch):
    promotion_dir = tmp_path / "promotions"
    registry, _, _, artifact_sha = _trained_registry(
        tmp_path, monkeypatch, promotion_dir=promotion_dir
    )
    version = registry.get_active_model().get_model_version()
    _write_promotion_record(promotion_dir, version, artifact_sha)

    _apply_env(monkeypatch, AI_SIGNAL_MODE="live", AI_ENGINE_ALLOW_LIVE_MODEL="true")

    result = await _make_generator(registry).generate(
        user_id="u1",
        trading_session_id="s1",
        broker_connection_id="c1",
        instrument="EURUSD",
        timeframe="H1",
        candles=_candles(),
    )
    # The live gate is open: no LiveModeNotSupportedError; response echoes live.
    assert result.mode == "live"
    assert result.generated is True
    assert result.signal is not None
    assert result.signal.model_version == version


# ─── API exposure (read-only surface stays read-only) ───────────────────────


@pytest.mark.asyncio
async def test_models_endpoints_expose_live_activation(tmp_path, monkeypatch, client):
    from app.main import app_state

    promotion_dir = tmp_path / "promotions"
    registry, _, _, artifact_sha = _trained_registry(
        tmp_path, monkeypatch, promotion_dir=promotion_dir
    )
    version = registry.get_active_model().get_model_version()
    _write_promotion_record(promotion_dir, version, artifact_sha)

    original_registry = app_state.get("registry")
    app_state["registry"] = registry
    try:
        active = await client.get("/api/v1/models/active")
        assert active.status_code == 200
        body = active.json()
        assert body["live_activation"]["activated"] is True
        assert body["live_activation"]["model_version"] == version
        assert body["approved_for_live"] is False

        listed = await client.get("/api/v1/models")
        assert listed.status_code == 200
        entries = listed.json()
        assert len(entries) == 1
        assert entries[0]["live_activation"]["activated"] is True
        assert entries[0]["approved_for_live"] is False
    finally:
        app_state["registry"] = original_registry


@pytest.mark.asyncio
async def test_models_active_reports_not_activated_truthfully(client):
    # Default registry (scaffold) has no promotion record → truthful reason.
    active = await client.get("/api/v1/models/active")
    assert active.status_code == 200
    live_activation = active.json()["live_activation"]
    assert live_activation["activated"] is False
    assert live_activation["reason"] == "NO_VERIFIED_ARTIFACT"


@pytest.mark.asyncio
async def test_signals_route_403_when_env_gate_closed(client, monkeypatch):
    _apply_env(monkeypatch, AI_SIGNAL_MODE="live", AI_ENGINE_ALLOW_LIVE_MODEL="false")
    response = await client.post(
        "/api/v1/signals/generate",
        json={
            "user_id": "u1",
            "trading_session_id": "s1",
            "broker_connection_id": "c1",
            "instrument": "EURUSD",
            "timeframe": "H1",
        },
    )
    assert response.status_code == 403
    assert "AI_ENGINE_ALLOW_LIVE_MODEL" in response.json()["detail"]


@pytest.mark.asyncio
async def test_signals_route_403_without_promotion_record(client, monkeypatch):
    _apply_env(monkeypatch, AI_SIGNAL_MODE="live", AI_ENGINE_ALLOW_LIVE_MODEL="true")
    response = await client.post(
        "/api/v1/signals/generate",
        json={
            "user_id": "u1",
            "trading_session_id": "s1",
            "broker_connection_id": "c1",
            "instrument": "EURUSD",
            "timeframe": "H1",
        },
    )
    assert response.status_code == 403
    assert "promotion record" in response.json()["detail"]


# ─── No-training-script-self-approval guarantee ─────────────────────────────


def test_training_code_never_references_the_promotion_dir():
    """Source-scan: trainers/model-packaging code can never write the promotion dir."""
    scan_paths = sorted((ENGINE_ROOT / "app" / "domain" / "training").glob("*.py"))
    scan_paths += [
        ENGINE_ROOT / "app" / "domain" / "models" / "baseline_xgboost.py",
        ENGINE_ROOT / "app" / "domain" / "models" / "governance.py",
        ENGINE_ROOT / "app" / "domain" / "models" / "schemas.py",
    ]
    assert len(scan_paths) >= 8  # all trainers + packaging are covered

    for path in scan_paths:
        source = path.read_text(encoding="utf-8")
        for identifier in PROMOTION_DIR_IDENTIFIERS:
            assert identifier not in source, (
                f"{path.name} must never reference promotion identifier "
                f"{identifier!r} — training code must never write or grant "
                "the live promotion directory"
            )

    # Trainers keep hardcoding live approval OFF at the artifact layer.
    for trainer in (
        "train_xgboost.py",
        "train_multitimeframe.py",
        "train_final_multitimeframe.py",
        "run_first_six_pair.py",
    ):
        source = (ENGINE_ROOT / "app" / "domain" / "training" / trainer).read_text(
            encoding="utf-8"
        )
        assert '"approved_for_live": False' in source, (
            f"{trainer} must keep approved_for_live hardcoded False"
        )


def test_promotion_module_documents_no_training_writes():
    source = (ENGINE_ROOT / "app" / "domain" / "models" / "promotion.py").read_text(
        encoding="utf-8"
    )
    assert "training code must never write this directory" in source.lower()


def test_allow_live_model_defaults_false():
    settings = config_module.Settings()
    assert settings.ai_engine_allow_live_model is False
    assert settings.ai_signal_mode == "paper"


def test_default_registry_live_activation_fail_closed(monkeypatch):
    # No env override → default promotion dir (empty in the repo) → not active.
    registry = build_default_registry()
    activation = registry.get_live_activation()
    assert activation["activated"] is False
    assert activation["reason"] == "NO_VERIFIED_ARTIFACT"
