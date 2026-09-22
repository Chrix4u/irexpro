"""Tests for nested model-qualification experiments and immutable research governance."""
from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from app.domain.models.multitimeframe_features import MULTITIMEFRAME_FEATURE_COLUMNS
from app.domain.training import model_qualification as qualification
from app.domain.training.model_qualification import (
    CONFIDENCE_FLOOR,
    ModelVariant,
    QualificationExperiment,
    _apply_calibrator,
    _feature_columns,
    _fit_calibrator,
    _locked_gate_snapshot,
    _nested_windows,
    _prediction_frame,
    _select_decision_threshold,
    default_experiments,
    evaluate_qualification_corpora,
    run_nested_qualification_experiments,
)
from app.domain.training.train_multitimeframe import (
    run_pooled_walk_forward_with_predictions,
)


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
    assert sum(len(experiment.variants) for experiment in experiments) == 8
    assert CONFIDENCE_FLOOR == 0.60


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


def test_outer_validation_is_never_passed_to_inner_selection_or_refit(monkeypatch):
    dataset = _research_dataset()
    candidate = ModelVariant(name="candidate", calibration="none")
    experiments = (
        QualificationExperiment(
            name="baseline",
            variants=(ModelVariant(name="baseline_locked"),),
        ),
        QualificationExperiment(name="candidate", variants=(candidate,)),
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



def test_feature_experiments_never_invent_non_runtime_features():
    full = _feature_columns("all")
    ablated = _feature_columns("drop_volume")

    assert full == list(MULTITIMEFRAME_FEATURE_COLUMNS)
    assert set(ablated).issubset(MULTITIMEFRAME_FEATURE_COLUMNS)
    assert set(qualification.QUALIFICATION_REGIME_COLUMNS).issubset(
        MULTITIMEFRAME_FEATURE_COLUMNS
    )
    assert len(ablated) < len(full)
    assert all(
        not any(
            column.endswith(suffix)
            for suffix in qualification.VOLUME_FEATURE_SUFFIXES
        )
        for column in ablated
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
