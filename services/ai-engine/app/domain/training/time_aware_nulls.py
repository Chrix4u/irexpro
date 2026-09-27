"""Time-aware null-test helpers for financial model research.

These helpers intentionally avoid IID row shuffling. Circular and block-wise
target permutations preserve more temporal structure and are intended for
research-only null experiments on pre-boundary data.
"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass

import numpy as np


@dataclass(frozen=True)
class NullPermutation:
    method: str
    seed: int
    shift_or_block_size: int
    indices_sha256: str
    indices: np.ndarray


def _digest_indices(indices: np.ndarray) -> str:
    values = np.asarray(indices, dtype=np.int64)
    return hashlib.sha256(values.tobytes()).hexdigest()


def circular_shift_indices(
    length: int,
    *,
    seed: int,
    min_shift_fraction: float = 0.10,
) -> NullPermutation:
    """Return a deterministic non-trivial circular shift of chronological labels."""
    if length < 10:
        raise ValueError("length must be at least 10")
    if not 0.0 < min_shift_fraction < 0.5:
        raise ValueError("min_shift_fraction must be between 0 and 0.5")
    minimum = max(1, int(length * min_shift_fraction))
    maximum = length - minimum
    if maximum <= minimum:
        raise ValueError("length too small for requested shift separation")
    rng = np.random.default_rng(seed)
    shift = int(rng.integers(minimum, maximum))
    indices = np.roll(np.arange(length, dtype=np.int64), shift)
    return NullPermutation(
        method="circular_shift",
        seed=int(seed),
        shift_or_block_size=shift,
        indices_sha256=_digest_indices(indices),
        indices=indices,
    )


def block_permutation_indices(
    length: int,
    *,
    seed: int,
    block_size: int,
) -> NullPermutation:
    """Permute contiguous chronological blocks while preserving within-block order."""
    if length < 2:
        raise ValueError("length must be at least 2")
    if block_size < 2:
        raise ValueError("block_size must be at least 2")
    if block_size >= length:
        raise ValueError("block_size must be smaller than length")

    blocks = [
        np.arange(start, min(start + block_size, length), dtype=np.int64)
        for start in range(0, length, block_size)
    ]
    rng = np.random.default_rng(seed)
    order = rng.permutation(len(blocks))
    indices = np.concatenate([blocks[int(i)] for i in order])
    return NullPermutation(
        method="block_permutation",
        seed=int(seed),
        shift_or_block_size=int(block_size),
        indices_sha256=_digest_indices(indices),
        indices=indices,
    )


def empirical_right_tail_p_value(
    observed: float,
    null_values: list[float] | np.ndarray,
) -> float:
    """Finite-sample corrected right-tail empirical p-value."""
    values = np.asarray(null_values, dtype=float)
    if values.size < 1:
        raise ValueError("null_values must be non-empty")
    if not np.isfinite(values).all() or not np.isfinite(observed):
        raise ValueError("observed and null_values must be finite")
    exceedances = int((values >= float(observed)).sum())
    return float((exceedances + 1) / (values.size + 1))


def null_summary(
    observed: float,
    null_values: list[float] | np.ndarray,
) -> dict[str, float | int]:
    values = np.asarray(null_values, dtype=float)
    if values.size < 1:
        raise ValueError("null_values must be non-empty")
    return {
        "observed": float(observed),
        "null_count": int(values.size),
        "null_mean": float(values.mean()),
        "null_median": float(np.median(values)),
        "null_p90": float(np.quantile(values, 0.90)),
        "null_p95": float(np.quantile(values, 0.95)),
        "null_p99": float(np.quantile(values, 0.99)),
        "empirical_right_tail_p_value": empirical_right_tail_p_value(
            observed,
            values,
        ),
    }
