'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {ACTIVATED_AT,classify,aggregate,reportForRows}=require('./audit-owner-demo-progressive-profit-retention.cjs');
const baseline={
 opened_at:'2026-11-20T09:20:00.000Z',
 closed_at:'2026-11-20T09:22:00.000Z',
 instrument:'USDJPY',direction:'SELL',lot_size:'6',
 max_favorable_pnl:'170.74',path_peak_observed_at:'2026-11-20T09:21:20.000Z',
 path_observation_count:38,close_reason:'PROFIT_PROTECTION',
 realised_pnl:'41.51',commission:'-36',swap:'0',
 strategy_route:'CONFIRMED_REVERSAL',initial_risk:'188.68',
};
test('exact demo activation timestamp is frozen; no date inference',()=>{
 assert.equal(ACTIVATED_AT,'2026-11-20T09:28:43.000Z');
});
test('settled booked after-fee dollars and observed net peak are not confused',()=>{
 const x=classify(baseline);
 assert.equal(x.rolloutPeriod,'BEFORE_ROLLOUT');
 assert.equal(x.net,5.51);
 assert.equal(x.peak,170.74);
 assert.equal(x.peakCaptureRatio,0.0323);
 assert.equal(x.givebackToFinalNet,165.23);
 assert.equal(x.peakToCloseSeconds,40);
 assert.equal(x.severeRetainedBelowHalf,true);
});
test('a position opened before activation but settled after is EXCLUDED from both cohorts',()=>{
 const x=classify({...baseline,closed_at:'2026-11-20T09:29:00.000Z'});
 assert.equal(x.rolloutPeriod,'STRADDLED_ROLLOUT_EXCLUDED');
});
test('after group requires OPENED after the service activation and can count losses',()=>{
 const x=classify({...baseline,opened_at:'2026-11-20T09:29:00.000Z',
  closed_at:'2026-11-20T09:31:00.000Z',realised_pnl:'-63'});
 assert.equal(x.rolloutPeriod,'AFTER_ROLLOUT');
 assert.equal(x.net,-99);
 assert.equal(x.severeRetainedBelowHalf,true);
});
test('other exit reasons never masquerade as a profit-protection win',()=>{
 const x=classify({...baseline,close_reason:'BROKER_CLOSE'});
 assert.equal(x.profitProtection,false);
 assert.equal(x.severeRetainedBelowHalf,false);
});
test('missing fee and inverted broker times fail rather than fabricate profits',()=>{
 assert.throws(()=>classify({...baseline,commission:null}),/UNVERIFIED_BROKER_ECONOMICS/);
 assert.throws(()=>classify({...baseline,opened_at:'2026-11-20T09:23:00.000Z'}),/INVALID_BROKER_TIMES/);
});
test('rollout summary excludes straddlers and counts both wins and lost winners',()=>{
 const xs=[
  baseline,
  {...baseline,opened_at:'2026-11-20T09:25:00.000Z',closed_at:'2026-11-20T09:29:00.000Z'},
  {...baseline,opened_at:'2026-11-20T09:29:00.000Z',closed_at:'2026-11-20T09:31:00.000Z',
   max_favorable_pnl:'100',realised_pnl:'94',commission:'-20',initial_risk:'100'},
  {...baseline,opened_at:'2026-11-20T09:33:00.000Z',closed_at:'2026-11-20T09:34:00.000Z',
   max_favorable_pnl:'0',realised_pnl:'-94',commission:'-20',close_reason:'BROKER_CLOSE'},
 ];
 const r=reportForRows(xs,new Date('2026-11-20T09:35:00Z'));
 assert.equal(r.comparedCohorts.before.settled,1);
 assert.equal(r.comparedCohorts.after.settled,2);
 assert.equal(r.comparedCohorts.straddledExcluded.settled,1);
 assert.equal(r.comparedCohorts.after.wins,1);
 assert.equal(r.comparedCohorts.after.losses,1);
 assert.equal(r.comparedCohorts.after.protectedCloses,1);
 assert.equal(r.comparedCohorts.after.protectedPeakObserved,1);
 assert.equal(r.comparedCohorts.after.protectedFinalNetSumUsd,74);
 assert.equal(r.comparedCohorts.after.protectedPeakSumUsd,100);
 assert.equal(r.comparedCohorts.after.aggregatePeakCapture,.74);
 assert.equal(r.modifiesExecution,false);
 assert.equal(r.demonstratedCausalImprovement,false);
 assert.equal(r.noOrders,true);
});
test('zero evidence does not produce fictitious retention percentages',()=>{
 const a=aggregate([]);
 assert.equal(a.aggregatePeakCapture,null);
 assert.equal(a.averagePeakCapture,null);
 assert.equal(a.profitFactor,null);
 assert.equal(a.severeRetainedBelowHalf,0);
});
