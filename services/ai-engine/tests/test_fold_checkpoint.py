from __future__ import annotations

import pytest

from app.domain.training.fold_checkpoint import (
    load_fold_checkpoint,
    research_fingerprint,
    save_fold_checkpoint,
)


def test_fold_checkpoint_round_trip(tmp_path) -> None:
    fingerprint = research_fingerprint(
        experiment="v14",
        candidate_sha="abc",
        dataset_hashes={"USDJPY": "123"},
        decision_time_before="2026-09-27T05:00:00+00:00",
        horizon_bars=1,
    )
    save_fold_checkpoint(
        tmp_path,
        fingerprint=fingerprint,
        fold_index=1,
        fold_report={"fold": 1, "value": 42},
    )
    loaded = load_fold_checkpoint(
        tmp_path,
        fingerprint=fingerprint,
        fold_index=1,
    )
    assert loaded == {"fold": 1, "value": 42}


def test_fold_checkpoint_rejects_wrong_fingerprint(tmp_path) -> None:
    save_fold_checkpoint(
        tmp_path,
        fingerprint="good",
        fold_index=1,
        fold_report={"fold": 1},
    )
    with pytest.raises(ValueError, match="fingerprint mismatch"):
        load_fold_checkpoint(
            tmp_path,
            fingerprint="bad",
            fold_index=1,
        )
