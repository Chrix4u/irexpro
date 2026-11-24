'use strict';
/*
 * Exact Pepperstone LIVE account: completed M1, 15-minute hypothetical
 * missed-entry outcomes. READ ONLY and research only; NO order placement,
 * authorization change, strategy promotion or production model rewrite.
 */
const fs=require('node:fs');
const path=require('node:path');

const ROUTES=Object.freeze({
  TREND_CONTINUATION:'M1_TREND_CONTINUATION',
  CONFIRMED_REVERSAL:'M1_CONFIRMED_REVERSAL',
  EARLY_TRANSITION:'M1_EARLY_TRANSITION',
});
const MINUTE=60000;
const HORIZON=15;
const TIMING_VETOES=new Set([
  'MULTIMODEL_CONTINUATION_TIMING_NOT_READY',
  'MULTIMODEL_REVERSAL_NOT_M1_CONFIRMED',
  'MULTIMODEL_EARLY_TRANSITION_NOT_M1_CONFIRMED',
]);

function activeBlockers(row){
  return Array.isArray(row.blockers)
    ? row.blockers.filter(x=>typeof x==='string')
    : [];
}
function timingOnlyBlock(row){
  const blockers=activeBlockers(row);
  return blockers.length>0&&blockers.every(x=>TIMING_VETOES.has(x));
}

