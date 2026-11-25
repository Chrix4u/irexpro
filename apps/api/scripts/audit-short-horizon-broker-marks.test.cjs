'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {brokerMarkNetUSD,eligibleMark,summarize,groupActualAndSurvivingMarks}=
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


test('strategy audit separates primary 2-lot trades from independent 0.01-lot M1',()=>{
 const records=[
  {...trade,execution_path:'PRIMARY_PLAN_B',plan_b_route:'TREND_CONTINUATION',
   direction:'SELL',quotes:[quote('2026-11-11T08:01:59Z',1.1194,1.1195)],
   realised_pnl:100,commission:-24},
  {...trade,execution_path:'PRIMARY_PLAN_B',plan_b_route:'CONFIRMED_REVERSAL',
   quotes:[quote('2026-11-11T08:01:59Z',1.1194,1.1195)],
   realised_pnl:-120,commission:-24},
  {...trade,execution_path:'QUALIFIED_CONTINUATION',plan_b_route:'TREND_CONTINUATION',
   lot_size:0.01,realised_pnl:-0.90,commission:-0.06,
   quotes:[quote('2026-11-11T08:01:59Z',1.1194,1.1195)]},
 ];
 const r=summarize(records);
 const primary=r.byExecutionPathAndPlanBRoute['PRIMARY_PLAN_B/TREND_CONTINUATION'];
 const reversal=r.byExecutionPathAndPlanBRoute['PRIMARY_PLAN_B/CONFIRMED_REVERSAL'];
 const canary=r.byExecutionPathAndPlanBRoute['QUALIFIED_CONTINUATION/TREND_CONTINUATION'];
 assert.equal(primary.actuallyClosed,1);
 assert.equal(primary.actualNetUSD,76);
 assert.equal(reversal.actualNetUSD,-144);
 assert.equal(canary.actualNetUSD,-0.96);
 assert.equal(primary.horizons[1].observableSurvivors,1);
 assert.equal(canary.horizons[1].observableSurvivors,1);
 assert.equal(
  r.byExecutionPathAndPairSideRoute['PRIMARY_PLAN_B/EURUSD/SELL/TREND_CONTINUATION']
    .actuallyClosed,1);
});
test('grouping reports missing quote data separately from trades closed before horizon',()=>{
 const rows=[
  {executionPath:'PRIMARY_PLAN_B',planBRoute:'TREND_CONTINUATION',
   actualNetUSD:-10,horizons:{
    1:{state:'TRADE_CLOSED_BEFORE_HORIZON'},
    3:{state:'TRADE_CLOSED_BEFORE_HORIZON'},
    5:{state:'TRADE_CLOSED_BEFORE_HORIZON'},
    10:{state:'TRADE_CLOSED_BEFORE_HORIZON'}}},
  {executionPath:'PRIMARY_PLAN_B',planBRoute:'TREND_CONTINUATION',
   actualNetUSD:20,horizons:{
    1:{state:'NO_CAUSAL_BROKER_MARK'},3:{state:'NO_CAUSAL_BROKER_MARK'},
    5:{state:'NO_CAUSAL_BROKER_MARK'},10:{state:'NO_CAUSAL_BROKER_MARK'}}},
 ];
 const r=groupActualAndSurvivingMarks(rows,x=>[x.executionPath,x.planBRoute].join('/'));
 const a=r['PRIMARY_PLAN_B/TREND_CONTINUATION'];
 assert.equal(a.horizons[1].observableSurvivors,0);
 assert.equal(a.horizons[1].closedBeforeHorizon,1);
 assert.equal(a.horizons[1].quotesMissingWhileOpen,1);
 assert.equal(a.horizons[1].conditionalMeanNetUSD,null);
});
