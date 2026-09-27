"""Governance tests for the USDJPY v17 disjoint replication runner."""
from app.domain.training import single_pair_v17_disjoint_replication as v17


def test_v17_keeps_v16_economic_gates_locked() -> None:
    assert v17.PAYOFF_RATIO_FLOOR == 1.15
    assert v17.MIN_LONG_SELECTION_PROFIT_FACTOR == 1.15
    assert v17.MIN_SHORT_SELECTION_PROFIT_FACTOR == 1.15
    assert v17.MIN_OUTER_TRADES == 20
    assert v17.MIN_PER_FOLD_TRADES == 3
    assert v17.MAX_FOLD_TRADE_CONCENTRATION == 0.80


def test_v17_is_research_only_disjoint_replication() -> None:
    assert v17.EXPERIMENT_NAME == "event_barrier_v17_disjoint_replication_v16_policy"
