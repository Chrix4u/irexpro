'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {analyzeM1Barriers}=require('./forward-direction-m1-barrier-review.cjs');
const at=n=>new Date(Date.parse('2026-11-16T18:00:00.000Z')+n*60000).toISOString();
function quote(min,bid,ask,low,high){
 return {source:'ctrader-broker-native',positive_quote_sample_count:4,
  bucket_time:at(min),last_quote_sample_at:new Date(Date.parse(at(min))+52000).toISOString(),
  bid_close:bid,ask_close:ask,low,high,last_positive_spread:ask-bid};
}
const e={instrument:'EURUSD',evaluated_at:at(0),direction:'BUY',
 stop_distance:'0.0005',target_distance:'0.0008'};
function market(bars){return new Map([['EURUSD',new Map(
 bars.map(([minute,bid,ask,low,high])=>[Date.parse(at(minute)),quote(minute,bid,ask,low,high)])
 )]]);}
const entry=[1,1.1,1.1001,1.1,1.1001];
test('a possible stop on a subsequent full bar is not counted as a guaranteed fill',()=>{
 const m=market([entry,[2,1.0995,1.0997,1.0993,1.1002],
  [3,1.101,1.1012,1.1008,1.1012]]);
 const result=analyzeM1Barriers(e,m,3,'BUY');
 assert.equal(result.status,'POSSIBLE_STOP_BEFORE_TARGET');
 assert.equal(result.exactFillVerified,false);
 assert.equal(result.entryMinuteUnchecked,true);
});
test('a possible target is independently identified for a buy',()=>{
 const m=market([entry,[2,1.101,1.1012,1.1008,1.1013]]);
 assert.equal(analyzeM1Barriers(e,m,3,'BUY').status,'POSSIBLE_TARGET_BEFORE_STOP');
});
test('opposite sell side uses bid entry and ask for exit barriers',()=>{
 const m=market([entry,[2,1.099,1.0991,1.0988,1.0993]]);
 assert.equal(analyzeM1Barriers(e,m,3,'SELL').status,'POSSIBLE_TARGET_BEFORE_STOP');
});
test('both sides of a bar touching hypothetical barriers is ambiguous',()=>{
 const m=market([entry,[2,1.1002,1.1003,1.0989,1.1022]]);
 assert.equal(analyzeM1Barriers(e,m,3,'BUY').status,'AMBIGUOUS_BOTH_POSSIBLE');
});
test('gapped M1 evidence is unknown rather than a winning hypothetical trade',()=>{
 const m=market([entry,[3,1.101,1.1012,1.1008,1.1013]]);
 assert.equal(analyzeM1Barriers(e,m,3,'BUY').status,'UNKNOWN_MISSING_PATH');
});
test('missing midpoint range, spread, or entry quote does not invent a path',()=>{
 const m=market([entry,[2,1.1001,1.1002,1.1001,1.1002]]);
 m.get('EURUSD').get(Date.parse(at(2))).high=null;
 assert.equal(analyzeM1Barriers(e,m,3,'BUY').status,'UNKNOWN_BAR_RANGE');
 assert.equal(analyzeM1Barriers(e,new Map(),3,'BUY').status,'UNKNOWN_ENTRY_QUOTE');
 assert.equal(analyzeM1Barriers({...e,stop_distance:null},m,3,'BUY').status,'UNKNOWN_RISK_OR_TIME');
});
test('no observed full-minute crossing is not proof the entry minute was safe',()=>{
 const m=market([entry,[2,1.1001,1.1002,1.1001,1.1002],
  [3,1.1002,1.1003,1.1001,1.1003]]);
 const r=analyzeM1Barriers(e,m,2,'BUY');
 assert.equal(r.status,'NO_POSSIBLE_TOUCH_IN_INSPECTED_BARS');
 assert.equal(r.entryMinuteUnchecked,true);
 assert.equal(r.exactFillVerified,false);
});

test('a possible hit inside the exit-minute candle cannot be ordered before its mark',()=>{
 const m=market([entry,[2,1.1001,1.1002,1.1001,1.1002],
  [3,1.0994,1.0996,1.0992,1.1002]]);
 const result=analyzeM1Barriers(e,m,2,'BUY');
 assert.equal(result.status,'UNKNOWN_EXIT_MINUTE_ORDER');
 assert.equal(result.exactFillVerified,false);
});
