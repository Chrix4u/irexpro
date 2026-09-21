"""Tests for the official BLS historical monthly schedule provider."""
from __future__ import annotations

from datetime import UTC, datetime

import httpx
import pytest

from app.domain.agents.providers import bls_historical_schedule
from app.domain.agents.providers.bls_historical_schedule import (
    BlsHistoricalScheduleError,
    BlsHistoricalScheduleProvider,
    bls_historical_schedule_url,
    parse_bls_historical_schedule,
)

FETCHED_AT = datetime(2026, 9, 21, 3, 30, tzinfo=UTC)


def page(
    *rows: str,
    last_modified: str = "November 17, 2023",
) -> str:
    return f"""
<!doctype html>
<html>
  <head><title>BLS schedule</title></head>
  <body>
    <h1>Schedule of Selected Releases</h1>
    <table>
      <thead><tr><th>Date</th><th>Time</th><th>Release</th></tr></thead>
      <tbody>
        {"".join(rows)}
      </tbody>
    </table>
    <p>NOTE: All times on calendar are Eastern Time.</p>
    <div>Last Modified Date: {last_modified}</div>
  </body>
</html>
"""


def row(date_text: str, time_text: str, release: str) -> str:
    return (
        "<tr>"
        f"<td>{date_text}</td>"
        f"<td>{time_text}</td>"
        f"<td><a href=\"#\">{release}</a></td>"
        "</tr>"
    )


def test_parser_reuses_governed_policy_and_converts_eastern_to_utc():
    snapshot = parse_bls_historical_schedule(
        page(
            row(
                "Friday, July 5, 2024",
                "08:30 AM",
                "Employment Situation for June 2024",
            ),
            row(
                "Thursday, July 11, 2024",
                "08:30 AM",
                "Consumer Price Index for June 2024",
            ),
            row(
                "Friday, July 12, 2024",
                "08:30 AM",
                "Producer Price Index for June 2024",
            ),
            row(
                "Wednesday, July 31, 2024",
                "08:30 AM",
                "Employment Cost Index for Second Quarter 2024",
            ),
            row(
                "Friday, July 19, 2024",
                "10:00 AM",
                "State Employment and Unemployment (Monthly) for June 2024",
            ),
        ),
        year=2024,
        month=7,
        fetched_at=FETCHED_AT,
    )

    assert snapshot.governed_rows == 4
    assert snapshot.causally_usable_rows == 4
    assert snapshot.skipped_retrospective_rows == 0
    assert snapshot.page_available_at == datetime(
        2023,
        11,
        18,
        4,
        59,
        59,
        999999,
        tzinfo=UTC,
    )
    assert [
        (event.event_family, event.impact)
        for event in snapshot.events
    ] == [
        ("EMPLOYMENT_SITUATION", "HIGH"),
        ("CPI", "HIGH"),
        ("PPI", "MEDIUM"),
        ("EMPLOYMENT_COST_INDEX", "MEDIUM"),
    ]
    assert snapshot.events[0].scheduled_for == datetime(
        2024,
        7,
        5,
        12,
        30,
        tzinfo=UTC,
    )
    assert all(
        event.available_at == snapshot.page_available_at
        for event in snapshot.events
    )
    assert all(event.source_id == "us_bls" for event in snapshot.events)


def test_parser_skips_rows_that_snapshot_cannot_prove_were_known_pre_event():
    snapshot = parse_bls_historical_schedule(
        page(
            row(
                "Tuesday, April 2, 2024",
                "10:00 AM",
                "Job Openings and Labor Turnover Survey for February 2024",
            ),
            row(
                "Friday, April 5, 2024",
                "08:30 AM",
                "Employment Situation for March 2024",
            ),
            row(
                "Wednesday, April 10, 2024",
                "08:30 AM",
                "Consumer Price Index for March 2024",
            ),
            last_modified="April 04, 2024",
        ),
        year=2024,
        month=4,
        fetched_at=FETCHED_AT,
    )

    assert snapshot.governed_rows == 3
    assert snapshot.skipped_retrospective_rows == 1
    assert snapshot.causally_usable_rows == 2
    assert [event.event_family for event in snapshot.events] == [
        "EMPLOYMENT_SITUATION",
        "CPI",
    ]
    assert all(
        event.available_at < event.scheduled_for
        for event in snapshot.events
    )


def test_historical_identity_is_stable_across_same_release_reschedule():
    first = parse_bls_historical_schedule(
        page(
            row(
                "Friday, December 5, 2025",
                "08:30 AM",
                "Employment Situation for November 2025",
            ),
            last_modified="January 03, 2025",
        ),
        year=2025,
        month=12,
        fetched_at=FETCHED_AT,
    ).events[0]
    revised = parse_bls_historical_schedule(
        page(
            row(
                "Tuesday, December 16, 2025",
                "08:30 AM",
                "Employment Situation for November 2025",
            ),
            last_modified="January 04, 2025",
        ),
        year=2025,
        month=12,
        fetched_at=FETCHED_AT,
    ).events[0]

    assert first.source_event_id == revised.source_event_id
    assert first.scheduled_for != revised.scheduled_for


