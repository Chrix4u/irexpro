"""Official U.S. BLS release-calendar adapter for Agent Council context."""
from __future__ import annotations

import hashlib
from datetime import UTC, datetime
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import httpx

from app.domain.agents.macro_context import MacroContextEvent, MacroImpact

BLS_CALENDAR_URL = "https://www.bls.gov/schedule/news_release/bls.ics"
_BLS_SOURCE_ID = "us_bls"
_BLS_FALLBACK_TIMEZONE = "America/New_York"
_MAX_CALENDAR_BYTES = 1_500_000
_HTTP_TIMEOUT_SECONDS = 10.0

_RELEASE_POLICIES: tuple[tuple[str, str, MacroImpact], ...] = (
    ("consumer price index", "CPI", "HIGH"),
    ("employment situation", "EMPLOYMENT_SITUATION", "HIGH"),
    ("producer price index", "PPI", "MEDIUM"),
    ("job openings and labor turnover", "JOLTS", "MEDIUM"),
    ("employment cost index", "EMPLOYMENT_COST_INDEX", "MEDIUM"),
)

_WINDOWS_TZ_ALIASES = {
    "eastern standard time": _BLS_FALLBACK_TIMEZONE,
    "us-eastern": _BLS_FALLBACK_TIMEZONE,
}


class BlsCalendarProviderError(RuntimeError):
    """Fail-closed error raised when the official calendar cannot be trusted."""


def _aware(value: datetime, field_name: str) -> datetime:
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError(f"{field_name} must be timezone-aware")
    return value


def _unfold_lines(payload: str) -> list[str]:
    unfolded: list[str] = []
    for raw_line in payload.splitlines():
        line = raw_line.rstrip("\r")
        if line.startswith((" ", "\t")):
            if not unfolded:
                raise BlsCalendarProviderError("BLS calendar contains an invalid folded line")
            unfolded[-1] += line[1:]
        else:
            unfolded.append(line)
    return unfolded


def _decode_ical_text(value: str) -> str:
    return (
        value.replace("\\N", "\n")
        .replace("\\n", "\n")
        .replace("\\,", ",")
        .replace("\\;", ";")
        .replace("\\\\", "\\")
        .strip()
    )


def _parse_property(line: str) -> tuple[str, dict[str, str], str]:
    if ":" not in line:
        raise BlsCalendarProviderError("BLS calendar contains a malformed property")
    head, value = line.split(":", 1)
    parts = head.split(";")
    name = parts[0].strip().upper()
    if not name:
        raise BlsCalendarProviderError("BLS calendar contains an unnamed property")

    params: dict[str, str] = {}
    for raw_param in parts[1:]:
        if "=" not in raw_param:
            continue
        key, raw_value = raw_param.split("=", 1)
        params[key.strip().upper()] = raw_value.strip().strip('"')

    return name, params, value.strip()


def _parse_datetime(value: str, params: dict[str, str]) -> datetime:
    if params.get("VALUE", "").upper() == "DATE" or "T" not in value:
        raise BlsCalendarProviderError("BLS release event must include a clock time")

    raw = value.strip()
    is_utc = raw.endswith("Z")
    if is_utc:
        raw = raw[:-1]

    formats = ("%Y%m%dT%H%M%S", "%Y%m%dT%H%M")
    parsed: datetime | None = None
    for date_format in formats:
        try:
            parsed = datetime.strptime(raw, date_format)
            break
        except ValueError:
            continue
    if parsed is None:
        raise BlsCalendarProviderError("BLS release event has an unsupported DTSTART")

    if is_utc:
        return parsed.replace(tzinfo=UTC)

    tzid = params.get("TZID", _BLS_FALLBACK_TIMEZONE).strip()
    tzid = _WINDOWS_TZ_ALIASES.get(tzid.casefold(), tzid)
    try:
        timezone = ZoneInfo(tzid)
    except ZoneInfoNotFoundError as exc:
        raise BlsCalendarProviderError("BLS release event uses an unknown timezone") from exc

    return parsed.replace(tzinfo=timezone).astimezone(UTC)


def _release_policy(summary: str) -> tuple[str, MacroImpact] | None:
    normalized = " ".join(summary.casefold().split())
    for prefix, event_family, impact in _RELEASE_POLICIES:
        if normalized.startswith(prefix):
            return event_family, impact
    return None


def _stable_source_event_id(uid: str) -> str:
    digest = hashlib.sha256(uid.strip().encode("utf-8")).hexdigest()
    return f"bls:{digest}"


