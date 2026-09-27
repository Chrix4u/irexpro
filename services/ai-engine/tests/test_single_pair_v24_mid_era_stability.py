"""Governance tests for USDJPY v24 mid-era stability audit."""
from app.domain.training import single_pair_v24_mid_era_stability as v24


def test_v24_predeclares_mid_era_fractions() -> None:
    assert v24.DEFAULT_TRAIN_FRACTIONS == (0.60, 0.80)
    assert v24.DEFAULT_VALIDATION_FRACTION == 0.02


def test_v24_audit_remains_research_only_by_construction() -> None:
    assert v24.MIN_OUTER_TRADES == 20
    assert v24.MIN_PER_FOLD_TRADES == 3
    assert v24.MAX_FOLD_TRADE_CONCENTRATION == 0.80


def test_v24_fraction_parser_rejects_empty_values() -> None:
    try:
        v24._parse_fractions(" , ")
    except ValueError as exc:
        assert "at least one train fraction" in str(exc)
    else:
        raise AssertionError("empty train fraction list should fail")
