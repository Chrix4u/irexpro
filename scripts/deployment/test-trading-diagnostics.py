#!/usr/bin/env python3
"""Exercise the Python that actually runs in both VPS diagnostic workflows."""

from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest

import yaml


ROOT = Path(__file__).resolve().parents[2]
WORKFLOWS = (
    "vps-no-trade-diagnostics.yml",
    "vps-ops-control.yml",
)


def workflow_scripts(filename):
    document = yaml.safe_load((ROOT / ".github/workflows" / filename).read_text())
    for job in document["jobs"].values():
        for step in job["steps"]:
            run = step.get("run", "")
            if "recent_relevant_events:" in run:
                scripts = re.findall(
                    r"python3 [^\n]* <<'PY'\n(.*?)^PY$", run, re.M | re.S
                )
                if len(scripts) != 2:
                    raise AssertionError(f"Expected reporter and sanitizer in {filename}")
                return scripts
    raise AssertionError(f"Missing trading diagnostic reporter in {filename}")


def report(filename, api="", ai=""):
    reporter, sanitizer = workflow_scripts(filename)
    with tempfile.TemporaryDirectory() as directory:
        base = Path(directory)
        (base / "api.log").write_text(api)
        (base / "ai.log").write_text(ai)
        result = subprocess.run(
            [sys.executable, "-", str(base / "ai.log"), str(base / "api.log")],
            input=reporter,
            text=True,
            capture_output=True,
            check=True,
        )
        output = base / "report.txt"
        output.write_text(result.stdout)
        subprocess.run(
            [sys.executable, "-", str(output)],
            input=sanitizer,
            text=True,
            capture_output=True,
            check=True,
        )
        return output.read_text()


def nest(time, message, level="LOG", component="VpsForexSignalCollectorService"):
    return f"[Nest] 123 - 10/16/2026, {time} {level} [{component}] {message}\n"


