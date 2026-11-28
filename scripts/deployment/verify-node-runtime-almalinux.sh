#!/usr/bin/env bash
# Hosted, isolated ABI smoke. Not a production deployment or full release certification.
set -Eeuo pipefail
umask 077
[[ "${GITHUB_ACTIONS:-}" == true && "${RUNNER_ENVIRONMENT:-}" == github-hosted ]] || exit 1
[[ "$#" == 1 && -n "${RUNNER_TEMP:-}" ]] || exit 2
artifact="$(realpath "$1")"
[[ "$artifact" == "$RUNNER_TEMP/irexpro-node-runtime" ]] || exit 2
(
  cd "$artifact"
  sha256sum -c SHA256SUMS
)
scratch="$(mktemp -d "$RUNNER_TEMP/irexpro-abi.XXXXXXXX")"
trap 'rm -rf -- "$scratch"' EXIT
for component in api web admin; do
  mkdir "$scratch/$component"
  tar --no-same-owner -xzf "$artifact/$component.tar.gz" -C "$scratch/$component"
done
# Resolve the tag once, then run the exact downloaded image ID and record its digest.
# A versioned, digest-pinned release policy is still required for final certification.
image=docker.io/library/almalinux:9
docker pull "$image"
image_id="$(docker image inspect --format '{{.Id}}' "$image")"
image_digests="$(docker image inspect --format '{{json .RepoDigests}}' "$image")"
node_bin="$(realpath "$(command -v node)")"
{
  printf 'Image ID: %s\nImage digests: %s\n' "$image_id" "$image_digests"
  docker run --rm -i --network none --cap-drop ALL \
    --security-opt no-new-privileges --user "$(id -u):$(id -g)" \
    -v "$scratch:/candidate:rw" \
    -v "$node_bin:/usr/local/bin/node:ro" \
    -e HOME=/tmp -e NEXT_TELEMETRY_DISABLED=1 \
    "$image_id" /bin/bash -se <<'CONTAINER'
set -Eeuo pipefail
test "$(uname -m)" = x86_64
test "$(getconf GNU_LIBC_VERSION)" = "glibc 2.34"
getconf GNU_LIBC_VERSION
node --version
node -e 'if(process.versions.node.split(".")[0]!=="22") process.exit(1)'
cd /candidate/api
node -e 'require("argon2").hash("isolated-abi-fixture").then(h=>{if(!h)process.exit(1)}).catch(e=>{console.error(e);process.exit(1)})'
node -e 'require("@nestjs/core");require("typeorm");require("pg")'
test -f dist/database/data-source.js
# Check both standalone frontends without any database or broker connection.
pid=''
trap 'if [[ -n "$pid" ]]; then kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; fi' EXIT
for component in web admin; do
  cd "/candidate/$component/apps/$component"
  port=39051; route=/login
  if [[ "$component" == admin ]]; then port=39052; route=/; fi
  HOSTNAME=127.0.0.1 PORT="$port" NODE_ENV=production node server.js >/tmp/irexpro-$component.log 2>&1 &
  pid=$!
  if ! node - "$port" "$route" <<'NODE'
const [port, route] = process.argv.slice(2);
(async () => {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const response = await fetch('http://127.0.0.1:' + port + route, {
        redirect: 'manual', signal: AbortSignal.timeout(2000)
      });
      if ([200, 307, 308].includes(response.status)) {
        console.log('Standalone smoke HTTP ' + response.status + ' ' + route);
        await response.body?.cancel();
        return;
      }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
NODE
  then
    cat "/tmp/irexpro-$component.log" >&2
    exit 1
  fi
  kill "$pid"
  wait "$pid" || true
  pid=''
done
printf '%s\n' 'AlmaLinux 9 isolated Node runtime smoke PASS'
CONTAINER
} > "$artifact/TARGET_ABI_SMOKE" 2>&1 || {
  cat "$artifact/TARGET_ABI_SMOKE" >&2
  exit 1
}
cat "$artifact/TARGET_ABI_SMOKE"
(
  cd "$artifact"
  sha256sum TARGET_ABI_SMOKE >> SHA256SUMS
  sha256sum -c SHA256SUMS
)
