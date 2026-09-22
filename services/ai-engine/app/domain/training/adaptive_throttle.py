"""Deterministic adaptive provider backpressure for the Dukascopy collector.

The public datafeed occasionally returns transient 429/5xx responses or
transport errors under concurrency. The existing collector already bounds
concurrency and retries per hour; this module adds a deterministic, bounded,
fully testable throttle that steps worker parallelism down under sustained
provider pressure and back up after sustained healthy batches::

    normal:            3 workers
    repeated pressure: 3 -> 2 -> 1
    sustained health:  1 -> 2 -> 3

There is no randomness, no wall-clock heuristics, and no unbounded sleeping:
the level is a pure function of the per-batch pressure/clean counters, the
level is always bounded to ``[min_workers, initial_workers]``, and unresolved
hours still fail closed exactly as before.
"""
from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass


@dataclass(frozen=True)
class AdaptiveThrottlePolicy:
    """Explicit, typed policy for adaptive worker throttling.

    ``reduce_after_pressure_events``: number of *consecutive* pressured
    batches (any transient retry event or failed hour) before stepping the
    worker level down by one.

    ``recover_after_clean_batches``: number of *consecutive* fully clean
    batches (no retries, no failures) before stepping the worker level up
    by one.
    """

    initial_workers: int = 3
    min_workers: int = 1
    reduce_after_pressure_events: int = 2
    recover_after_clean_batches: int = 2

    def __post_init__(self) -> None:
        if self.min_workers < 1:
            raise ValueError("min_workers must be at least 1")
        if self.initial_workers < self.min_workers:
            raise ValueError("initial_workers must be >= min_workers")
        if self.reduce_after_pressure_events < 1:
            raise ValueError("reduce_after_pressure_events must be at least 1")
        if self.recover_after_clean_batches < 1:
            raise ValueError("recover_after_clean_batches must be at least 1")


@dataclass
class ThrottleTelemetry:
    """Counters exposed through research collection telemetry."""

    reductions: int = 0
    recoveries: int = 0
    final_level: int = 0


class AdaptiveFetchThrottle:
    """Bounded deterministic worker-level state machine.

    ``observe_batch(pressure_events)`` is called once per completed fetch
    batch with the number of transient retry events plus failed hours seen in
    that batch. A positive count marks the batch pressured; zero marks it
    clean. Consecutive counters reset whenever the observation kind changes.
    """

    def __init__(
        self,
        policy: AdaptiveThrottlePolicy | None = None,
        *,
        on_change: Callable[[int, int, str], None] | None = None,
    ) -> None:
        self.policy = policy or AdaptiveThrottlePolicy()
        self._level = self.policy.initial_workers
        self._consecutive_pressured = 0
        self._consecutive_clean = 0
        self._on_change = on_change
        self.telemetry = ThrottleTelemetry(final_level=self._level)

    @property
    def level(self) -> int:
        return self._level

    def _apply(self, new_level: int, reason: str) -> None:
        old_level = self._level
        self._level = new_level
        self.telemetry.final_level = new_level
        if new_level < old_level:
            self.telemetry.reductions += 1
        elif new_level > old_level:
            self.telemetry.recoveries += 1
        if self._on_change is not None and new_level != old_level:
            self._on_change(old_level, new_level, reason)

    def observe_batch(self, pressure_events: int) -> int:
        """Record one batch outcome and return the level for the next batch."""
        if pressure_events < 0:
            raise ValueError("pressure_events cannot be negative")
        if pressure_events > 0:
            self._consecutive_pressured += 1
            self._consecutive_clean = 0
            if (
                self._consecutive_pressured
                >= self.policy.reduce_after_pressure_events
                and self._level > self.policy.min_workers
            ):
                self._consecutive_pressured = 0
                self._apply(
                    self._level - 1,
                    "transient_provider_pressure",
                )
        else:
            self._consecutive_clean += 1
            self._consecutive_pressured = 0
            if (
                self._consecutive_clean >= self.policy.recover_after_clean_batches
                and self._level < self.policy.initial_workers
            ):
                self._consecutive_clean = 0
                self._apply(
                    self._level + 1,
                    "sustained_healthy_batches",
                )
        return self._level
