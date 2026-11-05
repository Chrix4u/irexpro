"""OOD research must preserve causal timestamps, future labels and no execution."""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta

import pandas as pd
import pytest

from app.domain.training.ood_shadow_candidate import (
    MIN_TRADING_DAYS,
    NUMERIC_FEATURES,
    chronological_split,
    input_features,
    prepare_cohort,
    summarize_independent_ood_conditions,
    study_from_csv,
)


def example(*, direction: str = "BUY") -> dict:
    decision = datetime(2026, 11, 5, 12, 0, tzinfo=UTC)
    record = {
        "instrument": "EURUSD",
        "route": "M1_TREND_CONTINUATION",
        "direction": direction,
        "decision_time_utc": decision.isoformat(),
        "signal_bar_time_utc": (decision - timedelta(minutes=1)).isoformat(),
        "entry_observed_at_utc": (decision - timedelta(seconds=15)).isoformat(),
        "future_observed_at_utc": (decision + timedelta(minutes=15, seconds=30)).isoformat(),
        "diagnostics_json": json.dumps(["extensionAtr:HARD_HIGH"]),
        "entry_bid": 1.1000,
        "entry_ask": 1.1002,
        "future_bid_15m": 1.1006,
        "future_ask_15m": 1.1008,
    }
    record.update({name: 0.32 for name in NUMERIC_FEATURES})
    record["stop_distance"] = 0.001
    return record


def test_asof_quotes_and_future_labels_never_enter_model_features() -> None:
    records, quality = prepare_cohort(pd.DataFrame([example()]))
    assert quality["raw_records"] == quality["causally_verified_records"] == 1
    # BUY after spread: +4.0 pips, subtract 1.0 extra estimated friction.
    assert records.iloc[0]["proxy_pips"] == pytest.approx(3.0)
    assert records.iloc[0]["label"] == 1
    features = input_features(records)
    assert "entry_bid" not in features
    assert "entry_ask" not in features
    assert "future_bid_15m" not in features
    assert "future_ask_15m" not in features
    assert "label" not in features
    assert "proxy_pips" not in features
    assert "ood_extensionAtr:HARD_HIGH" in features
    assert features.iloc[0]["ood_extensionAtr:HARD_HIGH"] == 1


def test_sells_use_bid_entry_and_ask_future_then_deduct_friction() -> None:
    records, _ = prepare_cohort(pd.DataFrame([example(direction="SELL")]))
    # SELL loses eight pips before extra friction; no positive label.
    assert records.iloc[0]["proxy_pips"] == pytest.approx(-9)
    assert records.iloc[0]["label"] == 0


@pytest.mark.parametrize(
    "field,delta",
    [
        ("entry_observed_at_utc", timedelta(seconds=1)),
        ("future_observed_at_utc", timedelta(minutes=14)),
        ("signal_bar_time_utc", timedelta(minutes=1)),
    ],
)
def test_rejects_future_lookahead_or_incomplete_horizon(field: str, delta: timedelta) -> None:
    candidate = example()
    decision = datetime.fromisoformat(candidate["decision_time_utc"])
    candidate[field] = (decision + delta).isoformat()
    with pytest.raises(ValueError, match="causal quote"):
        prepare_cohort(pd.DataFrame([candidate]))


def test_rejects_unusable_spread_and_missing_features() -> None:
    candidate = example()
    candidate["entry_ask"] = candidate["entry_bid"] - 0.0001
    with pytest.raises(ValueError, match="causal quote"):
        prepare_cohort(pd.DataFrame([candidate]))
    candidate = example()
    del candidate["momentum_5_atr"]
    with pytest.raises(ValueError, match="Missing required columns"):
        prepare_cohort(pd.DataFrame([candidate]))


def test_chronological_split_never_uses_adjacent_horizon_events_across_folds() -> None:
    records = []
    for day in range(MIN_TRADING_DAYS):
        start = datetime(2026, 9, 1, tzinfo=UTC) + timedelta(days=day)
        for minute in range(85):
            t = start + timedelta(minutes=minute)
            records.append({"decision_time_utc": t, "utc_day": t.date(), "label": minute % 2})
    train, valid, test = chronological_split(pd.DataFrame(records))
    assert len(train) > 150 and len(valid) > 150 and len(test) > 150
    assert (
        train["decision_time_utc"].max() + timedelta(minutes=60) < valid["decision_time_utc"].min()
    )
    assert (
        valid["decision_time_utc"].max() + timedelta(minutes=60) < test["decision_time_utc"].min()
    )


