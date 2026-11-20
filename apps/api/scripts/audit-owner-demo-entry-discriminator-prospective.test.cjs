'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {finiteResult,summarize,buildScoreboard}=
 require('./audit-owner-demo-entry-discriminator-prospective.cjs');
function row(net,low,prob,version='tested') {
 return {
  instrument:'EURUSD',direction:'BUY',lot_size:2,
  opened_at:'2026-11-20T11:00:00.000Z',
  closed_at:'2026-11-20T11:17:00.000Z',
  decision_recorded_at:'2026-11-20T10:59:00.000Z',
  intent_created_at:'2026-11-20T10:59:08.000Z',
  realised_pnl:net+3,commission:-3,swap:0,
  plan_b_route:'CONFIRMED_REVERSAL',
  decision_shadow:{
   artifact:'owner-demo-after-fee-entry-discriminator-v1',
   status:'FITTED_SHADOW_UNQUALIFIED',
   route:'CONFIRMED_REVERSAL',
   probabilityOfAfterFeeWinningTrade:prob,
   probabilityOfAfterFeeLosingTrade:1-prob,
   researchLowScoreThreshold:.52,researchLowScoreFlag:low,
   modelVersion:version,
   trainingCutoffUtc:'2026-11-19T00:00:00.000Z',
   shadowOnly:true,modifiesExecution:false,
   grantsTradeAuthority:false,vetoRecommended:false,
  },
 };
}
test('accepts only genuine after-fee settled fills with frozen before-intent scores',()=>{
 const x=finiteResult(row(-20,true,.4));
 assert.equal(x.loss,true);
 assert.equal(x.netUsd,-20);
 assert.equal(x.netUsdPerLot,-10);
 for(const patch of [
  {decision_recorded_at:'2026-11-20T11:00:10.000Z'},
  {intent_created_at:'2026-11-20T11:01:00.000Z'},
  {opened_at:'2026-11-19T11:00:00.000Z'},
  {commission:null},
  {lot_size:0},
 ])assert.equal(finiteResult({...row(-20,true,.4),...patch}),null);
});
test('disallows mismatched model route, impossible probability and altered policy authority',()=>{
 const x=row(9,false,.8);
 assert.equal(finiteResult({...x,plan_b_route:'EARLY_TRANSITION'}),null);
 assert.equal(finiteResult({...x,decision_shadow:{...x.decision_shadow,modifiesExecution:true}}),null);
 assert.equal(finiteResult({...x,decision_shadow:{...x.decision_shadow,grantsTradeAuthority:true}}),null);
 assert.equal(finiteResult({...x,decision_shadow:{...x.decision_shadow,probabilityOfAfterFeeLosingTrade:.5}}),null);
 assert.equal(finiteResult({...x,decision_shadow:{...x.decision_shadow,researchLowScoreFlag:true}}),null);
});
test('scoreboard counts winning trades a shadow filter would throw away',()=>{
 const rows=[row(-30,true,.45),row(15,true,.48),
  row(-9,false,.72),row(22,false,.8)];
 const result=buildScoreboard(rows,new Date('2026-11-21T00:00:00Z'));
 assert.equal(result.validFrozenPreOrderScores,4);
 const rev=result.routes.find(r=>r.byRoute==='CONFIRMED_REVERSAL');
 assert.equal(rev.all.trades,4);
 assert.equal(rev.belowTrainingQuartile.trades,2);
 assert.equal(rev.belowTrainingQuartile.wins,1);
 assert.equal(rev.belowTrainingQuartile.losses,1);
 assert.equal(rev.hypotheticalNetChangeUsd,15);
 assert.equal(rev.prospectiveEligibility,'SPARSE_PROSPECTIVE_DATA');
 assert.equal(rev.grantsTradeAuthority,false);
 assert.equal(result.modifiesExecution,false);
});
