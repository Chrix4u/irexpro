'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {ARTIFACT,HORIZONS,SQL,validQuote,outcome,summarize}=require('./audit-owner-demo-drawdown-guard-postexit.cjs');
const closed=Date.parse('2026-11-19T10:00:00Z');
const iso=t=>new Date(t).toISOString();
const trade=(patch={})=>({
 instrument:'USDCAD',direction:'SELL',opened_at:iso(closed-5*60000-20000),
 closed_at:iso(closed),close_requested_at:iso(closed-3000),
 fill_price:'1.20000',exit_price:'1.20020',stop_loss:'1.20050',
 take_profit:'1.19900',lot_size:'2.00',realised_pnl:'-28',
 commission:'-12',swap:'0',route:'EARLY_TRANSITION',...patch
});
const q=(sec,ask,instrument='USDCAD',lag=1000)=>({
 instrument,source:closed+sec*1000,captured:closed+sec*1000+lag,
 bid:ask-.00002,ask
});
const later=closed+2*60*60000;
test('SQL requires actual owner DEMO broker and signed guard close request',()=>{
 for(const part of [
  "b.broker_id='pepperstone-ctrader'","b.account_type='DEMO'",
  "b.account_currency='USD'","t.account_currency='USD'",
  "a.actor_user_id=t.user_id","a.resource_id=t.id::text",
  "a.metadata->'aiCloseTrigger'->>'source'='DEMO_DRAWDOWN_GUARD'",
  "a.metadata->>'closeReason'='AI_CLOSE_SIGNAL'",
  'a.created_at>=t.opened_at',"t.close_reason='AI_CLOSE_SIGNAL'",
  "t.status='CLOSED'"
 ])assert.ok(SQL.includes(part),part);
 assert.deepEqual(HORIZONS,[1,3,5,10,20,30]);
});
test('native quote validity is two-clock, positive bid/ask, recognized pair only',()=>{
 const raw=[iso(closed+5000),iso(closed+6000),'USDCAD',1.2001,1.20012];
 assert.equal(validQuote(raw)?.instrument,'USDCAD');
 assert.equal(validQuote([...raw.slice(0,1),iso(closed+22000),...raw.slice(2)]),null);
 assert.equal(validQuote([iso(closed+7000),iso(closed+6000),...raw.slice(2)]),null);
 assert.equal(validQuote([...raw.slice(0,3),1.2002,1.2001]),null);
 assert.equal(validQuote([...raw.slice(0,2),'USDCHF',...raw.slice(3)]),null);
});
test('guard exit can show late sampled recovery with no sampled original stop',()=>{
 const out=outcome(trade(),[q(4,1.20020),q(28,1.20012),q(54,1.19997)],later);
 assert.equal(out.status,'BROKER_SETTLED');
 assert.equal(out.exitNetUsd,-40);
 assert.equal(out.stages['1m'].status,'COMPLETE_SAMPLED_PATH');
 assert.equal(out.stages['1m'].sampledReturnToOriginalEntry,true);
 assert.equal(out.stages['1m'].sampledOriginalStop,false);
 assert.ok(out.stages['1m'].additionalPipsAtLastSample>0);
 const r=summarize([out],{files:1,accepted:3,rejected:0});
 assert.equal(r.aggregate.horizons['1m'].recoveryWithoutSampledStop,1);
 assert.equal(r.aggregate.realizedGuardExitNetUsd,-40);
 assert.equal(r.aggregate.horizons['1m'].counterfactualTradingNetUsd,null);
 assert.equal(r.modifiesExecution,false);
});
test('sampled stop before late recovery is not mistaken for safe hold',()=>{
 const out=outcome(trade(),[
   q(4,1.20020),q(26,1.20065),q(40,1.19998),q(54,1.19994)
 ],later);
 const stage=out.stages['1m'];
 assert.equal(stage.sampledOriginalStop,true);
 assert.equal(stage.firstSeenOriginalBarrier,'STOP');
 assert.equal(stage.sampledReturnToOriginalEntry,true);
 assert.equal(stage.recoveredAfterSampledStop,true);
 const r=summarize([out],{files:1});
 assert.equal(r.aggregate.horizons['1m'].recoveryWithoutSampledStop,0);
 assert.equal(r.aggregate.horizons['1m'].firstSeenStop,1);
});
test('missing or sparse observed path is censored, never classified profitable',()=>{
 const out=outcome(trade(),[q(5,1.20022),q(170,1.19980)],later);
 assert.equal(out.stages['1m'].status,'INSUFFICIENT_ASOF_QUOTES');
 assert.equal(out.stages['3m'].status,'INCOMPLETE_SAMPLED_PATH');
 const r=summarize([out],{});
 assert.equal(r.aggregate.horizons['3m'].completeQuotePaths,0);
 assert.equal(r.aggregate.horizons['3m'].lastQuoteBetterThanActualExit,0);
 assert.equal(r.aggregate.horizons['3m'].missingOrPartialQuotePaths,1);
});
test('quote not archived before horizon cannot be used as a past horizon mark',()=>{
 const out=outcome(trade(),[q(3,1.20021),q(49,1.19990,'USDCAD',15000)],later);
 assert.equal(out.stages['1m'].status,'INSUFFICIENT_ASOF_QUOTES');
});
test('invalid broker barriers and missing fee evidence fail closed',()=>{
 assert.equal(outcome(trade({stop_loss:'1.19900'}),[],later).status,'INVALID_BROKER_TRADE');
 assert.equal(outcome(trade({commission:null}),[],later).status,'INVALID_BROKER_TRADE');
 assert.equal(outcome(trade({direction:'BUY'}),[],later).status,'INVALID_BROKER_TRADE');
});
test('not-mature horizons never inherit later observed quotes',()=>{
 const out=outcome(trade(),[q(4,1.20015),q(52,1.20012)],
  closed+2*60000);
 assert.equal(out.stages['1m'].status,'COMPLETE_SAMPLED_PATH');
 assert.equal(out.stages['3m'].status,'NOT_MATURE');
 const r=summarize([out],{});
 assert.equal(r.aggregate.horizons['3m'].notMature,1);
 assert.equal(r.aggregate.horizons['3m'].completeQuotePaths,0);
 assert.equal(r.artifact,ARTIFACT);
});

