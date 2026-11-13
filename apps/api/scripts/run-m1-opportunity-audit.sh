#!/usr/bin/env bash
# Owner-verified broker quote research ONLY. No order submission, DB writes,
# strategy promotion, broker process restarts or LIVE functionality.
set -euo pipefail
umask 077
ROOT=/home/lightworld/webapps/irexpro-staging
DIR="$ROOT/var/shadow-audits/m1-opportunity"
mkdir -p "$DIR"
chmod 700 "$DIR"
exec 9>"$DIR/.run.lock"
if ! flock -n 9; then
  echo 'M1_OPPORTUNITY_SKIPPED overlapping prior research'
  exit 0
fi
if [[ "${1:-}" == "--dry-run" ]]; then
  test -r "$ROOT/apps/api/scripts/audit-independent-m1-profit-window.cjs"
  echo 'M1_OPPORTUNITY_DRY_RUN_OK authority=NONE'
  exit 0
fi
RUN_ID=$(date -u '+%Y%m%dT%H%M%SZ')
SUMMARY="/tmp/irexpro-m1-opportunity-summary-$RUN_ID.json"
cleanup() { rm -f "$SUMMARY"; }
trap cleanup EXIT
cd "$ROOT/apps/api"
timeout 90s nice -n 14 /usr/local/apps/nodejs22/bin/node scripts/audit-independent-m1-profit-window.cjs > "$SUMMARY"
PYTHON=/usr/bin/python3
OUTPUT=$("$PYTHON" - "$SUMMARY" <<'PY'
import json,sys
from pathlib import Path
summary=json.loads(Path(sys.argv[1]).read_text())
file=Path(summary["output"])
if file.parent != Path("/tmp") or not file.name.startswith("irexpro-m1-opportunity-"):
    raise SystemExit("Invalid private research artifact")
report=json.loads(file.read_text())
assert report["artifact"] == "independent-m1-profit-window-shadow-v2"
assert report["mode"] == "READ_ONLY_RESEARCH"
assert report["executionAuthority"] == "NONE"
assert report["modifiesBrokerOrders"] is False
assert report["modifiesPositions"] is False
assert report["source"] == "PEPPERSTONE_CTRADER_DEMO_OWNER_BOUND"
assert report["recordedProspectively"] is True
assert report["qualifiesForDemoExecution"] is False
assert report["qualificationReason"] == "NO_PROSPECTIVE_BROKER_FILL_EVIDENCE_OR_STABLE_AFTER_COST_EDGE"
assert report["assumptions"]["retrospectiveMode"] is False
assert report["assumptions"]["positiveEntryAndExitQuoteRequired"] is True
assert report["assumptions"]["positiveQuoteMarkRequiredForEveryStopPathMinute"] is True
assert report["assumptions"]["endpointOnlyCannotProveStopSurvival"] is True
assert report["assumptions"]["hypotheticalFirstTouchNotTickAccurate"] is True
for score in report["summary"]:
    assert score["validatedStopPaths"] + score["endpointOnlyCannotVerifyStop"] == score["fixedHold"]["evaluated"]
    assert score["quickCapture"]["2"]["completeTradePolicy"]["evaluated"] <= score["validatedStopPaths"]
print(file)
PY
)
install -m 600 "$OUTPUT" "$DIR/$RUN_ID.json"
install -m 600 "$DIR/$RUN_ID.json" "$DIR/.latest-$RUN_ID.json"
mv -f "$DIR/.latest-$RUN_ID.json" "$DIR/latest.json"
rm -f "$OUTPUT"
find "$DIR" -maxdepth 1 -type f -name '20??????T??????Z.json' -mtime +20 -delete
"$PYTHON" - "$DIR/latest.json" <<'PY'
import json,sys
r=json.load(open(sys.argv[1]))
print("M1_OPPORTUNITY_RESEARCH_OK authority=NONE observations=%d priced=%d" % (
 r["studiedSignalCount"],r["independentlyPricedEpisodes"]))
print("M1_OPPORTUNITY_DATA_QUALITY totalValidatedPaths=%d endpointOnlyNoStopProof=%d" % (
 sum(x["validatedStopPaths"] for x in r["summary"]),
 sum(x["endpointOnlyCannotVerifyStop"] for x in r["summary"])))
for v in r["summary"]:
 if v["horizonMinutes"] in (5,7,10) and v["fixedHold"]["evaluated"]>0:
  print("M1_SHADOW_DIRECTIONAL_MARK_ONLY pair=%s horizon=%sm priced=%d quoteNetPips=%s stopPathsVerified=%d endpointOnly=%d" % (
   v["pair"],v["horizonMinutes"],v["fixedHold"]["evaluated"],
   v["fixedHold"]["netPips"],v["validatedStopPaths"],v["endpointOnlyCannotVerifyStop"]))
  if v["validatedStopPaths"]>0:
   p=v["quickCapture"]["2"]["completeTradePolicy"]
   print("M1_SHADOW_STOP_FIRST_PROXY pair=%s horizon=%sm evaluated=%d quoteNetPips=%s" % (
    v["pair"],v["horizonMinutes"],p["evaluated"],p["netPips"]))
PY
