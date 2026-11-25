#!/usr/bin/env bash
# Verify the contents of a GitHub-compiled iRexPro release bundle before any staging transfer.
set -Eeuo pipefail
[[ $# -eq 2 ]] || { echo "Usage: $0 bundle.tar.gz <40-char-sha>" >&2; exit 2; }
bundle="$1"
expected_sha="$2"
[[ "$expected_sha" =~ ^[a-f0-9]{40}$ ]] || { echo "Invalid expected SHA" >&2; exit 2; }
[[ -f "$bundle" && ! -L "$bundle" ]] || { echo "Bundle missing or a symlink" >&2; exit 2; }
entries="$(tar -tzf "$bundle")"
while IFS= read -r entry; do
  [[ "$entry" == . || "$entry" == ./* ]] || { echo "Unsafe bundle path" >&2; exit 3; }
  [[ "$entry" != *../* && "$entry" != */.. && "$entry" != *//* ]] || { echo "Unsafe bundle traversal" >&2; exit 3; }
done <<< "$entries"
for required in ./RELEASE_SHA ./apps/api/dist/main.js ./apps/web/.next/BUILD_ID ./apps/admin/.next/BUILD_ID ./pnpm-lock.yaml; do
  grep -Fxq "$required" <<< "$entries" || { echo "Missing bundle content: $required" >&2; exit 4; }
done
actual_sha="$(tar -xzOf "$bundle" ./RELEASE_SHA | tr -d '\r\n')"
[[ "$actual_sha" == "$expected_sha" ]] || { echo "Release SHA mismatch" >&2; exit 5; }
echo "Verified compiled runtime bundle for $expected_sha"
