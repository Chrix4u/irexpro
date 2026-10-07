#!/usr/bin/env python3
"""Leakage-resistant rolling chronological evaluator for strategy event CSVs.

Required columns: signal_time, exit_time, pnl_r, instrument. Optional: direction.
Labels enter a training fold only when exit_time <= training cutoff. Evaluation
rows are chronological and embargoed; no future outcome is visible to training.
"""
from __future__ import annotations

import argparse
import csv
import json
import math
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from statistics import mean, pstdev


def parse_time(value: str) -> datetime:
    value = value.strip().replace("Z", "+00:00")
    dt = datetime.fromisoformat(value)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


@dataclass(frozen=True)
class Event:
    signal_time: datetime
    exit_time: datetime
    pnl_r: float
    instrument: str
    direction: str
def load_events(path: Path) -> list[Event]:
    events: list[Event] = []
    with path.open(newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        required = {"signal_time", "exit_time", "pnl_r", "instrument"}
        missing = required.difference(reader.fieldnames or [])
        if missing:
            raise ValueError(f"missing columns: {sorted(missing)}")
        for row in reader:
            event = Event(
                signal_time=parse_time(row["signal_time"]),
                exit_time=parse_time(row["exit_time"]),
                pnl_r=float(row["pnl_r"]),
                instrument=row["instrument"].strip().upper(),
                direction=(row.get("direction") or "UNKNOWN").strip().upper(),
            )
            if event.exit_time < event.signal_time:
                raise ValueError("exit_time precedes signal_time")
            events.append(event)
    return sorted(events, key=lambda item: (item.signal_time, item.exit_time))


def metrics(events: list[Event]) -> dict[str, object]:
    pnl = [event.pnl_r for event in events]
    profit = sum(value for value in pnl if value > 0)
    loss = -sum(value for value in pnl if value < 0)
    pf = profit / loss if loss > 0 else (1_000_000.0 if profit > 0 else None)
    wins = sum(value > 0 for value in pnl)
    sharpe = None
    if len(pnl) >= 2:
        sd = pstdev(pnl)
        if sd > 0:
            sharpe = math.sqrt(len(pnl)) * mean(pnl) / sd
    per_pair: dict[str, float] = {}
    per_week: dict[str, float] = {}
    for event in events:
        per_pair[event.instrument] = per_pair.get(event.instrument, 0.0) + event.pnl_r
        iso = event.signal_time.isocalendar()
        week = f"{iso.year}-W{iso.week:02d}"
        per_week[week] = per_week.get(week, 0.0) + event.pnl_r
    return {
        "count": len(events),
        "wins": wins,
        "losses": len(events) - wins,
        "win_rate": wins / len(events) if events else None,
        "profit_factor": pf,
        "expectancy_r": mean(pnl) if pnl else None,
        "evidence_window_sharpe": sharpe,
        "positive_instrument_fraction": (
            sum(value > 0 for value in per_pair.values()) / len(per_pair) if per_pair else None
        ),
        "positive_week_fraction": (
            sum(value > 0 for value in per_week.values()) / len(per_week) if per_week else None
        ),
        "net_r": sum(pnl),
    }


def build_folds(
    events: list[Event], train_size: int, test_size: int, embargo_minutes: int
) -> list[dict[str, object]]:
    folds: list[dict[str, object]] = []
    start = train_size
    fold_no = 1
    while start < len(events):
        train_signal_cutoff = events[start - 1].signal_time
        label_cutoff = train_signal_cutoff
        train = [event for event in events[:start] if event.exit_time <= label_cutoff]
        test_begin_time = train_signal_cutoff + timedelta(minutes=embargo_minutes)
        candidate_test = [event for event in events[start:] if event.signal_time >= test_begin_time]
        test = candidate_test[:test_size]
        if not test:
            break
        folds.append(
            {
                "fold": fold_no,
                "train_signal_cutoff": train_signal_cutoff.isoformat(),
                "label_availability_cutoff": label_cutoff.isoformat(),
                "test_first_signal": test[0].signal_time.isoformat(),
                "test_last_signal": test[-1].signal_time.isoformat(),
                "train": metrics(train),
                "test": metrics(test),
                "train_rows_excluded_for_unavailable_outcome": start - len(train),
            }
        )
        start = events.index(test[-1]) + 1
        fold_no += 1
    return folds
def self_test() -> None:
    base = datetime(2026, 1, 1, tzinfo=timezone.utc)
    events = [
        Event(base + timedelta(minutes=i * 10), base + timedelta(minutes=i * 10 + 5), 1 if i % 2 else -1, "EURUSD", "BUY")
        for i in range(30)
    ]
    # This label finishes after the first training cutoff and must be excluded.
    events[9] = Event(events[9].signal_time, base + timedelta(days=2), 1, "EURUSD", "BUY")
    folds = build_folds(events, train_size=10, test_size=5, embargo_minutes=10)
    if not folds or folds[0]["train_rows_excluded_for_unavailable_outcome"] != 1:
        raise AssertionError("outcome-availability guard failed")
    if parse_time("2026-01-01T00:00:00Z").tzinfo != timezone.utc:
        raise AssertionError("UTC normalization failed")
    print("rolling causal evaluator self-test passed")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("csv", nargs="?")
    parser.add_argument("--train-size", type=int, default=1000)
    parser.add_argument("--test-size", type=int, default=250)
    parser.add_argument("--embargo-minutes", type=int, default=60)
    parser.add_argument("--output")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return
    if not args.csv:
        parser.error("csv is required unless --self-test is used")
    events = load_events(Path(args.csv))
    folds = build_folds(events, args.train_size, args.test_size, args.embargo_minutes)
    report = {
        "methodology": "rolling chronological; labels available only after exit_time; UTC; embargoed",
        "event_count": len(events),
        "train_size": args.train_size,
        "test_size": args.test_size,
        "embargo_minutes": args.embargo_minutes,
        "folds": folds,
    }
    payload = json.dumps(report, indent=2, allow_nan=False)
    if args.output:
        Path(args.output).write_text(payload + "\n", encoding="utf-8")
    else:
        print(payload)


if __name__ == "__main__":
    main()
