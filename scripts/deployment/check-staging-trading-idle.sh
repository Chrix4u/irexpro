#!/usr/bin/env bash
# Fail-closed staging deploy preflight. Never modify trading state, SQL rows,
# credential files, broker settings, or any PM2 processes.
set -Eeuo pipefail
umask 077

fail() {
  printf 'CD HOLD: trading state is not safely idle; staging deployment is blocked. %s\n' "$1" >&2
  exit 38
}

[[ "${STAGING_ROOT:-}" = /* ]] || fail "No absolute staging root was provided."
env_file="$STAGING_ROOT/apps/api/.env"
[[ -f "$env_file" ]] || fail "Staging database configuration is unavailable."
command -v psql >/dev/null 2>&1 || fail "PostgreSQL read-only verifier is unavailable."

# Locally sourced staging configuration, never printed or embedded in logs.
# Same trusted .env already used for API launches. Fail closed on bad values.
(
  set +u
  # shellcheck disable=SC1090
  . "$env_file" >/dev/null 2>&1 || fail "Database configuration could not be loaded."
  set -u

  [[ -n "${DB_HOST:-}" && -n "${DB_USER:-}" && -n "${DB_PASSWORD:-}" ]] ||
    fail "Database host, user, or password is missing."
  db_name="${DB_NAME:-${DB_DATABASE:-}}"
  [[ -n "$db_name" ]] || fail "Database name is missing."
  db_port="${DB_PORT:-5432}"
  [[ "$db_port" =~ ^[0-9]+$ ]] || fail "Database port is malformed."

  # READ ONLY and complete once per invocation. A failed query, unavailable
  # database or uncertain broker state must NEVER be interpreted as idle.
  result=""
  if ! result="$(PGPASSWORD="$DB_PASSWORD" PGCONNECT_TIMEOUT=5 psql \
    -X -q -At -v ON_ERROR_STOP=1 -h "$DB_HOST" -p "$db_port" \
    -U "$DB_USER" -d "$db_name" <<'SQL'
BEGIN READ ONLY;
SELECT CASE
  WHEN EXISTS (
    SELECT 1 FROM trading.trading_sessions
    WHERE ended_at IS NULL
  ) THEN 'ACTIVE_AI_SESSION'
  WHEN EXISTS (
    SELECT 1 FROM trading.trades
    WHERE status IN ('PENDING', 'OPEN', 'RECONCILIATION_PENDING')
  ) THEN 'OPEN_OR_UNRESOLVED_TRADE'
  ELSE 'IDLE'
END;
ROLLBACK;
SQL
  )"; then
    fail "Read-only database state check failed."
  fi

  case "$result" in
    IDLE)
      printf 'STAGING TRADING PREFLIGHT: no active AI sessions or unresolved trades.\n'
      ;;
    ACTIVE_AI_SESSION|OPEN_OR_UNRESOLVED_TRADE)
      fail "$result"
      ;;
    *)
      fail "Trading state query returned an unrecognized result."
      ;;
  esac
)
