'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {summarize,strictBarrierPath,SQL}=require('./audit-pepperstone-profit-lock-postexit.cjs');
const close=new Date('2026-11-17T01:46:56Z');
const base={
 trade_key:'t1',instrument:'AUDUSD',direction:'BUY',closed_at:close,
 exit_price:'0.67371',take_profit:'0.67429',
 realised_pnl:'37.84',commission:'-10.32',swap:'0',
 strategy_route:'CONFIRMED_REVERSAL',
};
const bar=(minute,bid,ask)=>({...base,bucket_time:new Date('2026-11-17T01:'+minute+':00Z'),bid_close:bid,ask_close:ask,sample_count:100});
test('uses only fully completed post-exit broker BID close and distinguishes matured 3 and 5m',()=>{
 const r=summarize([bar('47','0.67373','0.67374'),bar('48','0.67371','0.67372'),
   bar('49','0.67360','0.67361'),bar('50','0.67362','0.67363')],
   new Date('2026-11-17T01:54:00Z'));
 assert.equal(r.trades,1);
 assert.equal(r.details[0].realizedNet,27.52);
 assert.equal(r.details[0].horizons[0].status,'MATURE_SAMPLED');
 assert.equal(r.details[0].horizons[0].tpReachedAtSampledM1Close,false);
 assert.equal(r.details[0].horizons[0].observedBars,2);
 assert.equal(r.details[0].horizons[1].observedBars,4);
 assert.equal(r.details[0].horizons[1].worstAdditionalPips,-1.1);
 assert.equal(r.details[0].horizons[2].status,'NOT_YET_MATURE');
});
test('SELL uses ask quote and refuses earlier-than-exit candle',()=>{
 const row={...base,trade_key:'t2',instrument:'USDJPY',direction:'SELL',
  exit_price:'159.503',take_profit:'159.442'};
 const r=summarize([
  {...row,bucket_time:new Date('2026-11-17T01:46:00Z'),bid_close:'159.43',ask_close:'159.44',sample_count:90},
  {...row,bucket_time:new Date('2026-11-17T01:47:00Z'),bid_close:'159.46',ask_close:'159.47',sample_count:90}
 ],new Date('2026-11-17T01:54:00Z'));
 assert.equal(r.details[0].horizons[1].tpReachedAtSampledM1Close,false);
 assert.equal(r.details[0].horizons[1].observedBars,1);
 assert.equal(r.details[0].horizons[1].bestAdditionalPips,3.3);
});
test('never interprets missing or immature samples as TP',()=>{
 const r=summarize([{...base,bucket_time:null,bid_close:null,ask_close:null,sample_count:null}],
  new Date('2026-11-17T01:52:00Z'));
 assert.equal(r.details[0].horizons[0].status,'NO_VALID_BAR_CLOSE');
 assert.equal(r.details[0].horizons[2].status,'NOT_YET_MATURE');
 assert.equal(r.sampledTpCloseHits,0);
 assert.equal(r.modifiesExecution,false);
});
test('marks a sampled TP close but never claims broker fill',()=>{
 const r=summarize([bar('47','0.67430','0.67431')],new Date('2026-11-17T01:54:00Z'));
 assert.equal(r.sampledTpCloseHits,2);
 assert.equal(r.authority,'RESEARCH_ONLY');
});


