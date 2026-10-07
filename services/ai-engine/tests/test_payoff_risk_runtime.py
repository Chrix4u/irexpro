"""Focused runtime tests for the qualified USDJPY payoff-risk policy."""
from __future__ import annotations

import unittest

from app.domain.models.baseline_xgboost import BaselineXGBoostModel


class _Classifier:
    def __init__(self, positive_probability: float) -> None:
        self._p = positive_probability

    def predict_proba(self, _frame):
        return [[1.0 - self._p, self._p]]


class _Regressor:
    def __init__(self, value: float) -> None:
        self._value = value

    def predict(self, _frame):
        return [self._value]


def _model(
    *,
    opportunity: float = 0.82,
    long_probability: float = 0.63,
    short_probability: float = 0.31,
    long_upside: float = 1.40,
    long_downside: float = 1.00,
    short_upside: float = 0.80,
    short_downside: float = 1.00,
) -> BaselineXGBoostModel:
    model = BaselineXGBoostModel()
    model._feature_names = ["instrument_USDJPY"]
    model._model_version = "test-payoff-risk"
    model._bundle = {
        "opportunity": _Classifier(opportunity),
        "long_direction": _Classifier(long_probability),
        "short_direction": _Classifier(short_probability),
        "payoff_long_upside": _Regressor(long_upside),
        "payoff_long_downside": _Regressor(long_downside),
        "payoff_short_upside": _Regressor(short_upside),
        "payoff_short_downside": _Regressor(short_downside),
    }
    return model


def _predict(model: BaselineXGBoostModel):
    return model._predict_with_event_hybrid_payoff_risk_bundle(
        {"instrument_USDJPY": 1.0}
    )


class PayoffRiskRuntimeTests(unittest.TestCase):
    def test_fully_qualified_long_signal_is_eligible(self):
        prediction = _predict(_model())

        self.assertEqual(prediction.direction, "BUY")
        self.assertTrue(prediction.explainability["signal_eligible"])
        self.assertEqual(prediction.explainability["signal_gate_reason"], "eligible")
        self.assertAlmostEqual(prediction.raw_scores["action_probability_margin"], 0.32)
        self.assertAlmostEqual(prediction.raw_scores["expected_selected_net_bps"], 0.40)
        self.assertAlmostEqual(prediction.raw_scores["expected_payoff_ratio"], 1.40)

        normalized_direction = 0.63 / (0.63 + 0.31)
        expected_joint = min(0.82, normalized_direction)
        self.assertAlmostEqual(
            prediction.raw_scores["joint_confidence"], expected_joint
        )
        self.assertAlmostEqual(
            prediction.confidence_score, round(expected_joint, 4)
        )

    def test_fails_closed_when_side_margin_is_too_small(self):
        prediction = _predict(
            _model(long_probability=0.46, short_probability=0.40)
        )
        self.assertFalse(prediction.explainability["signal_eligible"])
        self.assertEqual(
            prediction.explainability["signal_gate_reason"],
            "action_probability_margin_below_floor",
        )

    def test_fails_closed_when_expected_net_is_not_positive(self):
        prediction = _predict(_model(long_upside=0.90, long_downside=1.00))
        self.assertFalse(prediction.explainability["signal_eligible"])
        self.assertEqual(
            prediction.explainability["signal_gate_reason"],
            "expected_selected_net_not_positive",
        )

    def test_fails_closed_when_payoff_ratio_is_below_floor(self):
        prediction = _predict(_model(long_upside=1.10, long_downside=1.00))
        self.assertGreater(prediction.raw_scores["expected_selected_net_bps"], 0)
        self.assertLess(prediction.raw_scores["expected_payoff_ratio"], 1.15)
        self.assertFalse(prediction.explainability["signal_eligible"])
        self.assertEqual(
            prediction.explainability["signal_gate_reason"],
            "expected_payoff_ratio_below_floor",
        )

    def test_rejects_non_usdjpy_feature_vector(self):
        model = _model()
        with self.assertRaisesRegex(ValueError, "restricted to USDJPY"):
            model._predict_with_event_hybrid_payoff_risk_bundle(
                {"instrument_USDJPY": 0.0}
            )


if __name__ == "__main__":
    unittest.main()
