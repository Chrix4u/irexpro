'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {summarize}=require('./audit-pepperstone-profit-lock-postexit.cjs');
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