def test_parser_fails_closed_without_one_unambiguous_last_modified_date():
    payload = page(
        row(
            "Friday, July 5, 2024",
            "08:30 AM",
            "Employment Situation for June 2024",
        )
    ).replace("Last Modified Date: November 17, 2023", "")

    with pytest.raises(
        BlsHistoricalScheduleError,
        match="missing an official Last Modified Date",
    ):
        parse_bls_historical_schedule(
            payload,
            year=2024,
            month=7,
            fetched_at=FETCHED_AT,
        )

    conflicting = page(
        row(
            "Friday, July 5, 2024",
            "08:30 AM",
            "Employment Situation for June 2024",
        )
    ).replace(
        "</body>",
        "<div>Last Modified Date: November 18, 2023</div></body>",
    )
    with pytest.raises(
        BlsHistoricalScheduleError,
        match="conflicting Last Modified Date",
    ):
        parse_bls_historical_schedule(
            conflicting,
            year=2024,
            month=7,
            fetched_at=FETCHED_AT,
        )


def test_parser_rejects_governed_release_outside_requested_month():
    with pytest.raises(
        BlsHistoricalScheduleError,
        match="outside the requested month",
    ):
        parse_bls_historical_schedule(
            page(
                row(
                    "Friday, August 2, 2024",
                    "08:30 AM",
                    "Employment Situation for July 2024",
                )
            ),
            year=2024,
            month=7,
            fetched_at=FETCHED_AT,
        )


def test_parser_rejects_duplicate_release_identity():
    duplicate = row(
        "Friday, July 5, 2024",
        "08:30 AM",
        "Employment Situation for June 2024",
    )
    with pytest.raises(
        BlsHistoricalScheduleError,
        match="duplicate governed release identities",
    ):
        parse_bls_historical_schedule(
            page(duplicate, duplicate),
            year=2024,
            month=7,
            fetched_at=FETCHED_AT,
        )


@pytest.mark.parametrize(
    ("year", "month"),
    [(1999, 1), (2101, 1), (2024, 0), (2024, 13), (True, 1)],
)
def test_fixed_historical_url_rejects_invalid_year_month(year, month):
    with pytest.raises(ValueError):
        bls_historical_schedule_url(year, month)


@pytest.mark.asyncio
async def test_provider_fetches_only_fixed_official_bls_month_url():
    expected_url = "https://www.bls.gov/schedule/2024/07_sched_list.htm"
    payload = page(
        row(
            "Friday, July 5, 2024",
            "08:30 AM",
            "Employment Situation for June 2024",
        )
    )

    def handler(request: httpx.Request) -> httpx.Response:
        assert str(request.url) == expected_url
        assert request.headers["user-agent"] == "iRexPro-AgentCouncil-Research/1.0"
        return httpx.Response(
            200,
            headers={"content-type": "text/html; charset=utf-8"},
            content=payload.encode("utf-8"),
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        snapshot = await BlsHistoricalScheduleProvider(client).fetch_month(
            year=2024,
            month=7,
        )

    assert snapshot.source_url == expected_url
    assert len(snapshot.events) == 1
    assert snapshot.payload_sha256


@pytest.mark.asyncio
async def test_provider_uses_official_page_availability_not_current_fetch_time(
    monkeypatch,
):
    payload = page(
        row(
            "Friday, July 5, 2024",
            "08:30 AM",
            "Employment Situation for June 2024",
        )
    )
    current_fetch = datetime(2026, 9, 21, 3, 40, tzinfo=UTC)

    class FixedDateTime(datetime):
        @classmethod
        def now(cls, tz=None):
            return current_fetch

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={"content-type": "text/html"},
            content=payload.encode("utf-8"),
        )

    monkeypatch.setattr(bls_historical_schedule, "datetime", FixedDateTime)
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        snapshot = await BlsHistoricalScheduleProvider(client).fetch_month(
            year=2024,
            month=7,
        )

    assert snapshot.fetched_at == current_fetch
    assert snapshot.events[0].available_at < current_fetch
    assert snapshot.events[0].available_at == snapshot.page_available_at


@pytest.mark.asyncio
async def test_provider_rejects_unexpected_content_type_and_oversized_page():
    async def run(response: httpx.Response) -> None:
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(lambda _request: response)
        ) as client:
            await BlsHistoricalScheduleProvider(client).fetch_month(
                year=2024,
                month=7,
            )

    with pytest.raises(
        BlsHistoricalScheduleError,
        match="unexpected content type",
    ):
        await run(
            httpx.Response(
                200,
                headers={"content-type": "application/json"},
                content=b"{}",
            )
        )

    with pytest.raises(
        BlsHistoricalScheduleError,
        match="exceeds size limit",
    ):
        await run(
            httpx.Response(
                200,
                headers={
                    "content-type": "text/html",
                    "content-length": "1500001",
                },
                content=b"<html></html>",
            )
        )
