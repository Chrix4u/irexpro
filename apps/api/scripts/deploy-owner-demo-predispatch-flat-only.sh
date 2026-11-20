#!/usr/bin/env bash
# Exact-owner Pepperstone USD DEMO deployment with mandatory flat-only check.
# Intentional manual invocation ONLY. Research feature cannot submit orders.
set -euo pipefail
ROOT=/home/lightworld/webapps/irexpro-staging
API="$ROOT/apps/api"
DIST="$API/dist/modules/ai"
STAGE="$API/dist.owner-predispatch-confluence-staged/modules/ai"
ENVFILE="$API/.env"
HEALTH_URL=https://irexpro.lightworldtech.com/api/v1/health
CHECK="$API/scripts/check-owner-demo-flat-before-restart.cjs"
API_SERVICE=irexpro-api-staging
PROFIT_SERVICE=irexpro-owner-demo-drawdown-guard-postexit-shadow
FILES=(
 m1-tactical-scheduler.service.js
 m1-tactical-scheduler.service.js.map
 owner-demo-predispatch-fee-confluence-shadow.js
 owner-demo-predispatch-fee-confluence-shadow.js.map
)
echo "PREDISPATCH_DEPLOY_PREFLIGHT_AT_UTC=$(date -u +%FT%TZ)"
for f in "${FILES[@]}";do
 test -s "$STAGE/$f" || { echo "MISSING_STAGED_API_ARTIFACT=$f";exit 47; }
done
test -s "$CHECK"
test -s "$ENVFILE"
grep -q '^IREXPRO_OWNER_DEMO_WEAK_REVERSAL_4LOT_CEILING=enabled$' "$ENVFILE" || {
 echo "REFUSE_UNEXPECTED_WEAK_REVERSAL_POLICY";exit 48;
}
node "$CHECK"
PRE_API_PID=$(pm2 pid "$API_SERVICE" | head -1)
PRE_PROFIT_PID=$(pm2 pid "$PROFIT_SERVICE" | head -1)
test -n "$PRE_API_PID" && test "$PRE_API_PID" != 0
test -n "$PRE_PROFIT_PID" && test "$PRE_PROFIT_PID" != 0
PRE_HTTP=$(curl -sS --connect-timeout 3 --max-time 8 -o /dev/null -w '%{http_code}' "$HEALTH_URL")
test "$PRE_HTTP" = 200 || { echo "UNHEALTHY_BEFORE_RESTART";exit 49; }
BACKUP="/home/lightworld/webapps/irexpro-research/deploy-backups/owner-predispatch-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p -m 700 "$BACKUP"
chmod 700 "$BACKUP"
cp -p "$ENVFILE" "$BACKUP/api.env.before"
for f in "${FILES[@]}";do
 if [ -f "$DIST/$f" ];then cp -p "$DIST/$f" "$BACKUP/$f.before";fi
done
RESTART_ATTEMPTED=0
rollback(){
 local rc=$?
 trap - ERR
 echo "ROLLING_BACK_OWNER_PREDISPATCH_RELEASE rc=$rc"
 for f in "${FILES[@]}";do
  if [ -f "$BACKUP/$f.before" ];then
   cp -p "$BACKUP/$f.before" "$DIST/$f"
  else
   rm -f "$DIST/$f"
  fi
 done
 cp -p "$BACKUP/api.env.before" "$ENVFILE"
 if [ "$RESTART_ATTEMPTED" = 1 ];then
  pm2 restart "$API_SERVICE" > /tmp/irexpro-owner-predispatch-rollback.log 2>&1 || true
 fi
 echo "OLD_CODE_ENV_RESTORED"
 exit "$rc"
}
trap rollback ERR
for f in "${FILES[@]}";do
 cp -p "$STAGE/$f" "$DIST/$f.owner-predispatch-stage"
 mv -f "$DIST/$f.owner-predispatch-stage" "$DIST/$f"
done
cp -p "$ENVFILE" "$ENVFILE.owner-predispatch-stage"
if grep -q '^IREXPRO_OWNER_DEMO_PREDISPATCH_FEE_CONFLUENCE_SHADOW=' "$ENVFILE.owner-predispatch-stage";then
 sed -i 's/^IREXPRO_OWNER_DEMO_PREDISPATCH_FEE_CONFLUENCE_SHADOW=.*/IREXPRO_OWNER_DEMO_PREDISPATCH_FEE_CONFLUENCE_SHADOW=enabled/' "$ENVFILE.owner-predispatch-stage"
else
 printf '\nIREXPRO_OWNER_DEMO_PREDISPATCH_FEE_CONFLUENCE_SHADOW=enabled\n' >> "$ENVFILE.owner-predispatch-stage"
fi
mv -f "$ENVFILE.owner-predispatch-stage" "$ENVFILE"
# Mandatory exact broker position re-check as close as possible to restart.
# If a new trade appeared, restore files only. Do not restart anything.
node "$CHECK"
echo "API_RESTART_AT_UTC=$(date -u +%FT%TZ)"
RESTART_ATTEMPTED=1
pm2 restart "$API_SERVICE" > /tmp/irexpro-owner-predispatch-api-restart.log 2>&1
READY=0
for i in $(seq 1 16);do
 CODE=$(curl -s --connect-timeout 2 --max-time 6 -o /dev/null -w '%{http_code}' "$HEALTH_URL" || true)
 if [ "$CODE" = 200 ];then READY=1;break;fi
 sleep 2
done
test "$READY" -eq 1
test "$(pm2 pid "$PROFIT_SERVICE" | head -1)" = "$PRE_PROFIT_PID"
test "$(grep -c '^IREXPRO_OWNER_DEMO_PREDISPATCH_FEE_CONFLUENCE_SHADOW=enabled$' "$ENVFILE")" -eq 1
test "$(grep -c '^IREXPRO_OWNER_DEMO_WEAK_REVERSAL_4LOT_CEILING=enabled$' "$ENVFILE")" -eq 1
node -e 'const x=require(process.argv[1]);if(x.OWNER_DEMO_PREDISPATCH_FEE_CONFLUENCE_ARTIFACT!=="owner-demo-predispatch-fee-dual-abstain-research-v1")process.exit(1)' "$DIST/owner-demo-predispatch-fee-confluence-shadow.js"
trap - ERR
echo "DEPLOY_SUCCESS_PRE_DISPATCH_DEMO_RESEARCH_AT_UTC=$(date -u +%FT%TZ)"
echo "API_PID=$(pm2 pid "$API_SERVICE") PROFIT_PID=$(pm2 pid "$PROFIT_SERVICE")"
echo "NO_TRADING_GATE_OR_BROKER_STOP_CHANGED"
echo "ROLLBACK_BACKUP=$BACKUP"
