#!/usr/bin/env bash
# Fetch a successful GitHub Actions source-light runtime and stage it as a
# localhost-only candidate. Does not switch Nginx, PM2, API or trading engines.
set -Eeuo pipefail
[[ $# -eq 2 ]] || { echo "Usage: $0 <GitHub Actions run ID> <exact source SHA>" >&2; exit 2; }
run_id="$1"
sha="$2"
[[ "$run_id" =~ ^[0-9]{7,15}$ ]] || { echo "Invalid run ID" >&2; exit 2; }
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo "Invalid commit SHA" >&2; exit 2; }
repo="Chrix4u/irexpro"
tool_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
for required in gh jq sha256sum; do
  command -v "$required" >/dev/null || { echo "Missing verified CLI: $required" >&2; exit 2; }
done
# Inspect the authenticated GitHub Actions run rather than an arbitrary URL.
metadata="$(gh api "repos/$repo/actions/runs/$run_id")"
run_status="$(jq -r '.status' <<< "$metadata")"
run_conclusion="$(jq -r '.conclusion' <<< "$metadata")"
run_name="$(jq -r '.name' <<< "$metadata")"
run_branch="$(jq -r '.head_branch' <<< "$metadata")"
run_event="$(jq -r '.event' <<< "$metadata")"
[[ "$run_status" == "completed" && "$run_conclusion" == "success" ]] || { echo "CI run did not succeed" >&2; exit 3; }
[[ "$run_name" == "iRexPro Isolated Standalone Runtime Canary" ]] || { echo "Unexpected workflow" >&2; exit 3; }
[[ "$run_branch" == "ops/github-first-vps-storage-20261121" ]] || { echo "Unexpected builder branch" >&2; exit 3; }
[[ "$run_event" == "push" || "$run_event" == "workflow_dispatch" ]] || { echo "Unsupported workflow event" >&2; exit 3; }
live_sha="$(git -C /home/lightworld/webapps/irexpro-staging rev-parse HEAD)"
[[ "$sha" == "$live_sha" ]] || { echo "Refusing candidate for different trading source" >&2; exit 3; }
umask 077
temp="$(mktemp -d /tmp/irexpro-release-from-github.XXXXXXXX)"
cleanup() { rm -rf -- "$temp"; }
trap cleanup EXIT
artifact="irexpro-standalone-$sha"
gh run download "$run_id" -R "$repo" -n "$artifact" -D "$temp"
(
  cd "$temp"
  sha256sum -c irexpro-standalone-runtime.tar.gz.sha256
)
bash "$tool_dir/stage-standalone-canary.sh" "$temp/irexpro-standalone-runtime.tar.gz" "$temp/irexpro-standalone-runtime.tar.gz.sha256" "$sha"
tool_sha="$(tar -xzOf "$temp/irexpro-standalone-runtime.tar.gz" ./meta/BUILD_TOOL_SHA | tr -d '\r\n')"
[[ "$tool_sha" =~ ^[0-9a-f]{40}$ ]] || exit 4
candidate="/home/lightworld/runtime/irexpro/candidates/$sha-${tool_sha:0:8}"
test -d "$candidate" || { echo "Expected candidate directory missing" >&2; exit 4; }
bash "$tool_dir/bind-shared-runtime.sh" "$candidate"
echo "GitHub-built candidate verified and staged locally, without switching public trading services: $candidate"
if python3 "$tool_dir/preflight-artifact-cutover.py" "$candidate"; then
  echo "Preflight passed. Cutover remains a separate explicit operation."
else
  code="$?"
  if [[ "$code" != 10 ]]; then
    echo "Unexpected preflight failure ($code)" >&2
    exit "$code"
  fi
  echo "Preflight HOLD: required safety gates remain; current trading services unchanged."
fi
