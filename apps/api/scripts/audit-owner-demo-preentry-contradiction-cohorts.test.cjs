'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {classify,row,summarize,compare,analyze}=require('./audit-owner-demo-preentry-contradiction-cohorts.cjs');
const entry='2026-11-20T08:00:00Z';
function original(overrides={}){
 const obj={
  matchedDecision:true,entryRoute:'CONFIRMED_REVERSAL',
  tradeKey:'a',tradeDate:'2026-11-20',decisionAt:entry,
  openedAt:'2026-11-20T08:00:12Z',instrument:'AUDUSD',direction:'SELL',
  lot:3.5,netUsd:-120,netUsdPerLot:-34.29,label:'LOSS',
  entry:{alignedM5:-.2,forecastNetR:.19,expertState:'ABSTAIN',m1Route:'ABSTAIN'},
 };
 return {...obj,...overrides,entry:{...obj.entry,...overrides.entry}};
}
function context(overrides={}){
 return {
  status:'VALID',route:'CONFIRMED_REVERSAL',instrument:'AUDUSD',
  direction:'SELL',day:'2026-11-20',intentAt:Date.parse(entry)+5000,
  openedAt:Date.parse(entry)+12000,netRealizedR:-.78,
  asOf:{status:'FRESH_ASOF_BROKER_QUOTE',
   aligned60sPips:-.65,quoteAgeSeconds:1,
   latestEventAt:'2026-11-20T07:59:59Z',
   latestObservedAt:'2026-11-20T07:59:59Z'},
  ...overrides
 };
}
function candle(m1Body=-.35,overrides={}){
 return {status:'AT_LEAST_ONE_VERIFIED_ASOF_QUOTE_CANDLE',
  M1:{source:'SAMPLED_BROKER_NATIVE_ASOF_QUOTES',fullTickOhlc:false,
   at:'2026-11-20T07:59:45Z',bodyAlignedRatio:m1Body},...overrides};
}
test('two causal clocks and broker intent keep quote and candle flags pre-entry only',()=>{
 const d=classify(original(),context(),candle());
 assert.equal(d.status,'VERIFIED_MATCHED_PREENTRY_DECISION');
 assert.equal(d.flags.LAST_60S_QUOTE_OPPOSES,true);
 assert.equal(d.flags.LAST_60S_QUOTE_AND_MODEL_M5_OPPOSE,true);
 assert.equal(d.flags.M1_FORMING_BODY_OPPOSES,true);
 assert.equal(d.flags.BOTH_PREENTRY_MEASUREMENTS_OPPOSE,true);
 assert.equal(d.quoteAligned60sPips,-.65);
 assert.equal(d.submittedModelM5Alignment,-.2);
 assert.equal(d.expertState,'ABSTAIN');
});
test('adverse quote + aligned model M5 is a single-source concern, not double adverse context',()=>{
 const d=classify(original({entry:{alignedM5:.16}}),context(),candle(.25));
 assert.equal(d.flags.LAST_60S_QUOTE_OPPOSES,true);
 assert.equal(d.flags.LAST_60S_QUOTE_AND_MODEL_M5_OPPOSE,false);
 assert.equal(d.flags.BOTH_PREENTRY_MEASUREMENTS_OPPOSE,false);
 assert.equal(d.flags.EITHER_PREENTRY_MEASUREMENT_OPPOSE,true);
});
test('missing previous 60s quote does NOT mean safe or adverse and cannot invoke gate',()=>{
 const q=context({asOf:{status:'FRESH_ASOF_BROKER_QUOTE',
   aligned60sPips:null,quoteAgeSeconds:1}});
 const d=classify(original(),q,candle());
 assert.equal(d.hasQuoteEvidence,false);
 assert.equal(d.flags.LAST_60S_QUOTE_OPPOSES,null);
 assert.equal(d.flags.LAST_60S_QUOTE_AND_MODEL_M5_OPPOSE,null);
 assert.equal(d.flags.BOTH_PREENTRY_MEASUREMENTS_OPPOSE,null);
 assert.equal(d.flags.M1_FORMING_BODY_OPPOSES,true);
});
test('stale quote or future decision cannot retrospectively grant pre-order signal',()=>{
 const x=context({asOf:{status:'FRESH_ASOF_BROKER_QUOTE',
   aligned60sPips:-.9,quoteAgeSeconds:18}});
 assert.equal(classify(original(),x,candle()).flags.LAST_60S_QUOTE_OPPOSES,null);
 const o=original({decisionAt:'2026-11-20T08:00:08Z'});
 const z=classify(o,context(),candle());
 assert.equal(z.flags.LAST_60S_QUOTE_OPPOSES,null);
});
test('candle captured after original decision is not a pre-entry warning',()=>{
 const x=classify(original(),context(),candle(-.9,{
  M1:{source:'SAMPLED_BROKER_NATIVE_ASOF_QUOTES',
   fullTickOhlc:false,at:'2026-11-20T08:00:10Z',
   bodyAlignedRatio:-.9},
 }));
 assert.equal(x.hasM1CandleEvidence,false);
 assert.equal(x.flags.M1_FORMING_BODY_OPPOSES,null);
 assert.equal(x.flags.BOTH_PREENTRY_MEASUREMENTS_OPPOSE,null);
});
test('sampled forming candle can be adverse while short quote movement is favorable',()=>{
 const q=context({asOf:{status:'FRESH_ASOF_BROKER_QUOTE',
  aligned60sPips:.6,quoteAgeSeconds:1}});
 const x=classify(original(),q,candle(-.45));
 assert.equal(x.flags.LAST_60S_QUOTE_OPPOSES,false);
 assert.equal(x.flags.M1_FORMING_BODY_OPPOSES,true);
 assert.equal(x.flags.EITHER_PREENTRY_MEASUREMENT_OPPOSE,true);
});
test('a posteriori broker outcome never changes original red flag assignment',()=>{
 const win=original({netUsd:120,netUsdPerLot:34.29,label:'WIN'});
 const lose=original({netUsd:-120,label:'LOSS'});
 assert.deepEqual(classify(win,context(),candle()).flags,
  classify(lose,context(),candle()).flags);
});
test('negative control Early Transition must be scored independently from Confirmed Reversal',()=>{
 const et=original({entryRoute:'EARLY_TRANSITION',entry:{alignedM5:.5}});
 const ctx=context({route:'EARLY_TRANSITION'});
 const result=analyze([original(),et],
  new Map([['a',ctx]]),new Map([['a',candle()]]),
  new Date('2026-11-20T08:03:00Z'));
 assert.equal(result.allSettled.trades,2);
 const cr=result.leadingCandidateComparison.find(x=>
  x.flag==='LAST_60S_QUOTE_AND_MODEL_M5_OPPOSE');
 assert.equal(cr.missingEvidence,1);
 assert.equal(cr.hypotheticalSkipped.trades,0);
 assert.equal(result.realBrokerVetoEnabled,false);
 assert.equal(result.ownerNoonLotTrialModified,false);
});
test('skip economics account for lost winners and avoided losers rather than only improved net',()=>{
 const x=row(original({tradeKey:'win',netUsd:30,label:'WIN',netUsdPerLot:10}),
  context(),candle());
 const y=row(original({tradeKey:'loss',netUsd:-110,label:'LOSS',netUsdPerLot:-36.67}),
  context(),candle());
 const z=row(original({tradeKey:'kept',netUsd:-20,label:'LOSS',netUsdPerLot:-6.67}),
  context({asOf:{status:'FRESH_ASOF_BROKER_QUOTE',
   aligned60sPips:.5,quoteAgeSeconds:1}}),candle(.3));
 const result=compare([x,y,z],'LAST_60S_QUOTE_AND_MODEL_M5_OPPOSE',
  'CONFIRMED_REVERSAL','2026-11-19');
 assert.equal(result.hypotheticalSkipped.trades,2);
 assert.equal(result.sacrificedWinningTrades,1);
 assert.equal(result.avoidedLosingTrades,1);
 assert.equal(result.historicalRetrospectiveImprovementUsd,80);
 assert.equal(result.wouldSetExecutionBlocker,false);
 assert.equal(result.hypotheticalKept.netUsd,-20);
});
test('unmatched decision and missing M5 evidence never masquerade as a safe veto',()=>{
 const x=classify(original({matchedDecision:false}),context(),candle());
 assert.equal(x.status,'UNMATCHED_PRE_ENTRY_DECISION');
 assert.deepEqual(x.flags,{});
 const y=classify(original({entry:{alignedM5:null}}),context(),candle());
 assert.equal(y.flags.LAST_60S_QUOTE_AND_MODEL_M5_OPPOSE,null);
});
test('empty cohorts keep null rather than fabricated 100% profit factor',()=>{
 const x=summarize([]);
 assert.equal(x.trades,0);assert.equal(x.profitFactor,null);
 assert.equal(x.meanNetR,null);
});
test('historically reviewed Nov20 is excluded from every future-validation claim',()=>{
 const o=original({tradeKey:'old-trade'}),c=context();
 const result=analyze([o],new Map([['old-trade',c]]),
  new Map([['old-trade',candle()]]),new Date('2026-11-20T09:01:00Z'));
 assert.equal(result.prospectiveUnseenAfterUtc,'2026-11-21T00:00:00.000Z');
 assert.equal(result.prospectiveUnseenAfterReviewedDays.distinctEntryDays,0);
 assert.equal(result.prospectiveUnseenAfterReviewedDays.comparisons.knownEvidence.trades,0);
 assert.equal(result.prospectiveUnseenAfterReviewedDays.enoughDataToReviewProspectiveEffect,false);
 assert.equal(result.prospectiveUnseenAfterReviewedDays.executableVetoEligible,false);
 assert.equal(result.validatedOnFutureUntouchedTradingDays,false);
});
