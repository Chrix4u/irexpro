"""Tests for nested model-qualification experiments and immutable research governance."""
from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from app.domain.models.multitimeframe_features import MULTITIMEFRAME_FEATURE_COLUMNS
from app.domain.training import model_qualification as qualification
from app.domain.training.model_qualification import (
    ACTIONABLE_LABEL_POLICY,
    ACTIONABLE_TARGET_COLUMN,
    CONFIDENCE_FLOOR,
    EVENT_DUAL_ACTIONABILITY_EXPERIMENT_NAME,
    EVENT_LONG_ACTIONABLE_TARGET_COLUMN,
    EVENT_PAIR_EXPERT_EXPERIMENT_NAME,
    EVENT_PAIR_REGIME_EXPERT_EXPERIMENT_NAME,
    EVENT_PAIR_RETURN_MARGIN_EXPERIMENT_NAME,
    EVENT_SHORT_ACTIONABLE_TARGET_COLUMN,
    EVENT_TWO_STAGE_EXPERIMENT_NAME,
    OPPORTUNITY_CLASSIFICATION_THRESHOLD,
    OPPORTUNITY_SAMPLE_WEIGHT_POLICY,
    TWO_STAGE_EXPERIMENT_NAME,
    ModelVariant,
    QualificationExperiment,
    _apply_calibrator,
    _dual_actionability_diagnostics,
    _ensure_actionable_target,
    _ensure_event_dual_actionability_targets,
    _event_dual_actionability_prediction_frame,
    _event_return_margin_bps,
    _event_two_stage_prediction_frame,
    _feature_columns,
    _fit_calibrator,
    _fit_event_pair_experts_for_outer,
    _fit_event_pair_regime_experts_for_outer,
    _locked_gate_snapshot,
    _nested_windows,
    _opportunity_class_balance_weights,
    _opportunity_classification,
    _pair_expert_probabilities,
    _pair_regime_expert_probabilities,
    _pair_return_margin_probabilities,
    _prediction_frame,
    _select_decision_threshold,
    _two_stage_prediction_frame,
    default_experiments,
    evaluate_qualification_corpora,
    run_nested_qualification_experiments,
)
from app.domain.training.qualification_diagnostics import (
    causal_regime_diagnostics,
    feature_gain_stability_diagnostics,
)
from app.domain.training.train_multitimeframe import (
    EVENT_ACTIONABLE_TARGET_COLUMN,
    EVENT_BARRIER_RETURN_COLUMN,
    EVENT_DIRECTION_TARGET_COLUMN,
    EVENT_LABEL_POLICY,
    EVENT_LONG_NET_RETURN_COLUMN,
    EVENT_SHORT_NET_RETURN_COLUMN,
    EVENT_STEP_COLUMN,
    TARGET_COLUMN,
    run_pooled_walk_forward_with_predictions,
)
from app.domain.training.validation import compute_classification_metrics


class _FakeModel:
    best_iteration = 2

    def fit(self, *_args, **_kwargs):
        return self

    def predict_proba(self, features):
        signal = np.asarray(features["m1_simple_return"], dtype=float)
        probability = np.where(signal >= 0.0, 0.70, 0.30)
        return np.column_stack([1.0 - probability, probability])

    def get_booster(self):
        class _Booster:
            def get_score(self, importance_type):
                assert importance_type == "gain"
                return {}

        return _Booster()


def _research_dataset(
    periods: int = 700,
    instruments: tuple[str, ...] = ("EURUSD", "GBPUSD"),
) -> pd.DataFrame:
    rows: list[dict[str, object]] = []
    times = pd.date_range("2026-01-01T00:00:00Z", periods=periods, freq="min")
    for period_index, decision_time in enumerate(times):
        for instrument_index, instrument in enumerate(instruments):
            target = int((period_index + instrument_index) % 2 == 0)
            row: dict[str, object] = {
                "decision_time": decision_time,
                "instrument": instrument,
                "target": target,
                "long_net_return": 0.001 if target else -0.001,
                "short_net_return": -0.001 if target else 0.001,
                "m1_spread_bps": 1.0,
            }
            for column in MULTITIMEFRAME_FEATURE_COLUMNS:
                row[column] = 0.0
            row["m1_simple_return"] = 0.01 if target else -0.01
            rows.append(row)
    return pd.DataFrame(rows).sort_values(
        ["decision_time", "instrument"]
    ).reset_index(drop=True)


def test_default_experiment_matrix_is_bounded_and_keeps_locked_baseline():
    experiments = default_experiments()

    assert experiments[0].name == "baseline"
    baseline = experiments[0].variants[0]
    assert baseline.name == "baseline_locked"
    assert baseline.parameter_overrides == ()
    assert baseline.sample_weight_policy == "economic"
    assert baseline.calibration == "none"
    assert baseline.feature_policy == "all"
    assert sum(len(experiment.variants) for experiment in experiments) == 15
    assert experiments[-7].name == "structure_feature_ablation"
    assert experiments[-6].name == TWO_STAGE_EXPERIMENT_NAME
    assert experiments[-6].mode == "two_stage_actionable"
    assert experiments[-5].name == EVENT_TWO_STAGE_EXPERIMENT_NAME
    assert experiments[-5].mode == "two_stage_event"
    assert experiments[-4].name == EVENT_PAIR_EXPERT_EXPERIMENT_NAME
    assert experiments[-4].mode == "two_stage_event_pair_experts"
    assert experiments[-3].name == EVENT_PAIR_RETURN_MARGIN_EXPERIMENT_NAME
    assert experiments[-3].mode == "two_stage_event_pair_return_margin"
    assert experiments[-2].name == EVENT_PAIR_REGIME_EXPERT_EXPERIMENT_NAME
    assert experiments[-2].mode == "two_stage_event_pair_regime_experts"
    assert experiments[-1].name == EVENT_DUAL_ACTIONABILITY_EXPERIMENT_NAME
    assert experiments[-1].mode == "event_dual_actionability"
    assert experiments[-1].tune_decision_threshold is False
    assert CONFIDENCE_FLOOR == 0.60
    assert ACTIONABLE_LABEL_POLICY.endswith("_v1")


