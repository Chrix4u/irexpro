'use strict';
const{test}=require('node:test'),assert=require('node:assert/strict');
const {START,SQL_SESSION,SQL_SIGNALS,SQL_QUOTES,selectEpisodes,
 evaluateEpisode,bucket,summary}=require('./audit-pepperstone-forward-direction-calibration.cjs');
const at=(m,s=10)=>'2026-11-16T18:'+String(m).padStart(2,'0')+':'+String(s).padStart(2,'0')+'Z';
const row=(min,side,score,options={})=>({
 instrument:'EURUSD',direction:side,bar_time:at(min,0),
 evaluated_at:at(min,side==='BUY'?10:14),
 planb_route:'CONFIRMED_REVERSAL',ensemble_score:String(score),
 planb_quality:'0.7',admitted:'true',governance_eligible:'true',
 m1_route:'ABSTAIN',stop_distance:'0.0005',target_distance:'0.0008',
 ...options,
});
const q=(min,bid,ask)=>({
 bucket_time:at(min,0),last_quote_sample_at:at(min,55),
 bid_close:bid,ask_close:ask,
 positive_quote_sample_count:5,source:'ctrader-broker-native',
});
const book=new Map([['EURUSD',new Map([
 [Date.parse(at(1,0)),q(1,1.1,1.1001)],
 [Date.parse(at(6,0)),q(6,1.1003,1.1004)],
])]]);
test('two contemporaneous candidates compare their as-of scores, not BUY-first iteration',()=>{
 const r=selectEpisodes([row(0,'BUY',0.6),row(0,'SELL',0.7)]);
 assert.equal(r.episodes.length,1);
 assert.equal(r.episodes[0].direction,'SELL');
 assert.equal(r.episodes[0].oppositeDirection,'BUY');
 assert.equal(r.episodes[0].sameBarOppositeObserved,true);
 assert.equal(r.episodes[0].evaluated_at,new Date(at(0,14)).toISOString());
});
test('even a later stronger candidate cannot replace the first selected episode within 15 minutes',()=>{
 const r=selectEpisodes([
  row(0,'BUY',0.62),row(0,'SELL',0.6),
  row(5,'SELL',0.99),row(5,'BUY',0.5),
  row(16,'SELL',0.7),row(16,'BUY',0.6),
 ]);
 assert.deepEqual(r.episodes.map(x=>x.direction),['BUY','SELL']);
 assert.equal(r.skipped.overlap,1);
});
test('opposite-side hypothetical mark never becomes a broker order',()=>{
 const e=selectEpisodes([row(0,'BUY',0.71),row(0,'SELL',0.6)]).episodes[0];
 const result=evaluateEpisode(e,book).outcomes[5];
 assert.equal(result.status,'PAIR_COMPARABLE');
 assert.equal(result.chosenNetPips,1.2);
 assert.equal(result.reverseNetPips,-4.8);
 assert.equal(result.firstHitStopLoss,'NOT_EVALUATED');
 const stats=bucket([evaluateEpisode(e,book)],5);
 assert.equal(stats.chosenWins,1);
 assert.equal(stats.counterWins,0);
 assert.equal(stats.chosenNormalizedNetUsd,12);
 assert.equal(stats.counterNormalizedNetUsd,-48);
});
test('missing bid/ask marks remain unknown rather than profitable',()=>{
 const e=selectEpisodes([row(0,'BUY',0.71)]).episodes[0];
 const marks=evaluateEpisode(e,new Map());
 assert.equal(marks.outcomes[5].status,'MISSING_NATIVE_BID_ASK');
 const stats=summary([marks]).byHorizon[5];
 assert.equal(stats.observed,0);
 assert.equal(stats.chosenMeanNetPips,null);
 assert.equal(stats.missing,1);
});
test('tie on same-bar opposite scores is skipped, not assigned by ordering',()=>{
 const r=selectEpisodes([row(0,'BUY',0.65),row(0,'SELL',0.65)]);
 assert.equal(r.episodes.length,0);
 assert.equal(r.skipped.ambiguous,1);
});
test('only admitted and governance-qualified Plan-B decisions are eligible research candidates',()=>{
 const r=selectEpisodes([
  row(0,'BUY',0.75,{admitted:'false'}),
  row(1,'SELL',0.8,{governance_eligible:'false'}),
  row(2,'SELL',0.71,{planb_route:'UNKNOWN'}),
  row(3,'SELL',0.72,{ensemble_score:null}),
  row(4,'SELL',0.61),
 ]);
 assert.equal(r.episodes.length,1);
 assert.equal(r.episodes[0].evaluated_at,new Date(at(4,14)).toISOString());
 assert.equal(r.skipped.invalid,3);
 assert.equal(r.skipped.missingScore,1);
});
test('research SQL strictly scopes Pepperstone DEMO USD and prohibits mutations',()=>{
 assert.equal(START,'2026-11-16T17:50:00.000Z');
 assert.match(SQL_SESSION,/s\.user_id=\$1/);
 assert.match(SQL_SESSION,/s\.account_currency='USD'/);
 assert.match(SQL_SESSION,/b\.broker_id='pepperstone-ctrader'/);
 assert.match(SQL_SESSION,/b\.account_type='DEMO'/);
 assert.match(SQL_SIGNALS,/d\.broker_connection_id=\$2/);
 assert.match(SQL_SIGNALS,/d\.evaluated_at>=\$3/);
 assert.match(SQL_SIGNALS,/LIMIT 40001/);
 assert.match(SQL_QUOTES,/source='ctrader-broker-native'/);
 for(const sql of [SQL_SESSION,SQL_SIGNALS,SQL_QUOTES])
  assert.doesNotMatch(sql,/\b(?:INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE)\b/i);
});

