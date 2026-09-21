"""Tests for historical causal Agent Council overlay evaluation."""
from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta

import pandas as pd
import pytest

from app.domain.agents.macro_context import MacroContextEvent
from app.domain.training.agent_context_evaluation import (
    evaluate_agent_context_overlay_with_rows,
    load_historical_macro_events,
)

START = datetime(2026, 1, 15, 10, 0, tzinfo=UTC)


def predictions(rows: list[dict]) -> pd.DataFrame:
    return pd.DataFrame(
        [
            {
                "decision_time": START,
                "instrument": "EURUSD",
                "confidence": 0.80,
                "predicted_long": True,
                "active_trade": True,
                "selected_net_return": 0.01,
                **row,
            }
            for row in rows
        ]
    )


def bls_event(
    *,
    source_event_id: str = "bls:cpi",
    status: str = "SCHEDULED",
    observed_at: datetime | None = None,
    available_at: datetime | None = None,
    scheduled_for: datetime | None = None,
) -> MacroContextEvent:
    observed = observed_at or (START - timedelta(hours=1, seconds=1))
    available = available_at or (START - timedelta(hours=1))
    scheduled = scheduled_for or (START + timedelta(minutes=5))
    return MacroContextEvent(
        source_id="us_bls",
        source_event_id=source_event_id,
        event_family="CPI",
        title="Consumer Price Index",
        currency="USD",
        impact="HIGH",
        status=status,
        observed_at=observed,
        available_at=available,
        scheduled_for=scheduled,
    )


def test_overlay_blocks_only_quant_active_rows_in_verified_event_window():
    frame = predictions(
        [
            {
                "decision_time": START,
                "selected_net_return": -0.02,
            },
            {
                "decision_time": START + timedelta(minutes=5),
                "selected_net_return": 0.01,
            },
            {
                "decision_time": START + timedelta(minutes=10),
                "selected_net_return": 0.02,
            },
            {
                "decision_time": START + timedelta(minutes=15),
                "active_trade": False,
                "selected_net_return": -0.50,
            },
        ]
    )

    report, annotated = evaluate_agent_context_overlay_with_rows(
        frame,
        [bls_event()],
        horizon_bars=5,
        pre_event_minutes=5,
        post_event_minutes=0,
    )

    assert report["quant_active_signals"] == 3
    assert report["candidate_active_signals"] == 1
    assert report["blocked_signal_diagnostics"] == {
        "blocked_signals": 2,
        "blocked_positive_outcomes": 1,
        "blocked_negative_outcomes": 1,
        "blocked_flat_outcomes": 0,
    }
    assert report["governance"]["approved_for_paper_uat"] is False
    assert report["governance"]["approved_for_live"] is False
    assert report["governance"]["quant_direction_changed"] is False

    assert annotated.loc[0, "agent_context_status"] == "BLOCKED"
    assert annotated.loc[1, "agent_context_status"] == "BLOCKED"
    assert annotated.loc[2, "agent_context_status"] == "INSUFFICIENT"
    assert annotated.loc[3, "agent_context_status"] == "NOT_EVALUATED"
    assert annotated["predicted_long"].tolist() == frame["predicted_long"].tolist()
    assert annotated["confidence"].tolist() == frame["confidence"].tolist()
    assert annotated["selected_net_return"].tolist() == frame["selected_net_return"].tolist()


def test_event_not_available_at_decision_cannot_block_until_it_becomes_known():
    event = bls_event(
        observed_at=START + timedelta(seconds=30),
        available_at=START + timedelta(minutes=1),
        scheduled_for=START + timedelta(minutes=2),
    )
    frame = predictions(
        [
            {"decision_time": START},
            {"decision_time": START + timedelta(minutes=1)},
        ]
    )

    _, annotated = evaluate_agent_context_overlay_with_rows(
        frame,
        [event],
        horizon_bars=1,
        pre_event_minutes=5,
        post_event_minutes=0,
    )

    assert annotated.loc[0, "agent_context_status"] == "INSUFFICIENT"
    assert annotated.loc[0, "context_candidate_active_trade"]
    assert annotated.loc[1, "agent_context_status"] == "BLOCKED"
    assert not annotated.loc[1, "context_candidate_active_trade"]


