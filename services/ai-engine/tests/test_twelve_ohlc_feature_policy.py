from app.domain.training.model_qualification import VOLUME_FEATURE_SUFFIXES, _feature_columns


def test_twelve_ohlc_feature_policy_excludes_broker_only_inputs() -> None:
    columns = _feature_columns("twelve_ohlc")

    assert len(columns) == 111
    assert "m1_spread_bps" not in columns
    assert "spread_to_atr_ratio" not in columns
    assert not any(
        column.endswith(suffix)
        for column in columns
        for suffix in VOLUME_FEATURE_SUFFIXES
    )

    # Preserve causal OHLC-derived, time/context and instrument features.
    for required in (
        "m1_simple_return",
        "m5_rsi_14",
        "m15_breakout_strength_20",
        "h1_atr_pct_14",
        "h4_momentum_10",
        "minute_of_day_sin",
        "trend_alignment_score",
        "instrument_EURUSD",
        "instrument_USDJPY",
    ):
        assert required in columns
