from app.domain.training.model_qualification import (
    EVENT_PAIR_EXPERT_EXPERIMENT_NAME,
    EVENT_PAIR_RETURN_MARGIN_EXPERIMENT_NAME,
)
from app.domain.training.single_pair_qualification import (
    candidate_summary,
    single_pair_experiments,
)


def test_single_pair_experiment_matrix_is_intentionally_bounded():
    experiments = single_pair_experiments()

    assert [experiment.name for experiment in experiments] == [
        "baseline",
        EVENT_PAIR_EXPERT_EXPERIMENT_NAME,
        EVENT_PAIR_RETURN_MARGIN_EXPERIMENT_NAME,
    ]
    assert experiments[0].mode == "directional"
    assert experiments[1].mode == "two_stage_event_pair_experts"
    assert experiments[1].variants[0].name == "event_barrier_v4_pair_direction"
    assert experiments[2].mode == "two_stage_event_pair_return_margin"
    assert experiments[2].variants[0].name == "event_barrier_v5_pair_return_margin"


def test_candidate_summary_uses_event_pair_expert_gate():
    report = {
        "experiments": {
            EVENT_PAIR_EXPERT_EXPERIMENT_NAME: {
                "research_gate": {
                    "research_gate_passed": True,
                    "observed": {"balanced_accuracy": 0.53},
                    "checks": {"balanced_accuracy": True},
                },
                "overall": {
                    "active_trades": 12,
                    "trading": {"trade_or_period_count": 10},
                    "evidence_sufficiency_warnings": ["small_sample"],
                },
            }
        }
    }

    summary = candidate_summary(report)

    assert summary["research_gate_passed"] is True
    assert summary["observed"]["balanced_accuracy"] == 0.53
    assert summary["active_trades"] == 12
    assert summary["trade_or_period_count"] == 10
    assert summary["evidence_sufficiency_warnings"] == ["small_sample"]
