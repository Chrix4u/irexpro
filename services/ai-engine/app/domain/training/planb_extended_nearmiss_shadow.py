"""Read-only missed-entry quote audit for normal-drift Plan-B regime vetoes.

No trading models are fitted, enabled, changed, or promoted by this module.
The 15-minute post-decision proxy does not replicate fills, stops, or execution.
Observed one-minute candle high/low is a MID/quote range, not an executable
broker bid/ask high/low; stop/target touch flags remain explicitly tentative.
"""

from __future__ import annotations

import argparse
import io
import json
import os
import subprocess
from pathlib import Path

import numpy as np
import pandas as pd
from dotenv import dotenv_values

ARTIFACT = "planb-normal-drift-extended-m1-miss-audit-v1"
PAIRS = ("AUDUSD", "EURUSD", "GBPUSD")
RESEARCH_DIR = Path("/home/lightworld/webapps/irexpro-research/planb-near-miss")
PRICE_COLUMNS = (
    "proposed_entry",
    "stop_loss",
    "take_profit",
    "entry_bid",
    "entry_ask",
    "future_bid",
    "future_ask",
    "decision_spread",
    "possible_low",
    "possible_high",
    "path_m1_bars",
    "aligned_m5",
    "aligned_m15",
    "aligned_h1",
    "aligned_h4",
)
REQUIRED = (
    "instrument",
    "direction",
    "route",
    "plan_b_regime",
    "decision_time_utc",
    "decision_available_at_utc",
    "entry_quote_at",
    "future_quote_at",
    "entry_quote_source",
    "future_quote_source",
    "first_target_close_at",
    "first_stop_close_at",
    "first_possible_mid_stop_at",
    "last_observed_m1_bar_at",
    *PRICE_COLUMNS,
)


