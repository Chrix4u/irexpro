#!/usr/bin/env python3
"""Read-only iRexPro cutover preflight.

Never starts PM2, connects to a broker, accesses private environment values,
modifies symlinks, or executes database migrations. Report blockers clearly.
"""
from pathlib import Path
import json
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

# No broker orders are sent. This gate examines the order/trade ledger in
# read-only mode, refusing promotion while unresolved orders remain.
if api.is_dir():
    ledger_script = Path(__file__).with_name("readonly-broker-cutover-audit.cjs")
    rc, _ = run(["node", str(ledger_script), str(api)])
    verify("Read-only order and trade ledger reconciled for restart",
           rc == 0,
           "Unresolved order or broker ledger state; run the read-only audit and independently verify broker-side positions")

# A snapshot alone is insufficient. The verified candidate must link to the
# protected shared storage, not carry a second stale copy of the credentials.
# Do not print or open secret contents in this read-only preflight.
shared = Path("/home/lightworld/runtime/irexpro/shared")
def linked_to(relative_path, shared_relative_path):
    link = candidate / relative_path
    shared_target = shared / shared_relative_path
    return (link.is_symlink() and shared_target.exists()
            and link.resolve() == shared_target.resolve())

for name, rel, target in [
    ("Candidate API secret config", "api/.env", "env/api.env"),
    ("Candidate API worker config", "apps/api/.env", "env/api.env"),
    ("Candidate AI secret config", "services/ai-engine/.env", "env/ai.env"),
    ("Candidate independent Python environment", "services/ai-engine/.venv", "python/ai-venv"),
    ("Candidate operational-state mount", "var", "var"),
]:
    verify(name + " points to protected shared storage", linked_to(rel, target))
verify("Live operational-state writers use shared storage (not a stale snapshot)",
       staging.joinpath("var").resolve() == shared.joinpath("var").resolve(),
       "Live trading state still writes to legacy path. Reconcile writes and switch atomically before retiring old runtime")

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
