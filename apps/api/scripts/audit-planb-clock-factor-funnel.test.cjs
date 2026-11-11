'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SCOPE_SQL, DECISIONS_SQL, referenceNoonUtc,
  aggregate, audit,
} = require('./audit-planb-clock-factor-funnel.cjs');

const USER = '2caa0c64-00dd-48fb-babb-06b39cb74068';
const CONNECTION = '26ef9b4e-6e24-4a65-a4f2-8db22e209e9d';
function scoreFn(input) {
  const p = input.scanTime.getUTCHours() === 12 ? 0.7 : 0.4;
  return { probability: p, expectedR: p * (2.5 / 1.5) - (1-p),
    admitted: p >= 0.5 };
}
function decision(extra = {}) {
  return {
    instrument: 'GBPUSD', direction: 'SELL',
    evaluatedAt: '2026-11-10T16:10:00Z', m1Route: 'M1_TREND_CONTINUATION',
    confidence: '0.68', alignedEma: '0.4', alignedM15: '0.5',
    extension: '0.6', volatility: '0.15', rsi: '47', momentum: '-0.3',
    originalProbability: '0.4',
    paperAdmitted: 'false', strategyRoute: 'TREND_CONTINUATION',
    directionQuality: '0.65', tradeQuality: '0.6', exitQuality: '0.65',
    sessionQuality: '0.9', portfolioQuality: '1', consensusPassed: '5',
    regime: 'TREND_HEALTHY', regimeAllowed: 'true',
    eventRisk: 'CLEAR', driftState: 'NORMAL',
    governanceBlockers: ['ENSEMBLE_NOT_PAPER_ADMITTED','ENSEMBLE_NOT_PROMOTABLE_ADMISSION'],
    ...extra,
  };
}
test('noon reference is UTC on same date and changes no market features', () => {
  assert.equal(referenceNoonUtc('2026-11-10T20:39:50Z').toISOString(),
    '2026-11-10T12:00:00.000Z');
  const output = aggregate([decision()], scoreFn);
  const afternoon = output.byPeriod.AFTERNOON_14_TO_20_UTC;
  assert.equal(output.verifiedReplays, 1);
  assert.equal(afternoon.originalMetaAdmitted, 0);
  assert.equal(afternoon.noonReferenceMetaAdmitted, 1);
  assert.equal(afternoon.newlyMetaAdmittedWithRegimeAndIndependentGatesClear, 1);
  assert.equal(afternoon.originalPlanBAdmitted, 0);
  assert.equal(afternoon.newlyFrozenRoutePlanBAdmitted, 1);
  assert.equal(afternoon.newlyFrozenRoutePlanBAdmittedAndM1AndIndependentGatesClear, 1);
  assert.equal(afternoon.originalMeanMetaProbability, 0.4);
  assert.equal(afternoon.noonReferenceMeanMetaProbability, 0.7);
});
test('rollover, M1 abstentions, news and OOD never become clean executable pathways', () => {
  const output = aggregate([
    decision({regime:'ROLLOVER_RISK',regimeAllowed:'false'}),
    decision({m1Route:'ABSTAIN'}),
    decision({eventRisk:'HIGH_IMPACT_BLOCK'}),
    decision({driftState:'OUT_OF_DISTRIBUTION',governanceBlockers:['DRIFT_OUT_OF_DISTRIBUTION']}),
    decision({governanceBlockers:['UNVERIFIED_BROKER_SPREAD']}),
    decision({governanceBlockers:null}),
  ], scoreFn).byPeriod.AFTERNOON_14_TO_20_UTC;
  assert.equal(output.newlyMetaAdmitted, 6);
  assert.equal(output.newlyMetaAdmittedWithRegimeAndIndependentGatesClear, 0);
  assert.equal(output.independentGovernanceVetoDecisions, 4);
});
test('replay mismatch and missing as-of features fail closed rather than invent gains', () => {
  assert.throws(()=>aggregate([decision({originalProbability:'0.6'})],scoreFn),
    /ACTIVE_PLAN_B_META_REPLAY_MISMATCH/);
  assert.throws(()=>aggregate([decision({consensusPassed:'6'})],scoreFn),
    /ACTIVE_PLAN_B_CONSENSUS_REPLAY_MISMATCH/);
  assert.throws(()=>aggregate([decision({confidence:null})],scoreFn),
    /INCOMPLETE_ASOF_MODEL_FEATURES/);
  assert.throws(()=>aggregate([decision({evaluatedAt:'bad'})],scoreFn),/INVALID_ASOF_TIME/);
});
function client(rows = [], active = true) {
  const calls = [];
  return {
    calls,
    query: async(sql, params) => {
      calls.push({sql,params});
      if(sql===SCOPE_SQL)return {rows:active?[{
        connectionId:CONNECTION,brokerId:'pepperstone-ctrader',
        snapshotAt:'2026-11-10T23:00:00.000Z',
      }]:[]};
      if(sql===DECISIONS_SQL)return {rows};
      return {rows:[]};
    },
  };
}
const options=(c)=>({client:c,userId:USER,from:'2026-11-10T08:00:00Z',
  through:'2026-11-10T22:00:00Z',scoreFn,maxDecisions:4});
test('active-session ownership and read-only transaction protect broker scope', async()=>{
  assert.match(SCOPE_SQL,/ts.user_id = \$1/);
  assert.match(SCOPE_SQL,/bc.user_id = ts.user_id/);
  assert.match(SCOPE_SQL,/account_type = 'DEMO'/);
  assert.match(SCOPE_SQL,/status = 'ACTIVE'/);
  assert.match(DECISIONS_SQL,/d.user_id = \$1 AND d.broker_connection_id = \$2/);
  const c=client([decision()]);
  const r=await audit(options(c));
  assert.equal(r.brokerId,'pepperstone-ctrader');
  assert.equal(r.modifiesExecution,false);
  assert.equal(r.executionAuthority,'NONE');
  assert.equal(r.qualificationEvidence,false);
  assert.match(c.calls[0].sql,/READ ONLY/);
  assert.deepEqual(c.calls.find(x=>x.sql===DECISIONS_SQL).params.slice(0,2),[USER,CONNECTION]);
  assert.equal(c.calls.at(-1).sql,'COMMIT');
});
test('absent active session, truncated history and mismatched model all roll back',async()=>{
  const missing=client([],false);
  await assert.rejects(audit(options(missing)),/ACTIVE_OWNED_CTRADER_DEMO_UNAVAILABLE/);
  assert.equal(missing.calls.at(-1).sql,'ROLLBACK');
  const tooMany=client(Array.from({length:5},()=>decision()));
  await assert.rejects(audit(options(tooMany)),/AUDIT_WINDOW_TRUNCATED_FAIL_CLOSED/);
  assert.equal(tooMany.calls.at(-1).sql,'ROLLBACK');
  const mismatch=client([decision({originalProbability:'0.5'})]);
  await assert.rejects(audit(options(mismatch)),/ACTIVE_PLAN_B_META_REPLAY_MISMATCH/);
  assert.equal(mismatch.calls.at(-1).sql,'ROLLBACK');
});
test('invalid user scope and invalid as-of window fail before DB access',async()=>{
  const c=client();
  await assert.rejects(audit({...options(c),userId:'not-uuid'}),/INVALID_USER_SCOPE/);
  await assert.rejects(audit({...options(c),through:'2026-12-30T22:00:00Z'}),
    /INVALID_ASOF_AUDIT_PERIOD/);
  assert.equal(c.calls.length,0);
});
