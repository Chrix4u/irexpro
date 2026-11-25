'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const{QUERY,BRAKES,hasSafeInputs,leaders,quoteEligible,feeP90AsOf,score,summarize,audit}=
 require('./audit-planb-downstream-brake-firsttouch.cjs');
const USER='bcde668a-4104-4fa5-b371-1639526c5df1';
const CONN='a52c489c-e242-4a5c-b87b-616dcc10ba65';
const START='2026-11-12T07:00:00Z',END='2026-11-12T23:30:00Z';
const decision=(extra={})=>({id:'a',evaluatedAt:'2026-11-12T09:00:00Z',
 instrument:'AUDUSD',direction:'SELL',strategyRoute:'TREND_CONTINUATION',
 route:'M1_TREND_CONTINUATION',authorityPath:'PRIMARY_PLAN_B',
 primaryExecutable:'true',executionAuthority:'NONE',
 blockers:['M1_PORTFOLIO_NET_LOSS_STREAK_BRAKE'],stopDistance:'0.00020',
 targetDistance:'0.00040',spreadCostR:'0.025',spreadValid:'true',
 eventRisk:'CLEAR',...extra});
function bar(minute,bid=0.65000,ask=0.65002,extra={}){
 const at=new Date(Date.parse('2026-11-12T09:00:00Z')+minute*60000);
 return {instrument:'AUDUSD',timestamp:at.toISOString(),source:'ctrader-broker-native',
 open:'0.65001',high:'0.65005',low:'0.64990',close:'0.65001',
 positive_quote_sample_count:50,
 last_quote_sample_at:new Date(at.getTime()+30000).toISOString(),
 bid_close:String(bid),ask_close:String(ask),...extra};
}
const candles=Array.from({length:15},(_,i)=>bar(i+1));
const fees=Array.from({length:7},(_,i)=>({
 instrument:'AUDUSD',closedAt:new Date(Date.parse('2026-11-11T08:00:00Z')+i*60000).toISOString(),
 commission:'-12',swap:'0',lots:'2',
}));
test('selects real original Plan B authority only, not other M1 or actual fills',()=>{
 assert.equal(hasSafeInputs(decision()),true);
 assert.equal(hasSafeInputs(decision({authorityPath:'BLOCKED'})),false);
 assert.equal(hasSafeInputs(decision({executionAuthority:'BROKER_NATIVE'})),false);
 assert.equal(hasSafeInputs(decision({primaryExecutable:'false'})),false);
 assert.equal(hasSafeInputs(decision({instrument:'GBPUSD'})),false);
 assert.equal(hasSafeInputs(decision({blockers:null})),false);
});
test('repeated 1-minute signals are NOT counted as many independent trades',()=>{
 const rows=[decision(),decision({id:'b',evaluatedAt:'2026-11-12T09:01:00Z'}),
 decision({id:'c',evaluatedAt:'2026-11-12T09:29:00Z'}),
 decision({id:'d',evaluatedAt:'2026-11-12T09:30:00Z'}),
 decision({id:'e',direction:'BUY',evaluatedAt:'2026-11-12T09:02:00Z'}),
 decision({id:'f',strategyRoute:'CONFIRMED_REVERSAL',evaluatedAt:'2026-11-12T09:02:00Z'}),
 decision({id:'g',blockers:['NON_BRAKE'],evaluatedAt:'2026-11-12T09:32:00Z'})];
 const result=leaders(rows);
 assert.equal(result.length,4);
 assert.deepEqual(result.map(x=>x.id),['a','e','f','d']);
});
test('quote validation requires exact minute sample, positive broker spread and plausible candle',()=>{
 assert.equal(quoteEligible(bar(1)),true);
 assert.equal(quoteEligible(bar(1,0.65,0.649)),false);
 assert.equal(quoteEligible(bar(1,0.65,0.65002,{source:'synthetic'})),false);
 assert.equal(quoteEligible(bar(1,0.65,0.65002,{last_quote_sample_at:'2026-11-12T08:59:30Z'})),false);
 assert.equal(quoteEligible(bar(1,0.65,0.65002,{positive_quote_sample_count:0})),false);
});
test('cost as-of ignores fees closing later than hypothetical decision',()=>{
 assert.equal(feeP90AsOf(fees,'AUDUSD',Date.parse('2026-11-12T09:00:00Z')),6);
 assert.equal(feeP90AsOf(fees,'EURUSD',Date.parse('2026-11-12T09:00:00Z')),null);
 assert.equal(feeP90AsOf(fees,'AUDUSD',Date.parse('2026-11-11T07:00:00Z')),null);
});
test('a historical sell stop hit before target is net-negative after original spread and broker fees',()=>{
 const rows=candles.map((r,i)=>i===0?{...r,high:'0.65040',low:'0.64999',close:'0.65001'}:r);
 const x=score(decision(),rows,fees,Date.parse(END));
 assert.equal(x.state,'OBSERVED_M1_MIDPOINT_PROXY');
 assert.equal(x.outcome,'SL');
 assert(x.netR < -1);
 assert(x.commissionR>0);
});
test('no 15 verified consecutive future bars means UNOBSERVABLE, never profitable',()=>{
 assert.equal(score(decision(),candles.slice(0,14),fees,Date.parse(END)).state,
 'MISSING_15_CONSECUTIVE_VERIFIED_BROKER_CANDLES');
 assert.equal(score(decision(),candles,fees.slice(0,2),Date.parse(END)).state,
 'INSUFFICIENT_PRIOR_SAME_PAIR_BROKER_FEES');
 assert.equal(score(decision({spreadValid:'false'}),candles,fees,Date.parse(END)).state,
 'UNSAFE_OR_MISSING_ORIGINAL_EXECUTION_GEOMETRY');
});
test('overlap is counted; a profitable hypothetical NEVER approves relaxing actual brake',()=>{
 const cases=[
  {...decision(),brakes:[BRAKES[0]],otherBlockers:['M1_ACTIVE_OPPOSITE_POSITION'],
   observation:{state:'OBSERVED_M1_MIDPOINT_PROXY',outcome:'TP',netR:2}},
  {...decision({id:'z'}),brakes:[BRAKES[1]],otherBlockers:[],
   observation:{state:'MISSING_15_CONSECUTIVE_VERIFIED_BROKER_CANDLES'}},
 ];
 const s=summarize(cases);
 assert.equal(s.episodes,2);assert.equal(s.observable,1);
 assert.equal(s.overlappingIndependentBlockers,1);
 assert.equal(s.missingData,1);assert.equal(s.sumNetR,2);
 assert.equal(s.evidenceQualified,false);
 assert.equal(s.suggestBrakeRelaxation,false);
});
test('broker read-only transaction owner binds quotes, decisions, fees; no order or risk mutation',async()=>{
 const calls=[];
 const db={query:async(sql,args)=>{
  calls.push([sql,args]);
  if(sql===QUERY.scope)return {rows:[{id:CONN,broker:'pepperstone-ctrader',currency:'USD'}]};
  if(sql===QUERY.decisions)return {rows:[decision()]};
  if(sql===QUERY.quotes)return {rows:candles};
  if(sql===QUERY.fees)return {rows:fees};
  return {rows:[]};
 }};
 const r=await audit(db,USER,START,END);
 assert.equal(r.mode,'READ_ONLY');
 assert.equal(r.eligibleToRelaxBrake,false);
 assert.equal(r.changesBrokerOrders,false);
 assert.equal(r.overall.episodes,1);
 assert.equal(calls[0][0],'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 assert.equal(calls.at(-1)[0],'COMMIT');
 assert.deepEqual(calls.find(x=>x[0]===QUERY.decisions)[1].slice(0,2),[USER,CONN]);
 assert.equal(calls.find(x=>x[0]===QUERY.quotes)[1][0],CONN);
 assert.deepEqual(calls.find(x=>x[0]===QUERY.fees)[1].slice(0,2),[USER,CONN]);
});
