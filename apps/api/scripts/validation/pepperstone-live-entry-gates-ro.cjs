'use strict';
/** No write operations, no broker requests, exact LIVE account-scoped. */
const fs=require('node:fs'),path=require('node:path');
function normalizeBlockers(x){
  if(Array.isArray(x))return x.filter(k=>typeof k==='string').slice(0,40);
  if(typeof x==='string'){try{return normalizeBlockers(JSON.parse(x))}catch{}}
  return [];
}
function tally(items){
  const m=new Map();for(const v of items)m.set(v,(m.get(v)||0)+1);
  return Object.fromEntries([...m].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])));
}
function summarizeLiveEntryDecisions(rows,{countOrders=0}={}){
  let admitted=0,qualified=0,both=0,matching=0,authorized=0,paper=0,primary=0,bridges=0,lateGateFailures=0;
  const reasons=[],blocks=[],outcomes=[],latest=new Map();
  for(const r of rows){
    const a=r.plan_b_admitted===true||r.plan_b_admitted==='true',q=r.route&&r.route!=='ABSTAIN';
    const expected={
      TREND_CONTINUATION:'M1_TREND_CONTINUATION',
      CONFIRMED_REVERSAL:'M1_CONFIRMED_REVERSAL',
      EARLY_TRANSITION:'M1_EARLY_TRANSITION',
    }[r.plan_b_route];
    const match=expected!==undefined&&expected===r.route;
    if(a)admitted++;
    if(q)qualified++;
    if(a&&q)both++;
    if(a&&q&&match)matching++;
    // Use the independently persisted Plan-B/M1 primary authority verdict,
    // not just similarities between the strategy labels.
    const primaryAuthorized=a&&r.primary_authority==='PRIMARY_PLAN_B';
    if(primaryAuthorized)primary++;
    if(primaryAuthorized&&r.plan_b_route==='CONFIRMED_REVERSAL'&&
       (r.route==='M1_EARLY_TRANSITION'||
        (r.route==='M1_TREND_CONTINUATION'&&r.reversal_bridge==='true')))bridges++;
    if(r.execution_authority==='BROKER_NATIVE')authorized++;
    if(r.execution_authority==='BROKER_NATIVE'&&
      ['SIGNAL_INVALID','RISK_REJECTED','EXECUTION_REJECTED'].includes(r.outcome_state))lateGateFailures++;
    if(r.execution_authority==='PAPER_ONLY_RESEARCH')paper++;
    reasons.push(r.m1_reason||'UNKNOWN');
    blocks.push(...normalizeBlockers(r.blockers));
    if(r.outcome_state)outcomes.push(r.outcome_state);
    const key=(r.instrument||'')+':'+(r.direction||'');
    if(!latest.has(key))latest.set(key,{
      instrument:r.instrument,direction:r.direction,route:r.route,
      reason:r.m1_reason||null,planBAdmitted:a,planBRoute:r.plan_b_route||null,exactRouteMatch:!!match,
      primaryModelAuthority:r.primary_authority||null,
      reversalTimingBridge:r.reversal_bridge==='true',
      executionAuthority:r.execution_authority,asOf:r.bar_time,
      outcomeState:r.outcome_state||null,
      outcomeReason:typeof r.outcome_reason==='string'?r.outcome_reason.slice(0,220):null,
      blockers:normalizeBlockers(r.blockers).slice(0,8),
    });
  }
  return {
    decisionRows:rows.length,planBAdmitted:admitted,
    m1RouteQualified:qualified,admittedWithAnyM1Route:both,exactModelM1RouteMatch:matching,
    primaryModelAuthorityGranted:primary,primaryReversalTimingBridges:bridges,
    brokerNativeAuthorityGranted:authorized,brokerAuthorizedButRejected:lateGateFailures,
    paperOnlyResearch:paper,
    recordedLiveOrders:countOrders,
    assessment:rows.length===0?'NO_RECENT_LIVE_DECISIONS':
      lateGateFailures>0?'BROKER_AUTHORIZED_DECISION_FAILED_LATER_GATE':
      authorized>0&&countOrders===0?'AUTHORIZED_DECISION_REQUIRES_ORDER_PATH_REVIEW':
      authorized>0?'BROKER_AUTHORIZED_DECISIONS_EXIST':
      'NO_BROKER_AUTHORIZED_ENTRY_IN_WINDOW',
    m1Reasons:tally(reasons),topBlockers:tally(blocks),outcomes:tally(outcomes),
    latestByPair:[...latest.values()].sort((a,b)=>a.instrument.localeCompare(b.instrument)||a.direction.localeCompare(b.direction))
  };
}
function parseSinceArgument(args,now=Date.now()){
  if(args.length>1)throw Error('EXPECTED_AT_MOST_ONE_--since=UTC_TIMESTAMP');
  if(args.length===0)return null;
  if(!args[0].startsWith('--since='))throw Error('UNKNOWN_READ_ONLY_ARGUMENT');
  const input=args[0].slice('--since='.length);
  if(!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(input))throw Error('SINCE_REQUIRES_FULL_UTC_ISO_TIME');
  const parsed=Date.parse(input);
  if(!Number.isFinite(parsed)||parsed>now||now-parsed>2*60*60*1000)throw Error('SINCE_OUTSIDE_READONLY_TWO_HOUR_WINDOW');
  return new Date(parsed);
}
async function main(){
  const since=parseSinceArgument(process.argv.slice(2));
  const envFile=process.env.IREXPRO_READONLY_ENV_PATH||path.resolve(__dirname,'../../.env');
  const env=require('dotenv').parse(fs.readFileSync(envFile));
  const {Client}=require('pg');
  const db=new Client({
    host:env.DB_HOST,port:Number(env.DB_PORT||5432),
    database:env.DB_NAME,user:env.DB_USER,password:env.DB_PASSWORD,
    ssl:env.DB_SSL==='true'?{rejectUnauthorized:false}:false,
    connectionTimeoutMillis:4000,statement_timeout:8000,
    application_name:'irexpro_pepperstone_live_entry_gate_audit_readonly',
  });
  const configuredOwner=env.VPS_FOREX_SCANNER_USER_ID;
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(configuredOwner||'')){
    throw Error('SCOPED_OWNER_ID_NOT_CONFIGURED');
  }
  await db.connect();
  try{
    await db.query('BEGIN READ ONLY');
    const b=await db.query(
      "SELECT id,user_id,status,authorization_status,live_trading_enabled "+
      "FROM broker.broker_connections WHERE broker_id='pepperstone-ctrader' "+
      "AND account_type='LIVE' AND user_id=$1 "+
      "AND provider_broker_identity='pepperstone' AND deleted_at IS NULL",
      [configuredOwner]
    );
    if(b.rows.length!==1)throw Error('EXACT_LIVE_ACCOUNT_BINDING_NOT_UNIQUE');
    const owner=b.rows[0],params=[owner.id,owner.user_id];
    const s=await db.query(
      'SELECT status,execution_mode,started_at FROM trading.trading_sessions '+
      'WHERE broker_connection_id=$1 AND user_id=$2 ORDER BY started_at DESC LIMIT 1',params);
    const decisions=await db.query(
      "SELECT bar_time,instrument,direction,route,execution_authority,blockers,"+
      "governance->'routeDecision'->>'reason' m1_reason,"+
      "governance->'multimodelEnsemble'->>'paperAdmitted' plan_b_admitted,"+
      "governance->'multimodelEnsemble'->>'strategyRoute' plan_b_route,"+
      "governance->'multimodelAuthority'->>'authorityPath' primary_authority,"+
      "governance->'multimodelAuthority'->>'reversalTimingBridge' reversal_bridge,"+
      "outcome_state,outcome_reason "+
      "FROM trading.m1_tactical_decisions "+
      "WHERE broker_connection_id=$1 AND user_id=$2 "+
      "AND evaluated_at>=$3 "+
      "ORDER BY evaluated_at DESC,created_at DESC LIMIT 1501",
      [...params,since||new Date(Date.now()-30*60*1000)]);
    const orders=await db.query(
      'SELECT status,count(*)::int n FROM trading.orders '+
      'WHERE broker_connection_id=$1 GROUP BY status',[owner.id]);
    let shadowType='NOT_CONFIGURED';
    if(env.MULTIMODEL_BROKER_EXPERT_SOURCE_CONNECTION_ID){
      const x=await db.query(
        'SELECT account_type FROM broker.broker_connections '+
        'WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL',
        [env.MULTIMODEL_BROKER_EXPERT_SOURCE_CONNECTION_ID,owner.user_id]);
      shadowType=x.rows[0]?.account_type||'UNAVAILABLE';
    }
    if(decisions.rows.length>1500)throw Error('READ_ONLY_DECISION_WINDOW_TRUNCATED_USE_NARROWER_--since');
    const statuses=orders.rows.map(x=>({status:x.status,count:x.n}));
    console.log(JSON.stringify({
      check:'PEPPERSTONE_LIVE_ENTRY_FUNNEL_READ_ONLY',
      checkedAt:new Date().toISOString(),account:'LIVE •••6270',
      connected:owner.status==='CONNECTED',
      liveEnabled:owner.authorization_status==='ACTIVE'&&owner.live_trading_enabled,
      currentSession:s.rows[0]||null,
      decisionWindowSince:(since||new Date(Date.now()-30*60*1000)).toISOString(),
      last30Minutes:summarizeLiveEntryDecisions(decisions.rows,{
        countOrders:statuses.reduce((n,x)=>n+x.count,0)}),
      liveOrdersByStatus:statuses,
      separateLegacyShadowExpert:{
        accountType:shadowType,distinctFromLive:
          env.MULTIMODEL_BROKER_EXPERT_SOURCE_CONNECTION_ID!==owner.id,
        executionAuthority:false,
      },
      readsOnly:true,brokerOrdersSent:0,changesToTradingControls:0
    },null,2));
    await db.query('ROLLBACK');
  }catch(e){await db.query('ROLLBACK').catch(()=>{});throw e}
  finally{await db.end().catch(()=>{})}
}
if(require.main===module)main().catch(e=>{
  console.error('LIVE_ENTRY_AUDIT_FAILED',e.code||e.message||'UNKNOWN');process.exitCode=1;
});
module.exports={summarizeLiveEntryDecisions,normalizeBlockers,parseSinceArgument};
