"""Official BLS prior-year monthly schedule archive for causal research replay."""
from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from datetime import UTC, datetime, time
from html.parser import HTMLParser
from zoneinfo import ZoneInfo

import httpx

from app.domain.agents.macro_context import MacroContextEvent
from app.domain.agents.providers.bls_calendar import classify_bls_release

BLS_HISTORICAL_SCHEDULE_URL_TEMPLATE = (
    "https://www.bls.gov/schedule/{year:04d}/{month:02d}_sched_list.htm"
)
_BLS_SOURCE_ID = "us_bls"
_BLS_EASTERN = ZoneInfo("America/New_York")
_MAX_PAGE_BYTES = 1_500_000
_HTTP_TIMEOUT_SECONDS = 10.0
_LAST_MODIFIED_PATTERN = re.compile(
    r"Last\s+Modified\s+Date\s*:\s*([A-Za-z]+\s+\d{1,2},\s+\d{4})",
    re.IGNORECASE,
)


class BlsHistoricalScheduleError(RuntimeError):
    """Fail-closed error for untrusted or malformed official BLS archive pages."""


@dataclass(frozen=True)
class BlsHistoricalScheduleSnapshot:
    """One official monthly BLS schedule snapshot normalized for research."""

    year: int
    month: int
    source_url: str
    fetched_at: datetime
    page_available_at: datetime
    payload_sha256: str
    governed_rows: int
    causally_usable_rows: int
    skipped_retrospective_rows: int
    events: tuple[MacroContextEvent, ...]


def bls_historical_schedule_url(year: int, month: int) -> str:
    """Build a fixed official BLS monthly list-view URL."""
    if isinstance(year, bool) or not isinstance(year, int) or not 2000 <= year <= 2100:
        raise ValueError("year must be an integer between 2000 and 2100")
    if isinstance(month, bool) or not isinstance(month, int) or not 1 <= month <= 12:
        raise ValueError("month must be an integer between 1 and 12")
    return BLS_HISTORICAL_SCHEDULE_URL_TEMPLATE.format(year=year, month=month)


def _normalize_text(value: str) -> str:
    return " ".join(value.replace("\xa0", " ").split())


