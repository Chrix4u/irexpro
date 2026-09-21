"""Tests for the BLS historical context archive collector."""
from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

import pytest

from app.domain.agents.macro_context import MacroContextEvent
from app.domain.agents.providers.bls_historical_schedule import (
    BlsHistoricalScheduleSnapshot,
    bls_historical_schedule_url,
)
from app.domain.training.agent_context_evaluation import (
    load_historical_macro_events,
)
from app.domain.training.collect_bls_historical_context import (
    _month_range,
    collect_bls_historical_context,
)

COLLECTED_AT = datetime(2026, 9, 21, 3, 50, tzinfo=UTC)


def event(
    *,
    source_event_id: str,
    available_at: datetime,
    scheduled_for: datetime,
    family: str = "CPI",
    title: str = "Consumer Price Index for June 2024",
) -> MacroContextEvent:
    return MacroContextEvent(
        source_id="us_bls",
        source_event_id=source_event_id,
        event_family=family,
        title=title,
        currency="USD",
        impact="HIGH" if family in {"CPI", "EMPLOYMENT_SITUATION"} else "MEDIUM",
        status="SCHEDULED",
        observed_at=available_at,
        available_at=available_at,
        scheduled_for=scheduled_for,
    )


def snapshot(
    *,
    year: int,
    month: int,
    events: tuple[MacroContextEvent, ...],
    governed_rows: int | None = None,
    skipped: int = 0,
) -> BlsHistoricalScheduleSnapshot:
    page_available_at = min(
        (item.available_at for item in events),
        default=datetime(year, month, 1, tzinfo=UTC),
    )
    return BlsHistoricalScheduleSnapshot(
        year=year,
        month=month,
        source_url=bls_historical_schedule_url(year, month),
        fetched_at=COLLECTED_AT,
        page_available_at=page_available_at,
        payload_sha256=f"sha-{year}-{month}",
        governed_rows=governed_rows if governed_rows is not None else len(events) + skipped,
        causally_usable_rows=len(events),
        skipped_retrospective_rows=skipped,
        events=events,
    )


class FakeProvider:
    def __init__(self, snapshots: dict[tuple[int, int], BlsHistoricalScheduleSnapshot]):
        self.snapshots = snapshots
        self.calls: list[tuple[int, int]] = []

    async def fetch_month(
        self,
        *,
        year: int,
        month: int,
    ) -> BlsHistoricalScheduleSnapshot:
        self.calls.append((year, month))
        return self.snapshots[(year, month)]


@pytest.mark.asyncio
async def test_collector_writes_evaluator_compatible_jsonl_and_manifest(tmp_path):
    first_available = datetime(2023, 11, 18, 4, 59, 59, tzinfo=UTC)
    second_available = datetime(2024, 1, 4, 4, 59, 59, tzinfo=UTC)
    july = snapshot(
        year=2024,
        month=7,
        events=(
            event(
                source_event_id="bls-archive:employment",
                family="EMPLOYMENT_SITUATION",
                title="Employment Situation for June 2024",
                available_at=first_available,
                scheduled_for=datetime(2024, 7, 5, 12, 30, tzinfo=UTC),
            ),
            event(
                source_event_id="bls-archive:cpi",
                available_at=first_available,
                scheduled_for=datetime(2024, 7, 11, 12, 30, tzinfo=UTC),
            ),
        ),
    )
    august = snapshot(
        year=2024,
        month=8,
        events=(
            event(
                source_event_id="bls-archive:cpi-aug",
                title="Consumer Price Index for July 2024",
                available_at=second_available,
                scheduled_for=datetime(2024, 8, 14, 12, 30, tzinfo=UTC),
            ),
        ),
        governed_rows=2,
        skipped=1,
    )
    provider = FakeProvider({(2024, 7): july, (2024, 8): august})
    output = tmp_path / "bls_events.jsonl"

    result = await collect_bls_historical_context(
        start_year=2024,
        start_month=7,
        end_year=2024,
        end_month=8,
        output_path=output,
        provider=provider,
        collected_at=COLLECTED_AT,
    )

    assert provider.calls == [(2024, 7), (2024, 8)]
    assert result["event_count"] == 3
    assert result["page_count"] == 2
    assert result["governed_rows"] == 4
    assert result["causally_usable_rows"] == 3
    assert result["skipped_retrospective_rows"] == 1
    assert result["lookahead_allowed"] is False
    assert result["research_only"] is True
    assert result["dataset_sha256"]

    loaded = load_historical_macro_events(output)
    assert [item.source_event_id for item in loaded] == [
        "bls-archive:employment",
        "bls-archive:cpi",
        "bls-archive:cpi-aug",
    ]

    manifest_path = Path(result["manifest_path"])
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert manifest["dataset"] == "bls_historical_macro_context"
    assert manifest["month_count"] == 2
    assert len(manifest["snapshots"]) == 2
    assert manifest["snapshots"][0]["source_url"].endswith(
        "/2024/07_sched_list.htm"
    )
    assert manifest["snapshots"][1]["skipped_retrospective_rows"] == 1


@pytest.mark.asyncio
async def test_collector_preserves_same_release_revisions_for_causal_resolution(
    tmp_path,
):
    first = event(
        source_event_id="bls-archive:stable",
        family="EMPLOYMENT_SITUATION",
        title="Employment Situation for November 2025",
        available_at=datetime(2025, 1, 4, 4, 59, 59, tzinfo=UTC),
        scheduled_for=datetime(2025, 12, 5, 13, 30, tzinfo=UTC),
    )
    revised = event(
        source_event_id="bls-archive:stable",
        family="EMPLOYMENT_SITUATION",
        title="Employment Situation for November 2025",
        available_at=datetime(2025, 11, 21, 4, 59, 59, tzinfo=UTC),
        scheduled_for=datetime(2025, 12, 16, 13, 30, tzinfo=UTC),
    )
    provider = FakeProvider(
        {
            (2025, 11): snapshot(year=2025, month=11, events=(first,)),
            (2025, 12): snapshot(year=2025, month=12, events=(revised,)),
        }
    )
    output = tmp_path / "revisions.jsonl"

    result = await collect_bls_historical_context(
        start_year=2025,
        start_month=11,
        end_year=2025,
        end_month=12,
        output_path=output,
        provider=provider,
        collected_at=COLLECTED_AT,
    )

    assert result["event_count"] == 2
    assert result["unique_release_identity_count"] == 1
    assert result["revision_count"] == 1
    loaded = load_historical_macro_events(output)
    assert loaded[0].source_event_id == loaded[1].source_event_id
    assert loaded[0].available_at < loaded[1].available_at
    assert loaded[0].scheduled_for != loaded[1].scheduled_for


def test_month_range_is_inclusive_cross_year_and_bounded():
    assert _month_range(
        start_year=2024,
        start_month=11,
        end_year=2025,
        end_month=2,
        max_months=12,
    ) == [
        (2024, 11),
        (2024, 12),
        (2025, 1),
        (2025, 2),
    ]

    with pytest.raises(ValueError, match="end month cannot precede start month"):
        _month_range(
            start_year=2025,
            start_month=2,
            end_year=2024,
            end_month=12,
            max_months=12,
        )

    with pytest.raises(ValueError, match="exceeds max_months"):
        _month_range(
            start_year=2024,
            start_month=1,
            end_year=2025,
            end_month=1,
            max_months=12,
        )
