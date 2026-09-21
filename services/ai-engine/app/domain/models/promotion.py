"""
ModelPromotionRecord — operator-authored LIVE promotion records.

RULES:
- Training code must NEVER write this directory. A trainer can never grant
  live approval: the artifact-side `approved_for_live` stays False everywhere
  and the promotion record is the ONLY live-granting mechanism, authored
  OUT-OF-BAND by a human operator (file drop on the host / deployment secret
  store — never via the API, never via training scripts).
- Records carry NO secrets and NO tokens by design: the schema below has no
  field that can hold credentials, and unknown fields invalidate the record.
- Loading is FAIL-CLOSED: any malformed, tampered, duplicated or
  non-matching record is INVALID and never activates live mode. A missing
  promotion directory simply means "no live activation".
- A record only binds a model when its `model_version` AND `artifact_sha256`
  match the registered model's VERIFIED artifact bytes (recomputed at check
  time by the registry). Editing a binding field (artifact_sha256 /
  model_version) therefore breaks the binding and the record stops matching.
- This module only READS the promotion directory. There is deliberately no
  write API in the engine (see the trainer source-scan test in
  tests/test_model_promotion.py).
"""
from __future__ import annotations

import json
import os
import re
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.core.logging import get_logger

logger = get_logger(__name__)

# Environment override for the promotion-record directory.
PROMOTION_DIR_ENV = "AI_MODEL_PROMOTION_DIR"
# Default directory: <ai-engine root>/var/model-promotions
DEFAULT_PROMOTION_DIR = Path(__file__).resolve().parents[3] / "var" / "model-promotions"

_SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")


