'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {
  OWNER_SQL,REALIZED_SQL,toAmount,canonicalRows,summarizeRows,analyze,runAudit,
}=require('./audit-planb-realised-net-sleeves.cjs');

const SAMPLE=(overrides={})=>({
  id:'trade-1',instrument:'AUDUSD',direction:'BUY',
  route:'TREND_CONTINUATION',modelVersion:'multimodel-v1',
  closedAt:'2026-11-09T10:00:00Z',gross:'7.00',
  commission:'-1.60',swap:'0',...overrides,
});

test('uses net of actual commission/swap, not gross wins',()=>{
  const rows=canonicalRows([
    SAMPLE({id:'a',gross:'2',commission:'-3'}),
    SAMPLE({id:'b',gross:'10',commission:'-1',closedAt:'2026-11-09T11:00:00Z'}),
  ]);
  const x=summarizeRows(rows);
  assert.equal(x.closedTrades,2);
  assert.equal(x.winRate,0.5);
  assert.equal(x.grossEUR,12);
  assert.equal(x.commissionEUR,-4);
  assert.equal(x.netEUR,8);
  assert.equal(x.positiveNetEUR,9);
  assert.equal(x.negativeNetEUR,-1);
  assert.equal(x.profitFactor,9);
  assert.equal(x.closedPnlPeakToTroughEUR,1);
  assert.equal(x.screeningLabel,'INSUFFICIENT_INDEPENDENT_DAYS');
});

test('keeps actual trade days and pair-side-route sleeves distinct',()=>{
  const report=analyze([
    SAMPLE({id:'a',gross:8,commission:-1,closedAt:'2026-11-04T08:00:00Z'}),
    SAMPLE({id:'b',gross:-5,commission:-1,closedAt:'2026-11-09T08:00:00Z'}),
    SAMPLE({id:'c',instrument:'GBPUSD',direction:'SELL',
      route:'CONFIRMED_REVERSAL',gross:6,commission:-1.4}),
  ],'2026-11-09T15:00:00Z');
  assert.equal(report.byDay['2026-11-04'].netEUR,7);
  assert.equal(report.byDay['2026-11-09'].netEUR,-1.4);
  assert.equal(report.byPair['AUDUSD'].netEUR,1);
  assert.equal(report.bySleeve['GBPUSD/SELL/CONFIRMED_REVERSAL'].netEUR,4.6);
  assert.equal(report.changesTradingAuthority,false);
  assert.equal(report.changesBrokerOrders,false);
});

test('one profitable session with many trades cannot count as validated edge',()=>{
  const rows=Array.from({length:35},(_,i)=>SAMPLE({id:String(i),
    gross:10,commission:-1,closedAt:'2026-11-04T08:00:00Z'}));
  const result=analyze(rows,'2026-11-09T15:00:00Z');
  const stats=result.bySleeve['AUDUSD/BUY/TREND_CONTINUATION'];
  assert.equal(stats.closedTrades,35);
  assert.equal(stats.tradingDays,1);
  assert.equal(stats.screeningLabel,'INSUFFICIENT_INDEPENDENT_DAYS');
});

test('rejects duplicate or malformed broker trade rows, without guessing costs',()=>{
  assert.throws(()=>canonicalRows([SAMPLE({commission:null})]),/UNRELIABLE_BROKER_REALIZED_ROW/);
  assert.throws(()=>canonicalRows([SAMPLE({gross:'NaN'})]),/UNRELIABLE_BROKER_REALIZED_ROW/);
  assert.throws(()=>canonicalRows([SAMPLE({direction:'ABSTAIN'})]),/UNRELIABLE_BROKER_REALIZED_ROW/);
  assert.throws(()=>canonicalRows([SAMPLE(),SAMPLE()]),/UNRELIABLE_BROKER_REALIZED_ROW/);
  assert.equal(toAmount(''),null);
  assert.equal(canonicalRows([SAMPLE({swap:null})])[0].swap,0);
});

test('a losing sleeve with adequate day count still fails after-cost screen',()=>{
  const records=Array.from({length:36},(_,i)=>SAMPLE({
    id:String(i),closedAt:new Date(Date.UTC(2026,9,1+Math.floor(i/3),8)).toISOString(),
    gross:i%3===0?5:-4,commission:-1.5,
  }));
  const stats=analyze(records,'2026-11-09T15:00:00Z').total;
  assert.equal(stats.tradingDays,12);
  assert.equal(stats.screeningLabel,'NEGATIVE_OR_WEAK_AFTER_COST_EVIDENCE');
});

test('requires account-owned cTrader DEMO and read-only transaction',async()=>{
  const queries=[];
  const client={query:async(sql)=>{
    queries.push(sql);
    return {rows:[]};
  }};
  await assert.rejects(runAudit({
    client,userId:'fbeee4fa-1cd3-4adf-b378-0b6d7a6b5d22',
    connectionId:'ff7e1f93-0fc3-43f8-bccc-6a7a2ab366c1',
  }),/OWNER_DEMO_CTRADER_NOT_FOUND/);
  assert.match(queries[0],/READ ONLY/);
  assert.equal(queries.at(-1),'ROLLBACK');
  assert.match(OWNER_SQL,/user_id=\$2/);
  assert.match(REALIZED_SQL,/t.user_id=\$1/);
  assert.match(REALIZED_SQL,/t.broker_connection_id=\$2/);
  assert.match(REALIZED_SQL,/PRIMARY_PLAN_B/);
});


test('keeps incomplete broker settlements visible without imputing their costs',async()=>{
  const client={query:async(sql)=>{
    if(sql.includes('SELECT current_timestamp AS')) return {
      rows:[{snapshotAt:'2026-11-09T15:00:00Z'}],
    };
    if(sql.includes('SELECT t.id')) return {
      rows:[
        SAMPLE({id:'good',gross:'8',commission:'-1.6'}),
        SAMPLE({id:'unpriced',gross:null,commission:null,
          instrument:'USDJPY',direction:'SELL',route:'EARLY_TRANSITION'}),
      ],
    };
    return {rows:[]};
  }};
  const report=await runAudit({
    client,userId:'fbeee4fa-1cd3-4adf-b378-0b6d7a6b5d22',
    connectionId:'ff7e1f93-0fc3-43f8-bccc-6a7a2ab366c1',
  });
  assert.equal(report.total.closedTrades,1);
  assert.equal(report.total.netEUR,6.4);
  assert.deepEqual(report.dataQuality,{
    queriedClosedTrades:2,
    pricedClosedTrades:1,
    unpricedClosedTrades:1,
    unpricedBySleeve:{'USDJPY/SELL/EARLY_TRANSITION':1},
    afterCostTotalComplete:false,
  });
  assert.ok(report.limitations.some(text=>text.includes('PARTIAL')));
});