def prepare(raw: pd.DataFrame) -> tuple[pd.DataFrame, dict]:
    missing = set(REQUIRED) - set(raw.columns)
    if missing:
        raise ValueError(f"Research columns absent: {sorted(missing)}")
    df = raw.copy()
    for key in PRICE_COLUMNS:
        df[key] = pd.to_numeric(df[key], errors="coerce")
    for key in (
        "decision_time_utc",
        "decision_available_at_utc",
        "entry_quote_at",
        "future_quote_at",
        "first_target_close_at",
        "first_stop_close_at",
        "first_possible_mid_stop_at",
        "last_observed_m1_bar_at",
    ):
        df[key] = pd.to_datetime(df[key], utc=True, errors="coerce")
    valid = (
        df["instrument"].isin(PAIRS)
        & df["direction"].isin(("BUY", "SELL"))
        & df["route"].eq("M1_TREND_CONTINUATION")
        & df["plan_b_regime"].isin(("TREND_EXTENDED", "TREND_HEALTHY"))
        & df["entry_quote_source"].eq("ctrader-broker-native")
        & df["future_quote_source"].eq("ctrader-broker-native")
        & df[list(PRICE_COLUMNS)].notna().all(axis=1)
        & np.isfinite(df[list(PRICE_COLUMNS)].to_numpy(dtype=float)).all(axis=1)
        & df["decision_time_utc"].notna()
        & df["decision_available_at_utc"].notna()
        & (df["decision_available_at_utc"] >= df["decision_time_utc"])
        & (df["decision_available_at_utc"] - df["decision_time_utc"] <= pd.Timedelta(minutes=2))
        & df["entry_quote_at"].notna()
        & df["future_quote_at"].notna()
        & (df["entry_quote_at"] >= df["decision_available_at_utc"])
        & (df["entry_quote_at"] - df["decision_available_at_utc"] <= pd.Timedelta(seconds=150))
        & (df["future_quote_at"] >= df["entry_quote_at"] + pd.Timedelta(minutes=15))
        & (df["future_quote_at"] <= df["entry_quote_at"] + pd.Timedelta(minutes=18))
        & (df["entry_bid"] > 0)
        & (df["entry_ask"] >= df["entry_bid"])
        & (df["future_bid"] > 0)
        & (df["future_ask"] >= df["future_bid"])
        & (df["decision_spread"] >= 0)
        & (df["decision_spread"] < 0.001)
        & (df["path_m1_bars"] >= 14)
        & (df["path_m1_bars"] <= 15)
        & (df["possible_low"] > 0)
        & (df["possible_high"] >= df["possible_low"])
        & ((df["proposed_entry"] - df["entry_bid"]).abs() <= 0.0005)
    )
    # Reject geometry inconsistent with either proposed direction.
    geometry = np.where(
        df["direction"].eq("BUY"),
        (df["stop_loss"] < df["proposed_entry"]) & (df["proposed_entry"] < df["take_profit"]),
        (df["take_profit"] < df["proposed_entry"]) & (df["proposed_entry"] < df["stop_loss"]),
    )
    valid = valid & geometry
    df = df.loc[valid].copy().sort_values(
        ["decision_time_utc", "instrument", "direction"], kind="stable"
    )
    if not df.empty:
        spread = np.maximum(
            df["decision_spread"], df["entry_ask"] - df["entry_bid"]
        )
        buying = df["direction"].eq("BUY")
        # Conservative point-in-time quote proxy with recorded execution spread.
        df["proxy_entry"] = np.where(
            buying,
            np.maximum.reduce(
                [df["proposed_entry"], df["entry_ask"], df["entry_bid"] + spread]
            ),
            np.minimum(df["proposed_entry"], df["entry_bid"]),
        )
        df["proxy_exit"] = np.where(
            buying,
            df["future_bid"],
            np.maximum(df["future_ask"], df["future_bid"] + spread),
        )
        df["fifteen_min_proxy_pips"] = np.where(
            buying,
            (df["proxy_exit"] - df["proxy_entry"]) / 0.0001,
            (df["proxy_entry"] - df["proxy_exit"]) / 0.0001,
        ) - 1.0  # Additional hypothetical friction; not actual broker commissions.
        df["possible_stop_touch"] = np.where(
            buying,
            df["possible_low"] <= df["stop_loss"],
            df["possible_high"] >= df["stop_loss"],
        )
        df["possible_target_touch"] = np.where(
            buying,
            df["possible_high"] >= df["take_profit"],
            df["possible_low"] <= df["take_profit"],
        )
        df["m5_m15_aligned"] = (df["aligned_m5"] > 0) & (df["aligned_m15"] > 0)
        df["h1_opposed"] = df["aligned_h1"] < 0
        target = df["first_target_close_at"]
        stop = df["first_stop_close_at"]
        possible_mid_stop = df["first_possible_mid_stop_at"]
        # A quote close beyond TP is observable, not proof a broker order
        # executed; an earlier possible intraminute stop makes it ambiguous.
        df["target_before_stop_quote_close"] = (
            target.notna()
            & (stop.isna() | (target < stop))
            & (possible_mid_stop.isna() | (target < possible_mid_stop))
        )
        df["stop_before_target_quote_close"] = (
            stop.notna() & (target.isna() | (stop < target))
        )
        df["utc_day"] = df["decision_time_utc"].dt.strftime("%Y-%m-%d")
    return df, {
        "raw_quote_matched_rows": int(len(raw)),
        "causally_qualified_rows": int(len(df)),
        "excluded_incomplete_or_unverified_rows": int(len(raw) - len(df)),
    }


def non_overlapping(df: pd.DataFrame) -> pd.DataFrame:
    last: dict[str, pd.Timestamp] = {}
    selected: list[int] = []
    for index, row in df.iterrows():
        symbol = str(row["instrument"])
        at = row["decision_time_utc"]
        if symbol in last and at - last[symbol] < pd.Timedelta(minutes=30):
            continue
        last[symbol] = at
        selected.append(index)
    return df.loc[selected].copy()


