'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {validQuote,selectLeaders,mark,summarize}=require('./audit-pepperstone-alternative-route-opportunities.cjs');
const q=(at,bid,ask)=>({
 bucket_time:at,last_quote_sample_at:new Date(Date.parse(at)+55000).toISOString(),
 source:'ctrader-broker-native',positive_quote_sample_count:2,
 bid_close:bid,ask_close:ask,
});
const d=(time,route='CONFIRMED_REVERSAL',instrument='EURUSD',direction='BUY',other={})=>({
 instrument,direction,evaluated_at:time,planb_route:route,
 planb_admitted:'true',governance_eligible:'true',m1_route:'ABSTAIN',
 blockers:['MULTIMODEL_REVERSAL_NOT_M1_CONFIRMED'],
 stop_distance:'0.0005',target_distance:'0.0008',...other
});
const book=new Map([['EURUSD',new Map([
 [Date.parse('2026-11-16T10:01:00Z'),q('2026-11-16T10:01:00Z',1.1,1.1001)],
 [Date.parse('2026-11-16T10:06:00Z'),q('2026-11-16T10:06:00Z',1.1003,1.1004)],
])]]);
test('native quote must be sampled inside its own M1 bar',()=>{
 assert.equal(validQuote(undefined),false);
 assert.equal(validQuote(q('2026-11-16T10:01:00Z',1,1.0001)),true);
 assert.equal(validQuote({...q('2026-11-16T10:01:00Z',1,1.0001),
   source:'other-provider'}),false);
 assert.equal(validQuote({...q('2026-11-16T10:01:00Z',1,1.0001),
   last_quote_sample_at:'2026-11-16T10:02:00Z'}),false);
});
test('chronological distinct episodes cannot choose later winning scans by hindsight',()=>{
 const rows=[
  d('2026-11-16T10:20:00Z'),
  d('2026-11-16T10:00:00Z'),
  d('2026-11-16T10:05:00Z'),
  d('2026-11-16T10:03:00Z','EARLY_TRANSITION'),
  d('2026-11-16T10:23:00Z','EARLY_TRANSITION'),
 ];
 const separate=selectLeaders(rows,'ROUTE');
 assert.deepEqual(separate.map(x=>[x.planb_route,x.evaluated_at]),[
  ['CONFIRMED_REVERSAL','2026-11-16T10:00:00Z'],
  ['EARLY_TRANSITION','2026-11-16T10:03:00Z'],
  ['CONFIRMED_REVERSAL','2026-11-16T10:20:00Z'],
  ['EARLY_TRANSITION','2026-11-16T10:23:00Z'],
 ]);
 const exclusive=selectLeaders(rows,'EXCLUSIVE_PAIR');
 assert.deepEqual(exclusive.map(x=>x.evaluated_at),[
  '2026-11-16T10:00:00Z','2026-11-16T10:20:00Z'
 ]);
});
test('BUY after spread and commission normalizes net P&L to pip R',()=>{
 const v=mark(d('2026-11-16T10:00:00Z'),book,5);
 assert.equal(v.state,'FIXED_HOLD_BROKER_QUOTE_PROXY');
 assert.equal(v.grossPips,2);
 assert.equal(v.netPips,1.2); // 2p gross - 0.6p commission - 0.2p slippage
 assert.equal(v.netUSDPerStandardLot,12);
 assert.equal(v.stopFirst,'NOT_VERIFIED');
});
test('SELL on identical marks would not be labelled a winner',()=>{
 const v=mark(d('2026-11-16T10:00:00Z','EARLY_TRANSITION','EURUSD','SELL'),book,5);
 assert.equal(v.state,'FIXED_HOLD_BROKER_QUOTE_PROXY');
 assert.equal(v.grossPips,-4);
 assert.equal(v.netPips,-4.8);
});
test('unverified next-minute broker marks are explicitly unobservable',()=>{
 const missing=mark(d('2026-11-16T10:00:00Z'),new Map(),5);
 assert.equal(missing.state,'UNOBSERVABLE_QUOTE_GAP');
 assert.equal(missing.netPips,undefined);
});
test('summary tracks observed versus missing and is not executable',()=>{
 const chosen=[d('2026-11-16T10:00:00Z'),
 d('2026-11-16T11:00:00Z')];
 const r=summarize(chosen,book);
 assert.equal(r.selected,2);
 assert.deepEqual(r.byRoute.CONFIRMED_REVERSAL.horizons['5'],
  {selected:2,observed:1,positive:1,negative:0,missing:1,netPips:1.2,avgNetPips:1.2});
});
