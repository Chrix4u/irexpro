'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {brokerMarkNetUSD,eligibleMark,summarize}=
  require('./audit-short-horizon-broker-marks.cjs');
const opened='2026-11-11T08:00:15.000Z';
const closed='2026-11-11T08:12:15.000Z';
const trade={instrument:'EURUSD',direction:'BUY',opened_at:opened,closed_at:closed,
  fill_price:1.12,lot_size:4,realised_pnl:0,commission:-24,swap:0,
  close_reason:'BROKER_CLOSE',max_favorable_pnl:80};
const quote=(time,bid,ask,opts={})=>({
  last_quote_sample_at:time,bid_close:bid,ask_close:ask,
  positive_quote_sample_count:10,source:'ctrader-broker-native',...opts,
});
test('BUY closes at bid and SELL closes at ask, not midpoint',()=>{
 const buy=brokerMarkNetUSD(trade,1.12010);
 const sell=brokerMarkNetUSD({...trade,direction:'SELL'},1.11990);
 assert.ok(Math.abs(buy.netUSD-16)<0.001);
 assert.ok(Math.abs(sell.netUSD-16)<0.001);
});
test('USD-base quote-currency gross PnL is converted back to USD at executable close mark',()=>{
 const jpy=brokerMarkNetUSD({...trade,instrument:'USDJPY',fill_price:158.922,
  direction:'BUY'},158.972);
 assert.ok(Math.abs(jpy.grossUSD - 20000/158.972)<0.0001);
 const chf=brokerMarkNetUSD({...trade,instrument:'USDCHF',fill_price:0.82592,
  direction:'SELL'},0.82542);
 assert.ok(Math.abs(chf.grossUSD-200/0.82542)<0.001);
});
test('only a broker-native quote first observed AFTER horizon and BEFORE actual close qualifies',()=>{
 const quotes=[
  quote('2026-11-11T08:01:10Z',1.12030,1.12035),
  quote('2026-11-11T08:01:59Z',1.12040,1.12045),
  quote('2026-11-11T08:02:40Z',1.12060,1.12065),
 ];
 const one=eligibleMark(trade,1,quotes);
 assert.equal(one.quoteTime,'2026-11-11T08:01:59.000Z');
 assert.ok(one.netUSD>0);
 assert.equal(eligibleMark(trade,3,quotes),null);
});
test('expired and post-closure quotes never give profitable future hindsight',()=>{
 const short={...trade,closed_at:'2026-11-11T08:01:20Z'};
 assert.equal(eligibleMark(short,3,[quote('2026-11-11T08:04:30Z',1.123,1.124)]),null);
 assert.equal(eligibleMark(short,1,[quote('2026-11-11T08:01:35Z',1.123,1.124)]),null);
});
test('rejects non-broker, bad spread, empty quote and future beyond minute tolerance',()=>{
 const bad=[
  quote('2026-11-11T08:01:55Z',1.1203,1.12032,{source:'synthetic'}),
  quote('2026-11-11T08:01:56Z',1.1203,1.12032,{positive_quote_sample_count:0}),
  quote('2026-11-11T08:01:57Z',1.1204,1.12035),
  quote('2026-11-11T08:03:15Z',1.1205,1.12055),
 ];
 assert.equal(eligibleMark(trade,1,bad),null);
});
test('invalid prices/fees/fx pairs are not converted to assumed profitability',()=>{
 assert.equal(brokerMarkNetUSD({...trade,commission:null},1.1201),null);
 assert.equal(brokerMarkNetUSD({...trade,instrument:'EURGBP'},1.1201),null);
 assert.equal(brokerMarkNetUSD({...trade,lot_size:0},1.1201),null);
});
test('counts actual trade closed before horizon separately from unobserved quotes',()=>{
 const records=[
  {...trade,quotes:[quote('2026-11-11T08:01:59Z',1.1204,1.12042)]},
  {...trade,closed_at:'2026-11-11T08:00:45Z',quotes:[]},
 ];
 const stats=summarize(records);
 assert.equal(stats.count,2);
 assert.equal(stats.horizonObservations[0].eligible,1);
 assert.equal(stats.horizonObservations[0].closedBeforeHorizon,1);
 assert.equal(stats.horizonObservations[1].closedBeforeHorizon,1);
 assert.equal(stats.horizonObservations[1].missingBrokerQuote,1);
});