class ModelPromotionRecord(BaseModel):
    """
    One operator-authored LIVE promotion decision for a specific model
    artifact (identified byte-exactly by its SHA-256).

    Authored out-of-band by an operator; `promoted_by` and `approved_by` may
    differ (e.g. promoted_by = ML engineer, approved_by = legal/compliance).
    No secrets, no tokens — unknown fields make the record INVALID.
    """

    model_config = ConfigDict(extra="forbid")

    record_id: str
    model_version: str
    artifact_sha256: str
    promoted_by: str
    approved_by: str
    reason: str
    created_at: datetime
    supersedes: str | None = None

    @field_validator("record_id")
    @classmethod
    def _record_id_must_be_uuid4(cls, value: str) -> str:
        try:
            parsed = uuid.UUID(value)
        except ValueError as exc:
            raise ValueError("record_id must be a UUID string") from exc
        if parsed.version != 4:
            raise ValueError("record_id must be a UUID4 string")
        return str(parsed)

    @field_validator("model_version")
    @classmethod
    def _model_version_non_empty(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("model_version must be a non-empty string")
        return cleaned

    @field_validator("artifact_sha256")
    @classmethod
    def _artifact_sha_must_be_64_hex(cls, value: str) -> str:
        cleaned = value.strip().lower()
        if not _SHA256_PATTERN.match(cleaned):
            raise ValueError("artifact_sha256 must be a 64-character hex SHA-256")
        return cleaned

    @field_validator("promoted_by", "approved_by", "reason")
    @classmethod
    def _non_empty_operator_fields(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("operator identity and reason must be non-empty")
        return cleaned

    @field_validator("supersedes")
    @classmethod
    def _supersedes_optional_uuid(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("supersedes must be a previous record_id or null")
        try:
            uuid.UUID(cleaned)
        except ValueError as exc:
            raise ValueError("supersedes must be a UUID record_id or null") from exc
        return cleaned


class InvalidPromotionRecord(BaseModel):
    """A promotion record file that failed validation (never crashes the engine)."""

    file: str
    reason: str
    detail: str | None = None
    record_id: str | None = None


class PromotionDirectoryState(BaseModel):
    """Snapshot of the promotion directory after fail-closed validation."""

    directory: str
    valid_records: list[ModelPromotionRecord] = Field(default_factory=list)
    invalid_records: list[InvalidPromotionRecord] = Field(default_factory=list)


def resolve_promotion_dir() -> Path:
    """Resolve the promotion directory (env override, else engine default)."""
    raw = os.getenv(PROMOTION_DIR_ENV, "").strip()
    return Path(raw) if raw else DEFAULT_PROMOTION_DIR


def load_promotion_records(directory: Path | None = None) -> PromotionDirectoryState:
    """
    Read and validate every `*.json` promotion record in the directory.

    FAIL-CLOSED semantics:
    - Missing directory → empty state (no records, no crash).
    - Malformed JSON / schema violation / unreadable file → INVALID entry.
    - A record_id that appears in more than one file → every occurrence is
      INVALID (a duplicated promotion decision cannot be trusted).
    - The engine never mutates anything in this directory.
    """
    target = directory if directory is not None else resolve_promotion_dir()
    state = PromotionDirectoryState(directory=str(target))

    if not target.is_dir():
        logger.info("Model promotion directory not present — no live activation")
        return state

    parsed: list[tuple[str, ModelPromotionRecord | InvalidPromotionRecord]] = []

    for record_file in sorted(target.glob("*.json")):
        invalid = _parse_promotion_file(record_file)
        if invalid is not None:
            parsed.append((record_file.name, invalid))
            continue
        record = _read_validated_record(record_file)
        if record is None:
            # Defensive: file parsed once but cannot be re-read consistently.
            parsed.append(
                (
                    record_file.name,
                    InvalidPromotionRecord(file=record_file.name, reason="UNREADABLE_RECORD"),
                )
            )
        else:
            parsed.append((record_file.name, record))

    # Duplicate record_id invalidates EVERY occurrence of that id.
    id_counts: dict[str, int] = {}
    for _, entry in parsed:
        if isinstance(entry, ModelPromotionRecord):
            id_counts[entry.record_id] = id_counts.get(entry.record_id, 0) + 1

    for filename, entry in parsed:
        if isinstance(entry, ModelPromotionRecord):
            if id_counts[entry.record_id] > 1:
                state.invalid_records.append(
                    InvalidPromotionRecord(
                        file=filename,
                        reason="DUPLICATE_RECORD_ID",
                        record_id=entry.record_id,
                    )
                )
            else:
                state.valid_records.append(entry)
        else:
            state.invalid_records.append(entry)

    if state.invalid_records:
        logger.warning(
            "Invalid model promotion records ignored",
            directory=str(target),
            invalid_count=len(state.invalid_records),
            reasons=[entry.reason for entry in state.invalid_records],
        )

    return state


def _read_validated_record(record_file: Path) -> ModelPromotionRecord | None:
    """Re-read and validate a record file (returns None on any failure)."""
    try:
        payload = json.loads(record_file.read_text(encoding="utf-8"))
        return ModelPromotionRecord.model_validate(payload)
    except Exception:
        return None


def _parse_promotion_file(record_file: Path) -> InvalidPromotionRecord | None:
    """Parse one promotion file; return an InvalidPromotionRecord on failure."""
    try:
        payload = json.loads(record_file.read_text(encoding="utf-8"))
    except Exception as exc:
        return InvalidPromotionRecord(
            file=record_file.name,
            reason="MALFORMED_JSON",
            detail=str(exc)[:300],
        )

    if not isinstance(payload, dict):
        return InvalidPromotionRecord(
            file=record_file.name,
            reason="MALFORMED_JSON",
            detail="record file must contain a JSON object",
        )

    try:
        ModelPromotionRecord.model_validate(payload)
    except Exception as exc:
        return InvalidPromotionRecord(
            file=record_file.name,
            reason="SCHEMA_VALIDATION_FAILED",
            detail=str(exc)[:300],
            record_id=(
                str(payload.get("record_id"))
                if isinstance(payload.get("record_id"), str)
                else None
            ),
        )

    return None


def find_promotion_for_model(
    state: PromotionDirectoryState,
    model_version: str,
    artifact_sha256: str,
) -> ModelPromotionRecord | None:
    """
    Return the valid promotion record binding model_version + artifact_sha256
    exactly, or None. When several valid records bind the same target, the
    most recently created one wins (deterministic; a warning is logged).
    """
    candidates = [
        record
        for record in state.valid_records
        if record.model_version == model_version
        and record.artifact_sha256 == artifact_sha256.lower()
    ]
    if not candidates:
        return None
    if len(candidates) > 1:
        logger.warning(
            "Multiple valid promotion records bind the same model artifact",
            model_version=model_version,
            artifact_sha256=artifact_sha256,
            record_ids=[record.record_id for record in candidates],
        )
    return max(candidates, key=lambda record: (record.created_at, record.record_id))


def promotion_record_to_activation(record: ModelPromotionRecord) -> dict[str, Any]:
    """Project a valid promotion record onto the live-activation response shape."""
    return {
        "record_id": record.record_id,
        "model_version": record.model_version,
        "artifact_sha256": record.artifact_sha256,
        "promoted_by": record.promoted_by,
        "approved_by": record.approved_by,
        "activated_at": record.created_at.isoformat(),
    }
