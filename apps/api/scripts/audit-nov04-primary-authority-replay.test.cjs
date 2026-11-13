'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {nov04PrimaryAuthority,compareWindow,QUERY,run}=
 require('./audit-nov04-primary-authority-replay.cjs');
const OWNER='bcde668a-4104-4fa5-b371-1639526c5df1';
const OLD='42f2dbe0-fdb7-48a3-9db2-b1bc759d7ac6';
const NOW='88554498-41e2-4c19-9ab2-43d8e2604129';
const base=(patch={})=>({
 instrument:'AUDUSD',direction:'SELL',route:'M1_TREND_CONTINUATION',
 evaluated_at:'2026-11-12T14:33:00Z',
 ensemble:{paperAdmitted:true,strategyRoute:'TREND_CONTINUATION'},
 strategy_governance:{paperExecutionEligible:true},
 expert:{allBrokerNative:true,direction:'SELL',longVotes:0,shortVotes:3,
  ensembleConfidence:0.8},
 current_authority:{authorityPath:'PRIMARY_PLAN_B',blockers:[]},
 execution_authority:'BROKER_NATIVE',blockers:[],
 ...patch,
});
test('frozen 4 November primary trend requires identical M1 timing and governance',()=>{
 assert.equal(nov04PrimaryAuthority(base()).eligible,true);
 assert.deepEqual(nov04PrimaryAuthority(base({route:'ABSTAIN'})),{
  valid:true,eligible:false,reason:'M1_TIMING_MISMATCH',
 });
 assert.equal(nov04PrimaryAuthority(base({
  strategy_governance:{paperExecutionEligible:false},
 })).reason,'GOVERNANCE_REJECTED');
 assert.equal(nov04PrimaryAuthority(base({
  ensemble:{paperAdmitted:false,strategyRoute:'TREND_CONTINUATION'},
 })).reason,'PLAN_B_NOT_ADMITTED');
});
test('4 November reversal bridge required expert unanimity; no continuation bridge',()=>{
 const row=base({ensemble:{paperAdmitted:true,strategyRoute:'CONFIRMED_REVERSAL'},
  route:'M1_EARLY_TRANSITION'});
 assert.equal(nov04PrimaryAuthority(row).eligible,true);
 assert.equal(nov04PrimaryAuthority({...row,expert:{...row.expert,shortVotes:2,longVotes:1}}).eligible,false);
 assert.equal(nov04PrimaryAuthority({...row,expert:{...row.expert,ensembleConfidence:0.69}}).eligible,false);
 assert.equal(nov04PrimaryAuthority({...row,route:'M1_TREND_CONTINUATION'}).eligible,false);
 assert.equal(nov04PrimaryAuthority({...row,route:'M1_CONFIRMED_REVERSAL'}).eligible,true);
});
test('legacy early transition never permitted Plan B continuation M1 timing',()=>{
 const r=base({ensemble:{paperAdmitted:true,strategyRoute:'EARLY_TRANSITION'}});
 assert.equal(nov04PrimaryAuthority(r).eligible,false);
 assert.equal(nov04PrimaryAuthority({...r,route:'M1_EARLY_TRANSITION'}).eligible,true);
});
test('invalid or incomplete record is NOT silently treated as an approved order',()=>{
 assert.equal(nov04PrimaryAuthority(base({expert:null})).valid,false);
 assert.equal(nov04PrimaryAuthority(base({route:'UNKNOWN_ROUTE'})).eligible,false);
});
test('current primary vs legacy primary differences reported without changing execution',()=>{
 const rows=[
  base(),
  base({route:'ABSTAIN',current_authority:{authorityPath:'BLOCKED',blockers:['M1_TIMING']},
   execution_authority:'NONE',blockers:['M1_TIMING']}),
  base({current_authority:{authorityPath:'BLOCKED',blockers:['CHANGED_GATE']},
   execution_authority:'NONE',blockers:['CHANGED_GATE']}),
  base({current_authority:{authorityPath:'PRIMARY_PLAN_B',blockers:[]},
   execution_authority:'NONE',blockers:['PORTFOLIO_NET_LOSS']}),
 ];
 const r=compareWindow(rows,{broker:'pepperstone-ctrader',currency:'USD',interval:[]});
 assert.equal(r.comparedPaperAdmittedOrPrimary,4);
 assert.equal(r.oldPrimary,3);
 assert.equal(r.currentPrimary,2);
 assert.equal(r.agreementOnPrimary,2);
 assert.equal(r.oldOnly,1);
 assert.equal(r.currentOnly,0);
 assert.equal(r.actualApproved,1);
 assert.equal(r.primaryDownstreamBlocked,1);
 assert.equal(r.downstreamPrimaryBlockers.PORTFOLIO_NET_LOSS,1);
 assert.equal(r.oldOnlyExamples[0].currentBlockers[0],'CHANGED_GATE');
});
test('DB replay executes strictly owner-bound read-only windows for distinct old/current DEMO',async()=>{
 const calls=[];
 const db={query:async(sql,args)=>{
  calls.push({sql,args});
  if(sql.includes("t.account_currency='EUR'"))return {rows:[{id:OLD}]};
  if(sql.includes("b.broker_id='pepperstone-ctrader'"))return {rows:[{id:NOW}]};
  if(sql===QUERY)return {rows:[base()]};
  return {rows:[]};
 }};
 const r=await run(db,OWNER);
 assert.equal(r.mode,'READ_ONLY_NO_BROKER_AUTHORITY');
 assert.equal(r.altersOrders,false);
 assert.equal(r.periods.nov04_ctrader_eur.broker,'ctrader');
 assert.equal(r.periods.nov04_ctrader_eur.oldPrimary,1);
 assert.equal(r.periods.nov12_pepperstone_usd.currentPrimary,1);
 assert.equal(calls[0].sql,'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 assert.equal(calls.at(-1).sql,'COMMIT');
 const reads=calls.filter(c=>c.sql===QUERY);
 assert.equal(reads.length,5);
 assert.equal(reads[0].args[1],OLD);
 assert(reads.slice(1).every(c=>c.args[1]===NOW));
 assert(reads.every(c=>c.args[0]===OWNER));
 assert(!calls.some(c=>/^\s*(UPDATE|DELETE|INSERT|ALTER|TRUNCATE)/i.test(c.sql)));
});
test('refuses same broker connection for incompatible historical account periods',async()=>{
 const db={query:async(sql)=>{
  if(sql.includes('t.account_currency'))return {rows:[{id:NOW}]};
  if(sql.includes("b.broker_id='pepperstone-ctrader'"))return {rows:[{id:NOW}]};
  return {rows:[]};
 }};
 await assert.rejects(run(db,OWNER),/TWO_DISTINCT_OWNER_BOUND_DEMO_ACCOUNTS_REQUIRED/);
});
