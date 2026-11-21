#!/usr/bin/env bash
# Stage an independently compiled GitHub artifact as a canary only.
# Does not change PM2, nginx, systemd, database, brokers or live symlinks.
set -Eeuo pipefail
[[ $# -eq 3 ]] || {
  echo "Usage: $0 <archive.tar.gz> <checksum-file> <40-character-source-sha>" >&2
  exit 2
}
archive="$(realpath -- "$1")"
checksum="$(realpath -- "$2")"
sha="$3"
[[ "$sha" =~ ^[a-f0-9]{40}$ ]] || exit 2
[[ -f "$archive" && -f "$checksum" && ! -L "$archive" && ! -L "$checksum" ]] || exit 2
stage_root="/home/lightworld/runtime/irexpro/candidates"
mkdir -p "$stage_root"
exec 9>"/home/lightworld/runtime/irexpro/.canary-stage.lock"
flock -n 9 || { echo "Another runtime stage operation is in progress" >&2; exit 3; }
# Only stage the currently deployed demo trading commit in this pilot.
active_sha="$(git -C /home/lightworld/webapps/irexpro-staging rev-parse HEAD)"
[[ "$sha" == "$active_sha" ]] || { echo "HOLD: artifact SHA does not match live trading commit" >&2; exit 3; }
(
  cd "$(dirname "$archive")"
  sha256sum --check "$(basename "$checksum")"
)
script_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
python3 "$script_root/inspect-standalone-runtime.py" "$archive" "$sha"
tool_sha="$(git -C "$script_root/../.." rev-parse --short HEAD)"
candidate="$stage_root/$sha-$tool_sha"
[[ ! -e "$candidate" ]] || { echo "Candidate already staged: $candidate"; exit 0; }
temp="$(mktemp -d "$stage_root/.extract.XXXXXXXX")"
cleanup() { if [[ -n "${temp:-}" && -d "$temp" ]]; then rm -rf -- "$temp"; fi; }
trap cleanup EXIT
tar -xzf "$archive" -C "$temp" --no-same-owner
test -f "$temp/meta/RELEASE_SHA"
test "$(cat "$temp/meta/RELEASE_SHA")" = "$sha"
test -f "$temp/services/ai-engine/app/main.py"
test -f "$temp/apps/api/scripts/audit-pepperstone-main-counter-virtual.cjs"
# Check AI and worker script syntax without importing modules or starting
# schedulers, broker connections, database writers, or trading executions.
node --check "$temp/apps/api/scripts/audit-pepperstone-main-counter-virtual.cjs"
IREXPRO_CANDIDATE_PATH="$temp" python3 - <<'PYTHON'
import ast, os, pathlib
root = pathlib.Path(os.environ['IREXPRO_CANDIDATE_PATH']) / 'services/ai-engine'
files = list(root.rglob('*.py'))
if not files:
    raise SystemExit('Missing Python AI source')
for source in files:
    ast.parse(source.read_text(encoding="utf-8-sig"), filename=str(source))
print(f'Checked {len(files)} Python AI source files')
PYTHON
# Smoke tests ONLY the independent Next.js web/admin servers; launching the
# real Nest trading API here could create a second execution scheduler.
bash "$script_root/smoke-standalone-runtime.sh" "$temp"
mv -- "$temp" "$candidate"
temp=""
echo "STAGED: $candidate"
echo "NO LIVE SWITCH: active PM2/AI trading processes unchanged."
