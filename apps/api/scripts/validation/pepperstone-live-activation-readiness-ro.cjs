'use strict';
/**
 * READ ONLY owner Pepperstone LIVE activation diagnosis. Makes no provider
 * connection, broker orders, authorisation changes, or database writes.
 * IMPORTANT: this report CANNOT certify LIVE execution; only the real-money
 * end-to-end harness with durable operator evidence can establish that.
 */
const fs=require('node:fs');const path=require('node:path');
const {Client}=require('pg');const dotenv=require('dotenv');
const root=path.resolve(__dirname,'../..');
const env=dotenv.parse(fs.readFileSync(process.env.IREXPRO_LIVE_READINESS_DOTENV_PATH||path.join(root,'.env')));
const db=new Client({host:env.DB_HOST,port:Number(env.DB_PORT||5432),
  database:env.DB_NAME,user:env.DB_USER,password:env.DB_PASSWORD,
  ssl:env.DB_SSL==='true'?{rejectUnauthorized:false}:false,
  connectionTimeoutMillis:5000,statement_timeout:8000,
  application_name:'irexpro_pepperstone_live_activation_readiness_ro'});
const output={artifact:'pepperstone-live-account-readiness-diagnostic-v1',
  broker:'pepperstone-ctrader',executionPermissionChanged:false,
  realBrokerOrdersSent:false,accountIdsReturned:false,
  providerLiveCertification:'NOT_CERTIFIED',
  brokerAccountLinked:false,accountAuthorization:null,
  automatedLiveEnabled:false,liveBrokerEquityUsd:null,
  liveBrokerFreeMarginUsd:null,providerSnapshotAgeSeconds:null,
  liveOpenPositions:null,latestReconciliation:null,
  activeAiSessions:null,activeDemoSessions:null,activeLiveSessions:null,
  warnings:[],demoValidated:false,
  platformOAuthCredentialsConfigured:false,
  savedOAuthTradingScope:'NOT_INDEPENDENTLY_ATTESTED',
  canaryPlaceStopCloseReconcileEvidence:'NOT_FOUND',
  blockers:[],recommendation:'NO_LIVE_EXECUTION_UNTIL_CERTIFIED'};