class _BlsListPageParser(HTMLParser):
    """Extract table rows and visible text without adding an HTML dependency."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.rows: list[list[str]] = []
        self.visible_text: list[str] = []
        self._row: list[str] | None = None
        self._cell_parts: list[str] | None = None

    def handle_starttag(
        self,
        tag: str,
        _attrs: list[tuple[str, str | None]],
    ) -> None:
        normalized = tag.casefold()
        if normalized == "tr":
            if self._row is not None:
                raise BlsHistoricalScheduleError(
                    "BLS schedule contains nested table rows"
                )
            self._row = []
        elif normalized in {"td", "th"} and self._row is not None:
            if self._cell_parts is not None:
                raise BlsHistoricalScheduleError(
                    "BLS schedule contains nested table cells"
                )
            self._cell_parts = []

    def handle_data(self, data: str) -> None:
        if data:
            self.visible_text.append(data)
            if self._cell_parts is not None:
                self._cell_parts.append(data)

    def handle_endtag(self, tag: str) -> None:
        normalized = tag.casefold()
        if normalized in {"td", "th"} and self._cell_parts is not None:
            if self._row is None:
                raise BlsHistoricalScheduleError(
                    "BLS schedule contains a cell outside a row"
                )
            self._row.append(_normalize_text(" ".join(self._cell_parts)))
            self._cell_parts = None
        elif normalized == "tr" and self._row is not None:
            if self._cell_parts is not None:
                raise BlsHistoricalScheduleError(
                    "BLS schedule contains an unterminated table cell"
                )
            self.rows.append(self._row)
            self._row = None


def _page_available_at(parser: _BlsListPageParser) -> datetime:
    visible = _normalize_text(" ".join(parser.visible_text))
    matches = {
        _normalize_text(match)
        for match in _LAST_MODIFIED_PATTERN.findall(visible)
    }
    if not matches:
        raise BlsHistoricalScheduleError(
            "BLS schedule is missing an official Last Modified Date"
        )
    if len(matches) != 1:
        raise BlsHistoricalScheduleError(
            "BLS schedule contains conflicting Last Modified Date values"
        )

    raw_date = next(iter(matches))
    try:
        local_date = datetime.strptime(raw_date, "%B %d, %Y").date()
    except ValueError as exc:
        raise BlsHistoricalScheduleError(
            "BLS schedule has an invalid Last Modified Date"
        ) from exc

    # BLS exposes only a date, not a modification clock time. Use the end of
    # that Eastern day so historical replay never assumes earlier availability.
    conservative_local = datetime.combine(
        local_date,
        time(23, 59, 59, 999999),
        tzinfo=_BLS_EASTERN,
    )
    return conservative_local.astimezone(UTC)


def _parse_release_datetime(date_text: str, time_text: str) -> datetime:
    try:
        release_date = datetime.strptime(date_text, "%A, %B %d, %Y").date()
    except ValueError as exc:
        raise BlsHistoricalScheduleError(
            "BLS schedule contains an invalid release date"
        ) from exc

    try:
        release_time = datetime.strptime(time_text.upper(), "%I:%M %p").time()
    except ValueError as exc:
        raise BlsHistoricalScheduleError(
            "BLS schedule contains an invalid release time"
        ) from exc

    return datetime.combine(
        release_date,
        release_time,
        tzinfo=_BLS_EASTERN,
    ).astimezone(UTC)


def _historical_source_event_id(event_family: str, title: str) -> str:
    # Date/time is deliberately excluded so a reschedule keeps one revision
    # identity. The title contains the reference period for governed releases.
    material = f"{event_family}|{_normalize_text(title).casefold()}"
    digest = hashlib.sha256(material.encode("utf-8")).hexdigest()
    return f"bls-archive:{digest}"


def parse_bls_historical_schedule(
    payload: str,
    *,
    year: int,
    month: int,
    fetched_at: datetime,
) -> BlsHistoricalScheduleSnapshot:
    """Parse one official BLS monthly list-view page conservatively."""
    source_url = bls_historical_schedule_url(year, month)
    if fetched_at.tzinfo is None or fetched_at.utcoffset() is None:
        raise ValueError("fetched_at must be timezone-aware")

    parser = _BlsListPageParser()
    try:
        parser.feed(payload)
        parser.close()
    except BlsHistoricalScheduleError:
        raise
    except Exception as exc:
        raise BlsHistoricalScheduleError("BLS schedule HTML could not be parsed") from exc

    page_available_at = _page_available_at(parser)
    governed_rows = 0
    skipped_retrospective_rows = 0
    events: list[MacroContextEvent] = []
    identities: set[str] = set()

    for row in parser.rows:
        if len(row) < 3:
            continue
        date_text = _normalize_text(row[0])
        time_text = _normalize_text(row[1])
        release_text = _normalize_text(" ".join(row[2:]))
        if not date_text or not time_text or not release_text:
            continue

        policy = classify_bls_release(release_text)
        if policy is None:
            continue
        governed_rows += 1

        scheduled_for = _parse_release_datetime(date_text, time_text)
        local_scheduled = scheduled_for.astimezone(_BLS_EASTERN)
        if local_scheduled.year != year or local_scheduled.month != month:
            raise BlsHistoricalScheduleError(
                "BLS schedule contains a governed release outside the requested month"
            )

        # A page modified after the release cannot prove that the schedule was
        # known before that release. Keep the archive strictly pre-event causal.
        if page_available_at >= scheduled_for:
            skipped_retrospective_rows += 1
            continue

        event_family, impact = policy
        source_event_id = _historical_source_event_id(event_family, release_text)
        if source_event_id in identities:
            raise BlsHistoricalScheduleError(
                "BLS schedule contains duplicate governed release identities"
            )
        identities.add(source_event_id)

        events.append(
            MacroContextEvent(
                source_id=_BLS_SOURCE_ID,
                source_event_id=source_event_id,
                event_family=event_family,
                title=release_text,
                currency="USD",
                impact=impact,
                status="SCHEDULED",
                observed_at=page_available_at,
                available_at=page_available_at,
                scheduled_for=scheduled_for,
            )
        )

    events.sort(
        key=lambda item: (
            item.scheduled_for,
            item.event_family,
            item.source_event_id,
        )
    )
    encoded = payload.encode("utf-8")
    return BlsHistoricalScheduleSnapshot(
        year=year,
        month=month,
        source_url=source_url,
        fetched_at=fetched_at.astimezone(UTC),
        page_available_at=page_available_at,
        payload_sha256=hashlib.sha256(encoded).hexdigest(),
        governed_rows=governed_rows,
        causally_usable_rows=len(events),
        skipped_retrospective_rows=skipped_retrospective_rows,
        events=tuple(events),
    )


class BlsHistoricalScheduleProvider:
    """Fetch fixed official BLS prior-year monthly list pages for research."""

    def __init__(self, client: httpx.AsyncClient | None = None) -> None:
        self._client = client

    async def fetch_month(
        self,
        *,
        year: int,
        month: int,
    ) -> BlsHistoricalScheduleSnapshot:
        url = bls_historical_schedule_url(year, month)
        if self._client is not None:
            response = await self._request(self._client, url)
        else:
            async with httpx.AsyncClient(trust_env=False) as client:
                response = await self._request(client, url)

        fetched_at = datetime.now(UTC)
        content_type = response.headers.get("content-type", "")
        media_type = content_type.split(";", 1)[0].strip().casefold()
        if media_type not in {"text/html", "application/xhtml+xml"}:
            raise BlsHistoricalScheduleError(
                "BLS historical schedule returned an unexpected content type"
            )

        declared_length = response.headers.get("content-length")
        if declared_length:
            try:
                if int(declared_length) > _MAX_PAGE_BYTES:
                    raise BlsHistoricalScheduleError(
                        "BLS historical schedule response exceeds size limit"
                    )
            except ValueError as exc:
                raise BlsHistoricalScheduleError(
                    "BLS historical schedule returned an invalid content length"
                ) from exc

        content = response.content
        if len(content) > _MAX_PAGE_BYTES:
            raise BlsHistoricalScheduleError(
                "BLS historical schedule response exceeds size limit"
            )
        try:
            payload = content.decode("utf-8-sig")
        except UnicodeDecodeError as exc:
            raise BlsHistoricalScheduleError(
                "BLS historical schedule is not valid UTF-8"
            ) from exc

        return parse_bls_historical_schedule(
            payload,
            year=year,
            month=month,
            fetched_at=fetched_at,
        )

    async def _request(
        self,
        client: httpx.AsyncClient,
        url: str,
    ) -> httpx.Response:
        try:
            response = await client.get(
                url,
                headers={
                    "Accept": "text/html,application/xhtml+xml",
                    "User-Agent": "iRexPro-AgentCouncil-Research/1.0",
                },
                timeout=_HTTP_TIMEOUT_SECONDS,
                follow_redirects=False,
            )
        except httpx.HTTPError as exc:
            raise BlsHistoricalScheduleError(
                "BLS historical schedule request failed"
            ) from exc

        if response.status_code != 200:
            raise BlsHistoricalScheduleError(
                "BLS historical schedule request returned "
                f"HTTP {response.status_code}"
            )
        return response
