'use strict';
const{test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {validRecord,prepareIndex,addRecord,loadSamples,sampledSide,audit,
 REPLAY_WATCH_INTERVAL_MS}=require('./audit-pepperstone-sampled-exit-path.cjs');
const minute=60*1000;
const start=Date.parse('2026-11-16T19:02:00Z');
const clock=n=>new Date(start+n*minute).toISOString();
const sample=(mins,bid,ask,pair='EURUSD')=>[
 clock(mins),new Date(start+mins*minute+2000).toISOString(),
 pair,bid,ask,
];
const e={
 instrument:'EURUSD',direction:'BUY',oppositeDirection:'SELL',
 evaluated_at:clock(0),planb_route:'CONFIRMED_REVERSAL',
 stop_distance:'0.0005',target_distance:'0.0008',planbQuality:0.7,
};
function markBook(records){return records;}
test('archival replay runs no more than once per 15 minutes in watch mode',()=>{
 assert.equal(REPLAY_WATCH_INTERVAL_MS,15*60_000);
});
test('strict sample validation rejects retroactive or impossible quote timestamps',()=>{
 assert.equal(validRecord(sample(1,1.10,1.1001)),true);
 assert.equal(validRecord(sample(1,1.10,1.10)),false);
 assert.equal(validRecord(sample(1,1.10,1.1001,'BADPAIR')),false);
 const future=sample(1,1.10,1.1001);
 future[1]=new Date(start+60_000-1000).toISOString();
 assert.equal(validRecord(future),false);
 const stale=sample(1,1.10,1.1001);
 stale[1]=new Date(start+60_000+20_000).toISOString();
 assert.equal(validRecord(stale),false);
});
test('sampled BUY stop observed before target, opposite SELL target seen first',()=>{
 const rows=[
  sample(0.05,1.1000,1.1001),
  sample(0.5,1.1001,1.1002),
  sample(1,1.0990,1.0991),
  sample(2,1.1009,1.1010),
  sample(2.95,1.1008,1.1009),
 ];
 const buy=sampledSide(e,rows,'BUY',3);
 assert.equal(buy.firstObservedTouch.status,'FIRST_OBSERVED_STOP_LEVEL');
 assert.equal(buy.brokerFillVerified,false);
 const sell=sampledSide(e,rows,'SELL',3);
 assert.equal(sell.firstObservedTouch.status,'FIRST_OBSERVED_TARGET_LEVEL');
 assert.equal(sell.status,'COMPARABLE_WITH_SAMPLING_GAPS');
});
test('fixed-hold mark includes quote spread, commission and slippage',()=>{
 const rows=[sample(0.05,1.1000,1.1001),
  sample(1,1.1002,1.1003),
  sample(2,1.1003,1.1004),
  sample(2.99,1.1004,1.1005)];
 const buy=sampledSide(e,rows,'BUY',3);
 assert.equal(buy.estimatedFixedHoldNetPips,2.2);
 assert.equal(buy.estimatedFixedHoldNetUsdPerStandardLot,22);
 const sell=sampledSide(e,rows,'SELL',3);
 assert.equal(sell.estimatedFixedHoldNetPips,-5.8);
});
test('a delayed entry or empty saved quote interval stays unknown',()=>{
 assert.equal(sampledSide(e,[],'BUY',3).status,
 'UNKNOWN_NO_PROMPT_ASOF_ENTRY_SNAPSHOT');
 assert.equal(sampledSide(e,[sample(0.25,1.1,1.1001)],'BUY',3).status,
 'UNKNOWN_NO_PROMPT_ASOF_ENTRY_SNAPSHOT');
 const records=[sample(0.05,1.1000,1.1001),sample(1,1.1002,1.1003)];
 assert.equal(sampledSide(e,records,'BUY',3).status,
 'UNKNOWN_NO_NEAR_HORIZON_SNAPSHOT');
});
test('overlapping episode windows share only eligible instrument observations',()=>{
 const episode2={...e,evaluated_at:clock(16)};
 const index=prepareIndex([e,episode2]);
 const assigned=new Map();
 assert.equal(addRecord(sample(16.5,1.1000,1.1001),index,assigned),true);
 assert.equal(assigned.get(0).length,1);
 assert.equal(assigned.get(1).length,1);
 assert.equal(addRecord(sample(1,1.1000,1.1001,'USDJPY'),
  index,assigned),true);
 assert.equal(assigned.get(0).length,1);
});
test('read-only forward report is required and missing past samples stay unknown',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'irexpro-sampled-'));
 try{
  const src={artifact:'irexpro-forward-direction-side-calibration-v1',
   authority:'SHADOW_ONLY',modifiesExecution:false,placesOrders:false,
   episodes:[e]};
  const out=await audit(src,dir,new Date('2026-11-16T19:30:00Z'));
  assert.equal(out.byHorizon['3'].chosenComparable,0);
  assert.equal(out.episodes[0].sampled['3'].chosen.status,
   'UNKNOWN_NO_PROMPT_ASOF_ENTRY_SNAPSHOT');
  await assert.rejects(()=>audit({...src,placesOrders:true},dir),
   /NOT_A_VERIFIED_READONLY_FORWARD_REPORT/);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('timestamped append-only file input is streamed and matched to right episode',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'irexpro-quote-feed-'));
 try{
  const file=path.join(dir,'2026-11-16.jsonl');
  const rows=[sample(0.05,1.1,1.1001),sample(1,1.1003,1.1004)];
  fs.writeFileSync(file,rows.map(v=>JSON.stringify(v)).join('\n')+'\n');
  const result=await loadSamples([e],dir);
  assert.equal(result.accepted,2);
  assert.equal(result.assigned.get(0).length,2);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('multi-day summaries retain per-day research cohorts without hindsight selection',()=>{
 const {groupSummary}=require('./audit-pepperstone-sampled-exit-path.cjs');
 const v={status:'SAMPLED_PATH_COMPARABLE',
  estimatedFixedHoldNetPips:1,firstObservedTouch:{status:'NO_TOUCH_OBSERVED_NOT_PROOF_OF_SURVIVAL'}};
 const cases=[
  {evaluatedAt:'2026-11-16T19:10:00Z',route:'EARLY_TRANSITION',
   sampled:{3:{chosen:v,opposite:v},5:{chosen:v,opposite:v},10:{chosen:v,opposite:v},15:{chosen:v,opposite:v}}},
  {evaluatedAt:'2026-11-17T19:10:00Z',route:'CONFIRMED_REVERSAL',
   sampled:{3:{chosen:v,opposite:v},5:{chosen:v,opposite:v},10:{chosen:v,opposite:v},15:{chosen:v,opposite:v}}},
 ];
 const groups=groupSummary(cases);
 assert.equal(Object.keys(groups.byDay).length,2);
 assert.equal(groups.byDay['2026-11-16']['15'].chosenComparable,1);
 assert.equal(groups.byDay['2026-11-17']['15'].chosenComparable,1);
 assert.equal(groups.byRoute.EARLY_TRANSITION['15'].chosenComparable,1);
});
test('daily sampled path archives are immutable, private and restricted to shadow',()=>{
 const {archiveFinalizedSampled}=require('./audit-pepperstone-sampled-exit-path.cjs');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'irexpro-path-finalized-'));
 try{
  const report={
   artifact:'irexpro-sampled-broker-asof-path-v1',
   authority:'SHADOW_ONLY',modifiesExecution:false,placesOrders:false,
   byDay:{'2026-11-16':{'15':{selected:1,chosenComparable:0}}},
   episodes:[{evaluatedAt:'2026-11-16T19:10:00Z'}],
   limitations:['not tick-exact'],
  };
  assert.deepEqual(archiveFinalizedSampled(report,dir,
   new Date('2026-11-17T00:19:59Z')),[]);
  assert.deepEqual(archiveFinalizedSampled(report,dir,
   new Date('2026-11-17T00:20:00Z')),['2026-11-16']);
  const file=path.join(dir,'finalized-path','2026-11-16.json');
  const initial=fs.readFileSync(file,'utf8');
  assert.equal(fs.statSync(file).mode&0o777,0o600);
  assert.deepEqual(archiveFinalizedSampled(report,dir,
   new Date('2026-11-18T00:20:00Z')),[]);
  assert.equal(fs.readFileSync(file,'utf8'),initial);
  assert.throws(()=>archiveFinalizedSampled({...report,placesOrders:true},
   dir,new Date('2026-11-18T00:20:00Z')), /UNSAFE_ARCHIVE_SOURCE/);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('sparse samples never imply verified stop/target ordering',()=>{
 const rows=[sample(0.05,1.1000,1.1001),
   sample(0.90,1.0991,1.0992),
   sample(2.99,1.0990,1.0991)];
 const reviewed=sampledSide(e,rows,'BUY',3);
 assert.equal(reviewed.status,'COMPARABLE_WITH_SAMPLING_GAPS');
 assert.equal(reviewed.coverage.quotePathCoverage,'SPARSE_SAMPLES');
 assert.equal(reviewed.coverage.stopTargetOrderingProven,false);
 assert.equal(reviewed.firstObservedTouch.status,'FIRST_OBSERVED_STOP_LEVEL');
 assert.equal(reviewed.firstObservedTouch.mayHaveMissedEarlierCrossing,true);
 assert.ok(reviewed.firstObservedTouch.precedingUnobservedGapMs>30_000);
});
test('a dense recorded quote path remains comparable but cannot verify broker fill',()=>{
 const rows=[sample(0.05,1.1000,1.1001)];
 for(let j=1;j<=180;j++){
  const tick=0.05+j*2/60;
  rows.push(sample(tick,1.1002,1.1003));
 }
 const result=sampledSide(e,rows,'BUY',3);
 assert.equal(result.status,'SAMPLED_PATH_COMPARABLE');
 assert.equal(result.coverage.quotePathCoverage,'FREQUENT_SAMPLES');
 assert.equal(result.brokerFillVerified,false);
 const {summarize}=require('./audit-pepperstone-sampled-exit-path.cjs');
 const stats=summarize([{sampled:{3:{chosen:result,opposite:result}}}]);
 assert.equal(stats['3'].chosenFrequentOrModerateSamples,1);
 assert.equal(stats['3'].chosenCoverageQuality.FREQUENT_SAMPLES,1);
});
