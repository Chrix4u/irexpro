from __future__ import annotations

import numpy as np

from app.domain.training.time_aware_nulls import (
    block_permutation_indices,
    circular_shift_indices,
    empirical_right_tail_p_value,
    null_summary,
)


def test_circular_shift_is_deterministic_and_non_identity() -> None:
    first = circular_shift_indices(100, seed=7)
    second = circular_shift_indices(100, seed=7)
    assert np.array_equal(first.indices, second.indices)
    assert not np.array_equal(first.indices, np.arange(100))
    assert first.indices_sha256 == second.indices_sha256


def test_block_permutation_preserves_all_indices() -> None:
    result = block_permutation_indices(103, seed=11, block_size=10)
    assert sorted(result.indices.tolist()) == list(range(103))
    assert result.shift_or_block_size == 10


def test_empirical_p_value_has_finite_sample_correction() -> None:
    assert empirical_right_tail_p_value(10.0, [1.0, 2.0, 3.0]) == 0.25


def test_null_summary_reports_upper_quantiles() -> None:
    summary = null_summary(5.0, [1.0, 2.0, 3.0, 4.0])
    assert summary["observed"] == 5.0
    assert summary["null_count"] == 4
    assert summary["null_p95"] >= summary["null_p90"]
