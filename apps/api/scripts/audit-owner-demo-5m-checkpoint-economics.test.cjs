'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {SQL,bucket,windowStart,classify,summarize}=require('./audit-owner-demo-5m-checkpoint-economics.cjs');
const t0=Date.parse('2026-11-19T12:00:00Z');
const iso=n=>new Date(n).toISOString();
const row=(x={})=>({
 trade_key:'trade-test',instrument:'USDCAD',direction:'SELL',
 opened_at:iso(t0),checkpoint_at:iso(t0+300000),
 evaluated_at:iso(t0+315000),created_at:iso(t0+316000),
 closed_at:iso(t0+600000),status:'CLOSED',close_reason:'BROKER_CLOSE',
 fill_price:'1.4335',exit_price:'1.4340',stop_loss:'1.4340',take_profit:'1.4327',
 realised_pnl:'-70',commission:'-10',swap:'0',lot_size:'2',
 route:'CONFIRMED_REVERSAL',action:'OBSERVE',state:'NO_ACTION',
 reason:'DRAWDOWN_NOT_SEVERE',current_r:'-0.25',probability:'0.55',
 response:{source_state:'READY'},verified_guard_close:false,...x
});
test('SQL restricts exact owner broker DEMO USD and reads audited guard-request source',()=>{
 for(const s of [
  'o.user_id=$1','t.user_id=$1',"b.broker_id='pepperstone-ctrader'",
  "b.account_type='DEMO'","b.account_currency='USD'",
  "t.account_currency='USD'","o.checkpoint_minutes=5",
  "a.actor_user_id=t.user_id","a.resource_id=t.id::text",
  "a.metadata->'aiCloseTrigger'->>'source'='DEMO_DRAWDOWN_GUARD'"
 ])assert.ok(SQL.includes(s),s);
 assert.equal(windowStart(Date.parse('2026-11-20T02:10:00Z')),'2026-11-17T00:00:00.000Z');
 assert.equal(windowStart(Date.parse('2026-11-26T02:10:00Z')),'2026-11-20T00:00:00.000Z');
});
test('five-minute R bands respect exact mutually exclusive cutoffs',()=>{
 const pairs=[[-.4,'BELOW_-0.30R'],[-.3,'-0.30_TO_0R'],[-0.01,'-0.30_TO_0R'],
  [0,'0_TO_+0.15R'],[.149999,'0_TO_+0.15R'],
  [.15,'+0.15_TO_+0.40R'],[.4,'ABOVE_+0.40R']];
 for(const [v,expectation] of pairs)assert.equal(bucket(v),expectation);
});
test('settled continuing trades use authenticated pre-close score and actual net after costs',()=>{
 const d=classify(row());
 assert.equal(d.cohort,'GUARD_CONTINUED');
 assert.equal(d.checkpointBucket,'-0.30_TO_0R');
 assert.equal(d.scoreVerified,true);
 assert.equal(d.netUsd,-80);
 assert.equal(d.brokerClosePriceProximity,'EXIT_WITHIN_2P_OF_RECORDED_SL');
});
test('after-close or late-persisted five-minute score never enters verified cohort',()=>{
 for(const patch of [
  {evaluated_at:iso(t0+610000)},
  {created_at:iso(t0+610000)},
  {checkpoint_at:iso(t0+360000)},
  {response:{source_state:'WAITING_FOR_BROKER_DATA'}},
  {probability:'not a number'}
 ]){const d=classify(row(patch));assert.equal(d.scoreVerified,false);}
});
test('confirmed guard close requires matching broker-settled record and independent audit',()=>{
 const basic=row({action:'CLOSE_DEMO',state:'CLOSE_PENDING_RECONCILIATION',
  close_reason:'AI_CLOSE_SIGNAL',current_r:'-0.54'});
 const no=classify(basic);
 assert.equal(no.cohort,'UNVERIFIED_GUARD_CLOSE_ACTION');
 assert.equal(no.scoreVerified,false);
 const yes=classify({...basic,verified_guard_close:true});
 assert.equal(yes.cohort,'CONFIRMED_GUARD_EXIT');
 assert.equal(yes.scoreVerified,false);
 assert.equal(yes.checkpointR,null);
 assert.equal(classify({...basic,verified_guard_close:true,close_reason:'BROKER_CLOSE'}).cohort,
  'UNVERIFIED_GUARD_CLOSE_ACTION');
});
test('last price near recorded SL is not claimed to prove an actual broker stop trigger',()=>{
 const data=[
  classify(row()),
  classify(row({direction:'BUY',instrument:'EURUSD',stop_loss:'1.2000',
   exit_price:'1.20035',take_profit:'1.2030'})),
  classify(row({direction:'BUY',instrument:'USDJPY',stop_loss:'155.100',
   exit_price:'155.11',take_profit:'155.20'}))
 ];
 assert.equal(data[0].brokerClosePriceProximity,'EXIT_WITHIN_2P_OF_RECORDED_SL');
 assert.equal(data[1].brokerClosePriceProximity,'EXIT_NOT_NEAR_RECORDED_BARRIERS');
 assert.equal(data[2].brokerClosePriceProximity,'EXIT_WITHIN_2P_OF_RECORDED_SL');
});
test('group economics preserve winners, losses, spread/cost and profitability imbalance',()=>{
 const report=summarize([
  row({realised_pnl:'40',commission:'-8',close_reason:'PROFIT_PROTECTION'}),
  row({realised_pnl:'-90',commission:'-8'}),
  row({realised_pnl:'40',commission:'-8',close_reason:'PROFIT_PROTECTION'}),
  row({action:'CLOSE_DEMO',close_reason:'AI_CLOSE_SIGNAL',
   state:'CLOSE_PENDING_RECONCILIATION',verified_guard_close:true,
   realised_pnl:'-30',commission:'-10'}),
  row({action:'CLOSE_DEMO',close_reason:'AI_CLOSE_SIGNAL',
   state:'CLOSE_PENDING_RECONCILIATION',verified_guard_close:false,
   realised_pnl:'-50',commission:'-10'})
 ],iso(t0));
 const x=report.cohortAccounting.allCohorts.GUARD_CONTINUED;
 assert.equal(x.settled,3);assert.equal(x.winners,2);assert.equal(x.losers,1);
 assert.equal(x.totalNetUsd,-34);assert.equal(x.grossWinningsUsd,64);
 assert.equal(x.grossLossesUsd,-98);assert.equal(x.meanWinUsd,32);
 assert.equal(x.meanLossUsd,-98);assert.equal(x.profitFactor,.6531);
 assert.equal(report.cohortAccounting.independentlyVerifiedGuardCloses,1);
 assert.equal(report.cohortAccounting.allCohorts.UNVERIFIED_GUARD_CLOSE_ACTION.settled,1);
 assert.equal(report.safety.trainedClassifier,false);
 assert.equal(report.safety.guardThresholdChanged,false);
 assert.equal(report.tradeAuthority,'NONE');
});
