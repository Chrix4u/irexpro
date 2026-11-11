'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {validQuote,firstCausalQuote,causalFeePerLot,studyEpisode,aggregateEpisodes,asofTrainingRow}=
  require('./audit-short-horizon-m1-episodes.cjs');
const quote=(at,bid,ask,opts={})=>({
 last_quote_sample_at:at,bid_close:bid,ask_close:ask,
 positive_quote_sample_count:20,source:'ctrader-broker-native',...opts,
});
const d={instrument:'EURUSD',direction:'BUY',created_at:'2026-11-11T08:00:00Z'};
const qs=[quote('2026-11-11T07:59:59Z',1.110,1.1101),
 quote('2026-11-11T08:00:40Z',1.111,1.1111),
 quote('2026-11-11T08:01:40Z',1.1112,1.1113),
 quote('2026-11-11T08:03:40Z',1.1113,1.1114),
 quote('2026-11-11T08:05:40Z',1.1114,1.1115),
 quote('2026-11-11T08:10:40Z',1.1115,1.1116)];
const fees=Array.from({length:9},(_,i)=>({closedAt:Date.parse('2026-11-10T08:00:00Z')+i*60000,feePerLot:6}));
test('ignores pre-decision quote and reads only first quote AFTER persistence',()=>{
 assert.equal(firstCausalQuote(qs,Date.parse(d.created_at)).last_quote_sample_at,
   '2026-11-11T08:00:40Z');
});
test('validates actual two-sided broker spread',()=>{
 assert.equal(validQuote(quote('2026-11-11T08:00:40Z',1.11,1.109)),false);
 assert.equal(validQuote(quote('2026-11-11T08:00:40Z',1.11,1.111,{source:'synthetic'})),false);
});
test('as-of broker commission requires 8 prior closed fills: NEVER future closes',()=>{
 assert.equal(causalFeePerLot(fees.slice(0,7),Date.parse(d.created_at)),null);
 assert.equal(causalFeePerLot(fees,Date.parse(d.created_at)),6);
 assert.equal(causalFeePerLot(fees,Date.parse('2026-11-10T08:02:00Z')),null);
});
test('1/3/5/10 min economic labels are measured from observed broker entry, not backdated signal time',()=>{
 const r=studyEpisode(d,qs,fees);
 assert.equal(r.reason,'MARKED');
 assert.equal(r.entryAt,'2026-11-11T08:00:40.000Z');
 assert.ok(r.outcomes[1].netUsd1Lot>0); // +~1 pip net after $6 fee
 assert.equal(r.outcomes[3].positiveAfterCosts,true);
 assert.equal(r.outcomes[5].positiveAfterCosts,true);
 assert.equal(r.outcomes[10].positiveAfterCosts,true);
});
test('BUY receives ASK entry then BID exit: flat market is negative after spread + fee',()=>{
 const flat=[
   quote('2026-11-11T08:00:40Z',1.11,1.11005),
   quote('2026-11-11T08:01:40Z',1.11,1.11005),
 ];
 const result=studyEpisode(d,flat,fees);
 assert.equal(result.outcomes[1].positiveAfterCosts,false);
 assert.ok(result.outcomes[1].netUsd1Lot<-6);
});
test('no observed quote or missing causal fee means no claimed profitability',()=>{
 assert.equal(studyEpisode(d,[],fees),null);
 assert.equal(studyEpisode(d,qs,[]).reason,'CAUSAL_BROKER_FEES_NOT_ESTABLISHED');
});
test('PLAN B rejected signals can be observed without granting execution authority',()=>{
 const entry={planBAdmitted:false,route:'M1_TREND_CONTINUATION',
   executionAuthority:'NONE',
   study:{reason:'MARKED',outcomes:{1:{positiveAfterCosts:true,netUsd1Lot:1,signedPips:1}}}};
 const x=aggregateEpisodes([entry]);
 assert.equal(x.PLAN_B_NOT_ADMITTED.economic[1].positive,1);
 assert.equal(x.BROKER_AUTHORIZED.episodes,0);
});

test('training export contains only pre-decision allowlisted features, with labels separated',()=>{
 const input={...d,route:'M1_TREND_CONTINUATION',paper_admitted:'true',
   execution_authority:'NONE',user_id:'PRIVATE',broker_connection_id:'PRIVATE',
   candidate:{atr:0.003,confidence:0.8,latestFutureQuote:1.88,brokerKey:'PRIVATE'},
   plan_b:{metaProbability:.58,expectedR:.2,regime:'TREND_HEALTHY',
     portfolioUserEmail:'PRIVATE'}};
 const data=asofTrainingRow(input,{reason:'MARKED',outcomes:{1:{netUsd1Lot:-8}}});
 assert.equal(data.features.atr,0.003);
 assert.equal(data.features.planBMetaProbability,0.58);
 assert.equal(data.labels[1].netUsd1Lot,-8);
 assert.equal(data.features.latestFutureQuote,undefined);
 assert.equal(data.features.brokerKey,undefined);
 assert.ok(!JSON.stringify(data).includes('PRIVATE'));
 assert.equal(data.observedBrokerAuthority,false);
});