def _event_from_properties(
    properties: dict[str, list[tuple[dict[str, str], str]]],
    *,
    fetched_at: datetime,
) -> MacroContextEvent | None:
    summary_entries = properties.get("SUMMARY", [])
    if not summary_entries:
        raise BlsCalendarProviderError("BLS VEVENT is missing SUMMARY")
    summary = _decode_ical_text(summary_entries[0][1])
    policy = _release_policy(summary)
    if policy is None:
        return None

    uid_entries = properties.get("UID", [])
    start_entries = properties.get("DTSTART", [])
    if not uid_entries or not uid_entries[0][1].strip():
        raise BlsCalendarProviderError("governed BLS release is missing UID")
    if not start_entries:
        raise BlsCalendarProviderError("governed BLS release is missing DTSTART")

    status_entries = properties.get("STATUS", [])
    status = (
        "CANCELLED"
        if status_entries and status_entries[0][1].strip().upper() == "CANCELLED"
        else "SCHEDULED"
    )
    event_family, impact = policy
    scheduled_for = _parse_datetime(start_entries[0][1], start_entries[0][0])

    return MacroContextEvent(
        source_id=_BLS_SOURCE_ID,
        source_event_id=_stable_source_event_id(uid_entries[0][1]),
        event_family=event_family,
        title=summary,
        currency="USD",
        impact=impact,
        status=status,
        observed_at=fetched_at,
        available_at=fetched_at,
        scheduled_for=scheduled_for,
    )


def parse_bls_calendar(
    payload: str,
    *,
    fetched_at: datetime,
) -> list[MacroContextEvent]:
    """Parse the official BLS iCalendar payload without inventing past availability."""
    known_at = _aware(fetched_at, "fetched_at")
    lines = _unfold_lines(payload)
    if "BEGIN:VCALENDAR" not in lines or "END:VCALENDAR" not in lines:
        raise BlsCalendarProviderError("BLS response is not a complete iCalendar document")

    events: list[MacroContextEvent] = []
    current: dict[str, list[tuple[dict[str, str], str]]] | None = None

    for line in lines:
        marker = line.strip().upper()
        if marker == "BEGIN:VEVENT":
            if current is not None:
                raise BlsCalendarProviderError("BLS calendar contains nested VEVENT blocks")
            current = {}
            continue
        if marker == "END:VEVENT":
            if current is None:
                raise BlsCalendarProviderError("BLS calendar contains unmatched END:VEVENT")
            event = _event_from_properties(current, fetched_at=known_at)
            if event is not None:
                events.append(event)
            current = None
            continue
        if current is None or not line.strip():
            continue

        name, params, value = _parse_property(line)
        current.setdefault(name, []).append((params, value))

    if current is not None:
        raise BlsCalendarProviderError("BLS calendar contains an unterminated VEVENT")

    return sorted(
        events,
        key=lambda item: (item.scheduled_for, item.event_family, item.source_event_id),
    )


class BlsOfficialCalendarProvider:
    """Fetch the fixed official BLS calendar and normalize governed release events."""

    def __init__(self, client: httpx.AsyncClient | None = None) -> None:
        self._client = client

    async def fetch(self) -> list[MacroContextEvent]:
        """
        Fetch the official calendar and stamp knowledge at response receipt.

        Historical replay uses `parse_bls_calendar()` with the persisted
        snapshot receipt time. The live network boundary intentionally accepts
        no caller-supplied availability timestamp.
        """
        if self._client is not None:
            response = await self._request(self._client)
        else:
            async with httpx.AsyncClient(trust_env=False) as client:
                response = await self._request(client)

        known_at = datetime.now(UTC)

        content_type = response.headers.get("content-type", "")
        media_type = content_type.split(";", 1)[0].strip().lower()
        if media_type != "text/calendar":
            raise BlsCalendarProviderError("BLS calendar returned an unexpected content type")

        declared_length = response.headers.get("content-length")
        if declared_length:
            try:
                if int(declared_length) > _MAX_CALENDAR_BYTES:
                    raise BlsCalendarProviderError("BLS calendar response exceeds size limit")
            except ValueError as exc:
                raise BlsCalendarProviderError(
                    "BLS calendar returned an invalid content length"
                ) from exc

        content = response.content
        if len(content) > _MAX_CALENDAR_BYTES:
            raise BlsCalendarProviderError("BLS calendar response exceeds size limit")

        try:
            payload = content.decode("utf-8-sig")
        except UnicodeDecodeError as exc:
            raise BlsCalendarProviderError("BLS calendar is not valid UTF-8") from exc

        return parse_bls_calendar(payload, fetched_at=known_at)

    async def _request(self, client: httpx.AsyncClient) -> httpx.Response:
        try:
            response = await client.get(
                BLS_CALENDAR_URL,
                headers={
                    "Accept": "text/calendar",
                    "User-Agent": "iRexPro-AgentCouncil/1.0",
                },
                timeout=_HTTP_TIMEOUT_SECONDS,
                follow_redirects=False,
            )
        except httpx.HTTPError as exc:
            raise BlsCalendarProviderError("BLS calendar request failed") from exc

        if response.status_code != 200:
            raise BlsCalendarProviderError(
                f"BLS calendar request returned HTTP {response.status_code}"
            )
        return response
