#!/usr/bin/env bash
# Read-only, private, repeatable research. NEVER place orders or deploy models.
set -Eeuo pipefail
umask 077

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
api_env="$repo/apps/api/.env"
research_root="/home/lightworld/webapps/irexpro-research/ood-shadow"
python_bin="$repo/services/ai-engine/.venv/bin/python"
sql="$repo/services/ai-engine/app/domain/training/ood_shadow_cohort_readonly.sql"

[[ -f "$api_env" && -f "$sql" && -x "$python_bin" ]] || {
  echo "OOD research prerequisites missing; fail closed" >&2
  exit 1
}
# The private .env contains human-readable comments/values that are NOT
# valid shell statements. Parse with python-dotenv instead of sourcing code.
# Export ONLY the necessary allowlisted variables, using NUL separators so
# whitespace never causes shell interpolation or exposes a credential in logs.
while IFS= read -r -d '' item; do
  export "$item"
done < <("$python_bin" - "$api_env" <<'PYENV'
from dotenv import dotenv_values
import sys

settings = dotenv_values(sys.argv[1])
allowed = (
    "VPS_FOREX_SCANNER_USER_ID",
    "DB_HOST", "DB_PORT", "DB_USER", "DB_PASSWORD", "DB_NAME", "DB_DATABASE",
)
for name in allowed:
    value = settings.get(name)
    if value is not None:
        sys.stdout.buffer.write((name + "=" + value).encode("utf-8") + b"\0")
PYENV
)
[[ -n "${VPS_FOREX_SCANNER_USER_ID:-}" ]] || {
  echo "OOD scanner user is not configured; no export" >&2
  exit 1
}
[[ -n "${DB_HOST:-}" && -n "${DB_USER:-}" && -n "${DB_PASSWORD:-}" ]] || {
  echo "OOD database read access is not configured" >&2
  exit 1
}
db_name="${DB_NAME:-${DB_DATABASE:-}}"
[[ -n "$db_name" ]] || { echo "No database name configured" >&2; exit 1; }

install -d -m 700 "$research_root"
tmp_cohort="$(mktemp "$research_root/cohort.XXXXXXXX.csv")"
tmp_report="$(mktemp "$research_root/report.XXXXXXXX.json")"
trap 'rm -f "$tmp_cohort" "$tmp_report"' EXIT

# psql CSV contains only sanitized model features and two observed quote pairs,
# not users, session keys, connector IDs, broker credentials, or raw trade logs.
PGPASSWORD="$DB_PASSWORD" psql -X --csv \
  -h "$DB_HOST" -p "${DB_PORT:-5432}" -U "$DB_USER" -d "$db_name" \
  -v ON_ERROR_STOP=1 -v scanner_user="$VPS_FOREX_SCANNER_USER_ID" \
  -f "$sql" > "$tmp_cohort"

PYTHONPATH="$repo/services/ai-engine" "$python_bin" \
  -m app.domain.training.ood_shadow_candidate \
  --cohort-csv "$tmp_cohort" --report-json "$tmp_report"

# Atomically replace the one private snapshot; avoids unbounded disk growth.
chmod 600 "$tmp_cohort" "$tmp_report"
mv -f "$tmp_cohort" "$research_root/latest-cohort.csv"
mv -f "$tmp_report" "$research_root/latest-report.json"
python3 - "$research_root/latest-report.json" <<'PY'
import json,sys
report=json.load(open(sys.argv[1],encoding="utf-8"))
quality=report.get("data_quality",{})
print("OOD_SHADOW_READONLY=TRUE")
print("OOD_SHADOW_AUTHORITY=NONE")
print("OOD_SHADOW_TRAINING_READINESS="+report["readiness"])
print("OOD_SHADOW_VERIFIED_ROWS="+str(quality.get("causally_verified_records",0)))
print("OOD_SHADOW_DISTINCT_DAYS="+str(quality.get("distinct_utc_days",0)))
print("OOD_SHADOW_FITTED="+str(report.get("model_fitted",False)).lower())
print("OOD_SHADOW_PRODUCTION_PROMOTION=FALSE")
PY
