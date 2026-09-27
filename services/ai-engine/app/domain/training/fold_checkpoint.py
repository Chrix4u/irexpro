"""Deterministic fold checkpoint helpers for long-running research jobs."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any


def research_fingerprint(
    *,
    experiment: str,
    candidate_sha: str,
    dataset_hashes: dict[str, str],
    decision_time_before: str,
    horizon_bars: int,
) -> str:
    payload = {
        "experiment": experiment,
        "candidate_sha": candidate_sha,
        "dataset_hashes": dict(sorted(dataset_hashes.items())),
        "decision_time_before": decision_time_before,
        "horizon_bars": int(horizon_bars),
    }
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()


def save_fold_checkpoint(
    directory: str | Path,
    *,
    fingerprint: str,
    fold_index: int,
    fold_report: dict[str, Any],
) -> Path:
    root = Path(directory)
    root.mkdir(parents=True, exist_ok=True)
    path = root / f"fold-{fold_index:02d}.json"
    payload = {
        "fingerprint": fingerprint,
        "fold": int(fold_index),
        "report": fold_report,
    }
    temp = path.with_suffix(".json.tmp")
    temp.write_text(
        json.dumps(payload, indent=2, sort_keys=True, default=str),
        encoding="utf-8",
    )
    temp.replace(path)
    return path


def load_fold_checkpoint(
    directory: str | Path,
    *,
    fingerprint: str,
    fold_index: int,
) -> dict[str, Any] | None:
    path = Path(directory) / f"fold-{fold_index:02d}.json"
    if not path.exists():
        return None
    payload = json.loads(path.read_text(encoding="utf-8"))
    if payload.get("fingerprint") != fingerprint:
        raise ValueError(f"checkpoint fingerprint mismatch for fold {fold_index}")
    if int(payload.get("fold", -1)) != int(fold_index):
        raise ValueError(f"checkpoint fold mismatch for fold {fold_index}")
    report = payload.get("report")
    if not isinstance(report, dict):
        raise ValueError(f"checkpoint report missing for fold {fold_index}")
    return report
