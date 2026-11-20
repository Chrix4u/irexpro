'use strict';
/**
 * Independent, owner-demo-only broker-settlement scorecard refresher.
 * No broker writes, no session or entry changes, no requests to trading APIs.
 */
const audit=require('./audit-owner-demo-weak-reversal-ceiling-forward.cjs');
const PERIOD_MS=45000;
let stopping=false,timeout=null,failures=0,last=null;
async function tick() {
 if(stopping)return;
 try{
  const report=await audit.run();
  failures=0;
  const snapshot={
   cappedOpen:report.byGroup.weakConfirmedReversalCapped.openPositions,
   cappedSettled:report.byGroup.weakConfirmedReversalCapped.settled,
   cappedBookedNetUsd:report.byGroup.weakConfirmedReversalCapped.bookedNetUsd,
   uncappedConfirmedSettled:report.byGroup.confirmedReversalUnchanged.settled,
   censoredOpen:report.all.openPositions,
   shadowEligibleSince:report.preEntryConfluenceFrozenActivation||null,
   shadowFlagged:report.preEntryConfluenceShadow?.flagged?.trades||0,
   shadowWarnedActualWinners:report.preEntryConfluenceShadow?.flagged?.winners||0,
   shadowWarnedActualLosers:report.preEntryConfluenceShadow?.flagged?.losers||0,
   shadowMissedFastCloses:report.preEntryConfluenceShadow?.closedBeforeFirstOpenSnapshot||0,
   preDispatchCausalFills:report.preDispatchShadow?.decisionsWithCausalBrokerFill||0,
   preDispatchWarned:report.preDispatchShadow?.warned?.tradeIds||0,
   preDispatchWarnedSettledLosers:report.preDispatchShadow?.warned?.losers||0,
   preDispatchWarnedSettledWinners:report.preDispatchShadow?.warned?.winners||0,
   preDispatchWarningWinnersUsd:report.preDispatchShadow?.actualWinningUsdThatWarningWouldExclude||0,
   source:'BROKER_SETTLED_ONLY',
  };
  if(JSON.stringify(snapshot)!==JSON.stringify(last)){
   console.log(JSON.stringify({event:'OWNER_DEMO_CAP_FORWARD_REFRESH',...snapshot}));
   last=snapshot;
  }
 }catch(e){
  failures++;
  console.error('OWNER_DEMO_CAP_FORWARD_REFRESH_FAILED',
   String(e.message||e).slice(0,240));
  // Fail clearly rather than writing a false blank report.
  if(failures>=10){process.exitCode=1;return;}
 }
 if(!stopping) timeout=setTimeout(tick,PERIOD_MS);
}
function start(){
 process.on('SIGTERM',()=>{stopping=true;if(timeout)clearTimeout(timeout)});
 process.on('SIGINT',()=>{stopping=true;if(timeout)clearTimeout(timeout)});
 void tick();
}
if(require.main===module)start();
module.exports={PERIOD_MS,start};
