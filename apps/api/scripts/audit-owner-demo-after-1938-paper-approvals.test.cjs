'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {validOutcomeCandle,distinctEpisodes,summarize,audit}=
 require('./audit-owner-demo-after-1938-paper-approvals.cjs');
const a='2026-11-19T23:20:00.000Z';
const candle={
 source:'ctrader-broker-native',timeframe:'M1',
 timestamp:'2026-11-19T23:04:00.000Z',
 last_positive_sample_at:'2026-11-19T23:04:58.000Z',
 sample_count:50,positive_quote_sample_count:5,
 open:1.23,high:1.231,low:1.229,close:1.23,
 bid_close:1.2299,ask_close:1.2301,
};
test('only properly completed native bid/ask candles are outcome evidence',()=>{
 assert.equal(validOutcomeCandle(candle,a),true);
 for(const bad of [
  {last_positive_sample_at:'2026-11-19T23:06:20.000Z'},
  {timestamp:'2026-11-19T23:20:00.000Z'},
  {source:'TWELVE_DATA'},
  {bid_close:1.2302,ask_close:1.2301},
  {sample_count:1},
  {positive_quote_sample_count:1},
  {high:1.20},
 ])assert.equal(validOutcomeCandle({...candle,...bad},a),false);
});
test('independent 16-minute episodes cannot merge different broker accounts, instruments or directions',()=>{
 const t=(minute,connection='a',instrument='USDJPY',direction='BUY')=>({
   evaluated_at:new Date(Date.parse('2026-11-19T19:00:00Z')+minute*60000).toISOString(),
   broker_connection_id:connection,instrument,direction});
 const selected=distinctEpisodes([
  t(0),t(4),t(16),t(12,'b'),t(12,'a','EURUSD'),t(12,'a','USDJPY','SELL'),
 ]);
 assert.equal(selected.length,5);
 assert.equal(selected.filter(x=>x.direction==='BUY'&&x.instrument==='USDJPY'&&x.broker_connection_id==='a').length,2);
});
test('quote losses include after-cost outcome without inventing broker fills',()=>{
 const r=summarize([
  {outcome:'MTM',estimatedNetR:-1.2},
  {outcome:'TP',estimatedNetR:1.4},
  {outcome:'SL',estimatedNetR:-1.1},
  {outcome:'AMBIGUOUS'},
  {outcome:'NO_COMPLETE_NATIVE_BARS'},
  {outcome:'UNVERIFIED_COST_PROVENANCE'},
 ]);
 assert.equal(r.candidates,6);
 assert.equal(r.completeQuoteOutcomes,3);
 assert.equal(r.positiveNetQuoteLabels,1);
 assert.equal(r.negativeNetQuoteLabels,2);
 assert.equal(r.actualBrokerFills,0);
 assert.equal(r.grantsExecutionAuthority,false);
 assert.equal(r.quotesUnavailable,1);
 assert.equal(r.unknownCost,1);
 assert.equal(r.ambiguousBars,1);
});
test('refuses absent owner scope without contacting a database',async()=>{
 await assert.rejects(audit({query(){throw Error('SHOULD_NOT_EXECUTE')}},'none',new Date()),/OWNER_SCOPE_REQUIRED/);
});
