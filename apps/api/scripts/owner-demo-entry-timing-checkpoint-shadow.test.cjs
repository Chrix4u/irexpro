'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {
 VERSION,lastAsOf,evaluateFrozenCheckpoint,evaluateCheckpointMark,
}=require('./owner-demo-entry-timing-checkpoint-shadow.cjs');
const MINUTE=60000;
const start=Date.parse('2026-11-18T10:00:00Z');
const base={
 instrument:'EURUSD',direction:'BUY',sgn:1,
 openedAt:start,closedAt:start+15*MINUTE,
 plannedEntry:1.1000,entry:1.10002,stop:1.0995,tp:1.1008,
};
const quote=(seconds,bid,seen=seconds)=>({
 at:start+seconds*1000,observed:start+seen*1000,
 bid,ask:bid+.0001,mid:bid+.00005,spread:.0001,
});
const supported=()=>({
 status:'FRESH_ASOF_BROKER_QUOTE',
 aligned60sPips:.8,aligned300sPips:1,
 m5QuoteCoverage:'FREQUENT_POLL_QUOTE_SAMPLES',
 m5Direction:'AGREES',
});
test('frozen checkpoint is read-only, has no execution or lot authority',()=>{
 const x=evaluateFrozenCheckpoint(base,[quote(59,1.10007)],supported,start+10*MINUTE);
 assert.equal(x.state,'DEFERRED_ENTRY_RESEARCH_CANDIDATE');
 assert.equal(x.noTradeAuthority,true);
 assert.equal(x.proposesBrokerOrder,false);
 assert.equal(x.modifiesLotSizing,false);
 assert.equal(x.modelPromotionAllowed,false);
 assert.equal(x.actualBrokerStopUnchanged,true);
 assert.equal(x.signalBasedOnlyOnQuotesObservedByCheckpoint,true);
 assert.equal(x.artifact,VERSION);
});
test('checkpoint never sees a quote received later than its own decision time',()=>{
 const quotes=[quote(58,1.10005,59),quote(59.5,1.10045,62)];
 const observed=lastAsOf(quotes,start+MINUTE);
 assert.equal(observed.at,start+58000);
 const x=evaluateFrozenCheckpoint(base,quotes,supported,start+10*MINUTE);
 assert.equal(x.state,'DEFERRED_ENTRY_RESEARCH_CANDIDATE');
 assert.equal(x.hypotheticalEntrySidePrice,1.10015);
});
test('checkpoint cannot operate before it matures or after the real trade was closed',()=>{
 const q=[quote(59,1.10007)];
 assert.equal(evaluateFrozenCheckpoint(base,q,supported,start+MINUTE+5000).state,
  'CHECKPOINT_NOT_MATURE');
 assert.equal(evaluateFrozenCheckpoint({...base,closedAt:start+MINUTE},q,supported,
  start+10*MINUTE).state,'REAL_TRADE_ALREADY_CLOSED');
});
test('missing planned entry or invalid broker stop geometry must fail closed',()=>{
 for(const x of [
  {...base,plannedEntry:null},
  {...base,plannedEntry:0},
  {...base,plannedEntry:1.0994},
  {...base,plannedEntry:1.1009},
 ]){
  assert.equal(evaluateFrozenCheckpoint(x,[quote(59,1.10007)],supported,
   start+10*MINUTE).state,'ORIGINAL_PLANNED_ENTRY_UNVERIFIED');
 }
});
test('stale quote, wide spread, and adverse position cannot become a signal',()=>{
 const x=evaluateFrozenCheckpoint(base,[quote(40,1.10007)],supported,start+10*MINUTE);
 assert.equal(x.state,'NO_FRESH_CHECKPOINT_QUOTE');
 const wide=[{...quote(59,1.10007),ask:1.10037,spread:.0003}];
 assert.equal(evaluateFrozenCheckpoint(base,wide,supported,start+10*MINUTE).state,
  'SPREAD_NOT_COMPATIBLE_WITH_DELAY');
 assert.equal(evaluateFrozenCheckpoint(base,[quote(59,1.09980)],supported,
  start+10*MINUTE).state,'WAIT_PRICE_HAS_NOT_CONFIRMED');
});
test('checkpoint rejects chasing and missing M1/M5 evidence, without changing any trade',()=>{
 const baseline=[quote(59,1.10007)];
 assert.equal(evaluateFrozenCheckpoint(base,[quote(59,1.1004)],supported,start+10*MINUTE)
  .state,'WAIT_AVOID_PRICE_CHASE');
 assert.equal(evaluateFrozenCheckpoint(base,baseline,()=>({
  ...supported(),aligned60sPips:null}),start+10*MINUTE).state,'NO_CAUSAL_M1_CONFIRMATION');
 assert.equal(evaluateFrozenCheckpoint(base,baseline,()=>({
  ...supported(),aligned60sPips:-.1}),start+10*MINUTE)
  .state,'WAIT_M1_MOMENTUM_NOT_ALIGNED');
 assert.equal(evaluateFrozenCheckpoint(base,baseline,()=>({
  ...supported(),m5QuoteCoverage:'GAPPED_POLL_QUOTE_SAMPLES'}),start+10*MINUTE)
  .state,'WAIT_M5_QUOTE_CONTEXT_UNVERIFIED');
 assert.equal(evaluateFrozenCheckpoint(base,baseline,()=>({
  ...supported(),m5Direction:'OPPOSES'}),start+10*MINUTE).state,'WAIT_M5_OPPOSES');
});
test('future mark uses quote-side entry and exit; it is never an executable broker fill',()=>{
 const quotes=[quote(59,1.10007),quote(179,1.10040)];
 const decision=evaluateFrozenCheckpoint(base,quotes,supported,start+10*MINUTE);
 const x=evaluateCheckpointMark(base,quotes,decision,3,start+10*MINUTE);
 assert.equal(x.status,'QUOTE_ONLY_HYPOTHETICAL_MARK');
 assert.equal(x.directionPositive,true);
 assert.ok(x.directionalMoveFromHypotheticalEntryPips>0);
 assert.equal(x.spreadIncludedInPriceDifference,true);
 assert.equal(x.hypotheticalBrokerFillVerified,false);
 assert.equal(x.noTradeAuthority,true);
});
test('a future quote arriving after horizon is not observed; after-close labels are censored',()=>{
 const quotes=[quote(59,1.10007),quote(179,1.10040,181)];
 const d=evaluateFrozenCheckpoint(base,quotes,supported,start+10*MINUTE);
 assert.equal(evaluateCheckpointMark(base,quotes,d,3,start+10*MINUTE)
  .status,'NO_FRESH_MARK');
 const realClosed={...base,closedAt:start+2*MINUTE};
 const x=evaluateCheckpointMark(realClosed,[quote(59,1.10007),quote(179,1.10040)],
  d,3,start+10*MINUTE);
 assert.equal(x.afterOriginalRealTradeClosed,true);
 assert.equal(x.hypotheticalBrokerFillVerified,false);
});
test('SELL uses bid for hypothetical entry and ASK for later quote exit',()=>{
 const sell={...base,direction:'SELL',sgn:-1,
  plannedEntry:1.1000,entry:1.09998,stop:1.1005,tp:1.0992};
 const quotes=[quote(59,1.10010),quote(179,1.09950)];
 const decision=evaluateFrozenCheckpoint(sell,quotes,supported,start+10*MINUTE);
 assert.equal(decision.state,'WAIT_PRICE_HAS_NOT_CONFIRMED');
 const valid=[quote(59,1.09993),quote(179,1.09930)];
 const selected=evaluateFrozenCheckpoint(sell,valid,supported,start+10*MINUTE);
 assert.equal(selected.state,'DEFERRED_ENTRY_RESEARCH_CANDIDATE');
 const x=evaluateCheckpointMark(sell,valid,selected,3,start+10*MINUTE);
 assert.equal(x.status,'QUOTE_ONLY_HYPOTHETICAL_MARK');
 assert.equal(x.directionPositive,true);
});
