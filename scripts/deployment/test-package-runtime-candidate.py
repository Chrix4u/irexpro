#!/usr/bin/env python3
import importlib.util
import io
import json
import tarfile
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "candidate", Path(__file__).with_name("package-runtime-candidate.py")
)
candidate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(candidate)

SHA = "a" * 40
TARGET = "linux-x86_64-glibc2.34"


class CandidateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.assets = self.root / "assets"
        self.assets.mkdir()
        for name in candidate.COMPONENTS:
            (self.assets / name).write_bytes(("test-fixture:" + name).encode())
        self.archive = self.root / "candidate.tar"

    def tearDown(self):
        self.tmp.cleanup()

    def build(self):
        return candidate.build(self.assets, self.archive, SHA, TARGET)

    def test_complete_and_deterministic(self):
        first = self.build()
        second = self.root / "second.tar"
        candidate.build(self.assets, second, SHA, TARGET)
        self.assertEqual(self.archive.read_bytes(), second.read_bytes())
        self.assertEqual(first, candidate.verify(self.archive, SHA, TARGET))
        self.assertEqual(first["release_status"], "candidate-not-certified")

    def test_missing_model(self):
        (self.assets / "model-assets.tar.gz").unlink()
        with self.assertRaises(ValueError):
            self.build()
        self.assertFalse(self.archive.exists())

    def test_unexpected_file(self):
        (self.assets / ".env").write_text("synthetic-test-only")
        with self.assertRaises(ValueError):
            self.build()

    def test_symlink(self):
        p = self.assets / "api.tar.gz"
        p.unlink()
        p.symlink_to(self.assets / "web.tar.gz")
        with self.assertRaises(ValueError):
            self.build()

    def test_empty_asset(self):
        (self.assets / "api.tar.gz").write_bytes(b"")
        with self.assertRaises(ValueError):
            self.build()

    def test_wrong_identity(self):
        self.build()
        for sha, target in [("b" * 40, TARGET), (SHA, "linux-aarch64")]:
            with self.assertRaises(ValueError):
                candidate.verify(self.archive, sha, target)

    def test_invalid_sha(self):
        with self.assertRaises(ValueError):
            candidate.build(self.assets, self.archive, "main", TARGET)

    def test_tamper(self):
        self.build()
        raw = self.archive.read_bytes()
        self.archive.write_bytes(raw.replace(b"test-fixture:api.tar.gz",
                                             b"evil-fixture:api.tar.gz"))
        with self.assertRaises(ValueError):
            candidate.verify(self.archive, SHA, TARGET)

    def test_duplicate_member(self):
        self.build()
        with tarfile.open(self.archive, "a") as tar:
            data = b"x"
            tar.addfile(candidate.entry("api.tar.gz", len(data)), io.BytesIO(data))
        with self.assertRaises(ValueError):
            candidate.verify(self.archive, SHA, TARGET)

    def test_unsafe_member(self):
        self.build()
        with tarfile.open(self.archive, "a") as tar:
            tar.addfile(candidate.entry("../outside", 1), io.BytesIO(b"x"))
        with self.assertRaises(ValueError):
            candidate.verify(self.archive, SHA, TARGET)

    def test_no_overwrite(self):
        self.archive.write_bytes(b"existing")
        with self.assertRaises(FileExistsError):
            self.build()
        self.assertEqual(self.archive.read_bytes(), b"existing")

    def test_output_not_in_input(self):
        with self.assertRaises(ValueError):
            candidate.build(self.assets, self.assets / "candidate.tar", SHA, TARGET)


if __name__ == "__main__":
    unittest.main(verbosity=2)
