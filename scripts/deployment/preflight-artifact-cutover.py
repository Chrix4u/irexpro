#!/usr/bin/env python3
"""Read-only iRexPro cutover preflight.

Never starts PM2, connects to a broker, accesses private environment values,
modifies symlinks, or executes database migrations. Report blockers clearly.
"""
from pathlib import Path
import json
import os
import subprocess
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: preflight-artifact-cutover.py /absolute/candidate-path")
candidate = Path(sys.argv[1]).resolve()
allowed = Path("/home/lightworld/runtime/irexpro/candidates").resolve()
if allowed not in candidate.parents or candidate == allowed:
    raise SystemExit("Candidate path must be inside the controlled iRexPro candidates folder")
staging = Path("/home/lightworld/webapps/irexpro-staging")
issues = []
checks = 0

def verify(description, good, blocker=None):
    global checks
    checks += 1
    print(("PASS" if good else "HOLD") + ": " + description, flush=True)
    if not good:
        issues.append(blocker or description)

def run(args, cwd=None):
    proc = subprocess.run(args, cwd=cwd, text=True,
                          stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                          timeout=20, check=False)
    return proc.returncode, proc.stdout.strip()

source_sha = (candidate / "meta/RELEASE_SHA").read_text().strip() if (candidate / "meta/RELEASE_SHA").is_file() else ""
rc, live_sha = run(["git", "-C", str(staging), "rev-parse", "HEAD"])
verify("Candidate exact source SHA matches running trading checkout",
       rc == 0 and bool(source_sha) and source_sha == live_sha)

for rel in [
    "api/dist/main.js",
    "apps/api/scripts/audit-pepperstone-main-counter-virtual.cjs",
    "services/ai-engine/app/main.py",
    "services/ai-engine/requirements.lock",
    "web/apps/web/server.js",
    "admin/apps/admin/server.js",
]:
    verify("Runtime entrypoint exists: " + rel, (candidate / rel).is_file())

rc, pm2_raw = run(["pm2", "jlist"])
try:
    processes = [p for p in json.loads(pm2_raw) if p.get("name", "").startswith("irexpro-")]
except (json.JSONDecodeError, TypeError):
    processes = []
verify("All 4 core PM2 services present and online",
       all(any(p["name"] == n and p.get("pm2_env", {}).get("status") == "online" for p in processes)
           for n in ("irexpro-api-staging", "irexpro-ai-staging",
                     "irexpro-web-staging", "irexpro-admin-staging")))
workers = [p for p in processes
           if "/apps/api/scripts/" in p.get("pm2_env", {}).get("pm_exec_path", "")]
verify("All 19 existing shadow-worker entrypoints are packaged",
       len(workers) == 19 and all(
           (candidate / "apps/api/scripts" / Path(p["pm2_env"]["pm_exec_path"]).name).is_file()
           for p in workers))

api = candidate / "api"
if api.is_dir():
    rc, text = run(["node", "-e", 'for (const x of ["@nestjs/core","typeorm","pg","argon2"]) require(x)'], cwd=api)
    verify("Production API and native module imports resolve", rc == 0)

# Secrets and persistent state must be symlinked to explicitly protected
# shared paths. Do not read their contents or print them.
shared = Path("/home/lightworld/runtime/irexpro/shared")
for name, rel in [
    ("API secret config", "env/api.env"),
    ("AI secret config", "env/ai.env"),
    ("AI Python environment", "python/ai-venv"),
    ("trading operational state", "var"),
]:
    verify(name + " externalized into protected shared storage", (shared / rel).exists())

verify("Current deployment pipeline no longer builds on live VPS",
       False, "Legacy VPS-build staging deployment still needs tested artifact-only replacement")
verify("Broker open-position and safe restart reconciliation completed",
       False, "Broker position reconciliation is mandatory before changing active API/AI workers")
print(f"RESULT: {checks} checks; {len(issues)} cutover blockers", flush=True)
for issue in issues:
    print(" - " + issue, flush=True)
if issues:
    sys.exit(10)
print("Eligible for a separately tested atomic cutover, not automatic promotion.")
