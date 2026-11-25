#!/usr/bin/env bash
# Research-only, low-priority, bounded, single-flight broker-quote forecast audit.
# Never opens broker positions or promotes models; stores private daily evidence.
set -euo pipefail
umask 077

ROOT=/home/lightworld/webapps/irexpro-staging
DEST="$ROOT/var/shadow-audits/net-alpha"
NODE=/usr/local/apps/nodejs22/bin/node
PYTHON="$ROOT/services/ai-engine/.venv/bin/python"
mkdir -p "$DEST"
chmod 700 "$DEST"
exec 9>"$DEST/.run.lock"
if ! flock -n 9; then
  echo "NET_ALPHA_SHADOW_SKIPPED overlapping earlier invocation"
  exit 0
fi

RUN_ID=$(date -u '+%Y%m%dT%H%M%SZ')
CSV="/tmp/irexpro-netalpha-broker-$RUN_ID.csv"
REPORT="/tmp/irexpro-netalpha-result-$RUN_ID.json"
cleanup() { rm -f -- "$CSV" "$REPORT"; }
trap cleanup EXIT
if [ "${1:-}" = "--dry-run" ]; then
  test -x "$NODE" && test -x "$PYTHON"
  echo "NET_ALPHA_SHADOW_DRY_RUN_OK $RUN_ID executionAuthority=NONE"
  exit 0
fi

echo "NET_ALPHA_SHADOW_START $RUN_ID"
cd "$ROOT/apps/api"
nice -n 14 "$NODE" scripts/export-demo-horizon-quotes.cjs "$CSV"
cd "$ROOT/services/ai-engine"
OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 timeout 780s nice -n 16 \
  "$PYTHON" -m app.domain.training.demo_independent_net_alpha_challenger \
  --csv "$CSV" --out "$REPORT" >/dev/null

# The model itself writes a strict research-only JSON contract.
# Refuse to store incomplete or promotable results.
"$PYTHON" - "$REPORT" <<'PY'
import json, sys
from pathlib import Path
r=json.loads(Path(sys.argv[1]).read_text())
assert r["artifact"] == "irexpro-independent-net-alpha-walkforward-v1"
assert r["promotionAllowed"] is False
assert r["executionAuthority"] == "NONE"
assert r["brokerOrders"] == 0
assert r["assumptions"]["positiveBidAskSpreadRequired"] is True
assert r["assumptions"]["holdoutBrokerVerified"] == "pepperstone-ctrader"
assert r["qualification"]["reviewStatus"] == "NOT_QUALIFIED_FOR_DEMO_EXECUTION"
assert r["qualification"]["paperPromotionEligible"] is False
assert r["qualification"]["livePromotionEligible"] is False
assert r["results"]
scored=sum(x.get("status")=="WALKFORWARD_RESEARCH_ONLY" for x in r["results"])
print("NET_ALPHA_SHADOW_VALIDATED folds=%d qualifiedFolds=%d authority=NONE" %
      (len(r["results"]), scored))
PY

install -m 600 "$REPORT" "$DEST/$RUN_ID.json"
install -m 600 "$REPORT" "$DEST/.latest-$RUN_ID.json"
mv -f "$DEST/.latest-$RUN_ID.json" "$DEST/latest.json"
# Keep only research files created by this runner, retain the latest result.
find "$DEST" -maxdepth 1 -type f -name '20??????T??????Z.json' -mtime +20 -delete
echo "NET_ALPHA_SHADOW_FINISHED $RUN_ID authority=NONE brokerOrders=0"
