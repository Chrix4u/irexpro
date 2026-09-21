"""Tests for the official BLS Agent Council calendar adapter."""
from __future__ import annotations

from datetime import UTC, datetime

import httpx
import pytest

from app.domain.agents.providers.bls_calendar import (
    BLS_CALENDAR_URL,
    BlsCalendarProviderError,
    BlsOfficialCalendarProvider,
    parse_bls_calendar,
)

FETCHED_AT = datetime(2026, 9, 1, 12, 0, tzinfo=UTC)


def calendar(*events: str) -> str:
    return "\r\n".join(
        [
            "BEGIN:VCALENDAR",
            "VERSION:2.0",
            "PRODID:-//U.S. Bureau of Labor Statistics//Release Calendar//EN",
            *events,
            "END:VCALENDAR",
            "",
        ]
    )


def vevent(
    *,
    uid: str = "cpi-2026-09@bls.gov",
    dtstart: str = "DTSTART;TZID=America/New_York:20260911T083000",
    summary: str = "Consumer Price Index for August 2026",
    status: str = "CONFIRMED",
) -> str:
    return "\r\n".join(
        [
            "BEGIN:VEVENT",
            f"UID:{uid}",
            dtstart,
            f"SUMMARY:{summary}",
            f"STATUS:{status}",
            "END:VEVENT",
        ]
    )


def test_parser_maps_governed_bls_release_and_preserves_fetch_causality():
    events = parse_bls_calendar(
        calendar(vevent()),
        fetched_at=FETCHED_AT,
    )

    assert len(events) == 1
    item = events[0]
    assert item.source_id == "us_bls"
    assert item.event_family == "CPI"
    assert item.impact == "HIGH"
    assert item.currency == "USD"
    assert item.status == "SCHEDULED"
    assert item.observed_at == FETCHED_AT
    assert item.available_at == FETCHED_AT
    assert item.scheduled_for == datetime(2026, 9, 11, 12, 30, tzinfo=UTC)
    assert item.source_event_id.startswith("bls:")


@pytest.mark.parametrize(
    ("dtstart", "expected"),
    [
        (
            "DTSTART:20261002T083000",
            datetime(2026, 10, 2, 12, 30, tzinfo=UTC),
        ),
        (
            "DTSTART:20261210T083000",
            datetime(2026, 12, 10, 13, 30, tzinfo=UTC),
        ),
        (
            "DTSTART:20260911T123000Z",
            datetime(2026, 9, 11, 12, 30, tzinfo=UTC),
        ),
        (
            "DTSTART;TZID=Eastern Standard Time:20260911T083000",
            datetime(2026, 9, 11, 12, 30, tzinfo=UTC),
        ),
    ],
)
def test_parser_handles_bls_eastern_time_and_dst(dtstart, expected):
    events = parse_bls_calendar(
        calendar(vevent(dtstart=dtstart)),
        fetched_at=FETCHED_AT,
    )

    assert events[0].scheduled_for == expected


def test_parser_uses_governed_impact_policy_and_ignores_unknown_releases():
    events = parse_bls_calendar(
        calendar(
            vevent(
                uid="employment@bls.gov",
                summary="Employment Situation for August 2026",
            ),
            vevent(
                uid="ppi@bls.gov",
                summary="Producer Price Index for August 2026",
            ),
            vevent(
                uid="regional@bls.gov",
                summary="Metropolitan Area Employment and Unemployment for July 2026",
            ),
        ),
        fetched_at=FETCHED_AT,
    )

    assert [(item.event_family, item.impact) for item in events] == [
        ("EMPLOYMENT_SITUATION", "HIGH"),
        ("PPI", "MEDIUM"),
    ]


def test_cancelled_bls_release_maps_to_cancelled_revision():
    events = parse_bls_calendar(
        calendar(vevent(status="CANCELLED")),
        fetched_at=FETCHED_AT,
    )

    assert events[0].status == "CANCELLED"


