#!/usr/bin/env bash
# PRIVATE READ-ONLY cTrader DEMO outcome audit. Never connects to broker or trains models.
set -Eeuo pipefail
umask 077
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
python_bin="$repo/services/ai-engine/.venv/bin/python"
api_env="$repo/apps/api/.env"
sql="$repo/services/ai-engine/app/domain/training/demo_rejected_entry_outcomes_readonly.sql"
research_dir="/home/lightworld/webapps/irexpro-research/admission-rejected-shadow"
[[ -x "$python_bin" && -r "$api_env" && -r "$sql" ]] || { echo 'Research prerequisites unavailable' >&2; exit 1; }
# Python-dotenv parses the private env safely: no shell execution and no unbounded env export.
while IFS= read -r -d '' item; do
  export "$item"
done < <("$python_bin" - "$api_env" <<'PY'
from dotenv import dotenv_values
import sys
values = dotenv_values(sys.argv[1])
for key in (
    "VPS_FOREX_SCANNER_USER_ID",
    "M1_TACTICAL_MARKET_DATA_CONNECTION_ID",
    "DB_HOST",
    "DB_PORT",
    "DB_USER",
    "DB_PASSWORD",
    "DB_NAME",
    "DB_DATABASE",
):
    value = values.get(key)
    if value is not None:
        sys.stdout.buffer.write(f"{key}={value}".encode() + b"\0")
PY
)
db_name="${DB_NAME:-${DB_DATABASE:-}}"
[[ -n "${VPS_FOREX_SCANNER_USER_ID:-}" && -n "${M1_TACTICAL_MARKET_DATA_CONNECTION_ID:-}" ]] || {
  echo 'No pinned scanner/broker-native source binding' >&2; exit 1;
}
[[ -n "${DB_HOST:-}" && -n "${DB_USER:-}" && -n "${DB_PASSWORD:-}" && -n "$db_name" ]] || {
  echo 'No bounded database read configuration' >&2; exit 1;
}
install -d -m 700 "$research_dir"
tmp_csv="$(mktemp "$research_dir/cohort.XXXXXXXX.csv")"
tmp_json="$(mktemp "$research_dir/report.XXXXXXXX.json")"
trap 'rm -f "$tmp_csv" "$tmp_json"' EXIT

PGPASSWORD="$DB_PASSWORD" psql -X --csv \
 -h "$DB_HOST" -p "${DB_PORT:-5432}" -U "$DB_USER" -d "$db_name" \
 -v ON_ERROR_STOP=1 \
 -v scanner_user="$VPS_FOREX_SCANNER_USER_ID" \
 -v source_id="$M1_TACTICAL_MARKET_DATA_CONNECTION_ID" \
 -f "$sql" > "$tmp_csv"

PYTHONPATH="$repo/services/ai-engine" "$python_bin" \
 -m app.domain.training.demo_rejected_entry_outcomes_shadow \
 --cohort-csv "$tmp_csv" --report-json "$tmp_json"

chmod 600 "$tmp_csv" "$tmp_json"
mv -f "$tmp_csv" "$research_dir/latest-cohort.csv"
mv -f "$tmp_json" "$research_dir/latest-report.json"
# Train/score an *in-memory*, research-only challenger on earlier days;
# never write model weights, publish promotions, or send a broker order.
challenger_tmp="$(mktemp "$research_dir/challenger.XXXXXXXX.json")"
trap 'rm -f "$tmp_csv" "$tmp_json" "$challenger_tmp"' EXIT
PYTHONPATH="$repo/services/ai-engine" "$python_bin" \
  -m app.domain.training.demo_planb_temporal_challenger \
  --cohort-csv "$research_dir/latest-cohort.csv" --report-json "$challenger_tmp"
chmod 600 "$challenger_tmp"
mv -f "$challenger_tmp" "$research_dir/latest-challenger-report.json"

# A strictly read-only original-SL/TP quote-close audit for rejected entries.
# Keep ephemeral CSV private; retain only the anonymized bounded JSON report.
first_hit_sql="$repo/services/ai-engine/app/domain/training/demo_rejected_first_hit_readonly.sql"
[[ -r "$first_hit_sql" ]] || { echo 'First-hit research SQL missing' >&2; exit 1; }
first_hit_csv="$(mktemp "$research_dir/firsthit.XXXXXXXX.csv")"
first_hit_json="$(mktemp "$research_dir/firsthit.XXXXXXXX.json")"
trap 'rm -f "$tmp_csv" "$tmp_json" "$challenger_tmp" "$first_hit_csv" "$first_hit_json"' EXIT
db_port="${DB_PORT:-5432}"
PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=80000' PGPASSWORD="$DB_PASSWORD" psql -X --csv \
  -h "$DB_HOST" -p "$db_port" -U "$DB_USER" -d "$db_name" \
  -v ON_ERROR_STOP=1 -v scanner_user="$VPS_FOREX_SCANNER_USER_ID" \
  -v source_id="$M1_TACTICAL_MARKET_DATA_CONNECTION_ID" -f "$first_hit_sql" > "$first_hit_csv"
PYTHONPATH="$repo/services/ai-engine" "$python_bin" \
  -m app.domain.training.demo_rejected_first_hit_shadow \
  --cohort-csv "$first_hit_csv" --report-json "$first_hit_json"
chmod 600 "$first_hit_json"
mv -f "$first_hit_json" "$research_dir/latest-first-hit-report.json"
rm -f "$first_hit_csv"

printf '%s\n' 'REJECTED_ENTRY_SHADOW_READONLY=TRUE' 'REJECTED_ENTRY_BROKER_ORDER_WRITES=0' 'REJECTED_ENTRY_PROMOTION_ALLOWED=FALSE'
