#!/usr/bin/env bash
# Research only: read-only broker quote labels and private diagnostics. No orders.
set -Eeuo pipefail
umask 077
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
api_env="$repo/apps/api/.env"
# Git worktrees do not copy private .env files. Use the staging source only
# when this exact code is deployed under its authorized staging root.
[[ -f "$api_env" ]] || { echo "Missing API environment; research held" >&2; exit 2; }
python_bin="$repo/services/ai-engine/.venv/bin/python"
sql="$repo/services/ai-engine/app/domain/training/ood_six_pair_cohort_readonly.sql"
[[ -x "$python_bin" && -f "$sql" ]] || { echo "Missing research prerequisites" >&2; exit 2; }
research_root="/home/lightworld/webapps/irexpro-research/ood-shadow"
install -d -m 700 "$research_root"
while IFS= read -r -d '' item; do export "$item"; done < <("$python_bin" - "$api_env" <<'PY'
import sys
from dotenv import dotenv_values
cfg=dotenv_values(sys.argv[1])
for key in ("VPS_FOREX_SCANNER_USER_ID","DB_HOST","DB_PORT","DB_USER","DB_PASSWORD","DB_NAME","DB_DATABASE"):
    if cfg.get(key) is not None:
        sys.stdout.buffer.write((key+"="+cfg[key]).encode()+b"\0")
PY
)
[[ -n "${VPS_FOREX_SCANNER_USER_ID:-}" && -n "${DB_HOST:-}" && -n "${DB_USER:-}" && -n "${DB_PASSWORD:-}" ]] || { echo "Missing scoped research DB configuration" >&2; exit 3; }
database="${DB_NAME:-${DB_DATABASE:-}}"
[[ -n "$database" ]] || { echo "Missing database name" >&2; exit 3; }
cohort="$(mktemp "$research_root/six-pair-cohort.XXXXXXXX.csv")"
report="$(mktemp "$research_root/six-pair-report.XXXXXXXX.json")"
trap 'rm -f "$cohort" "$report"' EXIT
PGPASSWORD="$DB_PASSWORD" psql -X --csv -h "$DB_HOST" -p "${DB_PORT:-5432}" -U "$DB_USER" -d "$database" -v ON_ERROR_STOP=1 -v scanner_user="$VPS_FOREX_SCANNER_USER_ID" -f "$sql" > "$cohort"
PYTHONPATH="$repo/services/ai-engine" "$python_bin" -m app.domain.training.ood_six_pair_shadow --cohort-csv "$cohort" --report-json "$report"
chmod 600 "$cohort" "$report"
mv -f "$cohort" "$research_root/latest-six-pair-cohort.csv"
mv -f "$report" "$research_root/latest-six-pair-report.json"
