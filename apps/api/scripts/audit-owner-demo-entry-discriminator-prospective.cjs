#!/usr/bin/env node
'use strict';
/**
 * Future, truly unseen broker fills versus the frozen Nov17-18 model.
 * No writes to trading DB or execution. Route-specific false veto costs.
 */
const path=require('node:path'),fs=require('node:fs');
const START='2026-11-20T00:00:00.000Z';
const ARTIFACT='owner-demo-after-fee-entry-discriminator-v1';
const OUTPUT='/home/lightworld/webapps/irexpro-research/entry-formation/prospective-after-fee-scoreboard.json';
function num(v){return v==null||v===''?null:Number.isFinite(+v)?+v:null}
function ms(v){return v==null?null:Number.isFinite(new Date(v).getTime())?new Date(v).getTime():null}
function finiteResult(row){
 const quote=row.decision_shadow;
 if(!quote||quote.artifact!==ARTIFACT||
  quote.status!=='FITTED_SHADOW_UNQUALIFIED'||
  quote.shadowOnly!==true||quote.modifiesExecution!==false||
  quote.grantsTradeAuthority!==false||quote.vetoRecommended!==false||
  !['CONFIRMED_REVERSAL','EARLY_TRANSITION'].includes(quote.route)||
  quote.route!==row.plan_b_route||
  num(quote.probabilityOfAfterFeeWinningTrade)==null||
  num(quote.probabilityOfAfterFeeLosingTrade)==null||
  num(quote.researchLowScoreThreshold)==null||
  typeof quote.researchLowScoreFlag!=='boolean'||!quote.modelVersion||
  ms(row.decision_recorded_at)==null||ms(row.intent_created_at)==null||
  ms(row.opened_at)==null||ms(row.closed_at)==null||
  ms(row.decision_recorded_at)>ms(row.intent_created_at)||
  ms(row.intent_created_at)>ms(row.opened_at)||
  ms(row.closed_at)<ms(row.opened_at)||
  ms(row.closed_at)<=ms(quote.trainingCutoffUtc)||
  ms(row.opened_at)<ms(START))return null;
 const p=num(quote.probabilityOfAfterFeeWinningTrade);
 if(p<0||p>1||Math.abs(p+num(quote.probabilityOfAfterFeeLosingTrade)-1)>.0001)return null;
 const threshold=num(quote.researchLowScoreThreshold);
 if(Math.abs(p-threshold)<1e-5){
  // Scores are rounded to 5 decimals in the decision sidecar. Allow
  // rounding tolerance, never guess at an ambiguous threshold.
  return null;
 }
 if((p<threshold)!==quote.researchLowScoreFlag)return null;
 const gross=num(row.realised_pnl),fee=num(row.commission),swap=num(row.swap),
  lot=num(row.lot_size);
 if(gross==null||fee==null||swap==null||lot==null||lot<=0)return null;
 const net=Number((gross+fee+swap).toFixed(2));
 return {route:quote.route,day:new Date(row.opened_at).toISOString().slice(0,10),
  instrument:row.instrument,side:row.direction,
  score:p,lowScore:quote.researchLowScoreFlag,netUsd:net,
  netUsdPerLot:Number((net/lot).toFixed(2)),
  win:net>0,loss:net<0,modelVersion:quote.modelVersion};
}
function summarize(rows) {
 const byLow=rows.filter(r=>r.lowScore),kept=rows.filter(r=>!r.lowScore);
 const count=(a)=>({trades:a.length,wins:a.filter(r=>r.win).length,
  losses:a.filter(r=>r.loss).length,
  netUsd:Number(a.reduce((s,r)=>s+r.netUsd,0).toFixed(2)),
  netUsdPerLot:Number(a.reduce((s,r)=>s+r.netUsdPerLot,0).toFixed(2))});
 const winnerScores=rows.filter(r=>r.win).map(r=>r.score);
 const loserScores=rows.filter(r=>r.loss).map(r=>r.score);
 let auc=null;
 if(winnerScores.length&&loserScores.length) {
  let correct=0;
  for(const w of winnerScores)for(const l of loserScores)correct+=w>l?1:w===l?.5:0;
  auc=Number((correct/(winnerScores.length*loserScores.length)).toFixed(4));
 }
 const days=new Set(rows.map(r=>r.day)).size;
 const outcome={
  byRoute:rows[0]?.route||'NONE',observedDays:days,
  all:count(rows),belowTrainingQuartile:count(byLow),aboveTrainingQuartile:count(kept),
  winRankingAuc:auc,
  hypotheticalNetChangeUsd:Number((-byLow.reduce((s,r)=>s+r.netUsd,0)).toFixed(2)),
  prospectiveEligibility:days>=5&&rows.length>=30&&winnerScores.length>=8&&loserScores.length>=8
   ?'REVIEW_FUTURE_MODEL_EVIDENCE':'SPARSE_PROSPECTIVE_DATA',
  changesExecution:false,grantsTradeAuthority:false,
 };
 return outcome;
}
function buildScoreboard(rows,asOf) {
 const evaluated=rows.map(finiteResult);
 const valid=evaluated.filter(Boolean);
 const routes=['CONFIRMED_REVERSAL','EARLY_TRANSITION','TREND_CONTINUATION'];
 return {
  artifact:'owner-demo-entry-outcome-prospective-settled-scoreboard-v1',
  observedAt:new Date(asOf).toISOString(),fromUtc:START,
  trainingCohortExcluded:true,
  observedClosedTrades:rows.length,
  validFrozenPreOrderScores:valid.length,
  missingOrUnverifiedScores:rows.length-valid.length,
  routes:routes.map(route=>summarize(valid.filter(r=>r.route===route))),
  modifiesExecution:false,grantsTradeAuthority:false,
  disclaimer:[
   'Only settled broker USD DEMO trades with an unchanged frozen score recorded BEFORE trade intent count.',
   'A proposed avoidance rule would discard winners as well as losses; report both.',
   'True prospective evidence needs at least several distinct market days; 30 fills is not automatic trading permission.',
   'No unfilled signal or shadow candle outcome is called a broker profit.',
  ],
 };
}
async function main(){
 require('dotenv').config({path:path.resolve(__dirname,'../.env'),quiet:true});
 const owner=process.env.VPS_FOREX_SCANNER_USER_ID;
 if(!/^[0-9a-f-]{36}$/i.test(owner||''))throw Error('OWNER_SCOPE_REQUIRED');
 const {Client}=require('pg'),db=new Client({
  host:process.env.DB_HOST||'localhost',
  port:Number(process.env.DB_PORT||5432),user:process.env.DB_USER,password:process.env.DB_PASSWORD,
  database:process.env.DB_NAME,ssl:process.env.DB_SSL==='true'?{rejectUnauthorized:false}:undefined,
  connectionTimeoutMillis:6500,statement_timeout:13000});
 await db.connect();
 let rows=[];
 try{
  await db.query('BEGIN READ ONLY');
  rows=(await db.query([
   'SELECT t.id,t.instrument,t.direction,t.lot_size,t.opened_at,t.closed_at,',
   't.realised_pnl,t.commission,t.swap,ti.created_at AS intent_created_at,',
   'd.created_at AS decision_recorded_at,',
   "ti.metadata->>'multimodel_plan_b_route' AS plan_b_route,",
   "d.governance->'ownerDemoEntryOutcomeShadow' AS decision_shadow",
   'FROM trading.trades t',
   'JOIN broker.broker_connections b ON b.id=t.broker_connection_id AND b.user_id=t.user_id',
   'JOIN trading.trade_intents ti ON ti.id=t.trade_intent_id AND ti.user_id=t.user_id',
   'AND ti.broker_connection_id=t.broker_connection_id',
   'LEFT JOIN trading.m1_tactical_decisions d ON d.id=',
   "CASE WHEN ti.metadata->>'m1_decision_id' ~ '^[0-9a-f-]{36}$'",
   "THEN (ti.metadata->>'m1_decision_id')::uuid END",
   'AND d.user_id=t.user_id AND d.broker_connection_id=t.broker_connection_id',
   'WHERE t.user_id=$1 AND b.user_id=$1',
   "AND b.broker_id='pepperstone-ctrader' AND b.account_type='DEMO'",
   "AND b.account_currency='USD' AND t.status='CLOSED'",
   'AND t.opened_at >= $2::timestamptz',
   'ORDER BY t.opened_at ASC,t.id ASC LIMIT 1001',
  ].join(' '),[owner,START])).rows;
  await db.query('ROLLBACK');
 } finally{await db.end()}
 if(rows.length>1000)throw Error('TRADES_TRUNCATED');
 const result=buildScoreboard(rows,new Date());
 fs.mkdirSync(path.dirname(OUTPUT),{recursive:true,mode:0o700});
 fs.writeFileSync(OUTPUT,JSON.stringify(result,null,2),{mode:0o600});
 console.log('PROSPECTIVE_ENTRY_SCOREBOARD',JSON.stringify(result));
}
module.exports={finiteResult,summarize,buildScoreboard};
if(require.main===module)main().catch(e=>{
 console.error('PROSPECTIVE_SCOREBOARD_FAILED',e.message);process.exitCode=1;
});
