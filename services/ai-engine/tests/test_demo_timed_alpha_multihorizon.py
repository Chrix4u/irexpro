"""Tests of NON-promoting chronological short-horizon forecast research."""
from __future__ import annotations

from copy import deepcopy
from datetime import UTC, datetime, timedelta

from unittest import TestCase, main

from app.domain.training.demo_timed_alpha_multihorizon import (
    HORIZONS,
    chronological_holdout,
    evaluate,
    load_research_cohort,
)


def _episode(when: datetime, i: int, good: bool) -> dict:
    # Two patterns for logistic and ridge. Labels MUST remain separate.
    net = 11.5 + (i % 3) if good else -9.5 - (i % 5)
    return {
        "instrument": ("EURUSD", "GBPUSD", "USDJPY")[i % 3],
        "direction": "SELL" if i % 2 else "BUY",
        "route": "M1_TREND_CONTINUATION",
        "persistedDecisionAt": when.isoformat().replace("+00:00", "Z"),
        "planBAdmitted": (i % 3 == 0),
        "observedBrokerAuthority": False,
        "researchRegime": "TREND_HEALTHY",
        "features": {
            "confidence": 0.7 + (0.08 if good else -0.08),
            "alignedMomentum3Atr": 0.5 if good else -0.5,
            "planBExpectedR": 0.15 if good else -0.15,
            "FUTURE_PRICE_NO_LEAKAGE": 9999999,
        },
        "feeEvidenceAvailable": True,
        "labels": {
            str(h): {
                "netUsd1Lot": net,
                "signedPips": net / 10,
                "positiveAfterCosts": net > 0,
                "markLagSec": 20.0,
            } for h in HORIZONS
        },
        "oppositeLabels": {
            str(h): {
                "netUsd1Lot": -net - 6,  # independently pays two-sided costs
                "signedPips": -net / 10,
                "positiveAfterCosts": -net - 6 > 0,
                "markLagSec": 20.0,
            } for h in HORIZONS
        },
    }


def _research_dataset(train=80, holdout=40) -> dict:
    begin = datetime(2026, 11, 10, 12, tzinfo=UTC)
    later = datetime(2026, 11, 11, 12, tzinfo=UTC)
    rows = [_episode(begin + timedelta(minutes=5 * i), i, i % 3 == 0)
            for i in range(train)]
    rows += [_episode(later + timedelta(minutes=5 * i), i + 1000, i % 2 == 0)
             for i in range(holdout)]
    return {
        "artifact": "irexpro-offline-1-3-5-10m-research-cohort-v1",
        "trainingAuthority": "NONE",
        "promotionAllowed": False,
        "brokerOrders": 0,
        "rowCount": len(rows),
        "rows": rows,
    }


