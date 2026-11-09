'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {ROWS_SQL,OWNER_SQL,normalize,analyze,run}
=require('./audit-planb-expert-entry-calibration.cjs');

const DATA=(extra={})=>({
  id:'trade-1',instrument:'EURUSD',direction:'BUY',route:'TREND_CONTINUATION',
  openedAt:'2026-11-09T08:48:29Z',intentAt:'2026-11-09T08:48:22Z',
  decisionAt:'2026-11-09T08:48:18Z',expertOpportunity:'0.32',
  expertState:'ABSTAIN',expertConfidence:'0.55',
  gross:'-4.18',commission:'-1.62',swap:'0',
  plannedEntry:'1.11877',priorLossAt:'2026-11-09T08:46:24Z',
  priorEntry:'1.11877',priorStop:'1.11827',...extra,
});
test('detects a price-identical recent same-side retry using pre-order proposed entry',()=>{
  const r=normalize(DATA());
  assert.equal(r.rapidSameSideLossRetry,true);
  assert.equal(r.priorLossDistanceR,0);
  assert.equal(r.expertBand,'EXPLORATORY_LOW');
  assert.equal(r.expertState,'ABSTAIN');
  assert.equal(Number(r.net.toFixed(2)),-5.80);
});
test('does not call a materially repriced or 10m-old opportunity the same signal',()=>{
  assert.equal(normalize(DATA({plannedEntry:'1.11917'})).rapidSameSideLossRetry,false);
  assert.equal(normalize(DATA({priorLossAt:'2026-11-09T08:38:00Z'})).rapidSameSideLossRetry,false);
  assert.equal(normalize(DATA({plannedEntry:null})).rapidSameSideLossRetry,false);
});
test('rejects expert observations saved after intent or earlier than allowed as-of window',()=>{
  assert.equal(normalize(DATA({decisionAt:'2026-11-09T08:48:25Z'})).expertBand,
    'UNVERIFIED_EXPERT_PROVENANCE');
  assert.equal(normalize(DATA({decisionAt:'2026-11-09T08:30:00Z'})).expertBand,
    'UNVERIFIED_EXPERT_PROVENANCE');
  assert.equal(normalize(DATA({expertOpportunity:'NaN'})).expertBand,
    'UNVERIFIED_EXPERT_PROVENANCE');
});
test('missing finance values remain incomplete, not free/zero-commission',()=>{
  const a=analyze([DATA({gross:null}),DATA({id:'x',openedAt:'2026-11-09T09:00:00Z',
    intentAt:'2026-11-09T08:59:55Z',decisionAt:'2026-11-09T08:59:50Z'})],
    '2026-11-09T12:00:00Z');
  assert.equal(a.total.records,2);
  assert.equal(a.total.priced,1);
  assert.equal(a.total.unpriced,1);
  assert.equal(a.total.coverageComplete,false);
  assert.equal(a.modifiesOrders,false);
  assert.equal(a.modifiesExecution,false);
});
test('source analysis keeps day, route and exploratory score cohorts separate',()=>{
  const rows=[
    DATA({id:'loss',expertOpportunity:'0.29'}),
    DATA({id:'win',openedAt:'2026-11-04T08:30:00Z',
      intentAt:'2026-11-04T08:29:55Z',decisionAt:'2026-11-04T08:29:50Z',
      gross:'6',commission:'-1',priorLossAt:null,expertOpportunity:'0.41'}),
  ];
  const x=analyze(rows,'2026-11-09T12:00:00Z');
  assert.equal(x.total.records,2);
  assert.equal(x.expertRoute['TREND_CONTINUATION/EXPLORATORY_LOW'].netEUR,-5.8);
  assert.equal(x.expertRoute['TREND_CONTINUATION/EXPLORATORY_HIGH'].netEUR,5);
  assert.equal(x.byDay['2026-11-04'].netEUR,5);
  assert.equal(x.total.reason,'INSUFFICIENT_INDEPENDENT_DAYS');
  assert.throws(()=>analyze([...rows,rows[0]],'2026-11-09T12:00:00Z'),
    /DUPLICATE_BROKER_TRADE/);
});
test('shows gross winners lost to costs without overstating after-fee results',()=>{
  const rows=[
    DATA({id:'fee-flip',gross:'1',commission:'-2',expertOpportunity:'0.38',expertState:'ABSTAIN'}),
    DATA({id:'actual-net-win',openedAt:'2026-11-09T09:02:00Z',
      intentAt:'2026-11-09T09:01:55Z',decisionAt:'2026-11-09T09:01:51Z',
      gross:'5',commission:'-1',expertOpportunity:'0.38',expertState:'CONFIRM',
      priorLossAt:null}),
    DATA({id:'missing-commission',openedAt:'2026-11-09T09:22:00Z',
      intentAt:'2026-11-09T09:21:55Z',decisionAt:'2026-11-09T09:21:50Z',
      gross:'7',commission:null,priorLossAt:null}),
  ];
  const report=analyze(rows,'2026-11-09T12:00:00Z');
  assert.equal(report.total.records,3);
  assert.equal(report.total.priced,2);
  assert.equal(report.total.unpriced,1);
  assert.equal(report.total.grossWins,2);
  assert.equal(report.total.netWins,1);
  assert.equal(report.total.grossPositiveNetNonpositive,1);
  assert.equal(report.total.grossWinFraction,1);
  assert.equal(report.total.netWinFraction,0.5);
  assert.equal(report.total.netEUR,3);
  assert.equal(report.byRoute.TREND_CONTINUATION.grossPositiveNetNonpositive,1);
  assert.equal(report.byExpertState['ABSTAIN/EXPLORATORY_HIGH'].netEUR,-1);
  assert.equal(report.byExpertState['CONFIRM/EXPLORATORY_HIGH'].netEUR,4);
  assert.equal(report.modifiesExecution,false);
  assert.equal(report.total.forwardQualified,false);
});
test('scope SQL and transaction guarantee read-only cTrader DEMO and as-of join',async()=>{
  assert.match(OWNER_SQL,/user_id=\$2/);
  assert.match(OWNER_SQL,/account_type='DEMO'/);
  assert.match(ROWS_SQL,/t.user_id=\$1/);
  assert.match(ROWS_SQL,/t.broker_connection_id=\$2/);
  assert.match(ROWS_SQL,/d.created_at<=i.created_at/);
  assert.match(ROWS_SQL,/q.closed_at<i.created_at/);
  assert.match(ROWS_SQL,/PRIMARY_PLAN_B/);
  const calls=[];
  const client={query:async(sql)=>{calls.push(sql);return{rows:[]}}};
  await assert.rejects(run({client,
    userId:'2caa0c64-00dd-48fb-babb-06b39cb74068',
    connectionId:'26ef9b4e-6e24-4a65-a4f2-8db22e209e9d',
  }),/NOT_USER_OWNED_CTRADER_DEMO/);
  assert.match(calls[0],/READ ONLY/);
  assert.equal(calls.at(-1),'ROLLBACK');
});
