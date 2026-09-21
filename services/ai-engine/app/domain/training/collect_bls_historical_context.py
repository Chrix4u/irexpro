"""Collect causal BLS historical monthly schedule snapshots for research."""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from app.domain.agents.macro_context import MacroContextEvent
from app.domain.agents.providers.bls_historical_schedule import (
    BlsHistoricalScheduleProvider,
    BlsHistoricalScheduleSnapshot,
)


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _month_index(year: int, month: int) -> int:
    if isinstance(year, bool) or not isinstance(year, int) or not 2000 <= year <= 2100:
        raise ValueError("year must be an integer between 2000 and 2100")
    if isinstance(month, bool) or not isinstance(month, int) or not 1 <= month <= 12:
        raise ValueError("month must be an integer between 1 and 12")
    return year * 12 + month - 1


def _month_range(
    *,
    start_year: int,
    start_month: int,
    end_year: int,
    end_month: int,
    max_months: int,
) -> list[tuple[int, int]]:
    start = _month_index(start_year, start_month)
    end = _month_index(end_year, end_month)
    if end < start:
        raise ValueError("end month cannot precede start month")
    if isinstance(max_months, bool) or not isinstance(max_months, int) or max_months < 1:
        raise ValueError("max_months must be a positive integer")

    count = end - start + 1
    if count > max_months:
        raise ValueError(
            f"requested {count} months exceeds max_months={max_months}"
        )

    result: list[tuple[int, int]] = []
    for value in range(start, end + 1):
        year, zero_based_month = divmod(value, 12)
        result.append((year, zero_based_month + 1))
    return result


def _event_sort_key(event: MacroContextEvent) -> tuple[datetime, datetime, str]:
    return (
        event.available_at.astimezone(UTC),
        event.scheduled_for.astimezone(UTC),
        event.source_event_id,
    )


def _snapshot_manifest(
    snapshot: BlsHistoricalScheduleSnapshot,
) -> dict[str, Any]:
    return {
        "year": snapshot.year,
        "month": snapshot.month,
        "source_url": snapshot.source_url,
        "fetched_at": snapshot.fetched_at.isoformat(),
        "official_page_available_at": snapshot.page_available_at.isoformat(),
        "payload_sha256": snapshot.payload_sha256,
        "governed_rows": snapshot.governed_rows,
        "causally_usable_rows": snapshot.causally_usable_rows,
        "skipped_retrospective_rows": snapshot.skipped_retrospective_rows,
    }


async def collect_bls_historical_context(
    *,
    start_year: int,
    start_month: int,
    end_year: int,
    end_month: int,
    output_path: str | Path,
    provider: BlsHistoricalScheduleProvider | None = None,
    max_months: int = 120,
    collected_at: datetime | None = None,
) -> dict[str, Any]:
    """Fetch official BLS monthly pages and persist a causal JSONL event archive."""
    months = _month_range(
        start_year=start_year,
        start_month=start_month,
        end_year=end_year,
        end_month=end_month,
        max_months=max_months,
    )
    observed_at = collected_at or datetime.now(UTC)
    if observed_at.tzinfo is None or observed_at.utcoffset() is None:
        raise ValueError("collected_at must be timezone-aware")

    source = provider or BlsHistoricalScheduleProvider()
    snapshots: list[BlsHistoricalScheduleSnapshot] = []
    events: list[MacroContextEvent] = []

    for year, month in months:
        snapshot = await source.fetch_month(year=year, month=month)
        snapshots.append(snapshot)
        events.extend(snapshot.events)

    events.sort(key=_event_sort_key)

    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("w", encoding="utf-8", newline="\n") as handle:
        for event in events:
            handle.write(
                json.dumps(
                    event.model_dump(mode="json"),
                    sort_keys=True,
                    separators=(",", ":"),
                )
            )
            handle.write("\n")

    event_ids = [event.source_event_id for event in events]
    unique_ids = set(event_ids)
    manifest = {
        "manifest_version": 1,
        "dataset": "bls_historical_macro_context",
        "source": "official_bls_monthly_release_schedule",
        "research_only": True,
        "lookahead_allowed": False,
        "availability_policy": (
            "official monthly page Last Modified Date interpreted as end-of-day "
            "America/New_York; governed releases at/before that conservative "
            "availability timestamp are excluded as retrospective"
        ),
        "start_year": start_year,
        "start_month": start_month,
        "end_year": end_year,
        "end_month": end_month,
        "month_count": len(months),
        "page_count": len(snapshots),
        "event_count": len(events),
        "unique_release_identity_count": len(unique_ids),
        "revision_count": len(events) - len(unique_ids),
        "governed_rows": sum(item.governed_rows for item in snapshots),
        "causally_usable_rows": sum(
            item.causally_usable_rows for item in snapshots
        ),
        "skipped_retrospective_rows": sum(
            item.skipped_retrospective_rows for item in snapshots
        ),
        "collected_at": observed_at.astimezone(UTC).isoformat(),
        "dataset_sha256": _sha256_file(output),
        "snapshots": [_snapshot_manifest(item) for item in snapshots],
    }

    manifest_path = output.with_suffix(".manifest.json")
    manifest_path.write_text(
        json.dumps(manifest, indent=2, sort_keys=True),
        encoding="utf-8",
    )
    return {
        **manifest,
        "dataset_path": str(output),
        "manifest_path": str(manifest_path),
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description=(
            "Collect causal official BLS historical monthly release schedules "
            "for Agent Council research"
        )
    )
    parser.add_argument("--start-year", type=int, required=True)
    parser.add_argument("--start-month", type=int, required=True)
    parser.add_argument("--end-year", type=int, required=True)
    parser.add_argument("--end-month", type=int, required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--max-months", type=int, default=120)
    args = parser.parse_args()

    result = asyncio.run(
        collect_bls_historical_context(
            start_year=args.start_year,
            start_month=args.start_month,
            end_year=args.end_year,
            end_month=args.end_month,
            output_path=args.output,
            max_months=args.max_months,
        )
    )
    print(json.dumps(result, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
