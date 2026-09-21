"""Tests for the BLS context overlay research orchestrator."""
from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

import pandas as pd
import pytest

from app.domain.agents.macro_context import MacroContextEvent
from app.domain.agents.providers.bls_historical_schedule import (
    BlsHistoricalScheduleSnapshot,
    bls_historical_schedule_url,
)
from app.domain.training.run_bls_context_overlay_study import (
    _prediction_month_bounds,
    run_bls_context_overlay_study,
)


class FakeProvider:
    def __init__(self, snapshots):
        self.snapshots = snapshots
        self.calls: list[tuple[int, int]] = []

    async def fetch_month(self, *, year: int, month: int):
        self.calls.append((year, month))
        return self.snapshots[(year, month)]


def snapshot(
    *,
    year: int,
    month: int,
    events: tuple[MacroContextEvent, ...],
) -> BlsHistoricalScheduleSnapshot:
    available = min(event.available_at for event in events)
    return BlsHistoricalScheduleSnapshot(
        year=year,
        month=month,
        source_url=bls_historical_schedule_url(year, month),
        fetched_at=datetime(2026, 9, 21, 4, 0, tzinfo=UTC),
        page_available_at=available,
        payload_sha256="snapshot-sha",
        governed_rows=len(events),
        causally_usable_rows=len(events),
        skipped_retrospective_rows=0,
        events=events,
    )


def test_prediction_month_bounds_include_event_window_padding():
    predictions = pd.DataFrame(
        {
            "decision_time": [
                "2026-01-01T05:10:00Z",
                "2026-02-01T04:50:00Z",
            ]
        }
    )

    bounds = _prediction_month_bounds(
        predictions,
        pre_event_minutes=30,
        post_event_minutes=30,
    )

    assert bounds == (2025, 12, 2026, 2)


@pytest.mark.asyncio
async def test_orchestrator_collects_matching_month_and_writes_overlay_outputs(
    tmp_path: Path,
):
    predictions_path = tmp_path / "predictions.csv"
    pd.DataFrame(
        {
            "decision_time": [
                "2024-07-05T12:15:00Z",
                "2024-07-05T13:00:00Z",
            ],
            "instrument": ["EURUSD", "EURUSD"],
            "target": [0, 1],
            "positive_probability": [0.80, 0.80],
            "confidence": [0.80, 0.80],
            "predicted_long": [True, True],
            "active_trade": [True, True],
            "selected_net_return": [-0.01, 0.02],
            "fold": [1, 1],
        }
    ).to_csv(predictions_path, index=False)

    page_available = datetime(2023, 11, 18, 4, 59, 59, tzinfo=UTC)
    macro_event = MacroContextEvent(
        source_id="us_bls",
        source_event_id="bls-archive:employment-june-2024",
        event_family="EMPLOYMENT_SITUATION",
        title="Employment Situation for June 2024",
        currency="USD",
        impact="HIGH",
        status="SCHEDULED",
        observed_at=page_available,
        available_at=page_available,
        scheduled_for=datetime(2024, 7, 5, 12, 30, tzinfo=UTC),
    )
    provider = FakeProvider(
        {
            (2024, 7): snapshot(
                year=2024,
                month=7,
                events=(macro_event,),
            )
        }
    )

    output_dir = tmp_path / "context"
    result = await run_bls_context_overlay_study(
        predictions_path=predictions_path,
        horizon_bars=5,
        output_dir=output_dir,
        provider=provider,
        collected_at=datetime(2026, 9, 21, 4, 5, tzinfo=UTC),
    )

    assert provider.calls == [(2024, 7)]
    assert result["quant_active_signals"] == 2
    assert result["candidate_active_signals"] == 1
    assert result["blocked_signal_diagnostics"]["blocked_signals"] == 1
    assert result["blocked_signal_diagnostics"]["blocked_negative_outcomes"] == 1
    assert result["governance"]["approved_for_paper_uat"] is False
    assert result["governance"]["approved_for_live"] is False
    assert result["historical_context_archive"]["month_count"] == 1
    assert result["historical_context_archive"]["event_count"] == 1

    assert Path(result["report_path"]).is_file()
    assert Path(result["annotated_predictions_path"]).is_file()
    assert Path(result["events_path"]).is_file()
    assert Path(result["archive_manifest_path"]).is_file()

    annotated = pd.read_csv(result["annotated_predictions_path"])
    assert annotated["agent_context_status"].tolist() == [
        "BLOCKED",
        "INSUFFICIENT",
    ]
    assert annotated["context_candidate_active_trade"].tolist() == [
        False,
        True,
    ]


@pytest.mark.asyncio
async def test_orchestrator_rejects_invalid_event_windows_before_collection(
    tmp_path: Path,
):
    predictions_path = tmp_path / "predictions.csv"
    pd.DataFrame(
        {
            "decision_time": ["2024-07-05T12:15:00Z"],
        }
    ).to_csv(predictions_path, index=False)
    provider = FakeProvider({})

    with pytest.raises(ValueError, match="pre_event_minutes"):
        await run_bls_context_overlay_study(
            predictions_path=predictions_path,
            horizon_bars=5,
            output_dir=tmp_path / "out",
            pre_event_minutes=1441,
            provider=provider,
        )

    assert provider.calls == []