def test_nested_windows_are_chronological_disjoint_and_purged():
    dataset = _research_dataset(periods=500, instruments=("EURUSD",))
    windows = _nested_windows(
        dataset,
        horizon_bars=10,
        min_inner_periods=30,
    )

    ordered = [
        windows.fit,
        windows.early_stop,
        windows.calibration,
        windows.selection,
    ]
    for earlier, later in zip(ordered, ordered[1:]):
        assert earlier["decision_time"].max() < later["decision_time"].min()
        gap = (
            later["decision_time"].min() - earlier["decision_time"].max()
        ).total_seconds() / 60.0
        assert gap > 10
        assert set(earlier["decision_time"]).isdisjoint(later["decision_time"])


def test_platt_calibration_is_deterministic_and_isotonic_requires_evidence():
    raw = np.array([0.2, 0.3, 0.4, 0.6, 0.7, 0.8] * 20, dtype=float)
    labels = np.array([0, 0, 1, 0, 1, 1] * 20, dtype=int)

    first = _apply_calibrator(
        _fit_calibrator("platt", probabilities=raw, labels=labels),
        raw,
    )
    second = _apply_calibrator(
        _fit_calibrator("platt", probabilities=raw, labels=labels),
        raw,
    )

    np.testing.assert_allclose(first, second)
    assert np.isfinite(first).all()
    assert ((first > 0.0) & (first < 1.0)).all()

    with pytest.raises(ValueError, match="isotonic calibration requires sufficient"):
        _fit_calibrator("isotonic", probabilities=raw, labels=labels)


def test_decision_threshold_selection_is_deterministic_and_does_not_change_confidence_floor():
    probabilities = np.array([0.20, 0.35, 0.48, 0.52, 0.65, 0.80])
    labels = np.array([0, 0, 0, 1, 1, 1])

    first_threshold, first_metrics = _select_decision_threshold(labels, probabilities)
    second_threshold, second_metrics = _select_decision_threshold(labels, probabilities)

    assert first_threshold == second_threshold
    assert first_metrics == second_metrics
    assert first_threshold in qualification.DECISION_THRESHOLD_GRID
    assert CONFIDENCE_FLOOR == 0.60


def test_prediction_frame_rejects_any_confidence_floor_below_060():
    source = _research_dataset(periods=4, instruments=("EURUSD",))
    raw = np.array([0.7, 0.3, 0.7, 0.3])

    with pytest.raises(ValueError, match="must not be lowered below 0.60"):
        _prediction_frame(
            source,
            raw_probabilities=raw,
            calibrated_probabilities=raw,
            decision_threshold=0.50,
            confidence_floor=0.59,
            fold=1,
            experiment="test",
            variant=ModelVariant(name="test"),
        )


def test_locked_research_gates_are_exactly_preserved():
    assert _locked_gate_snapshot() == {
        "min_balanced_accuracy": 0.52,
        "min_sharpe_ratio": 1.0,
        "min_profit_factor": 1.15,
        "max_drawdown": 0.12,
        "min_positive_fold_fraction": 0.60,
        "min_positive_instrument_fraction": 0.67,
    }


def test_qualification_entrypoint_requires_research_cutoff_before_loading_data(tmp_path):
    with pytest.raises(ValueError, match="decision_time_before is required"):
        qualification.evaluate_qualification_corpora(
            {"EURUSD": tmp_path / "never-read.csv"},
            horizon_bars=10,
            decision_time_before=None,
            report_path=tmp_path / "report.json",
        )


def test_all_feature_policy_preserves_canonical_training_runtime_contract():
    assert qualification._feature_columns("all") == list(MULTITIMEFRAME_FEATURE_COLUMNS)
    ablated = qualification._feature_columns("drop_volume")
    assert set(ablated).issubset(MULTITIMEFRAME_FEATURE_COLUMNS)
    assert len(ablated) < len(MULTITIMEFRAME_FEATURE_COLUMNS)


def test_outer_validation_is_never_passed_to_inner_selection_or_refit(monkeypatch):
    dataset = _research_dataset()
    candidate = ModelVariant(name="candidate", calibration="none")
    experiments = (
        QualificationExperiment(
            name="baseline",
            variants=(ModelVariant(name="baseline_locked"),),
        ),
        QualificationExperiment(
            name="candidate",
            variants=(candidate,),
            tune_decision_threshold=True,
        ),
    )
    training_windows: list[tuple[pd.Timestamp, pd.Timestamp]] = []

    def fake_select(training_window, **_kwargs):
        training_windows.append(
            (
                training_window["decision_time"].min(),
                training_window["decision_time"].max(),
            )
        )
        return candidate, 0.50, [
            {
                "variant": "candidate",
                "eligible": True,
                "decision_threshold": 0.50,
                "selection_key": [1.0, 0.0, 1.0, 1.0, 0.0],
            }
        ]

    def fake_refit(training_window, *, variant, **_kwargs):
        training_windows.append(
            (
                training_window["decision_time"].min(),
                training_window["decision_time"].max(),
            )
        )
        return _FakeModel(), qualification._CalibrationModel(method="none"), [
            "m1_simple_return"
        ]

    monkeypatch.setattr(
        qualification,
        "_select_variant_inside_outer_training",
        fake_select,
    )
    monkeypatch.setattr(qualification, "_fit_selected_for_outer", fake_refit)

    report = run_nested_qualification_experiments(
        dataset,
        horizon_bars=5,
        confidence_floor=0.60,
        max_splits=2,
        min_train_periods=300,
        validation_periods=100,
        min_inner_periods=30,
        experiments=experiments,
    )

    validation_starts = [
        pd.Timestamp(fold["validation_start"])
        for fold in report["experiments"]["baseline"]["folds"]
    ]
    assert len(training_windows) == len(validation_starts) * 3
    for fold_index, validation_start in enumerate(validation_starts):
        fold_training_windows = training_windows[fold_index * 3 : (fold_index + 1) * 3]
        assert all(train_end < validation_start for _, train_end in fold_training_windows)
    for experiment in report["experiments"].values():
        for fold in experiment["folds"]:
            assert pd.Timestamp(fold["train_end"]) < pd.Timestamp(
                fold["validation_start"]
            )
    assert report["untouched_final_test_used"] is False
    assert report["outer_validation_used_for_tuning"] is False
    assert report["governance"]["research_gates_lowered"] is False
    assert report["governance"]["weak_pairs_removed"] is False
    assert report["governance"]["bad_folds_removed"] is False


