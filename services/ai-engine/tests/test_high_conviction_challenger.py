from __future__ import annotations

from app.domain.models.high_conviction_challenger import PlanBV4HighConvictionChallenger
from app.domain.models.multitimeframe_features import MULTITIMEFRAME_FEATURE_COLUMNS


class FakeClassifier:
    def __init__(self, probability_long: float) -> None:
        self.probability_long = probability_long

    def predict_proba(self, frame):
        p = self.probability_long
        return [[1.0 - p, p]]


def challenger(
    *,
    two_dir: float = 0.8,
    pair_dir: float = 0.7,
    regime_dir: float = 0.9,
    opportunity: float = 0.6,
) -> PlanBV4HighConvictionChallenger:
    model = PlanBV4HighConvictionChallenger()
    model._loaded = True
    model._features = list(MULTITIMEFRAME_FEATURE_COLUMNS)
    model._manifest = {
        "artifact": "plan-b-v4-oof-three-expert-consensus-challenger",
        "frozen_consensus": {
            "opp_floor": 0.55,
            "margin_floor": 0.0,
            "votes_required": 3,
        },
    }
    model._routers = {
        symbol: {
            "m1_spread_bps_median": 0.3,
            "m1_volatility_20_median": 0.0001,
        }
        for symbol in ("AUDUSD", "EURUSD", "GBPUSD", "USDCAD", "USDCHF", "USDJPY")
    }
    model._models = {
        "two_direction": FakeClassifier(two_dir),
        "two_opportunity": FakeClassifier(opportunity),
        "pair_direction": {
            symbol: FakeClassifier(pair_dir)
            for symbol in ("AUDUSD", "EURUSD", "GBPUSD", "USDCAD", "USDCHF", "USDJPY")
        },
        "pair_opportunity": FakeClassifier(opportunity),
        "regime_direction": {
            **{
                f"{symbol}::fallback": FakeClassifier(regime_dir)
                for symbol in ("AUDUSD", "EURUSD", "GBPUSD", "USDCAD", "USDCHF", "USDJPY")
            },
            "EURUSD::calm": FakeClassifier(regime_dir),
            "EURUSD::active_clean": FakeClassifier(regime_dir),
            "EURUSD::stressed": FakeClassifier(regime_dir),
        },
        "regime_opportunity": FakeClassifier(opportunity),
    }
    return model


def features(*, spread: float = 0.2, volatility: float = 0.00005):
    result = {name: 0.0 for name in MULTITIMEFRAME_FEATURE_COLUMNS}
    result["m1_spread_bps"] = spread
    result["m1_volatility_20"] = volatility
    result["instrument_EURUSD"] = 1.0
    return result


def test_unanimous_high_opportunity_is_admitted_shadow_only():
    result = challenger().score(instrument="EURUSD", features=features())

    assert result["admitted"] is True
    assert result["direction"] == "BUY"
    assert result["long_votes"] == 3
    assert result["opportunity_floor"] == 0.55
    assert result["modifies_execution"] is False
    assert result["paper_promotion_eligible"] is False


def test_direction_disagreement_fails_frozen_three_vote_rule():
    result = challenger(pair_dir=0.3).score(
        instrument="EURUSD",
        features=features(),
    )

    assert result["admitted"] is False
    assert result["long_votes"] == 2
    assert result["short_votes"] == 1


def test_opportunity_floor_is_enforced_exactly():
    result = challenger(opportunity=0.549).score(
        instrument="EURUSD",
        features=features(),
    )

    assert result["admitted"] is False
    assert result["mean_opportunity_probability"] < 0.55


def test_regime_routing_matches_training_policy():
    model = challenger()

    calm = model.score(
        instrument="EURUSD",
        features=features(spread=0.2, volatility=0.00005),
    )
    active = model.score(
        instrument="EURUSD",
        features=features(spread=0.2, volatility=0.0002),
    )
    stressed = model.score(
        instrument="EURUSD",
        features=features(spread=0.4, volatility=0.0002),
    )

    assert calm["regime"] == "calm"
    assert active["regime"] == "active_clean"
    assert stressed["regime"] == "stressed"


def test_untrained_regime_uses_pair_fallback():
    result = challenger().score(
        instrument="AUDUSD",
        features=features(spread=0.2, volatility=0.00005),
    )

    regime_expert = result["experts"][2]
    assert regime_expert["regime"] == "calm"
    assert regime_expert["used_fallback"] is True
