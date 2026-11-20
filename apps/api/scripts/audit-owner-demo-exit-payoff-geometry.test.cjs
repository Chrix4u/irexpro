'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {QUERY,signedDist,quoteRiskUsd,decode,calculate,analyze}=require('./audit-owner-demo-exit-payoff-geometry.cjs');
const opened='2026-11-19T04:00:00.000Z';
const row=(overrides={})=>({
 trade_id:'good-trade',instrument:'AUDUSD',direction:'SELL',
 opened_at:opened,closed_at:'2026-11-19T04:09:00Z',
 intent_at:'2026-11-19T03:59:59Z',
 decision_evaluated_at:'2026-11-19T03:59:00Z',
 decision_recorded_at:'2026-11-19T03:59:30Z',
 decision_id:'d-valid',status:'CLOSED',close_reason:'PROFIT_PROTECTION',
 lot_size:'2',fill_price:'.66998',exit_price:'.66988',
 original_intent_stop:'.67050',original_intent_target:'.66920',
 realised_pnl:'20',commission:'-12',swap:'0',
 max_favorable_pnl:'25',max_adverse_pnl:'-2',profit_giveback:'5',
 path_peak_observed_at:'2026-11-19T04:07:00Z',
 allocated_stop_risk_usd:'102',allocated_risk_percent:'0.5',
 verified_guard_close:false,
 metadata:{multimodel_plan_b_route:'CONFIRMED_REVERSAL'},
 candidate:{instrument:'AUDUSD',direction:'SELL',entry:.67,stopLoss:.6705,takeProfit:.6692},
 governance:{multimodelGovernance:{netExpectedR:.22}},
 ...overrides
});
test('read-only query restricts exact owner and DEMO USD and joins independently signed guard audits',()=>{
 for(const q of [
  't.user_id=$1','b.user_id=$1',"b.broker_id='pepperstone-ctrader'",
  "b.account_type='DEMO'","b.account_currency='USD'",
  "t.account_currency='USD'","t.status='CLOSED'",
  "a.actor_user_id=t.user_id","a.resource_id=t.id::text",
  "a.metadata->'aiCloseTrigger'->>'source'='DEMO_DRAWDOWN_GUARD'",
  'ti.stop_loss AS original_intent_stop',
  'ti.take_profit AS original_intent_target',
  'd.created_at AS decision_recorded_at',
 ])assert.ok(QUERY.includes(q),q);
 assert.equal(/\b(UPDATE|INSERT|DELETE|TRUNCATE)\b/.test(QUERY),false);
});
test('planned target 1.6R derives exclusively from the verified original decision and intent',()=>{
 const t=decode(row());
 assert.equal(t.originalDecisionVerified,true);
 assert.equal(t.plannedGeometryVerified,true);
 assert.equal(t.plannedRewardToRisk,1.6);
 assert.equal(t.fillGeometryVerified,true);
 assert.equal(t.filledRewardToRisk,1.5);
 assert.equal(t.stopRiskFromFillAndIntentUsd,104);
 assert.equal(t.netUsd,8);
 assert.equal(t.realizedNetRFromFillStop,.0769);
 assert.equal(t.preEntryForecastNetR,.22);
});
test('actual close class is profit protection, with observed peak separate from broker fill',()=>{
 const t=decode(row());
 assert.equal(t.closeClass,'PROFIT_PROTECTION');
 assert.equal(t.observedGrossPeakUsd,25);
 assert.equal(t.profitProtectionPeakCaptureRatio,.8);
 assert.equal(t.observedPeakAtProvenance,true);
 assert.equal(t.nearOriginalStop,false);
 assert.equal(t.nearOriginalTarget,false);
 assert.equal(t.observedAfterFinalCostsPositivePeakBeforeLoss,false);
});
test('intent stop is immutable: unrelated amended broker stop does not contaminate original RR',()=>{
 const t=decode(row({stop_loss:'.66950',take_profit:'.66970'}));
 assert.equal(t.plannedRewardToRisk,1.6);
 assert.equal(t.fillGeometryVerified,true);
 assert.equal(t.stopRiskFromFillAndIntentUsd,104);
});
test('missing or hindsight decision blocks pre-entry metrics but retains proven broker net',()=>{
 for(const patch of [
  {decision_id:null},
  {decision_recorded_at:'2026-11-19T04:00:05Z'},
  {decision_evaluated_at:'2026-11-19T04:00:01Z'},
  {candidate:{...row().candidate,instrument:'USDCAD'}},
  {original_intent_stop:'.67100'},
  {governance:{} ,decision_id:null},
 ]){const t=decode(row(patch));assert.equal(t.originalDecisionVerified,false);
  assert.equal(t.plannedRewardToRisk,null);assert.equal(t.netUsd,8);}
});
test('cost-adjusted net may lose despite a positive gross mark (observed not executable)',()=>{
 const t=decode(row({trade_id:'lost-after-mark',close_reason:'BROKER_CLOSE',
  exit_price:'.67050',realised_pnl:'-104',commission:'-12',swap:'0',
  max_favorable_pnl:'25'}));
 assert.equal(t.netUsd,-116);
 assert.equal(t.peakedPositiveBeforeLoss,true);
 assert.equal(t.observedAfterFinalCostsPositivePeakBeforeLoss,true);
 assert.equal(t.nearOriginalStop,true);
 assert.equal(t.closeClass,'BROKER_CLOSE');
 assert.equal(t.realizedNetRFromFillStop,-1.1154);
});
test('a positive gross peak below final paid fee is never called a positive after-fee peak',()=>{
 const t=decode(row({close_reason:'BROKER_CLOSE',realised_pnl:'-50',
  commission:'-12',max_favorable_pnl:'5'}));
 assert.equal(t.peakedPositiveBeforeLoss,true);
 assert.equal(t.observedAfterFinalCostsPositivePeakBeforeLoss,false);
});
test('invalid path-peak provenance excludes sampled profitable peak labels',()=>{
 const t=decode(row({close_reason:'BROKER_CLOSE',realised_pnl:'-50',
  max_favorable_pnl:'99',path_peak_observed_at:'2026-11-19T04:15:00Z'}));
 assert.equal(t.observedPeakAtProvenance,false);
 assert.equal(t.peakedPositiveBeforeLoss,false);
 assert.equal(t.observedAfterFinalCostsPositivePeakBeforeLoss,false);
});
test('AI close must have signed guard audit to be attributed to five-minute drawdown guard',()=>{
 const assumed=decode(row({close_reason:'AI_CLOSE_SIGNAL',verified_guard_close:false}));
 assert.equal(assumed.closeClass,'OTHER_OR_UNVERIFIED_AI_CLOSE');
 const verified=decode(row({close_reason:'AI_CLOSE_SIGNAL',verified_guard_close:true}));
 assert.equal(verified.closeClass,'INDEPENDENT_GUARD_REQUEST');
 assert.equal(decode(row({close_reason:'BROKER_CLOSE',verified_guard_close:true})).closeClass,
  'BROKER_CLOSE');
});
test('USD account geometry converts USDJPY quote currency using actual fill price',()=>{
 assert.equal(quoteRiskUsd('EURUSD',2,1.1,1.0995).toFixed(2),'100.00');
 assert.equal(quoteRiskUsd('USDJPY',2,155,154.95).toFixed(2),'64.52');
 assert.equal(quoteRiskUsd('EURGBP',1,.85,.84),null);
 assert.equal(quoteRiskUsd('AUDUSD',0,.66,.65),null);
 assert.ok(signedDist(.67,.6705,'SELL','stop')>0);
 assert.ok(signedDist(.67,.6692,'SELL','target')>0);
});
test('report separates settled trial winner from baseline losing settlement without promising causality',()=>{
 const t=decode(row({trade_id:'baseline-loss',close_reason:'BROKER_CLOSE',
  realised_pnl:'-50',exit_price:'.67050'}));
 const t2=decode(row({trade_id:'trial-winner',
  metadata:{multimodel_plan_b_route:'CONFIRMED_REVERSAL',
  m1_owner_demo_noon_lot_trial_artifact:'owner-pepperstone-demo-four-plus-until-20261120t1200z-v1'}}));
 const x=analyze([row({trade_id:'baseline-loss',close_reason:'BROKER_CLOSE',
  realised_pnl:'-50',exit_price:'.67050'}),row({trade_id:'trial-winner',
  metadata:t2.trialCohort==='EXPLICIT_OWNER_HIGH_LOT'?
  {multimodel_plan_b_route:'CONFIRMED_REVERSAL',
    m1_owner_demo_noon_lot_trial_artifact:'owner-pepperstone-demo-four-plus-until-20261120t1200z-v1'}:{} })]);
 assert.equal(t.loss,true);
 assert.equal(x.all.trades,2);
 assert.equal(x.verifiedPreEntryDecisionCount,2);
 assert.equal(x.trialVsBaseline.EXPLICIT_OWNER_HIGH_LOT.trades,1);
 assert.equal(x.trialVsBaseline.BASELINE_OTHER.trades,1);
 assert.equal(x.confirmedGuardExit.trades,0);
 assert.equal(x.noExecutionsChanged,true);
 assert.equal(x.trialLotPolicyChanged,false);
});
test('invalid or unverified broker settlement never gets a fabricated monetary value',()=>{
 for(const update of [
  {realised_pnl:null},{commission:null},{swap:null},
  {opened_at:'2026-11-19T04:12:00Z'},
  {lot_size:'0'},{fill_price:null},
 ])assert.throws(()=>decode(row(update)),/INVALID_COMPLETE_BROKER_TRADE_ECONOMICS/);
 const stats=calculate([]);assert.equal(stats.avgLossUsd,null);
 assert.equal(stats.netUsd,0);
});
