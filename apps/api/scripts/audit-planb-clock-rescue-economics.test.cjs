'use strict';
const {test}=require('node:test');
const a=require('node:assert/strict');
const {period,day,asOfRow,independentClear,sameStrategy,
 replay,stats,summarize,audit,SQL}=require('./audit-planb-clock-rescue-economics.cjs');
const {scorePlanBShadowMeta,scorePlanBClockNeutralResearch}=
 require('../dist/modules/ai/v8-shadow-meta-scorer');
const {scorePlanBMultimodelShadow}=
 require('../dist/modules/ai/plan-b-multimodel-shadow');
const scorer={active:scorePlanBShadowMeta,neutral:scorePlanBClockNeutralResearch};
const good={
 regimeAllowed:'true',regime:'TREND_HEALTHY',eventRisk:'CLEAR',
 driftState:'NORMAL',governanceBlockers:['ENSEMBLE_NOT_PAPER_ADMITTED']};
test('Ghana afternoon starts 13:30 UTC, spans midnight, 01:00 is new morning',()=>{
 a.equal(period('2026-11-11T13:29:00Z'),'BEFORE_1330');
 a.equal(period('2026-11-11T13:30:00Z'),'AFTER_1330');
 a.equal(period('2026-11-11T23:59:00Z'),'AFTER_1330');
 a.equal(period('2026-11-12T00:50:00Z'),'AFTER_1330');
 a.equal(period('2026-11-12T01:00:00Z'),'BEFORE_1330');
 a.equal(day('2026-11-12T00:50:00Z'),'2026-11-11');
});
test('independent news, drift, rollover, missing spread evidence retain veto',()=>{
 a.equal(independentClear(good),true);
 for(const patch of [
  {eventRisk:'HIGH_IMPACT_BLOCK'},{driftState:'OUT_OF_DISTRIBUTION'},
  {regime:'ROLLOVER_RISK'},{regimeAllowed:'false'},
  {governanceBlockers:['SPREAD_UNVERIFIED']},{governanceBlockers:null},
 ]){
  a.equal(independentClear({...good,...patch}),false);
 }
});
test('M1 and Plan B strategy mismatch blocks candidate even when nominally routed',()=>{
 a.equal(sameStrategy({m1Route:'M1_TREND_CONTINUATION',
   strategyRoute:'TREND_CONTINUATION'}),true);
 a.equal(sameStrategy({m1Route:'M1_EARLY_TRANSITION',
   strategyRoute:'TREND_CONTINUATION'}),false);
 a.equal(sameStrategy({m1Route:'ABSTAIN',
   strategyRoute:'TREND_CONTINUATION'}),false);
});
function fixture(){
 const input={instrument:'EURUSD',direction:'SELL',
  confidence:.7,extensionAtr:.65,volatilityScore:.25,
  emaSeparation:.45,mtfStrength:.55,rsi14:39,
  shortHorizonMomentumAtr:-.2,scanTime:new Date('2026-11-11T19:00:00Z')};
 const score=scorePlanBMultimodelShadow(input);
 const research=scorePlanBClockNeutralResearch(input);
 return {instrument:input.instrument,direction:input.direction,
  route:'M1_TREND_CONTINUATION',created_at:input.scanTime,
  evaluated_at:input.scanTime,execution_authority:'NONE',
  candidate:{confidence:input.confidence,alignedEmaSeparationAtr:input.emaSeparation*2,
    alignedM15:input.mtfStrength},
  governance:{
   multimodelEnsemble:score,
   oodResearchFeatures:{extensionAtr:input.extensionAtr,
     volatilityScore:input.volatilityScore,rsi14:input.rsi14,
     shortHorizonMomentumAtr:input.shortHorizonMomentumAtr},
   multimodelGovernance:{eventRisk:'CLEAR',driftState:'NORMAL',
     paperExecutionBlockers:['ENSEMBLE_NOT_PAPER_ADMITTED']},
   planBClockNeutralResearch:research,
  }};
}
test('as-of clock comparison replays exact original and cannot generate broker authority',()=>{
 const f=fixture(),out=replay(f,scorer);
 a.equal(typeof out.crosses,'boolean');
 a.equal(f.execution_authority,'NONE');
 a.equal(asOfRow(f).persistedNeutral,
   scorePlanBClockNeutralResearch({
     instrument:'EURUSD',direction:'SELL',confidence:.7,
     extensionAtr:.65,volatilityScore:.25,emaSeparation:.45,mtfStrength:.55,
     rsi14:39,shortHorizonMomentumAtr:-.2,
     scanTime:new Date('2026-11-11T19:00:00Z')}).hourNeutralProbability);
 a.equal(Object.hasOwn(out,'executable'),false);
 a.equal(Object.hasOwn(out,'order'),false);
});
test('tampered persisted original and research probability must fail replay',()=>{
 const first=fixture();
 first.governance.multimodelEnsemble.metaProbability=.999;
 a.throws(()=>replay(first,scorer),/ACTIVE_REPLAY_MISMATCH/);
 const second=fixture();
 second.governance.planBClockNeutralResearch.hourNeutralProbability=.999;
 a.throws(()=>replay(second,scorer),/PERSISTED_NEUTRAL_MISMATCH/);
});
test('missing cost/quote outcomes cannot be counted as profitable',()=>{
 const caseOne={period:'AFTER_1330',day:'2026-11-11',
  flags:{crosses:true,newlyCore:true,strictlyScreened:true,activeCore:false},
  study:null};
 const report=summarize([caseOne]);
 a.equal(report.cohorts.AFTER_OTHER_GATES_CLEAR.episodes,1);
 a.equal(report.cohorts.AFTER_OTHER_GATES_CLEAR[5].n,0);
 a.equal(report.cohorts.AFTER_OTHER_GATES_CLEAR[5].positiveShare,null);
});
test('read-only DB ownership check fails closed when broker/session missing',async()=>{
 const calls=[];
 const client={query:async(q)=>{calls.push(q);return {rows:[]}}};
 await a.rejects(audit(client,{
   userId:'2caa0c64-00dd-48fb-babb-06b39cb74068',
   from:'2026-11-11T08:00:00Z',through:'2026-11-11T20:00:00Z',
   scorer}),/OWNED_USD_DEMO_UNAVAILABLE/);
 a.equal(calls[0],'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 a.equal(calls.at(-1),'ROLLBACK');
 a.match(SQL.decisions,/d.user_id=\$1 AND d.broker_connection_id=\$2/);
});
test('extended research horizons can be marked without altering legacy short-horizon observations',()=>{
 const {studyEpisode}=require('./audit-short-horizon-m1-episodes.cjs');
 const quote=(at,bid,ask)=>({last_quote_sample_at:at,bid_close:bid,
  ask_close:ask,source:'ctrader-broker-native',positive_quote_sample_count:3});
 const start='2026-11-11T13:30:00Z';
 const qs=[quote('2026-11-11T13:30:30Z',1.2,1.2001),
  quote('2026-11-11T13:35:40Z',1.2004,1.2005),
  quote('2026-11-11T13:40:40Z',1.2006,1.2007),
  quote('2026-11-11T13:50:40Z',1.2008,1.2009),
  quote('2026-11-11T14:00:40Z',1.201,1.2011),
  quote('2026-11-11T14:30:40Z',1.202,1.2021)];
 const fees=Array.from({length:9},(_,i)=>({
  closedAt:Date.parse('2026-11-10T10:00:00Z')+i*60000,feePerLot:7}));
 const d={instrument:'EURUSD',direction:'BUY',created_at:start};
 const normal=studyEpisode(d,qs,fees);
 const longer=studyEpisode(d,qs,fees,[5,10,20,30,60]);
 a.equal(normal.outcomes[5].netUsd1Lot,longer.outcomes[5].netUsd1Lot);
 a.equal(normal.outcomes[10].netUsd1Lot,longer.outcomes[10].netUsd1Lot);
 a.equal(longer.outcomes[60].positiveAfterCosts,true);
 a.throws(()=>studyEpisode(d,qs,fees,[120]),/UNSUPPORTED_RESEARCH_MARK_HORIZON/);
});