test('pending qualified decisions are visible without prematurely scoring future prices',async()=>{
 const {run,SQL_PROGRESS}=require('./audit-pepperstone-forward-direction-calibration.cjs');
 const uuid='11111111-1111-4111-8111-111111111111';
 const queried=[];
 const db={query:async(sql,params)=>{
  queried.push([sql,params]);
  if(sql===SQL_SESSION)return {rows:[{id:'broker-demo'}]};
  if(sql===SQL_PROGRESS)return {rows:[{
   total_scans:96,paper_admitted:7,governance_eligible:5,
   qualified_total:5,qualified_pending:5,
   latest_scan_at:'2026-11-16T18:02:00Z',
   latest_qualified_at:'2026-11-16T18:00:00Z',
  }]};
  if(sql===SQL_QUOTES)return {rows:[q(2,1.1,1.1001)]};
  return {rows:[]};
 }};
 const report=await run(db,uuid,new Date('2026-11-16T18:03:00Z'));
 assert.equal(report.selectedEpisodes,0);
 assert.equal(report.telemetry.scannerDecisions,96);
 assert.equal(report.telemetry.jointlyQualified,5);
 assert.equal(report.telemetry.waitingForMaturity,5);
 assert.equal(report.telemetry.maturedQualified,0);
 assert.equal(report.telemetry.status,'QUALIFIED_SIGNALS_WAITING_FOR_OUTCOME');
 assert.equal(report.telemetry.nativeBrokerDataFresh,true);
 assert.equal(report.authority,'SHADOW_ONLY');
 assert.equal(report.placesOrders,false);
 assert.equal(queried[0][0],'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 assert.equal(queried[queried.length-1][0],'COMMIT');
 assert.match(SQL_PROGRESS,/d\.broker_connection_id=\$2/);
 assert.match(SQL_PROGRESS,/d\.evaluated_at >= \$5::timestamptz/);
 assert.doesNotMatch(SQL_PROGRESS,/\b(?:INSERT|UPDATE|DELETE|DROP|ALTER)\b/i);
});

test('prospective scores are reported by predeclared quality bands and instrument-side',()=>{
 const {qualityBand}=require('./audit-pepperstone-forward-direction-calibration.cjs');
 assert.equal(qualityBand(null),'UNKNOWN');
 assert.equal(qualityBand(0.54),'BELOW_0_55');
 assert.equal(qualityBand(0.55),'FROM_0_55_TO_0_60');
 assert.equal(qualityBand(0.60),'FROM_0_60_TO_0_65');
 assert.equal(qualityBand(0.65),'AT_LEAST_0_65');
 const e=selectEpisodes([
  row(0,'BUY',0.71,{planb_quality:'0.62'}),
  row(0,'SELL',0.60,{planb_quality:'0.50'}),
 ]).episodes[0];
 const report=summary([evaluateEpisode(e,book)]);
 assert.equal(report.byQualityBand.FROM_0_60_TO_0_65['5'].selected,1);
 assert.equal(report.byQualityBand.FROM_0_60_TO_0_65['5'].chosenWins,1);
 assert.equal(report.byInstrumentSide['EURUSD|BUY']['5'].counterWins,0);
 assert.equal(report.byM1Route.ABSTAIN['5'].observed,1);
});

test('finalized day evidence is archived once, after all outcomes mature',()=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
 const {archiveFinalizedDays,ARTIFACT}=require('./audit-pepperstone-forward-direction-calibration.cjs');
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'irexpro-dir-cal-'));
 try{
  const episode=evaluateEpisode(selectEpisodes([row(0,'BUY',0.71)]).episodes[0],book);
  const report={
   artifact:ARTIFACT,authority:'SHADOW_ONLY',
   modifiesExecution:false,placesOrders:false,
   generatedAt:'2026-11-17T00:19:59.000Z',
   byDay:{'2026-11-16':summary([episode]).byHorizon},
   episodes:[episode],
  };
  assert.deepEqual(archiveFinalizedDays(report,base),[]);
  report.generatedAt='2026-11-17T00:20:00.000Z';
  assert.deepEqual(archiveFinalizedDays(report,base),['2026-11-16']);
  const p=path.join(base,'daily','2026-11-16.json');
  const first=fs.readFileSync(p,'utf8');
  assert.equal(JSON.parse(first).cohort.byHorizon['5'].chosenWins,1);
  assert.equal(fs.statSync(p).mode&0o777,0o600);
  assert.deepEqual(archiveFinalizedDays(report,base),[]);
  assert.equal(fs.readFileSync(p,'utf8'),first);
  assert.throws(()=>archiveFinalizedDays({...report,placesOrders:true},base),
   /ARCHIVE_REQUIRES_VERIFIED_SHADOW_REPORT/);
 }finally{fs.rmSync(base,{recursive:true,force:true});}
});

