'use strict';
/**
 * Read-only historical evidence audit for the ONE real Pepperstone LIVE canary
 * already executed in certification run 236a6506-5368-4b68-b6b4-394c3af3ecb3.
 *
 * No order, amendment, close, renewal, certification, or LIVE permission writes.
 * Safe to unit-test offline via module.exports. Real broker reads require
 * exact encrypted stored connection + valid OAuth and an operator invocation.
 * The historical FAIL artifact is immutable; any new evidence is a separate
 * addendum, NEVER a retroactive certification PASS.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const RUN_ID = '236a6506-5368-4b68-b6b4-394c3af3ecb3';
const ACCOUNT_ID = '49506270';
const BROKER_ID = 'pepperstone-ctrader';
const POSITION_ID = '669256554';
const INSTRUMENT = 'AUDUSD';
const VOLUME = '0.01';
const HISTORY_ROWS_CAP = 200;
const TIME_PADDING_MS = 2 * 60_000;

function positiveProviderId(x) {
  return typeof x === 'string' || typeof x === 'number'
    ? /^[1-9]\d*$/.test(String(x)) && Number.isSafeInteger(Number(x))
    : false;
}

function chooseNativeOrderIdentity({deals, hasMore, positionId, from, to}) {
  if (!Array.isArray(deals) || deals.length >= HISTORY_ROWS_CAP || hasMore !== false) {
    return {status:'INCOMPLETE',reason:'HISTORY_PAGE_UNPROVEN_COMPLETE'};
  }
  // All matching deals are evaluated, including malformed records, before
  // accepting a particular order. A missing order ID cannot be ignored.
  const relevant = deals.filter(x=>x && String(x.positionId)===String(positionId));
  if (!relevant.length) return {status:'INCOMPLETE',reason:'POSITION_DEALS_NOT_FOUND'};
  const opening = relevant.filter(x=>x.closePositionDetail == null);
  const closing = relevant.filter(x=>x.closePositionDetail != null);
  if (opening.length!==1 || closing.length<1) {
    return {status:'INCOMPLETE',reason:'UNIQUE_OPEN_AND_CLOSE_DEAL_NOT_PROVEN'};
  }
  const deal = opening[0];
  const openedMs = Number(deal.executionTimestamp);
  if (
    !positiveProviderId(deal.orderId) ||
    !positiveProviderId(deal.dealId) ||
    !Number.isSafeInteger(openedMs) ||
    openedMs<from || openedMs>to ||
    !closing.some(x=>Number(x.executionTimestamp)>openedMs &&
      Number(x.executionTimestamp)<=to)
  ) {
    return {status:'INCOMPLETE',reason:'NATIVE_ORDER_ID_OR_EXECUTION_TIME_NOT_VERIFIED'};
  }
  return {
    status:'FOUND',
    brokerNativeOrderId:String(deal.orderId),
    openingDealId:String(deal.dealId),
    openingTime:new Date(openedMs).toISOString(),
    closingDeals:closing.length,
  };
}

function verifyOrderReadback(state, candidate) {
  if (!state) return {status:'INCOMPLETE',reason:'NATIVE_ORDER_NOT_RETRIEVABLE'};
  if (
    String(state.providerOrderId)!==candidate.brokerNativeOrderId ||
    state.status!=='FILLED' ||
    String(state.instrument).replace(/[^A-Za-z0-9]/g,'').toUpperCase()!==INSTRUMENT ||
    Number(state.filledQuantity)!==Number(VOLUME) ||
    (state.providerPositionId != null && String(state.providerPositionId)!==POSITION_ID)
  ) {
    return {status:'INCOMPLETE',reason:'ORDER_READBACK_IDENTITY_OR_FILL_MISMATCH'};
  }
  return {status:'VERIFIED',filledQuantity:state.filledQuantity,
    nativeOrderId:String(state.providerOrderId),providerPositionId:state.providerPositionId??null};
}

function loadOriginalEvidence(evidenceDir) {
  const matches=fs.readdirSync(evidenceDir).filter(x=>
    x.startsWith('live-certification-pepperstone-ctrader-'+RUN_ID+'-') &&
    x.endsWith('.json')
  );
  if(matches.length!==1) throw Error('EXACT_ORIGINAL_CERTIFICATION_ARTIFACT_NOT_FOUND');
  const evidencePath=path.join(evidenceDir,matches[0]);
  const raw=fs.readFileSync(evidencePath);
  const j=JSON.parse(raw.toString('utf8'));
  const step=name=>j.steps?.find(x=>x.name===name);
  if (
    j.runId!==RUN_ID || j.brokerId!==BROKER_ID || j.mode!=='LIVE' ||
    j.certificationResult!=='FAIL' || j.evidenceState!=='PERSISTED' ||
    j.target?.accountIdMasked!=='•••6270' ||
    j.steps?.length!==16 ||
    step('place-minimum-safe-order')?.status!=='PASS' ||
    step('verify-provider-ack')?.status!=='FAIL' ||
    step('query-order')?.status!=='FAIL' ||
    step('query-position')?.status!=='PASS' ||
    step('close-position')?.status!=='PASS' ||
    step('verify-closed')?.status!=='PASS' ||
    step('reconcile-history')?.status!=='PASS' ||
    step('verify-zero-unexpected-open-exposure')?.status!=='PASS' ||
    j.canary?.actualSize!==VOLUME || j.canary?.instrument!==INSTRUMENT ||
    !step('query-position')?.detail?.includes('canary position '+POSITION_ID+' ') ||
    !Number.isFinite(Date.parse(j.startedAt)) ||
    !Number.isFinite(Date.parse(j.finishedAt))
  ) throw Error('ORIGINAL_CANARY_EVIDENCE_IDENTITY_OR_STATUS_MISMATCH');
  return {
    sourceFile:evidencePath,
    sourceSha256:crypto.createHash('sha256').update(raw).digest('hex'),
    startedAt:j.startedAt,finishedAt:j.finishedAt,
  };
}

function writeAddendum(dir, record) {
  const id=crypto.randomUUID();
  const filename='historical-live-canary-order-audit-'+RUN_ID+'-'+id+'.json';
  const file=path.join(dir,filename);
  const evidence={...record,auditId:id,auditedAt:new Date().toISOString(),
    originalCertificationResult:'FAIL',automatedLiveTradingEnabledByThisAudit:false,
    modifiesExistingCertification:false,brokerWriteOperations:0};
  const content=JSON.stringify(evidence,null,2)+'\n';
  fs.writeFileSync(file,content,{flag:'wx',mode:0o600});
  const check=fs.readFileSync(file);
  if(check.toString('utf8')!==content)throw Error('ADDENDUM_READBACK_FAILED');
  return {file,sha256:crypto.createHash('sha256').update(check).digest('hex')};
}

async function run() {
  const evidenceDir='/root/irexpro-live-cert-evidence';
  const out={artifact:'irexpro-existing-live-canary-order-readonly-audit-v1',
    runId:RUN_ID,brokerId:BROKER_ID,accountIdMasked:'•••6270',
    instrument:INSTRUMENT,positionId:POSITION_ID,auditStatus:'INCOMPLETE',
    noBrokerOrderCalls:true,brokerWritesSent:false};
  let adapter,brokerClient,credentials;
  try {
    const original=loadOriginalEvidence(evidenceDir);
    out.originalEvidenceSha256=original.sourceSha256;
    const from=Date.parse(original.startedAt)-TIME_PADDING_MS;
    const to=Date.parse(original.finishedAt)+TIME_PADDING_MS;
    if (!(to>from && to-from<=10*60_000)) throw Error('INVALID_FIXED_HISTORY_WINDOW');
    out.historyWindow={from:new Date(from).toISOString(),to:new Date(to).toISOString()};

    const dotenv=require('dotenv');
    const env={...dotenv.parse(fs.readFileSync(path.resolve(__dirname,'../../.env')))};
    const {Client}=require('pg');
    const db=new Client({host:env.DB_HOST,port:Number(env.DB_PORT||5432),
      database:env.DB_NAME,user:env.DB_USER,password:env.DB_PASSWORD,
      ssl:env.DB_SSL==='true'?{rejectUnauthorized:false}:false,
      connectionTimeoutMillis:5000,statement_timeout:7000,
      application_name:'irexpro_historical_canary_provider_ro'});
    let connected=false;
    let row;
    try {
      await db.connect();connected=true;
      await db.query('BEGIN READ ONLY');
      const result=await db.query(`
        SELECT id::text,user_id::text,broker_id,account_id,account_type,status,
               authorization_status,credential_status,provider_broker_identity,
               encrypted_credentials,credential_iv,credential_tag,encryption_key_id
          FROM broker.broker_connections
         WHERE broker_id=$1 AND account_id=$2 AND account_type='LIVE'
           AND deleted_at IS NULL
         LIMIT 2`,[BROKER_ID,ACCOUNT_ID]);
      if(result.rows.length!==1)throw Error('EXACT_LIVE_CONNECTION_NOT_FOUND');
      row=result.rows[0];
      if(row.provider_broker_identity!=='pepperstone' ||
         row.status!=='CONNECTED' ||
         !['CONNECTED','ACTIVE'].includes(row.authorization_status) ||
         !['ROTATED','VERIFIED','ACTIVE'].includes(row.credential_status)) {
        throw Error('LIVE_CONNECTION_NOT_ELIGIBLE');
      }
    } finally {
      if(connected)await db.query('ROLLBACK').catch(()=>undefined);
      await db.end().catch(()=>undefined);
    }

    const {ConfigService}=require('@nestjs/config');
    const {CredentialEncryptionService}=require(
      '../../dist/modules/broker/services/credential-encryption.service');
    const {CTraderClientService}=require(
      '../../dist/modules/broker/adapters/ctrader/ctrader-client.service');
    const {CTraderAdapter}=require(
      '../../dist/modules/broker/adapters/ctrader/ctrader.adapter');
    const {BrokerMode}=require(
      '../../dist/modules/broker/interfaces/broker-adapter.interface');
    const {CTRADER_PAYLOAD_TYPE}=require(
      '../../dist/modules/broker/adapters/ctrader/ctrader-message-types');
    const cfg=new ConfigService({BROKER_ENCRYPTION_KEY:env.BROKER_ENCRYPTION_KEY,
      broker:{ctraderClientId:env.CTRADER_CLIENT_ID,
              ctraderClientSecret:env.CTRADER_CLIENT_SECRET}});
    credentials=new CredentialEncryptionService(cfg).decrypt({
      ciphertext:row.encrypted_credentials,iv:row.credential_iv,
      tag:row.credential_tag,keyId:row.encryption_key_id,
    });
    if(credentials.accountId!==ACCOUNT_ID || !credentials.apiKey) {
      throw Error('STORED_CREDENTIAL_ACCOUNT_ID_MISMATCH');
    }
    brokerClient=new CTraderClientService(cfg);
    adapter=new CTraderAdapter(brokerClient,BROKER_ID);
    adapter.setMode(BrokerMode.LIVE);
    const connectedAccount=await adapter.connect(credentials);
    if(!connectedAccount.success ||
       connectedAccount.accountId!==ACCOUNT_ID ||
       connectedAccount.accountType!=='LIVE') {
      throw Error('BROKER_LIVE_ACCOUNT_IDENTITY_MISMATCH');
    }
    // ONLY Spotware read surface (DEAL_LIST_REQ) + documented read methods.
    const res=await brokerClient.request('LIVE',CTRADER_PAYLOAD_TYPE.DEAL_LIST_REQ,{
      ctidTraderAccountId:Number(ACCOUNT_ID),fromTimestamp:from,toTimestamp:to,
      maxRows:HISTORY_ROWS_CAP,
    });
    if(res.payloadType!==CTRADER_PAYLOAD_TYPE.DEAL_LIST_RES) {
      throw Error('HISTORICAL_DEAL_RESPONSE_NOT_VERIFIED');
    }
    const page=res.payload||{};
    const chosen=chooseNativeOrderIdentity({
      deals:page.deal,hasMore:page.hasMore,
      positionId:POSITION_ID,from,to,
    });
    out.historyProof={status:chosen.status,reason:chosen.reason||null,
      matchedNativeOrderId:chosen.brokerNativeOrderId||null,
      openingDealId:chosen.openingDealId||null,
      openingTime:chosen.openingTime||null,
      closingDeals:chosen.closingDeals||0};
    if(chosen.status==='FOUND'){
      const [order,positions,working]=await Promise.all([
        adapter.getOrderById(chosen.brokerNativeOrderId),
        adapter.getOpenPositions(),
        adapter.listOrders(),
      ]);
      out.orderProof=verifyOrderReadback(order,chosen);
      out.currentExposure={openPositions:positions.length,workingOrders:working.length};
      if(out.orderProof.status==='VERIFIED' && positions.length===0 &&
        working.length===0) out.auditStatus='HISTORICAL_ORDER_ID_VERIFIED';
      else out.reason='BROKER_READBACK_OR_ZERO_EXPOSURE_UNVERIFIED';
    } else out.reason=chosen.reason;
  } catch(error) {
    // A typed audit-only category, not provider response text or credentials.
    out.reason=String(error?.message||'').match(/^[A-Z][A-Z0-9_]{3,90}$/)
      ? error.message:'BROKER_HISTORY_OR_SECURE_CREDENTIAL_READ_FAILED';
  } finally {
    if(credentials)for(const key of Object.keys(credentials))credentials[key]=null;
    try{await adapter?.disconnect()}catch{}
    try{await brokerClient?.onModuleDestroy()}catch{}
    const saved=writeAddendum(evidenceDir,out);
    console.log(JSON.stringify({status:out.auditStatus,reason:out.reason||null,
      historyProof:out.historyProof||null,orderProof:out.orderProof||null,
      currentExposure:out.currentExposure||null,originalCertification:'FAIL',
      evidenceSha256:saved.sha256,artifactPath:saved.file,
      noNewOrders:true,liveActivationChanged:false},null,2));
    if(out.auditStatus!=='HISTORICAL_ORDER_ID_VERIFIED')process.exitCode=1;
  }
}

if(require.main===module)void run();
module.exports={chooseNativeOrderIdentity,verifyOrderReadback,loadOriginalEvidence};
