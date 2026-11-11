'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SCOPE_SQL, ACTIVE_DEMO_CONNECTION_SQL, TRADE_SQL,
  runAudit, evaluateRows,
} = require('./audit-commission-r-calibration-gap.cjs');

const USER = '2caa0c64-00dd-48fb-babb-06b39cb74068';
const PEPPERSTONE = '26ef9b4e-6e24-4a65-a4f2-8db22e209e9d';
const PREVIOUS = 'b2f686be-b7ea-4b24-b9cb-fcc89b9cfaef';
const ASOF = '2026-11-11T01:30:00.000Z';
const SINCE = '2026-11-01T00:00:00.000Z';

function trade(overrides = {}) {
  return {
    instrument:'USDJPY',direction:'BUY',openedAt:'2026-11-10T10:00:00Z',
    closedAt:'2026-11-10T10:22:00Z',
    allocationCreatedAt:'2026-11-10T09:59:00Z',
    currency:'USD',grossPnl:'100',commission:'-24',swap:'0',
    engine:'external-irexpro-multimodel-ensemble',route:'TREND_CONTINUATION',
    allocationRiskAtStop:'100',fallbackAllocationRisk:null,
    m1ExpectedNetR:'0.4',planBExpectedNetR:'0.35',modeledSpreadCostR:'0.05',
    modeledCostSource:'BROKER_SPREAD',
    ...overrides,
  };
}
function client({ connectionId = PEPPERSTONE, brokerId='pepperstone-ctrader',
  rows=[trade(),trade({instrument:'GBPUSD',grossPnl:'-80'})] }={}) {
  const calls=[];
  return {
    calls,
    query:async(sql,params)=>{
      calls.push({sql,params});
      if(sql===ACTIVE_DEMO_CONNECTION_SQL) return {rows:connectionId?[{connectionId}]:[]};
      if(sql===SCOPE_SQL) return {rows:[{asOf:ASOF,brokerId,accountCurrency:'USD'}]};
      if(sql===TRADE_SQL) return {rows};
      return {rows:[]};
    },
  };
}
const input=(c,connectionId)=>({
  client:c,userId:USER,connectionId,since:SINCE,maxRows:50,
});

test('uses active, exact user-owned FULL_AUTO Pepperstone DEMO rather than stale data account',async()=>{
  assert.match(SCOPE_SQL, /'pepperstone-ctrader'/);
  assert.match(SCOPE_SQL, /'icmarkets-ctrader'/);
  assert.match(SCOPE_SQL, /account_type='DEMO'/);
  assert.match(ACTIVE_DEMO_CONNECTION_SQL, /s.user_id=\$1/);
  assert.match(ACTIVE_DEMO_CONNECTION_SQL, /b.user_id=s.user_id/);
  assert.match(ACTIVE_DEMO_CONNECTION_SQL, /s.status='ACTIVE'/);
  assert.match(ACTIVE_DEMO_CONNECTION_SQL, /s.execution_mode='FULL_AUTO'/);
  assert.match(TRADE_SQL, /ti.user_id=\$1 AND ti.broker_connection_id=\$2/);
  assert.match(TRADE_SQL, /ca0.created_at<=t.opened_at/);
  const c=client();
  const report=await runAudit(input(c));
  assert.equal(report.brokerId,'pepperstone-ctrader');
  assert.equal(report.accountCurrency,'USD');
  assert.equal(report.promotionEligible,false);
  assert.equal(report.cohortQualified,false);
  assert.equal(report.modifiesExecution,false);
  assert.equal(report.byCurrency['USD | ALL'].pairedRealizedNetR,2);
  assert.equal(report.byCurrency['USD | ALL'].netProfitable,1);
  assert.equal(report.byCurrency['USD | ALL'].netUnprofitable,1);
  assert.equal(report.byCurrency['USD | ALL'].meanRealizedNetR,-0.14);
  assert.match(c.calls[0].sql,/REPEATABLE READ READ ONLY/);
  assert.deepEqual(c.calls.find(x=>x.sql===TRADE_SQL).params.slice(0,2),
    [USER,PEPPERSTONE]);
  assert.equal(c.calls.at(-1).sql,'COMMIT');
});

test('explicit prior DEMO connection override remains owner-scoped, never silently used',async()=>{
  const c=client({brokerId:'ctrader'});
  const result=await runAudit(input(c,PREVIOUS));
  assert.equal(result.brokerId,'ctrader');
  assert.equal(c.calls.some(x=>x.sql===ACTIVE_DEMO_CONNECTION_SQL),false);
  assert.deepEqual(c.calls.find(x=>x.sql===SCOPE_SQL).params,[PREVIOUS,USER]);
  assert.deepEqual(c.calls.find(x=>x.sql===TRADE_SQL).params.slice(0,2),
    [USER,PREVIOUS]);
});

test('refuses missing active session, never queries another broker account, rolls back',async()=>{
  const c=client({connectionId:null});
  await assert.rejects(runAudit(input(c)),/ACTIVE_CTRADER_DEMO_UNAVAILABLE/);
  assert.equal(c.calls.some(x=>x.sql===TRADE_SQL),false);
  assert.equal(c.calls.at(-1).sql,'ROLLBACK');
});

test('refuses invalid IDs before transaction, and rejects truncated cohorts',async()=>{
  const c=client();
  await assert.rejects(runAudit({...input(c),userId:'invalid'}),/INVALID_DEMO_SCOPE/);
  await assert.rejects(runAudit(input(c,'not-uuid')),/INVALID_DEMO_SCOPE/);
  assert.equal(c.calls.length,0);
  const filled=client({rows:Array.from({length:51},(_,i)=>trade({grossPnl:String(i)}))});
  await assert.rejects(runAudit(input(filled)),/TRUNCATED_TRADE_HISTORY/);
  assert.equal(filled.calls.at(-1).sql,'ROLLBACK');
});

test('missing commission or risk remains excluded; never treats missing costs as free',()=>{
  const report=evaluateRows([
    trade(),trade({commission:null}),trade({allocationRiskAtStop:'broken'}),
  ],SINCE,ASOF);
  assert.equal(report.byCurrency['USD | ALL'].trades,3);
  assert.equal(report.byCurrency['USD | ALL'].pairedRealizedNetR,1);
  assert.equal(report.byCurrency['USD | ALL'].skippedIncompleteCostOrRisk,2);
});

test('does not pool different account currencies into one false profitability series',()=>{
  const r=evaluateRows([
    trade(),trade({currency:'EUR',instrument:'EURUSD',grossPnl:'1000'}),
  ],SINCE,ASOF);
  assert.equal(r.byCurrency['USD | ALL'].pairedRealizedNetR,1);
  assert.equal(r.byCurrency['EUR | ALL'].pairedRealizedNetR,1);
  assert.equal(r.byCurrency['USD | ALL'].meanRealizedNetR,0.76);
  assert.equal(r.byCurrency['EUR | ALL'].meanRealizedNetR,9.76);
});
