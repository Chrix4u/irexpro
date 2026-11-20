'use strict';
const{test}=require('node:test'),assert=require('node:assert/strict');
const{num,cohort,SQL}=require('./audit-pepperstone-first-shadow-economics.cjs');
const TIME='2026-11-16T06:02:00Z';
function trade(signal,net,fee,at='2026-11-16T05:56:00Z') {
  return {opened_at:'2026-11-16T05:50:00Z',closed_at:TIME,
    realised_pnl:net,commission:fee,swap:'0',
    LEGACY_FIRST_CROSSING:signal===undefined?null:{
      created_at:at,metadata:signal},
    HIGH_PEAK_CONFIRMED:null,PEAK_TO_LOSS_RESCUE:null};
}
test('nullable money does not become artificial zero',()=>{
  assert.equal(num(null),null);
  assert.equal(num(''),null);
  assert.equal(num('1.5'),1.5);
});
test('signal is counted once before actual close and costs are conservative',()=>{
  const x=cohort([
    trade({currentGrossPnl:'78.24',estimatedBrokerCosts:'19.08'},'-83.75','-19.08'),
    trade({currentGrossPnl:'22.36',estimatedBrokerCosts:'10.32'},'137.60','-10.32'),
    trade({currentGrossPnl:'100',estimatedBrokerCosts:'12'},'200','-10','2026-11-16T06:03:00Z'),
  ],'LEGACY_FIRST_CROSSING');
  assert.equal(x.firstSignals,2);
  assert.equal(x.laterWinners,1);
  assert.equal(x.laterLosers,1);
  assert.equal(x.realizedNetOfSignaledTrades,24.45);
  assert.equal(x.positiveAfterExtraCostMarkSignals,2);
});
test('missing cost does not assert hypothetical after-cost mark',()=>{
  const x=cohort([trade({currentGrossPnl:'-31.48'},'-83.75','-19.08')],
    'LEGACY_FIRST_CROSSING');
  assert.equal(x.firstSignals,1);
  assert.equal(x.costEvidenceSignals,0);
  assert.equal(x.positiveAfterExtraCostMarkSignals,0);
});
test('confirmed high-peak research log includes net-after-extra-cost evidence',()=>{
  const t=trade(undefined,'137.60','-10.32');
  t.HIGH_PEAK_CONFIRMED={created_at:'2026-11-16T05:56:00Z',
    metadata:{estimatedNetAfterExtraCost:22.36,brokerExtraFeeReserve:10.32}};
  const x=cohort([t],'HIGH_PEAK_CONFIRMED');
  assert.equal(x.firstSignals,1);
  assert.equal(x.positiveMarkSignals,1);
  assert.equal(x.costEvidenceSignals,1);
  assert.equal(x.positiveAfterExtraCostMarkSignals,1);
  assert.equal(x.laterWinners,1);
});
test('SQL is owner-scoped, only pre-close signal, read-only and bounded',()=>{
  assert.match(SQL,/t\.user_id=\$1 AND b\.user_id=\$1/);
  assert.match(SQL,/a\.created_at>=t\.opened_at AND a\.created_at<t\.closed_at/);
  assert.match(SQL,/t\.status='CLOSED'/);
  assert.match(SQL,/LIMIT 2001/);
  assert.doesNotMatch(SQL,/\b(?:INSERT|UPDATE|DELETE|DROP|ALTER)\s+(?:FROM|INTO|TABLE|trading)/i);
});
