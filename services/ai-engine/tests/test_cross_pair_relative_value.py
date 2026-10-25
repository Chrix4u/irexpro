from __future__ import annotations

import numpy as np
import pandas as pd

from app.domain.training.cross_pair_relative_value import (
    PAIRS,
    USD_BASE_PAIRS,
    build_cross_pair_residual_frame,
    calibrate_relative_value_policy,
    route_relative_value_signals,
)


def _frame(periods: int = 6) -> pd.DataFrame:
    times = pd.date_range("2026-09-01T00:00:00Z", periods=periods, freq="min")
    rows: list[dict[str, object]] = []
    for minute, decision_time in enumerate(times):
        for pair_index, pair in enumerate(PAIRS):
            pair_return = (pair_index + 1) * 0.001 + minute * 0.0001
            rows.append(
                {
                    "decision_time": decision_time,
                    "instrument": pair,
                    "m1_simple_return": pair_return,
                    "long_net_return": 0.0002,
                    "short_net_return": -0.0002,
                }
            )
    return pd.DataFrame.from_records(rows)


def test_residual_frame_requires_all_six_pairs_per_decision_time() -> None:
    frame = _frame()
    missing_time = pd.Timestamp("2026-09-01T00:02:00Z")
    frame = frame.loc[
        ~((frame["decision_time"] == missing_time) & (frame["instrument"] == "USDCHF"))
    ].copy()

    result = build_cross_pair_residual_frame(frame, rolling_window=3)

    assert set(result["instrument"]) == set(PAIRS)
    assert missing_time not in set(result["decision_time"])
    assert result.groupby("decision_time")["instrument"].nunique().eq(6).all()


def test_usd_orientation_and_leave_one_out_median_are_exact() -> None:
    decision_time = pd.Timestamp("2026-09-01T00:00:00Z")
    raw_returns = {
        "EURUSD": 0.0010,
        "GBPUSD": 0.0020,
        "AUDUSD": 0.0030,
        "USDJPY": 0.0040,
        "USDCAD": 0.0050,
        "USDCHF": 0.0060,
    }
    frame = pd.DataFrame(
        {
            "decision_time": [decision_time] * 6,
            "instrument": list(raw_returns),
            "m1_simple_return": list(raw_returns.values()),
            "long_net_return": [0.0] * 6,
            "short_net_return": [0.0] * 6,
        }
    )

    result = build_cross_pair_residual_frame(frame, rolling_window=1).set_index("instrument")

    expected_signed = {
        pair: value if pair in USD_BASE_PAIRS else -value for pair, value in raw_returns.items()
    }
    for pair, signed in expected_signed.items():
        peers = [value for other, value in expected_signed.items() if other != pair]
        peer_median = float(np.median(peers))
        assert result.loc[pair, "usd_signed_return"] == signed
        assert result.loc[pair, "peer_usd_median_return"] == peer_median
        assert result.loc[pair, "cross_pair_residual"] == signed - peer_median


def test_rolling_residual_zscore_is_past_only() -> None:
    base = _frame(periods=8)
    original = build_cross_pair_residual_frame(base, rolling_window=3)
    cutoff = pd.Timestamp("2026-09-01T00:05:00Z")
    before = original.loc[
        (original["instrument"] == "EURUSD") & (original["decision_time"] == cutoff),
        "cross_pair_residual_z",
    ].iloc[0]

    future = _frame(periods=10)
    future.loc[future["decision_time"] > cutoff, "m1_simple_return"] *= 1_000_000.0
    changed = build_cross_pair_residual_frame(future, rolling_window=3)
    after = changed.loc[
        (changed["instrument"] == "EURUSD") & (changed["decision_time"] == cutoff),
        "cross_pair_residual_z",
    ].iloc[0]

    assert np.isfinite(before)
    assert after == before


def test_residual_builder_preserves_economic_labels() -> None:
    frame = _frame(periods=5)
    result = build_cross_pair_residual_frame(frame, rolling_window=2)

    assert "long_net_return" in result
    assert "short_net_return" in result
    assert result["long_net_return"].eq(0.0002).all()
    assert result["short_net_return"].eq(-0.0002).all()


def _economic_frame(rows: int = 240, *, profitable: bool = True, one_sided: bool = False) -> pd.DataFrame:
    times = pd.date_range("2026-09-10T00:00:00Z", periods=rows, freq="min")
    records: list[dict[str, object]] = []
    cases = (("EURUSD", 2.0), ("EURUSD", -2.0), ("USDCAD", 2.0), ("USDCAD", -2.0))
    for index, decision_time in enumerate(times):
        pair, residual_z = cases[index % len(cases)]
        if one_sided:
            residual_z = 2.0
        is_base = pair in USD_BASE_PAIRS
        desired_usd = -np.sign(residual_z)
        predicted_long = bool(desired_usd * (1.0 if is_base else -1.0) > 0)
        win = index % 7 != 0
        selected = 0.00030 if win else -0.00010
        if not profitable:
            selected = -0.00020
        other = -0.00030 if profitable else -0.00020
        records.append(
            {
                "decision_time": decision_time,
                "instrument": pair,
                "cross_pair_residual_z": residual_z,
                "long_net_return": selected if predicted_long else other,
                "short_net_return": other if predicted_long else selected,
            }
        )
    return pd.DataFrame.from_records(records)