const completeNative=(minute,overrides={})=>{
 const at=new Date('2026-11-17T01:'+minute+':00Z');
 return {
  ...base,entry_price:'0.67320',stop_loss:'0.67250',
  ...bar(minute,'0.67374','0.67376'),
  open:'0.67372',high:'0.67379',low:'0.67368',close:'0.67374',
  source:'ctrader-broker-native',positive_quote_sample_count:80,
  last_positive_sample_at:new Date(at.getTime()+50000),
  ...overrides,
 };
};
test('strict after-exit research requires contiguous completed authentic native quotes',()=>{
 const first=completeNative('47'),second=completeNative('48');
 const t=completeNative('47');
 const result=strictBarrierPath(t,[first,second],new Date('2026-11-17T01:49:56Z').getTime());
 assert.equal(result.status,'NO_SAMPLED_BARRIER_TOUCH');
 assert.equal(result.completedContiguousNativeBars,2);
 assert.equal(result.unobservedPartialExitMinute,true);
 assert.equal(result.noBrokerFillProof,true);
 assert.equal(result.additionalPipsAtLastBidAskClose,0.3);
 assert.equal(strictBarrierPath(t,[first],new Date('2026-11-17T01:49:56Z').getTime()).status,
  'MISSING_OR_INVALID_NATIVE_CANDLES');
 assert.equal(strictBarrierPath(t,[first,first,second],
  new Date('2026-11-17T01:49:56Z').getTime()).status,'DUPLICATE_CANDLE_BUCKET');
});
test('high-low overlap only means a possible barrier, never a confirmed broker fill',()=>{
 const t=completeNative('47');
 const after=[completeNative('47',{high:'0.67435'}),completeNative('48')];
 const r=strictBarrierPath(t,after,new Date('2026-11-17T01:49:56Z').getTime());
 assert.equal(r.status,'POSSIBLE_TP_TOUCH');
 assert.equal(r.possibleTpTouch,true);
 assert.equal(r.noBrokerFillProof,true);
 const both=strictBarrierPath(t,[
  completeNative('47',{high:'0.67435',low:'0.67245'}),
  completeNative('48')],new Date('2026-11-17T01:49:56Z').getTime());
 assert.equal(both.status,'POSSIBLE_BOTH_BARRIERS');
});
test('missing live samples, stale or backfilled timestamps never become clean outcomes',()=>{
 const t=completeNative('47');
 for(const invalid of [
  {source:'twelvedata'},{positive_quote_sample_count:0},
  {last_positive_sample_at:new Date('2026-11-17T01:48:05Z')},
  {high:'0.67370'},
  {bid_close:'0.67400',ask_close:'0.67390'},
 ]){
  const result=strictBarrierPath(t,[completeNative('47',invalid),completeNative('48')],
   new Date('2026-11-17T01:49:56Z').getTime());
  assert.equal(result.status,'MISSING_OR_INVALID_NATIVE_CANDLES');
 }
 assert.match(SQL,/q.source='ctrader-broker-native'/);
 assert.match(SQL,/b.account_type='DEMO'/);
});
test('SELL detects potential original SL on an upper M1 wick without assuming an order fill',()=>{
 const t={...completeNative('47'),instrument:'USDJPY',direction:'SELL',
  entry_price:'159.500',stop_loss:'159.560',take_profit:'159.420',exit_price:'159.470'};
 const rows=[
  {...completeNative('47'),high:'159.570',low:'159.440',open:'159.500',close:'159.470',
   bid_close:'159.47',ask_close:'159.475'},
  {...completeNative('48'),high:'159.510',low:'159.445',open:'159.480',close:'159.460',
   bid_close:'159.460',ask_close:'159.465'},
 ];
 const result=strictBarrierPath(t,rows,new Date('2026-11-17T01:49:56Z').getTime());
 assert.equal(result.status,'POSSIBLE_STOP_TOUCH');
 assert.equal(result.possibleStopTouch,true);
});
test('strict-path summary keeps incomplete and possible-barrier candidates separate from successes',()=>{
 const rows=[completeNative('47'),completeNative('48')];
 const data=summarize(rows,new Date('2026-11-17T01:55:00Z'));
 assert.equal(data.strictBarrierSummary['3m'].completeContiguousNativeQuotePaths,1);
 assert.equal(data.strictBarrierSummary['3m'].noBrokerFillsInferred,true);
 assert.equal(data.strictBarrierSummary['3m'].unobservedExitMinuteCases,1);
 assert.equal(data.strictBarrierSummaryByRoute.CONFIRMED_REVERSAL['3m'].cleanQuoteOnlyCases,1);
 assert.equal(data.strictBarrierSummaryByInstrument.AUDUSD['3m'].cleanQuoteOnlyCases,1);
});
