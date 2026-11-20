'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const rapid=require('./owner-demo-subminute-recovery-shadow.cjs');
const watch=require('./watch-owner-demo-recovery-risk-shadow.cjs');
const base=Date.parse('2026-11-20T17:00:30.000Z');
const iso=x=>new Date(x).toISOString();
const opened=base-22000;
const row=(x={})=>({
 trade_id:'6ed0ae55-4e31-4d22-9074-55c97800397a',
 broker_connection_id:'dde65a12-70e1-4d6b-97bb-5af2384d8714',
 route:'CONFIRMED_REVERSAL',instrument:'USDJPY',direction:'SELL',
 status:'OPEN',opened_at:iso(opened),fill_price:'158.714',
 stop_loss:'158.762',lot_size:'7',realised_pnl:null,commission:null,swap:null,
 max_favorable_pnl:'10',profit_giveback:'30',
 sizing_inputs:{demoExecutionRiskEnvelope:{historicalFeePerLot:6}},
 ...x,
});
function quote(at=base-2000,vals={}){
 const bucket=Math.floor(at/60000)*60000;
 return {instrument:'USDJPY',timeframe:'M1',source:'ctrader-broker-native',
  bucket_time:iso(bucket),created_at:iso(bucket+100),
  updated_at:iso(at+400),last_positive_sample_at:iso(at),
  sample_count:10,positive_quote_sample_count:8,
  last_positive_bid:'158.720',last_positive_ask:'158.722',...vals};
}
const marker={activatedAt:iso(base-10*60000),
 rapidActivatedAt:iso(opened-3000),
 earlyCautionActivatedAt:iso(base-60*60000)};
