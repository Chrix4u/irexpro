'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {stopPath,verifiedBucket}=require('./planb-hypothetical-stop-path.cjs');
const base=Date.parse('2026-11-11T14:01:00Z');
const candle=(i,opts={})=>({
 bucket_time:new Date(base+i*60000).toISOString(),
 high:'1.2002',low:'1.1999',close:'1.2000',
 bid_close:'1.19995',ask_close:'1.20005',
 sample_count:5,positive_quote_sample_count:5,
 last_quote_sample_at:new Date(base+i*60000+30000).toISOString(),
 source:'ctrader-broker-native',...opts});
const bars=()=>Array.from({length:60},(_,i)=>candle(i));
const study={reason:'MARKED',entryAt:'2026-11-11T14:00:20Z',
 entryPrice:1.2001,outcomes:{60:{netUsd1Lot:12}}};
const candidate={direction:'BUY',stopLoss:1.1998,takeProfit:1.2007};
test('unbroken 60-minute quotes with no barrier show neither witnessed',()=>{
 const p=stopPath(candidate,study,bars());
 assert.equal(p.state,'COMPLETE_60M_SAMPLED_QUOTES');
 assert.equal(p.observedFullMinutes,60);
 assert.equal(p.firstBarrier,'NEITHER_WITNESSED');
});
test('sampled adverse midpoint stop followed by positive 60-minute mark is counted',()=>{
 const q=bars();q[2]=candle(2,{low:'1.1997'});
 const r=stopPath(candidate,study,q);
 assert.equal(r.firstBarrier,'STOP_WITNESSED_FIRST');
 assert.equal(r.stopThenPositiveAtHorizon,true);
 assert.equal(r.firstStopMinute,'2026-11-11T14:03:00.000Z');
});
test('target observed before stop remains target first even if later low crosses stop',()=>{
 const q=bars();q[1]=candle(1,{high:'1.2010',close:'1.2009',
  bid_close:'1.2008',ask_close:'1.2010'});
 q[4]=candle(4,{low:'1.1997'});
 const r=stopPath(candidate,study,q);
 assert.equal(r.firstBarrier,'TARGET_CLOSE_WITNESSED_FIRST');
 assert.equal(r.stopThenPositiveAtHorizon,false);
});
test('same-minute stop and target cannot infer tick ordering',()=>{
 const q=bars();q[1]=candle(1,{low:'1.1997',high:'1.2010',
  close:'1.2009',bid_close:'1.2008',ask_close:'1.2010'});
 const r=stopPath(candidate,study,q);
 assert.equal(r.firstBarrier,'SAME_MINUTE_AMBIGUOUS');
 assert.equal(r.stopThenPositiveAtHorizon,false);
});
test('missing minute fails closed and cannot be labelled fully stop-free',()=>{
 const q=bars();q.splice(3,1);
 const r=stopPath(candidate,study,q);
 assert.equal(r.state,'DATA_GAP');
 assert.equal(r.observedFullMinutes,3);
});
test('source and sample geometry must be broker-native and temporally valid',()=>{
 assert.equal(verifiedBucket(candle(0,{source:'synthetic'}),base),false);
 assert.equal(verifiedBucket(candle(0,{sample_count:0}),base),false);
 assert.equal(verifiedBucket(candle(0,{last_quote_sample_at:'2026-11-11T14:02:01Z'}),base),false);
 assert.equal(stopPath({...candidate,stopLoss:1.201},study,bars()).state,
  'INVALID_ENTRY_STOP_TARGET_GEOMETRY');
});
test('1.5x stop distance changes only the simulated stop boundary, not the target or fill',()=>{
 const q=bars();q[2]=candle(2,{low:'1.1997'});
 const original=stopPath(candidate,study,q);
 const wider=stopPath(candidate,study,q,60,1.5);
 assert.equal(original.firstBarrier,'STOP_WITNESSED_FIRST');
 assert.equal(wider.state,'COMPLETE_60M_SAMPLED_QUOTES');
 assert.equal(wider.stopDistanceMultiplier,1.5);
 assert.equal(wider.firstBarrier,'NEITHER_WITNESSED');
 assert.equal(wider.stopThenPositiveAtHorizon,false);
 assert.equal(stopPath(candidate,study,q,60,4).state,'UNSUPPORTED_STOP_MULTIPLE');
});
