'use strict';
/**
 * Read-only actual owner Pepperstone USD DEMO trade decision comparison.
 * Frozen as-of trade entry metadata vs actual after-fee broker settlement.
 * Discovery cohort (17-18 November 2026), NOT predictive validation.
 */
const fs=require('node:fs'),path=require('node:path');
const FROM='2026-11-17T00:00:00Z',TO='2026-11-19T00:00:00Z';
const OUT='/home/lightworld/webapps/irexpro-research/governance-disagreement';
const SQL=[
 "SELECT t.id::text trade_id,t.instrument,t.direction,t.opened_at,t.closed_at,",
 "t.realised_pnl,t.commission,t.swap,t.max_favorable_pnl,",
 "ti.metadata->>'multimodel_plan_b_route' strategy,",
 "ti.metadata->>'multimodel_governance_net_expected_r' planb_expected_r,",
 "ti.metadata->>'multimodel_plan_b_score' planb_score,",
 'd.evaluated_at decision_at,d.governance',
 'FROM trading.trades t',
 'JOIN broker.broker_connections b ON b.id=t.broker_connection_id',
 'AND b.user_id=t.user_id',
 'JOIN trading.trade_intents ti ON ti.id=t.trade_intent_id',
 'AND ti.user_id=t.user_id AND ti.broker_connection_id=t.broker_connection_id',
 'LEFT JOIN LATERAL (SELECT d.evaluated_at,d.governance',
 'FROM trading.m1_tactical_decisions d',
 'WHERE d.trade_intent_id=ti.id AND d.user_id=t.user_id',
 'AND d.broker_connection_id=t.broker_connection_id',
 'AND d.evaluated_at<=t.opened_at ORDER BY d.evaluated_at DESC,d.id DESC LIMIT 1) d ON TRUE',
 'WHERE t.user_id=$1 AND b.user_id=$1',
 "AND b.broker_id='pepperstone-ctrader' AND b.account_type='DEMO'",
 "AND b.account_currency='USD' AND b.deleted_at IS NULL",
 "AND t.account_currency='USD' AND t.status='CLOSED'",
 'AND t.opened_at>=$2::timestamptz AND t.opened_at<$3::timestamptz',
 "AND ti.metadata->>'multimodel_plan_b_route' IN ('EARLY_TRANSITION','CONFIRMED_REVERSAL')",
 'ORDER BY t.opened_at,t.id LIMIT 251'
].join(' ');
function n(x){if(x===null||x===undefined||x==='')return null;const y=Number(x);return Number.isFinite(y)?y:null;}
function r(x){return Math.round(x*100)/100}
function classify(row){
 const g=row.governance?.genericGovernance??{},
  expert=row.governance?.multimodelTrainedExpert??{},
  planb=row.governance?.multimodelEnsemble??{};
 const planbR=n(row.planb_expected_r),genericR=n(g.netExpectedR),
  netFields=[n(row.realised_pnl),n(row.commission),n(row.swap)];
 if(netFields.some(v=>v===null)||netFields[1]>0||
    !['EARLY_TRANSITION','CONFIRMED_REVERSAL'].includes(row.strategy))
  throw Error('INVALID_OR_MISSING_SETTLEMENT');
 const net=r(netFields.reduce((a,b)=>a+b,0));
 const validDecision=row.decision_at!==null &&
   new Date(row.decision_at).getTime()<=new Date(row.opened_at).getTime();
 const signals={
  genericNetRNegative:genericR===null?null:genericR<0,
  planBPositiveGenericNegative:planbR===null||genericR===null?null:planbR>0&&genericR<0,
  genericPaperRejected:g.paperExecutionEligible===undefined?null:g.paperExecutionEligible===false,
  driftDisturbed:g.driftState===undefined?null:['STRESSED','OUT_OF_DISTRIBUTION'].includes(g.driftState),
  genericExpectancyFailed:g.netExpectedRPassed===undefined?null:g.netExpectedRPassed===false,
  genericPredictedCostShadowBlocked:g.predictedCostShadow?.paperWouldHaveBlocked??null,
  trainedExpertAbstained:expert.state===undefined?null:expert.state==='ABSTAIN',
  planBNotEnsembleAdmitted:planb.admitted===undefined?null:planb.admitted===false,
 };
 return {
  tradeId:row.trade_id,openedAt:row.opened_at,
  instrument:row.instrument,direction:row.direction,strategy:row.strategy,
  netUsd:net,win:net>0,loss:net<0,
  planbForecastNetR:planbR,genericForecastNetR:genericR,
  decisionPresentAndAsOf:validDecision,driftState:g.driftState??null,
  planBPaperAdmitted:planb.paperAdmitted??null,
  peakBrokerNetUsd:n(row.max_favorable_pnl),
  signals,
 };
}
function aggregate(rows){
 const summary=group=>{
  const wins=group.filter(x=>x.win),losses=group.filter(x=>x.loss);
  return {trades:group.length,wins:wins.length,losses:losses.length,
   netUsd:r(group.reduce((s,x)=>s+x.netUsd,0)),
   winsTotal:r(wins.reduce((s,x)=>s+x.netUsd,0)),
   lossesTotal:r(losses.reduce((s,x)=>s+x.netUsd,0))};
 };
 const cohorts={};
 const routes=['ALL','EARLY_TRANSITION','CONFIRMED_REVERSAL'];
 for(const route of routes){
  const x=rows.filter(y=>route==='ALL'||y.strategy===route);
  const features=Object.keys(x[0]?.signals??{});
  cohorts[route]={total:summary(x),patterns:{}};
  for(const id of features){
   const flagged=x.filter(y=>y.signals[id]===true);
   const clear=x.filter(y=>y.signals[id]===false);
   const unknown=x.filter(y=>y.signals[id]===null);
   cohorts[route].patterns[id]={
    flagged:summary(flagged),notFlagged:summary(clear),unknown:unknown.length,
    wouldRejectSomeWinners:flagged.some(y=>y.win),
    exploratoryOnly:true,
   };
  }
 }
 return cohorts;
}
function md(report){
 const lines=[
 '# Owner DEMO Plan-B vs independent governance disagreement',
 '',
 'Research-only, as-of entry evidence, opened 17–18 November 2026 UTC.',
 'Different model pathways can legitimately disagree; no flag implies unauthorized execution or a guaranteed opposite-side profit.',
 'All monetary figures are signed broker settlement INCLUDING commission/swap.',
 'This is a discovery set; every threshold must be verified on independent future dates and balanced against missed winners.',
 '',
 '| Route | Signal | Flagged | Flagged wins | Flagged losses | Flagged net | Unflagged net | Unknown |',
 '|---|---|---:|---:|---:|---:|---:|---:|'
 ];
 for(const [route,group]of Object.entries(report.cohorts))
  for(const [key,x]of Object.entries(group.patterns)){
   lines.push('| '+route+' | '+key+' | '+x.flagged.trades+
    ' | '+x.flagged.wins+' | '+x.flagged.losses+
    ' | $'+x.flagged.netUsd+' | $'+x.notFlagged.netUsd+' | '+x.unknown+' |');
  }
 lines.push('','## Caveats','',
  '- A negative generic forecast while Plan-B expects positive R is a disagreement across distinct estimators; it is not a prediction that the counter-direction will succeed.',
  '- Neither independent trained-expert ABSTAIN nor generic paper admission status may override existing owner DEMO trading gates without future positive after-fee evidence.',
  '- Avoid tuning a filter to these already-inspected November 17–18 trades, even if the in-sample excluded net P&L appears attractive.',
  '- The forward shadow collector has its own frozen hypothesis set and is not retroactively re-labeled by this audit.',
  '- The underlying trade-level dataset is owner-private and is never committed to public GitHub.');
 return lines.join('\n');
}
async function run(c,owner,now=new Date()){
 if(!/^[a-f0-9-]{36}$/i.test(owner||''))throw Error('INVALID_OWNER_SCOPE');
 await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 try{
  await c.query("SET LOCAL statement_timeout='17000ms'");
  const rows=(await c.query(SQL,[owner,FROM,TO])).rows;
  if(rows.length>250)throw Error('RESEARCH_BOUND_EXCEEDED');
  const parsed=rows.map(classify);
  const report={artifact:'owner-demo-planb-governance-asof-disagreement-v1',
   generatedAt:now.toISOString(),window:{from:FROM,to:TO},
   scope:'OWNER_PEPPERSTONE_USD_DEMO',researchOnly:true,
   modifiesExecution:false,brokerOrders:0,
   hasUnprovenCounterfactuals:false,
   trades:parsed.length,missingDecisionAtEntry:parsed.filter(x=>!x.decisionPresentAndAsOf).length,
   cohorts:aggregate(parsed),privateIndividualCases:parsed,
   disclaimer:'Inspected outcomes: descriptive diagnostic only; no causal evidence to invert an entry or automatically suppress orders.'};
  await c.query('COMMIT');
  return {report,markdown:md(report)};
 }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e}
}
async function main(){
 require('dotenv').config({path:path.join(__dirname,'../.env'),quiet:true});
 const {Client}=require('pg');
 const client=new Client({host:process.env.DB_HOST||'localhost',
  port:Number(process.env.DB_PORT||5432),database:process.env.DB_NAME,
  user:process.env.DB_USER,password:process.env.DB_PASSWORD,
  ssl:process.env.DB_SSL==='true'?{rejectUnauthorized:false}:undefined,
  application_name:'irexpro-owner-demo-governance-disagreement-readonly'});
 try{
  await client.connect();
  const {report,markdown}=await run(client,process.env.VPS_FOREX_SCANNER_USER_ID);
  fs.mkdirSync(OUT,{recursive:true,mode:0o700});
  fs.writeFileSync(path.join(OUT,'latest.json'),JSON.stringify(report,null,2),{mode:0o600});
  fs.writeFileSync(path.join(OUT,'latest.md'),markdown,{mode:0o600});
  console.log('GOVERNANCE_DISAGREEMENT_READONLY',JSON.stringify({
   asOf:report.generatedAt,trades:report.trades,missingDecisions:report.missingDecisionAtEntry,
   overall:report.cohorts.ALL,researchOnly:true,modifiesExecution:false,
  }));
 }finally{await client.end()}
}
module.exports={SQL,FROM,TO,classify,aggregate,md,run};
if(require.main===module)main().catch(e=>{console.error('GOVERNANCE_READONLY_AUDIT_FAILED',String(e.message).slice(0,180));process.exitCode=1});