def test_refuses_two_days_no_matter_how_many_rows() -> None:
    records = []
    for day in range(2):
        start = datetime(2026, 11, 4, tzinfo=UTC) + timedelta(days=day)
        for minute in range(800):
            t = start + timedelta(minutes=minute)
            records.append({"decision_time_utc": t, "utc_day": t.date(), "label": minute % 2})
    with pytest.raises(ValueError, match="independent UTC trading days"):
        chronological_split(pd.DataFrame(records))


def test_real_like_scarce_data_blocks_fitting_and_promotion(tmp_path) -> None:
    examples = []
    for day in range(3):
        for pair in ("AUDUSD", "EURUSD", "GBPUSD"):
            for minute in range(60):
                row = example()
                row["instrument"] = pair
                start = datetime(2026, 11, 3 + day, 12, 0, tzinfo=UTC)
                moment = start + timedelta(minutes=minute)
                row["decision_time_utc"] = moment.isoformat()
                row["signal_bar_time_utc"] = (moment - timedelta(minutes=1)).isoformat()
                row["entry_observed_at_utc"] = (moment - timedelta(seconds=15)).isoformat()
                row["future_observed_at_utc"] = (
                    moment + timedelta(minutes=15, seconds=20)
                ).isoformat()
                examples.append(row)
    source = tmp_path / "cohort.csv"
    pd.DataFrame(examples).to_csv(source, index=False)
    report = study_from_csv(source)
    assert report["readiness"] == "BLOCKED_NOT_ENOUGH_VERIFIED_HISTORY"
    assert report["model_fitted"] is False
    assert report["auto_promotion"] is False
    assert report["authority"] == "RESEARCH_ONLY_NO_EXECUTION"
    assert report["label_is_verified_broker_net_pnl"] is False
    assert report["data_quality"]["distinct_utc_days"] == 3
    assert report["data_quality"]["causally_verified_records"] == 540


def test_synthetic_mature_history_can_fit_shadow_only_without_promotion() -> None:
    from app.domain.training.ood_shadow_candidate import run_study

    examples = []
    for day in range(12):
        for pair in ("AUDUSD", "EURUSD", "GBPUSD"):
            for minute in range(70):
                observation = example()
                moment = datetime(2026, 9, 1 + day, 12, 0, tzinfo=UTC) + timedelta(minutes=minute)
                observation["instrument"] = pair
                observation["decision_time_utc"] = moment.isoformat()
                observation["signal_bar_time_utc"] = (moment - timedelta(minutes=1)).isoformat()
                observation["entry_observed_at_utc"] = (moment - timedelta(seconds=15)).isoformat()
                observation["future_observed_at_utc"] = (
                    moment + timedelta(minutes=15, seconds=20)
                ).isoformat()
                is_profitable = minute % 2 == 0
                observation["future_bid_15m"] = 1.1006 if is_profitable else 1.0996
                observation["future_ask_15m"] = observation["future_bid_15m"] + 0.0002
                observation["alignedMomentum1Atr"] = 0.9 if is_profitable else -0.9
                examples.append(observation)
    frame, quality = prepare_cohort(pd.DataFrame(examples))
    assert quality["distinct_utc_days"] == 12
    result = run_study(frame)
    assert result["fit_completed"] is True
    assert result["serialized_model"] is False
    assert result["promotion_allowed"] is False
    assert result["validation"]["count"] >= 150
    assert result["untouched_test"]["count"] >= 150
    assert "balanced_accuracy" in result["untouched_test"]


def test_readonly_query_does_not_export_identifiers_or_use_future_quotes_as_features() -> None:
    from app.domain.training.ood_shadow_candidate import CATEGORICAL_FEATURES

    query = (
        __import__("pathlib").Path(__file__).resolve().parents[1]
        / "app/domain/training/ood_shadow_cohort_readonly.sql"
    ).read_text()
    result_columns = query.split("\nSELECT\n", 1)[1].split("\nFROM unique_decisions", 1)[0]
    assert "user_id" not in result_columns
    assert "broker_connection_id" not in result_columns
    assert "signal_id" not in result_columns
    assert "INSERT INTO" not in query.upper()
    assert "UPDATE trading" not in query
    assert "DELETE FROM" not in query
    assert "d.user_id::text = :'scanner_user'" in query
    assert "d.evaluated_at + INTERVAL '15 minutes'" in query
    assert CATEGORICAL_FEATURES == ("instrument", "route", "direction")


