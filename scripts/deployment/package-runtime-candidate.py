#!/usr/bin/env python3
"""Assemble an offline server candidate from already-built, reviewed assets.

This tool does not compile, install, deploy, certify models, or enable trading.
Run in a clean CI artifact directory, never against a production checkout.
The caller is responsible for validating component contents and licenses.
"""
import argparse
import hashlib
import io
import json
import re
import sys
import tarfile
from pathlib import Path

COMPONENTS = (
    "api.tar.gz",
    "web.tar.gz",
    "admin.tar.gz",
    "ai-engine.tar.gz",
    "model-assets.tar.gz",
    "model-provenance.json",
    "database-migrations.tar.gz",
    "install-tools.tar.gz",
)
MANIFEST = "release-manifest.json"
MAX_MANIFEST = 65536


def digest(stream):
    h = hashlib.sha256()
    size = 0
    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
        h.update(chunk)
        size += len(chunk)
    return {"bytes": size, "sha256": h.hexdigest()}


def identity(source_sha, target):
    if not isinstance(source_sha, str) or not re.fullmatch(r"[0-9a-f]{40}", source_sha):
        raise ValueError("source SHA must be a full lowercase Git commit SHA")
    if not isinstance(target, str) or not re.fullmatch(r"linux-[a-z0-9][a-z0-9._-]{1,80}", target):
        raise ValueError("target must identify a Linux platform/architecture/ABI")


def entry(name, size):
    item = tarfile.TarInfo(name)
    item.size = size
    item.mode = 0o644
    item.mtime = 0
    return item


def input_manifest(directory, source_sha, target):
    identity(source_sha, target)
    if directory.is_symlink() or not directory.is_dir():
        raise ValueError("input must be a real dedicated artifact directory")
    if {p.name for p in directory.iterdir()} != set(COMPONENTS):
        raise ValueError("input must contain exactly the required server assets")
    artifacts = {}
    for name in COMPONENTS:
        p = directory / name
        if p.is_symlink() or not p.is_file():
            raise ValueError("asset must be a regular non-symlink file: " + name)
        with p.open("rb") as f:
            artifacts[name] = digest(f)
        if not artifacts[name]["bytes"]:
            raise ValueError("empty asset: " + name)
    return {
        "format_version": 1,
        "release_status": "candidate-not-certified",
        "source_sha": source_sha,
        "target": target,
        "artifacts": artifacts,
    }


def validate_manifest(m):
    if not isinstance(m, dict) or set(m) != {
        "format_version", "release_status", "source_sha", "target", "artifacts"
    }:
        raise ValueError("invalid manifest schema")
    if type(m["format_version"]) is not int or m["format_version"] != 1:
        raise ValueError("unsupported manifest version")
    if m["release_status"] != "candidate-not-certified":
        raise ValueError("unexpected release status")
    identity(m["source_sha"], m["target"])
    if not isinstance(m["artifacts"], dict) or set(m["artifacts"]) != set(COMPONENTS):
        raise ValueError("incomplete artifact manifest")
    for name, asset in m["artifacts"].items():
        if (not isinstance(asset, dict) or set(asset) != {"bytes", "sha256"}
                or type(asset["bytes"]) is not int or asset["bytes"] <= 0
                or not isinstance(asset["sha256"], str)
                or not re.fullmatch(r"[0-9a-f]{64}", asset["sha256"])):
            raise ValueError("invalid asset metadata: " + name)


def verify(archive, expected_sha, expected_target):
    identity(expected_sha, expected_target)
    with tarfile.open(archive, mode="r|") as tar:
        first = tar.next()
        if (first is None or first.name != MANIFEST or not first.isfile()
                or not 0 < first.size <= MAX_MANIFEST):
            raise ValueError("missing or invalid manifest")
        with tar.extractfile(first) as stream:
            manifest = json.load(stream)
        validate_manifest(manifest)
        if manifest["source_sha"] != expected_sha or manifest["target"] != expected_target:
            raise ValueError("source SHA or target mismatch")
        seen = set()
        # Use next() rather than iter(tar): streaming iteration can yield the
        # already-read first member again on older Python versions.
        while True:
            item = tar.next()
            if item is None:
                break
            if not item.isfile() or item.name not in COMPONENTS or item.name in seen:
                raise ValueError("unexpected, duplicate or unsafe archive member")
            expected = manifest["artifacts"][item.name]
            if item.size != expected["bytes"]:
                raise ValueError("asset size mismatch: " + item.name)
            with tar.extractfile(item) as stream:
                actual = digest(stream)
            if actual != expected:
                raise ValueError("asset checksum mismatch: " + item.name)
            seen.add(item.name)
        if seen != set(COMPONENTS):
            raise ValueError("missing archive members")
    return manifest


def build(directory, archive, source_sha, target):
    manifest = input_manifest(directory, source_sha, target)
    payload = (json.dumps(manifest, sort_keys=True, indent=2) + "\n").encode()
    if archive.parent.resolve() == directory.resolve():
        raise ValueError("output must be outside the input directory")
    created = False
    try:
        with archive.open("xb") as output:
            created = True
            with tarfile.open(fileobj=output, mode="w", format=tarfile.USTAR_FORMAT) as tar:
                tar.addfile(entry(MANIFEST, len(payload)), io.BytesIO(payload))
                for name in COMPONENTS:
                    p = directory / name
                    if p.is_symlink() or not p.is_file():
                        raise ValueError("asset changed: " + name)
                    with p.open("rb") as stream:
                        tar.addfile(entry(name, manifest["artifacts"][name]["bytes"]), stream)
                    if p.stat().st_size != manifest["artifacts"][name]["bytes"]:
                        raise ValueError("asset size changed: " + name)
        return verify(archive, source_sha, target)
    except BaseException:
        if created:
            archive.unlink(missing_ok=True)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("build", "verify"):
        p = sub.add_parser(name)
        p.add_argument("--archive", required=True, type=Path)
        p.add_argument("--source-sha", required=True)
        p.add_argument("--target", required=True)
        if name == "build":
            p.add_argument("--input", required=True, type=Path)
    args = parser.parse_args()
    try:
        result = (build(args.input, args.archive, args.source_sha, args.target)
                  if args.command == "build"
                  else verify(args.archive, args.source_sha, args.target))
    except (OSError, ValueError, tarfile.TarError) as exc:
        print("candidate package rejected: " + str(exc), file=sys.stderr)
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