def test_nested_locked_baseline_reproduces_legacy_walk_forward_metrics(monkeypatch):
    dataset = _research_dataset()

    monkeypatch.setattr(
        "app.domain.training.train_multitimeframe._build_model",
        lambda: _FakeModel(),
    )
    monkeypatch.setattr(qualification, "_build_model", lambda: _FakeModel())

    legacy, _ = run_pooled_walk_forward_with_predictions(
        dataset,
        horizon_bars=5,
        confidence_threshold=0.60,
        min_train_periods=300,
        validation_periods=100,
        purge_periods=5,
        embargo_periods=5,
        max_splits=2,
    )
    nested = run_nested_qualification_experiments(
        dataset,
        horizon_bars=5,
        confidence_floor=0.60,
        max_splits=2,
        min_train_periods=300,
        validation_periods=100,
        min_inner_periods=30,
        experiments=default_experiments()[:1],
    )
    baseline = nested["experiments"]["baseline"]

    assert baseline["overall"]["classification"] == legacy["overall"]["classification"]
    assert baseline["overall"]["trading"] == legacy["overall"]["trading"]
    assert baseline["fold_count"] == legacy["fold_count"]



def test_qualification_checkpoints_resume_without_refitting(monkeypatch, tmp_path):
    dataset = _research_dataset(periods=500, instruments=("EURUSD",))
    fit_calls = 0

    def fake_fit(*_args, **_kwargs):
        nonlocal fit_calls
        fit_calls += 1
        return (
            _FakeModel(),
            qualification._CalibrationModel(method="none"),
            list(MULTITIMEFRAME_FEATURE_COLUMNS),
        )

    monkeypatch.setattr(qualification, "_fit_selected_for_outer", fake_fit)

    kwargs = {
        "horizon_bars": 5,
        "confidence_floor": 0.60,
        "max_splits": 2,
        "min_train_periods": 300,
        "validation_periods": 100,
        "min_inner_periods": 30,
        "experiments": default_experiments()[:1],
        "checkpoint_dir": tmp_path / "qualification-checkpoints",
        "checkpoint_fingerprint": "stable-fingerprint",
    }

    first = run_nested_qualification_experiments(dataset, **kwargs)
    first_fit_calls = fit_calls
    assert first_fit_calls > 0

    second = run_nested_qualification_experiments(dataset, **kwargs)
    assert fit_calls == first_fit_calls
    assert (
        second["candidate_comparison_table"]
        == first["candidate_comparison_table"]
    )

    incompatible = dict(kwargs)
    incompatible["checkpoint_fingerprint"] = "different-fingerprint"
    run_nested_qualification_experiments(dataset, **incompatible)
    assert fit_calls > first_fit_calls



def test_opportunity_weights_strengthen_rare_class_without_extreme_values():
    frame = pd.DataFrame(
        {EVENT_ACTIONABLE_TARGET_COLUMN: ([0] * 90) + ([1] * 10)}
    )

    opportunity = _opportunity_class_balance_weights(frame)
    moderate = qualification._binary_class_balance_weights(
        frame,
        target_column=EVENT_ACTIONABLE_TARGET_COLUMN,
    )

    assert OPPORTUNITY_SAMPLE_WEIGHT_POLICY == "inverse_frequency_power_0_75_capped_v1"
    assert opportunity.mean() == pytest.approx(1.0)
    assert opportunity.min() >= 0.25
    assert opportunity.max() <= 4.0
    assert opportunity[-1] > moderate[-1]
    assert opportunity[-1] / opportunity[0] > moderate[-1] / moderate[0]


def test_actionable_target_keeps_every_row_and_requires_positive_net_edge():
    frame = pd.DataFrame(
        {
            "long_net_return": [0.0010, -0.0004, -0.0002, 0.0],
            "short_net_return": [-0.0012, -0.0001, 0.0003, 0.0],
        }
    )

    labeled = _ensure_actionable_target(frame)

    assert len(labeled) == len(frame)
    assert labeled[ACTIONABLE_TARGET_COLUMN].tolist() == [1, 0, 1, 0]
    assert ACTIONABLE_TARGET_COLUMN not in frame.columns


def test_two_stage_trade_requires_opportunity_and_direction_confidence():
    source = _research_dataset(periods=3, instruments=("EURUSD",))
    source = _ensure_actionable_target(source)

    predictions = _two_stage_prediction_frame(
        source,
        direction_probabilities=np.array([0.70, 0.70, 0.55]),
        opportunity_probabilities=np.array([0.70, 0.55, 0.90]),
        confidence_floor=0.60,
        fold=1,
        experiment=TWO_STAGE_EXPERIMENT_NAME,
        variant=ModelVariant(name="actionable_v2_direction"),
    )

    assert predictions["active_trade"].tolist() == [True, False, False]
    assert predictions["predicted_opportunity"].tolist() == [True, False, True]
    assert np.allclose(
        predictions["confidence"].to_numpy(dtype=float),
        np.array([0.70, 0.55, 0.55]),
    )
    assert len(predictions) == len(source)
    assert set(predictions["actionable_label_policy"]) == {ACTIONABLE_LABEL_POLICY}



def test_opportunity_classification_threshold_is_separate_from_trade_confidence_floor():
    source = _research_dataset(periods=4, instruments=("EURUSD",))
    source = _ensure_actionable_target(source)
    source[ACTIONABLE_TARGET_COLUMN] = [0, 0, 1, 1]

    predictions = _two_stage_prediction_frame(
        source,
        direction_probabilities=np.array([0.70, 0.70, 0.70, 0.70]),
        opportunity_probabilities=np.array([0.45, 0.49, 0.51, 0.55]),
        confidence_floor=0.60,
        fold=1,
        experiment=TWO_STAGE_EXPERIMENT_NAME,
        variant=ModelVariant(name="actionable_v2_direction"),
    )

    metrics = _opportunity_classification(predictions)

    assert OPPORTUNITY_CLASSIFICATION_THRESHOLD == pytest.approx(0.50)
    assert CONFIDENCE_FLOOR == pytest.approx(0.60)
    assert metrics is not None
    assert metrics["balanced_accuracy"] == pytest.approx(1.0)
    assert predictions["predicted_opportunity"].tolist() == [False, False, False, False]
    assert predictions["active_trade"].tolist() == [False, False, False, False]