def test_scheduled_ood_research_cannot_dispatch_or_auto_publish_models() -> None:
    repo = __import__("pathlib").Path(__file__).resolve().parents[3]
    runner = (repo / "scripts/research/run_ood_shadow_training.sh").read_text()
    workflow = (repo / ".github/workflows/vps-ood-shadow-research.yml").read_text()
    query = (
        repo / "services/ai-engine/app/domain/training/ood_shadow_cohort_readonly.sql"
    ).read_text()

    assert "dotenv_values" in runner
    assert 'source "$api_env"' not in runner
    assert "VPS_FOREX_SCANNER_USER_ID" in runner
    assert 'chmod 600 "$tmp_cohort" "$tmp_report"' in runner
    assert "latest-report.json" in runner
    assert "latest-cohort.csv" in runner
    assert "OOD_SHADOW_PRODUCTION_PROMOTION=FALSE" in runner
    assert "cron: '20 16 * * 1-5'" in workflow
    assert "workflow_dispatch:" in workflow
    assert "SSH_KNOWN_HOSTS" in workflow
    assert "StrictHostKeyChecking=yes" in workflow
    assert "run_ood_shadow_training.sh" in workflow
    assert "INTERVAL '35 days'" in query
    assert "d.user_id::text = :'scanner_user'" in query


def test_ood_condition_outcomes_exclude_overlapping_pair_side_and_route() -> None:
    def at(minute: int, *, pair: str, direction: str, route: str) -> dict:
        row = example(direction=direction)
        decision = datetime(2026, 11, 5, 12, 0, tzinfo=UTC) + timedelta(minutes=minute)
        row["instrument"] = pair
        row["route"] = route
        row["decision_time_utc"] = decision.isoformat()
        row["signal_bar_time_utc"] = (decision - timedelta(minutes=1)).isoformat()
        row["entry_observed_at_utc"] = (decision - timedelta(seconds=15)).isoformat()
        row["future_observed_at_utc"] = (
            decision + timedelta(minutes=15, seconds=30)
        ).isoformat()
        return row

    candidates = [
        at(0, pair="EURUSD", direction="BUY", route="M1_TREND_CONTINUATION"),
        at(1, pair="EURUSD", direction="SELL", route="M1_EARLY_TRANSITION"),
        at(2, pair="GBPUSD", direction="BUY", route="M1_TREND_CONTINUATION"),
        at(15, pair="EURUSD", direction="BUY", route="M1_TREND_CONTINUATION"),
        at(16, pair="EURUSD", direction="BUY", route="M1_EARLY_TRANSITION"),
    ]
    records, quality = prepare_cohort(pd.DataFrame(candidates))
    assert quality["causally_verified_records"] == 5
    outcomes = summarize_independent_ood_conditions(records)
    assert outcomes["independent_opportunities"] == 3
    assert outcomes["distinct_utc_days"] == 1
    assert outcomes["overall"]["observations"] == 3
    assert outcomes["overall"]["mean_proxy_pips"] == pytest.approx(3.0)
    assert outcomes["condition_outcomes"][0] == {
        "dimension": "extensionAtr:HARD_HIGH",
        "observations": 3,
        "distinct_utc_days": 1,
        "pair_counts": {"EURUSD": 2, "GBPUSD": 1},
        "mean_proxy_pips": 3.0,
        "positive_proxy_fraction": 1.0,
        "proxy_profit_factor": None,
    }
    assert outcomes["labels_are_real_broker_net_pnl"] is False
    assert outcomes["authority"] == "RESEARCH_ONLY_NO_EXECUTION"


def test_ood_condition_report_excludes_unrecognized_input_tags(tmp_path) -> None:
    row = example()
    row["diagnostics_json"] = json.dumps(["extensionAtr:HARD_HIGH", "UNTRUSTED_RAW_TAG"])
    source = tmp_path / "ood.csv"
    pd.DataFrame([row]).to_csv(source, index=False)
    report = study_from_csv(source)
    audit = report["independent_ood_condition_outcomes"]
    assert [c["dimension"] for c in audit["condition_outcomes"]] == [
        "extensionAtr:HARD_HIGH"
    ]
    assert audit["independent_opportunities"] == 1
    assert report["model_fitted"] is False
    assert report["promotion_allowed"] is False
    assert report["auto_promotion"] is False
