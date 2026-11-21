#!/usr/bin/env bash
# Smoke-test a preverified extracted runtime without starting its trading API.
# Usage: smoke-standalone-runtime.sh /absolute/path/to/extracted-release
set -Eeuo pipefail
[[ $# -eq 1 && "$1" = /* ]] || { echo "Usage: $0 /absolute/release-root" >&2; exit 2; }
release="$1"
test -f "$release/meta/RELEASE_SHA"
test -f "$release/api/dist/main.js"
test -d "$release/api/node_modules/@nestjs/core"
test -f "$release/web/apps/web/server.js"
test -f "$release/admin/apps/admin/server.js"
web_port="${IREXPRO_CANARY_WEB_PORT:-4305}"
admin_port="${IREXPRO_CANARY_ADMIN_PORT:-4306}"
[[ "$web_port" =~ ^[0-9]{4,5}$ && "$admin_port" =~ ^[0-9]{4,5}$ ]]
[[ "$web_port" != "$admin_port" ]]
if command -v ss >/dev/null 2>&1; then
  for port in "$web_port" "$admin_port"; do
    if ss -ltnH "sport = :$port" | grep -q .; then
      echo "Canary TCP port $port already in use; refusing interference" >&2
      exit 3
    fi
  done
fi
logdir="$(mktemp -d /tmp/irexpro-standalone-smoke.XXXXXXXX)"
web_pid=""
admin_pid=""
finish() {
  local status=$?
  if [[ -n "$web_pid" ]]; then kill "$web_pid" 2>/dev/null || true; fi
  if [[ -n "$admin_pid" ]]; then kill "$admin_pid" 2>/dev/null || true; fi
  if [[ "$status" != 0 ]]; then
    echo "Web/admin canary failed. Last web/admin logs:" >&2
    tail -30 "$logdir/web.log" "$logdir/admin.log" >&2 || true
  fi
  rm -rf -- "$logdir"
  return "$status"
}
trap finish EXIT
(cd "$release/web/apps/web" && HOSTNAME=127.0.0.1 PORT="$web_port" NODE_ENV=production exec node server.js) > "$logdir/web.log" 2>&1 &
web_pid=$!
(cd "$release/admin/apps/admin" && HOSTNAME=127.0.0.1 PORT="$admin_port" NODE_ENV=production exec node server.js) > "$logdir/admin.log" 2>&1 &
admin_pid=$!
ready=false
for attempt in $(seq 1 40); do
  kill -0 "$web_pid" 2>/dev/null || { echo "Web canary exited" >&2; exit 4; }
  kill -0 "$admin_pid" 2>/dev/null || { echo "Admin canary exited" >&2; exit 4; }
  web_code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:$web_port/login" 2>/dev/null || true)"
  admin_code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:$admin_port/" 2>/dev/null || true)"
  if [[ "$web_code" == 200 && "$admin_code" =~ ^(200|302|303|307|308)$ ]]; then
    ready=true
    break
  fi
  sleep 2
done
[[ "$ready" == true ]] || { echo "Canary HTTP readiness failed after $attempt attempts: web=$web_code admin=$admin_code" >&2; exit 5; }
# Prove that the static Next assets were included in the extracted runtime,
# rather than being accidentally served from the original VPS source checkout.
page="$(curl -fsS --max-time 10 "http://127.0.0.1:$web_port/login")"
asset="$(printf '%s' "$page" | grep -oE '/_next/static/[^"]+' | head -n 1 || true)"
[[ -n "$asset" ]] || { echo "No Next static asset reference on login" >&2; exit 6; }
asset="${asset%%\?*}"
curl -fsS -o /dev/null --max-time 10 "http://127.0.0.1:$web_port$asset"
echo "PASS: isolated source-light runtime web=$web_code admin=$admin_code static=200 source=$(cat "$release/meta/RELEASE_SHA")"