def test_two_stage_summary_uses_joint_not_direction_only_coverage():
    source = _research_dataset(periods=3, instruments=("EURUSD",))
    source = _ensure_actionable_target(source)
    predictions = _two_stage_prediction_frame(
        source,
        direction_probabilities=np.array([0.70, 0.70, 0.55]),
        opportunity_probabilities=np.array([0.70, 0.55, 0.90]),
        confidence_floor=0.60,
        fold=1,
        experiment=TWO_STAGE_EXPERIMENT_NAME,
        variant=ModelVariant(name="actionable_v2_direction"),
    )

    summary = qualification._summarize_predictions(
        predictions,
        horizon_bars=1,
        confidence_threshold=0.60,
    )

    assert summary["diagnostics"]["confidence_coverage"]["count"] == 1
    assert summary["diagnostics"]["confidence_coverage"]["fraction"] == pytest.approx(
        1.0 / 3.0
    )
    assert (
        summary["diagnostics"]["direction_only_confidence_coverage"]["fraction"]
        == pytest.approx(2.0 / 3.0)
    )


def test_event_two_stage_prediction_keeps_timeouts_for_economics():
    source = _research_dataset(periods=4, instruments=("EURUSD",))
    source[EVENT_ACTIONABLE_TARGET_COLUMN] = [1, 0, 1, 0]
    source[EVENT_DIRECTION_TARGET_COLUMN] = [1, 0, 0, 0]
    source[EVENT_LONG_NET_RETURN_COLUMN] = [0.0010, -0.0002, -0.0012, 0.0001]
    source[EVENT_SHORT_NET_RETURN_COLUMN] = [-0.0011, -0.0001, 0.0011, -0.0002]
    source[EVENT_STEP_COLUMN] = [1, 5, 2, 5]
    source[EVENT_BARRIER_RETURN_COLUMN] = [0.0005] * 4

    predictions = _event_two_stage_prediction_frame(
        source,
        direction_probabilities=np.array([0.75, 0.70, 0.25, 0.80]),
        opportunity_probabilities=np.array([0.80, 0.90, 0.85, 0.40]),
        confidence_floor=0.60,
        fold=1,
        experiment=EVENT_TWO_STAGE_EXPERIMENT_NAME,
        variant=ModelVariant(name="event_barrier_v3_direction"),
    )

    assert len(predictions) == len(source)
    assert predictions["active_trade"].tolist() == [True, True, True, False]
    assert predictions[TARGET_COLUMN].tolist() == [1, 0, 0, 0]
    assert predictions[qualification.ACTIONABLE_TARGET_COLUMN].tolist() == [1, 0, 1, 0]
    assert predictions.loc[1, "selected_net_return"] == pytest.approx(-0.0002)
    assert set(predictions["event_label_policy"]) == {EVENT_LABEL_POLICY}


def test_event_dual_actionability_targets_partition_actionable_rows():
    source = _research_dataset(periods=4, instruments=("EURUSD",))
    source[EVENT_ACTIONABLE_TARGET_COLUMN] = [1, 0, 1, 0]
    source[EVENT_DIRECTION_TARGET_COLUMN] = [1, 0, 0, 0]

    labeled = _ensure_event_dual_actionability_targets(source)

    assert labeled[EVENT_LONG_ACTIONABLE_TARGET_COLUMN].tolist() == [1, 0, 0, 0]
    assert labeled[EVENT_SHORT_ACTIONABLE_TARGET_COLUMN].tolist() == [0, 0, 1, 0]
    assert (
        labeled[EVENT_LONG_ACTIONABLE_TARGET_COLUMN]
        + labeled[EVENT_SHORT_ACTIONABLE_TARGET_COLUMN]
    ).tolist() == source[EVENT_ACTIONABLE_TARGET_COLUMN].tolist()


def test_event_dual_actionability_requires_winner_probability_and_margin():
    source = _research_dataset(periods=4, instruments=("EURUSD",))
    source[EVENT_ACTIONABLE_TARGET_COLUMN] = [1, 0, 1, 0]
    source[EVENT_DIRECTION_TARGET_COLUMN] = [1, 0, 0, 0]
    source[EVENT_LONG_NET_RETURN_COLUMN] = [0.0010, -0.0002, -0.0012, 0.0001]
    source[EVENT_SHORT_NET_RETURN_COLUMN] = [-0.0011, -0.0001, 0.0011, -0.0002]
    source[EVENT_STEP_COLUMN] = [1, 5, 2, 5]
    source[EVENT_BARRIER_RETURN_COLUMN] = [0.0005] * 4

    predictions = _event_dual_actionability_prediction_frame(
        source,
        long_probabilities=np.array([0.75, 0.62, 0.30, 0.55]),
        short_probabilities=np.array([0.10, 0.58, 0.72, 0.20]),
        confidence_floor=0.60,
        fold=1,
        experiment=EVENT_DUAL_ACTIONABILITY_EXPERIMENT_NAME,
        variant=ModelVariant(name="event_barrier_v7_dual_actionability"),
    )

    assert predictions["predicted_long"].tolist() == [True, True, False, True]
    assert predictions["active_trade"].tolist() == [True, False, True, False]
    np.testing.assert_allclose(
        predictions["confidence"].to_numpy(dtype=float),
        np.array([0.75, 0.62, 0.72, 0.55]),
    )
    assert set(predictions["confidence_policy"]) == {
        "winning_side_probability_gte_floor_and_side_margin_gte_0_10"
    }
    assert qualification.CONFIDENCE_FLOOR == 0.60
    assert qualification.DUAL_ACTION_MARGIN_FLOOR == 0.10


def test_dual_actionability_diagnostics_explain_zero_trade_filtering():
    source = _research_dataset(periods=4, instruments=("EURUSD",))
    source[EVENT_ACTIONABLE_TARGET_COLUMN] = [1, 0, 1, 0]
    source[EVENT_DIRECTION_TARGET_COLUMN] = [1, 0, 0, 0]
    source[EVENT_LONG_NET_RETURN_COLUMN] = [0.0010, -0.0002, -0.0012, 0.0001]
    source[EVENT_SHORT_NET_RETURN_COLUMN] = [-0.0011, -0.0001, 0.0011, -0.0002]
    source[EVENT_STEP_COLUMN] = [1, 5, 2, 5]
    source[EVENT_BARRIER_RETURN_COLUMN] = [0.0005] * 4

    predictions = _event_dual_actionability_prediction_frame(
        source,
        long_probabilities=np.array([0.59, 0.62, 0.30, 0.55]),
        short_probabilities=np.array([0.10, 0.58, 0.61, 0.20]),
        confidence_floor=0.60,
        fold=1,
        experiment=EVENT_DUAL_ACTIONABILITY_EXPERIMENT_NAME,
        variant=ModelVariant(name="event_barrier_v7_dual_actionability"),
    )

    diagnostics = _dual_actionability_diagnostics(
        predictions,
        confidence_floor=0.60,
    )

    assert diagnostics is not None
    assert diagnostics["winner_probability_pass_count"] == 2
    assert diagnostics["margin_pass_count"] == 3
    assert diagnostics["both_pass_count"] == 1
    assert diagnostics["active_trades"] == 1
    assert diagnostics["long_probability_gte_floor_count"] == 1
    assert diagnostics["short_probability_gte_floor_count"] == 1
    assert diagnostics["both_sides_gte_floor_count"] == 0
    assert diagnostics["policy"] == "diagnostic_only_no_gate_or_threshold_change"


