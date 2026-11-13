'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {WINDOWS,QUERY,normalize,summary,reportWindows,run}=
 require('./audit-nov04-legacy-model-parity.cjs');
const USER='de32e3d3-60c1-43ff-b836-264a058d1ff6';
const stamp='2026-11-04T09:00:00.000Z';
const old=(patch={})=>({id:'a',instrument:'USDCAD',direction:'SELL',
 created_at:stamp,closed_at:'2026-11-04T09:05:00Z',
 lot_size:'0.20',realised_pnl:'10.00',commission:'-2.00',swap:'0',
 account_currency:'EUR',broker_id:'ctrader',account_type:'DEMO',
 strategy_code:'external-irexpro-multimodel-ensemble',
 model_version:'external-provider/irexpro-multimodel-ensemble-v1/demo-v1',
 authority:'PRIMARY_PLAN_B',planb_route:'TREND_CONTINUATION',...patch});
const pepper=(patch={})=>old({id:'new',created_at:'2026-11-10T10:00:00.000Z',
 account_currency:'USD',broker_id:'pepperstone-ctrader',lot_size:'4.00',
 realised_pnl:'100',commission:'-24',...patch});
test('historical date windows use explicit UTC Z and are never local-time guesses',()=>{
 assert.equal(WINDOWS[0].from,'2026-11-04T00:00:00Z');
 assert.equal(WINDOWS[0].to,'2026-11-05T00:00:00Z');
 for(const w of WINDOWS){
  assert.match(w.from,/Z$/);assert.match(w.to,/Z$/);
 }
 assert.match(QUERY,/t\.created_at >= \$2::timestamptz/);
 assert.match(QUERY,/t\.created_at < \$3::timestamptz/);
});
test('read-only broker/source scoping avoids mixing EUR cTrader with USD Pepperstone',()=>{
 assert.match(QUERY,/t\.user_id=\$1/);
 assert.match(QUERY,/b\.broker_id=\$4/);
 assert.match(QUERY,/t\.account_currency=\$5/);
 assert.match(QUERY,/b\.account_type='DEMO'/);
 assert.match(QUERY,/t\.status='CLOSED'/);
 assert.throws(()=>normalize([pepper()],'EUR','ctrader'),/INVALID_OR_MIXED_BROKER_ACCOUNT/);
 assert.throws(()=>normalize([old()],'USD','pepperstone-ctrader'),/INVALID_OR_MIXED_BROKER_ACCOUNT/);
});
test('actual net after broker fees, winners, profit factor and lots are correct',()=>{
 const a=normalize([old(),old({id:'b',realised_pnl:'-4',commission:'-2'})],
  'EUR','ctrader').priced;
 const r=summary(a);
 assert.deepEqual({n:r.n,wins:r.netWinners,net:r.net,gross:r.gross,fees:r.fees,
  lots:r.totalLots,pf:r.netProfitFactor},
  {n:2,wins:1,net:2,gross:6,fees:-4,lots:0.4,pf:1.333});
 assert.equal(r.modelVersions.length,1);
});
test('missing broker commission is excluded but explicitly accounted as missing',()=>{
 const r=reportWindows({
  nov04:[old({commission:null})],
  nov04_to_nov09:[old()],
  nov10_to_nov12:[pepper()]});
 assert.equal(r.reportByPeriod.nov04.dataQuality.unpriced,1);
 assert.equal(r.reportByPeriod.nov04.total.n,0);
 assert.equal(r.modelPromotion,false);
 assert.equal(r.actualOrderChanges,false);
});
test('4 Nov primary, bootstrap and transition models are never merged',()=>{
 const p=reportWindows({
  nov04:[
   old(),old({id:'b',authority:'BOOTSTRAP_CONTINUATION',
    strategy_code:'external-irexpro-m1-tactical',realised_pnl:'-3.00'}),
   old({id:'c',authority:'M5_EARLY_TRANSITION_HANDOFF',
    planb_route:'EARLY_TRANSITION',realised_pnl:'-2.00'}),
  ],nov04_to_nov09:[old()],nov10_to_nov12:[pepper()]});
 const a=p.reportByPeriod.nov04.byAuthority;
 assert.equal(a.PRIMARY_PLAN_B.net,8);
 assert.equal(a.BOOTSTRAP_CONTINUATION.net,-5);
 assert.equal(a.M5_EARLY_TRANSITION_HANDOFF.net,-4);
 assert.equal(p.reportByPeriod.nov04.total.net,-1);
 assert.equal(p.reportByPeriod.nov10_to_nov12.currency,'USD');
 assert.equal(p.reportByPeriod.nov04.currency,'EUR');
});
test('script is read-only and refuses incomplete historical comparisons',async()=>{
 const calls=[];
 const db={query:async(sql,args)=>{
  calls.push([sql,args]);
  if(sql===QUERY){
   const broker=args[3];
   if(broker==='ctrader')return {rows:[old()]};
   return {rows:[pepper()]};
  }
  return {rows:[]};
 }};
 const r=await run(db,USER);
 assert.equal(r.reportByPeriod.nov04.total.net,8);
 assert.equal(r.reportByPeriod.nov10_to_nov12.total.net,76);
 assert.equal(calls[0][0],'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 assert.equal(calls.at(-1)[0],'COMMIT');
 assert.equal(calls.filter(([s])=>s===QUERY).length,3);
 assert.deepEqual(calls.filter(([s])=>s===QUERY).map(([,args])=>args[4]),
  ['EUR','EUR','USD']);
 assert(!calls.some(([s])=>/INSERT|DELETE|UPDATE|ALTER|TRUNCATE/.test(s)));
 const absent={query:async(sql,args)=>sql===QUERY?{rows:[]}:{rows:[]}};
 await assert.rejects(run(absent,USER),/HISTORICAL_ACCOUNT_COVERAGE_INCOMPLETE/);
});
