'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {ARTIFACT,PAIRS,usdPolarity,median,toBars,usdMomentum,factorAt,
 outcome,auditBars,queryAudit,q,usdDirectionalBet,historicalUsdConcentration}=
 require('./audit-owner-demo-usd-crosspair-factor.cjs');
const MIN=60000,T0=Date.parse('2026-11-18T00:00:00.000Z');
const OWNER='fbf0cacb-c1be-4cd9-818d-7648b503ebef';
function rows({
 length=40,
 invertedTarget=false,
 missingPair=null,
 malformedQuote=false,
 offsetMinutes=0,
}={}){
 const out=[];
 for(let i=0;i<length;i++){
  const t=T0+(i+offsetMinutes)*MIN;
  for(const pair of PAIRS){
   if(pair===missingPair)continue;
   const polarity=usdPolarity(pair);
   // USD-relative factor positive in all pairs. EURUSD quote falls.
   const reverse=pair==='EURUSD'&&invertedTarget?-1:1;
   const mid=(pair==='USDJPY'?150:1.2)*
     Math.exp(i*.0002*polarity*reverse);
   out.push({
    instrument:pair,
    bucket_time:new Date(t).toISOString(),
    bid_close:mid-.00001,
    ask_close:mid+.00001,
    last_quote_sample_at:new Date(t+40000).toISOString(),
    last_positive_bid:mid-.00001,
    last_positive_ask:mid+.00001,
    last_positive_sample_at:new Date(t+39000).toISOString(),
    positive_quote_sample_count:malformedQuote&&pair==='GBPUSD'?0:12,
   });
  }
 }
 return out;
}
function parsed(x){
 const sample=rows(x),asOf=new Date(T0+45*MIN).toISOString();
 return toBars(sample,asOf);
}
test('USD pair polarity obeys base/quote convention including GBPUSD and USDCHF',()=>{
 assert.equal(usdPolarity('USDJPY'),1);
 assert.equal(usdPolarity('USDCHF'),1);
 assert.equal(usdPolarity('USDCAD'),1);
 assert.equal(usdPolarity('EURUSD'),-1);
 assert.equal(usdPolarity('AUDUSD'),-1);
 assert.equal(usdPolarity('GBPUSD'),-1);
 assert.equal(usdPolarity('EURJPY'),null);
 assert.equal(usdPolarity('RANDOM'),null);
});
test('median clips only factor inputs, not original returns',()=>{
 assert.equal(median([1,2,100]),2);
 assert.equal(median([1,4]),2.5);
 assert.equal(median([]),null);
});
test('USD weakness reverses the signs of USD-base and USD-quote signals',()=>{
 const records=rows({length:20}).map(x=>({
  ...x,bid_close:1/Number(x.ask_close),ask_close:1/Number(x.bid_close),
 }));
 const m=toBars(records,new Date(T0+25*MIN));
 const f1=factorAt(m.bars,'EURUSD',T0+10*MIN);
 const f2=factorAt(m.bars,'USDJPY',T0+10*MIN);
 assert.equal(f1.state,'USD_WEAK');
 assert.equal(f1.consensusPairDirection,'BUY');
 assert.equal(f2.state,'USD_WEAK');
 assert.equal(f2.consensusPairDirection,'SELL');
});
test('positive USD factor predicts USD-base BUY but USD-quote SELL',()=>{
 const {bars}=parsed();
 const f1=factorAt(bars,'EURUSD',T0+10*MIN);
 const f2=factorAt(bars,'USDJPY',T0+10*MIN);
 assert.equal(f1.state,'USD_STRONG');
 assert.equal(f1.consensusPairDirection,'SELL');
 assert.equal(f2.state,'USD_STRONG');
 assert.equal(f2.consensusPairDirection,'BUY');
 assert.equal(f1.targetExcluded,true);
 assert.ok(f1.peer.every(x=>x.pair!=='EURUSD'));
 assert.equal(f2.peer.length,5);
 assert.ok(f2.agreement>=.67);
});
test('real positive broker quote in last 20s rescues invalid zero-spread close, never fabricates one',()=>{
 const records=rows({length:16});
 for(const r of records){
  if(r.instrument==='EURUSD'){
   r.bid_close=r.ask_close;
   r.last_quote_sample_at=new Date(Date.parse(r.bucket_time)+59000).toISOString();
   r.last_positive_sample_at=new Date(Date.parse(r.bucket_time)+53000).toISOString();
  }
 }
 const parsed=toBars(records,new Date(T0+20*MIN));
 assert.equal(parsed.recoveredPositiveQuote,16);
 assert.equal(parsed.bars.get('EURUSD').size,16);
 assert.equal(parsed.bars.get('EURUSD').get(T0+10*MIN).source,
  'LAST_POSITIVE_QUOTE_FINAL_20S');
 const stale=rows({length:16});
 for(const r of stale){
  if(r.instrument==='EURUSD'){
   r.bid_close=r.ask_close;
   r.last_positive_sample_at=new Date(Date.parse(r.bucket_time)+30000).toISOString();
  }
 }
 assert.equal(toBars(stale,new Date(T0+20*MIN)).bars.get('EURUSD').size,0);
});
test('target itself cannot self-confirm even if its direction disagrees with every peer',()=>{
 const {bars}=parsed({invertedTarget:true});
 const f=factorAt(bars,'EURUSD',T0+15*MIN);
 assert.equal(f.state,'USD_STRONG');
 assert.equal(f.consensusPairDirection,'SELL');
 assert.ok(f.peer.every(x=>x.pair!=='EURUSD'));
 assert.ok(usdMomentum(bars,'EURUSD',T0+15*MIN)<0);
});
test('stale quotes and missing entire peer group cannot count as strong USD evidence',()=>{
 const records=rows({length:16});
 for(const r of records){
  if(r.instrument==='GBPUSD')
   r.last_quote_sample_at=new Date(Date.parse(r.bucket_time)+65000).toISOString();
 }
 const parsed=toBars(records,new Date(T0+20*MIN));
 assert.equal(parsed.invalidTime,16);
 const factor=factorAt(parsed.bars,'EURUSD',T0+10*MIN);
 assert.equal(factor.peerCount,4);
 assert.equal(factor.state,'USD_STRONG');
 // Only one USD quote-side peer is left, then remove it too.
 parsed.bars.get('AUDUSD').clear();
 const missing=factorAt(parsed.bars,'EURUSD',T0+10*MIN);
 assert.equal(missing.state,'INSUFFICIENT_INDEPENDENT_PEERS');
});
test('in-progress current candle cannot influence the calculation',()=>{
 const asOf=new Date(T0+11*MIN+10000);
 const records=rows({length:12});
 const m=toBars(records,asOf);
 assert.equal(m.bars.get('USDJPY').has(T0+11*MIN),false);
 assert.equal(factorAt(m.bars,'USDJPY',T0+11*MIN).state,
  'INSUFFICIENT_INDEPENDENT_PEERS');
 assert.equal(factorAt(m.bars,'USDJPY',T0+10*MIN).state,'USD_STRONG');
});
test('future outcome labels never participate in the factor itself',()=>{
 const {bars}=parsed();
 const t=T0+10*MIN,f=factorAt(bars,'EURUSD',t);
 const o=outcome(bars,'EURUSD',t,5,f);
 assert.equal(o.directionalCorrect,true);
 assert.equal(o.includesFullBrokerCosts,false);
 assert.equal(o.brokerFill,false);
 const frozen=JSON.stringify(f);
 // Change future target prices AFTER signal time — current factor unchanged.
 bars.get('EURUSD').get(t+5*MIN).mid*=2;
 const changed=outcome(bars,'EURUSD',t,5,f);
 assert.equal(JSON.stringify(factorAt(bars,'EURUSD',t)),frozen);
 assert.notEqual(changed.directionalChangeBps,o.directionalChangeBps);
});
test('concurrent 6-pair signals are correlated; sample size is by UTC days',()=>{
 const {bars}=parsed();
 const r=auditBars(bars);
 assert.equal(r.artifact,ARTIFACT);
 assert.equal(r.brokerOrders,0);
 assert.equal(r.modifiesExecution,false);
 assert.ok(r.horizons['5m'].summary.events>0);
 assert.ok(r.horizons['5m'].summary.directionalHitRate>.5);
 assert.equal(r.horizons['5m'].summary.independentUtcDays,1);
 assert.equal(r.horizons['5m'].summary.meanAfterSpreadOnlyBps!=null,true);
 assert.ok(r.horizons['5m'].byTarget.USDCHF.events>0);
});
test('three different pairs can all express the same weak USD exposure',()=>{
 assert.equal(usdDirectionalBet('AUDUSD','BUY'),'USD_WEAK');
 assert.equal(usdDirectionalBet('USDCAD','SELL'),'USD_WEAK');
 assert.equal(usdDirectionalBet('USDJPY','SELL'),'USD_WEAK');
 assert.equal(usdDirectionalBet('EURUSD','SELL'),'USD_STRONG');
 const t=[
  {instrument:'USDCAD',direction:'SELL',
   opened_at:'2026-11-19T01:08:16.557Z',
   closed_at:'2026-11-19T01:13:28.332Z'},
  {instrument:'AUDUSD',direction:'BUY',
   opened_at:'2026-11-19T01:08:52.840Z',
   closed_at:'2026-11-19T01:14:00.813Z'},
  {instrument:'USDJPY',direction:'SELL',
   opened_at:'2026-11-19T01:09:17.445Z',
   closed_at:'2026-11-19T01:13:10.765Z'},
 ];
 const report=historicalUsdConcentration(t);
 assert.equal(report.maxConcurrentSameUsdDirectionPositions,3);
 assert.equal(report.sameUsdDirectionOverlapEvents,2);
 assert.equal(report.latestOverlapMoments.at(-1).exposureSide,'USD_WEAK');
 assert.equal(report.latestOverlapMoments.at(-1).concurrentPositions,3);
 assert.equal(report.changesExecution,false);
});
test('do not mistake opposite-direction USD exposure for common concentration',()=>{
 const t=[
  {instrument:'USDCAD',direction:'BUY',
   opened_at:'2026-11-19T01:08:00Z',
   closed_at:'2026-11-19T01:14:00Z'},
  {instrument:'AUDUSD',direction:'BUY',
   opened_at:'2026-11-19T01:09:00Z',
   closed_at:'2026-11-19T01:14:00Z'},
 ];
 assert.equal(historicalUsdConcentration(t).maxConcurrentSameUsdDirectionPositions,1);
});
test('owner scope and bounded broker candles read in a READ ONLY transaction',async()=>{
 const input=rows({length:40});
 const seen=[];
 const db={query:async(sql,args)=>{
  seen.push([sql,args]);
  if(sql===q.scope)return {rows:[{connection_id:OWNER,
   snapshot_at:new Date(T0+45*MIN).toISOString()}]};
  if(sql===q.candles)return {rows:input};
  return {rows:[]};
 }};
 const r=await queryAudit(db,OWNER,new Date(T0).toISOString());
 assert.equal(r.brokerOrders,0);
 assert.equal(r.rowsRead,240);
 assert.ok(r.horizons['5m'].summary.events>0);
 assert.ok(seen[0][0].includes('READ ONLY'));
 assert.ok(q.scope.includes("s.status='ACTIVE'"));
 assert.ok(q.scope.includes("b.broker_id='pepperstone-ctrader'"));
 assert.ok(q.candles.includes("source='ctrader-broker-native'"));
 assert.ok(q.candles.includes("interval '1 minute'"));
 await assert.rejects(queryAudit(db,'UNKNOWN',new Date(T0).toISOString()),
  /INVALID_OWNER/);
});
test('audit rejects truncated quote history rather than silently reporting certainty',async()=>{
 const db={query:async(sql)=>{
  if(sql===q.scope)return {rows:[{connection_id:OWNER,
    snapshot_at:new Date(T0+45*MIN).toISOString()}]};
  if(sql===q.candles)return {rows:Array(24001).fill(rows({length:1})[0])};
  return {rows:[]};
 }};
 await assert.rejects(queryAudit(db,OWNER,new Date(T0).toISOString()),
  /TRUNCATED/);
});
