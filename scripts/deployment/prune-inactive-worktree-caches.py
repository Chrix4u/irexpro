#!/usr/bin/env python3
"""Remove only verified, ignored generated caches in inactive old iRexPro worktrees.

Never remove source files, the worktrees themselves, models, broker state, or
the active staging deployment. Dry-run is default. Applied deletions are
confined to node_modules/.next/.turbo within >=14-day-old git worktrees.
"""
import os
import sys
import time
import subprocess
from pathlib import Path

REPO=Path("/home/lightworld/webapps/irexpro-staging")
ROOTS=(
    Path("/home/lightworld/webapps/irexpro-staging/.worktrees"),
    Path("/home/lightworld/webapps/irexpro-worktrees"),
    Path("/home/lightworld/dev"),
)
RELATIVE_CACHES=(
    "apps/web/.next",
    "apps/admin/.next",
    "apps/web/node_modules",
    "apps/admin/node_modules",
    "apps/api/node_modules",
    "apps/mobile/node_modules",
    "node_modules",
    "packages/types/node_modules",
    "packages/api-client/node_modules",
    ".turbo",
)
MODE=sys.argv[1] if len(sys.argv)>1 else "dry-run"
LIMIT=int(sys.argv[2]) if len(sys.argv)>2 else 15
if MODE not in ("dry-run","apply") or not 1 <= LIMIT <= 150:
    raise SystemExit("Usage: prune-inactive-irexpro-caches.py dry-run|apply [1..150]")
CUTOFF=time.time()-14*86400
def call(argv,timeout=15):
    try:
        p=subprocess.run(argv,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,timeout=timeout)
        return p.returncode,p.stdout
    except (subprocess.TimeoutExpired,OSError):
        return 124,""
rc,out=call(["git","-C",str(REPO),"worktree","list","--porcelain"],20)
if rc:
    raise SystemExit("Cannot enumerate iRexPro worktrees; no changes")
entries=[]
for chunk in out.strip().split("\n\n"):
    if not chunk.startswith("worktree "):
        continue
    line=chunk.splitlines()[0]
    entries.append(Path(line[len("worktree "):]))
def active_worktree_paths():
    active=[]
    for item in os.scandir("/proc"):
        if not item.name.isdigit():
            continue
        root="/proc/"+item.name
        try:
            active.append(Path(root+"/cmdline").read_bytes().replace(b"\0",b" ").decode(errors="replace"))
        except (OSError,ValueError): pass
        try:
            active.append(os.readlink(root+"/cwd"))
        except OSError: pass
    return active
active=active_worktree_paths()
safe_roots=[p.resolve() for p in ROOTS]
eligible_worktrees=0
candidate_folders=0
removed=0
for w in entries:
    if eligible_worktrees >= LIMIT:
        break
    try:
        if w.parent not in ROOTS or w.is_symlink() or not w.is_dir() or not (w/".git").is_file():
            continue
        if w.stat().st_mtime > CUTOFF:
            continue
        if any(str(w)+"/" in cmd or str(w)+" " in cmd for cmd in active):
            continue
    except OSError:
        continue
    cache=[]
    for rel in RELATIVE_CACHES:
        p=w/rel
        if p.is_symlink() or not p.is_dir():
            continue
        if not p.resolve().is_relative_to(w.resolve()):
            continue
        # The repository itself must classify the path as ignored.
        rc,_=call(["git","-C",str(w),"check-ignore","-q", "--",rel],6)
        if rc!=0:
            continue
        cache.append(p)
    if not cache:
        continue
    eligible_worktrees += 1
    candidate_folders += len(cache)
    print(("APPLY" if MODE=="apply" else "ELIGIBLE"),
          w.name,"generated_folders",len(cache),flush=True)
    if MODE=="apply":
        for p in cache:
            if p.is_symlink() or not p.is_dir():
                raise SystemExit("Unexpected cache change; stopping")
            rc,_=call(["rm","-rf","--one-file-system","--",str(p)],180)
            if rc:
                print("SKIPPED FAILED",p,flush=True)
            else:
                removed+=1
print(f"SUMMARY mode={MODE} eligible_worktrees={eligible_worktrees} "
      f"generated_folders={candidate_folders} removed_folders={removed} "
      f"limit={LIMIT}",flush=True)
