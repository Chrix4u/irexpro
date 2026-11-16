'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {amount,classifyHistory,replayAsOf,SQL}=require('./audit-pepperstone-asof-entry-quality.cjs');
function trade(id,instrument,direction,opened,closed,net,risk=100){
  return {id,instrument,direction,openedAt:opened,closedAt:closed,net,risk};
}
test('missing amounts remain missing',()=>{
  assert.equal(amount(null),null);
  assert.equal(amount(''),null);
  assert.equal(amount('33.91'),33.91);
});
test('lack of independent days is unknown, not negative edge',()=>{
  const h=Array.from({length:10},(_,i)=>({
    net:i%2?120:-20,risk:100,
    closedAt:new Date(Date.UTC(2026,10,12,i)).toISOString()}));
  const c=classifyHistory(h);
  assert.equal(c.n,10);
  assert.equal(c.days,1);
  assert.equal(c.shadowAssessment,'UNKNOWN');
});
test('profitable sample with distinct days is supportive only in shadow',()=>{
 const h=Array.from({length:12},(_,i)=>({
   net:i%4===0?-25:90,risk:100,
   closedAt:new Date(Date.UTC(2026,10,10+Math.floor(i/4),i%4)).toISOString()}));
 const c=classifyHistory(h);
 assert.equal(c.shadowAssessment,'SUPPORTIVE_HISTORICAL_EDGE');
 assert.equal(c.days,3);
});
test('concurrent trade not yet closed cannot contaminate a later entry',()=>{
 const rows=[
   trade('a','AUDUSD','SELL','2026-11-10T08:00:00Z','2026-11-10T12:00:00Z',100),
   trade('b','AUDUSD','SELL','2026-11-10T09:00:00Z','2026-11-10T09:10:00Z',-100),
   trade('c','AUDUSD','SELL','2026-11-10T12:01:00Z','2026-11-10T12:10:00Z',50)
 ];
 const out=replayAsOf(rows);
 assert.equal(out.allAsOfDecisions[1].historical.n,0);
 assert.equal(out.allAsOfDecisions[2].historical.n,2);
});
test('only same pair and direction form history',()=>{
 const rows=[
   trade('a','USDJPY','BUY','2026-11-10T07:00:00Z','2026-11-10T07:05:00Z',100),
   trade('b','USDJPY','SELL','2026-11-10T07:10:00Z','2026-11-10T07:15:00Z',-100),
   trade('c','AUDUSD','BUY','2026-11-10T07:20:00Z','2026-11-10T07:25:00Z',-100),
   trade('d','USDJPY','BUY','2026-11-10T07:30:00Z','2026-11-10T07:35:00Z',50)
 ];
 assert.equal(replayAsOf(rows).allAsOfDecisions[3].historical.n,1);
});
test('three consecutive closed losses are a causal caution, not an executable veto',()=>{
  const rows=[
    trade('a','USDJPY','SELL','2026-11-10T01:00:00Z','2026-11-10T01:03:00Z',-50),
    trade('b','USDJPY','SELL','2026-11-10T02:00:00Z','2026-11-10T02:03:00Z',-50),
    trade('c','USDJPY','SELL','2026-11-10T03:00:00Z','2026-11-10T03:03:00Z',-50),
    trade('d','USDJPY','SELL','2026-11-10T04:00:00Z','2026-11-10T04:03:00Z',-70),
  ];
  const x=replayAsOf(rows);
  assert.equal(x.allAsOfDecisions[3].historical.recentConsecutiveLosses,3);
  assert.equal(x.allAsOfDecisions[3].historical.lossStreakCaution,true);
  assert.equal(x.allAsOfDecisions[3].historical.shadowAssessment,'UNKNOWN');
  assert.equal(x.byLossStreakCaution.CAUTION_3_PLUS.losses,1);
});
test('a completed winning trade resets the causal losing streak',()=>{
  const x=classifyHistory([
    {net:-50,risk:100,closedAt:'2026-11-10T01:01:00Z'},
    {net:-50,risk:100,closedAt:'2026-11-10T01:02:00Z'},
    {net:-50,risk:100,closedAt:'2026-11-10T01:03:00Z'},
    {net:40,risk:100,closedAt:'2026-11-10T01:04:00Z'},
  ]);
  assert.equal(x.lossStreakCaution,false);
  assert.equal(x.recentConsecutiveLosses,0);
});
test('invalid entry and exit timestamp ordering is rejected',()=>{
 assert.throws(()=>replayAsOf([trade('a','AUDUSD','BUY',
 '2026-11-11T12:00:00Z','2026-11-11T11:00:00Z',10)]),/INVALID_TRADE_TIMESTAMPS/);
});
test('query is owner-scoped and bounded to closed demo trades',()=>{
 assert.match(SQL,/t\.user_id=\$1 AND b\.user_id=\$1/);
 assert.match(SQL,/b\.account_type='DEMO'/);
 assert.match(SQL,/t\.status='CLOSED'/);
 assert.match(SQL,/LIMIT 3001/);
 assert.doesNotMatch(SQL,/\b(?:UPDATE|DELETE|INSERT|ALTER|DROP)\s+(?:FROM|INTO|TABLE|trading)/i);
});
