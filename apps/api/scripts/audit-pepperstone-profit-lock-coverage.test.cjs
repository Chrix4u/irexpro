'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {amount,band,summarize,QUERY}=require('./audit-pepperstone-profit-lock-coverage.cjs');
test('money null is never interpreted as zero',()=>{
  assert.equal(amount(null),null);
  assert.equal(amount(''),null);
  assert.equal(amount('-19.08'),-19.08);
});
test('trade cases fall into three intended risk bands',()=>{
  assert.equal(band(14.49,80.50),'BELOW_0_20_R');
  assert.equal(band(43.31,99.75),'EARLY_0_20_TO_0_50_R');
  assert.equal(band(108.18,99.73),'HIGH_0_50_R_PLUS');
  assert.equal(band(5,null),'UNVERIFIED_RISK');
});
test('after-cost net and historical recommendation count are distinct',()=>{
  const rows=[
    {max_favorable_pnl:'43.31',initial_risk_pnl:'99.75',realised_pnl:'33.91',commission:'-17.10',swap:'0',close_reason:'PROFIT_PROTECTION',shadow_recommendations:0},
    {max_favorable_pnl:'108.18',initial_risk_pnl:'99.73',realised_pnl:'-83.75',commission:'-19.08',swap:'0',close_reason:'BROKER_CLOSE',shadow_recommendations:4},
    {max_favorable_pnl:'14.49',initial_risk_pnl:'80.50',realised_pnl:null,commission:null,swap:null,shadow_recommendations:0}
  ];
  const x=summarize(rows);
  assert.equal(x.EARLY_0_20_TO_0_50_R.net,16.81);
  assert.equal(x.EARLY_0_20_TO_0_50_R.profitProtectionCloses,1);
  assert.equal(x.HIGH_0_50_R_PLUS.net,-102.83);
  assert.equal(x.HIGH_0_50_R_PLUS.shadowRecommendedTrades,1);
  assert.equal(x.BELOW_0_20_R.unpriced,1);
});
test('query only selects bounded owner-scoped, demo broker evidence',()=>{
  assert.match(QUERY,/t\.user_id=\$1 AND b\.user_id=\$1/);
  assert.match(QUERY,/b\.account_type='DEMO'/);
  assert.match(QUERY,/LIMIT \$4::int/);
  assert.doesNotMatch(QUERY,/\b(?:UPDATE|DELETE|INSERT|ALTER|DROP)\s+(?:TABLE|FROM|INTO|trading)/i);
});