function routeClass(row){
  if(row.route==='ABSTAIN')return 'M1_ABSTAIN';
  return ROUTES[row.plan_b_route]===row.route?'EXACT_ROUTE_MATCH':'ROUTE_DISAGREEMENT';
}
function positiveQuotedMinute(r){
  const b=new Date(r.timestamp).getTime(),q=new Date(r.last_quote_sample_at).getTime();
  const open=Number(r.open),close=Number(r.close),
    high=Number(r.high),low=Number(r.low);
  return Number.isFinite(b)&&Number.isFinite(q)&&q>=b&&q<b+MINUTE&&
    Number(r.positive_quote_sample_count)>0&&r.source==='ctrader-broker-native'&&
    open>0&&close>0&&high>0&&low>0&&high>=low&&
    open>=low&&open<=high&&close>=low&&close<=high;
}
function episodeLeaders(rows,{gapMinutes=5}={}){
  const last=new Map(),out=[];
  for(const row of [...rows].sort((a,b)=>new Date(a.evaluated_at)-new Date(b.evaluated_at))){
    if(row.plan_b_admitted!==true&&row.plan_b_admitted!=='true')continue;
    const now=new Date(row.evaluated_at).getTime();
    if(!Number.isFinite(now)||!['BUY','SELL'].includes(row.direction))continue;
    const category=routeClass(row);
    const key=[row.instrument,row.direction,row.plan_b_route,category,row.route].join('|');
    const previous=last.get(key);
    last.set(key,now);
    if(previous!==undefined&&now-previous<=gapMinutes*MINUTE)continue;
    out.push({...row,category});
  }
  return out;
}
function toFinitePositive(x){
  if(x==null||x==='')return null;
  const n=Number(x);return Number.isFinite(n)&&n>0?n:null;
}
function summarize(rows){
  const groups={};
  for(const x of rows){
    const g=groups[x.category]||(groups[x.category]={episodes:0,observed:0,ambiguous:0,unobservable:0,positive:0,negative:0,flat:0,totalNetR:0,netRs:[]});
    g.episodes++;
    if(x.outcome==='AMBIGUOUS'){g.ambiguous++;continue}
    if(x.outcome==='UNOBSERVABLE'){g.unobservable++;continue}
    g.observed++;g.totalNetR+=x.netR;g.netRs.push(x.netR);
    if(x.netR>0)g.positive++;
    else if(x.netR<0)g.negative++;
    else g.flat++;
  }
  return Object.fromEntries(Object.entries(groups).sort().map(([key,g])=>{
    const {netRs,...rest}=g;
    return [key,{...rest,totalNetR:+g.totalNetR.toFixed(4),
      averageNetR:g.observed?+(g.totalNetR/g.observed).toFixed(4):null,
      observedPositiveFraction:g.observed?+(g.positive/g.observed).toFixed(4):null}];
  }));
}
function study(rows,bars,evaluate,cutoff){
  if(typeof evaluate!=='function')throw Error('MISSING_EXISTING_CAUSAL_EVALUATOR');
  const byPair=new Map();
  for(const bar of bars){
    if(!positiveQuotedMinute(bar))continue;
    if(!byPair.has(bar.instrument))byPair.set(bar.instrument,new Map());
    byPair.get(bar.instrument).set(new Date(bar.timestamp).getTime(),bar);
  }
  const episodes=episodeLeaders(rows);
  const outcomes=[];
  for(const row of episodes){
    const t=new Date(row.evaluated_at).getTime();
    const stop=toFinitePositive(row.stop_distance);
    const target=toFinitePositive(row.target_distance);
    const cost=row.estimated_cost_r==null?null:Number(row.estimated_cost_r);
    let result=null;
    const observed=byPair.get(row.instrument)||new Map();
    const future=[];
    for(let i=0;i<HORIZON;i++){
      const bar=observed.get(t+(i+1)*MINUTE);
      if(!bar)break;
      future.push(bar);
    }
    if(Number.isFinite(t)&&t+16*MINUTE<=cutoff&&stop!==null&&target!==null&&
       cost!==null&&Number.isFinite(cost)&&cost>=0&&future.length===HORIZON){
      result=evaluate({
        direction:row.direction,evaluatedAt:new Date(t),
        stopDistance:stop,targetDistance:target,executionCostR:cost,
        bars:future,
      });
    }
    const status=result?.outcome==='AMBIGUOUS'?'AMBIGUOUS':
      Number.isFinite(result?.netRMultiple)?'OBSERVED':'UNOBSERVABLE';
    outcomes.push({
      instrument:row.instrument,direction:row.direction,
      category:row.category,planBRoute:row.plan_b_route,
      m1Route:row.route,m1Reason:row.m1_reason,
      timingOnlyBlock:timingOnlyBlock(row),
      otherBlockers:activeBlockers(row).filter(x=>!TIMING_VETOES.has(x)),
      decisionAt:new Date(t).toISOString(),
      outcome:status,netR:status==='OBSERVED'?result.netRMultiple:null,
    });
  }
  return {
    decisionRows:rows.length,admittedEpisodes:episodes.length,
    quotedM1Minutes:bars.filter(positiveQuotedMinute).length,
    summary:summarize(outcomes),
    byBlockerExclusivity:summarize(outcomes.map(x=>({
      ...x,
      category:x.timingOnlyBlock?'TIMING_ONLY':'OTHER_OR_MIXED_VETOES',
    }))),
    outcomes,
  };
}
async function main(){
  const envPath=process.env.IREXPRO_READONLY_ENV_PATH||path.resolve(__dirname,'../../.env');
  const env=require('dotenv').parse(fs.readFileSync(envPath));
  const {Client}=require('pg');
  const compiled=process.env.IREXPRO_CAUSAL_EVALUATOR_DIST||
    path.resolve(__dirname,'../../dist');
  const {evaluateM1CausalOutcome15m}=require(path.resolve(compiled,'modules/ai/m1-causal-outcome'));
  const configuredOwner=env.VPS_FOREX_SCANNER_USER_ID;
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(configuredOwner||'')){
    throw Error('SCOPED_OWNER_ID_NOT_CONFIGURED');
  }
  const db=new Client({
    host:env.DB_HOST,port:Number(env.DB_PORT||5432),
    database:env.DB_NAME,user:env.DB_USER,password:env.DB_PASSWORD,
    ssl:env.DB_SSL==='true'?{rejectUnauthorized:false}:false,
    connectionTimeoutMillis:5000,statement_timeout:20000,
    application_name:'irexpro_live_planb_m1_outcome_research_ro',
  });
  await db.connect();
  try{
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const connection=await db.query(
      "SELECT id,user_id,account_type,broker_id FROM broker.broker_connections "+
      "WHERE broker_id='pepperstone-ctrader' AND account_type='LIVE' "+
      "AND provider_broker_identity='pepperstone' AND user_id=$1 "+
      "AND deleted_at IS NULL",
      [configuredOwner]
    );
    if(connection.rows.length!==1)throw Error('EXACT_LIVE_ACCOUNT_SCOPE_MISSING');
    const scope=connection.rows[0];
    const time=await db.query('SELECT now() AS snapshot_at');
    const snapshotAt=time.rows[0].snapshot_at;
    const maturedThrough=new Date(new Date(snapshotAt).getTime()-18*MINUTE);
    const since=new Date(Math.max(
      new Date(snapshotAt).getTime()-90*MINUTE,
      new Date('2026-11-24T06:44:00Z').getTime()
    ));
    const query=await db.query(
      "SELECT instrument,direction,route,bar_time,evaluated_at,execution_authority,"+
      "candidate->>'stopDistance' stop_distance,candidate->>'targetDistance' target_distance,"+
      "governance #>> '{genericGovernance,estimatedExecutionCostR}' estimated_cost_r,"+
      "governance #>> '{multimodelEnsemble,strategyRoute}' plan_b_route,"+
      "governance #>> '{multimodelEnsemble,paperAdmitted}' plan_b_admitted,"+
      "governance #>> '{routeDecision,reason}' m1_reason,blockers "+
      "FROM trading.m1_tactical_decisions WHERE user_id=$1 AND broker_connection_id=$2 "+
      "AND evaluated_at>=$3 AND evaluated_at<=$4 "+
      "ORDER BY evaluated_at,created_at LIMIT 1200",
      [scope.user_id,scope.id,since,maturedThrough]
    );
    const quoteRows=await db.query(
      "SELECT instrument,bucket_time AS timestamp,open,high,low,close,source,"+
      "positive_quote_sample_count,last_quote_sample_at "+
      "FROM market_data.provider_quote_candles "+
      "WHERE connection_id=$1 AND timeframe='M1' "+
      "AND bucket_time>=$2 AND bucket_time<=$3 "+
      "ORDER BY instrument,bucket_time",
      [scope.id,new Date(since.getTime()-MINUTE),snapshotAt]
    );
    const results=study(query.rows,quoteRows.rows,evaluateM1CausalOutcome15m,
      new Date(snapshotAt).getTime());
    const report={
      artifact:'pepperstone-live-planb-m1-route-15m-causal-research-v1',
      observedAt:new Date(snapshotAt).toISOString(),
      from:since.toISOString(),maturedThrough:maturedThrough.toISOString(),
      brokerAccount:'Pepperstone LIVE •••6270',
      method:'STRICT_COMPLETED_BROKER_NATIVE_QUOTED_M1_15BAR_OHLC_COUNTERFACTUAL',
      treatment:'Plan-B admitted; compare M1 abstain vs mismatched strategy vs exact route match',
      keyRestriction:'Never infer actual entry, fill, realized P&L or production promotion from this study',
      noOrders:true,noTradingControlChanges:true,noDbChanges:true,
      promotionAuthorized:false,qualificationEvidence:false,
      note:'Episode leaders (five-minute dedup), one hypothetical entry per episode. Only same-minute positive broker quotes qualify as complete M1 bars. A 15-bar fully observed future path is mandatory. Midpoint OHLC cannot prove tick order; same-bar TP/SL is AMBIGUOUS. Costs use decision-time estimatedExecutionCostR, not verified full broker fees. Very short LIVE observation period; selection bias and overlap remain.',
      ...results,
    };
    console.log(JSON.stringify(report,null,2));
    await db.query('ROLLBACK');
  }catch(e){await db.query('ROLLBACK').catch(()=>{});throw e}
  finally{await db.end().catch(()=>{})}
}
if(require.main===module)main().catch(e=>{
  console.error('LIVE_ROUTE_OUTCOME_AUDIT_FAILED',e.code||e.message||'UNKNOWN');process.exitCode=1;
});
module.exports={routeClass,positiveQuotedMinute,episodeLeaders,
  toFinitePositive,activeBlockers,timingOnlyBlock,summarize,study};
