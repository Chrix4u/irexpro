#!/usr/bin/env bash
# Hermetic unit tests for the fail-closed staging deployment gate.
set -Eeuo pipefail
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin" "$tmp/apps/api"
cat > "$tmp/apps/api/.env" <<'ENV'
DB_HOST=127.0.0.1
DB_PORT=5432
DB_USER=test
DB_PASSWORD=test_password_only
DB_NAME=test_schema
ENV
cat > "$tmp/bin/psql" <<'MOCK'
#!/usr/bin/env bash
cat > "$MOCK_SQL_OUTPUT"
case "${MOCK_PSQL_RESULT:-}" in
  IDLE) echo IDLE ;;
  ACTIVE_AI_SESSION) echo ACTIVE_AI_SESSION ;;
  OPEN_OR_UNRESOLVED_TRADE) echo OPEN_OR_UNRESOLVED_TRADE ;;
  BAD_OUTPUT) echo GUESSED_IDLE ;;
  FAILED) exit 1 ;;
  *) exit 2 ;;
esac
MOCK
chmod 700 "$tmp/bin/psql"
script="$(cd "$(dirname "$0")" && pwd)/check-staging-trading-idle.sh"
export PATH="$tmp/bin:$PATH" STAGING_ROOT="$tmp" MOCK_SQL_OUTPUT="$tmp/query.sql"

MOCK_PSQL_RESULT=IDLE bash "$script" >/dev/null
grep -Fq 'BEGIN READ ONLY' "$tmp/query.sql"
grep -Fq 'trading.trading_sessions' "$tmp/query.sql"
grep -Fq 'ended_at IS NULL' "$tmp/query.sql"
grep -Fq 'trading.trades' "$tmp/query.sql"
grep -Fq 'RECONCILIATION_PENDING' "$tmp/query.sql"
grep -Fq 'ROLLBACK' "$tmp/query.sql"

for state in ACTIVE_AI_SESSION OPEN_OR_UNRESOLVED_TRADE BAD_OUTPUT FAILED; do
  if MOCK_PSQL_RESULT="$state" bash "$script" >/dev/null 2>"$tmp/err"; then
    echo "UNSAFE DEPLOYMENT ALLOWED: $state" >&2
    exit 1
  fi
  grep -Fq 'CD HOLD:' "$tmp/err"
done

mv "$tmp/apps/api/.env" "$tmp/missing.env"
if MOCK_PSQL_RESULT=IDLE bash "$script" >/dev/null 2>"$tmp/err"; then
  echo 'UNSAFE DEPLOYMENT ALLOWED: missing DB configuration' >&2
  exit 1
fi
grep -Fq 'CD HOLD:' "$tmp/err"

printf 'PASS: staging idle gate permits only verified flat/stopped broker state (6 assertions).\n'
