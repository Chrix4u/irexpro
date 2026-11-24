'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {
  routeClass,positiveQuotedMinute,episodeLeaders,toFinitePositive,
  timingOnlyBlock,summarize,study,
}=require('./pepperstone-live-route-outcomes-ro.cjs');
const T=Date.parse('2026-11-24T07:00:00Z'),M=60_000;
const base=(x={})=>({
  instrument:'AUDUSD',direction:'SELL',route:'M1_EARLY_TRANSITION',
  plan_b_route:'CONFIRMED_REVERSAL',plan_b_admitted:'true',
  evaluated_at:new Date(T).toISOString(),m1_reason:'EARLY_TRANSITION_IMPULSE',
  stop_distance:'0.0005',target_distance:'0.0008',
  estimated_cost_r:'0.025',...x,
});
const bar=(i,x={})=>({
  instrument:'AUDUSD',timestamp:new Date(T+i*M).toISOString(),
  last_quote_sample_at:new Date(T+i*M+5_000).toISOString(),
  source:'ctrader-broker-native',positive_quote_sample_count:1,
  open:'0.6650',high:'0.6655',low:'0.6645',close:'0.6651',...x,
});
test('rejects mistaking early transition for confirmed reversal',()=>{
  assert.equal(routeClass(base()),'ROUTE_DISAGREEMENT');
  assert.equal(routeClass(base({route:'M1_CONFIRMED_REVERSAL'})),'EXACT_ROUTE_MATCH');
  assert.equal(routeClass(base({route:'ABSTAIN'})),'M1_ABSTAIN');
});
test('deduplicates repeat minute decisions of the same pair/side/strategy',()=>{
  const leaders=episodeLeaders([
    base(),base({evaluated_at:new Date(T+1*M).toISOString()}),
    base({evaluated_at:new Date(T+8*M).toISOString()}),
    base({direction:'BUY'}),base({plan_b_admitted:'false'}),
  ]);
  assert.equal(leaders.length,3);
});
test('positive quote must be same minute, broker-native and geometrically valid',()=>{
  assert.equal(positiveQuotedMinute(bar(1)),true);
  assert.equal(positiveQuotedMinute(bar(1,{last_quote_sample_at:new Date(T).toISOString()})),false);
  assert.equal(positiveQuotedMinute(bar(1,{source:'manual'})),false);
  assert.equal(positiveQuotedMinute(bar(1,{positive_quote_sample_count:0})),false);
  assert.equal(positiveQuotedMinute(bar(1,{high:0.663,low:0.666})),false);
});
test('cannot call outcome evaluator on missing one of 15 quoted M1 bars',()=>{
  let called=false;
  const rows=Array.from({length:15},(_,i)=>bar(i+1)).filter((_,i)=>i!==7);
  const r=study([base()],rows,()=>{called=true;return {outcome:'TP',netRMultiple:1}},T+30*M);
  assert.equal(called,false);
  assert.equal(r.summary.ROUTE_DISAGREEMENT.unobservable,1);
});
test('15 consecutive broker-observed bars permit CAUSAL outcome evaluation',()=>{
  let input=null;
  const rows=Array.from({length:15},(_,i)=>bar(i+1));
  const r=study([base()],rows,x=>{
    input=x;return {outcome:'SL',netRMultiple:-1.025};
  },T+30*M);
  assert.equal(input.bars.length,15);
  assert.equal(input.bars[0].timestamp,new Date(T+M).toISOString());
  assert.equal(r.summary.ROUTE_DISAGREEMENT.negative,1);
  assert.equal(r.summary.ROUTE_DISAGREEMENT.totalNetR,-1.025);
});
test('fails closed if outcome horizon not yet mature',()=>{
  let n=0;
  const r=study([base()],Array.from({length:15},(_,i)=>bar(i+1)),
    ()=>{n++;return {outcome:'TP',netRMultiple:1}},T+10*M);
  assert.equal(n,0);
  assert.equal(r.summary.ROUTE_DISAGREEMENT.unobservable,1);
});
test('zero and nonfinite stop, target or cost cannot score',()=>{
  for(const variant of [
    {stop_distance:'0'},
    {target_distance:'garbage'},
    {estimated_cost_r:'-0.1'},
    {estimated_cost_r:null},
  ]){
    let calls=0;
    const r=study([base(variant)],Array.from({length:15},(_,i)=>bar(i+1)),
      ()=>{calls++;return {outcome:'TP',netRMultiple:1}},T+30*M);
    assert.equal(calls,0);
    assert.equal(r.summary.ROUTE_DISAGREEMENT.unobservable,1);
  }
});
test('counts only independently timing-vetoed decisions as timing-only',()=>{
  const x=base({blockers:['MULTIMODEL_REVERSAL_NOT_M1_CONFIRMED']});
  const y=base({blockers:['MULTIMODEL_REVERSAL_NOT_M1_CONFIRMED','DRIFT_OUT_OF_DISTRIBUTION']});
  assert.equal(timingOnlyBlock(x),true);
  assert.equal(timingOnlyBlock(y),false);
  assert.equal(timingOnlyBlock(base({blockers:[]})),false);
  const rows=Array.from({length:15},(_,i)=>bar(i+1));
  const stats=study([x],rows,()=>({outcome:'MTM',netRMultiple:-0.2}),T+30*M);
  assert.equal(stats.byBlockerExclusivity.TIMING_ONLY.negative,1);
});
test('ambiguous both-hit M1 candle is never claimed as profit',()=>{
  const r=study([base()],Array.from({length:15},(_,i)=>bar(i+1)),
    ()=>({outcome:'AMBIGUOUS',netRMultiple:null}),T+30*M);
  assert.equal(r.summary.ROUTE_DISAGREEMENT.ambiguous,1);
  assert.equal(r.summary.ROUTE_DISAGREEMENT.observed,0);
  assert.equal(r.summary.ROUTE_DISAGREEMENT.averageNetR,null);
});
test('does not coerce missing values to a positive stop distance',()=>{
  assert.equal(toFinitePositive(null),null);
  assert.equal(toFinitePositive(''),null);
  assert.equal(toFinitePositive(0),null);
  assert.equal(toFinitePositive('0.0005'),0.0005);
});

test('LIVE research DB scope is bound to the configured owner, not hardcoded account numbers',()=>{
  const fs=require('node:fs');
  const source=fs.readFileSync(require.resolve('./pepperstone-live-route-outcomes-ro.cjs'),'utf8');
  assert.match(source,/env\.VPS_FOREX_SCANNER_USER_ID/);
  assert.match(source,/provider_broker_identity='pepperstone' AND user_id=\$1/);
  assert.doesNotMatch(source,/49506270/);
});
