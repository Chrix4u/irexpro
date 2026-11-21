#!/usr/bin/env bash
# Atomic release-pointer rehearsal ONLY. Never modifies production PM2,
# the public web root, broker configuration, or the live staging checkout.
set -Eeuo pipefail
[[ $# -ge 1 && $# -le 2 ]] || { echo "Usage: $0 activate <candidate> | rollback" >&2; exit 2; }
mode="$1"
[[ "$mode" == "activate" || "$mode" == "rollback" ]] || exit 2
root="/home/lightworld/runtime/irexpro"
if [[ "${IREXPRO_PREVIEW_TEST_ROOT:-}" != "" ]]; then
  [[ "${IREXPRO_PREVIEW_TEST_MODE:-}" == "1" ]] || exit 3
  [[ "$IREXPRO_PREVIEW_TEST_ROOT" =~ ^/tmp/irexpro-preview-test\.[A-Za-z0-9]+$ ]] || exit 3
  root="$IREXPRO_PREVIEW_TEST_ROOT"
  expected_sha="$(cat "$root/test-active-sha")"
else
  expected_sha="$(git -C /home/lightworld/webapps/irexpro-staging rev-parse HEAD)"
fi
[[ "$expected_sha" =~ ^[0-9a-f]{40}$ ]] || exit 3
candidates="$root/candidates"
preview="$root/preview"
install -d -m 0700 "$preview"
exec 9>"$preview/.release-pointer.lock"
flock -n 9 || { echo "Preview pointer update already in progress" >&2; exit 3; }
valid_candidate() {
  local name="$1" sha tailsha toolsha
  [[ -d "$name" && ! -L "$name" ]] || return 1
  [[ "$(dirname -- "$name")" == "$candidates" ]] || return 1
  sha="$(cat "$name/meta/RELEASE_SHA" 2>/dev/null)" || return 1
  toolsha="$(cat "$name/meta/BUILD_TOOL_SHA" 2>/dev/null)" || return 1
  [[ "$sha" == "$expected_sha" && "$toolsha" =~ ^[a-f0-9]{40}$ ]] || return 1
  tailsha="${toolsha:0:8}"
  [[ "$(basename -- "$name")" == "$sha-$tailsha" ]] || return 1
  [[ -f "$name/api/dist/main.js" && -f "$name/web/apps/web/server.js" && -f "$name/admin/apps/admin/server.js" ]] || return 1
}
put_link() {
  local name="$1" dest="$2" temp
  temp="$preview/.$name.$$.$RANDOM.tmp"
  ln -s -- "$dest" "$temp"
  mv -Tf -- "$temp" "$preview/$name"
}
resolve_link() {
  local link="$preview/$1" real
  [[ -L "$link" ]] || return 1
  real="$(readlink -f -- "$link")" || return 1
  valid_candidate "$real" || return 1
  printf '%s\n' "$real"
}
if [[ "$mode" == "activate" ]]; then
  [[ $# -eq 2 ]] || exit 2
  target="$(realpath -e -- "$2")"
  valid_candidate "$target" || { echo "Invalid preview release; refusing activation" >&2; exit 4; }
  if [[ -L "$preview/current" ]]; then
    former="$(resolve_link current)" || { echo "Current preview pointer invalid" >&2; exit 4; }
    [[ "$former" == "$target" ]] && { echo "Preview pointer already points to verified candidate"; exit 0; }
    put_link previous "$former"
  elif [[ -e "$preview/current" ]]; then
    echo "Preview current is not a symlink" >&2
    exit 4
  fi
  put_link current "$target"
  echo "PREVIEW activated $(basename -- "$target"); no production traffic changed."
else
  [[ $# -eq 1 ]] || exit 2
  current="$(resolve_link current)" || { echo "No valid current preview release" >&2; exit 4; }
  previous="$(resolve_link previous)" || { echo "No verified previous preview release" >&2; exit 4; }
  put_link current "$previous"
  put_link previous "$current"
  echo "PREVIEW rollback to $(basename -- "$previous"); production unchanged."
fi