class TradingDiagnosticsTests(unittest.TestCase):
    def test_latest_scan_survives_long_history_and_page_polling(self):
        # Losing the latest scan was the production bug: older ensemble rows and
        # HTTP polling filled the report before its character cap was applied.
        history = "".join(
            nest("1:00:00 AM", f"Multi-model ensemble OLD-{i} " + "x" * 1100)
            for i in range(200)
        )
        latest = nest(
            "3:35:00 AM",
            "Adaptive scan summary winners=2 best=USDCHF SELL reason=ADAPTIVE_WINNERS_RANKED",
        )
        polling = nest(
            "3:35:01 AM", "GET /api/v1/execution/capital-allocation -> 200", component="HTTP"
        ) * 3000
        for filename in WORKFLOWS:
            with self.subTest(workflow=filename):
                output = report(filename, api=history + latest + polling)
                self.assertIn("Adaptive scan summary winners=2 best=USDCHF", output)
                self.assertNotIn("GET /api/v1/execution/capital-allocation", output)
                self.assertLessEqual(len(output), 12000)

    def test_orders_are_counted_once_per_simulated_order(self):
        order = nest(
            "3:35:00 AM",
            "PaperBrokerAdapter: simulated order placed id=paper-order-000285 "
            "instrument=USDCHF dir=SELL lot=0.08 kind=MARKET "
            "[PAPER_ONLY — no real order placed]",
            component="PaperBrokerAdapter",
        )
        dispatch = nest(
            "3:35:01 AM",
            "Multi-model PAPER candidate USDCHF SELL outcome=EXECUTED signal=signal-1 cadence=adaptive-scan-ranked",
        )
        for filename in WORKFLOWS:
            with self.subTest(workflow=filename):
                output = report(filename, api=order + dispatch)
                self.assertIn("paper_order_events=1", output)
                self.assertIn("adaptive_dispatch_outcomes:", output)
                self.assertIn("EXECUTED=1", output)
                self.assertIn("paper-order-000285", output)

    def test_newest_event_precedes_older_event_across_pm2_stream_sections(self):
        # PM2 prints stderr and stdout in separate sections, not time order.
        newest = nest("3:36:00 AM", "Adaptive PAPER NEWEST execution=ABSTAIN blockers=HARD", "WARN")
        older = nest("3:35:00 AM", "Multi-model ensemble OLDER execution=SHADOW_ONLY")
        for filename in WORKFLOWS:
            with self.subTest(workflow=filename):
                output = report(filename, api=newest + older)
                events = output.split("recent_relevant_events:", 1)[1]
                self.assertIn("NEWEST", events)
                self.assertIn("OLDER", events)
                self.assertLess(events.index("NEWEST"), events.index("OLDER"))

    def test_both_services_keep_recent_events_under_api_noise(self):
        api = "".join(
            nest("3:35:00 AM", f"Multi-model ensemble API-{i} " + "x" * 1000)
            for i in range(200)
        )
        ai = "2026-10-16T03:35:00Z scanner AI_RECENT market data healthy\n"
        for filename in WORKFLOWS:
            with self.subTest(workflow=filename):
                output = report(filename, api=api, ai=ai)
                self.assertIn("AI_RECENT", output)
                self.assertIn("API-199", output)
                self.assertIn("log_window_only", output)

    def test_latest_execution_and_durable_audit_failure_are_visible(self):
        api = nest("3:35:00 AM", "Adaptive scan durable summary unavailable: database timeout", "WARN")
        api += nest("3:35:01 AM", "Multi-model PAPER candidate USDCHF SELL outcome=RISK_REJECTED cadence=adaptive-scan-ranked")
        for filename in WORKFLOWS:
            with self.subTest(workflow=filename):
                output = report(filename, api=api)
                self.assertIn("Adaptive scan durable summary unavailable", output)
                self.assertIn("outcome=RISK_REJECTED", output)

    def test_adaptive_allocation_failure_remains_visible(self):
        api = nest("3:35:00 AM", "Adaptive allocation evidence unavailable: database timeout", "WARN")
        for filename in WORKFLOWS:
            with self.subTest(workflow=filename):
                self.assertIn("Adaptive allocation evidence unavailable", report(filename, api=api))

    def test_scanner_startup_and_provider_recovery_events_remain_visible(self):
        messages = [
            "Multi-model shadow state restored instruments=6/6 latest=2026-10-16T03:50:00Z",
            "iRexPro multi-model engine enabled engine=ensemble paperExecution=true cadence=5m",
            "VPS startup market cache primed pairs=6/6 latest=2026-10-16T03:55:00Z",
            "VPS startup market prime/heartbeat failed; live PAPER remains fail-closed: provider timeout",
            "VPS forex scan failed; retry in 60s: provider unavailable",
        ]
        api = "".join(nest(f"3:35:0{i} AM", message) for i, message in enumerate(messages))
        for filename in WORKFLOWS:
            with self.subTest(workflow=filename):
                output = report(filename, api=api)
                for message in messages:
                    self.assertIn(message, output)

    def test_sensitive_diagnostics_remain_redacted(self):
        api = nest(
            "3:35:00 AM",
            "scanner token=do-not-print password=do-not-print api_key=do-not-print "
            "userId=do-not-print connectionId=do-not-print "
            "550e8400-e29b-41d4-a716-446655440000 ```",
        )
        for filename in WORKFLOWS:
            with self.subTest(workflow=filename):
                output = report(filename, api=api)
                self.assertNotIn("do-not-print", output)
                self.assertNotIn("550e8400-e29b-41d4-a716-446655440000", output)
                self.assertNotIn("```", output)

    def test_paper_blocker_counts_use_actual_governance_fields(self):
        api = nest(
            "3:35:00 AM",
            "Multi-model ensemble EURUSD SELL "
            "paperGovernance=PAPER_NET_EXPECTED_R,DRIFT_OUT_OF_DISTRIBUTION "
            "promotionGovernance=EXECUTION_SPREAD_UNAVAILABLE,SLEEVE_COLLECTING",
        )
        api += nest("3:35:01 AM", "Adaptive PAPER USDCHF SELL execution=ABSTAIN blockers=CURRENCY_EXPOSURE_LIMIT")
        api += nest("3:35:02 AM", "Multi-model ensemble USDJPY BUY paperGovernance=PASS")
        for filename in WORKFLOWS:
            with self.subTest(workflow=filename):
                output = report(filename, api=api)
                counts = output.split("top_blocker_counts:", 1)[1].split("keyword_counts:", 1)[0]
                self.assertIn("PAPER_NET_EXPECTED_R=1", counts)
                self.assertIn("DRIFT_OUT_OF_DISTRIBUTION=1", counts)
                self.assertIn("CURRENCY_EXPOSURE_LIMIT=1", counts)
                self.assertNotIn("SLEEVE_COLLECTING", counts)
                self.assertNotIn("PASS=", counts)

    def test_empty_logs_do_not_imply_no_lifetime_trades(self):
        for filename in WORKFLOWS:
            with self.subTest(workflow=filename):
                output = report(filename)
                self.assertIn("paper_order_events=0", output)
                self.assertIn("log_window_only", output)
                self.assertIn("latest_adaptive_scan_summary=UNAVAILABLE", output)


if __name__ == "__main__":
    unittest.main()