def metrics(df: pd.DataFrame) -> dict:
    if df.empty:
        return {
            "episodes": 0,
            "positive_fraction": None,
            "mean_proxy_pips": None,
            "proxy_profit_factor": None,
            "distinct_utc_days": 0,
            "possible_stop_touches": 0,
            "possible_target_touches": 0,
            "target_before_stop_quote_closes": 0,
            "stop_before_target_quote_closes": 0,
        }
    p = df["fifteen_min_proxy_pips"]
    gains = float(p.clip(lower=0).sum())
    losses = float(-p.clip(upper=0).sum())
    return {
        "episodes": int(len(df)),
        "positive_fraction": round(float((p > 0).mean()), 4),
        "mean_proxy_pips": round(float(p.mean()), 4),
        "proxy_profit_factor": round(gains / losses, 4) if losses > 0 else None,
        "distinct_utc_days": int(df["utc_day"].nunique()),
        "possible_stop_touches": int(df["possible_stop_touch"].sum()),
        "possible_target_touches": int(df["possible_target_touch"].sum()),
        "target_before_stop_quote_closes": int(
            df["target_before_stop_quote_close"].sum()
        ),
        "stop_before_target_quote_closes": int(
            df["stop_before_target_quote_close"].sum()
        ),
    }


def build_report(
    raw: pd.DataFrame,
    inspect_at: str | None = None,
    inspect_instrument: str = "EURUSD",
    inspect_direction: str = "BUY",
) -> dict:
    qualified, quality = prepare(raw)
    episodes = non_overlapping(qualified)
    groups: dict[str, dict] = {}
    grouped = (
        episodes.groupby(
            ["plan_b_regime", "m5_m15_aligned", "h1_opposed"], sort=True
        )
        if not episodes.empty
        else []
    )
    for (regime, aligned, h1_opposed), part in grouped:
        key = f"{regime}|M5_M15_{'ALIGNED' if aligned else 'NOT_ALIGNED'}|H1_{'OPPOSED' if h1_opposed else 'NOT_OPPOSED'}"
        groups[key] = {**metrics(part), "pairs": sorted(part["instrument"].unique().tolist())}
    example = None
    if inspect_at:
        timestamp = pd.Timestamp(inspect_at)
        if timestamp.tzinfo is None:
            raise ValueError("Inspection time must be timezone-aware")
        target = qualified[
            qualified["decision_time_utc"].eq(timestamp)
            & qualified["instrument"].eq(inspect_instrument)
            & qualified["direction"].eq(inspect_direction)
        ]
        if not target.empty:
            row = target.iloc[0]
            example = {
                "decision_time_utc": row["decision_time_utc"].isoformat(),
                "instrument": str(row["instrument"]),
                "direction": str(row["direction"]),
                "regime": str(row["plan_b_regime"]),
                "decision_available_at_utc": row["decision_available_at_utc"].isoformat(),
                "entry_signal": round(float(row["proposed_entry"]), 5),
                "conservative_entry_quote_proxy": round(float(row["proxy_entry"]), 6),
                "future_bid_quote": round(float(row["future_bid"]), 6),
                "future_quote_at": row["future_quote_at"].isoformat(),
                "fifteen_min_proxy_pips": round(float(row["fifteen_min_proxy_pips"]), 4),
                "possible_stop_touch_midpoint_only": bool(row["possible_stop_touch"]),
                "possible_target_touch_midpoint_only": bool(row["possible_target_touch"]),
                "independent_episode_sample": bool(row.name in episodes.index),
                "first_target_bidask_quote_close_at": (
                    row["first_target_close_at"].isoformat()
                    if pd.notna(row["first_target_close_at"])
                    else None
                ),
                "first_stop_bidask_quote_close_at": (
                    row["first_stop_close_at"].isoformat()
                    if pd.notna(row["first_stop_close_at"])
                    else None
                ),
                "possible_midpoint_stop_touch_at": (
                    row["first_possible_mid_stop_at"].isoformat()
                    if pd.notna(row["first_possible_mid_stop_at"])
                    else None
                ),
                "target_before_stop_quote_close": bool(
                    row["target_before_stop_quote_close"]
                ),
                "observed_m1_bar_at": (
                    row["last_observed_m1_bar_at"].isoformat()
                    if pd.notna(row["last_observed_m1_bar_at"])
                    else None
                ),
                "full_60_minute_observation": bool(
                    pd.notna(row["last_observed_m1_bar_at"])
                    and row["last_observed_m1_bar_at"]
                    >= row["entry_quote_at"] + pd.Timedelta(minutes=60)
                ),
            }
    return {
        "artifact": ARTIFACT,
        "mode": "RESEARCH_SHADOW_ONLY",
        "authority": "NONE",
        "model_fitted": False,
        "execution_allowed": False,
        "promotion_allowed": False,
        "modifies_execution": False,
        "broker_net_pnl_verified": False,
        "commission_and_swap_verified": False,
        "extra_hypothetical_friction_pips": 1.0,
        "methodology": (
            "First completed cTrader M1 bid/ask quote observed AFTER the model decision "
            "was durably recorded (not the previous signal candle), and a future quote "
            ">=15min after that reference, with recorded execution spread plus 1pip assumed "
            "friction. One earliest observation per symbol across sides/regimes every "
            "30min. Fixed horizon is not a fill, stop/TP simulation or broker net P&L."
        ),
        "limitations": (
            "Broker quote closes following a saved decision are only executable-price "
            "proxies, not actual synchronous quote/order evidence. "
            "Only short-sample provider quotes, not independent daily folds. "
            "Midpoint OHLC stop/target touches are possible-touch flags only; "
            "first 60-minute bid/ask quote CLOSE crossing is not proof of order "
            "execution or first intraminute touch. An earlier possible midpoint "
            "stop invalidates quote-close target-first classification. "
            "Intraminute bid/ask ordering, fills, slippage, financing and "
            "commissions cannot be verified from these bars."
        ),
        "data_quality": quality,
        "independent_episodes": int(len(episodes)),
        "overall": metrics(episodes),
        "subgroups": groups,
        "inspection": example,
    }


