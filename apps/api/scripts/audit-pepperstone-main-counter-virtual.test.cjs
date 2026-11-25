'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {evaluatePair,reportFor,SQL,validQuote}=require('./audit-pepperstone-main-counter-virtual.cjs');
function q(time,high,low,bid,ask,spread=.0001){
 return {bucket_time:time,high,low,last_positive_bid:bid,last_positive_ask:ask,
   last_positive_spread:spread,positive_quote_sample_count:5,
   source:'ctrader-broker-native'};
}
const quotes=[
 q('2026-11-16T15:11:00Z',1.2001,1.1999,1.2,1.2001),
 q('2026-11-16T15:12:00Z',1.2005,1.2000,1.2004,1.2005),
 q('2026-11-16T15:13:00Z',1.2010,1.2007,1.2009,1.2010)
];
function main(overrides={}){
 return {id:'abcd',instrument:'EURUSD',direction:'SELL',lot_size:'1',
  opened_at:'2026-11-16T15:11:22Z',closed_at:'2026-11-16T15:13:30Z',
  fill_price:'1.2000',exit_price:'1.2010',stop_loss:'1.2005',
  take_profit:'1.1990',status:'CLOSED',close_reason:'BROKER_CLOSE',
  realised_pnl:'-100',commission:'-6',swap:'0',quotes,...overrides};
}
test('MAIN SELL loss versus virtual BUY gains after double-sided costs',()=>{
 const p=evaluatePair(main());
 assert.equal(p.main.netUsd,-106);
 assert.equal(p.main.direction,'SELL');
 assert.equal(p.counter.direction,'BUY');
 assert.equal(p.counter.matchedHorizonNetUsd,74);
 assert.equal(p.counter.mirroredBarrierNetUsd,74);
 assert.equal(p.counter.isBrokerOrder,false);
 assert.equal(p.counter.linkedMain,p.main.id);
 assert.equal(p.main.netUsd+p.counter.matchedHorizonNetUsd,-32);
});
test('MAIN BUY win implies virtual SELL same-horizon loss with both spread costs',()=>{
 const p=evaluatePair(main({direction:'BUY',realised_pnl:'100',
  exit_price:'1.2010',stop_loss:'1.1995',take_profit:'1.2015'}));
 assert.equal(p.main.netUsd,94);
 assert.equal(p.counter.direction,'SELL');
 assert.equal(p.counter.matchedHorizonNetUsd,-126);
});
test('counter can hit its stop before later same-horizon apparent profit',()=>{
 const path=[quotes[0],q('2026-11-16T15:12:00Z',1.2005,1.1990,1.2004,1.2005),quotes[2]];
 const p=evaluatePair(main({quotes:path}));
 assert.equal(p.counter.barrierOutcome,'VIRTUAL_STOP_FIRST');
 assert.equal(p.counter.mirroredBarrierNetUsd,-56);
 assert.equal(p.counter.matchedHorizonNetUsd,74);
});
test('simultaneous STOP and TP in one candle is ambiguous, not a fabricated win',()=>{
 const path=[quotes[0],q('2026-11-16T15:12:00Z',1.2020,1.1990,1.2004,1.2005),quotes[2]];
 const p=evaluatePair(main({quotes:path,take_profit:'1.1985'}));
 assert.equal(p.counter.barrierOutcome,'AMBIGUOUS_BOTH_BARRIERS_SAME_MINUTE');
 assert.equal(p.counter.mirroredBarrierNetUsd,null);
});
test('absence of entry spread yields an unresolved virtual trade',()=>{
 const p=evaluatePair(main({quotes:quotes.slice(1)}));
 assert.equal(p.counter.matchedHorizonNetUsd,null);
 assert.equal(p.counter.reason,'BROKER_ENTRY_OR_EXIT_SPREAD_UNAVAILABLE');
});
test('stale or zero native quotes cannot produce live marks',()=>{
 const p=evaluatePair(main({status:'OPEN',closed_at:null,exit_price:null,
  realised_pnl:null,commission:null,quotes:[quotes[0]]}),
  new Date('2026-11-16T15:20:00Z'));
 assert.equal(p.counter.openMarkEstimateNetUsd,null);
 assert.equal(p.counter.reason,'WAITING_FOR_FRESH_NATIVE_BROKER_QUOTES');
});
test('open live MAIN and virtual COUNTER have separate opposite mark estimates',()=>{
 const p=evaluatePair(main({status:'OPEN',closed_at:null,exit_price:null,
   realised_pnl:null,commission:null,quotes}),
   new Date('2026-11-16T15:13:30Z'));
 assert.equal(p.counter.state,'VIRTUAL_MONITORED_OPEN');
 assert.equal(p.main.openMarkEstimateNetUsd,-106);
 assert.equal(p.counter.openMarkEstimateNetUsd,74);
 assert.equal(p.counter.estimatedRoundTripCommissionUsd,6);
 assert.equal(p.counter.isBrokerOrder,false);
});
test('broker quote source and positive spread required',()=>{
 assert.equal(validQuote({...quotes[0],source:'rest-estimate'}),false);
 assert.equal(validQuote({...quotes[0],last_positive_spread:0}),false);
 assert.equal(validQuote(quotes[0]),true);
});
test('grouping does not misstate sample when virtual comparison unobservable',()=>{
 const r=reportFor([main(),main({id:'other',quotes:[]})],
 new Date('2026-11-16T15:14:00Z'));
 assert.equal(r.daily['2026-11-16'].mainClosed,2);
 assert.equal(r.daily['2026-11-16'].counterComparable,1);
 assert.equal(r.daily['2026-11-16'].unresolvedCounter,1);
 assert.equal(r.modifiesTrading,false);
 assert.equal(r.executionAuthority,'NONE');
});
test('the database query cannot route broker orders',()=>{
 assert.match(SQL,/t\.user_id=\$1/);
 assert.match(SQL,/b\.broker_id='pepperstone-ctrader'/);
 assert.match(SQL,/b\.account_type='DEMO'/);
 assert.match(SQL,/t\.account_currency='USD'/);
 assert.match(SQL,/LIMIT \$3::int/);
 assert.doesNotMatch(SQL,/\b(?:INSERT|UPDATE|DELETE|DROP|ALTER|CALL)\b/i);
});