def test_bls_uid_identity_is_stable_across_reschedules():
    first = parse_bls_calendar(
        calendar(
            vevent(
                uid="stable-release@bls.gov",
                dtstart="DTSTART:20260911T083000",
            )
        ),
        fetched_at=FETCHED_AT,
    )[0]
    revised = parse_bls_calendar(
        calendar(
            vevent(
                uid="stable-release@bls.gov",
                dtstart="DTSTART:20260912T083000",
            )
        ),
        fetched_at=datetime(2026, 9, 2, 12, 0, tzinfo=UTC),
    )[0]

    assert first.source_event_id == revised.source_event_id
    assert first.scheduled_for != revised.scheduled_for
    assert first.available_at < revised.available_at


def test_folded_summary_is_unfolded_before_policy_matching():
    payload = calendar(
        "\r\n".join(
            [
                "BEGIN:VEVENT",
                "UID:folded@bls.gov",
                "DTSTART:20260911T083000",
                "SUMMARY:Consumer Price Index for",
                " August 2026",
                "STATUS:CONFIRMED",
                "END:VEVENT",
            ]
        )
    )

    events = parse_bls_calendar(payload, fetched_at=FETCHED_AT)

    assert len(events) == 1
    assert events[0].title == "Consumer Price Index forAugust 2026"


def test_malformed_governed_release_fails_closed():
    payload = calendar(
        "\r\n".join(
            [
                "BEGIN:VEVENT",
                "DTSTART:20260911T083000",
                "SUMMARY:Consumer Price Index for August 2026",
                "END:VEVENT",
            ]
        )
    )

    with pytest.raises(BlsCalendarProviderError, match="missing UID"):
        parse_bls_calendar(payload, fetched_at=FETCHED_AT)


@pytest.mark.asyncio
async def test_provider_fetches_only_fixed_official_bls_url():
    payload = calendar(vevent())

    def handler(request: httpx.Request) -> httpx.Response:
        assert str(request.url) == BLS_CALENDAR_URL
        assert request.headers["accept"] == "text/calendar"
        assert request.headers["user-agent"] == "iRexPro-AgentCouncil/1.0"
        return httpx.Response(
            200,
            headers={"content-type": "text/calendar; charset=utf-8"},
            content=payload.encode("utf-8"),
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        provider = BlsOfficialCalendarProvider(client)
        events = await provider.fetch(fetched_at=FETCHED_AT)

    assert len(events) == 1
    assert events[0].available_at == FETCHED_AT


@pytest.mark.asyncio
async def test_provider_rejects_unexpected_content_type():
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={"content-type": "text/html"},
            content=b"<html>not a calendar</html>",
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        provider = BlsOfficialCalendarProvider(client)
        with pytest.raises(BlsCalendarProviderError, match="unexpected content type"):
            await provider.fetch(fetched_at=FETCHED_AT)


@pytest.mark.asyncio
async def test_provider_rejects_oversized_calendar_before_parsing():
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={
                "content-type": "text/calendar",
                "content-length": "1500001",
            },
            content=b"BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n",
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        provider = BlsOfficialCalendarProvider(client)
        with pytest.raises(BlsCalendarProviderError, match="exceeds size limit"):
            await provider.fetch(fetched_at=FETCHED_AT)


@pytest.mark.asyncio
async def test_provider_maps_http_failure_without_response_body():
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            503,
            headers={"content-type": "text/plain"},
            content=b"sensitive upstream diagnostic must never appear in error",
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        provider = BlsOfficialCalendarProvider(client)
        with pytest.raises(
            BlsCalendarProviderError,
            match="BLS calendar request returned HTTP 503",
        ) as exc_info:
            await provider.fetch(fetched_at=FETCHED_AT)

    assert "sensitive upstream" not in str(exc_info.value)


@pytest.mark.asyncio
async def test_provider_maps_transport_failure_without_request_details():
    def handler(_request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("socket diagnostic")

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        provider = BlsOfficialCalendarProvider(client)
        with pytest.raises(
            BlsCalendarProviderError,
            match="BLS calendar request failed",
        ) as exc_info:
            await provider.fetch(fetched_at=FETCHED_AT)

    assert "socket diagnostic" not in str(exc_info.value)
