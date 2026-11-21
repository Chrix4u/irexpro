#!/usr/bin/env python3
"""Read-only Lightworld shared VPS disk monitor.

Usage:
  lightworld-storage-watch collect     # fast disk snapshot, bounded retention
  lightworld-storage-watch status      # latest snapshot
  lightworld-storage-watch inventory   # low-I/O, time-limited directory survey
No deletes, no release changes, no access to credentials, no network.
"""
import datetime as dt
import fcntl
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys
import time

STATE = Path("/var/lib/lightworld-storage-watch")
SNAPS = STATE / "snapshots"
LATEST = STATE / "latest.json"
INVENTORY = STATE / "inventory.json"
LOCK = STATE / ".lock"
MAX_SNAPS = 336  # seven days of half-hour samples

def disk():
    s = os.statvfs("/")
    block = s.f_frsize
    total = s.f_blocks * block
    used = (s.f_blocks - s.f_bfree) * block
    free = s.f_bavail * block
    denominator = used + free  # matches df use%; ext4 reserves count as unavailable
    return {
        "filesystem": "/",
        "total_gib": round(total / (1024**3), 2),
        "used_gib": round(used / (1024**3), 2),
        "available_gib": round(free / (1024**3), 2),
        "use_percent": math.ceil(used / denominator * 100) if denominator else 100,
        "inode_use_percent": round((s.f_files-s.f_ffree) / s.f_files * 100, 1)
            if s.f_files else None
    }

def build_count():
    count = 0
    indicators = (
        b"next build", b"pnpm build", b"pnpm install",
        b"npm install", b"npm run build", b"yarn build",
        b"vite build", b"turbo run build",
    )
    for item in os.scandir("/proc"):
        if not item.name.isdigit():
            continue
        try:
            # Read argv without presenting command lines or paths (secrets may occur).
            argv = (Path(item.path) / "cmdline").read_bytes().split(b"\x00")
            if not argv or not argv[0]:
                continue
            # An agent's bash/python command string can mention "pnpm build"
            # without running a compiler. Count only real build/install
            # executables, not shell, Python, grep, cron or this monitor.
            exe = os.path.basename(os.fsdecode(argv[0])).lower()
            if exe not in ("node", "bun", "npm", "pnpm", "yarn",
                           "next", "vite", "turbo", "npx"):
                continue
            raw = b" ".join(argv).lower()
            if any(i in raw for i in indicators):
                count += 1
        except (OSError, PermissionError):
            continue
    return count

def save_json(dest, obj):
    tmp = dest.with_name(dest.name + "." + str(os.getpid()) + ".tmp")
    try:
        with tmp.open("x", encoding="utf-8") as f:
            os.chmod(tmp, 0o600)
            json.dump(obj, f, indent=2, sort_keys=True)
            f.write("\n")
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, dest)
    finally:
        if tmp.exists():
            tmp.unlink()

def read_json(path):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None

def ensure_state():
    STATE.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(STATE, 0o700)
    SNAPS.mkdir(mode=0o700, exist_ok=True)
    os.chmod(SNAPS, 0o700)

def lock_state():
    f = LOCK.open("a+")
    fcntl.flock(f.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    return f

def collect():
    ensure_state()
    with lock_state():
        old = read_json(LATEST) or {}
        at = dt.datetime.now(dt.timezone.utc)
        data = {
            "captured_at_utc": at.isoformat(timespec="seconds"),
            "disk": disk(),
            "active_build_processes": build_count(),
            "advisory_only": True,
            "policy": "/home/lightworld/SHARED_VPS_DEPLOYMENT_POLICY_20261121.md",
        }
        if old.get("disk") and old.get("captured_at_utc"):
            try:
                old_time = dt.datetime.fromisoformat(old["captured_at_utc"])
                age_hr = (at - old_time).total_seconds() / 3600
                if 0 <= age_hr <= 4:
                    delta = round(data["disk"]["used_gib"] - old["disk"]["used_gib"], 2)
                    data["growth_since_previous_gib"] = delta
            except (ValueError, TypeError, KeyError):
                pass
        alerts = []
        if data["disk"]["use_percent"] >= 90:
            alerts.append("VPS disk at or above 90%; defer discretionary builds")
        if data["disk"]["available_gib"] <= 30:
            alerts.append("Free disk at or below 30 GiB")
        if data.get("growth_since_previous_gib", 0) >= 2:
            alerts.append("Disk grew 2 GiB or more since prior collection")
        data["alerts"] = alerts
        stamp = at.strftime("%Y%m%dT%H%M%SZ")
        save_json(SNAPS / (stamp + ".json"), data)
        save_json(LATEST, data)
        items = sorted(SNAPS.glob("*.json"))
        for item in items[:-MAX_SNAPS]:
            item.unlink()
        if alerts:
            subprocess.run(
                ["/usr/bin/logger", "-p", "user.warning", "-t", "lightworld-storage-watch",
                 "; ".join(alerts)], timeout=4, check=False)
        print(json.dumps(data, sort_keys=True))
        return 0

def status():
    obj = read_json(LATEST)
    if not obj:
        print("No inventory has been collected; use collect first.", file=sys.stderr)
        return 2
    print(json.dumps(obj, indent=2, sort_keys=True))
    if INVENTORY.is_file():
        inv = read_json(INVENTORY)
        if inv:
            print("Last deep survey UTC:", inv.get("captured_at_utc"))
            for item in inv.get("directories", [])[:18]:
                print(f"{item['gib']:7.2f} GiB  {item['path']}")
    return 0

def inventory():
    ensure_state()
    with lock_state():
        # The source directory set is fixed; do not descend into /var or
        # arbitrary mount points. Do not scan if another monitored build runs.
        if build_count():
            print("HOLD: installer/compiler currently running; defer expensive scan")
            return 10
        target = "/home/lightworld"
        cmd = ["/usr/bin/ionice", "-c3", "/usr/bin/nice", "-n19", "/usr/bin/du",
               "-x", "-m", "--max-depth=1", target]
        try:
            p = subprocess.run(cmd, text=True, capture_output=True, timeout=900,
                               check=False)
        except subprocess.TimeoutExpired:
            print("HOLD: disk inventory timed out; live services unaffected")
            return 10
        if p.returncode != 0:
            print("HOLD: directory survey failed; no partial results accepted")
            return 10
        dirs = []
        for line in p.stdout.splitlines():
            size, sep, path = line.partition("\t")
            if not sep or not size.isdigit():
                continue
            if path == target or not path.startswith(target + "/"):
                continue
            dirs.append({"path": path, "gib": round(int(size)/1024, 2)})
        dirs.sort(key=lambda x: x["gib"], reverse=True)
        data = {
            "captured_at_utc": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
            "root": target, "directories": dirs,
            "recovery_candidates_unverified": True,
            "note": "Sizes only; NEVER delete from this list without verifying owner, live process and rollback"
        }
        save_json(INVENTORY, data)
        print(json.dumps(data, indent=2))
        return 0

def main():
    if len(sys.argv) != 2 or sys.argv[1] not in ("collect", "status", "inventory"):
        print(__doc__)
        return 2
    if sys.argv[1] == "collect":
        return collect()
    if sys.argv[1] == "status":
        return status()
    return inventory()

if __name__ == "__main__":
    try:
        sys.exit(main())
    except BlockingIOError:
        print("HOLD: another storage-watch job owns the survey lock")
        sys.exit(10)