def test_event_summary_direction_classification_uses_true_events_only():
    source = _research_dataset(periods=6, instruments=("EURUSD",))
    source[EVENT_ACTIONABLE_TARGET_COLUMN] = [1, 1, 0, 0, 1, 1]
    source[EVENT_DIRECTION_TARGET_COLUMN] = [1, 0, 0, 0, 1, 0]
    source[EVENT_LONG_NET_RETURN_COLUMN] = [0.001, -0.001, -0.0001, 0.0001, 0.001, -0.001]
    source[EVENT_SHORT_NET_RETURN_COLUMN] = [-0.001, 0.001, -0.0001, -0.0002, -0.001, 0.001]
    source[EVENT_STEP_COLUMN] = [1, 1, 5, 5, 2, 2]
    source[EVENT_BARRIER_RETURN_COLUMN] = [0.0005] * 6

    predictions = _event_two_stage_prediction_frame(
        source,
        direction_probabilities=np.array([0.8, 0.2, 0.9, 0.9, 0.8, 0.2]),
        opportunity_probabilities=np.array([0.8] * 6),
        confidence_floor=0.60,
        fold=1,
        experiment=EVENT_TWO_STAGE_EXPERIMENT_NAME,
        variant=ModelVariant(name="event_barrier_v3_direction"),
    )
    summary = qualification._summarize_predictions(
        predictions,
        horizon_bars=5,
        confidence_threshold=0.60,
    )

    assert summary["event_direction_evaluated_rows"] == 4
    assert summary["classification"]["sample_count"] == 4
    assert summary["classification"]["balanced_accuracy"] == pytest.approx(1.0)
    # Timeout rows remain present and can still become false-positive trades.
    assert summary["rows"] == 6
    assert summary["active_trades"] == 6


def test_pair_expert_probability_router_preserves_row_order_and_instrument_identity():
    class ConstantModel:
        def __init__(self, probability):
            self.probability = probability

        def predict_proba(self, features):
            probability = np.full(len(features), self.probability, dtype=float)
            return np.column_stack([1.0 - probability, probability])

    frame = _research_dataset(
        periods=3,
        instruments=("EURUSD", "USDJPY"),
    )
    probabilities = _pair_expert_probabilities(
        {
            "EURUSD": ConstantModel(0.75),
            "USDJPY": ConstantModel(0.25),
        },
        frame,
        list(MULTITIMEFRAME_FEATURE_COLUMNS),
    )

    expected = np.where(frame["instrument"].eq("EURUSD"), 0.75, 0.25)
    np.testing.assert_allclose(probabilities, expected)



def test_pair_regime_router_is_exhaustive_and_uses_pair_fallback():
    class ConstantModel:
        def __init__(self, probability):
            self.probability = probability

        def predict_proba(self, features):
            probability = np.full(len(features), self.probability, dtype=float)
            return np.column_stack([1.0 - probability, probability])

    frame = _research_dataset(
        periods=3,
        instruments=("EURUSD",),
    )
    frame.loc[frame.index[0], "m1_volatility_20"] = 0.1
    frame.loc[frame.index[0], "m1_spread_bps"] = 0.5
    frame.loc[frame.index[1], "m1_volatility_20"] = 0.9
    frame.loc[frame.index[1], "m1_spread_bps"] = 0.5
    frame.loc[frame.index[2], "m1_volatility_20"] = 0.1
    frame.loc[frame.index[2], "m1_spread_bps"] = 2.0

    probabilities = _pair_regime_expert_probabilities(
        {
            "EURUSD::fallback": ConstantModel(0.55),
            "EURUSD::calm": ConstantModel(0.60),
            "EURUSD::active_clean": ConstantModel(0.70),
        },
        {
            "EURUSD": {
                "m1_volatility_20_median": 0.5,
                "m1_spread_bps_median": 1.0,
            }
        },
        frame,
        list(MULTITIMEFRAME_FEATURE_COLUMNS),
    )

    np.testing.assert_allclose(probabilities, np.array([0.60, 0.70, 0.55]))


def test_regime_pair_experts_learn_router_thresholds_from_training_only(monkeypatch):
    dataset = _research_dataset(
        periods=700,
        instruments=("EURUSD", "USDJPY"),
    )
    period_codes = dataset.groupby("decision_time", sort=True).ngroup()
    dataset[EVENT_ACTIONABLE_TARGET_COLUMN] = 1
    dataset[EVENT_DIRECTION_TARGET_COLUMN] = (
        (period_codes + dataset["instrument"].eq("USDJPY").astype(int)) % 2
    ).astype(int)
    dataset["m1_volatility_20"] = np.where(period_codes % 2 == 0, 0.1, 0.9)
    dataset["m1_spread_bps"] = np.where(period_codes % 3 == 0, 2.0, 0.5)

    calls: list[dict[str, object]] = []

    def fake_fit(
        variant,
        *,
        fit,
        early_stop,
        feature_columns,
        target_column,
        sample_weight_policy,
    ):
        calls.append(
            {
                "name": variant.name,
                "target": target_column,
                "fit_rows": len(fit),
                "early_rows": len(early_stop),
            }
        )
        return _FakeModel()

    monkeypatch.setattr(qualification, "_fit_binary_variant", fake_fit)

    models, routers, opportunity, features, counts = (
        _fit_event_pair_regime_experts_for_outer(
            dataset,
            variant=ModelVariant(name="event_barrier_v6_pair_regime_direction"),
            horizon_bars=5,
        )
    )

    assert opportunity is not None
    assert features == list(MULTITIMEFRAME_FEATURE_COLUMNS)
    assert set(routers) == {"EURUSD", "USDJPY"}
    assert all("m1_volatility_20_median" in item for item in routers.values())
    assert all("m1_spread_bps_median" in item for item in routers.values())
    assert "EURUSD::fallback" in models
    assert "USDJPY::fallback" in models
    assert counts["regime_router_policy"] == qualification.REGIME_ROUTER_POLICY
    assert calls[0]["target"] == EVENT_ACTIONABLE_TARGET_COLUMN