class TimedAlphaResearchTest(TestCase):
    def test_refuses_any_executable_or_nonresearch_dataset(self):
        d = _research_dataset(5, 5)
        for key, value in [
            ("trainingAuthority", "DEMO_EXECUTION"),
            ("promotionAllowed", True),
            ("brokerOrders", 1),
            ("artifact", "production-model-weights"),
        ]:
            mutated = deepcopy(d)
            mutated[key] = value
            with self.assertRaises(ValueError):
                load_research_cohort(mutated)


    def test_research_features_never_contain_future_data_or_broker_identity(self):
        d = _research_dataset(3, 3)
        d["rows"][0]["features"]["afterTradeOutcomeUSD"] = 8000
        d["rows"][0]["broker_connection_id"] = "DO_NOT_LEAK"
        parsed = load_research_cohort(d)
        assert "afterTradeOutcomeUSD" not in parsed[0]["features"]
        assert "FUTURE_PRICE_NO_LEAKAGE" not in parsed[0]["features"]
        assert "broker_connection_id" not in parsed[0]
        assert parsed[0]["features"]["alignedMomentum3Atr"] == 0.5


    def test_utc_day_purge_removes_train_lookahead_at_holdout_boundary(self):
        d = _research_dataset(3, 3)
        d["rows"].append(_episode(datetime(2026, 11, 10, 23, 50, tzinfo=UTC), 999, False))
        parsed = load_research_cohort(d)
        train, holdout, details = chronological_holdout(parsed, 10)
        assert details["embargoMinutes"] == 20
        assert all(row["time"].isoformat() < "2026-11-10T23:40:00+00:00" for row in train)
        assert all(row["time"].date().isoformat() == "2026-11-11" for row in holdout)
        assert details["trainDays"] == 1
        assert details["holdoutDays"] == 1


    def test_models_fit_with_train_only_and_latest_day_holdout_but_never_promote(self):
        report = evaluate(_research_dataset())
        assert report["cohortRows"] == 120
        assert report["utcDays"] == 2
        assert report["promotionAllowed"] is False
        assert report["brokerOrders"] == 0
        assert report["modelArtifactSaved"] is False
        assert len(report["horizons"]) == 4
        for horizon in report["horizons"]:
            assert horizon["modelFitted"] is True
            assert horizon["readiness"] == "EXPLORATORY_ONLY_INSUFFICIENT_DAYS"
            assert horizon["split"]["trainDays"] == 1
            assert horizon["split"]["holdoutDays"] == 1
            assert horizon["holdoutAll"]["n"] == 40
            assert 0 < horizon["modelDiagnostics"]["brier"] < 1
            assert horizon["modelDiagnostics"]["trainOnlyExpectedNetThreshold"] >= 0


    def test_holdout_labels_never_refit_model_or_pick_training_threshold(self):
        data = _research_dataset()
        first = evaluate(data)
        updated = deepcopy(data)
        for row in updated["rows"]:
            if row["persistedDecisionAt"].startswith("2026-11-11"):
                for label in row["labels"].values():
                    label["netUsd1Lot"] = -25 if label["netUsd1Lot"] > 0 else 25
                    label["positiveAfterCosts"] = label["netUsd1Lot"] > 0
        second = evaluate(updated)
        for a, b in zip(first["horizons"], second["horizons"], strict=True):
            assert a["modelDiagnostics"]["trainOnlyExpectedNetThreshold"] == (
                b["modelDiagnostics"]["trainOnlyExpectedNetThreshold"]
            )
            assert a["modelDiagnostics"]["holdoutMeanPredictedNetOneLot"] == (
                b["modelDiagnostics"]["holdoutMeanPredictedNetOneLot"]
            )
            assert a["modelDiagnostics"]["holdoutMeanActualNetOneLot"] != (
                b["modelDiagnostics"]["holdoutMeanActualNetOneLot"]
            )


    def test_paired_side_model_never_routes_orders_and_ignores_holdout_labels_when_fitting(self):
        first = evaluate(_research_dataset())
        assert len(first["pairedDirection"]) == 4
        for p in first["pairedDirection"]:
            assert p["authority"] == "RESEARCH_ONLY_NO_EXECUTION"
            assert p["modelFitted"] is True
            assert p["promotionAllowed"] is False and p["brokerOrders"] == 0
            assert p["holdoutOriginalDirection"]["n"] == 40
            assert p["holdoutAlwaysOpposite"]["n"] == 40
            assert p["noEdgeCount"] + p["chosenOriginalCount"] + p["chosenOppositeCount"] == 40
        updated = _research_dataset()
        for row in updated["rows"]:
            if row["persistedDecisionAt"].startswith("2026-11-11"):
                for h in HORIZONS:
                    row["oppositeLabels"][str(h)]["netUsd1Lot"] = -500
        second = evaluate(updated)
        for a, b in zip(first["pairedDirection"], second["pairedDirection"], strict=True):
            assert a["diagnostics"]["meanPredictedOriginalUSD"] == (
                b["diagnostics"]["meanPredictedOriginalUSD"]
            )
            assert a["diagnostics"]["meanPredictedOppositeUSD"] == (
                b["diagnostics"]["meanPredictedOppositeUSD"]
            )
            assert a["chosenOppositeCount"] == b["chosenOppositeCount"]
            assert a["holdoutAlwaysOpposite"]["avgNetUsdOneLot"] != (
                b["holdoutAlwaysOpposite"]["avgNetUsdOneLot"]
            )

    def test_insufficient_training_days_does_not_fit_or_promote(self):
        data = _research_dataset(60, 0)
        report = evaluate(data)
        assert report["utcDays"] == 1
        assert all(row["modelFitted"] is False for row in report["horizons"])
        assert all(row["promotionAllowed"] is False for row in report["horizons"])


    def test_missing_or_nonfinite_labels_do_not_turn_into_wins(self):
        data = _research_dataset(4, 4)
        data["rows"][0]["labels"]["1"]["netUsd1Lot"] = "NaN"
        data["rows"][1]["labels"]["1"]["netUsd1Lot"] = "Infinity"
        parsed = load_research_cohort(data)
        assert 1 not in parsed[0]["labels"]
        assert 1 not in parsed[1]["labels"]

if __name__ == "__main__":
    main()
