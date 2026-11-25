'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const research=require('./audit-owner-demo-preentry-to-5m-outcomes.cjs');
const formation=require('./audit-owner-demo-win-loss-formation.cjs');
const t=Date.parse('2026-11-19T10:00:00Z');
const iso=x=>new Date(x).toISOString();
const checkpoint=(update={})=>({
 trade_key:'entry-one',action:'OBSERVE',state:'NO_ACTION',
 checkpoint_at:iso(t+300000),opened_at:iso(t),
 evaluated_at:iso(t+310000),created_at:iso(t+311000),
 closed_at:iso(t+600000),status:'CLOSED',current_r:'-0.2',
 probability:'0.54',response:{source_state:'READY'},...update});
const trade=(id,day,win=true,flagged=false)=>({
 tradeKey:id,tradeDate:day,openedAt:day+'T10:00:00Z',
 closedAt:day+'T11:00:00Z',instrument:'USDCAD',direction:'BUY',
 lot:2,entryRoute:'CONFIRMED_REVERSAL',matchedDecision:true,
 entry:{route:'CONFIRMED_REVERSAL',m1Route:'ABSTAIN',
  metaProbability:.6,planBScore:flagged?.61:.68,
  alignedM5:flagged?-.7:.3,alignedM1Momentum3:.2,
  m5Body:flagged?-.4:.3,m5Body3:.2,alignedH1:.5,alignedH4:.1,
  forecastNetR:.2,m1Confidence:.73,expertProbability:.35,
  consensus:7,alignedM5Momentum3:.2,alignedM15:.4,
  alignedHigherAgreement:.2,extension:.1},
 netUsd:win?20:-60,netUsdPerLot:win?10:-30,
 label:win?'WIN':'LOSS',outcomeOnly:{closeReason:win?'PROFIT_PROTECTION':'BROKER_CLOSE'}
});
test('owner-scoped read-only SQL uses verified original decisions and separate five-minute evidence',()=>{
 for(const s of [
  'o.trade_id::text trade_key',"b.broker_id='pepperstone-ctrader'",
  "b.account_type='DEMO'","b.account_currency='USD'",
  'o.user_id=$1','t.user_id=$1','o.checkpoint_minutes=5',
  "o.artifact='plan-b-v89-demo-5m-drawdown-guard-v1'"
 ])assert.ok(research.CHECKPOINT_SQL.includes(s),s);
 assert.ok(formation.SQL.includes('d.created_at recorded_at'));
 assert.ok(formation.SQL.includes('ti.created_at intent_at'));
 assert.equal(research.startDay(Date.parse('2026-11-20T05:00:00Z')),
  '2026-11-17T00:00:00.000Z');
 assert.equal(research.tomorrow(Date.parse('2026-11-20T05:00:00Z')),
  '2026-11-21T00:00:00.000Z');
 assert.equal(research.startDay(Date.parse('2026-11-30T05:00:00Z')),
  '2026-11-24T00:00:00.000Z');
});
test('five-minute checkpoint can be a later label, never available at entry',()=>{
 const o=research.normalizeFiveMinuteCheckpoint(checkpoint());
 assert.equal(o.checkpointR,-.2);
 assert.equal(o.range,'ADVERSE');
 assert.equal(o.recordedBeforeExit,true);
 assert.equal(o.usedAsEntryFeature,false);
 assert.equal(research.normalizeFiveMinuteCheckpoint(checkpoint({current_r:'.12'})).range,'SMALL_OR_FLAT');
 assert.equal(research.normalizeFiveMinuteCheckpoint(checkpoint({current_r:'.17'})).range,'STRONG_POSITIVE');
});
test('rejects hindsight or noncausal five-minute data',()=>{
 const updates=[
  {action:'CLOSE_DEMO',state:'CLOSE_PENDING_RECONCILIATION'},
  {state:'WAITING_FOR_BROKER_DATA'},
  {evaluated_at:iso(t+601000)},
  {created_at:iso(t+610000)},
  {checkpoint_at:iso(t+400000)},
  {probability:'not-a-number'},
  {response:{source_state:'BROKER_DATA_UNAVAILABLE'}},
  {current_r:'-0.42'}
 ];
 for(const patch of updates)
  assert.equal(research.normalizeFiveMinuteCheckpoint(checkpoint(patch)),null,
   JSON.stringify(patch));
});
test('no score from unavailable guard action is used as five-minute entry label',()=>{
 const rows=[
  checkpoint({trade_key:'entry-one'}),
  checkpoint({trade_key:'entry-two',action:'CLOSE_DEMO',
   state:'CLOSE_PENDING_RECONCILIATION'}),
 ];
 const result=research.withCheckpoint([trade('entry-one','2026-11-19'),
  trade('entry-two','2026-11-19')],rows);
 assert.equal(result[0].fiveMinute.weakOrFlat,true);
 assert.equal(result[1].fiveMinute,null);
 assert.equal(result[0].entry.planBScore,.68);
});
test('duplicates of valid checkpoint are refused rather than silently selecting best',()=>{
 assert.throws(()=>research.withCheckpoint([],[checkpoint(),checkpoint()]),
  /DUPLICATE_VERIFIED_FIVE_MINUTE_CHECKPOINT/);
});
test('win/loss score includes genuine commission-adjusted broker net, not a win count alone',()=>{
 const s=research.summary([
  trade('a','2026-11-17',true),
  trade('b','2026-11-17',true),
  trade('c','2026-11-17',false)
 ]);
 assert.equal(s.wins,2);assert.equal(s.losses,1);
 assert.equal(s.netUsd,-20);assert.equal(s.profitFactor,.6667);
 assert.equal(s.meanWinnerUsd,20);assert.equal(s.meanLoserUsd,-60);
});
test('retrospective warning would remove winning trades as well as avoid losing trades',()=>{
 const items=[
  trade('a','2026-11-17',true,true),
  trade('b','2026-11-17',false,true),
  trade('c','2026-11-18',true,false),
 ];
 const result=research.compareFlag(items,e=>e.planBScore<.64);
 assert.equal(result.retrospectiveAvoidedLosses,1);
 assert.equal(result.retrospectiveLostWinners,1);
 assert.equal(result.historicalNetRemovedIfVetoed,-40);
 assert.equal(result.warningOnly,true);assert.equal(result.canBlock,false);
});
test('day splits do not leak later outcomes into prior day or grant veto authority',()=>{
 const items=[
  trade('a','2026-11-17',false,true),
  trade('b','2026-11-18',true,false),
  trade('c','2026-11-19',true,true),
  trade('d','2026-11-20',false,true)
 ];
 const r=research.compareTrades(items,[],Date.parse('2026-11-20T12:00:00Z'));
 const m=r.preEntryFlagsByRoute.PLAN_B_SCORE_LT_064.CONFIRMED_REVERSAL;
 assert.equal(m.nov17And18Exploratory.flagged.losses,1);
 assert.equal(m.nov19LaterAlreadyReviewed.flagged.wins,1);
 assert.equal(m.nov20LaterAlreadyReviewed.flagged.losses,1);
 assert.equal(r.joinedPostEntryFiveMinute.available,0);
 assert.equal(r.originalPreEntryDecisionMatched,4);
 assert.equal(r.repeatedWarningAuthorizesTrades,false);
 assert.equal(r.noModelTraining,true);
 assert.equal(r.executionAuthority,'NONE');
 assert.deepEqual(r.exploratoryRepeatedWarnings,[]);
});
test('unlinked pre-intent evidence is not silently promoted into the original entry comparison',()=>{
 const bad=trade('bad','2026-11-19',false,true);
 bad.matchedDecision=false;bad.entry=null;
 const r=research.compareTrades([trade('x','2026-11-18',true,false),bad],[],
  Date.parse('2026-11-20T04:00:00Z'));
 assert.equal(r.closedTradeCohort.trades,2);
 assert.equal(r.originalPreEntryDecisionMatched,1);
 assert.equal(r.unmatchedEntry,1);
 assert.equal(r.fullPreEntryLineageCoverage,false);
});
