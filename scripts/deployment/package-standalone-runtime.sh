#!/usr/bin/env bash
# Build a source-light runtime release from a verified CI checkout.
# Environment: SOURCE_SHA, GITHUB_SHA (tooling), RUNTIME_BUNDLE_DEST
set -Eeuo pipefail
: "${SOURCE_SHA:?SOURCE_SHA required}"
: "${RUNTIME_BUNDLE_DEST:?RUNTIME_BUNDLE_DEST required}"
[[ "$SOURCE_SHA" =~ ^[a-f0-9]{40}$ ]] || exit 2
[[ "$RUNTIME_BUNDLE_DEST" = /* ]] || { echo 'Bundle destination must be absolute' >&2; exit 2; }
root="$RUNTIME_BUNDLE_DEST"
[[ ! -e "$root" ]] || { echo 'Bundle destination exists; refusing overwrite' >&2; exit 2; }
mkdir -p "$root"/{api,web,admin,meta}
[[ -f apps/api/dist/main.js ]]
for app in web admin; do
  test -f "apps/$app/.next/standalone/apps/$app/server.js"
  test -d "apps/$app/.next/static"
  cp -a "apps/$app/.next/standalone/." "$root/$app/"
  mkdir -p "$root/$app/apps/$app/.next"
  cp -a "apps/$app/.next/static" "$root/$app/apps/$app/.next/static"
  if test -d "apps/$app/public"; then
    cp -a "apps/$app/public" "$root/$app/apps/$app/public"
  fi
done
# pnpm deploy gathers the API's production dependencies and compiled output.
# This avoids copying the development node_modules tree with symlinks pointing
# back to the original source checkout.
rmdir "$root/api"
pnpm --filter @irexpro/api deploy --prod --legacy "$root/api"
test -f "$root/api/dist/main.js"
test -d "$root/api/node_modules/@nestjs/core"
# Legacy pnpm deploy may emit a virtual-store self-alias that points back to
# the repository checkout. That alias is not an API runtime dependency and
# must never be transported to the VPS.
self_alias="$root/api/node_modules/.pnpm/node_modules/@irexpro/api"
if [[ -L "$self_alias" ]]; then
  rm -- "$self_alias"
fi
# Declutter generated deploy output. Never remove the runtime scripts,
# migrations or AI data: they have separate lifecycle requirements.
rm -rf "$root/api/test" "$root/api/coverage" "$root/api/.git" "$root/api/node_modules/.cache"
printf '%s\n' "$SOURCE_SHA" > "$root/meta/RELEASE_SHA"
printf '%s\n' "${GITHUB_SHA:-unknown}" > "$root/meta/BUILD_TOOL_SHA"
cat > "$root/meta/RUNTIME_SCOPE" <<'EOF'
CI-built artifact: Next standalone web/admin and Nest API dependencies/dist.
NOT included: trading AI Python service, PM2 shadow workers, database, broker
secrets, model datasets, or schema migration execution. Never replace the live
deployment until these dependencies and isolated rollback are tested.
EOF
echo "Packaged source-light runtime for $SOURCE_SHA"
