#!/usr/bin/env bash
# Bind an already verified, inactive iRexPro candidate to protected shared
# runtime paths. Never modifies the currently deployed trading checkout.
set -Eeuo pipefail
[[ "$#" == 1 ]] || { echo "Usage: $0 /absolute/candidate" >&2; exit 2; }
candidate="$(realpath -e -- "$1")"
root="/home/lightworld/runtime/irexpro/candidates"
shared="/home/lightworld/runtime/irexpro/shared"
staging="/home/lightworld/webapps/irexpro-staging"
[[ "$(dirname -- "$candidate")" == "$root" ]] || { echo "Candidate outside approved directory" >&2; exit 3; }
[[ -d "$candidate" && ! -L "$candidate" ]] || exit 3
[[ -d "$shared" && ! -L "$shared" ]] || exit 3
source_sha="$(cat "$candidate/meta/RELEASE_SHA")"
active_sha="$(git -C "$staging" rev-parse HEAD)"
[[ "$source_sha" == "$active_sha" ]] || { echo "Candidate does not match active trading source" >&2; exit 3; }
[[ "$(stat -c '%a' "$shared")" == "700" ]] || { echo "Protected shared directory has unexpected permissions" >&2; exit 3; }
for pair in "apps/api/.env:env/api.env" "api/.env:env/api.env" "services/ai-engine/.env:env/ai.env" "services/ai-engine/.venv:python/ai-venv" "var:var"; do
  rel="${pair%%:*}"
  shared_rel="${pair#*:}"
  target="$shared/$shared_rel"
  link="$candidate/$rel"
  [[ -e "$target" && ! -L "$target" ]] || { echo "Missing protected shared path: $shared_rel" >&2; exit 4; }
  [[ -d "$(dirname "$link")" ]] || { echo "Missing candidate directory for $rel" >&2; exit 4; }
  if [[ -L "$link" ]]; then
    [[ "$(readlink -f "$link")" == "$(realpath -e "$target")" ]] || { echo "Unexpected existing candidate link: $rel" >&2; exit 5; }
  elif [[ -e "$link" ]]; then
    echo "Unexpected candidate file prevents binding: $rel" >&2
    exit 5
  else
    ln -s "$target" "$link"
  fi
  echo "Bound candidate runtime path: $rel"
done
# The credential copies must still be byte-identical to live configuration.
cmp -s "$staging/apps/api/.env" "$shared/env/api.env" || { echo "API credential copy drifted; HOLD" >&2; exit 6; }
cmp -s "$staging/services/ai-engine/.env" "$shared/env/ai.env" || { echo "AI credential copy drifted; HOLD" >&2; exit 6; }
[[ "$(stat -c '%a' "$shared/env/api.env")" == "600" ]]
[[ "$(stat -c '%a' "$shared/env/ai.env")" == "600" ]]
[[ -x "$candidate/services/ai-engine/.venv/bin/python" ]]
echo "Prepared candidate shared mounts (no live process restart or data writer switch)."
