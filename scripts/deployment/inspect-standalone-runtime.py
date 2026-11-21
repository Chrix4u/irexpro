#!/usr/bin/env python3
"""Verify a GitHub-compiled iRexPro runtime tarball without extraction.

Checks source SHA, essential entrypoints, archive paths/types, and links. This
is a preflight only; deployment additionally requires a trusted CI run and
artifact checksum, runtime isolation, and rollback testing.
"""
import io
import posixpath
import re
import sys
import tarfile
from pathlib import PurePosixPath

if len(sys.argv) != 3:
    raise SystemExit("Usage: inspect-standalone-runtime.py runtime.tar.gz <40-char-sha>")
filename, expected_sha = sys.argv[1:]
if not re.fullmatch(r"[a-f0-9]{40}", expected_sha):
    raise SystemExit("Invalid expected SHA")
required = {
    "meta/RELEASE_SHA",
    "meta/BUILD_TOOL_SHA",
    "api/dist/main.js",
    "api/package.json",
    "web/apps/web/server.js",
    "admin/apps/admin/server.js",
}
found = set()
with tarfile.open(filename, "r:gz") as archive:
    for member in archive:
        name = member.name
        clean = posixpath.normpath(name)
        if (not name or name.startswith("/") or clean in (".", "..")
                and name not in (".", "./")
                or clean.startswith("../") or "\\" in name
                or any(part == ".." for part in PurePosixPath(name).parts)):
            if name not in (".", "./"):
                raise SystemExit(f"Unsafe archive path: {name!r}")
        normalized = clean.removeprefix("./")
        if normalized == ".":
            continue
        if member.ischr() or member.isblk() or member.isfifo() or member.isdev():
            raise SystemExit(f"Disallowed archive file type: {name!r}")
        if member.issym() or member.islnk():
            if posixpath.isabs(member.linkname):
                raise SystemExit(f"Absolute archive link: {name!r}")
            target = posixpath.normpath(
                posixpath.join(posixpath.dirname(normalized), member.linkname)
                if member.issym() else member.linkname
            )
            if target.startswith("../") or target == "..":
                raise SystemExit(f"Escaping archive link: {name!r}")
        if (normalized.startswith(("api/", "web/apps/web/", "admin/apps/admin/"))
                and normalized.endswith(("/.env", "/.env.local"))):
            raise SystemExit(f"Unexpected runtime secret path: {name!r}")
        found.add(normalized)
    missing = required - found
    if missing:
        raise SystemExit(f"Missing required runtime files: {sorted(missing)}")
    sha_member = next(
        (item for item in archive.getmembers()
         if posixpath.normpath(item.name) == "meta/RELEASE_SHA"),
        None,
    )
    sha_data = archive.extractfile(sha_member) if sha_member and sha_member.isfile() else None
    if not sha_data or sha_data.read(120).decode().strip() != expected_sha:
        raise SystemExit("Embedded source SHA mismatch")
    if not any(p.startswith("web/apps/web/.next/static/") for p in found):
        raise SystemExit("Web static assets missing")
    if not any(p.startswith("admin/apps/admin/.next/static/") for p in found):
        raise SystemExit("Admin static assets missing")
    if not any(p.startswith("api/node_modules/") for p in found):
        raise SystemExit("API production dependencies missing")
print(f"Verified source-light runtime bundle for {expected_sha} ({len(found)} entries)")