(async()=>{
  output.platformOAuthCredentialsConfigured=Boolean(env.CTRADER_CLIENT_ID&&env.CTRADER_CLIENT_SECRET);
  if(!output.platformOAuthCredentialsConfigured)output.blockers.push('PLATFORM_OAUTH_APP_NOT_CONFIGURED');
  await db.connect();await db.query('BEGIN READ ONLY');
  try {
    const r=await db.query(`SELECT b.id,b.account_type,b.status,b.authorization_status,
        b.live_trading_enabled,b.demo_validated,b.account_currency,
        b.provider_broker_identity IS NOT NULL AS has_provider_identity,
        a.equity::text AS equity,a.free_margin::text AS free_margin,
        a.open_positions_count,a.synced_at
      FROM broker.broker_connections b
      LEFT JOIN broker.broker_accounts a ON a.broker_connection_id=b.id
      WHERE b.broker_id='pepperstone-ctrader' AND b.deleted_at IS NULL
      ORDER BY b.account_type`);
    const live=r.rows.filter(x=>x.account_type==='LIVE');
    const demo=r.rows.filter(x=>x.account_type==='DEMO');
    if(live.length!==1)output.blockers.push('EXACTLY_ONE_LIVE_CONNECTION_REQUIRED');
    else{
      const a=live[0];
      output.brokerAccountLinked=a.status==='CONNECTED'&&a.account_currency==='USD'&&a.has_provider_identity===true;
      output.accountAuthorization=a.authorization_status;
      output.automatedLiveEnabled=a.live_trading_enabled===true;
      output.liveBrokerEquityUsd=a.equity==null?null:Number(a.equity).toFixed(2);
      output.liveBrokerFreeMarginUsd=a.free_margin==null?null:Number(a.free_margin).toFixed(2);
      output.liveOpenPositions=a.open_positions_count;
      output.providerSnapshotAgeSeconds=a.synced_at?Math.round((Date.now()-new Date(a.synced_at).getTime())/1000):null;
      if(!output.brokerAccountLinked)output.blockers.push('LIVE_CONNECTION_IDENTITY_NOT_PROVEN');
      if(a.live_trading_enabled===true)output.blockers.push('LIVE_ALREADY_ENABLED_WITHOUT_THIS_DIAGNOSTIC_CERTIFICATION');
      if(!Number.isFinite(Number(a.equity))||Number(a.equity)<=0)output.blockers.push('LIVE_EQUITY_NOT_PROVEN');
      if(!Number.isFinite(Number(a.free_margin))||Number(a.free_margin)<=0)output.blockers.push('LIVE_FREE_MARGIN_NOT_PROVEN');
      if(!Number.isFinite(output.providerSnapshotAgeSeconds)||output.providerSnapshotAgeSeconds<0||output.providerSnapshotAgeSeconds>180)output.blockers.push('LIVE_ACCOUNT_SNAPSHOT_STALE');
      if(a.open_positions_count!==0)output.blockers.push('LIVE_ACCOUNT_NOT_FLAT');
      const recon=await db.query(`SELECT status,completed_at,provider_orders_seen,provider_positions_seen,errors,discrepancies_open
        FROM reconciliation.runs WHERE broker_connection_id=$1 ORDER BY created_at DESC LIMIT 1`,[a.id]);
      if(recon.rows.length){const x=recon.rows[0];output.latestReconciliation={status:x.status,
        ageSeconds:x.completed_at?Math.round((Date.now()-new Date(x.completed_at).getTime())/1000):null,
        orders:x.provider_orders_seen,positions:x.provider_positions_seen,
        errors:x.errors,openDiscrepancies:x.discrepancies_open};
        if(x.status!=='COMPLETED'||Number(x.errors)>0||Number(x.discrepancies_open)>0)output.blockers.push('LIVE_RECONCILIATION_UNPROVEN');
      }else output.blockers.push('LIVE_RECONCILIATION_NOT_PRESENT');
    }
    output.demoValidated=demo.length===1&&demo[0].demo_validated===true&&demo[0].status==='CONNECTED';
    if(!output.demoValidated)output.blockers.push('PEPPERSTONE_DEMO_NOT_VALIDATED');
    const sessions=await db.query(`SELECT COUNT(*)::int AS n,
      COUNT(*) FILTER(WHERE b.account_type='DEMO')::int AS demo,
      COUNT(*) FILTER(WHERE b.account_type='LIVE')::int AS live
      FROM trading.trading_sessions s JOIN broker.broker_connections b
       ON b.id=s.broker_connection_id WHERE s.status='ACTIVE'`);
    output.activeAiSessions=sessions.rows[0]?.n??null;
    output.activeDemoSessions=sessions.rows[0]?.demo??null;
    output.activeLiveSessions=sessions.rows[0]?.live??null;
    if(output.activeDemoSessions>0)output.warnings.push('DEMO_SESSION_ACTIVE_DO_NOT_INTERRUPT_FOR_DEPLOYMENT');
    if(output.activeLiveSessions>0 && !output.automatedLiveEnabled)
      output.blockers.push('UNAUTHORIZED_ACTIVE_LIVE_SESSION_REQUIRES_RECONCILIATION');
  }finally{await db.query('ROLLBACK').catch(()=>{});await db.end();}
  // This is not optional: OAuth linking and account readback never prove a
  // real-money order can be stopped, closed and reconciled. Even a clean
  // broker snapshot MUST still report this explicit certification blocker.
  output.blockers.push('REAL_LIVE_CANARY_ORDER_STOP_EXIT_RECONCILIATION_NOT_CERTIFIED');
  console.log(JSON.stringify(output,null,2));
})().catch(err=>{
  output.blockers.push('READ_ONLY_DIAGNOSTIC_FAILED');
  console.log(JSON.stringify(output,null,2));
  process.exitCode=1;
});
