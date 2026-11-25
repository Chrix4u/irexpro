#!/usr/bin/env python3
"""Regression tests for the read-only Lightworld shared-VPS capacity preflight."""
import importlib.machinery
import io
import json
import unittest
from contextlib import redirect_stdout
from pathlib import Path

PATH=Path(__file__).with_name("lightworld-vps-capacity-check.py")
guard=importlib.machinery.SourceFileLoader("lightworld_guard",str(PATH)).load_module()

class PolicyTests(unittest.TestCase):
    def test_build_accepted_with_clear_headroom(self):
        self.assertEqual(guard.decide("build",0,40*1024,89,0),[])

    def test_build_blocked_at_disk_threshold(self):
        self.assertTrue(guard.decide("build",0,40*1024,90,0))

    def test_build_blocked_low_free(self):
        self.assertTrue(guard.decide("build",0,25*1024,88,0))

    def test_build_blocked_concurrent_compilation(self):
        self.assertTrue(guard.decide("build",0,40*1024,85,1))

    def test_artifact_smaller_than_reserve_passes(self):
        self.assertEqual(guard.decide("artifact",500,40*1024,95,1),[])

    def test_artifact_with_extraction_overhead_hold(self):
        self.assertTrue(guard.decide("artifact",5000,12*1024,89,0))

    def test_artifact_without_size_is_rejected(self):
        self.assertTrue(guard.decide("artifact",0,40*1024,85,0))

    def test_readonly_inspect_no_block_even_when_full(self):
        self.assertEqual(guard.decide("inspect",0,1,100,99),[])

    def test_invalid_or_malformed_cli_arguments_refused(self):
        self.assertEqual(guard.main(["capacity"] ),2)
        self.assertEqual(guard.main(["capacity","artifact","undefined"]),2)
        self.assertEqual(guard.main(["capacity","artifact","0"]),2)

    def test_usage_no_mutation(self):
        self.assertFalse(hasattr(guard,"delete_release"))
        self.assertFalse(hasattr(guard,"restart_services"))

if __name__ == "__main__":
    with redirect_stdout(io.StringIO()):
        unittest.main()
