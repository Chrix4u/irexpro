'use strict';
/* Read-only exact-owner Pepperstone USD DEMO forward forming-candle shadow.
 * Runs at fixed as-of 15s/45s M1 and +15s/+285s M5 only.
 * No broker API, no order authority, no DB changes, no model promotion.
 */
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn}=require('node:child_process');
const {latestTail,pruneSnapshots}=require('./collect-owner-demo-forming-candle-snapshots.cjs');
const ARTIFACT='irexpro-owner-demo-prospective-candle-shadow-v1';
const ROOT='/home/lightworld/webapps/irexpro-research/forming-candle-predictions';
const SOURCE='/home/lightworld/webapps/irexpro-research/forming-candle-snapshots';
const ENGINE='/home/lightworld/webapps/irexpro-staging/services/ai-engine';
const PYTHON=ENGINE+'/.venv/bin/python';
const MODEL_ROOT='/tmp/irexpro-forming-candle-models';
const REPORT='/tmp/irexpro-forming-candle-evaluation-20261117.json';
const FOCUS=['EURUSD','AUDUSD','USDJPY','USDCAD'];
const STAGE_MS=15000;
const MAX_DAILY_BYTES=24*1024*1024;
function scoreSlot(now){
  if(!Number.isSafeInteger(now)||now<=0)throw Error('INVALID_CLOCK');
  const slot=Math.floor((now-4000)/STAGE_MS)*STAGE_MS;
  const part=slot%60000;
  return (part===15000||part===45000)&&now-slot>=4000&&now-slot<=10500?slot:null;
}
function stageTimeframes(slot){
  if(slot%60000!==15000&&slot%60000!==45000)return [];
  const out=['M1'];if([15000,285000].includes(slot%300000))out.push('M5');
  return out;
}
function predictionKey(x){return [x.decisionAt,x.barStart,x.instrument,x.timeframe].join('|');}
function loadStageSnapshots(slot,source=SOURCE){
  const file=path.join(source,new Date(slot).toISOString().slice(0,10)+'.jsonl');
  const expected=new Date(slot).toISOString(),allowed=stageTimeframes(slot);
  const result=[],seen=new Set();
  for(const line of latestTail(file,110*1024).split('\n')){
    if(!line)continue;let x;try{x=JSON.parse(line)}catch{continue}
    if(x.artifact!=='irexpro-forming-candle-asof-quote-shadow-v1'||
       x.decisionAt!==expected||!allowed.includes(x.timeframe)||
       !FOCUS.includes(x.instrument)||x.modifiesExecution!==false||
       x.brokerOrderAuthority!==false||x.includesNextBarLabel!==false||
       x.fromCompletedFutureCandle!==false)continue;
    const k=predictionKey(x);
    if(seen.has(k))throw Error('DUPLICATE_ASOF_SOURCE_SNAPSHOT');
    seen.add(k);result.push(x);
  }
  return result;
}
function restoreSeen(dir=ROOT,now=new Date()){
  const seen=new Set();
  for(const days of [1,0]){
    const day=new Date(now.getTime()-days*86400000).toISOString().slice(0,10);
    for(const line of latestTail(path.join(dir,day+'.jsonl'),350*1024).split('\n')){
      if(!line)continue;try{const x=JSON.parse(line);if(x.artifact===ARTIFACT)seen.add(predictionKey(x));}catch{}
    }
  }
  return seen;
}
function appendPredictions(rows,{dir=ROOT,seen=new Set()}={}){
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  let written=0,duplicates=0,capExceeded=0;
  for(const x of rows){
    if(x.artifact!==ARTIFACT||x.researchOnly!==true||
       x.brokerOrderAuthority!==false||x.modifiesExecution!==false||
       x.nextCandleOutcomeKnown!==false||x.afterCostPnlKnown!==false)
      throw Error('UNSAFE_RESEARCH_PREDICTION');
    const key=predictionKey(x);
    if(seen.has(key)){duplicates++;continue;}
    const f=path.join(dir,x.decisionAt.slice(0,10)+'.jsonl');
    const line=JSON.stringify(x)+'\n';
    if((fs.existsSync(f)?fs.statSync(f).size:0)+Buffer.byteLength(line)>MAX_DAILY_BYTES){
      capExceeded++;continue;
    }
    fs.appendFileSync(f,line,{mode:0o600});seen.add(key);written++;
  }
  return {written,duplicates,capExceeded};
}
async function getConnection(db,owner){
  const r=await db.query([
    'SELECT id FROM broker.broker_connections',
    'WHERE user_id=$1 AND broker_id=$2 AND account_type=$3',
    'AND account_currency=$4 AND deleted_at IS NULL',
    "AND status='CONNECTED' AND authorization_status='ACTIVE'",
    'ORDER BY created_at DESC LIMIT 1',
  ].join(' '),[owner,'pepperstone-ctrader','DEMO','USD']);
  if(r.rows.length!==1)throw Error('OWNER_PEPPERSTONE_USD_DEMO_NOT_VERIFIED');
  return r.rows[0].id;
}
async function readPriorBars(db,connection,snaps){
  const inst=snaps.map(x=>x.instrument),frames=snaps.map(x=>x.timeframe),
    starts=snaps.map(x=>x.barStart);
  await db.query('BEGIN READ ONLY');
  try{
    const sql=[
      'SELECT k.instrument,k.timeframe,c.bucket_time,c.open,c.high,c.low,c.close',
      'FROM unnest($2::text[],$3::text[],$4::timestamptz[])',
      'AS k(instrument,timeframe,bar_start)',
      'JOIN LATERAL (SELECT bucket_time,open,high,low,close',
      'FROM market_data.provider_quote_candles c',
      "WHERE c.connection_id=$1 AND c.source='ctrader-broker-native'",
      'AND c.instrument=k.instrument AND c.timeframe=k.timeframe',
      'AND c.sample_count>=2',
      'AND c.bucket_time + CASE k.timeframe',
      "WHEN 'M1' THEN interval '1 minute'",
      "WHEN 'M5' THEN interval '5 minutes'",
      "ELSE interval '999 days' END <= k.bar_start",
      "AND c.bucket_time >= k.bar_start-interval '7 hours'",
      'AND c.open>0 AND c.low>0 AND c.close>0',
      'AND c.high>=GREATEST(c.open,c.close)',
      'AND c.low<=LEAST(c.open,c.close)',
      'ORDER BY c.bucket_time DESC LIMIT 65) c ON TRUE',
      'ORDER BY k.instrument,k.timeframe,c.bucket_time',
    ].join(' ');
    const r=await db.query(sql,[connection,inst,frames,starts]);
    await db.query('COMMIT');
    const out={};
    for(const x of r.rows)(out[x.instrument+'|'+x.timeframe]??=[]).push({
      bucket_time:new Date(x.bucket_time).toISOString(),
      open:x.open,high:x.high,low:x.low,close:x.close,
    });
    return out;
  }catch(e){await db.query('ROLLBACK').catch(()=>{});throw e;}
}
function createWarmScorer(){
  const child=spawn(PYTHON,[
    '-m','scripts.research_forming_candle_forward_score',
    '--serve','--models',MODEL_ROOT,'--training-report',REPORT,
  ],{cwd:ENGINE,stdio:['pipe','pipe','pipe'],
     env:{...process.env,OPENBLAS_NUM_THREADS:'1',OMP_NUM_THREADS:'1'}});
  let ready=false,buf='',serial=0;
  const pending=new Map();
  child.stdout.on('data',chunk=>{
    buf+=chunk.toString();
    let index;
    while((index=buf.indexOf('\n'))>=0){
      const line=buf.slice(0,index);buf=buf.slice(index+1);
      let msg;try{msg=JSON.parse(line);}catch{continue;}
      if(msg.kind==='READY'&&msg.artifact===ARTIFACT&&msg.tradingAuthority===false){
        ready=true;
        console.log('PROSPECTIVE_FORMING_SCORER_READY',JSON.stringify({at:new Date().toISOString(),researchOnly:true}));
        continue;
      }
      const task=pending.get(msg.id);
      if(!task)continue;
      clearTimeout(task.timer);pending.delete(msg.id);
      if(msg.kind==='SCORE'&&msg.artifact===ARTIFACT&&
         msg.brokerOrderAuthority===false&&msg.modifiesExecution===false&&
         Array.isArray(msg.predictions))task.resolve(msg.predictions);
      else task.reject(Error(String(msg.error||'UNSAFE_SCORING_RESPONSE').slice(0,180)));
    }
  });
  child.stderr.on('data',data=>console.error('PROSPECTIVE_PYTHON_ERROR',data.toString().slice(0,180)));
  child.on('exit',(code,signal)=>{
    ready=false;
    for(const task of pending.values()){
      clearTimeout(task.timer);task.reject(Error('SCORER_PROCESS_EXITED'));
    }
    pending.clear();
    console.error('PROSPECTIVE_SCORER_STOPPED',JSON.stringify({code,signal}));
    process.exitCode=1;
    process.exit(1);
  });
  return {
    isReady:()=>ready,
    async predict(snaps,bars,decisionAt){
      if(!ready)throw Error('SCORER_NOT_WARM');
      const id=++serial;
      return new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>{pending.delete(id);reject(Error('SCORER_DEADLINE_EXCEEDED'));},3500);
        pending.set(id,{resolve,reject,timer});
        child.stdin.write(JSON.stringify({id,request:{mode:'RESEARCH_ONLY',
          brokerOrderAuthority:false,decisionAt,snapshots:snaps,priorBars:bars}})+'\n');
      });
    },
    stop(){child.kill('SIGTERM');},
  };
}
async function runStage(db,connection,slot,seen,scorer){
  if(!scorer.isReady())return {skipped:'SCORER_WARMING_UP'};
  if(scoreSlot(Date.now())!==slot)return {skipped:'EXPIRED_BEFORE_READ'};
  const source=loadStageSnapshots(slot);
  if(!source.length)return {skipped:'NO_ASOF_SOURCE'};
  const eligible=source.filter(x=>!seen.has(predictionKey(x)));
  if(!eligible.length)return {skipped:'DUPLICATE_FORECAST'};
  const bars=await readPriorBars(db,connection,eligible);
  if(scoreSlot(Date.now())!==slot)return {skipped:'EXPIRED_AFTER_READ'};
  const results=await scorer.predict(eligible,bars,new Date(slot).toISOString());
  if(scoreSlot(Date.now())!==slot)return {skipped:'EXPIRED_DURING_SCORE'};
  for(const x of results)if(!eligible.some(s=>predictionKey(s)===predictionKey(x)))
    throw Error('UNKNOWN_PROSPECTIVE_FORECAST_SOURCE');
  return appendPredictions(results,{seen});
}
async function main(){
  if(!process.argv.includes('--watch'))throw Error('RESEARCH_WATCH_FLAG_REQUIRED');
  require('dotenv').config({path:path.join(__dirname,'..','.env'),quiet:true});
  const {Client}=require('pg'),owner=process.env.VPS_FOREX_SCANNER_USER_ID;
  if(!owner)throw Error('EXACT_OWNER_SCOPE_REQUIRED');
  const db=new Client({host:process.env.DB_HOST,
    port:Number(process.env.DB_PORT||5432),database:process.env.DB_NAME,
    user:process.env.DB_USER,password:process.env.DB_PASSWORD,
    ssl:process.env.DB_SSL==='true'?{rejectUnauthorized:false}:false,
    statement_timeout:6500});
  await db.connect();
  const connection=await getConnection(db,owner),seen=restoreSeen();
  const scorer=createWarmScorer();
  let last=null,busy=false,count=0,written=0;
  const step=async()=>{
    if(busy)return;
    const slot=scoreSlot(Date.now());
    if(slot===null||slot===last)return;
    busy=true;last=slot;
    try{
      const r=await runStage(db,connection,slot,seen,scorer);
      if(['SCORER_WARMING_UP','NO_ASOF_SOURCE'].includes(r.skipped))last=null;
      count++;written+=(r.written||0);
      if(r.written||count%12===1)console.log('PROSPECTIVE_FORMING_CANDLE_SHADOW',
        JSON.stringify({at:new Date().toISOString(),stage:new Date(slot).toISOString(),
          count,written,result:r,researchOnly:true,brokerOrders:false,sqlWrites:false}));
      if(count%100===1)pruneSnapshots(ROOT,new Date());
    }catch(e){
      if(scoreSlot(Date.now())===slot)last=null;
      console.error('PROSPECTIVE_FORMING_CANDLE_REJECTED',JSON.stringify({
        at:new Date().toISOString(),stage:new Date(slot).toISOString(),
        error:String(e.message).slice(0,280),tradingUnchanged:true}));
    }finally{busy=false;}
  };
  await step();const timer=setInterval(()=>void step(),1000);
  const stop=()=>{clearInterval(timer);scorer.stop();db.end().catch(()=>{});process.exit(0)};
  process.on('SIGINT',stop);process.on('SIGTERM',stop);
}
module.exports={ARTIFACT,ROOT,scoreSlot,stageTimeframes,predictionKey,
  loadStageSnapshots,restoreSeen,appendPredictions,readPriorBars,runStage};
if(require.main===module)main().catch(e=>{console.error('PROSPECTIVE_FORMING_FATAL',String(e.message).slice(0,240));process.exitCode=1});