test('valid as-of OPEN quote accepts positive-spread forming M1 before first minute',()=>{
 const a=rapid.freshFormingNativeQuote(quote(),base,iso(opened));
 assert.ok(a);
 assert.equal(a.finalizedCandle,false);
 assert.equal(a.asOfAtCapture,true);
 assert.equal(a.brokerFillEvidence,false);
 assert.ok(a.spreadPips>0);
});
test('subminute quote guard rejects stale, future, preopen, no-spread and wrong source',()=>{
 for(const c of [
  {last_positive_sample_at:iso(opened-1000)},
  {last_positive_sample_at:iso(base+1000)},
  {last_positive_sample_at:iso(base-11000)},
  {updated_at:iso(base+1000)},
  {created_at:iso(base+1000)},
  {last_positive_ask:'158.720'},
  {positive_quote_sample_count:1},
  {sample_count:1},
  {source:'twelve-data'},
  {timeframe:'M5'},
  {last_positive_ask:'158.780'},
 ])assert.equal(rapid.freshFormingNativeQuote(quote(base-2000,c),base,iso(opened)),null,
  JSON.stringify(c));
});
test('rapid mark is read-only, after-cost and near original immutable stop',()=>{
 const q=rapid.freshFormingNativeQuote(quote(),base,iso(opened));
 const s=rapid.evaluateRapid(row(),q,null,42,base);
 assert.equal(s.status,'VALID_ASOF_SUBMINUTE_OBSERVATION');
 assert.equal(s.noBrokerOrders,true);
 assert.equal(s.noProfitProtectionChanges,true);
 assert.equal(s.noPredictionProbability,true);
 assert.equal(s.noStopAmendments,true);
 assert.equal(s.estimatedNetAfterFeeUsd<0,true);
 assert.equal(s.strongSubminuteWarning,false);
 assert.equal(s.state,'NO_VALID_SUBMINUTE_DIRECTION_COMPARISON');
});
test('near-stop warning requires two causal marks separated by 5-35s',()=>{
 const q=rapid.freshFormingNativeQuote(quote(base-2000,{
  last_positive_bid:'158.755',last_positive_ask:'158.757'}),base,iso(opened));
 const prior={quoteSampledAt:iso(base-11000),quoteSidePrice:158.730,
  estimatedNetAfterFeeUsd:-20};
 const s=rapid.evaluateRapid(row(),q,prior,42,base);
 assert.equal(s.state,'FAST_APPROACHING_ORIGINAL_STOP_WATCH');
 assert.equal(s.strongSubminuteWarning,true);
 assert.ok(s.initialStopHeadroomR<.35);
 assert.equal(s.preCloseDecisionSnapshotOnly,true);
});
test('warning is research-only and a still-positive net fade can recover later',()=>{
 const q=rapid.freshFormingNativeQuote(quote(base-2000,{
  last_positive_bid:'158.684',last_positive_ask:'158.686'}),base,iso(opened));
 const prior={quoteSampledAt:iso(base-11000),quoteSidePrice:158.677,
  estimatedNetAfterFeeUsd:110};
 const s=rapid.evaluateRapid(row(),q,prior,42,base);
 assert.equal(s.state,'FAST_STILL_POSITIVE_NET_FADE_WATCH');
 assert.equal(s.observedStillNetPositiveFade,true);
 assert.ok(s.estimatedNetRemainingAtCautionUsd>0);
 assert.equal(s.brokerExecutableCloseUnverified,true);
 assert.equal(s.noBrokerOrders,true);
});
test('a trade already closed and a rapid quote from before activation cannot be enrolled',()=>{
 const t=row();
 const exists=watch.enroll(t,marker,base);
 assert.ok(exists);
 const now=base;
 const bad={...t,status:'CLOSED'};
 const before={...marker,rapidActivatedAt:iso(opened+1000)};
 const r=watch.plan(bad,exists,before,now,[],quote());
 assert.equal(r.entry.rapidSamples.length,0);
 const past=watch.plan(t,exists,before,now,[],quote());
 assert.equal(past.entry.rapidSamples.length,0);
});
test('watcher archives new native quote only when trade remains OPEN and activation precedes OPEN',()=>{
 const t=row(),prev=watch.enroll(t,marker,base);
 assert.ok(prev);
 const t1=watch.plan(t,prev,marker,base,[],quote());
 assert.equal(t1.entry.rapidSamples.length,1);
 assert.equal(t1.entry.rapidSamples[0].noBrokerOrders,true);
 assert.ok(t1.events.some(e=>e.stage==='PROSPECTIVE_SUBMINUTE_OPEN_NATIVE_QUOTE'));
 const s2=watch.plan(t,t1.entry,marker,base+4000,[],quote(base+2200));
 assert.equal(s2.entry.rapidSamples.length,1);
 const s3=watch.plan(t,s2.entry,marker,base+12000,[],quote(base+10000));
 assert.equal(s3.entry.rapidSamples.length,2);
 assert.equal(s3.entry.rapidSamples[1].noTradingAuthority,undefined);
 assert.equal(s3.entry.rapidSamples[1].noBrokerOrders,true);
});
test('rapid simulation never retroactively starts on previously opened position',()=>{
 const t=row(),pre=watch.enroll(t,marker,base);
 const m={...marker,rapidActivatedAt:iso(opened+1000)};
 const r=watch.plan(t,pre,m,base,[],quote());
 assert.equal(r.entry.rapidSamples.length,0);
});
test('rapid labels count true broker settlements once even when position emitted three marks',()=>{
 const a={tradeId:'a',openedAt:iso(base-30000),
  rapidSamples:[{strongSubminuteWarning:true,observedStillNetPositiveFade:true},
   {strongSubminuteWarning:true,observedStillNetPositiveFade:false},
   {strongSubminuteWarning:false}],
  settled:{closedAt:iso(base+9000),netUsd:-275.68}};
 const b={tradeId:'b',openedAt:iso(base-30000),rapidSamples:[
  {strongSubminuteWarning:true,observedStillNetPositiveFade:false}],
  settled:{closedAt:iso(base+20000),netUsd:50}};
 const c={tradeId:'c',openedAt:iso(base-30000),rapidSamples:[],
  settled:{closedAt:iso(base+10000),netUsd:-2}};
 const s=rapid.forwardSummary([a,b,c]);
 assert.equal(s.observations,4);
 assert.equal(s.flaggedDistinctTrades,2);
 assert.equal(s.flaggedSettledWinners,1);
 assert.equal(s.flaggedSettledLosers,1);
 assert.equal(s.postEnrolmentClosedWithin60s,3);
 assert.equal(s.rapidClosesWithoutValidOpenQuote,1);
 assert.equal(s.rapidCloseBrokerNetUsd,-227.68);
 assert.equal(s.noHypotheticalSavedMoneyClaim,true);
 assert.equal(s.autoExitDisabled,true);
});
test('separate rapid watcher activation cannot be tampered with or auto-enabled',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'irexpro-rapid-'));
 const owner='6ed0ae55-4e31-4d22-9074-55c97800397a',conn='dde65a12-70e1-4d6b-97bb-5af2384d8714';
 try{
  const a=watch.setupRapid(root,owner,conn,base);
  assert.equal(a.artifact,rapid.ARTIFACT);
  assert.equal(a.maxQuoteAgeSeconds,10);
  assert.equal(a.autoClose,false);
  assert.deepEqual(watch.setupRapid(root,owner,conn,base+4000),a);
  const file=path.join(root,'subminute-quote-activation.json');
  fs.writeFileSync(file,JSON.stringify({...a,autoClose:true}));
  assert.throws(()=>watch.setupRapid(root,owner,conn,base+6000),/INVALID_FROZEN_RAPID_ACTIVATION/);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('rapid quotes query remains exact connection native M1 source and DB read-only',()=>{
 assert.ok(watch.RAPID_QUOTES_SQL.includes('connection_id=$1'));
 assert.ok(watch.RAPID_QUOTES_SQL.includes("source='ctrader-broker-native'"));
 assert.ok(watch.RAPID_QUOTES_SQL.includes("timeframe='M1'"));
 assert.ok(watch.RAPID_QUOTES_SQL.includes('instrument=ANY($2::text[])'));
 assert.doesNotMatch(watch.RAPID_QUOTES_SQL,/\b(?:INSERT|UPDATE|DELETE|TRUNCATE)\b/i);
});

test('rapid forward scoreboard strictly excludes previously reviewed fast broker-close losses',()=>{
 const old={tradeId:'old',openedAt:iso(base-100000),rapidSamples:[],
  settled:{closedAt:iso(base-60000),netUsd:-275.68}};
 const next={tradeId:'new',openedAt:iso(base+1000),rapidSamples:[],
  settled:{closedAt:iso(base+40000),netUsd:-40}};
 const r=rapid.forwardSummary([old,next],iso(base));
 assert.equal(r.postEnrolmentClosedWithin60s,1);
 assert.equal(r.rapidClosesWithoutValidOpenQuote,1);
 assert.equal(r.rapidCloseBrokerNetUsd,-40);
 assert.equal(r.strongWarningObservations,0);
 assert.equal(r.autoExitDisabled,true);
});
