"""Import HistData Generic ASCII tick ZIP/CSV into iRexPro causal raw M1 schema.

HistData Generic ASCII tick timestamps are fixed EST (UTC-05:00) without
daylight-saving adjustments. Tick rows provide bid/ask quotes. This importer
streams time-ordered ticks, converts them to UTC, validates bid/ask geometry,
and aggregates midpoint OHLC with last-tick spread and tick count.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import heapq
import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import IO, Iterator
from zipfile import ZipFile

EST_TO_UTC = timedelta(hours=5)
OUTPUT_COLUMNS = (
    "timestamp",
    "open",
    "high",
    "low",
    "close",
    "volume",
    "tick_volume",
    "spread_points",
    "price_digits",
    "quote_volume",
)


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def parse_histdata_timestamp(value: str) -> datetime:
    """Parse YYYYMMDD HHMMSSmmm fixed EST and return UTC."""
    raw = value.strip()
    if len(raw) != 18 or raw[8] != " ":
        raise ValueError(f"Invalid HistData timestamp: {value!r}")
    date_token = raw[:8]
    clock_token = raw[9:]
    if len(clock_token) != 9 or not (date_token + clock_token).isdigit():
        raise ValueError(f"Invalid HistData timestamp: {value!r}")
    local = datetime(
        int(date_token[:4]),
        int(date_token[4:6]),
        int(date_token[6:8]),
        int(clock_token[:2]),
        int(clock_token[2:4]),
        int(clock_token[4:6]),
        int(clock_token[6:9]) * 1000,
    )
    return (local + EST_TO_UTC).replace(tzinfo=UTC)


def _open_tick_text(path: Path) -> tuple[IO[bytes], str, ZipFile | None]:
    if path.suffix.lower() != ".zip":
        handle = path.open("rb")
        return handle, path.name, None

    archive = ZipFile(path)
    members = [
        name
        for name in archive.namelist()
        if name.lower().endswith(".csv") and "_t_" in name.lower()
    ]
    if len(members) != 1:
        archive.close()
        raise ValueError(
            f"Expected exactly one HistData tick CSV in {path.name}; found {members}"
        )
    member = members[0]
    return archive.open(member, "r"), member, archive


def iter_histdata_ticks(path: str | Path) -> Iterator[tuple[datetime, float, float]]:
    source = Path(path)
    handle, _member, archive = _open_tick_text(source)
    try:
        for line_number, raw_line in enumerate(handle, start=1):
            line = raw_line.decode("ascii").strip()
            if not line:
                continue
            parts = line.split(",")
            if len(parts) < 3:
                raise ValueError(
                    f"Malformed HistData tick row at line {line_number}: {line!r}"
                )
            timestamp = parse_histdata_timestamp(parts[0])
            bid = float(parts[1])
            ask = float(parts[2])
            if bid <= 0.0 or ask <= 0.0 or ask < bid:
                raise ValueError(
                    f"Invalid bid/ask geometry at line {line_number}: bid={bid} ask={ask}"
                )
            yield timestamp, bid, ask
    finally:
        handle.close()
        if archive is not None:
            archive.close()


def reorder_histdata_ticks(
    ticks: Iterator[tuple[datetime, float, float]],
    *,
    max_backward_seconds: float = 1.0,
) -> Iterator[tuple[datetime, float, float]]:
    """Repair only tightly bounded provider ordering jitter.

    HistData 2026 tick files contain rare one-second reversals. A watermark
    buffer reorders those ticks without allowing arbitrary historical sorting.
    Anything arriving more than max_backward_seconds behind the maximum seen
    timestamp fails closed.
    """
    if max_backward_seconds < 0.0:
        raise ValueError("max_backward_seconds must be non-negative")

    heap: list[tuple[datetime, int, float, float]] = []
    max_seen: datetime | None = None
    sequence = 0

    for timestamp, bid, ask in ticks:
        if max_seen is not None:
            lag = (max_seen - timestamp).total_seconds()
            if lag > max_backward_seconds:
                raise ValueError(
                    "HistData tick ordering exceeded bounded reorder window: "
                    f"{lag:.6f}s > {max_backward_seconds:.6f}s"
                )
        if max_seen is None or timestamp > max_seen:
            max_seen = timestamp

        heapq.heappush(heap, (timestamp, sequence, bid, ask))
        sequence += 1
        assert max_seen is not None
        watermark = max_seen - timedelta(seconds=max_backward_seconds)
        while heap and heap[0][0] <= watermark:
            ordered_timestamp, _seq, ordered_bid, ordered_ask = heapq.heappop(heap)
            yield ordered_timestamp, ordered_bid, ordered_ask

    while heap:
        ordered_timestamp, _seq, ordered_bid, ordered_ask = heapq.heappop(heap)
        yield ordered_timestamp, ordered_bid, ordered_ask


def aggregate_histdata_ticks(
    ticks: Iterator[tuple[datetime, float, float]],
    *,
    price_digits: int,
) -> Iterator[dict[str, object]]:
    scale = 10**price_digits
    current_minute: datetime | None = None
    row: dict[str, object] | None = None
    previous_timestamp: datetime | None = None

    for timestamp, bid, ask in ticks:
        if previous_timestamp is not None and timestamp < previous_timestamp:
            raise ValueError("HistData tick input is not chronological")
        previous_timestamp = timestamp

        minute = timestamp.replace(second=0, microsecond=0)
        mid = (bid + ask) / 2.0
        spread_points = int(round((ask - bid) * scale))

        if current_minute is None or minute != current_minute:
            if row is not None:
                yield row
            current_minute = minute
            row = {
                "timestamp": minute.isoformat(),
                "open": mid,
                "high": mid,
                "low": mid,
                "close": mid,
                "volume": 1.0,
                "tick_volume": 1.0,
                "spread_points": float(spread_points),
                "price_digits": price_digits,
                "quote_volume": 0.0,
            }
            continue

        assert row is not None
        row["high"] = max(float(row["high"]), mid)
        row["low"] = min(float(row["low"]), mid)
        row["close"] = mid
        row["volume"] = float(row["volume"]) + 1.0
        row["tick_volume"] = float(row["tick_volume"]) + 1.0
        row["spread_points"] = float(spread_points)

    if row is not None:
        yield row


def import_histdata_ticks(
    input_path: str | Path,
    output_path: str | Path,
    *,
    instrument: str,
    price_digits: int,
) -> dict[str, object]:
    source = Path(input_path)
    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(output.suffix + ".tmp")

    row_count = 0
    start_timestamp: str | None = None
    end_timestamp: str | None = None

    with temporary.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=OUTPUT_COLUMNS)
        writer.writeheader()
        for row in aggregate_histdata_ticks(
            reorder_histdata_ticks(
                iter_histdata_ticks(source),
                max_backward_seconds=1.0,
            ),
            price_digits=price_digits,
        ):
            writer.writerow(row)
            row_count += 1
            timestamp = str(row["timestamp"])
            if start_timestamp is None:
                start_timestamp = timestamp
            end_timestamp = timestamp

    if row_count < 250:
        temporary.unlink(missing_ok=True)
        raise ValueError(
            f"HistData import yielded only {row_count} M1 rows; expected at least 250"
        )
    temporary.replace(output)

    manifest = {
        "manifest_version": 1,
        "source": "HistData Generic ASCII Tick Data",
        "source_file": source.name,
        "source_sha256": _sha256_file(source),
        "source_timestamp_timezone": "EST fixed UTC-05:00, no DST",
        "timestamp_conversion": "source_timestamp_plus_5_hours_to_UTC",
        "instrument": instrument.upper(),
        "price_digits": price_digits,
        "aggregation": "M1 midpoint OHLC from bid/ask ticks",
        "bounded_tick_reorder_seconds": 1.0,
        "spread_semantics": "last tick ask-bid converted to price points",
        "tick_volume_semantics": "number of quote ticks per minute",
        "quote_volume_available": False,
        "friction_data_complete": True,
        "row_count": row_count,
        "start_timestamp": start_timestamp,
        "end_timestamp": end_timestamp,
        "dataset_path": str(output),
        "dataset_sha256": _sha256_file(output),
    }
    manifest_path = output.with_suffix(".manifest.json")
    manifest_path.write_text(
        json.dumps(manifest, indent=2, sort_keys=True),
        encoding="utf-8",
    )
    manifest["manifest_path"] = str(manifest_path)
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Import HistData bid/ask ticks into iRexPro raw M1 schema"
    )
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--instrument", required=True)
    parser.add_argument("--price-digits", type=int, required=True)
    args = parser.parse_args()

    report = import_histdata_ticks(
        args.input,
        args.output,
        instrument=args.instrument,
        price_digits=args.price_digits,
    )
    print(json.dumps(report, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
