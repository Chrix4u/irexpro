#!/usr/bin/env node
'use strict';
const {publishTextArtifact}=require('./publish-text-artifact.cjs');
/**
 * Owner Pepperstone USD DEMO AFTER-FEE route classifier.
 * Training Nov 17-18; later-day Nov 19 evaluation only.
 * Fits 7 causal fields, writes a pure research artifact and a TS frozen model.
 * No broker actions or modifications to trading policy.
 */
const path=require('node:path'),fs=require('node:fs'),crypto=require('node:crypto');
require('ts-node/register/transpile-only');
const {
 ENTRY_OUTCOME_FEATURES,encodeEntryOutcomeFeatures,entryOutcomeWinProbability,
 fingerprintOwnerDemoEntryBroker,
}=require('../src/modules/ai/owner-demo-entry-outcome-shadow.ts');
const {
 SQL,normalize
}=require('./audit-owner-demo-win-loss-formation.cjs');
const TRAIN_END='2026-11-19T00:00:00.000Z';
const RESEARCH='/home/lightworld/webapps/irexpro-research/entry-formation/route-classifier-training.json';
const GENERATED=path.resolve(__dirname,'../src/modules/ai/owner-demo-entry-outcome-model.generated.ts');
const ROUTES=['CONFIRMED_REVERSAL','EARLY_TRANSITION','TREND_CONTINUATION'];
function vector(row) {
 const e=row.entry;
 if(!row.matchedDecision||!e)return null;
 return encodeEntryOutcomeFeatures({
  alignedM5:e.alignedM5,m5Body:e.m5Body,
  alignedH1:e.alignedH1,alignedH4:e.alignedH4,
  alignedM1Momentum3:e.alignedM1Momentum3,
  planBScore:e.planBScore,forecastNetR:e.forecastNetR,
 });
}
function sigmoid(z){const c=Math.max(-30,Math.min(30,z));return 1/(1+Math.exp(-c))}
function fitLogistic(rows){
 if(rows.length<24) return null;
 const wins=rows.filter(x=>x.label==='WIN').length;
 const losses=rows.filter(x=>x.label==='LOSS').length;
 if(wins<8||losses<8)return null;
 const dim=ENTRY_OUTCOME_FEATURES.length,coefs=Array(dim).fill(0);
 let intercept=Math.log((wins+2)/(losses+2));
 const learningRate=.22,penalty=.42;
 // Strong regularization: small DEMO samples, highly correlated signals.
 for(let step=0;step<700;step++){
  const derivatives=Array(dim).fill(0);let interceptDerivative=0;
  for(const row of rows){
   const y=row.label==='WIN'?1:0;
   const z=ENTRY_OUTCOME_FEATURES.reduce(
    (v,k,j)=>v+coefs[j]*row.features[k],intercept);
   const err=sigmoid(z)-y;
   interceptDerivative+=err;
   ENTRY_OUTCOME_FEATURES.forEach((k,j)=>{derivatives[j]+=err*row.features[k]});
  }
  intercept-=learningRate*interceptDerivative/rows.length;
  ENTRY_OUTCOME_FEATURES.forEach((k,j)=>{
    coefs[j]-=learningRate*(derivatives[j]/rows.length+penalty*coefs[j]);
  });
 }
 const version=crypto.createHash('sha256').update(JSON.stringify({coefs,intercept,TRAIN_END})).digest('hex').slice(0,12);
 return {samples:rows.length,wins,losses,
  coefficients:coefs.map(x=>Number(x.toFixed(8))),
  intercept:Number(intercept.toFixed(8)),
  modelVersion:'owner-entry-discriminator-'+version};
}
function probability(row,model){
 return model?entryOutcomeWinProbability(row.features,model):null;
}
function auc(rows,model){
 if(!model)return null;
 const good=rows.filter(x=>x.label==='WIN').map(x=>probability(x,model));
 const bad=rows.filter(x=>x.label==='LOSS').map(x=>probability(x,model));
 if(!good.length||!bad.length)return null;
 let correct=0;
 for(const a of good)for(const b of bad)correct+=a>b?1:a===b?.5:0;
 return Number((correct/(good.length*bad.length)).toFixed(4));
}
function payoff(rows){
 return {count:rows.length,wins:rows.filter(x=>x.label==='WIN').length,
  losses:rows.filter(x=>x.label==='LOSS').length,
  netUsd:Number(rows.reduce((a,b)=>a+b.netUsd,0).toFixed(2)),
  netUsdPerLot:Number(rows.reduce((a,b)=>a+b.netUsdPerLot,0).toFixed(2))};
}
function validation(rows,model,training){
 if(!model)return {status:'INSUFFICIENT_ROUTE_TRAINING',train:payoff(training),later:payoff(rows)};
 const trainingScores=training.map(x=>probability(x,model)).sort((a,b)=>a-b);
 // Predetermine lowest quartile by the training observations alone; never
 // tune the cutoff to make a winning Nov 19 result.
 const cutoff=trainingScores[Math.max(0,Math.floor(trainingScores.length*.25)-1)];
 const withheld=rows.filter(x=>probability(x,model)<=cutoff);
 const kept=rows.filter(x=>probability(x,model)>cutoff);
 const output={
  status:'RETROSPECTIVE_SHADOW_ONLY',
  train:payoff(training),later:payoff(rows),trainingAuc:auc(training,model),
  laterAuc:auc(rows,model),frozenTrainQuartileCutoff:Number(cutoff.toFixed(5)),
  heldOutIfSkipped:payoff(withheld),keptIfSkipped:payoff(kept),
  hypotheticalNetChangeUsd:Number((-withheld.reduce((a,b)=>a+b.netUsd,0)).toFixed(2)),
  winningEntriesThatWouldBeLost:withheld.filter(x=>x.label==='WIN').length,
  losingEntriesPotentiallyAvoided:withheld.filter(x=>x.label==='LOSS').length,
  noVetoAuthorized:true,
 };
 return output;
}
function buildTrainingResult(records,brokerConnectionFingerprint){
 if(typeof brokerConnectionFingerprint!=='string'||brokerConnectionFingerprint.length!==64)
  throw Error('BROKER_CONNECTION_FINGERPRINT_REQUIRED');
 const valid=records.filter(x=>x.matchedDecision&&['WIN','LOSS'].includes(x.label))
  .map(x=>({...x,features:vector(x)}))
  .filter(x=>x.features!=null);
 // At training cutoff all training trades must have actually SETTLED.
 const training=valid.filter(x=>x.openedAt<TRAIN_END&&x.closedAt<TRAIN_END);
 const later=valid.filter(x=>x.openedAt>=TRAIN_END&&x.closedAt< '2026-11-20T00:00:00.000Z');
 const routes={},report={};
 for(const route of ROUTES){
  const train=training.filter(x=>x.entryRoute===route);
  const test=later.filter(x=>x.entryRoute===route);
  const model=fitLogistic(train);
  if(model){
   const sorted=train.map(x=>probability(x,model)).sort((a,b)=>a-b);
   model.researchLowScoreThreshold=Number(sorted[Math.max(0,Math.floor(sorted.length*.25)-1)].toFixed(8));
   routes[route]=model;
  }
  report[route]=validation(test,model,train);
 }
 const artifact={
  artifact:'owner-demo-after-fee-entry-discriminator-v1',
  trainingCutoffUtc:TRAIN_END,
  source:'EXACT_OWNER_BROKER_SETTLED_AFTER_FEE_FILLS',
  brokerConnectionFingerprint,
  status:'RESEARCH_ONLY',routes,
 };
 return {artifact,report,
  population:{allRows:records.length,valid:valid.length,
    training:payoff(training),later:payoff(later),
    trainLastResolvedAt:training.reduce((a,b)=>a>b.closedAt?a:b.closedAt,''),
    firstEvaluationOpenedAt:later.reduce((a,b)=>a<b.openedAt?a:b.openedAt,'9999')},
  noExecutionAuthority:true,
  prospectiveQualification:'NOT_PROSPECTIVELY_QUALIFIED',
  selectionBias:'TRAINED_ON_EXECUTED_FILLS_ONLY',
  disclaimer:'Nov19 already reviewed; not a pristine holdout; actual commission and swap included only in labels.'};
}
function generatedSource(artifact){
 return [
  "import type { FittedEntryOutcomeArtifact } from './owner-demo-entry-outcome-shadow';",
  '/** GENERATED by train-owner-demo-entry-outcome-shadow.cjs. Research only. */',
  'export const OWNER_DEMO_ENTRY_OUTCOME_FITTED: FittedEntryOutcomeArtifact =',
  JSON.stringify(artifact,null,2)+';',
  '',
 ].join('\n');
}
async function main(){
 require('dotenv').config({path:path.resolve(__dirname,'../.env'),quiet:true});
 const owner=process.env.VPS_FOREX_SCANNER_USER_ID;
 if(!/^[0-9a-f-]{36}$/i.test(owner||''))throw Error('OWNER_SCOPE_REQUIRED');
 const {Client}=require('pg');
 const db=new Client({host:process.env.DB_HOST||'localhost',
  port:Number(process.env.DB_PORT||5432),user:process.env.DB_USER,
  password:process.env.DB_PASSWORD,database:process.env.DB_NAME,
  ssl:process.env.DB_SSL==='true'?{rejectUnauthorized:false}:undefined,
  connectionTimeoutMillis:7500,statement_timeout:22000});
 await db.connect();
 let records=[];let verifiedBrokerConnectionId=null;
 try {
  await db.query('BEGIN READ ONLY');
  const result=await db.query(SQL,[owner,'pepperstone-ctrader',
    '2026-11-17T00:00:00Z','2026-11-20T00:00:00Z']);
  if(result.rows.length>800)throw Error('SOURCE_TRUNCATED');
  records=result.rows.map(normalize);
  const brokerConnections=(await db.query([
   'SELECT DISTINCT t.broker_connection_id FROM trading.trades t',
   'JOIN broker.broker_connections b ON b.id=t.broker_connection_id',
   'AND b.user_id=t.user_id',
   "WHERE t.user_id=$1 AND b.broker_id='pepperstone-ctrader'",
   "AND b.account_type='DEMO' AND b.account_currency='USD'",
   "AND t.status='CLOSED' AND t.opened_at >= $2::timestamptz",
   'AND t.opened_at < $3::timestamptz',
  ].join(' '),[owner,'2026-11-17T00:00:00Z','2026-11-20T00:00:00Z'])).rows;
  if(brokerConnections.length!==1)throw Error('TRAINING_ACCOUNT_NOT_UNIQUE');
  verifiedBrokerConnectionId=brokerConnections[0].broker_connection_id;
  await db.query('ROLLBACK');
 } finally {await db.end()}
 const built=buildTrainingResult(records,fingerprintOwnerDemoEntryBroker(verifiedBrokerConnectionId));
 if(built.population.training.count<40||built.population.later.count<20)
  throw Error('LACKS_TRAIN_AND_LATER_DAY_COVERAGE');
 const content=generatedSource(built.artifact);
 fs.mkdirSync(path.dirname(RESEARCH),{recursive:true,mode:0o700});
 fs.writeFileSync(RESEARCH,JSON.stringify(built,null,2),{mode:0o600});
 const oldExists=publishTextArtifact(GENERATED,content);
 console.log('ENTRY_OUTCOME_TRAINING',JSON.stringify({
  summary:built.population,trainValidation:built.report,
  fittedRoutes:Object.keys(built.artifact.routes),
  output:RESEARCH,modelSource:GENERATED,
  overWrotePriorResearchModel:oldExists,
 }).slice(0,23000));
}
module.exports={vector,fitLogistic,auc,payoff,validation,buildTrainingResult,generatedSource};
if(require.main===module)main().catch(e=>{
 console.error('OWNER_DEMO_TRAINING_FAILED',e.message);
 process.exitCode=1;
});
