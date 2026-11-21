#!/usr/bin/env python3
"""Unit tests for the read-only shared VPS capacity observer."""
import contextlib
import datetime as dt
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

SOURCE = Path(__file__).with_name("shared-vps-storage-watch.py")
spec = importlib.util.spec_from_file_location("shared_vps_storage_watch", SOURCE)
monitor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(monitor)

class StorageWatchTests(unittest.TestCase):
    def test_current_disk_snapshot_is_sane(self):
        x = monitor.disk()
        self.assertGreater(x["total_gib"], 0)
        self.assertGreater(x["available_gib"], 0)
        self.assertGreaterEqual(x["use_percent"], 0)
        self.assertLessEqual(x["use_percent"], 100)
        self.assertLess(x["available_gib"], x["total_gib"])

    def test_atomic_json_saving(self):
        with tempfile.TemporaryDirectory() as t:
            p = Path(t)/"latest.json"
            monitor.save_json(p, {"free": 43, "note": "verified"})
            self.assertEqual(json.loads(p.read_text())["free"], 43)
            self.assertEqual(p.stat().st_mode & 0o777, 0o600)
            self.assertEqual(list(Path(t).glob("*.tmp")), [])

    def test_collect_never_deletes_data_and_restricts_snapshots(self):
        with tempfile.TemporaryDirectory() as t:
            root = Path(t)
            with mock.patch.multiple(monitor,
                STATE=root,
                SNAPS=root/"snapshots",
                LATEST=root/"latest.json",
                INVENTORY=root/"inventory.json",
                LOCK=root/".lock",
                MAX_SNAPS=3
            ), mock.patch.object(monitor, "build_count", return_value=0), \
                 mock.patch.object(monitor, "disk", return_value={
                     "total_gib": 313, "available_gib": 34,
                     "used_gib": 277, "use_percent": 90, "inode_use_percent": 40
                 }), mock.patch.object(monitor.subprocess, "run") as subprocess_run:
                with contextlib.redirect_stdout(io.StringIO()):
                    self.assertEqual(monitor.collect(), 0)
                    for n in range(4):
                        p = root/"snapshots"/f"2000010{n}T000000Z.json"
                        p.write_text("{}")
                    self.assertEqual(monitor.collect(), 0)
                data = monitor.read_json(root/"latest.json")
                self.assertIn("VPS disk at or above 90%", data["alerts"][0])
                self.assertEqual(data["active_build_processes"], 0)
                self.assertLessEqual(len(list((root/"snapshots").glob("*.json"))), 3)
                subprocess_run.assert_called()

    def test_invalid_inventory_record_fails_safe(self):
        with tempfile.TemporaryDirectory() as t:
            target = Path(t)/"latest.json"
            target.write_text("{bad-data")
            self.assertIsNone(monitor.read_json(target))

    def test_build_counter_returns_nonnegative_integer(self):
        n = monitor.build_count()
        self.assertIsInstance(n, int)
        self.assertGreaterEqual(n, 0)

if __name__ == "__main__":
    unittest.main()
