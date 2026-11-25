'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {
 ARTIFACT,validateTrade,record,lowerBound,firstObservedFromClose,
 fractionAtProgress,simulateMilestoneTrailing,summarize,SQL,
}=require('./audit-owner-demo-protected-profit-tp-trailing.cjs');
const {
 limitFraction,proposedAtClose,simulateHybrid,corroborateWickOrder,
}=require('./pepperstone-profit-lock-hybrid-trailing-shadow.cjs');
const MINUTE=60000;
const d=ms=>new Date(ms);
const open=Date.parse('2026-11-17T10:00:00Z');
const close=open+4*MINUTE;
const trade={
 trade_key:'internal-test',instrument:'EURUSD',direction:'BUY',strategy_route:'EARLY_TRANSITION',
 opened_at:d(open),closed_at:d(close),
 fill_price:'1.1000',exit_price:'1.1021',stop_loss:'1.0980',take_profit:'1.1040',
 lot_size:'1',realised_pnl:'210',commission:'-6',swap:'0',max_favorable_pnl:'250',
};
const t=validateTrade(trade);
const q=(delta,value)=>({
 at:open+delta,bid:value,ask:value+0.0001,
});
function validNativeBucket(at,low='1.101',high='1.102'){
 return {bucket_time:d(at),source:'ctrader-broker-native',
  low,high,sample_count:50,positive_quote_sample_count:48,
  last_positive_sample_at:d(at+45000)};
}
test('owner report SQL is read-only scoped and protected exits only',()=>{
 assert.equal(typeof ARTIFACT,'string');
 assert.match(SQL,/b.account_type='DEMO'/);
 assert.match(SQL,/t.user_id=\$1 AND b.user_id=\$1/);
 assert.match(SQL,/PROFIT_PROTECTION/);
 assert.match(SQL,/multimodel_plan_b_route/);
 assert.equal(SQL.includes('UPDATE'),false);
 assert.equal(SQL.includes('DELETE'),false);
});
test('trade financial settlement and directional broker geometry must be valid',()=>{
 assert.equal(t.actualNet,204);
 assert.equal(t.sgn,1);
 assert.equal(validateTrade({...trade,commission:'6'}),null);
 assert.equal(validateTrade({...trade,take_profit:'1.0999'}),null);
 assert.equal(validateTrade({...trade,stop_loss:'1.105'}),null);
 assert.equal(validateTrade({...trade,strategy_route:'TREND_CONTINUATION'}),null);
 assert.equal(validateTrade({...trade,lot_size:'0'}),null);
});
test('native capture provenance rejects future-observed or inverted bid ask',()=>{
 assert.ok(record([d(open).toISOString(),d(open+2000).toISOString(),'EURUSD',1.1,1.1001]));
 assert.equal(record([d(open).toISOString(),d(open-1000).toISOString(),'EURUSD',1.1,1.1001]),null);
 assert.equal(record([d(open).toISOString(),d(open+15000).toISOString(),'EURUSD',1.1,1.1001]),null);
 assert.equal(record([d(open).toISOString(),d(open+2000).toISOString(),'EURUSD',1.1002,1.1]),null);
 assert.equal(record([d(open).toISOString(),d(open+2000).toISOString(),'XAUUSD',1.1,1.1001]),null);
});
test('first observed TP may happen after profit close and before observed original SL',()=>{
 const quotes=[q(4*MINUTE+1000,1.102),q(4*MINUTE+3000,1.1041),
  q(4*MINUTE+6000,1.0979)];
 const x=firstObservedFromClose(t,quotes,close+16*MINUTE+10000,15);
 assert.equal(x.status,'TP_FIRST_OBSERVED');
 assert.equal(x.sampledCountBeforeEvent,2);
 assert.equal(x.sampledPriceNotBrokerFill,true);
 assert.equal(x.frequentSamplesUntilEvent,true);
});
test('gapped snapshots cannot prove complete first-touch ordering',()=>{
 const quotes=[q(4*MINUTE+45000,1.1041)];
 const x=firstObservedFromClose(t,quotes,close+16*MINUTE+10000,15);
 assert.equal(x.status,'TP_FIRST_OBSERVED');
 assert.equal(x.frequentSamplesUntilEvent,false);
 assert.equal(x.limitedSamplingUntilEvent,false);
});
test('a stop-side observation before TP stays stop-first',()=>{
 const quotes=[q(4*MINUTE+1000,1.102),q(4*MINUTE+2000,1.097),
  q(4*MINUTE+3000,1.1041)];
 const x=firstObservedFromClose(t,quotes,close+16*MINUTE+10000,15);
 assert.equal(x.status,'STOP_FIRST_OBSERVED');
});
test('maturity and no path cannot be treated as observed winners',()=>{
 assert.equal(firstObservedFromClose(t,[],close+3*MINUTE,15).status,'NOT_MATURED');
 const x=firstObservedFromClose(t,[],close+16*MINUTE+10000,15);
 assert.equal(x.status,'NO_SNAPSHOTS');
});
test('first observed SELL crossing uses ASK not bid',()=>{
 const sell=validateTrade({...trade,direction:'SELL',fill_price:'1.1000',
  exit_price:'1.0989',stop_loss:'1.1020',take_profit:'1.0960'});
 const quotes=[q(4*MINUTE+1000,1.0960),q(4*MINUTE+2000,1.0958)];
 const x=firstObservedFromClose(sell,quotes,close+16*MINUTE+10000,15);
 assert.equal(x.status,'TP_FIRST_OBSERVED');
 assert.equal(x.sampledCountBeforeEvent,2);
});
test('milestone proposal is correct 50/65 60/70 80/75 and retains as peak grows',()=>{
 assert.equal(fractionAtProgress(.49),null);
 assert.equal(fractionAtProgress(.5),.65);
 assert.equal(fractionAtProgress(.59),.65);
 assert.equal(fractionAtProgress(.6),.7);
 assert.equal(fractionAtProgress(.79),.7);
 assert.equal(fractionAtProgress(.8),.75);
 assert.equal(limitFraction(.81,'ONLY_NEAR_TP_80_60'),.6);
 assert.equal(limitFraction(.7,'PATIENT_70_55_85_65'),.55);
});
test('naively replacing exits with trailing can sacrifice an actual profit',()=>{
 const quotes=[q(1000,1.1001),q(2*MINUTE,1.1024),
  q(3*MINUTE,1.1025),q(4*MINUTE,1.1021),
  q(5*MINUTE,1.1011)];
 const result=simulateMilestoneTrailing(t,quotes,close+121*MINUTE+10000,120);
 assert.equal(result.event,'TRAIL_STOP_OBSERVED');
 assert.equal(result.eventBeforeActualClose,false);
 assert.equal(result.triggeredMilestones.fifty!==null,true);
 assert.equal(result.syntheticQuoteNotBrokerFill,true);
});
test('a hybrid cannot override actual profit when quote near close is stale',()=>{
 const quotes=[q(1000,1.1025)];
 const x=simulateHybrid(t,quotes,close+121*MINUTE+10000,120);
 assert.equal(x.status,'ACTUAL_PROFIT_CLOSE_RETAINED');
 assert.equal(x.actualNet,t.actualNet);
 assert.equal(x.proxyIncrementVsActual,0);
});
test('hybrid with positive protected stop may hold to future TP in shadow only',()=>{
 const quotes=[q(1000,1.1001),q(2*MINUTE,1.1028),
  q(3*MINUTE,1.1029),q(4*MINUTE-1000,1.1025),
  q(4*MINUTE+1000,1.1024),q(4*MINUTE+2000,1.1031),
  q(4*MINUTE+3000,1.1041)];
 const p=proposedAtClose(t,quotes,'USER_50_65_60_70_80_75');
 assert.equal(p.status,'SIMULATED_STOP_CANDIDATE');
 assert.ok(p.netAtStopAfterHalfPipExtraSlippage>0);
 const r=simulateHybrid(t,quotes,close+121*MINUTE+10000,120);
 assert.equal(r.event,'ORIGINAL_TP_OBSERVED');
 assert.equal(r.brokerFillNotVerified,true);
 assert.ok(r.indicativeIncrementVsActual>0);
});
test('hybrid stop may be hit before TP despite a prior strong peak',()=>{
 const quotes=[q(1000,1.1001),q(2*MINUTE,1.1028),
  q(3*MINUTE,1.1029),q(4*MINUTE-1000,1.1025),
  q(4*MINUTE+1000,1.1020),q(4*MINUTE+2000,1.1018),
  q(4*MINUTE+3000,1.1041)];
 const r=simulateHybrid(t,quotes,close+121*MINUTE+10000,120);
 assert.equal(r.event,'PROPOSED_TRAIL_STOP_OBSERVED');
 assert.equal(r.brokerFillNotVerified,true);
});
test('midpoint stop wick before quote TP flags conflict with quoted ordering',()=>{
 const quoteTp={status:'TP_FIRST_OBSERVED',eventAt:d(close+4*MINUTE+1000).toISOString()};
 const bars=[validNativeBucket(close+MINUTE),
  validNativeBucket(close+2*MINUTE,'1.0978','1.102'),
  validNativeBucket(close+3*MINUTE),
  validNativeBucket(close+4*MINUTE)];
 const x=corroborateWickOrder(t,quoteTp,bars);
 assert.equal(x.status,'MIDPOINT_OPPOSITE_BARRIER_POSSIBLE_EARLIER');
 assert.equal(x.sideSpecificTickOrderNotCertified,true);
});
test('a duplicate or missing native candle cannot certify TP-first',()=>{
 const quoteTp={status:'TP_FIRST_OBSERVED',eventAt:d(close+2*MINUTE+1000).toISOString()};
 const only=validNativeBucket(close+MINUTE);
 const missing=corroborateWickOrder(t,quoteTp,[only]);
 const duplicate=corroborateWickOrder(t,quoteTp,[only,only,validNativeBucket(close+2*MINUTE)]);
 assert.equal(missing.status,'MISSING_FULL_M1_CANDLE_EVIDENCE');
 assert.equal(duplicate.status,'MISSING_FULL_M1_CANDLE_EVIDENCE');
});
test('summary cannot turn missed or unmatched outcomes into a TP win',()=>{
 const rows=[{
  route:'EARLY_TRANSITION',day:'2026-11-17',actualNet:20,
  firstByHorizon:Object.fromEntries([15,30,60,120,240].map(h=>[h+'m',{status:'NOT_MATURED'}])),
  trailing:{status:'NO_SAMPLED_EXIT_BY_HORIZON'},
  hybridByPolicy:{
   USER_50_65_60_70_80_75:{status:'ACTUAL_PROFIT_CLOSE_RETAINED'},
   PATIENT_70_55_85_65:{status:'ACTUAL_PROFIT_CLOSE_RETAINED'},
   ONLY_NEAR_TP_80_60:{status:'ACTUAL_PROFIT_CLOSE_RETAINED'},
  },
 }];
 const output=summarize(rows);
 assert.equal(output.bookedNet,20);
 assert.equal(output.horizons['15m'].firstObservedTP,0);
 assert.equal(output.hybridByPolicy.USER_50_65_60_70_80_75.asOfCloseCandidates,0);
});
