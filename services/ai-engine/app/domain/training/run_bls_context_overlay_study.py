"""Run the official BLS Agent Council overlay against one validation horizon."""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import pandas as pd

from app.domain.agents.providers.bls_historical_schedule import (
    BlsHistoricalScheduleProvider,
)
from app.domain.training.agent_context_evaluation import (
    evaluate_agent_context_overlay_with_rows,
    load_historical_macro_events,
)
from app.domain.training.collect_bls_historical_context import (
    collect_bls_historical_context,
)

_EASTERN = ZoneInfo("America/New_York")


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _prediction_month_bounds(
    predictions: pd.DataFrame,
    *,
    pre_event_minutes: int,
    post_event_minutes: int,
) -> tuple[int, int, int, int]:
    if "decision_time" not in predictions.columns or predictions.empty:
        raise ValueError("predictions must contain at least one decision_time")

    times = pd.to_datetime(predictions["decision_time"], utc=True, errors="coerce")
    if times.isna().any():
        raise ValueError("predictions contain invalid decision_time values")

    earliest = (
        times.min().to_pydatetime() - timedelta(minutes=pre_event_minutes)
    ).astimezone(_EASTERN)
    latest = (
        times.max().to_pydatetime() + timedelta(minutes=post_event_minutes)
    ).astimezone(_EASTERN)
    return earliest.year, earliest.month, latest.year, latest.month


async def run_bls_context_overlay_study(
    *,
    predictions_path: str | Path,
    horizon_bars: int,
    output_dir: str | Path,
    pre_event_minutes: int = 30,
    post_event_minutes: int = 15,
    provider: BlsHistoricalScheduleProvider | None = None,
    collected_at: datetime | None = None,
) -> dict[str, Any]:
    """Collect matching BLS archive months and evaluate the overlay."""
    if horizon_bars < 1:
        raise ValueError("horizon_bars must be positive")
    for value, field_name in (
        (pre_event_minutes, "pre_event_minutes"),
        (post_event_minutes, "post_event_minutes"),
    ):
        if (
            isinstance(value, bool)
            or not isinstance(value, int)
            or not 0 <= value <= 24 * 60
        ):
            raise ValueError(
                f"{field_name} must be an integer between 0 and 1440 minutes"
            )

    predictions_file = Path(predictions_path)
    predictions = pd.read_csv(predictions_file)
    start_year, start_month, end_year, end_month = _prediction_month_bounds(
        predictions,
        pre_event_minutes=pre_event_minutes,
        post_event_minutes=post_event_minutes,
    )

    root = Path(output_dir)
    root.mkdir(parents=True, exist_ok=True)
    event_path = root / "bls_historical_events.jsonl"
    overlay_path = root / "agent_council_overlay.json"
    annotated_path = root / "agent_council_overlay_rows.csv"

    archive = await collect_bls_historical_context(
        start_year=start_year,
        start_month=start_month,
        end_year=end_year,
        end_month=end_month,
        output_path=event_path,
        provider=provider,
        collected_at=collected_at or datetime.now(UTC),
    )
    events = load_historical_macro_events(event_path)
    report, annotated = evaluate_agent_context_overlay_with_rows(
        predictions,
        events,
        horizon_bars=horizon_bars,
        pre_event_minutes=pre_event_minutes,
        post_event_minutes=post_event_minutes,
    )

    report["inputs"] = {
        "predictions_path": str(predictions_file),
        "predictions_sha256": _sha256_file(predictions_file),
        "events_path": str(event_path),
        "events_sha256": _sha256_file(event_path),
    }
    report["historical_context_archive"] = {
        "manifest_path": archive["manifest_path"],
        "month_count": archive["month_count"],
        "event_count": archive["event_count"],
        "governed_rows": archive["governed_rows"],
        "causally_usable_rows": archive["causally_usable_rows"],
        "skipped_retrospective_rows": archive["skipped_retrospective_rows"],
    }

    overlay_path.write_text(
        json.dumps(report, indent=2, sort_keys=True),
        encoding="utf-8",
    )
    annotated.to_csv(annotated_path, index=False)

    return {
        **report,
        "report_path": str(overlay_path),
        "annotated_predictions_path": str(annotated_path),
        "events_path": str(event_path),
        "archive_manifest_path": archive["manifest_path"],
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description=(
            "Collect official historical BLS context for one walk-forward "
            "prediction file and compare the Agent Council block overlay"
        )
    )
    parser.add_argument("--predictions", required=True)
    parser.add_argument("--horizon-bars", type=int, required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--pre-event-minutes", type=int, default=30)
    parser.add_argument("--post-event-minutes", type=int, default=15)
    args = parser.parse_args()

    result = asyncio.run(
        run_bls_context_overlay_study(
            predictions_path=args.predictions,
            horizon_bars=args.horizon_bars,
            output_dir=args.output_dir,
            pre_event_minutes=args.pre_event_minutes,
            post_event_minutes=args.post_event_minutes,
        )
    )
    print(json.dumps(result, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