def _read_scoped_broker_cohort(sql_path: Path, api_env_path: Path) -> pd.DataFrame:
    config = dotenv_values(api_env_path)
    required = ("DB_HOST", "DB_USER", "DB_PASSWORD", "VPS_FOREX_SCANNER_USER_ID")
    if any(not config.get(key) for key in required):
        raise RuntimeError("Scoped read-only broker research configuration unavailable")
    db = config.get("DB_NAME") or config.get("DB_DATABASE")
    if not db:
        raise RuntimeError("Missing authorized research database")
    env = dict(os.environ)
    env["PGPASSWORD"] = str(config["DB_PASSWORD"])
    env["PGOPTIONS"] = "-c default_transaction_read_only=on -c statement_timeout=65000"
    query = [
        "psql", "-X", "--csv", "-v", "ON_ERROR_STOP=1",
        "-h", str(config["DB_HOST"]),
        "-p", str(config.get("DB_PORT") or "5432"),
        "-U", str(config["DB_USER"]), "-d", str(db),
        "-v", "scanner_user=" + str(config["VPS_FOREX_SCANNER_USER_ID"]),
        "-f", str(sql_path),
    ]
    try:
        completed = subprocess.run(
            query, env=env, check=True, capture_output=True, text=True, timeout=90
        )
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
        raise RuntimeError("Read-only broker research query failed") from exc
    return pd.read_csv(io.StringIO(completed.stdout))


def main() -> None:
    parser = argparse.ArgumentParser(description="Read-only Plan B missed-entry audit")
    parser.add_argument("--api-env", type=Path, required=True)
    parser.add_argument("--inspect-at", default=None)
    parser.add_argument("--inspect-instrument", default="EURUSD")
    parser.add_argument("--inspect-direction", default="BUY")
    args = parser.parse_args()
    if args.inspect_instrument not in PAIRS or args.inspect_direction not in ("BUY", "SELL"):
        raise ValueError("Inspection must target an approved research symbol and side")
    sql_path = Path(__file__).with_name("planb_extended_nearmiss_readonly.sql")
    raw = _read_scoped_broker_cohort(sql_path, args.api_env)
    report = build_report(
        raw, args.inspect_at, args.inspect_instrument, args.inspect_direction
    )
    RESEARCH_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
    temp = RESEARCH_DIR / ".latest-planb-regime-report.tmp"
    temp.write_text(json.dumps(report, sort_keys=True, indent=2) + "\n")
    os.chmod(temp, 0o600)
    os.replace(temp, RESEARCH_DIR / "latest-report.json")
    print(
        "PLANB_REGIME_NEAR_MISS_READONLY=TRUE "
        f"QUALIFIED={report['data_quality']['causally_qualified_rows']} "
        f"INDEPENDENT_EPISODES={report['independent_episodes']} "
        "MODEL_FITTED=FALSE EXECUTION_ALLOWED=FALSE"
    )


if __name__ == "__main__":
    main()