def test_future_revision_cannot_rewrite_past_context_state():
    cancelled_known = bls_event(
        source_event_id="bls:revision-test",
        status="CANCELLED",
        observed_at=START - timedelta(hours=2, seconds=1),
        available_at=START - timedelta(hours=2),
        scheduled_for=START + timedelta(minutes=2),
    )
    scheduled_future_revision = bls_event(
        source_event_id="bls:revision-test",
        status="SCHEDULED",
        observed_at=START + timedelta(seconds=30),
        available_at=START + timedelta(minutes=1),
        scheduled_for=START + timedelta(minutes=2),
    )
    frame = predictions(
        [
            {"decision_time": START},
            {"decision_time": START + timedelta(minutes=1)},
        ]
    )

    _, annotated = evaluate_agent_context_overlay_with_rows(
        frame,
        [cancelled_known, scheduled_future_revision],
        horizon_bars=1,
        pre_event_minutes=5,
        post_event_minutes=0,
    )

    assert annotated.loc[0, "agent_context_status"] == "INSUFFICIENT"
    assert annotated.loc[1, "agent_context_status"] == "BLOCKED"


def test_untrusted_macro_source_is_ignored():
    untrusted = bls_event().model_copy(
        update={
            "source_id": "random_calendar",
            "source_event_id": "random:cpi",
        }
    )
    frame = predictions([{"decision_time": START}])

    _, annotated = evaluate_agent_context_overlay_with_rows(
        frame,
        [untrusted],
        horizon_bars=1,
        pre_event_minutes=5,
        post_event_minutes=0,
    )

    assert annotated.loc[0, "agent_context_status"] == "INSUFFICIENT"
    assert annotated.loc[0, "context_candidate_active_trade"]


def test_overlay_comparison_uses_same_directional_returns_not_hindsight_relabeling():
    frame = predictions(
        [
            {
                "decision_time": START,
                "predicted_long": False,
                "selected_net_return": -0.03,
            },
            {
                "decision_time": START + timedelta(minutes=5),
                "predicted_long": True,
                "selected_net_return": 0.04,
            },
        ]
    )

    report, annotated = evaluate_agent_context_overlay_with_rows(
        frame,
        [bls_event()],
        horizon_bars=5,
        pre_event_minutes=5,
        post_event_minutes=0,
    )

    assert annotated["predicted_long"].tolist() == [False, True]
    assert annotated["selected_net_return"].tolist() == [-0.03, 0.04]
    assert report["overall"]["quant_only"]["raw_active_signals"] == 2
    assert report["overall"]["context_block_candidate"]["raw_active_signals"] == 0


