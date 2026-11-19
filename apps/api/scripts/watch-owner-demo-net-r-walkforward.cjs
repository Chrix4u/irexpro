'use strict';
// Bounded research-only auditor of owner Pepperstone USD DEMO, once per 30m.
// Child code uses PostgreSQL REPEATABLE READ READ ONLY.
// No broker, execution service, model weights or lot allocation imports.
const path=require('node:path'),{spawn}=require('node:child_process');
const CADENCE=30*60000;
const BIN=path.join(__dirname,'audit-owner-demo-net-r-walkforward.cjs');
const MAX_OUTPUT=128*1024;
function summarizeSuccess(out){
 const line=String(out).trim().split('\n')
  .find(x=>x.startsWith('DAY_PURGED_OWNER_NET_R_CALIBRATION '));
 if(!line)throw Error('MISSING_RESEARCH_RESULT');
 const result=JSON.parse(line.slice('DAY_PURGED_OWNER_NET_R_CALIBRATION '.length));
 const r=result.result;
 if(!r||!Number.isSafeInteger(r.evaluatedTrades)||r.evaluatedTrades<0||
  !Number.isSafeInteger(r.outOfSampleDayPurgedAdjustedCount))
  throw Error('INVALID_RESEARCH_RESULT');
 return {
  at:result.generatedAt,
  trades:r.evaluatedTrades,
  marketDays:r.independentDays,
  adjustedTestTrades:r.outOfSampleDayPurgedAdjustedCount,
  baselineMAE:r.maeRawOnComparedCohort,
  shadowMAE:r.maeAdjustedOnComparedCohort,
  preliminaryAccuracy:r.directionOfAccuracyChange,
  prospective:result.prospective??null,
  advisoryThresholdImpact:result.advisoryThresholdImpact??null,
  modifiesExecution:false,lotChanges:0,brokerOrders:0,
  qualifiedForLive:false,
 };
}
function runOnce({node=process.execPath,script=BIN,timeoutMs=45000}={}){
 return new Promise((resolve,reject)=>{
  let bytes=0,stdout='',stderr='',finished=false;
  const c=spawn(node,[script],{
   cwd:path.resolve(__dirname,'..'),
   env:{...process.env},
   stdio:['ignore','pipe','pipe'],
   windowsHide:true,
  });
  const timer=setTimeout(()=>{
   if(finished)return;c.kill('SIGKILL');
  },timeoutMs);
  const feed=(kind,buf)=>{
   bytes+=buf.length;
   if(bytes>MAX_OUTPUT){c.kill('SIGKILL');return}
   if(kind==='out')stdout+=buf.toString('utf8');
   else stderr+=buf.toString('utf8');
  };
  c.stdout.on('data',x=>feed('out',x));
  c.stderr.on('data',x=>feed('err',x));
  c.once('error',err=>{if(finished)return;
   finished=true;clearTimeout(timer);reject(err)});
  c.once('close',(code,signal)=>{
   if(finished)return;
   finished=true;clearTimeout(timer);
   if(bytes>MAX_OUTPUT)return reject(Error('SHADOW_OUTPUT_CAP_EXCEEDED'));
   if(code!==0)return reject(Error('RESEARCH_AUDIT_FAILED_'+String(code)+'_'+
    String(signal||'')+'_'+stderr.slice(0,130)));
   try{resolve(summarizeSuccess(stdout))}catch(err){reject(err)}
  });
 });
}
async function main(){
 let running=false,stopped=false;
 const tick=async()=>{
  if(stopped||running)return;
  running=true;try{
   const r=await runOnce();
   console.log('OWNER_DEMO_DAY_PURGED_NET_R_SHADOW',JSON.stringify(r));
  }catch(e){
   console.error('OWNER_DEMO_DAY_PURGED_NET_R_DEFERRED',
    String(e.message).slice(0,160));
  }finally{running=false}
 };
 await tick();
 if(!process.argv.includes('--watch'))return;
 const timer=setInterval(tick,CADENCE);
 const end=()=>{
  stopped=true;clearInterval(timer);
  // Research child, if still running, will finish within its own bounded timeout.
 };
 process.once('SIGTERM',end);process.once('SIGINT',end);
}
module.exports={CADENCE,MAX_OUTPUT,summarizeSuccess,runOnce};
if(require.main===module)main().catch(e=>{
 console.error('OWNER_DEMO_NET_R_WATCH_FATAL',String(e.message).slice(0,160));
 process.exitCode=1;
});
