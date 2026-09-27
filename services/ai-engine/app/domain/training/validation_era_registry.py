"""Guard against accidental reuse of exposed outer-validation eras."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

import pandas as pd


@dataclass(frozen=True)
class ValidationEra:
    candidate: str
    start: pd.Timestamp
    end: pd.Timestamp

    @classmethod
    def from_strings(
        cls,
        *,
        candidate: str,
        start: str,
        end: str,
    ) -> "ValidationEra":
        start_ts = pd.Timestamp(start)
        end_ts = pd.Timestamp(end)
        if start_ts.tzinfo is None:
            start_ts = start_ts.tz_localize("UTC")
        else:
            start_ts = start_ts.tz_convert("UTC")
        if end_ts.tzinfo is None:
            end_ts = end_ts.tz_localize("UTC")
        else:
            end_ts = end_ts.tz_convert("UTC")
        if end_ts < start_ts:
            raise ValueError("validation era end must be >= start")
        return cls(candidate=candidate, start=start_ts, end=end_ts)


def eras_overlap(left: ValidationEra, right: ValidationEra) -> bool:
    return not (left.end < right.start or right.end < left.start)


def assert_disjoint_validation_era(
    candidate: ValidationEra,
    exposed: list[ValidationEra],
) -> None:
    collisions = [
        era.candidate
        for era in exposed
        if eras_overlap(candidate, era)
    ]
    if collisions:
        raise ValueError(
            f"{candidate.candidate} outer validation overlaps exposed eras: "
            + ", ".join(sorted(collisions))
        )


def iso_interval(era: ValidationEra) -> str:
    return f"{era.start.isoformat()}..{era.end.isoformat()}"
