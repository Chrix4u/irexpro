'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {route,tradeRows,OUT}=require('./run-owner-demo-commission-routing-shadow.cjs');
test('route names are normalized without reclassifying unrecognized strategies',()=>{
 assert.equal(route('M1_EARLY_TRANSITION'),'EARLY_TRANSITION');
 assert.equal(route('M1_CONFIRMED_REVERSAL'),'CONFIRMED_REVERSAL');
 assert.equal(route('M1_TREND_CONTINUATION'),'TREND_CONTINUATION');
 assert.equal(route('CUSTOM_MODEL'),'CUSTOM_MODEL');
});
test('pre-entry capital allocation is used without masking malformed final risk',()=>{
 const base={instrument:'EURUSD',currency:'USD',route:'M1_EARLY_TRANSITION',
 lots:'4',openedAt:new Date('2026-11-17T12:00:00Z'),
 closedAt:new Date('2026-11-17T12:15:00Z'),
 allocationCreatedAt:new Date('2026-11-17T11:59:30Z'),
 grossPnl:'120',commission:'-36',swap:'0',
 m1ExpectedNetR:'.32',finalRiskAtStop:'250',fallbackRiskAmount:'400'};
 const x=tradeRows([base],'opaque-connection');
 assert.equal(x.length,1);
 assert.equal(x[0].initialCashRisk,'250');
 assert.equal(x[0].route,'EARLY_TRANSITION');
 assert.equal(x[0].preExistingExpectedNetR,'.32');
 assert.equal(x[0].brokerConnectionId,'opaque-connection');
 const invalid=tradeRows([{...base,finalRiskAtStop:'BAD'}],'opaque-connection');
 assert.equal(invalid[0].initialCashRisk,'BAD');
 const fallback=tradeRows([{...base,finalRiskAtStop:null}],'opaque-connection');
 assert.equal(fallback[0].initialCashRisk,'400');
});
test('read-only owner-scoped USD DEMO query; no account secret in the output schema',()=>{
 const src=fs.readFileSync(__filename.replace('.test.cjs','.cjs'),'utf8');
 assert.match(src,/BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY/);
 assert.match(src,/broker_id='pepperstone-ctrader'/);
 assert.match(src,/account_type='DEMO'/);
 assert.match(src,/account_currency='USD'/);
 assert.match(src,/WHERE t.user_id=\$1 AND t.broker_connection_id=\$2/);
 assert.match(src,/commission/);
 assert.match(src,/m1_net_expected_r/);
 assert.match(src,/ca0.created_at<=t.opened_at/);
 assert.match(src,/MAX\+1/);
 assert.doesNotMatch(src,/\b(?:placeOrder|executeTrade|closePosition|UPDATE\s+trading|DELETE\s+FROM|INSERT\s+INTO)\s*\(/);
 assert.match(OUT,/irexpro-research\/net-economics-shadow\/latest.json$/);
});
