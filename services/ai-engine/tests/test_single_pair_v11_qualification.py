from app.domain.training.model_qualification import (
    EVENT_HYBRID_CALIBRATED_GATING_EXPERIMENT_NAME,
    V11_ACTION_MARGIN_GRID,
    V11_OPPORTUNITY_THRESHOLD_GRID,
)
from app.domain.training.single_pair_v11_qualification import v11_experiments


def test_v11_experiment_matrix_compares_locked_v10_with_calibrated_gating() -> None:
    experiments = v11_experiments()

    assert [experiment.name for experiment in experiments] == [
        "baseline",
        EVENT_HYBRID_CALIBRATED_GATING_EXPERIMENT_NAME,
    ]
    assert experiments[0].mode == "directional"
    assert (
        experiments[1].mode
        == "event_hybrid_dual_direction_payoff_risk_calibrated_gating"
    )
    assert (
        experiments[1].variants[0].name
        == "event_barrier_v11_hybrid_payoff_risk_calibrated_gating"
    )


def test_v11_gate_search_is_bounded_and_never_changes_direction_floor() -> None:
    assert V11_OPPORTUNITY_THRESHOLD_GRID == (0.40, 0.45, 0.50, 0.55, 0.60)
    assert V11_ACTION_MARGIN_GRID == (0.05, 0.075, 0.10)
