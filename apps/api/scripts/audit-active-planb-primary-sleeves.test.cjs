'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {SCOPE_SQL,TRADE_SQL,normalized,stats,reportFor,run}=require('./audit-active-planb-primary-sleeves.cjs');
const OWNER='2caa0c64-00dd-48fb-babb-06b39cb74068';
const CONN='26ef9b4e-6e24-4a65-a4f2-8db22e209e9d';
const AT='2026-11-12T22:50:00.000Z';
const SCOPE={userId:OWNER,connectionId:CONN,currency:'USD',broker:'pepperstone-ctrader'};
function trade(p={}){
 return {id:'tr-1',instrument:'AUDUSD',direction:'SELL',
  closedAt:'2026-11-12T11:00:00Z',gross:'10',commission:'-12',swap:'-0.4',
  route:'TREND_CONTINUATION',currency:'USD',...p};
}
test('active owner-scope excludes disconnected, older, live and other accounts',()=>{
 assert.match(SCOPE_SQL,/bc\.status='CONNECTED'/);
 assert.match(SCOPE_SQL,/bc\.authorization_status='ACTIVE'/);
 assert.match(SCOPE_SQL,/ts\.status='ACTIVE'/);
 assert.match(SCOPE_SQL,/ts\.execution_mode='FULL_AUTO'/);
 assert.match(SCOPE_SQL,/bc\.account_type='DEMO'/);
 assert.match(SCOPE_SQL,/bc\.user_id=ts\.user_id/);
 assert.match(SCOPE_SQL,/ts\.user_id=\$1/);
 assert.match(SCOPE_SQL,/pepperstone-ctrader/);
 assert.doesNotMatch(SCOPE_SQL,/account_currency='EUR'/);
 assert.match(TRADE_SQL,/t\.broker_connection_id=\$2/);
 assert.match(TRADE_SQL,/PRIMARY_PLAN_B/);
 assert.match(TRADE_SQL,/ti\.user_id=t\.user_id/);
 assert.match(TRADE_SQL,/LIMIT \$5::int/);
});
test('a broker gross winner can be a real net loss after paid commissions',()=>{
 const {priced,unpriced}=normalized([trade()], 'USD');
 assert.equal(unpriced.length,0);
 assert.ok(Math.abs(priced[0].net + 2.4)<1e-10);
 const x=stats(priced);
 assert.equal(x.gross,10);assert.equal(x.brokerCosts,-12.4);
 assert.equal(x.net,-2.4);assert.equal(x.netWins,0);
 assert.equal(x.grossWinsNonPositiveAfterCosts,1);
});
test('grouping preserves side, route, money currency and unpriced coverage',()=>{
 const r=reportFor([
  trade({id:'a',gross:'60',commission:'-12'}),
  trade({id:'b',direction:'BUY',gross:'-12',commission:'-12'}),
  trade({id:'missing',instrument:'EURUSD',commission:null}),
 ], SCOPE, AT);
 assert.equal(r.currency,'USD');
 assert.equal(r.dataQuality.priced,2);
 assert.equal(r.dataQuality.unpriced,1);
 assert.equal(r.dataQuality.complete,false);
 assert.equal(r.byPairSideStrategy['AUDUSD/SELL/TREND_CONTINUATION'].net,47.6);
 assert.equal(r.byPairSideStrategy['AUDUSD/BUY/TREND_CONTINUATION'].net,-24.4);
 assert.equal(r.missingCostsBySleeve['EURUSD/SELL/TREND_CONTINUATION'],1);
 assert.equal(r.executionAuthority,'NONE');
 assert.equal(r.changesExecution,false);
 assert.equal(r.changesBrokerOrders,false);
});
test('enforces exact actual connected account currency, even when trades otherwise look valid',()=>{
 assert.throws(()=>normalized([trade({currency:'EUR'})],'USD'),/INVALID_REAL_BROKER_TRADE_OR_ACCOUNT_SCOPE/);
 assert.throws(()=>normalized([trade(),trade()],'USD'),/INVALID_REAL_BROKER_TRADE_OR_ACCOUNT_SCOPE/);
 assert.throws(()=>normalized([trade({route:'UNKNOWN'})],'USD'),/INVALID_REAL_BROKER_TRADE_OR_ACCOUNT_SCOPE/);
 assert.throws(()=>reportFor([], {...SCOPE,currency:'GHS/CEDI'},AT),/INVALID_ACTIVE_ACCOUNT_CURRENCY/);
});
test('read-only transaction queries the exact active account and current currency',async()=>{
 const calls=[];
 const client={query:async(sql,args)=>{
  calls.push([sql,args]);
  if(sql===SCOPE_SQL)return {rows:[SCOPE]};
  if(sql.startsWith('SELECT current_timestamp'))return {rows:[{asOf:AT}]};
  if(sql===TRADE_SQL)return {rows:[trade()]};
  return {rows:[]};
 }};
 const r=await run({client,userId:OWNER});
 assert.equal(calls[0][0],'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 assert.equal(calls[1][0],"SET LOCAL statement_timeout='12000ms'");
 assert.deepEqual(calls.find(x=>x[0]===SCOPE_SQL)[1],[OWNER]);
 const params=calls.find(x=>x[0]===TRADE_SQL)[1];
 assert.equal(params[0],OWNER);
 assert.equal(params[1],CONN);
 assert.equal(params.at(-1),3001);
 assert.equal(calls.at(-1)[0],'COMMIT');
 assert.equal(r.total.net,-2.4);
});
test('does not query trading ledger if active DEMO broker cannot be owner verified',async()=>{
 const calls=[];
 const client={query:async(sql)=>{
  calls.push(sql);
  return {rows:[]};
 }};
 await assert.rejects(run({client,userId:OWNER}),/CONNECTED_ACTIVE_DEMO_NOT_AVAILABLE/);
 assert.equal(calls.includes(TRADE_SQL),false);
 assert.equal(calls.at(-1),'ROLLBACK');
});
test('refuses truncated trade history rather than biasing recent results',async()=>{
 const client={query:async(sql)=>{
  if(sql===SCOPE_SQL)return {rows:[SCOPE]};
  if(sql.startsWith('SELECT current_timestamp'))return {rows:[{asOf:AT}]};
  if(sql===TRADE_SQL)return {rows:Array.from({length:3001},(_,i)=>trade({id:'tr-'+i}))};
  return {rows:[]};
 }};
 await assert.rejects(run({client,userId:OWNER}),/TRUNCATED_HISTORY_REFUSE/);
});
test('short histories never claim an independent qualified profitable edge',()=>{
 const r=reportFor([
  trade({id:'a',closedAt:'2026-11-09T09:00:00Z',gross:'50',commission:'-6'}),
  trade({id:'b',closedAt:'2026-11-10T10:00:00Z',gross:'50',commission:'-6'}),
  trade({id:'c',closedAt:'2026-11-12T11:00:00Z',gross:'50',commission:'-6'}),
 ], SCOPE, AT);
 assert.equal(r.total.screening,'INSUFFICIENT_DISTINCT_DAYS');
 assert.equal(r.byStrategy.TREND_CONTINUATION.screening,'INSUFFICIENT_DISTINCT_DAYS');
 assert.equal(r.changesExecution,false);
});
