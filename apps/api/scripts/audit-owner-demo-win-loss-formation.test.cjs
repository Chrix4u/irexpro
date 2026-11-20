'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {normalize,compare,FLAGS,winRankingAuc}=require('./audit-owner-demo-win-loss-formation.cjs');
const DAY='2026-11-18';
function record(day=DAY,net=10,override={}){
 const stem=day+'T12:00:';
 return {
  trade_id:'test-'+day+'-'+net,
  instrument:'EURUSD',direction:'BUY',lot_size:1,
  opened_at:stem+'10Z',closed_at:stem+'40Z',
  decision_at:stem+'00Z',recorded_at:stem+'01Z',intent_at:stem+'03Z',
  realised_pnl:net+1,commission:-1,swap:0,max_favorable_pnl:5,
  close_reason:'BROKER_CLOSE',
  metadata:{multimodel_plan_b_route:'CONFIRMED_REVERSAL',
    multimodel_execution_authority_path:'DEMO_CONTINUOUS_REVERSAL_EARLY_EVIDENCE',
    m1_advisory_quality_risk_fraction:0.5},
  m1_route:'ABSTAIN',
  candidate:{direction:'BUY',confidence:.71,alignedM5:-.4,alignedH1:-.2,
    alignedM5LatestBodyPressure:-.2,alignedMomentum3Atr:.5},
  governance:{
    multimodelEnsemble:{strategyRoute:'CONFIRMED_REVERSAL',ensembleScore:.65,metaProbability:.47,
      consensusPassed:7,regime:'REVERSAL_CONFIRMED'},
    multimodelGovernance:{netExpectedR:.15,driftState:'NORMAL'},
    multimodelTrainedExpert:{state:'ABSTAIN',direction:'BUY',longVotes:3,shortVotes:0,
      meanOpportunityProbability:.25,allBrokerNative:true},
  },decision_id:'test-entry-id',
  ...override
 };
}
test('closed DEMO win and loss retain original pre-entry signal and final after-fee outcome separately',()=>{
 const win=normalize(record('2026-11-18',9)),loss=normalize(record('2026-11-19',-11));
 assert.equal(win.label,'WIN');assert.equal(loss.label,'LOSS');
 assert.equal(win.netUsd,9);assert.equal(loss.netUsd,-11);
 assert.equal(win.entry.m1Route,'ABSTAIN'); // alternate may execute!
 assert.equal(win.entry.expertState,'ABSTAIN');
 assert.equal(win.matchedDecision,true);
 assert.equal(win.outcomeOnly.maxFavorableUsd,5);
 assert.equal(Object.hasOwn(win.entry,'maxFavorableUsd'),false);
 assert.equal(win.entry.alignedM5,-.4);
});
test('post-decision and post-intent changes cannot be treated as pre-entry features',()=>{
 for(const patch of [
  {recorded_at:'2026-11-18T12:00:05Z'},
  {decision_at:'2026-11-18T12:00:08Z'},
  {decision_id:null},
  {candidate:{direction:'SELL'}},
  {governance:{multimodelEnsemble:{strategyRoute:'TREND_CONTINUATION'}}},
 ]) {
  const result=normalize(record('2026-11-18',-5,patch));
  assert.equal(result.matchedDecision,false);
  assert.equal(result.entry,null);
  assert.equal(result.label,'LOSS');
 }
});
test('historical feature contrasts cannot auto-veto and count winning trades sacrificed',()=>{
 const good=normalize(record('2026-11-17',20));
 const lost=normalize(record('2026-11-18',-25));
 const laterGood=normalize(record('2026-11-19',10));
 const report=compare([good,lost,laterGood]);
 assert.equal(report.hasDeployedNewVeto,false);
 assert.equal(report.hasRetrainedModel,false);
 assert.equal(report.entryDecisionVerified,3);
 assert.equal(report.discoverySummary.n,2);
 assert.equal(report.laterDateSummary.n,1);
 const item=report.allFlagComparisons.find(x=>x.flag==='M5_DIRECTION_OPPOSES'&&x.route==='CONFIRMED_REVERSAL');
 assert.equal(item.all.flagged.wins,2);
 assert.equal(item.all.flagged.losses,1);
 assert.equal(item.all.hypotheticalIfAvoidedFlagged.lostWinners,2);
 assert.equal(item.executableVeto,false);
});
test('predefined formation factors do not include post-trade outcomes as inputs',()=>{
 assert.ok(FLAGS.length>10);
 assert.equal(FLAGS.some(([name])=>/peak|pnl|closed|stop_hit|losing/i.test(name)),false);
});


test('win-ranking AUC ignores future settlement as a predictor and handles ties',()=>{
 const a=normalize(record('2026-11-17',15));
 const b=normalize(record('2026-11-18',-10));
 a.entry.forecastNetR=.4;b.entry.forecastNetR=.1;
 assert.equal(winRankingAuc([a,b],'forecastNetR').auc,1);
 a.entry.forecastNetR=.1;b.entry.forecastNetR=.4;
 assert.equal(winRankingAuc([a,b],'forecastNetR').auc,0);
 a.entry.forecastNetR=.2;b.entry.forecastNetR=.2;
 assert.equal(winRankingAuc([a,b],'forecastNetR').auc,.5);
 assert.equal(winRankingAuc([a],'forecastNetR').available,false);
});
