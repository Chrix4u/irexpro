'use strict';
/**
 * Research-only observer: notices when an existing portfolio brake expires
 * and if the scanner continues to have no submitted trade intent.
 * It never modifies a risk rule, broker order, model or lot size.
 */
const fs=require('node:fs'),path=require('node:path');
const {spawn}=require('node:child_process');
const MONITOR_ARTIFACT='owner-demo-entry-blockade-watch-v1';
const CYCLE=90000,MAX_RUNTIME=25000,MAX_OUTPUT=140*1024;
const SCRIPT=path.join(__dirname,'audit-owner-demo-entry-blockers.cjs');
const REPORT='/home/lightworld/webapps/irexpro-research/entry-blockade/latest-report.json';
function classify(report,now=Date.now()){
 if(!report||report.artifact!=='owner-pepperstone-demo-entry-blockade-diagnostic-v1')
  throw Error('INVALID_DIAGNOSTIC_REPORT');
 if(!Number.isFinite(now))throw Error('INVALID_TIME');
 const last=Date.parse(report.latestDecisionAt||'');
 if(!Number.isFinite(last)||now-last>5*60000)
  return 'NO_RECENT_SCANNER_DECISIONS';
 if(report.newTradeIntentsSinceLastClose>0)
  return 'NEW_DEMO_INTENT_SUBMITTED';
 const brake=report.independentlyComputedAccountBrake;
 // The independently recomputed cooldown is NOT a dispatch veto for the
 // verified owner DEMO when the scheduler has advisory-only mode enabled.
 if(report.latestOwnerPausePolicy?.advisoryOnly===true &&
    report.latestOwnerPausePolicy?.portfolioLossStreakBlocks===false &&
    brake?.state==='CONFIRMED_THREE_LOSSES_120M_GUARD')
  return 'OWNER_LOSS_STREAK_WARNING_ONLY';
 if(brake?.state==='CONFIRMED_THREE_LOSSES_120M_GUARD')
  return 'VALID_PORTFOLIO_BRAKE_ACTIVE';
 if(brake?.state==='THREE_LOSSES_BUT_TIME_GATE_EXPIRED')
  return 'PORTFOLIO_BRAKE_EXPIRED_NO_NEW_INTENT';
 if(report.selectedAlternativeEligibleSinceLastClose===0)
  return 'NO_RECENT_ELIGIBLE_ALTERNATE';
 return 'POST_BRAKE_OTHER_MODEL_OR_RISK_CHECKS';
}
function compact(report,state){
 return {
  time:report.generatedAt,state,
  scannedSinceLastClose:report.decisionsSinceLatestClosedTrade,
  eligibleAlternatesSinceLastClose:report.selectedAlternativeEligibleSinceLastClose,
  brakedAlternatesSinceLastClose:report.selectedAlternativeBrakedSinceLastClose,
  ownerLossPauseAdvisoryOnly:report.latestOwnerPausePolicy?.advisoryOnly??null,
  effectivePortfolioVetoCount:report.eligibleAlternativeWithEffectivePortfolioVeto??null,
  newIntentsSinceLastClose:report.newTradeIntentsSinceLastClose,
  latestScanAt:report.latestDecisionAt,
  latestCloseAt:report.independentlyComputedAccountBrake.latestClosedAt,
  expectedBrakeExpiresAt:report.independentlyComputedAccountBrake.potentialBrakeEndsAt,
  cooldownRemainingSeconds:report.independentlyComputedAccountBrake.remainingSeconds,
  executionAuthority:'NONE',
  changesRiskRules:false,changesLotSize:false,placesOrders:false,
 };
}
function inspectSnapshot(file=REPORT,now=Date.now()){
 const report=JSON.parse(fs.readFileSync(file,'utf8'));
 const status=classify(report,now);
 return compact(report,status);
}
function runAudit({script=SCRIPT,timeout=MAX_RUNTIME}={}){
 return new Promise((resolve,reject)=>{
  let txt='',error='',size=0,finished=false;
  const child=spawn(process.execPath,[script],{
   cwd:path.resolve(__dirname,'..'),env:{...process.env},
   stdio:['ignore','pipe','pipe'],
  });
  const timer=setTimeout(()=>child.kill('SIGKILL'),timeout);
  const append=(to,buf)=>{
   size+=buf.length;
   if(size>MAX_OUTPUT){child.kill('SIGKILL');return}
   if(to==='out')txt+=buf.toString('utf8');
   else error+=buf.toString('utf8');
  };
  child.stdout.on('data',b=>append('out',b));
  child.stderr.on('data',b=>append('err',b));
  child.once('error',e=>{
   if(finished)return;finished=true;clearTimeout(timer);reject(e);
  });
  child.once('close',(code,signal)=>{
   if(finished)return;finished=true;clearTimeout(timer);
   if(size>MAX_OUTPUT)return reject(Error('OUTPUT_CAP_EXCEEDED'));
   if(code!==0)return reject(Error('DIAGNOSTIC_FAILED_'+String(code)+'_'+
    String(signal||'')+'_'+error.slice(0,150)));
   const line=txt.split('\n').find(s=>s.startsWith('OWNER_DEMO_ENTRY_BLOCKADE '));
   if(!line)return reject(Error('NO_OWNER_DEMO_AUDIT_MARKER'));
   resolve(line);
  });
 });
}
async function main(){
 let running=false,stopped=false,previous='',lastLogged=0;
 const check=async()=>{
  if(stopped||running)return;
  running=true;
  try{
   await runAudit();
   const report=inspectSnapshot(REPORT);
   if(report.state!==previous||Date.now()-lastLogged>=20*60000){
    console.log('OWNER_DEMO_ENTRY_BLOCKADE_STATUS',JSON.stringify(report));
    previous=report.state;lastLogged=Date.now();
   }
  }catch(e){
   console.error('OWNER_DEMO_ENTRY_BLOCKADE_RESEARCH_DEFERRED',
    String(e.message).slice(0,170));
  }finally{running=false}
 };
 await check();
 if(!process.argv.includes('--watch'))return;
 const timer=setInterval(check,CYCLE);
 const stop=()=>{stopped=true;clearInterval(timer)};
 process.once('SIGTERM',stop);process.once('SIGINT',stop);
}
module.exports={MONITOR_ARTIFACT,CYCLE,MAX_RUNTIME,MAX_OUTPUT,
 classify,compact,inspectSnapshot,runAudit};
if(require.main===module)main().catch(e=>{
 console.error('OWNER_DEMO_ENTRY_BLOCKER_WATCH_FATAL',e.message);
 process.exitCode=1;
});