def test_event_return_margin_target_is_long_minus_short_in_bps():
    frame = pd.DataFrame(
        {
            EVENT_LONG_NET_RETURN_COLUMN: [0.0012, -0.0004, 0.0001],
            EVENT_SHORT_NET_RETURN_COLUMN: [-0.0008, 0.0006, 0.0001],
        }
    )

    margin = _event_return_margin_bps(frame)

    np.testing.assert_allclose(margin, np.array([20.0, -10.0, 0.0]))


def test_pair_return_margin_router_preserves_pair_identity_and_calibration():
    class ConstantRegressor:
        def __init__(self, score):
            self.score = score

        def predict(self, features):
            return np.full(len(features), self.score, dtype=float)

    class ScoreCalibrator:
        def predict_proba(self, scores):
            probability = 1.0 / (1.0 + np.exp(-scores[:, 0] / 10.0))
            return np.column_stack([1.0 - probability, probability])

    frame = _research_dataset(
        periods=3,
        instruments=("EURUSD", "USDJPY"),
    )
    probabilities = _pair_return_margin_probabilities(
        {
            "EURUSD": ConstantRegressor(10.0),
            "USDJPY": ConstantRegressor(-10.0),
        },
        {
            "EURUSD": ScoreCalibrator(),
            "USDJPY": ScoreCalibrator(),
        },
        frame,
        list(MULTITIMEFRAME_FEATURE_COLUMNS),
    )

    eur_probability = 1.0 / (1.0 + np.exp(-1.0))
    jpy_probability = 1.0 / (1.0 + np.exp(1.0))
    expected = np.where(
        frame["instrument"].eq("EURUSD"),
        eur_probability,
        jpy_probability,
    )
    np.testing.assert_allclose(probabilities, expected)
    assert CONFIDENCE_FLOOR == 0.60


def test_event_pair_experts_train_direction_models_on_one_instrument_each(monkeypatch):
    dataset = _research_dataset(
        periods=500,
        instruments=("EURUSD", "USDJPY"),
    )
    period_codes = dataset.groupby("decision_time", sort=True).ngroup()
    dataset[EVENT_ACTIONABLE_TARGET_COLUMN] = (period_codes % 3 != 0).astype(int)
    dataset[EVENT_DIRECTION_TARGET_COLUMN] = (
        (period_codes + dataset["instrument"].eq("USDJPY").astype(int)) % 2
    ).astype(int)

    calls = []

    def fake_fit(
        variant,
        *,
        fit,
        early_stop,
        feature_columns,
        target_column,
        sample_weight_policy,
    ):
        calls.append(
            {
                "name": variant.name,
                "target": target_column,
                "fit_instruments": sorted(fit["instrument"].unique().tolist()),
                "early_instruments": sorted(early_stop["instrument"].unique().tolist()),
            }
        )
        return _FakeModel()

    monkeypatch.setattr(qualification, "_fit_binary_variant", fake_fit)

    models, opportunity_model, features, counts = _fit_event_pair_experts_for_outer(
        dataset,
        variant=ModelVariant(name="event_barrier_v4_pair_direction"),
        horizon_bars=10,
    )

    assert set(models) == {"EURUSD", "USDJPY"}
    assert opportunity_model is not None
    assert features == list(MULTITIMEFRAME_FEATURE_COLUMNS)
    assert counts["pair_count"] == 2

    assert calls[0]["target"] == EVENT_ACTIONABLE_TARGET_COLUMN
    assert calls[0]["fit_instruments"] == ["EURUSD", "USDJPY"]
    direction_calls = calls[1:]
    assert len(direction_calls) == 2
    assert all(call["target"] == EVENT_DIRECTION_TARGET_COLUMN for call in direction_calls)
    assert sorted(call["fit_instruments"] for call in direction_calls) == [
        ["EURUSD"],
        ["USDJPY"],
    ]
    assert all(call["fit_instruments"] == call["early_instruments"] for call in direction_calls)


def test_feature_experiments_never_invent_non_runtime_features():
    full = _feature_columns("all")
    volume_ablated = _feature_columns("drop_volume")
    structure_ablated = _feature_columns("drop_structure")

    assert full == list(MULTITIMEFRAME_FEATURE_COLUMNS)
    assert set(volume_ablated).issubset(MULTITIMEFRAME_FEATURE_COLUMNS)
    assert set(structure_ablated).issubset(MULTITIMEFRAME_FEATURE_COLUMNS)
    assert set(qualification.QUALIFICATION_REGIME_COLUMNS).issubset(
        MULTITIMEFRAME_FEATURE_COLUMNS
    )
    assert len(volume_ablated) < len(full)
    assert len(structure_ablated) < len(full)
    assert all(
        not any(
            column.endswith(suffix)
            for suffix in qualification.VOLUME_FEATURE_SUFFIXES
        )
        for column in volume_ablated
    )
    assert all(
        column not in qualification.STRUCTURE_GLOBAL_FEATURES
        and not any(
            column.endswith(suffix)
            for suffix in qualification.STRUCTURE_FEATURE_SUFFIXES
        )
        for column in structure_ablated
    )


def test_calibration_fit_receives_only_inner_calibration_labels(monkeypatch):
    dataset = _research_dataset(periods=500, instruments=("EURUSD",))
    windows = _nested_windows(
        dataset,
        horizon_bars=5,
        min_inner_periods=30,
    )
    observed_labels: list[np.ndarray] = []
    original_fit_calibrator = qualification._fit_calibrator

    monkeypatch.setattr(
        qualification,
        "_fit_variant",
        lambda *_args, **_kwargs: _FakeModel(),
    )

    def capture_calibrator(method, *, probabilities, labels):
        observed_labels.append(np.asarray(labels, dtype=int).copy())
        return original_fit_calibrator(
            method,
            probabilities=probabilities,
            labels=labels,
        )

    monkeypatch.setattr(
        qualification,
        "_fit_calibrator",
        capture_calibrator,
    )

    experiment = QualificationExperiment(
        name="platt_probe",
        variants=(
            ModelVariant(
                name="platt_probe",
                calibration="platt",
            ),
        ),
        tune_decision_threshold=True,
    )
    qualification._select_variant_inside_outer_training(
        dataset,
        experiment=experiment,
        horizon_bars=5,
        confidence_floor=0.60,
        min_inner_periods=30,
    )

    assert len(observed_labels) == 1
    np.testing.assert_array_equal(
        observed_labels[0],
        windows.calibration["target"].to_numpy(dtype=int),
    )
    assert windows.calibration["decision_time"].max() < windows.selection[
        "decision_time"
    ].min()


