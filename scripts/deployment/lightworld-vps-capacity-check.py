#!/usr/bin/env python3
"""Shared Lightworld VPS capacity preflight.

Advisory read-only capacity policy. No cleanup, service restart, deployments,
network access or changes to other projects. Exit 10 = HOLD.
Usage: lightworld-vps-capacity-check inspect
       lightworld-vps-capacity-check build
       lightworld-vps-capacity-check artifact <compressed_size_mib>
"""
import json
import math
import os
import sys
from pathlib import Path

MIN_MIB = 30 * 1024
ARTIFACT_FIXED_RESERVE_MIB = 8 * 1024
def usage():
    print(__doc__, file=sys.stderr)
    return 2

def snapshot(path="/"):
    s=os.statvfs(path)
    block=s.f_frsize
    capacity=s.f_blocks * block
    available=s.f_bavail * block
    # Match df Use% (used / (used + available)) including reserved blocks.
    used_bytes=(s.f_blocks-s.f_bfree)*block
    used_pct=100*used_bytes/(used_bytes+available)
    busy=[]
    for proc in os.scandir("/proc"):
        if not proc.name.isdecimal(): continue
        try:
            raw=(Path(proc.path)/"cmdline").read_bytes().replace(b"\\0",b" ").decode("utf-8","replace").lower()
        except (OSError,ValueError,PermissionError):
            continue
        # Count only known compiler/install command signatures; don't print args,
        # paths or secrets from process arguments.
        if any(sig in raw for sig in ("next build", "pnpm install", "npm install", "pnpm build", "yarn build", "turbo run build", "vite build")):
            if "lightworld-vps-capacity-check" not in raw:
                busy.append(proc.name)
    return {
        "disk_capacity_gib": round(capacity/(1024**3),1),
        "disk_available_gib": round(available/(1024**3),1),
        "disk_used_percent": math.ceil(used_pct),
        "active_build_process_count":len(busy),
    }, available/(1024**2), math.ceil(used_pct), len(busy)

def decide(mode, requested_mib, available_mib, used_pct, busy):
    blockers=[]
    if mode=="build":
        if used_pct >= 90.0: blockers.append("VPS root storage is at or above 90%; build in GitHub Actions instead")
        if available_mib <= MIN_MIB: blockers.append("VPS has <=30 GiB free; discretionary VPS compilation is blocked")
        if busy: blockers.append("Other dependency installs or builds are active; coordinate before starting more")
    elif mode=="artifact":
        if requested_mib > 0:
            minimum=ARTIFACT_FIXED_RESERVE_MIB+requested_mib*4
            if available_mib < minimum:
                blockers.append("Insufficient temporary extraction headroom above 8 GiB reserve")
        if requested_mib <= 0: blockers.append("Explicit positive artifact compressed size required")
    return blockers

def main(argv):
    if len(argv)<2 or argv[1] not in ("inspect","build","artifact"):
        return usage()
    mode=argv[1]
    if (mode in ("inspect","build") and len(argv)!=2) or (mode=="artifact" and len(argv)!=3):
        return usage()
    artifact=0
    if mode=="artifact":
        try: artifact=int(argv[2])
        except ValueError: return usage()
        if not 1<=artifact<=2_000_000: return usage()
    data, available, used, busy = snapshot()
    problems=decide(mode,artifact,available,used,busy)
    data.update({"purpose":mode,"allowed":not problems,"hold_reasons":problems,
                 "policy_path":"/home/lightworld/SHARED_VPS_DEPLOYMENT_POLICY_20261121.md"})
    if artifact: data["artifact_compressed_mib"]=artifact
    print(json.dumps(data,sort_keys=True))
    return 10 if problems else 0

if __name__=="__main__":
    sys.exit(main(sys.argv))
