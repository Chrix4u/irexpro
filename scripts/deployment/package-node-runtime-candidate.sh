#!/usr/bin/env bash
# Hosted CI only: assemble relocatable Node runtime candidates from a clean build.
# Does not deploy, start an API connected to a broker, or certify ABI compatibility.
set -Eeuo pipefail
umask 077

[[ "${GITHUB_ACTIONS:-}" == true && "${RUNNER_ENVIRONMENT:-}" == github-hosted ]] || {
  echo 'Requires an ephemeral GitHub-hosted runner.' >&2
  exit 1
}
[[ "$#" == 2 && "$1" =~ ^[0-9a-f]{40}$ ]] || exit 2
sha="$1"
out="$2"
test "$(git rev-parse HEAD)" = "$sha"
test -n "${RUNNER_TEMP:-}"
test "$(dirname "$out")" = "$RUNNER_TEMP"
mkdir -m 700 "$out"
scratch="$(mktemp -d "$RUNNER_TEMP/irexpro-node.XXXXXXXX")"
pid=''
trap 'if [[ -n "$pid" ]]; then kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; fi; rm -rf -- "$scratch"' EXIT

# pnpm deploy materializes production dependencies independently of workspace links.
pnpm --filter @irexpro/api --prod deploy --legacy "$scratch/pruned"
mkdir "$scratch/api"
cp -a "$scratch/pruned/package.json" "$scratch/pruned/node_modules" "$scratch/api/"
cp -a apps/api/dist "$scratch/api/dist"
test -f "$scratch/api/dist/main.js"
test -f "$scratch/api/dist/database/data-source.js"

# Legacy pnpm deploy may hoist a self-reference to the original workspace
# package. Retarget only that exact, verified API alias to the assembled API
# root; leave every other link subject to the strict portability check below.
python3 - "$scratch" "$PWD/apps/api" <<'PY'
import json, os, pathlib, sys
scratch = pathlib.Path(sys.argv[1]).resolve()
source = pathlib.Path(sys.argv[2]).resolve(strict=True)
api = scratch / "api"
alias = api / "node_modules/.pnpm/node_modules/@irexpro/api"
if alias.is_symlink():
    original = scratch / "pruned/node_modules/.pnpm/node_modules/@irexpro/api"
    if not original.is_symlink():
        raise SystemExit("unexpected API self-link provenance")
    target = original.resolve(strict=True)
    if target not in (source, (scratch / "pruned").resolve()):
        raise SystemExit("unexpected API self-link target")
    for root in (target, api):
        if json.loads((root / "package.json").read_text()).get("name") != "@irexpro/api":
            raise SystemExit("unexpected API self-link package identity")
    alias.unlink()
    alias.symlink_to(os.path.relpath(api, alias.parent), target_is_directory=True)
    if alias.resolve(strict=True) != api.resolve(strict=True):
        raise SystemExit("API self-link normalization failed")
PY

# The standalone trace is rooted at the repository; copy static files explicitly.
for component in web admin; do
  source="apps/$component"
  destination="$scratch/$component"
  mkdir "$destination"
  cp -a "$source/.next/standalone/." "$destination/"
  test -f "$destination/apps/$component/server.js"
  mkdir -p "$destination/apps/$component/.next"
  cp -a "$source/.next/static" "$destination/apps/$component/.next/static"
  if [[ -d "$source/public" ]]; then
    cp -a "$source/public" "$destination/apps/$component/public"
  fi
done

# Reject dangling, absolute or escaping links; do not rely on the build checkout.
python3 - "$scratch" <<'PY'
import os, pathlib, sys
base = pathlib.Path(sys.argv[1])
for component in ("api", "web", "admin"):
    root = (base / component).resolve()
    for directory, dirs, files in os.walk(root, followlinks=False):
        for name in dirs + files:
            p = pathlib.Path(directory) / name
            if p.is_symlink():
                if os.path.isabs(os.readlink(p)):
                    raise SystemExit(f"absolute runtime symlink: {p.relative_to(root)}")
                target = p.resolve(strict=True)
                if not target.is_relative_to(root):
                    raise SystemExit(f"escaping runtime symlink: {p.relative_to(root)}")
            if p.name in {".env", ".env.local", ".env.production", ".env.production.local", ".npmrc"}:
                raise SystemExit(f"unexpected configuration file: {p.relative_to(root)}")
PY

# Smoke the native API dependency without starting the backend or using credentials.
(
  cd "$scratch/api"
  env -u NODE_PATH node -e 'require("argon2").hash("synthetic-ci-fixture").then(h=>{if(!h)process.exit(1)}).catch(e=>{console.error(e);process.exit(1)})'
  env -u NODE_PATH node -e 'require.resolve("@nestjs/core");require.resolve("typeorm");require.resolve("pg")'
)

# Run each frontend from the standalone artifact, not from the repository.
for component in web admin; do
  port=39051
  route=/login
  if [[ "$component" == admin ]]; then port=39052; route=/; fi
  (
    cd "$scratch/$component/apps/$component"
    exec env -u NODE_PATH HOSTNAME=127.0.0.1 PORT="$port" NODE_ENV=production node server.js
  ) >"$scratch/$component.log" 2>&1 &
  pid=$!
  ready=false
  for _ in $(seq 1 40); do
    if ! kill -0 "$pid" 2>/dev/null; then break; fi
    status="$(curl -sS --max-time 2 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port$route" 2>/dev/null || true)"
    if [[ "$status" == 200 || "$status" == 307 || "$status" == 308 ]]; then ready=true; break; fi
    sleep 1
  done
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  pid=''
  if [[ "$ready" != true ]]; then
    cat "$scratch/$component.log" >&2
    exit 1
  fi
done

for component in api web admin; do
  tar -C "$scratch/$component" -czf "$out/$component.tar.gz" .
done
printf '%s\n' "$sha" > "$out/SOURCE_SHA"
printf '%s\n' 'node-runtime-candidate-not-certified' > "$out/STATUS"
{
  uname -m
  getconf GNU_LIBC_VERSION
  node --version
  pnpm --version
} > "$out/BUILD_ABI"
(
  cd "$out"
  sha256sum api.tar.gz web.tar.gz admin.tar.gz SOURCE_SHA STATUS BUILD_ABI > SHA256SUMS
  sha256sum -c SHA256SUMS
)