def test_overlay_reports_directional_precision_and_fold_stability():
    frame = predictions(
        [
            {
                "decision_time": START,
                "target": 0,
                "fold": 1,
                "predicted_long": True,
                "positive_probability": 0.80,
                "selected_net_return": -0.02,
            },
            {
                "decision_time": START + timedelta(minutes=5),
                "target": 1,
                "fold": 1,
                "predicted_long": False,
                "positive_probability": 0.20,
                "selected_net_return": -0.01,
            },
            {
                "decision_time": START + timedelta(minutes=10),
                "target": 1,
                "fold": 2,
                "predicted_long": True,
                "positive_probability": 0.80,
                "selected_net_return": 0.03,
            },
            {
                "decision_time": START + timedelta(minutes=15),
                "target": 0,
                "fold": 2,
                "predicted_long": False,
                "positive_probability": 0.20,
                "selected_net_return": 0.02,
            },
        ]
    )

    report, _ = evaluate_agent_context_overlay_with_rows(
        frame,
        [bls_event()],
        horizon_bars=5,
        pre_event_minutes=5,
        post_event_minutes=0,
    )

    accuracy = report["overall"]["directional_accuracy_on_active_signals"]
    assert accuracy["quant_only"] == pytest.approx(0.5)
    assert accuracy["context_block_candidate"] == pytest.approx(1.0)
    assert accuracy["delta_candidate_minus_quant"] == pytest.approx(0.5)

    classification = report["overall"]["classification_on_active_signals"]
    assert classification["quant_only"]["precision"] == pytest.approx(0.5)
    assert classification["context_block_candidate"]["precision"] == pytest.approx(1.0)
    assert classification["precision_delta_candidate_minus_quant"] == pytest.approx(0.5)
    assert classification["brier_delta_candidate_minus_quant"] == pytest.approx(-0.30)
    assert classification["log_loss_delta_candidate_minus_quant"] < 0

    assert set(report["by_fold"]) == {"1", "2"}
    assert report["by_fold"]["1"]["active_signal_count"] == 2
    assert report["by_fold"]["1"]["blocked_signal_count"] == 2
    assert (
        report["by_fold"]["1"]["directional_accuracy_on_active_signals"][
            "context_block_candidate"
        ]
        is None
    )
    assert (
        report["by_fold"]["1"]["classification_on_active_signals"][
            "context_block_candidate"
        ]
        is None
    )
    assert report["by_fold"]["2"]["active_signal_count"] == 2
    assert report["by_fold"]["2"]["blocked_signal_count"] == 0
    assert (
        report["by_fold"]["2"]["directional_accuracy_on_active_signals"]["quant_only"]
        == pytest.approx(1.0)
    )
    assert (
        report["by_fold"]["2"]["directional_accuracy_on_active_signals"][
            "context_block_candidate"
        ]
        == pytest.approx(1.0)
    )


def test_overlay_normalizes_csv_style_boolean_values():
    frame = predictions(
        [
            {
                "decision_time": START,
                "predicted_long": "true",
                "active_trade": "1",
            },
            {
                "decision_time": START + timedelta(minutes=1),
                "predicted_long": "FALSE",
                "active_trade": "0",
            },
        ]
    )

    _, annotated = evaluate_agent_context_overlay_with_rows(
        frame,
        [],
        horizon_bars=1,
    )

    assert annotated["predicted_long"].tolist() == [True, False]
    assert annotated["active_trade"].tolist() == [True, False]
    assert annotated["context_candidate_active_trade"].tolist() == [True, False]


def test_overlay_rejects_invalid_event_window_even_without_active_trades():
    frame = predictions(
        [
            {
                "decision_time": START,
                "active_trade": False,
            }
        ]
    )

    with pytest.raises(ValueError, match="pre_event_minutes must be an integer"):
        evaluate_agent_context_overlay_with_rows(
            frame,
            [],
            horizon_bars=1,
            pre_event_minutes=1441,
        )


def test_overlay_rejects_nonbinary_target_when_precision_is_requested():
    frame = predictions(
        [
            {
                "decision_time": START,
                "target": 2,
                "fold": 1,
            }
        ]
    )

    with pytest.raises(ValueError, match="target must contain only binary 0/1 labels"):
        evaluate_agent_context_overlay_with_rows(
            frame,
            [],
            horizon_bars=1,
        )


def test_load_historical_macro_events_supports_json_and_rejects_bad_rows(tmp_path):
    path = tmp_path / "events.json"
    path.write_text(
        json.dumps(
            [
                {
                    "source_id": "us_bls",
                    "source_event_id": "bls:cpi",
                    "event_family": "CPI",
                    "title": "Consumer Price Index",
                    "currency": "USD",
                    "impact": "HIGH",
                    "status": "SCHEDULED",
                    "observed_at": (START - timedelta(hours=1, seconds=1)).isoformat(),
                    "available_at": (START - timedelta(hours=1)).isoformat(),
                    "scheduled_for": (START + timedelta(minutes=5)).isoformat(),
                }
            ]
        ),
        encoding="utf-8",
    )

    loaded = load_historical_macro_events(path)
    assert len(loaded) == 1
    assert loaded[0].source_id == "us_bls"
    assert loaded[0].available_at.tzinfo is not None

    bad = tmp_path / "bad.json"
    bad.write_text(json.dumps([{"source_id": "us_bls"}]), encoding="utf-8")
    with pytest.raises(ValueError, match="Invalid historical macro event row 1"):
        load_historical_macro_events(bad)
