#!/usr/bin/env python3
"""Add a reviewed standalone-only Next.js build overlay to a clean GitHub CI checkout.

The checkout remains pinned to the exact trading commit. This changes only the
Next.js output/tracing settings in the ephemeral build runner, not the VPS or
the strategy source in GitHub.
"""
from pathlib import Path
import sys

repo = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path.cwd()
for app in ("web", "admin"):
    target = repo / "apps" / app / "next.config.mjs"
    raw = target.read_text()
    anchor = "const nextConfig = {\n"
    if raw.count(anchor) != 1:
        raise SystemExit(f"Unexpected Next.js config layout: {target}")
    if "outputFileTracingRoot:" in raw or "output: 'standalone'" in raw:
        raise SystemExit(f"Standalone build overlay already applied: {target}")
    # file URL pathname is the filesystem path on the Linux GitHub runner
    settings = ("const nextConfig = {\n"
                "  output: 'standalone',\n"
                "  outputFileTracingRoot: new URL('../../', import.meta.url).pathname,\n")
    target.write_text(raw.replace(anchor, settings, 1))
    print(f"Prepared standalone CI build for {app} (source commit unchanged)")