def test_qualification_corpora_requires_cutoff_before_loading_any_final_tail(tmp_path):
    with pytest.raises(
        ValueError,
        match="untouched final 20% is excluded",
    ):
        evaluate_qualification_corpora(
            {"EURUSD": tmp_path / "does-not-need-to-exist.csv"},
            horizon_bars=10,
            decision_time_before=None,
            report_path=tmp_path / "report.json",
        )


def test_nested_runner_rejects_lower_confidence_floor_before_model_fit():
    with pytest.raises(ValueError, match="must not be lowered below 0.60"):
        run_nested_qualification_experiments(
            _research_dataset(periods=500, instruments=("EURUSD",)),
            horizon_bars=5,
            confidence_floor=0.599,
            max_splits=1,
            min_train_periods=300,
            validation_periods=100,
            experiments=default_experiments()[:1],
        )



def test_compressed_directional_fixture_separates_boundary_bias_from_confidence():
    labels = np.array([0] * 100 + [1] * 100, dtype=int)
    raw = np.array([0.52] * 100 + [0.58] * 100, dtype=float)

    baseline = compute_classification_metrics(
        labels,
        raw,
        threshold=0.50,
    )
    selected_threshold, selected = _select_decision_threshold(labels, raw)
    calibrator = _fit_calibrator(
        "platt",
        probabilities=raw,
        labels=labels,
    )
    calibrated = _apply_calibrator(calibrator, raw)

    raw_coverage = float((np.maximum(raw, 1.0 - raw) >= 0.60).mean())
    calibrated_coverage = float(
        (np.maximum(calibrated, 1.0 - calibrated) >= 0.60).mean()
    )
    calibrated_metrics = compute_classification_metrics(
        labels,
        calibrated,
        threshold=0.50,
    )

    assert baseline["balanced_accuracy"] == pytest.approx(0.50)
    assert baseline["precision"] == pytest.approx(0.50)
    assert baseline["recall"] == pytest.approx(1.00)
    assert baseline["f1"] == pytest.approx(2.0 / 3.0)
    assert baseline["brier_score"] == pytest.approx(0.2234)
    assert raw_coverage == pytest.approx(0.0)

    assert selected_threshold == pytest.approx(0.525)
    assert selected["balanced_accuracy"] == pytest.approx(1.0)
    assert calibrated_metrics["balanced_accuracy"] == pytest.approx(1.0)
    assert calibrated_metrics["brier_score"] < 0.10
    assert calibrated_metrics["brier_score"] < baseline["brier_score"]
    assert calibrated_coverage == pytest.approx(1.0)
    assert CONFIDENCE_FLOOR == 0.60



def test_fixed_single_calibration_strategy_skips_redundant_inner_model_selection(
    monkeypatch,
):
    dataset = _research_dataset()
    platt = ModelVariant(name="platt_only", calibration="platt")
    experiments = (
        QualificationExperiment(
            name="baseline",
            variants=(ModelVariant(name="baseline_locked"),),
        ),
        QualificationExperiment(
            name="platt_only",
            variants=(platt,),
            tune_decision_threshold=False,
        ),
    )

    def forbidden_selector(*_args, **_kwargs):
        raise AssertionError("fixed one-variant calibration should not run candidate selection")

    monkeypatch.setattr(
        qualification,
        "_select_variant_inside_outer_training",
        forbidden_selector,
    )
    monkeypatch.setattr(
        qualification,
        "_fit_selected_for_outer",
        lambda *_args, **_kwargs: (
            _FakeModel(),
            qualification._CalibrationModel(method="none"),
            ["m1_simple_return"],
        ),
    )

    report = run_nested_qualification_experiments(
        dataset,
        horizon_bars=5,
        confidence_floor=0.60,
        max_splits=1,
        min_train_periods=300,
        validation_periods=100,
        min_inner_periods=30,
        experiments=experiments,
    )

    selection = report["experiments"]["platt_only"]["folds"][0]["selection"]
    assert selection["policy"] == "fixed_candidate_inner_calibration_only"
    assert selection["selected_variant"] == "platt_only"
    assert selection["decision_threshold"] == pytest.approx(0.50)

    comparison = report["candidate_comparison_table"]
    assert [row["experiment"] for row in comparison] == ["baseline", "platt_only"]
    required_metrics = {
        "balanced_accuracy",
        "sharpe_ratio",
        "profit_factor",
        "max_drawdown",
        "positive_fold_fraction",
        "positive_instrument_fraction",
        "trade_or_period_count",
        "confidence_coverage",
        "brier_score",
        "calibration_methods",
        "model_variants",
        "research_gate_passed",
    }
    assert required_metrics.issubset(comparison[0])
    assert comparison[0]["calibration_methods"] == ["none"]
    assert comparison[1]["calibration_methods"] == ["platt"]


def _comparison_fixture(
    *,
    balanced_accuracy: float,
    brier_score: float,
    sharpe_ratio: float,
    profit_factor: float,
    max_drawdown: float,
    positive_fold_fraction: float,
    positive_instrument_fraction: float,
    pair_returns: list[float],
    fold_returns: list[float],
    warnings: list[str] | None = None,
) -> dict[str, object]:
    return {
        "overall": {
            "classification": {
                "balanced_accuracy": balanced_accuracy,
                "brier_score": brier_score,
            },
            "trading": {
                "sharpe_ratio": sharpe_ratio,
                "profit_factor": profit_factor,
                "max_drawdown": max_drawdown,
            },
            "evidence_sufficiency_warnings": warnings or [],
        },
        "research_gate": {
            "observed": {
                "positive_fold_fraction": positive_fold_fraction,
                "positive_instrument_fraction": positive_instrument_fraction,
            }
        },
        "by_instrument": {
            f"PAIR{index}": {"trading": {"total_return": value}}
            for index, value in enumerate(pair_returns, start=1)
        },
        "folds": [
            {"aggregate": {"trading": {"total_return": value}}}
            for value in fold_returns
        ],
    }


