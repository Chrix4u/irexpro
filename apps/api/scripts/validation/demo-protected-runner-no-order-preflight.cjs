'use strict';
/** Owner Pepperstone USD DEMO read-only UAT readiness. No order APIs. */
const fs=require('node:fs');
const path=require('node:path');
const {Client}=require('pg');
const dotenv=require('dotenv');
const root=path.resolve(__dirname,'../..');
const env=dotenv.parse(fs.readFileSync(process.env.IREXPRO_PREFLIGHT_DOTENV_PATH || path.join(root,'.env')));
const dist=process.env.IREXPRO_PREFLIGHT_DIST_ROOT || path.join(root,'dist');
const fromDist=(p)=>require(path.join(dist,p));
const {
  CredentialEncryptionService,
}=fromDist('modules/broker/services/credential-encryption.service');
const {CTraderClientService}=fromDist('modules/broker/adapters/ctrader/ctrader-client.service');
const {CTraderAdapter}=fromDist('modules/broker/adapters/ctrader/ctrader.adapter');
const {BrokerMode}=fromDist('modules/broker/interfaces/broker-adapter.interface');
const {ConfigService}=require('@nestjs/config');
const switches=[
  'IREXPRO_PEPPERSTONE_DEMO_PROTECTED_RUNNER_EXECUTION',
  'IREXPRO_PEPPERSTONE_DEMO_PROTECTED_RUNNER_AMEND',
  'IREXPRO_PEPPERSTONE_DEMO_STOP_AUTHORITY_SYNC',
  'IREXPRO_PEPPERSTONE_DEMO_PROTECTED_RUNNER_HOLD',
];
const out={artifact:'irexpro-owner-demo-no-order-runner-preflight-v1',
  noBrokerOrderCalls:true,liveTradingAuthorized:false,
  account:'PEPPERSTONE_DEMO_USD',pilotState:'UNVERIFIED',
  schema:'NOT_CHECKED',
  openPositions:null,workingOrders:null,
  tradingSession:'UNKNOWN',brokerConnection:'UNKNOWN',
  executionSwitches:'UNKNOWN',pendingAmendments:'UNKNOWN',
  symbolsVerified:0,providerReadback:'NOT_CHECKED',
  pendingActualStopAmendmentUat:true,
};
let brokerClient,adapter,credentials;
const db=new Client({host:env.DB_HOST,port:Number(env.DB_PORT||5432),
  database:env.DB_NAME,user:env.DB_USER,password:env.DB_PASSWORD,
  ssl:env.DB_SSL==='true'?{rejectUnauthorized:false}:false,
  connectionTimeoutMillis:4500,statement_timeout:8000,
  application_name:'irexpro_owner_demo_no_order_pilot_preflight'});
