from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime
from pathlib import Path

from app.api.v1.routes.models import (
    PostEntryBrokerScoreRequest,
    score_plan_b_v85_broker_checkpoint,
)
from app.domain.models.post_entry_protection_challenger import (
    PlanBV85PostEntryProtectionChallenger,
)


class FakeClassifier:
    def __init__(self, probability: float) -> None:
        self.probability = probability

    def predict_proba(self, frame):
        return [[1.0 - self.probability, self.probability]]


def _manual_challenger(probability: float = 0.8) -> PlanBV85PostEntryProtectionChallenger:
    model = PlanBV85PostEntryProtectionChallenger()
    model._loaded = True
    model._features = ["current_r"]
    model._model = FakeClassifier(probability)
    model._manifest = {
        "artifact": "plan-b-v85-profitable-state-giveback-classifier-v1",
        "mode": "PROSPECTIVE_SHADOW_ONLY",
        "training_contract": {
            "snapshot_minutes": [5, 10, 15, 30, 60, 120, 240],
            "minimum_current_profit_r": 0.25,
            "giveback_label_r": 0.4,
            "probability_threshold": 0.6,
        },
        "development_evidence": {},
        "sealed_future_holdout_touched": False,
    }
    return model


def test_manifest_pin_is_required(tmp_path: Path):
    manifest = tmp_path / "manifest.json"
    manifest.write_text("{}")

    challenger = PlanBV85PostEntryProtectionChallenger(manifest)

    assert challenger.loaded is False
    assert challenger.load_error is not None
    assert "SHA-256 pin is required" in challenger.load_error


def test_manifest_hash_mismatch_fails_closed(tmp_path: Path):
    manifest = tmp_path / "manifest.json"
    manifest.write_text("{}")

    challenger = PlanBV85PostEntryProtectionChallenger(
        manifest,
        "0" * 64,
    )

    assert challenger.loaded is False
    assert challenger.load_error is not None
    assert "SHA-256 mismatch" in challenger.load_error


def test_protect_shadow_never_claims_execution_authority():
    challenger = _manual_challenger(0.8)

    result = challenger.score({"current_r": 0.6})

    assert result["action"] == "PROTECT_SHADOW"
    assert result["modifies_execution"] is False
    assert result["execution_authority"] == "NONE"
    assert result["paper_promotion_eligible"] is False


async def test_future_checkpoint_returns_without_fetching_market_data():
    challenger = _manual_challenger()

    class NoFetch:
        async def get_ohlcv(self, **kwargs):
            raise AssertionError("future checkpoint must not fetch broker data")

    request = PostEntryBrokerScoreRequest(
        user_id="user-1",
        broker_connection_id="conn-1",
        instrument="EURUSD",
        direction="BUY",
        entry_price=1.1000,
        stop_loss=1.0990,
        opened_at=datetime.now(UTC),
        checkpoint_minutes=60,
        confidence=0.7,
        candidate_score=0.6,
        extension_atr=0.8,
        volatility_score=0.2,
        ema_separation=0.3,
        mtf_strength=0.4,
        rsi14=55,
    )

    result = await score_plan_b_v85_broker_checkpoint(
        request,
        challenger,
        NoFetch(),
    )

    assert result["state"] == "NOT_YET_ELIGIBLE"
    assert result["reason"] == "CHECKPOINT_NOT_REACHED"
    assert result["score"] is None