def test_broad_improvement_rejects_profit_concentration_and_fragile_high_sharpe():
    baseline = _comparison_fixture(
        balanced_accuracy=0.505,
        brier_score=0.250,
        sharpe_ratio=0.5,
        profit_factor=1.0,
        max_drawdown=0.02,
        positive_fold_fraction=0.20,
        positive_instrument_fraction=0.33,
        pair_returns=[0.01, 0.01, 0.01, 0.0, 0.0, 0.0],
        fold_returns=[0.01, 0.01, 0.01, 0.0, 0.0],
    )
    candidate = _comparison_fixture(
        balanced_accuracy=0.525,
        brier_score=0.249,
        sharpe_ratio=2.2,
        profit_factor=1.3,
        max_drawdown=0.021,
        positive_fold_fraction=0.60,
        positive_instrument_fraction=0.67,
        pair_returns=[0.10, 0.01, 0.01, 0.01, 0.01, 0.01],
        fold_returns=[0.10, 0.01, 0.01, 0.01, 0.01],
        warnings=["high_sharpe_with_small_trade_sample"],
    )

    result = qualification._broad_improvement_flag(baseline, candidate)

    assert result["interesting_for_follow_up"] is False
    assert result["small_sample_rejection"] is True
    assert result["pair_concentration_rejection"] is True
    assert result["fold_concentration_rejection"] is True
    assert result["pair_positive_profit_concentration"] > 0.50
    assert result["fold_positive_profit_concentration"] > 0.50


def test_broad_improvement_rejects_material_drawdown_regression():
    baseline = _comparison_fixture(
        balanced_accuracy=0.505,
        brier_score=0.250,
        sharpe_ratio=0.5,
        profit_factor=1.0,
        max_drawdown=0.02,
        positive_fold_fraction=0.20,
        positive_instrument_fraction=0.33,
        pair_returns=[0.01] * 6,
        fold_returns=[0.01] * 5,
    )
    candidate = _comparison_fixture(
        balanced_accuracy=0.525,
        brier_score=0.249,
        sharpe_ratio=1.2,
        profit_factor=1.2,
        max_drawdown=0.031,
        positive_fold_fraction=0.60,
        positive_instrument_fraction=0.67,
        pair_returns=[0.01] * 6,
        fold_returns=[0.01] * 5,
    )

    result = qualification._broad_improvement_flag(baseline, candidate)

    assert result["interesting_for_follow_up"] is False
    assert result["material_drawdown_rejection"] is True
    assert result["pair_concentration_rejection"] is False
    assert result["fold_concentration_rejection"] is False


def _instrument_summary(
    *,
    balanced_accuracy: float,
    predicted_long_fraction: float,
    confidence_coverage: float,
    total_return: float,
) -> dict[str, object]:
    return {
        "classification": {"balanced_accuracy": balanced_accuracy},
        "diagnostics": {
            "directional_bias": {
                "predicted_long_fraction": predicted_long_fraction,
            },
            "confidence_coverage": {"fraction": confidence_coverage},
        },
        "trading": {"total_return": total_return},
    }


def test_pooled_architecture_diagnostic_flags_material_pair_heterogeneity():
    by_instrument = {
        "EURUSD": _instrument_summary(
            balanced_accuracy=0.56,
            predicted_long_fraction=0.70,
            confidence_coverage=0.30,
            total_return=0.01,
        ),
        "GBPUSD": _instrument_summary(
            balanced_accuracy=0.49,
            predicted_long_fraction=0.42,
            confidence_coverage=0.05,
            total_return=-0.01,
        ),
        "USDJPY": _instrument_summary(
            balanced_accuracy=0.51,
            predicted_long_fraction=0.55,
            confidence_coverage=0.10,
            total_return=-0.01,
        ),
    }

    report = qualification._pooled_architecture_diagnostic(by_instrument)

    assert report["material_pair_heterogeneity"] is True
    assert report["stronger_instrument_normalization_research_warranted"] is True
    assert report["future_mixture_of_experts_research_warranted"] is True
    assert report["diagnostic_only"] is True


def test_pooled_architecture_diagnostic_keeps_homogeneous_pairs_as_research_plausible():
    by_instrument = {
        symbol: _instrument_summary(
            balanced_accuracy=0.53 + (index * 0.002),
            predicted_long_fraction=0.51 + (index * 0.005),
            confidence_coverage=0.15 + (index * 0.005),
            total_return=0.01,
        )
        for index, symbol in enumerate(
            ["EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCAD", "USDCHF"]
        )
    }

    report = qualification._pooled_architecture_diagnostic(by_instrument)

    assert report["status"] == "pooled_architecture_remains_reasonable_for_research"
    assert report["material_pair_heterogeneity"] is False
    assert report["stronger_instrument_normalization_research_warranted"] is False
    assert report["future_mixture_of_experts_research_warranted"] is False


def test_feature_gain_stability_diagnostics_rewards_repeatability():
    folds = [
        [
            {"feature": "stable", "normalized_gain": 0.20},
            {"feature": "sporadic", "normalized_gain": 0.40},
        ],
        [
            {"feature": "stable", "normalized_gain": 0.25},
        ],
        [
            {"feature": "stable", "normalized_gain": 0.15},
            {"feature": "other", "normalized_gain": 0.30},
        ],
    ]

    rows = feature_gain_stability_diagnostics(folds, top_n=10)

    assert rows[0]["feature"] == "stable"
    assert rows[0]["fold_presence_count"] == 3
    assert rows[0]["fold_presence_fraction"] == pytest.approx(1.0)
    assert rows[0]["mean_normalized_gain"] == pytest.approx(0.20)
    assert {row["feature"] for row in rows} == {"stable", "sporadic", "other"}


def test_causal_regime_diagnostics_adds_alignment_and_spread_slices():
    rows: list[dict[str, float | int]] = []
    for index in range(90):
        bucket = index % 3
        target = index % 2
        rows.append(
            {
                "target": target,
                "positive_probability": 0.70 if target else 0.30,
                "m1_volatility_20": (0.001, 0.002, 0.003)[bucket],
                "h1_rsi_14": (35.0, 50.0, 65.0)[bucket],
                "trend_alignment_score": (-1.0, 0.0, 1.0)[bucket],
                "momentum_alignment_score": (-0.8, 0.0, 0.8)[bucket],
                "m1_spread_bps": (0.5, 1.0, 2.0)[bucket],
            }
        )

    report = causal_regime_diagnostics(pd.DataFrame(rows))

    assert set(report["trend_alignment_score"]) == {"bearish", "mixed", "bullish"}
    assert set(report["momentum_alignment_score"]) == {"bearish", "mixed", "bullish"}
    assert {"low", "mid", "high"}.issubset(report["m1_spread_bps"])
    assert report["trend_alignment_score"]["bullish"]["rows"] == 30
