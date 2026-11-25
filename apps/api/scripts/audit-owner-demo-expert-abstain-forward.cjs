'use strict';
/** Exact-owner Pepperstone USD DEMO expert-ABSTAIN forward label study.
 * Deterministic 5-minute episodes, quote-spread + assumed commission/slippage.
 * READ ONLY: no trading authority, orders, changed risk/config, or model promotion.
 */
const fs=require('node:fs'),path=require('node:path'),readline=require('node:readline');
const ROOT='/home/lightworld/webapps/irexpro-research';
const PAIRS=new Set(['AUDUSD','EURUSD','USDJPY','USDCAD']);
const STUDY_DAYS=['2026-11-17','2026-11-18','2026-11-19','2026-11-20'];
const PIP_COST_ASSUMPTION=1.0; // Further 1.0 pip beyond observed bid/ask spread.
const RANGE_START_HOUR=20,RANGE_END_HOUR=22,HORIZON_MS=300000,ENTRY_TOLERANCE_MS=12000,EXIT_TOLERANCE_MS=12000;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const finite=v=>v==null||v===''?null:Number.isFinite(Number(v))?Number(v):null;
function band(p){return p<0.20?'0.00-0.20':p<0.30?'0.20-0.30':p<0.40?'0.30-0.40':'0.40-1.00'}
function select(rows){
 const used=new Set(),out=[];
 for(const r of [...rows].sort((a,b)=>Date.parse(a.created_at)-Date.parse(b.created_at))){
  const e=r.governance?.multimodelTrainedExpert||{};
  const p=finite(e.meanOpportunityProbability),t=Date.parse(r.created_at);
  const expertAt=Date.parse(e.decisionTime);
  if(!PAIRS.has(r.instrument)||!['BUY','SELL'].includes(r.direction)||
    !['ABSTAIN','CONFIRM','CONFLICT'].includes(e.state)||
    e.allBrokerNative!==true||!['BUY','SELL'].includes(e.direction)||
    e.direction!==r.direction||p===null||p<0||p>1||
    !Number.isFinite(t)||!Number.isFinite(expertAt)||
    expertAt>t||t-expertAt>300000)continue;
  const key=[r.instrument,e.direction,Math.floor(t/300000)].join('|');
  if(used.has(key))continue;
  used.add(key);
  out.push({instrument:r.instrument,side:e.direction,signalAt:r.created_at,
   hour:new Date(t).getUTCHours(),day:new Date(t).toISOString().slice(0,10),
   expertState:e.state,expertAdmitted:e.admitted===true,
   expertP:p,ensembleConfidence:finite(e.ensembleConfidence),
   votes:e.direction==='BUY'?e.longVotes:e.shortVotes,
   planBRoute:r.governance?.multimodelEnsemble?.strategyRoute??'UNKNOWN',
   planBAdmitted:r.governance?.multimodelEnsemble?.paperAdmitted===true,
   m1Route:r.route??'UNKNOWN'});
 }
 return out;
}
function quoteValue(q){
 if(!Array.isArray(q)||q.length<5)return null;
 const t=Date.parse(q[0]),bid=finite(q[3]),ask=finite(q[4]);
 if(!Number.isFinite(t)||!Number.isFinite(bid)||!Number.isFinite(ask)||!(bid>0)||!(ask>=bid))return null;
 return {t,bid,ask};
}
function firstInWindow(sorted,target,tolerance){
 // Never take a quote earlier than the decision or future horizon.
 let l=0,h=sorted.length;
 while(l<h){const m=(l+h)>>1;if(sorted[m].t<target)l=m+1;else h=m}
 return l<sorted.length && sorted[l].t-target<=tolerance?sorted[l]:null;
}
function label(s,quotes,horizonMs=HORIZON_MS){
 const list=quotes[s.instrument]||[],at=Date.parse(s.signalAt);
 const enter=firstInWindow(list,at,ENTRY_TOLERANCE_MS);
 if(!enter)return {...s,outcome:'UNKNOWN_ENTRY_QUOTE',netPips:null};
 const exit=firstInWindow(list,at+horizonMs,EXIT_TOLERANCE_MS);
 if(!exit)return {...s,outcome:'UNKNOWN_EXIT_QUOTE',netPips:null};
 const pip=s.instrument.endsWith('JPY')?0.01:0.0001;
 // BUY pays ask at entry, receives bid at exit; SELL inverse.
 const raw=s.side==='BUY'?(exit.bid-enter.ask):(enter.bid-exit.ask);
 const netPips=Number((raw/pip-PIP_COST_ASSUMPTION).toFixed(3));
 return {...s,outcome:'SAMPLED_5M_MARK_NOT_BROKER_FILL',
   entryQuoteAt:new Date(enter.t).toISOString(),
   exitQuoteAt:new Date(exit.t).toISOString(),
   netPips,positive:netPips>0};
}
function stats(items){
 const observed=items.filter(x=>x.netPips!=null),net=observed.reduce((a,x)=>a+x.netPips,0);
 const positives=observed.filter(x=>x.netPips>0).length;
 const probs=observed.reduce((a,x)=>a+x.expertP,0);
 return {selected:items.length,observed:observed.length,
  unknown:items.length-observed.length,positives,
  positiveFraction:observed.length?Number((positives/observed.length).toFixed(4)):null,
  sumNetPips:Number(net.toFixed(3)),
  meanNetPips:observed.length?Number((net/observed.length).toFixed(4)):null,
  meanExpertOpportunityP:observed.length?Number((probs/observed.length).toFixed(4)):null,
 };
}
function group(items,fn){
 const groups={};for(const x of items)(groups[String(fn(x))]??=[]).push(x);
 return Object.fromEntries(Object.entries(groups).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,stats(v)]))
}
async function readQuotes(day,instruments){
 const fname=path.join(ROOT,'native-quote-snapshots',day+'.jsonl');
 const out=Object.fromEntries([...instruments].map(k=>[k,[]]));
 if(!fs.existsSync(fname))return out;
 const rl=readline.createInterface({input:fs.createReadStream(fname),crlfDelay:Infinity});
 for await(const line of rl){
  // Quotes are [native broker time, collection time, instrument, bid, ask].
  let q;try{q=JSON.parse(line)}catch{continue}
  if(!Array.isArray(q)||!instruments.has(q[2])||typeof q[0]!=='string')continue;
  const hour=Number(q[0].slice(11,13));
  if(hour<RANGE_START_HOUR||hour>RANGE_END_HOUR)continue;
  const v=quoteValue(q);if(v)out[q[2]].push(v);
 }
 for(const q of Object.values(out))q.sort((a,b)=>a.t-b.t);
 return out;
}
const SQL=`SELECT d.created_at,d.instrument,d.direction,d.route,d.governance
FROM trading.m1_tactical_decisions d
JOIN broker.broker_connections b ON b.id=d.broker_connection_id AND b.user_id=d.user_id
WHERE d.user_id=$1 AND d.broker_connection_id=$2
AND b.broker_id='pepperstone-ctrader' AND b.account_type='DEMO'
AND b.account_currency='USD' AND b.deleted_at IS NULL
AND d.created_at >= $3::timestamptz AND d.created_at < $4::timestamptz
ORDER BY d.created_at LIMIT 2200`;
async function main(){
 const api='/home/lightworld/webapps/irexpro-staging/apps/api';
 require(api+'/node_modules/dotenv').config({path:api+'/.env',quiet:true});
 const {Client}=require(api+'/node_modules/pg');
 const e=process.env,user=e.VPS_FOREX_SCANNER_USER_ID;
 const broker=e.IREXPRO_OWNER_PEPPERSTONE_DEMO_NOON_TRIAL_BROKER_CONNECTION_ID;
 if(!UUID.test(user||'')||!UUID.test(broker||''))throw Error('EXACT_OWNER_DEMO_SCOPE_UNAVAILABLE');
 const db=new Client({host:e.DB_HOST||'localhost',port:+(e.DB_PORT||5432),
  database:e.DB_NAME,user:e.DB_USER,password:e.DB_PASSWORD,
  ssl:e.DB_SSL==='true'?{rejectUnauthorized:false}:undefined,
  connectionTimeoutMillis:6000,statement_timeout:14000,
  application_name:'owner-native-expert-abstain-5min-readonly'});
 const all=[],all10=[],all15=[],limits=[];
 await db.connect();
 try{
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  for(const day of STUDY_DAYS){
   const start=day+'T20:00:00Z',end=day+'T22:00:00Z';
   const rows=(await db.query(SQL,[user,broker,start,end])).rows;
   limits.push({day,decisionRows:rows.length,truncatedAtLimit:rows.length===2200});
   const selected=select(rows);
   const quotes=await readQuotes(day,new Set(selected.map(x=>x.instrument)));
   for(const s of selected){all.push(label(s,quotes));all10.push(label(s,quotes,600000));all15.push(label(s,quotes,900000));}
  }
  await db.query('ROLLBACK');
 }catch(err){await db.query('ROLLBACK').catch(()=>{});throw err}
 finally{await db.end()}
 const report={artifact:'owner-native-expert-abstain-sampled-multihorizon-v2',
  generatedAt:new Date().toISOString(),scope:'EXACT_OWNER_PEPPERSTONE_CTRADER_USD_DEMO',
  period:'20:00–22:00 UTC, 2026-11-17 through 2026-11-20',
  mode:'RESEARCH_READ_ONLY',modifiesOrders:false,changesStops:false,
  changesModelThresholds:false,executionAuthority:'NONE',
  methodology:{episode:'FIRST expert-direction-aligned native observation per currency pair, expert direction and 5-minute UTC bucket',
   price:'FIRST broker-native sampled bid/ask at or after decision and each 5-, 10-, 15-minute mark, within 12 seconds',
   commissionAndSlippagePipsBeyondObservedSpread:PIP_COST_ASSUMPTION,
   horizonMinutes:[5,10,15],chargeOnlyOnObservedQuotes:true},
  sourceLimits:limits,total:stats(all),
  byHorizon:{5:stats(all),10:stats(all10),15:stats(all15)},
  byAdditionalCostPips:{
   0:stats(all.map(x=>x.netPips===null?x:{...x,netPips:Number((x.netPips+1).toFixed(3))})),
   0.5:stats(all.map(x=>x.netPips===null?x:{...x,netPips:Number((x.netPips+0.5).toFixed(3))})),
   1:stats(all),
  },
  byDay:group(all,x=>x.day),
  byProbabilityBand:group(all,x=>band(x.expertP)),
  byState:group(all,x=>x.expertState),
  byPlanBAdmitted:group(all,x=>String(x.planBAdmitted)),
  byVotes:group(all,x=>String(x.votes)),
  byPair:group(all,x=>x.instrument),
  labels:all,
  limitations:[
   'Broker-native quotes are sampled snapshots, not complete native ticks or executable broker fills.',
   'Fixed 5-, 10-, and 15-minute holding times are NOT the strategies actual stop/target exit paths.',
   'Fixed additional one-pip cost beyond observed bid/ask spread is a research proxy, not account-confirmed commission or slippage.',
   'Expert mean opportunity probability targets its own model opportunity event; its numerical value is NOT necessarily calibrated to the five-minute proxy win probability.',
   'First eligible episode per five-minute bucket avoids duplicate scanner decisions but does not eliminate overlap across instruments or create IID outcomes.',
   'Only expert-aligned directions were selected without consulting future results; opposing Plan-B cases are not automatically eligible trades.',
   'Signals missing a fresh entry or exit quote remain UNKNOWN and are never counted as losses or wins.',
   'The past 4 evenings are observational, not randomized or independently held-out for new thresholds.',
   'Neither apparent profitable subsets nor high model confidence are authorized to affect DEMO or LIVE orders.'
  ]};
 const output=path.join(ROOT,'expert-abstain-forward','latest-report.json');
 fs.mkdirSync(path.dirname(output),{recursive:true,mode:0o700});
 fs.writeFileSync(output,JSON.stringify(report,null,2),{mode:0o600});
 console.log('REPORT_PATH',output);
 console.log('RESULT',JSON.stringify({asOf:report.generatedAt,total:report.total,byDay:report.byDay,
  byProbabilityBand:report.byProbabilityBand,byState:report.byState,
  byHorizon:report.byHorizon,byAdditionalCostPips:report.byAdditionalCostPips,
  sourceLimits:report.sourceLimits}));
}
if(require.main===module){main().catch(e=>{console.error('READ_ONLY_EXPERT_FORWARD_FAILED',e.message);process.exitCode=1})}
module.exports={select,label,band,stats,quoteValue,firstInWindow,SQL};
