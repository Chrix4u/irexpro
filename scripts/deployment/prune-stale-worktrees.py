#!/usr/bin/env python3
"""Conservative, remote-verified iRexPro stale worktree removal.

Run as dry-run first. Apply removes only clean, unused, pushed worktrees.
Does not remove branches, model directories, database files, or active worktrees.
"""
import os
import sys
import subprocess
from pathlib import Path
import time
REPO = "/home/lightworld/webapps/irexpro-staging"
PARENT = Path(sys.argv[3]) if len(sys.argv)>3 else Path("/home/lightworld/webapps/irexpro-worktrees")
if str(PARENT) not in ["/home/lightworld/webapps/irexpro-worktrees","/home/lightworld/webapps/irexpro-staging/.worktrees","/home/lightworld/dev"]:
    raise SystemExit("Unsafe target root")
MODE = sys.argv[1] if len(sys.argv) > 1 else "dry-run"
if MODE not in ("dry-run", "apply"):
    raise SystemExit("Mode must be dry-run or apply")
LIMIT = int(sys.argv[2]) if len(sys.argv) > 2 else 20
CUTOFF = time.time() - (14 * 24 * 3600)
def run(cmd, seconds=8):
    try:
        p = subprocess.run(cmd, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=seconds)
        return p.returncode, p.stdout
    except (subprocess.TimeoutExpired, OSError):
        return 124, ""
def active_paths():
    data = []
    for pid in os.listdir("/proc"):
        if not pid.isdigit():
            continue
        root = "/proc/" + pid + "/"
        try:
            data.append(Path(root+"cmdline").read_bytes().replace(b"\0", b" ").decode(errors="ignore"))
        except (OSError, ValueError): pass
        try:
            data.append(os.readlink(root+"cwd"))
        except OSError: pass
    return data
def git_worktrees():
    code, out = run(["git", "-C", REPO, "worktree", "list", "--porcelain"], 20)
    if code: raise RuntimeError("cannot enumerate worktrees")
    entries=[]
    for b in out.strip().split("\n\n"):
        lines=b.splitlines()
        if not lines or not lines[0].startswith("worktree "): continue
        d=dict(line.split(" ",1) for line in lines if " " in line)
        entries.append(d)
    return entries
code, refs = run(["git", "-C", REPO, "ls-remote", "--heads", "origin"], 40)
if code: raise RuntimeError("cannot verify remote GitHub branches")
remote = dict((ref,sha) for sha,ref in (line.split("\t") for line in refs.splitlines() if "\t" in line))
running = active_paths()
seen=eligible=changed=0
for w in git_worktrees():
    p=Path(w["worktree"])
    if p.parent != PARENT or not p.is_dir() or not (p/".git").is_file(): continue
    seen+=1
    if p.stat().st_mtime > CUTOFF: continue
    if any(str(p)+"/" in x or str(p)+" " in x for x in running): continue
    branch = w.get("branch", "")
    sha = w.get("HEAD", "")
    remote_sha=remote.get(branch)
    if remote_sha != sha:
        code,_=run(["git","-C",REPO,"merge-base","--is-ancestor",sha,"origin/main"],5)
        if code: continue
    code,dirty=run(["git","-C",str(p),"status","--porcelain","--untracked-files=all"],7)
    if code or dirty.strip(): continue
    code,ignored=run(["git","-C",str(p),"clean","-ndX"],7)
    if code: continue
    allowed = {"node_modules", "dist", ".next", ".turbo", ".cache", "__pycache__", ".pytest_cache", ".pnpm-store", "build"}
    safe_ignored = True
    for line in ignored.splitlines():
        if not line.startswith("Would remove "):
            safe_ignored = False
            break
        rel = line[len("Would remove "):].rstrip("/")
        parts = rel.split("/")
        if not (any(part in allowed for part in parts) or rel.endswith(".tsbuildinfo")):
            safe_ignored = False
            break
    if not safe_ignored: continue
    # Also explicitly reject any sensitive or generated local file if accidentally nonignored.
    code,unsafe=run(["find",str(p),"-maxdepth","5","-type","f","(","-name","*.sqlite","-o","-name","*.db","-o","-name","*.parquet","-o","-name","*.pkl","-o","-name","*.joblib","-o","-name",".env","-o","-name",".env.local",")","-print","-quit"],5)
    if code or unsafe.strip(): continue
    eligible+=1
    if MODE=="apply" and changed<LIMIT:
        code,_=run(["git","-C",REPO,"worktree","remove",str(p)],30)
        if code==0:
            changed+=1
            print("REMOVED",p,sha[:12],flush=True)
        else:
            print("SKIPPED_REMOVE_FAILED",p,flush=True)
    elif eligible<=LIMIT:
        print("ELIGIBLE",p,sha[:12],flush=True)
print("SUMMARY mode=%s inspected=%d eligible=%d removed=%d limit=%d" % (MODE,seen,eligible,changed,LIMIT),flush=True)
