'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {evaluateM1AtEntry,theoreticalNoEntryOmission} = require('./m1-entry-asof.cjs');
const base={
  openedAt:'2026-11-19T16:16:38.964Z',
  executedM1CreatedAt:'2026-11-19T16:16:25.327Z',
  executedM1Route:'ABSTAIN',
  oppositeM1CreatedAt:'2026-11-19T16:16:24.953Z',
  oppositeM1EvaluatedAt:'2026-11-19T16:16:00.000Z',
  oppositeM1Route:'ABSTAIN',
};
test('known before entry: as-of double abstain, without new trade authority',()=>{
  assert.deepEqual(evaluateM1AtEntry(base),{
    executedDecisionAvailableAtEntry:true,
    oppositeDecisionAvailableAtEntry:true,
    oppositeRouteAtEntry:'ABSTAIN',
    oppositeSourceAtEntry:'PERSISTED_BEFORE_ORDER',
    verifiedDoubleAbstain:true,
  });
});
test('same-bar opposite saved after order is research, never as-of direction permission',()=>{
  const r=evaluateM1AtEntry({...base,
    oppositeM1CreatedAt:'2026-11-19T16:16:39.005Z'});
  assert.equal(r.oppositeDecisionAvailableAtEntry,false);
  assert.equal(r.verifiedDoubleAbstain,false);
});
test('future evaluation time cannot enter even if persistence claims to be early',()=>{
  const r=evaluateM1AtEntry({...base,
    oppositeM1EvaluatedAt:'2026-11-19T16:17:00Z'});
  assert.equal(r.oppositeDecisionAvailableAtEntry,false);
});
test('missing own decision is never valid despite earlier opposite decision',()=>{
  const r=evaluateM1AtEntry({...base,
    executedM1CreatedAt:null});
  assert.equal(r.executedDecisionAvailableAtEntry,false);
  assert.equal(r.oppositeDecisionAvailableAtEntry,false);
});
test('same-snapshot opposite is available before order even when its separate DB row arrives later',()=>{
  const r=evaluateM1AtEntry({...base,
    entryDirection:'SELL',
    oppositeM1CreatedAt:'2026-11-19T16:16:39.005Z',
    oppositeM1EvaluatedAt:'2026-11-19T16:17:00Z',
    sameSnapshotRoute:'M1_EARLY_TRANSITION',
    sameSnapshotDirection:'BUY',
    sameSnapshotDecisionTime:'2026-11-19T16:16:00Z',
    sameSnapshotShadowOnly:true,
  });
  assert.equal(r.oppositeDecisionAvailableAtEntry,true);
  assert.equal(r.oppositeRouteAtEntry,'M1_EARLY_TRANSITION');
  assert.equal(r.oppositeSourceAtEntry,'SAME_SNAPSHOT_BEFORE_ORDER');
  assert.equal(r.verifiedDoubleAbstain,false);
});
test('snapshot rejects the wrong opposite direction and any post-open feature time',()=>{
  for (const patch of [
    {sameSnapshotDirection:'SELL'},
    {sameSnapshotDecisionTime:'2026-11-19T16:17:00Z'},
    {sameSnapshotShadowOnly:false},
    {sameSnapshotRoute:'UNKNOWN'},
  ]) {
    const r=evaluateM1AtEntry({...base,
      entryDirection:'SELL',
      oppositeM1CreatedAt:'2026-11-19T16:16:39.005Z',
      sameSnapshotRoute:'ABSTAIN',
      sameSnapshotDirection:'BUY',
      sameSnapshotDecisionTime:'2026-11-19T16:16:00Z',
      sameSnapshotShadowOnly:true,...patch,
    });
    assert.equal(r.oppositeDecisionAvailableAtEntry,false);
    assert.equal(r.verifiedDoubleAbstain,false);
  }
});
test('opposite BUY route does not count as double abstain',()=>{
  const r=evaluateM1AtEntry({...base,
    oppositeM1Route:'M1_EARLY_TRANSITION'});
  assert.equal(r.oppositeDecisionAvailableAtEntry,true);
  assert.equal(r.verifiedDoubleAbstain,false);
});
test('missing and malformed dates fail to unknown instead of future labels',()=>{
  for (const val of [null,'invalid',undefined,'']) {
    assert.equal(evaluateM1AtEntry({...base,oppositeM1CreatedAt:val})
      .verifiedDoubleAbstain,false);
  }
});
test('shadow omission separately reports foregone winners and avoided losses',()=>{
  const e=(netUsd,verifiedDoubleAbstain=true)=>({
    labels:{netUsd},retrospectiveAudit:{verifiedDoubleAbstain},
  });
  const r=theoreticalNoEntryOmission([e(20),e(-35),e(15),e(-5),e(200,false)]);
  assert.deepEqual(r,{
    eligibleHistoricalTrades:4,missedWinners:2,avoidedLosers:2,
    foregoneWinnerNetUsd:35,avoidedLoserNetUsd:40,
    theoreticalOmittedNetUsd:5,
    executablePolicy:false,prospectiveValidation:false,
  });
});
