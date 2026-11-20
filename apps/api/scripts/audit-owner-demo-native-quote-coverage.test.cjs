'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {parse,summarize}=require('./audit-owner-demo-native-quote-coverage.cjs');
const now='2026-11-20T05:05:00.000Z';
const line=(s,c,p='EURUSD',bid=1.1,ask=1.10002)=>JSON.stringify([s,c,p,bid,ask]);
test('two clocks must be causal and within 15 seconds',()=>{
  assert.ok(parse(line('2026-11-20T04:31:00Z','2026-11-20T04:31:05Z'),now));
  assert.equal(parse(line('2026-11-20T04:31:00Z','2026-11-20T04:31:30Z'),now),null);
  assert.equal(parse(line('2026-11-20T04:31:05Z','2026-11-20T04:31:00Z'),now),null);
  assert.equal(parse(line('2026-11-20T04:29:59Z','2026-11-20T04:30:00Z'),now),null);
});
test('malformed prices or nonbroker pairs are rejected',()=>{
  assert.equal(parse(line('2026-11-20T04:31:00Z','2026-11-20T04:31:05Z','XAUUSD'),now),null);
  assert.equal(parse(line('2026-11-20T04:31:00Z','2026-11-20T04:31:05Z','EURUSD',1.2,1.1),now),null);
  assert.equal(parse('garbage',now),null);
});
test('duplicate quote timestamps do not inflate coverage',()=>{
  const rows=[line('2026-11-20T04:31:00Z','2026-11-20T04:31:05Z'),
    line('2026-11-20T04:31:00Z','2026-11-20T04:31:06Z'),
    line('2026-11-20T04:31:03Z','2026-11-20T04:31:07Z')];
  const r=summarize(rows,now);
  assert.equal(r.pairs.EURUSD.samples,2);
  assert.equal(r.pairs.EURUSD.maxGapSeconds,3);
  assert.equal(r.pairs.EURUSD.sourceGapsOver60Seconds,0);
  assert.equal(r.ordersSent,0);
});
test('gaps over sixty seconds are explicitly flagged',()=>{
  const rows=[line('2026-11-20T04:31:00Z','2026-11-20T04:31:05Z'),
    line('2026-11-20T04:34:00Z','2026-11-20T04:34:05Z')];
  const r=summarize(rows,now);
  assert.equal(r.pairs.EURUSD.sourceGapsOver60Seconds,1);
  assert.equal(r.pairs.EURUSD.coverageFlag,'GAPS_OVER_60_SECONDS');
  assert.equal(r.pairs.AUDUSD.coverageFlag,'INSUFFICIENT_SAMPLES');
});