def test_calibration_selects_profitable_mean_reversion_from_bounded_grid() -> None:
    calibration = _economic_frame()

    policy = calibrate_relative_value_policy(calibration, min_active_rows=20)

    assert policy.passed is True
    assert policy.hypothesis == "mean_reversion"
    assert policy.quantile in {0.70, 0.80, 0.90, 0.95}
    assert policy.profit_factor is not None and policy.profit_factor >= 1.10
    assert policy.mean_net_return > 0.0
    assert policy.long_fraction >= 0.05
    assert policy.short_fraction >= 0.05


def test_calibration_rejects_high_activity_losing_tail() -> None:
    calibration = _economic_frame(profitable=False)

    policy = calibrate_relative_value_policy(calibration, min_active_rows=20)

    assert policy.passed is False
    assert policy.reason == "NO_ECONOMIC_RESIDUAL_TAIL"


def test_calibration_requires_both_long_and_short_sides() -> None:
    calibration = _economic_frame(one_sided=True)
    calibration["instrument"] = "EURUSD"

    policy = calibrate_relative_value_policy(calibration, min_active_rows=20)

    assert policy.passed is False


def test_failed_policy_routes_to_abstain() -> None:
    calibration = _economic_frame(profitable=False)
    policy = calibrate_relative_value_policy(calibration, min_active_rows=20)
    validation = _economic_frame(rows=30)

    routed = route_relative_value_signals(validation, policy)

    assert routed["active_trade"].sum() == 0
    assert routed["selected_net_return"].eq(0.0).all()


def test_validation_values_cannot_change_calibration_policy() -> None:
    calibration = _economic_frame()
    policy_before = calibrate_relative_value_policy(calibration, min_active_rows=20)
    validation = _economic_frame(rows=30)
    validation["cross_pair_residual_z"] = 1_000_000.0
    validation["long_net_return"] = -100.0
    validation["short_net_return"] = -100.0

    _ = route_relative_value_signals(validation, policy_before)
    policy_after = calibrate_relative_value_policy(calibration, min_active_rows=20)

    assert policy_after == policy_before


def _evaluation_frame(periods: int = 420) -> pd.DataFrame:
    times = pd.date_range("2026-08-01T00:00:00Z", periods=periods, freq="min")
    rows: list[dict[str, object]] = []
    for minute, decision_time in enumerate(times):
        common = np.sin(minute / 11.0) * 0.0002
        for pair_index, pair in enumerate(PAIRS):
            orientation = 1.0 if pair in USD_BASE_PAIRS else -1.0
            idiosyncratic = np.sin((minute + pair_index * 3) / 7.0) * 0.00008
            pair_return = orientation * (common + idiosyncratic)
            long_net = 0.00025 if pair_index % 2 == 0 else -0.00010
            short_net = -0.00010 if pair_index % 2 == 0 else 0.00025
            rows.append(
                {
                    "decision_time": decision_time,
                    "instrument": pair,
                    "m1_simple_return": pair_return,
                    "long_net_return": long_net,
                    "short_net_return": short_net,
                }
            )
    return pd.DataFrame.from_records(rows)


def _passed_policy() -> object:
    from app.domain.training.cross_pair_relative_value import RelativeValuePolicy

    return RelativeValuePolicy(
        passed=True,
        reason="PASSED",
        hypothesis="mean_reversion",
        quantile=0.70,
        min_abs_residual_z=0.0,
        active_rows=100,
        density=0.25,
        mean_net_return=0.0002,
        profit_factor=2.0,
        profit_throughput=0.00005,
        long_fraction=0.5,
        short_fraction=0.5,
    )


def test_one_fold_evaluator_preserves_outer_and_inner_horizon_purges() -> None:
    from app.domain.training.cross_pair_relative_value import evaluate_relative_value_frame

    def calibrator(frame: pd.DataFrame, **_: object) -> object:
        assert not frame.empty
        return _passed_policy()

    report = evaluate_relative_value_frame(
        _evaluation_frame(),
        horizon_bars=1,
        min_train_periods=260,
        validation_periods=60,
        max_splits=1,
        rolling_window=5,
        calibration_min_periods=60,
        calibration_min_rows=10,
        calibrator=calibrator,
    )

    fold = report["folds"][0]
    fit_end = pd.Timestamp(fold["fit_end"])
    calibration_start = pd.Timestamp(fold["calibration_start"])
    outer_train_end = pd.Timestamp(fold["outer_train_end"])
    validation_start = pd.Timestamp(fold["validation_start"])
    assert calibration_start - fit_end >= pd.Timedelta(minutes=2)
    assert validation_start - outer_train_end >= pd.Timedelta(minutes=2)
    assert report["protocol"]["purge_periods"] == 1
    assert report["protocol"]["inner_calibration_train_only"] is True


