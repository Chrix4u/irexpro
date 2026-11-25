'use strict';
const {readPrivateFixture}=require('./private-research-test-fixture.cjs');
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {
 DECISIONS_SQL,SETTLEMENTS_SQL,ORDERS_SQL,eligiblePath,
 settled,inferPortfolioBrake,summarize,audit,persist,
}=require('./audit-owner-demo-entry-blockers.cjs');
const OWNER='b0d690b5-5a09-4d7f-a7b9-68f81f6bf615';
const AT='2026-11-18T13:37:00Z';
const TRADE_CLOSE='2026-11-18T12:05:33.982Z';
const negative=(at,net)=>({closed_at:at,opened_at:'2026-11-18T11:50:00Z',
 instrument:'AUDUSD',direction:'SELL',realised_pnl:String(net+10),
 commission:'-10',swap:'0'});
const losses=[
 negative(TRADE_CLOSE,-81.88),
 negative('2026-11-18T09:43:07Z',-37.96),
 negative('2026-11-18T09:37:22Z',-39.26),
];
const candidate=(opts={})=>({
 evaluated_at:'2026-11-18T13:24:00Z',
 instrument:'AUDUSD',direction:'SELL',route:'ABSTAIN',
 blockers:['MULTIMODEL_REVERSAL_NOT_M1_CONFIRMED',
  'M1_PORTFOLIO_NET_LOSS_STREAK_BRAKE'],
 ensemble:{strategyRoute:'CONFIRMED_REVERSAL',paperAdmitted:true},
 governance:{paperExecutionEligible:true},
 authority:{authorityPath:'BLOCKED',executable:false},
 alternative:{eligible:true,continuousEvidence:true,
  artifact:'pepperstone-demo-advisory-alternate-bridge-v1',reason:'ELIGIBLE'},
 portfolio_brake:{active:true,reason:'RECENT_PORTFOLIO_NET_LOSS_STREAK',
  latestClosedAt:TRADE_CLOSE},
 strategy_brake:null,...opts,
});
test('query explicitly isolates owner Pepperstone USD DEMO, safe observation only',()=>{
 for(const q of [DECISIONS_SQL,SETTLEMENTS_SQL,ORDERS_SQL]){
  assert.match(q,/user_id=\$1 AND b.user_id=\$1/);
  assert.match(q,/b.broker_id='pepperstone-ctrader'/);
  assert.match(q,/b.account_type='DEMO'/);
  assert.match(q,/b.account_currency='USD'/);
  assert.doesNotMatch(q,/UPDATE|DELETE|INSERT|SET \w+=/);
 }
 assert.match(SETTLEMENTS_SQL,/s.execution_mode='FULL_AUTO'/);
});
test('independent portfolio brake uses signed commission, no missing-cost assumed free',()=>{
 assert.equal(settled(losses[0]),-81.88);
 assert.equal(settled({...losses[0],commission:null}),null);
 assert.equal(settled({...losses[0],swap:null}),null);
});
test('exact 120-minute brake expires at actual broker-close timestamp plus 120 min',()=>{
 const r=inferPortfolioBrake(losses,Date.parse(AT));
 assert.equal(r.state,'CONFIRMED_THREE_LOSSES_120M_GUARD');
 assert.equal(r.lastThreeNetSumUsd,-159.10);
 assert.equal(r.potentialBrakeEndsAt,'2026-11-18T14:05:33.982Z');
 assert.equal(r.remainingSeconds,1714);
 const after=inferPortfolioBrake(losses,Date.parse('2026-11-18T14:06:00Z'));
 assert.equal(after.state,'THREE_LOSSES_BUT_TIME_GATE_EXPIRED');
 assert.equal(after.remainingSeconds,0);
});
test('no brake is inferred if any prior trade net positive or data missing',()=>{
 const wins=[losses[0],{...losses[1],realised_pnl:'90'},losses[2]];
 assert.equal(inferPortfolioBrake(wins,Date.parse(AT)).latestThreeNegative,false);
 const bad=[losses[0],{...losses[1],commission:null},losses[2]];
 assert.equal(inferPortfolioBrake(bad,Date.parse(AT)).latestThreeNegative,false);
 assert.equal(inferPortfolioBrake([],Date.parse(AT)).state,
  'NO_RECENT_FULL_AUTO_SETTLEMENT');
});
test('eligible continuous alternate is independent of duplicate M1 route label',()=>{
 const x=eligiblePath(candidate());
 assert.equal(x.altEligible,true);
 assert.equal(x.primaryEligible,false);
 assert.equal(x.duplicateLabelMismatchAdvisory,true);
 assert.equal(x.portfolioBrakeActive,true);
 assert.equal(eligiblePath(candidate({
  alternative:{...candidate().alternative,eligible:false},
 })).altEligible,false);
 assert.equal(eligiblePath(candidate({
  alternative:{...candidate().alternative,artifact:'untrusted'},
 })).altEligible,false);
});
test('research blocks never claim all eligible alternatives would broker-fill',()=>{
 const r=summarize([candidate()],losses,{n:0,latest:null,
  since_latest_close:0},new Date(AT));
 assert.equal(r.scannerDecisionsObserved,1);
 assert.equal(r.selectedContinuousAlternativeEligible,1);
 assert.equal(r.eligibleAlternativeWithPortfolioBrake,1);
 assert.equal(r.selectedAlternativeEligibleSinceLastClose,1);
 assert.equal(r.selectedAlternativeBrakedSinceLastClose,1);
 assert.equal(r.newTradeIntentsSinceLastClose,0);
 assert.equal(r.diagnosticBlockersRanked.some(x=>
  x.reason==='MULTIMODEL_REVERSAL_NOT_M1_CONFIRMED'),true);
 assert.equal(r.modes.executionAuthority,'NONE');
 assert.equal(r.modes.changesBrakes,false);
 assert.equal(r.modes.liveEligible,false);
});
test('owner DEMO advisory-only raw loss streak is not misreported as an order veto',()=>{
 const x=candidate({
  blockers:['MULTIMODEL_REVERSAL_NOT_M1_CONFIRMED'],
  owner_pause_policy:{advisoryOnly:true,portfolioLossStreakBlocks:false,
   modelLossStreakBlocks:false,fastStopCooldownBlocks:false},
 });
 const r=summarize([x],losses,{n:0,latest:null,since_latest_close:0},
  new Date(AT));
 assert.equal(r.eligibleAlternativeWithPortfolioBrake,1);
 assert.equal(r.eligibleAlternativeWithEffectivePortfolioVeto,0);
 assert.equal(r.selectedAlternativeBrakedSinceLastClose,0);
 assert.equal(r.ownerDemoAdvisoryOnlyDecisions,1);
 assert.equal(r.latestOwnerPausePolicy.advisoryOnly,true);
 assert.equal(r.activeSafetyObservations.portfolioBrake,1);
 assert.equal(r.effectiveSafetyVetoes.portfolioBrake,0);
});
test('latest owner advisory status comes from an eligible path, not a later ineligible tick',()=>{
 const eligible=candidate({
  owner_pause_policy:{advisoryOnly:true,portfolioLossStreakBlocks:false},
  blockers:[],
 });
 const ineligible=candidate({
  evaluated_at:'2026-11-18T13:27:00Z',
  alternative:{eligible:false},
  owner_pause_policy:{advisoryOnly:false,portfolioLossStreakBlocks:true},
  blockers:[],
 });
 const r=summarize([ineligible,eligible],losses,{n:0,since_latest_close:0},
  new Date(AT));
 assert.equal(r.latestOwnerPausePolicy.advisoryOnly,true);
 assert.equal(r.ownerDemoAdvisoryOnlyDecisions,1);
});
test('selected alternate without portfolio brake can be rejected by a separate safety rule',()=>{
 const x=candidate({
  evaluated_at:'2026-11-18T12:59:00Z',
  portfolio_brake:null,
  blockers:['M1_DEMO_EARLY_TRANSITION_PAIR_SIDE_DEGRADED'],
 });
 const r=summarize([x],losses,{n:0,latest:null,since_latest_close:0},
  new Date(AT));
 assert.equal(r.selectedAlternativeEligibleSinceLastClose,1);
 assert.equal(r.selectedAlternativeBrakedSinceLastClose,0);
 assert.equal(r.diagnosticBlockersRanked[0].reason,
  'M1_DEMO_EARLY_TRANSITION_PAIR_SIDE_DEGRADED');
});
test('as-of window excludes future and older-than-three-hours decisions',()=>{
 const old=candidate({evaluated_at:'2026-11-17T10:00:00Z'});
 const future=candidate({evaluated_at:'2026-11-18T14:00:00Z'});
 const r=summarize([old,future],losses,{n:0,since_latest_close:0},
  new Date(AT));
 assert.equal(r.scannerDecisionsObserved,0);
});
test('bounded repeatable-read transaction uses exactly owner and no update',async()=>{
 const calls=[];
 const c={query:async(sql,params)=>{
  calls.push({sql,params});
  if(sql===DECISIONS_SQL)return {rows:[candidate()]};
  if(sql===SETTLEMENTS_SQL)return {rows:losses};
  if(sql===ORDERS_SQL)return {rows:[{n:0,latest:null,
   since_latest_close:0}]};
  return {rows:[]};
 }};
 await assert.rejects(audit(c,'bad',new Date(AT)),/UNVERIFIED_OWNER/);
 assert.equal(calls.length,0);
 const r=await audit(c,OWNER,new Date(AT));
 assert.equal(r.selectedContinuousAlternativeEligible,1);
 assert.equal(calls[0].sql,'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 assert.equal(calls.at(-1).sql,'COMMIT');
 for(const q of calls.filter(x=>[DECISIONS_SQL,SETTLEMENTS_SQL,ORDERS_SQL].includes(x.sql)))
  assert.equal(q.params[0],OWNER);
 assert.equal(calls.find(x=>x.sql===ORDERS_SQL).params.length,4);
});
test('private atomic report is owner-only and does not write trading DB',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'irexpro-brake-'));
 try{
  const r=summarize([candidate()],losses,{n:0,since_latest_close:0},
   new Date(AT));
  const filename=path.join(root,'reports','snapshot.json');
  persist(r,filename);
  assert.equal(JSON.parse(readPrivateFixture(filename)).modes.modifiesOrders,false);
 }finally{fs.rmSync(root,{recursive:true,force:true})}
});
