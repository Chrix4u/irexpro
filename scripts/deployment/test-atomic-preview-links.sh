#!/usr/bin/env bash
set -Eeuo pipefail
script="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/atomic-preview-links.sh"
root="$(mktemp -d /tmp/irexpro-preview-test.XXXXXXXX)"
trap 'rm -rf -- "$root"' EXIT
sha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
printf '%s\n' "$sha" > "$root/test-active-sha"
for c in b c; do
  toolsha="$(printf '%040d' 0 | tr 0 "$c")"
  candidate="$root/candidates/$sha-${toolsha:0:8}"
  mkdir -p "$candidate/meta" "$candidate/api/dist" "$candidate/web/apps/web" "$candidate/admin/apps/admin"
  printf '%s\n' "$sha" > "$candidate/meta/RELEASE_SHA"
  printf '%s\n' "$toolsha" > "$candidate/meta/BUILD_TOOL_SHA"
  touch "$candidate/api/dist/main.js" "$candidate/web/apps/web/server.js" "$candidate/admin/apps/admin/server.js"
done
b="$root/candidates/$sha-bbbbbbbb"
c="$root/candidates/$sha-cccccccc"
preview="$root/preview"
switch() { IREXPRO_PREVIEW_TEST_MODE=1 IREXPRO_PREVIEW_TEST_ROOT="$root" bash "$script" "$@"; }
switch activate "$b"
[[ "$(readlink -f "$preview/current")" == "$b" ]]
[[ ! -e "$preview/previous" ]]
switch activate "$c"
[[ "$(readlink -f "$preview/current")" == "$c" ]]
[[ "$(readlink -f "$preview/previous")" == "$b" ]]
switch rollback
[[ "$(readlink -f "$preview/current")" == "$b" ]]
[[ "$(readlink -f "$preview/previous")" == "$c" ]]
switch rollback
[[ "$(readlink -f "$preview/current")" == "$c" ]]
[[ "$(readlink -f "$preview/previous")" == "$b" ]]
if switch activate "$root/test-active-sha" >/dev/null 2>&1; then
  echo "FAIL: nonrelease target accepted" >&2
  exit 1
fi
[[ "$(readlink -f "$preview/current")" == "$c" ]]
echo "PASS: atomic pointer activate, promote, rollback, second rollback, and invalid-target hold"