def test_evaluator_counts_simultaneous_six_pair_signals_as_one_portfolio_opportunity() -> None:
    from app.domain.training.cross_pair_relative_value import evaluate_relative_value_frame

    def calibrator(_: pd.DataFrame, **__: object) -> object:
        return _passed_policy()

    def route_all(frame: pd.DataFrame, _: object) -> pd.DataFrame:
        routed = frame.copy()
        routed["active_trade"] = True
        routed["predicted_long"] = True
        routed["selected_net_return"] = 0.0002
        return routed

    report = evaluate_relative_value_frame(
        _evaluation_frame(),
        horizon_bars=1,
        min_train_periods=260,
        validation_periods=60,
        max_splits=1,
        rolling_window=5,
        calibration_min_periods=60,
        calibration_min_rows=10,
        calibrator=calibrator,
        router=route_all,
    )

    assert report["participation"]["raw_active_signals"] == 60 * 6
    assert report["participation"]["non_overlapping_opportunities"] == 60


def test_positive_instrument_fraction_uses_all_six_pairs_as_denominator() -> None:
    from app.domain.training.cross_pair_relative_value import evaluate_relative_value_frame

    def calibrator(_: pd.DataFrame, **__: object) -> object:
        return _passed_policy()

    def route_one_pair(frame: pd.DataFrame, _: object) -> pd.DataFrame:
        routed = frame.copy()
        active = routed["instrument"].eq("EURUSD")
        routed["active_trade"] = active
        routed["predicted_long"] = True
        routed["selected_net_return"] = np.where(active, 0.0003, 0.0)
        return routed

    report = evaluate_relative_value_frame(
        _evaluation_frame(),
        horizon_bars=1,
        min_train_periods=260,
        validation_periods=60,
        max_splits=1,
        rolling_window=5,
        calibration_min_periods=60,
        calibration_min_rows=10,
        calibrator=calibrator,
        router=route_one_pair,
    )

    assert report["robustness"]["positive_instrument_fraction"] == 1 / 6
    assert report["robustness"]["instrument_positive"]["EURUSD"] is True
    assert sum(report["robustness"]["instrument_positive"].values()) == 1


def test_corpus_evaluator_requires_frozen_hashes_and_never_grants_trading_authority(
    tmp_path: object, monkeypatch: object
) -> None:
    import app.domain.training.cross_pair_relative_value as module

    report_path = tmp_path / "report.json"  # type: ignore[operator]
    frame = _evaluation_frame()
    monkeypatch.setattr(  # type: ignore[attr-defined]
        module,
        "load_and_prepare_corpora",
        lambda *args, **kwargs: (frame.copy(), dict(module.FROZEN_CORPUS_SHA256)),
    )
    monkeypatch.setattr(  # type: ignore[attr-defined]
        module,
        "evaluate_relative_value_frame",
        lambda *args, **kwargs: {
            "candidate": "cross-pair-relative-value-v1",
            "research_only": True,
            "approved_for_paper": False,
            "approved_for_demo": False,
            "approved_for_live": False,
            "folds": [],
        },
    )

    result = module.evaluate_relative_value_corpora(
        {pair: f"/{pair}.parquet" for pair in PAIRS},
        report_path=report_path,
        decision_time_before="2026-09-22T18:23:05.100429+00:00",
    )

    assert result["dataset_sha256"] == module.FROZEN_CORPUS_SHA256
    assert result["approved_for_paper"] is False
    assert result["approved_for_demo"] is False
    assert result["approved_for_live"] is False
    assert report_path.exists()
    assert not report_path.with_suffix(".json.tmp").exists()

    monkeypatch.setattr(  # type: ignore[attr-defined]
        module,
        "load_and_prepare_corpora",
        lambda *args, **kwargs: (frame.copy(), {**module.FROZEN_CORPUS_SHA256, "EURUSD": "wrong"}),
    )
    with __import__("pytest").raises(ValueError, match="frozen corpus SHA-256 mismatch"):
        module.evaluate_relative_value_corpora(
            {pair: f"/{pair}.parquet" for pair in PAIRS},
            report_path=report_path,
            decision_time_before="2026-09-22T18:23:05.100429+00:00",
        )
