"""Read-only rejected-entry study never fits, promotes or opens trades."""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pandas as pd
import pytest

from app.domain.training.demo_rejected_entry_outcomes_shadow import (
    prepare_cohort,
    report_from_csv,
)


def record(
    minute: int, instrument: str = "EURUSD", direction: str = "BUY"
) -> dict:
    when = datetime(2026, 11, 5, 12, 0, tzinfo=UTC) + timedelta(minutes=minute)
    return {
        "instrument": instrument,
        "direction": direction,
        "route": "M1_TREND_CONTINUATION",
        "planb_route": "TREND_CONTINUATION",
        "paper_admitted": "false",
        "admission_reasons_json": json.dumps(["EXIT_FEASIBILITY", "UNTRUSTED_CODE"]),
        "decision_time_utc": when.isoformat(),
        "entry_bid": 1.1000,
        "entry_ask": 1.1002,
        "future_bid": 1.1006,
        "future_ask": 1.1008,
        "entry_seen_utc": (when - timedelta(seconds=30)).isoformat(),
        "future_seen_utc": (when + timedelta(minutes=15, seconds=20)).isoformat(),
    }


def test_forward_labels_never_select_overlapping_cross_route_pair_side() -> None:
    raw = pd.DataFrame(
        [
            record(0),
            record(1, direction="SELL"),
            record(2, instrument="GBPUSD"),
            record(15, direction="SELL"),
            record(16),
        ]
    )
    clean, quality = prepare_cohort(raw)
    assert quality["causally_valid_before_deoverlap"] == 5
    assert quality["independent_opportunities"] == 3
    assert list(clean["direction"]) == ["BUY", "BUY", "BUY"]
    assert clean["proxy_pips"].tolist() == pytest.approx([3.0, 3.0, 3.0])
    assert clean["reason_codes"].tolist() == [frozenset(["EXIT_FEASIBILITY"])] * 3


def test_future_leakage_missing_prices_and_unsupported_pairs_are_rejected() -> None:
    a = record(0)
    b = record(1)
    b["entry_seen_utc"] = (
        datetime.fromisoformat(b["decision_time_utc"]) + timedelta(seconds=1)
    ).isoformat()
    c = record(2)
    c["future_seen_utc"] = (
        datetime.fromisoformat(c["decision_time_utc"]) + timedelta(minutes=14)
    ).isoformat()
    d = record(3, instrument="USDJPY")
    e = record(4)
    e["future_bid"] = float("inf")
    clean, quality = prepare_cohort(pd.DataFrame([a, b, c, d, e]))
    assert quality["causally_valid_before_deoverlap"] == 1
    assert len(clean) == 1


def test_shadow_report_is_aggregated_and_not_executable(tmp_path: Path) -> None:
    input_path = tmp_path / "cohort.csv"
    pd.DataFrame([record(0), record(1), record(16)]).to_csv(input_path, index=False)
    report = report_from_csv(input_path)
    assert report["authority"] == "RESEARCH_ONLY_NO_EXECUTION"
    assert report["model_fitted"] is False
    assert report["promotion_allowed"] is False
    assert report["broker_orders"] == 0
    assert report["actual_broker_net_pnl"] is False
    assert report["readiness"] == "EXPLORATORY_INSUFFICIENT_DAYS"
    assert report["overall"] == {
        "n": 2, "mean_proxy_pips": 3.0, "positive_fraction": 1.0,
    }
    assert report["admission_reasons"][0]["reason"] == "EXIT_FEASIBILITY"
    assert "UNTRUSTED_CODE" not in json.dumps(report)


def test_sql_and_runner_are_pinned_read_only_and_private() -> None:
    root = Path(__file__).resolve().parents[3]
    sql = (
        root / "services/ai-engine/app/domain/training/demo_rejected_entry_outcomes_readonly.sql"
    ).read_text()
    runner = (root / "scripts/research/run_demo_admission_rejected_shadow.sh").read_text()
    sql_select = sql.rsplit("\nSELECT ", 1)[1].split("\nFROM ranked d", 1)[0]
    for term in ("user_id", "broker_connection_id", "account_id", "signal_id"):
        assert term not in sql_select
    assert "d.user_id::text = :'scanner_user'" in sql
    assert "d.broker_connection_id::text = :'source_id'" in sql
    assert "q.connection_id::text=:'source_id'" in sql
    assert "d.execution_authority='NONE'" in sql
    assert "INTERVAL '35 days'" in sql
    assert "INSERT INTO" not in sql.upper()
    assert "UPDATE trading" not in sql.upper()
    assert "DELETE FROM" not in sql.upper()
    assert "dotenv_values" in runner
    assert 'source "$api_env"' not in runner
    assert "REJECTED_ENTRY_BROKER_ORDER_WRITES=0" in runner
    assert "REJECTED_ENTRY_PROMOTION_ALLOWED=FALSE" in runner
