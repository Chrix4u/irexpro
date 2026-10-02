#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="${1:-/home/lightworld/webapps/irexpro-staging}"

echo "== iRexPro host health =="
date -u '+UTC %Y-%m-%dT%H:%M:%SZ'
echo

echo "-- filesystem --"
df -h "$ROOT"
echo

echo "-- memory --"
free -h
echo

echo "-- load --"
uptime
echo
echo "-- application footprint (read-only) --"
for path in "$ROOT/apps" "$ROOT/node_modules" "$ROOT/.git" /home/lightworld/research; do
  if [[ -e "$path" ]]; then
    du -sh "$path" 2>/dev/null || true
  fi
done
echo

echo "-- largest top-level staging paths --"
du -x -h --max-depth=1 "$ROOT" 2>/dev/null | sort -h | tail -12 || true
echo

echo "-- PM2 --"
if command -v pm2 >/dev/null 2>&1; then
  pm2 jlist | node -e 'let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{for(const p of JSON.parse(s||"[]")) console.log([p.name,p.pm2_env?.status,"pid="+p.pid,"restarts="+(p.pm2_env?.restart_time??0)].join("\t"))})'
else
  echo "pm2 unavailable"
fi
echo
echo "-- safety note --"
echo "This report is read-only. Research datasets, model artifacts, untracked files and evidence are never deleted automatically."
