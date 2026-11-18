'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),
 fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const m=require('./watch-owner-demo-loss-pattern-shadow.cjs');
const owner='e7f41d84-7924-4e45-85e9-78effa1932f6';
const key='a9a834bc-19ca-4da5-8973-c0f3c6f5a301';
const when=Date.parse('2026-11-19T09:00:00Z');
const baseline={researchOnly:true,modifiesExecution:false,
 records:[0,1,2,3,4,5,6,7,8,9,10].map(i=>({
  openedAt:new Date(Date.parse('2026-11-17T09:00:00Z')+i*60000).toISOString(),
  tradingDay:i<5?'2026-11-17':'2026-11-18',
  entryFeatures:{route:'CONFIRMED_REVERSAL',instrument:'USDJPY',
   direction:'BUY',alignedH1:-.4,alignedH4:-.8,alignedM15:-.2,
   alignedM5:-.7,alignedM1Momentum3Atr:.5,alignedM5Momentum3Atr:.6,
   alignedM5BodyPressure:-.2,metaProbability:.49},
  futureOutcomesDoNotUseAsInputs:{netPnlUsd:i%4===0?50:-80},
 }))};
const row=(delta={})=>({
 trade_key:key,intent_id:'617228fa-662e-4d70-a4c2-d120e9f2552e',
 decision_id:'35c8235c-0ebf-4f06-bbfc-62de55d0046b',
 opened_at:new Date(when).toISOString(),decision_at:new Date(when-12000).toISOString(),
 intent_at:new Date(when-6000).toISOString(),instrument:'USDJPY',direction:'BUY',
 status:'OPEN',lot_size:'2.0',closed_at:null,realised_pnl:null,commission:null,swap:null,
 close_reason:null,max_favorable_pnl:'0',max_adverse_pnl:'-4',path_observation_count:2,
 initial_risk:'100',fallback_risk:'200',
 metadata:{multimodel_plan_b_route:'CONFIRMED_REVERSAL',multimodel_governance_net_expected_r:'.24',
   multimodel_execution_authority_path:'DEMO_CONTINUOUS_REVERSAL_EARLY_EVIDENCE'},
 candidate:{alignedH1:-.4,alignedH4:-.8,alignedM15:-.2,alignedM5:-.7,
  alignedMomentum3Atr:.5,alignedM5Momentum3Atr:.6,alignedM5LatestBodyPressure:-.2},
 governance:{multimodelEnsemble:{metaProbability:.49,ensembleScore:.72,
  consensusPassed:7,consensusRequired:6},
  multimodelTrainedExpert:{state:'ABSTAIN',direction:'BUY'}},
 ...delta,
});
test('SQL strictly DEMO USD Pepperstone owner scoped and read-only',()=>{
 assert.match(m.SQL,/t\.user_id=\$1 AND b\.user_id=\$1/);
 assert.match(m.SQL,/b\.broker_id=\$2/);
 assert.match(m.SQL,/b\.account_type='DEMO'/);
 assert.match(m.SQL,/b\.account_currency='USD'/);
 assert.match(m.SQL,/d\.evaluated_at<=t\.opened_at/);
 assert.match(m.SQL,/t\.opened_at >= \$3::timestamptz/);
 assert.doesNotMatch(m.SQL,/\b(?:UPDATE|DELETE|INSERT)\b/i);
});
test('only OPEN, on-time and pre-existing decision data form a frozen entry',()=>{
 assert.equal(m.frozenEntry(row(),when+15000).route,'CONFIRMED_REVERSAL');
 assert.equal(m.frozenEntry(row(),when+90001),null);
 assert.equal(m.frozenEntry(row({status:'CLOSED'}),when+15000),null);
 assert.equal(m.frozenEntry(row({decision_at:new Date(when+1000).toISOString()}),when+15000),null);
 assert.equal(m.frozenEntry(row({intent_at:new Date(when+1000).toISOString()}),when+15000),null);
});
test('the preregistered warning comes from entry features, never future P&L',()=>{
 const e=m.evaluateEntry(m.frozenEntry(row(),when+12000),baseline);
 assert(e.preRegisteredWarnings.includes('CR_USDJPY_BUY'));
 assert(e.preRegisteredWarnings.includes('CR_M5_OPPOSES'));
 assert(e.preRegisteredWarnings.includes('HIGHER_H1_H4_BOTH_OPPOSE'));
 assert(e.preRegisteredWarnings.includes('PLANB_META_BELOW_50PCT'));
 assert.equal('realised_pnl' in e.features,false);
 assert.equal('closed_at' in e.features,false);
 assert.equal(e.noTradeVeto,true);
 assert.equal(e.noDirectionFlip,true);
});
test('similarity memory cannot claim qualification from two historical dates',()=>{
 const x=m.scoreEntry(m.frozenEntry(row(),when+12000),baseline);
 assert.equal(x.nearestHistoryCount,5);
 assert.equal(x.memoryState,'INSUFFICIENT_INDEPENDENT_HISTORICAL_EXAMPLES');
 assert.equal(x.canAuthorizeOppositeOrder,false);
});
test('late or already closed entry cannot be backfilled using hindsight',()=>{
 const q=m.plan(row({status:'CLOSED'}),new Map(),when+20000,baseline);
 assert.equal(q.length,1);assert.equal(q[0].stage,'ENTRY_MISSED');
 assert.equal(m.plan(row(),new Map(),when+90002,baseline)[0].stage,'ENTRY_MISSED');
});
test('entry journal contains NO future outcomes, and does not change broker',()=>{
 const q=m.plan(row(),new Map(),when+12000,baseline);
 assert.equal(q[0].stage,'ENTRY');
 assert.equal(q[0].noPostEntryDataAtEnrollment,true);
 assert.equal(q[0].noTradeAuthority,true);
 assert.equal('settledNetUsd' in q[0],false);
 assert.equal('maxFavorableBrokerNetUsd' in q[0],false);
});
test('favorable 0.25R and 0.50R peaks only recorded while position OPEN',()=>{
 const e=m.plan(row(),new Map(),when+12000,baseline)[0];
 const stages=m.setStages([e]);
 const q=m.plan(row({max_favorable_pnl:'60'}),stages,when+30000,baseline);
 assert.deepEqual(q.map(x=>x.stage),['PEAK_025R','PEAK_050R']);
 assert(q.every(x=>x.noTradeAuthority&&x.positionWasOpenAtObservation));
 const closed=m.plan(row({status:'CLOSED',max_favorable_pnl:'60'}),stages,when+30000,baseline);
 assert.equal(closed.some(x=>x.stage.startsWith('PEAK_')),false);
});
test('settlement computes broker net once and labels outcome only',()=>{
 const e=m.plan(row(),new Map(),when+12000,baseline)[0];
 const q=m.plan(row({status:'CLOSED',realised_pnl:'-90',commission:'-12',swap:'-1.4',
  closed_at:new Date(when+150000).toISOString(),max_favorable_pnl:'30'}),
   m.setStages([e]),when+160000,baseline);
 assert.equal(q.length,1);
 assert.equal(q[0].stage,'SETTLED');
 assert.equal(q[0].settledNetUsd,-103.4);
 assert.equal(q[0].eventualOutcomeOnly,true);
});
test('report counts false rejections of winners and never authorizes flips',()=>{
 const e=m.plan(row(),new Map(),when+12000,baseline)[0];
 const settle=(id,pnl)=>({artifact:m.JOURNAL_SOURCE,tradeKey:id,
  stage:'SETTLED',capturedAt:new Date(when+160000).toISOString(),
  settledNetUsd:pnl,maxFavorableBrokerNetUsd:12});
 const e2={...e,tradeKey:'c1a0e628-09cb-4d89-868c-cbb88d6cb7b4'};
 const rep=m.summarize([e,settle(key,-103.4),e2,settle(e2.tradeKey,51)],
  {activatedAt:new Date(when-1000).toISOString(),baselineSha256:'test'},
  baseline);
 assert.equal(rep.futureEntriesEnrolled,2);
 assert.equal(rep.byWarning.CR_USDJPY_BUY.flagged.wins,1);
 assert.equal(rep.byWarning.CR_USDJPY_BUY.flagged.losses,1);
 assert.equal(rep.byWarning.CR_USDJPY_BUY.flagged.netUsd,-52.4);
 assert.equal(rep.autoReverseEnabled,false);
 assert.equal(rep.modelWeightsUpdated,false);
});
test('the frozen activation is owner-bound and cannot be rewritten',()=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'irexpro-loss-memory-'));
 try{
  const src=path.join(tmp,'source.json');
  fs.writeFileSync(src,JSON.stringify(baseline));
  const a=m.loadActivation(tmp,owner,when-10,src);
  const b=m.loadActivation(tmp,owner,when+10000,src);
  assert.equal(a.marker.baselineSha256,b.marker.baselineSha256);
  assert.equal(a.marker.activatedAt,b.marker.activatedAt);
  assert.equal(fs.statSync(path.join(tmp,'frozen-baseline.json')).mode&0o777,0o600);
  assert.throws(()=>m.loadActivation(tmp,'d14e97ae-2a65-49ef-a373-60fb7f3b6060',when+10000,src),/MISMATCHED/);
 }finally{fs.rmSync(tmp,{recursive:true,force:true})}
});
test('DB snapshot enforced REPEATABLE READ READ ONLY',async()=>{
 const calls=[],db={query:async (sql,params)=>{
  calls.push({sql,params});
  return {rows:sql===m.SQL?[row()]:[]};
 }};
 const results=await m.readTrades(db,owner,new Date(when-1000).toISOString());
 assert.equal(results.length,1);
 assert.equal(calls[0].sql,'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 assert.equal(calls.at(-1).sql,'COMMIT');
});