test('matured-signal SELECT cannot contain the historical trailing-comma syntax failure',()=>{
 const {SQL_SIGNALS}=require('./audit-pepperstone-forward-direction-calibration.cjs');
 assert.doesNotMatch(SQL_SIGNALS,/,\s+FROM\s+trading\.m1_tactical_decisions/i);
 assert.match(SQL_SIGNALS,/targetDistance' AS target_distance FROM/i);
});

test('quote query uses timestamped positive-spread cTrader snapshots, never zero-spread close',()=>{
 const {SQL_QUOTES}=require('./audit-pepperstone-forward-direction-calibration.cjs');
 const {validQuote}=require('./audit-pepperstone-alternative-route-opportunities.cjs');
 assert.match(SQL_QUOTES,/last_positive_bid AS bid_close/);
 assert.match(SQL_QUOTES,/last_positive_ask AS ask_close/);
 assert.match(SQL_QUOTES,/last_positive_sample_at AS last_quote_sample_at/);
 assert.match(SQL_QUOTES,/last_positive_spread>0/);
 assert.equal(validQuote(q(1,1.1000,1.1001)),true);
 assert.equal(validQuote(q(1,1.1001,1.1001)),false);
 assert.equal(validQuote({...q(1,1.1000,1.1001),
   last_quote_sample_at:at(2,10)}),false);
});