test('rolling UTC window keeps bounded research history as weeks advance',()=>{
 const {windowStart}=require('./audit-owner-demo-drawdown-guard-postexit.cjs');
 assert.equal(windowStart(Date.parse('2026-11-20T02:00:00Z')),'2026-11-17T00:00:00.000Z');
 assert.equal(windowStart(Date.parse('2026-11-25T02:00:00Z')),'2026-11-19T00:00:00.000Z');
});
test('pre-exit candlestick alignment requires independently frozen real as-of prediction',()=>{
 const {alignPreExitExpert}=require('./audit-owner-demo-drawdown-guard-postexit.cjs');
 const issued=closed-40000,bar=closed-60000;
 const p={
  artifact:'irexpro-owner-demo-prospective-candle-shadow-v1',
  instrument:'USDCAD',timeframe:'M1',barStart:iso(bar),
  decisionAt:iso(closed-45000),forecastWrittenAt:iso(issued),
  modelTrainedAt:'2026-11-17T12:00:00Z',
  predictedNextCandleClass:'GREEN_OR_UP',confidence:.6,
  rawUncalibratedProbabilities:{RED_OR_DOWN:.2,COST_SMALL_OR_FLAT:.2,GREEN_OR_UP:.6},
  snapshotAgeSeconds:5,
  researchOnly:true,brokerOrderAuthority:false,modifiesExecution:false,
  nextCandleOutcomeKnown:false,afterCostPnlKnown:false
 };
 const later={...p,barStart:iso(closed),decisionAt:iso(closed+15000),
  forecastWrittenAt:iso(closed+20000),confidence:.8,
  rawUncalibratedProbabilities:{RED_OR_DOWN:.1,COST_SMALL_OR_FLAT:.1,GREEN_OR_UP:.8}};
 const v=alignPreExitExpert(trade(),new Map([['USDCAD',[p,later]]]));
 assert.equal(v.status,'VERIFIED_PRE_EXIT_FORECAST');
 assert.equal(v.directionalAgreement,'OPPOSE');
 assert.equal(v.confidence,.6);
 assert.equal(v.ageSeconds,37);
 assert.equal(v.noExitAuthority,true);
 assert.equal(alignPreExitExpert(trade(),new Map([['USDCAD',[later]]])).status,
  'NO_VERIFIED_PRE_EXIT_FORECAST');
 assert.equal(alignPreExitExpert(trade(),new Map([['USDCAD',[{...p,researchOnly:false}]]])).status,
  'NO_VERIFIED_PRE_EXIT_FORECAST');
});

test('pre-exit guard scoring is admitted only with verified before-close evidence time',()=>{
 const {verifyPreExitGuardScore,SQL}=require('./audit-owner-demo-drawdown-guard-postexit.cjs');
 for(const part of [
  "o.evaluated_at<=ca.created_at",
  "o.response->>'evidence_evaluated_at' IS NOT NULL",
  "(o.response->>'evidence_evaluated_at')::timestamptz=o.evaluated_at",
  "o.action='CLOSE_DEMO'",
  'o.trade_id=t.id AND o.user_id=t.user_id'
 ])assert.ok(SQL.includes(part),part);
 const valid=trade({verified_guard_current_r:'-0.62',
  verified_guard_probability:'0.47',
  verified_guard_evaluated_at:iso(closed-10000)});
 const evidence=verifyPreExitGuardScore(valid);
 assert.equal(evidence.status,'VERIFIED_BEFORE_CLOSE_REQUEST');
 assert.equal(evidence.currentR,-.62);
 assert.equal(evidence.rawModelProbability,.47);
 assert.equal(evidence.noDecisionAuthority,true);
 assert.equal(verifyPreExitGuardScore({...valid,
  verified_guard_evaluated_at:iso(closed+1000)}).status,
  'HISTORICAL_GUARD_SCORE_ASOF_UNVERIFIED');
 assert.equal(verifyPreExitGuardScore({...valid,
  verified_guard_evaluated_at:null}).status,
  'HISTORICAL_GUARD_SCORE_ASOF_UNVERIFIED');
 assert.equal(verifyPreExitGuardScore({...valid,
  verified_guard_current_r:'-0.2'}).status,
  'HISTORICAL_GUARD_SCORE_ASOF_UNVERIFIED');
 const o=outcome(valid,[q(4,1.20015),q(54,1.19995)],later);
 o.preExitGuardScore=evidence;
 const result=summarize([o],{files:1});
 assert.equal(result.preExitGuardScoreAlignment.verifiedPreClose,1);
 assert.equal(result.preExitGuardScoreAlignment.by10mObservedPath.INCOMPLETE.trades,1);
 assert.equal(result.preExitGuardScoreAlignment.by10mObservedPath.INCOMPLETE.meanPreCloseR,-.62);
});