(async()=>{
  // This script intentionally requires the protection switches OFF. Its
  // job is to verify the environment, never prepare to send a 2110 command.
  if(switches.some(k=>env[k]==='enabled'||process.env[k]==='enabled')){
    out.executionSwitches='ENABLED_REFUSING_PREFLIGHT';
    throw Error('RUNNER_SWITCH_ENABLED');
  }
  out.executionSwitches='ALL_OFF';
  await db.connect();
  await db.query('BEGIN READ ONLY');
  let c;
  try{
    const safe=await db.query(`SELECT
      (SELECT COUNT(*)::int FROM trading.trading_sessions WHERE status='ACTIVE') active_sessions,
      (SELECT COUNT(*)::int FROM trading.trades WHERE status IN ('OPEN','PENDING','RECONCILIATION_PENDING')) active_trades,
      (SELECT COUNT(*)::int FROM trading.demo_profit_stop_amendment_intents) total_intents,
      (SELECT COUNT(*)::int FROM broker.broker_connections
       WHERE broker_id='pepperstone-ctrader' AND account_type='LIVE'
       AND live_trading_enabled=true) live_enabled`);
    if(safe.rows.length!==1)throw Error('DB_SAFETY_UNAVAILABLE');
    const p=safe.rows[0];
    out.tradingSession=p.active_sessions===0?'STOPPED':'ACTIVE';
    out.pendingAmendments=p.total_intents===0?'EMPTY':'NOT_EMPTY';
    if(p.live_enabled!==0||p.active_sessions!==0||p.active_trades!==0||p.total_intents!==0){
      throw Error('BROKER_SAFETY_PRECONDITIONS_NOT_MET');
    }
    const rr=await db.query(`SELECT encrypted_credentials,credential_iv,credential_tag,encryption_key_id,
      account_currency,status FROM broker.broker_connections
      WHERE broker_id='pepperstone-ctrader' AND account_type='DEMO'
        AND status='CONNECTED' AND deleted_at IS NULL`);
    if(rr.rows.length!==1||rr.rows[0].account_currency!=='USD')throw Error('OWNER_DEMO_CONNECTION_UNVERIFIED');
    c=rr.rows[0];
    out.brokerConnection='CONNECTED_DEMO_USD';
    out.schema='LIVE_SCHEMA_READ_ONLY_OK';
  }finally{
    await db.query('ROLLBACK').catch(()=>{});
    await db.end();
  }
  const config=new ConfigService({BROKER_ENCRYPTION_KEY:env.BROKER_ENCRYPTION_KEY,
    broker:{ctraderClientId:env.CTRADER_CLIENT_ID,
      ctraderClientSecret:env.CTRADER_CLIENT_SECRET}});
  credentials=new CredentialEncryptionService(config).decrypt({
    ciphertext:c.encrypted_credentials,iv:c.credential_iv,tag:c.credential_tag,
    keyId:c.encryption_key_id||'env-key-v1',
  });
  brokerClient=new CTraderClientService(config);
  adapter=new CTraderAdapter(brokerClient,'pepperstone-ctrader');
  adapter.setMode(BrokerMode.DEMO);
  await adapter.connect(credentials);
  // Only these three read-only adapter methods are permitted by this script.
  // There is no import/reference to modifyOrder, placeOrder or closeOrder.
  const [positions,orders,symbols]=await Promise.all([
    adapter.getOpenPositions(),adapter.listOrders(),adapter.getInstrumentList(),
  ]);
  out.providerReadback='SUCCESS';
  out.openPositions=positions.length;
  out.workingOrders=orders.length;
  const majors=['EURUSD','GBPUSD','AUDUSD','USDJPY','USDCAD','USDCHF'];
  const ready=majors.filter(name=>{
    const s=symbols.find(x=>x.symbol===name);
    return !!s && Number.isInteger(s.digits) && s.digits>=2 && s.digits<=6 &&
      Number(s.minLot)>0 && Number(s.maxLot)>=Number(s.minLot) &&
      Number(s.lotStep)>0 &&
      s.minStopLossDistanceUnit==='POINTS' &&
      Number.isFinite(Number(s.minStopLossDistance)) &&
      Number(s.minStopLossDistance)>=0;
  });
  out.symbolsVerified=ready.length;
  if(positions.length===0 && orders.length===0 && ready.length===majors.length){
    out.pilotState='NO_OPEN_POSITION_FOR_BROKER_AMENDMENT_UAT';
  }else{
    out.pilotState='EXPOSURE_OR_SYMBOL_PROOF_UNVERIFIED';
    process.exitCode=1;
  }
})().catch(err=>{
  out.pilotState='PREFLIGHT_FAILED_CLOSED';
  // Never print provider details, credentials, account or position IDs.
  out.failure=err.message?.startsWith('BROKER_')||err.message?.startsWith('RUNNER_')||
    err.message?.startsWith('OWNER_')?err.message:'PROVIDER_OR_DATABASE_UNVERIFIED';
  process.exitCode=1;
}).finally(async()=>{
  if(credentials)for(const k of Object.keys(credentials))credentials[k]=null;
  try{await adapter?.disconnect()}catch{}
  try{await brokerClient?.onModuleDestroy()}catch{}
  console.log(JSON.stringify(out));
});
