"""Tests for the deterministic adaptive provider backpressure state machine."""
from __future__ import annotations

import pytest

from app.domain.training.adaptive_throttle import (
    AdaptiveFetchThrottle,
    AdaptiveThrottlePolicy,
)


def test_policy_rejects_invalid_bounds():
    with pytest.raises(ValueError, match="min_workers"):
        AdaptiveThrottlePolicy(min_workers=0)
    with pytest.raises(ValueError, match="initial_workers"):
        AdaptiveThrottlePolicy(initial_workers=1, min_workers=2)
    with pytest.raises(ValueError, match="reduce_after_pressure_events"):
        AdaptiveThrottlePolicy(reduce_after_pressure_events=0)
    with pytest.raises(ValueError, match="recover_after_clean_batches"):
        AdaptiveThrottlePolicy(recover_after_clean_batches=0)


def test_level_stays_at_initial_without_pressure():
    throttle = AdaptiveFetchThrottle(AdaptiveThrottlePolicy(initial_workers=3))

    for _ in range(10):
        assert throttle.observe_batch(0) == 3

    assert throttle.level == 3
    assert throttle.telemetry.reductions == 0
    assert throttle.telemetry.recoveries == 0


def test_repeated_pressure_steps_level_down_to_minimum():
    throttle = AdaptiveFetchThrottle(
        AdaptiveThrottlePolicy(initial_workers=3, min_workers=1)
    )

    # Two consecutive pressured batches step 3 -> 2.
    assert throttle.observe_batch(1) == 3
    assert throttle.observe_batch(2) == 2

    # Two more consecutive pressured batches step 2 -> 1.
    assert throttle.observe_batch(1) == 2
    assert throttle.observe_batch(5) == 1

    # The level is bounded at the minimum; no further reduction.
    assert throttle.observe_batch(9) == 1
    assert throttle.observe_batch(9) == 1

    assert throttle.level == 1
    assert throttle.telemetry.reductions == 2
    assert throttle.telemetry.recoveries == 0


def test_sustained_clean_batches_recover_to_initial():
    throttle = AdaptiveFetchThrottle(
        AdaptiveThrottlePolicy(initial_workers=3, min_workers=1)
    )

    throttle.observe_batch(1)
    throttle.observe_batch(1)
    assert throttle.level == 2

    # One clean batch alone does not recover yet.
    assert throttle.observe_batch(0) == 2
    assert throttle.observe_batch(0) == 3

    assert throttle.telemetry.recoveries == 1


def test_alternating_pressure_and_clean_never_moves_level():
    throttle = AdaptiveFetchThrottle(
        AdaptiveThrottlePolicy(initial_workers=3, min_workers=1)
    )

    for _ in range(20):
        assert throttle.observe_batch(1) == 3
        assert throttle.observe_batch(0) == 3

    assert throttle.level == 3
    assert throttle.telemetry.reductions == 0
    assert throttle.telemetry.recoveries == 0


def test_level_never_exceeds_initial_after_recovery():
    throttle = AdaptiveFetchThrottle(
        AdaptiveThrottlePolicy(initial_workers=3, min_workers=1)
    )

    throttle.observe_batch(1)
    throttle.observe_batch(1)
    throttle.observe_batch(1)
    throttle.observe_batch(1)
    assert throttle.level == 1

    for _ in range(10):
        throttle.observe_batch(0)

    assert throttle.level == 3
    assert throttle.telemetry.recoveries == 2


def test_level_changes_emit_deterministic_callbacks():
    changes: list[tuple[int, int, str]] = []
    throttle = AdaptiveFetchThrottle(
        AdaptiveThrottlePolicy(initial_workers=3, min_workers=1),
        on_change=lambda old, new, reason: changes.append((old, new, reason)),
    )

    throttle.observe_batch(4)
    throttle.observe_batch(4)
    throttle.observe_batch(0)
    throttle.observe_batch(0)

    assert changes == [
        (3, 2, "transient_provider_pressure"),
        (2, 3, "sustained_healthy_batches"),
    ]
    assert throttle.telemetry.final_level == 3


def test_negative_pressure_events_rejected():
    throttle = AdaptiveFetchThrottle()
    with pytest.raises(ValueError, match="cannot be negative"):
        throttle.observe_batch(-1)


def test_single_worker_policy_cannot_throttle_below_one():
    throttle = AdaptiveFetchThrottle(
        AdaptiveThrottlePolicy(initial_workers=1, min_workers=1)
    )

    for _ in range(6):
        assert throttle.observe_batch(3) == 1

    assert throttle.telemetry.reductions == 0
