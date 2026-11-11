#!/usr/bin/env node
'use strict';
/**
 * Read-only, non-executable M1 candidate study with native broker quote
 * snapshots: 1/3/5/10 minutes after the FIRST FUTURE QUOTE we could have
 * used for entering a candidate. No orders, no risk grants, no model change.
 *
 * Every entered price is a broker ASK for BUY, BID for SELL; every exit mark
 * uses the opposite side, then deducts an as-of P90 broker commission.
 * No intrabar first-touch, slippage, market impact or guaranteed execution.
 * Per-pair/side 5-minute de-duplication reduces but does not eliminate
 * temporal correlation; multi-day purged walk-forward remains mandatory.
 */
const {brokerMarkNetUSD,finiteNumber,timestamp}=require('./audit-short-horizon-broker-marks.cjs');
const HORIZONS=[1,3,5,10];
function validQuote(q) {
  const bid=finiteNumber(q.bid_close),ask=finiteNumber(q.ask_close);
  return q.source==='ctrader-broker-native'
    && Number(q.positive_quote_sample_count)>0
    && bid!==null&&ask!==null&&bid>0&&ask>=bid
    && timestamp(q.last_quote_sample_at)!==null;
}
function firstCausalQuote(quotes,notBefore,maxDelayMs=90000) {
  if(!Number.isFinite(notBefore)||!Number.isFinite(maxDelayMs)||maxDelayMs<=0)return null;
  // quotes must be sorted ascending by actual last sample, not the M1
  // bucket start: inspecting an entire future candle leaks future data.
  let low=0,high=quotes.length;
  while(low<high){const mid=(low+high)>>1;
    if(timestamp(quotes[mid].last_quote_sample_at)<notBefore)low=mid+1;
    else high=mid;
  }
  const q=quotes[low];
  const at=q?timestamp(q.last_quote_sample_at):null;
  return q&&validQuote(q)&&at!==null&&at>=notBefore&&at<=notBefore+maxDelayMs?q:null;
}
function p90(values) {
  if(!values.length)return null;
  const s=[...values].sort((a,b)=>a-b);
  const rank=0.9*(s.length-1),lo=Math.floor(rank),hi=Math.ceil(rank);
  return s[lo]+(rank-lo)*(s[hi]-s[lo]);
}
function causalFeePerLot(closes,at) {
  const vals=closes.filter(c=>c.closedAt<at && c.closedAt>=at-21*86400000)
    .slice(-40).map(c=>c.feePerLot).filter(v=>Number.isFinite(v)&&v>0);
  return vals.length>=8?p90(vals):null;
}
function oppositeDirection(direction) {
  if(direction==='BUY')return 'SELL';
  if(direction==='SELL')return 'BUY';
  throw new Error('UNSUPPORTED_DIRECTION_FOR_RESEARCH');
}
function comparePairedDirections(cases) {
  // An ORACLE choice using future outcomes would be hindsight. Its output
  // exists solely to quantify whether direction errors occur frequently.
  // It is NEVER a model policy, signal filter, broker authorization or PnL.
  const report={};
  for(const h of HORIZONS) {
    let pairs=0,originalPositive=0,oppositePositive=0,
      oppositeBetter=0,bothNegative=0,bothPositive=0,
      sumOriginal=0,sumOpposite=0;
    for(const item of cases) {
      const current=item.study?.outcomes?.[h];
      const reverse=item.oppositeStudy?.outcomes?.[h];
      if(!current||!reverse)continue;
      pairs++;sumOriginal+=current.netUsd1Lot;sumOpposite+=reverse.netUsd1Lot;
      if(current.netUsd1Lot>0)originalPositive++;
      if(reverse.netUsd1Lot>0)oppositePositive++;
      if(reverse.netUsd1Lot>current.netUsd1Lot)oppositeBetter++;
      if(current.netUsd1Lot<=0&&reverse.netUsd1Lot<=0)bothNegative++;
      if(current.netUsd1Lot>0&&reverse.netUsd1Lot>0)bothPositive++;
    }
    report[h]={
      n:pairs,
      originalPositive,
      oppositePositive,
      oppositeBetterInHindsight:oppositeBetter,
      bothNonPositive:bothNegative,
      bothPositive,
      originalMeanNetOneLot:pairs?Number((sumOriginal/pairs).toFixed(2)):null,
      oppositeMeanNetOneLot:pairs?Number((sumOpposite/pairs).toFixed(2)):null,
      warning:'Opposite-side marks are counterfactual, not broker-executable approvals; the better direction cannot be known in advance.',
    };
  }
  return report;
}
function studyEpisode(decision,quotes,closes) {
  const decided=timestamp(decision.created_at);
  if(decided===null||!['BUY','SELL'].includes(decision.direction)||!Array.isArray(quotes))return null;
  const entryQuote=firstCausalQuote(quotes,decided,90000);
  if(!entryQuote)return null;
  const entryAt=timestamp(entryQuote.last_quote_sample_at);
  const entryPrice=Number(decision.direction==='BUY'?entryQuote.ask_close:entryQuote.bid_close);
  const feePerLot=causalFeePerLot(closes,decided);
  if(feePerLot===null)return {reason:'CAUSAL_BROKER_FEES_NOT_ESTABLISHED',outcomes:{}};
  const hypotTrade={instrument:decision.instrument,direction:decision.direction,
    fill_price:entryPrice,lot_size:1,commission:-feePerLot,swap:0};
  const outcomes={};
  for(const h of HORIZONS) {
    const exitQuote=firstCausalQuote(quotes,entryAt+h*60000,90000);
    if(!exitQuote){outcomes[h]=null;continue}
    const price=Number(decision.direction==='BUY'?exitQuote.bid_close:exitQuote.ask_close);
    const pnl=brokerMarkNetUSD(hypotTrade,price);
    if(!pnl){outcomes[h]=null;continue}
    outcomes[h]={netUsd1Lot:pnl.netUSD,grossUsd1Lot:pnl.grossUSD,
      signedPips:pnl.pips,positiveAfterCosts:pnl.netUSD>0,
      markLagSec:(timestamp(exitQuote.last_quote_sample_at)-(entryAt+h*60000))/1000};
  }
  return {reason:'MARKED',feePerLot,entryAt:new Date(entryAt).toISOString(),outcomes};
}
const ASOF_NUMERIC_FEATURES = Object.freeze([
  'atr','score','confidence','directionQuality','grossExpectedR',
  'alignedEmaSeparationAtr','alignedEmaSlopeAtr',
  'alignedM5Momentum1Atr','alignedM5Momentum3Atr',
  'alignedMomentum1Atr','alignedMomentum3Atr','alignedMomentum5Atr',
  'alignedM5BodyPressure3','alignedHigherTimeframeAgreement',
  'alignedM30DirectionalEfficiency','breakoutAtr','m5BodyExpansionRatio',
]);
// Only explicitly allowlisted as-of candidate fields enter the offline
// learning dataset; never export user IDs, broker IDs or raw governance JSON.
// Labels are separate and must never enter the predictive feature list.
function asofTrainingRow(decision,study,oppositeStudy=null) {
  const c=decision.candidate && typeof decision.candidate==='object'
    ? decision.candidate : {};
  const meta=decision.plan_b && typeof decision.plan_b==='object'
    ? decision.plan_b : {};
  const features={};
  for(const key of ASOF_NUMERIC_FEATURES)features[key]=finiteNumber(c[key]);
  features.planBMetaProbability=finiteNumber(meta.metaProbability);
  features.planBExpectedR=finiteNumber(meta.expectedR);
  features.planBDirectionQuality=finiteNumber(meta.directionQuality);
  features.planBTradeQuality=finiteNumber(meta.tradeQuality);
  features.planBExitQuality=finiteNumber(meta.exitQuality);
  return {
    instrument:decision.instrument,direction:decision.direction,route:decision.route,
    persistedDecisionAt:new Date(decision.created_at).toISOString(),
    planBAdmitted:decision.paper_admitted==='true',
    researchRegime:typeof meta.regime==='string'?meta.regime:null,
    observedBrokerAuthority:decision.execution_authority==='BROKER_NATIVE',
    features,
    // Outcomes ONLY in this label object, never usable as training features.
    labels:study?.reason==='MARKED'?study.outcomes:null,
    // Counter-direction labels are held separately for supervised
    // BUY/SELL/NO_EDGE research, and NEVER enter as-of predictor features.
    oppositeLabels:oppositeStudy?.reason==='MARKED'?oppositeStudy.outcomes:null,
    feeEvidenceAvailable:study?.reason==='MARKED',
  };
}
function aggregateEpisodes(cases) {
  const cohorts={ALL:[],PLAN_B_ADMITTED:[],PLAN_B_NOT_ADMITTED:[],
    BROKER_AUTHORIZED:[],TREND_CONTINUATION:[],EARLY_TRANSITION:[]};
  for(const c of cases){
    cohorts.ALL.push(c);
    cohorts[c.planBAdmitted?'PLAN_B_ADMITTED':'PLAN_B_NOT_ADMITTED'].push(c);
    if(c.executionAuthority==='BROKER_NATIVE')cohorts.BROKER_AUTHORIZED.push(c);
    if(c.route==='M1_TREND_CONTINUATION')cohorts.TREND_CONTINUATION.push(c);
    else if(c.route==='M1_EARLY_TRANSITION')cohorts.EARLY_TRANSITION.push(c);
  }
  return Object.fromEntries(Object.entries(cohorts).map(([name,entries])=>{
    const result={episodes:entries.length,
      completeCostAndEntry:entries.filter(e=>e.study?.reason==='MARKED').length,
      economic:{},
    };
    for(const h of HORIZONS){
      const scored=entries.map(x=>x.study?.outcomes?.[h]).filter(Boolean);
      result.economic[h]={
        n:scored.length,
        positive:scored.filter(x=>x.positiveAfterCosts).length,
        positiveShare:scored.length?Number((scored.filter(x=>x.positiveAfterCosts).length/scored.length).toFixed(3)):null,
        avgNetUsdPerOneLot:scored.length?Number((scored.reduce((a,x)=>a+x.netUsd1Lot,0)/scored.length).toFixed(2)):null,
        avgSignedPips:scored.length?Number((scored.reduce((a,x)=>a+x.signedPips,0)/scored.length).toFixed(2)):null,
      };
    }
    return [name,result];
  }));
}
async function main() {
  require('dotenv').config({path:'.env',quiet:true});
  const {Client}=require('pg'),{getDatabaseSslOptions}=
    require(require('node:path').resolve(process.cwd(),'dist/config/database-tls'));
  const uid=process.env.VPS_FOREX_SCANNER_USER_ID;
  if(!uid)throw new Error('OWNED_DEMO_USER_NOT_CONFIGURED');
  const start=process.env.IREXPRO_HORIZON_AUDIT_START||'2026-11-10T08:00:00Z';
  const end=process.env.IREXPRO_HORIZON_AUDIT_END||'2026-11-11T10:00:00Z';
  if(timestamp(start)===null||timestamp(end)===null
    ||timestamp(end)<=timestamp(start)||timestamp(end)-timestamp(start)>7*86400000){
    throw new Error('INVALID_RESEARCH_WINDOW_MAX_SEVEN_DAYS');
  }
  const c=new Client({
    host:process.env.DB_HOST||'localhost',port:Number(process.env.DB_PORT||5432),
    database:process.env.DB_NAME||'irexpro_dev',user:process.env.DB_USER||'irexpro',
    password:process.env.DB_PASSWORD,ssl:getDatabaseSslOptions(process.env.DB_SSL==='true'),
    application_name:'irexpro-readonly-M1-horizon-candidate-labels-v1',
  });
  await c.connect();
  try{
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SET LOCAL statement_timeout='28s'");
    const owned=(await c.query(`SELECT s.broker_connection_id,b.broker_id,b.account_type,b.account_currency
      FROM trading.trading_sessions s JOIN broker.broker_connections b
        ON b.id=s.broker_connection_id AND b.user_id=s.user_id
      WHERE s.user_id=$1 AND s.status='ACTIVE' AND s.execution_mode='FULL_AUTO'
      ORDER BY s.started_at DESC LIMIT 1`,[uid])).rows;
    if(owned.length!==1||owned[0].broker_id!=='pepperstone-ctrader'
      ||owned[0].account_type!=='DEMO'||owned[0].account_currency!=='USD'){
      throw new Error('WRONG_CONNECTION_OR_ACCOUNT_CURRENCY');
    }
    const cid=owned[0].broker_connection_id;
    const rows=(await c.query(`
      WITH episodes AS (
        SELECT d.instrument,d.direction,d.route,d.created_at,
          d.execution_authority,d.candidate,
          d.governance -> 'multimodelEnsemble' AS plan_b,
          d.governance #>> '{multimodelEnsemble,paperAdmitted}' AS paper_admitted,
          ROW_NUMBER() OVER (PARTITION BY d.instrument,d.direction,
            date_bin('5 minutes',d.created_at,'2000-01-01'::timestamptz)
            ORDER BY d.created_at,d.id) rn
        FROM trading.m1_tactical_decisions d
        WHERE d.user_id=$1 AND d.broker_connection_id=$2
          AND d.route<>'ABSTAIN'
          AND d.created_at>=$3::timestamptz
          AND d.created_at<$4::timestamptz-interval '13 minutes'
      )
      SELECT instrument,direction,route,created_at,execution_authority,
             candidate,plan_b,paper_admitted
      FROM episodes WHERE rn=1 ORDER BY created_at LIMIT 8000
    `,[uid,cid,start,end])).rows;
    const bars=(await c.query(`
      SELECT instrument,last_quote_sample_at,bid_close,ask_close,source,
             positive_quote_sample_count
      FROM market_data.provider_quote_candles
      WHERE connection_id=$1 AND timeframe='M1'
        AND bucket_time>=$2::timestamptz
        AND bucket_time<$3::timestamptz
        AND source='ctrader-broker-native' AND positive_quote_sample_count>0
      ORDER BY instrument,last_quote_sample_at
    `,[cid,start,end])).rows;
    const fills=(await c.query(`
      SELECT closed_at,lot_size,commission,swap
      FROM trading.trades
      WHERE user_id=$1 AND broker_connection_id=$2
        AND status='CLOSED' AND account_currency='USD'
        AND instrument IN ('EURUSD','GBPUSD','AUDUSD','USDCAD','USDCHF','USDJPY')
        AND closed_at<$3::timestamptz AND closed_at>=$4::timestamptz-interval '21 days'
        AND commission IS NOT NULL AND lot_size>0
      ORDER BY closed_at
    `,[uid,cid,end,start])).rows;
    await c.query('COMMIT');
    const feeCloses=fills.map(x=>({
      closedAt:timestamp(x.closed_at),
      feePerLot:(Math.abs(Number(x.commission))+Math.max(0,-Number(x.swap||0)))/Number(x.lot_size),
    })).filter(x=>Number.isFinite(x.closedAt)&&Number.isFinite(x.feePerLot)&&x.feePerLot>0);
    const quotesBySymbol=new Map();
    for(const q of bars){if(!validQuote(q))continue;
      if(!quotesBySymbol.has(q.instrument))quotesBySymbol.set(q.instrument,[]);
      quotesBySymbol.get(q.instrument).push(q);
    }
    const cases=rows.map(x=>({
      instrument:x.instrument,direction:x.direction,route:x.route,
      executionAuthority:x.execution_authority,
      planBAdmitted:x.paper_admitted==='true',
      study:studyEpisode(x,quotesBySymbol.get(x.instrument)||[],feeCloses),
      oppositeStudy:studyEpisode(
        {...x,direction:oppositeDirection(x.direction)},
        quotesBySymbol.get(x.instrument)||[],feeCloses,
      ),
    }));
    const summary={
      artifact:'irexpro-readonly-5min-dedup-M1-candidate-horizon-mark-study-v1',
      status:'RESEARCH_ONLY_NO_TRADING_AUTHORITY',
      window:{start,end},candidateEpisodes:cases.length,
      brokerQuoteBars:bars.length,causalFeeFills:feeCloses.length,
      excludedNoCausalQuoteOrFee:cases.filter(x=>x.study?.reason!=='MARKED').length,
      cohorts:aggregateEpisodes(cases),
      pairedOppositeDirection:comparePairedDirections(cases),
      warnings:[
        'Opposite-side studies are price-mark counterfactuals; hindsight-best direction is NEVER a trade selection policy.',
        'M1 bid/ask marks not broker fills; no slippage/latency/first-touch of SL/TP.',
        'Future candidate outcomes are research labels only, never training features or trade authority.',
        '5-minute pair-side episodes are still temporally dependent. A two-day period is inadequate for production training.',
        'PLAN_B_NOT_ADMITTED contains structurally risky/no-news and unapproved trades; positive marks are NOT permission to execute.',
        'Historical broker commission is causal as-of event from earlier closed account fills; no future cost leakage.',
        'Entry is first observable quote 0–90 sec AFTER signal persistence, not the candidate-proposed fill.',
        'Not a full portfolio backtest: no position concurrency, margin or SL/TP enforcement.',
      ],
    };
    const exportPath=process.env.IREXPRO_HORIZON_COHORT_EXPORT;
    if(exportPath!==undefined) {
      // Local-only, owner-readable, never model registry, git, uploads,
      // public asset roots, or a path supplied through broker/client input.
      if(!/^\/tmp\/irexpro-[a-zA-Z0-9_.-]+\.json$/.test(exportPath)){
        throw new Error('COHORT_EXPORT_REQUIRES_EXPLICIT_LOCAL_TMP_PATH');
      }
      const fs=require('node:fs');
      const dataset=rows.map((row,i)=>
        asofTrainingRow(row,cases[i].study,cases[i].oppositeStudy));
      fs.writeFileSync(exportPath,JSON.stringify({
        artifact:'irexpro-offline-1-3-5-10m-research-cohort-v1',
        trainingAuthority:'NONE',promotionAllowed:false,brokerOrders:0,
        rowCount:dataset.length,asOfFeatures:ASOF_NUMERIC_FEATURES,
        rows:dataset,
      }),{mode:0o600,flag:'wx'});
    }
    console.log(JSON.stringify(summary,null,2));
  }catch(e){try{await c.query('ROLLBACK')}catch{};throw e}
  finally{await c.end()}
}
module.exports={validQuote,firstCausalQuote,causalFeePerLot,p90,studyEpisode,aggregateEpisodes,asofTrainingRow,oppositeDirection,comparePairedDirections};
if(require.main===module)main().catch(e=>{console.error('AUDIT_FAILED',e.message);process.exitCode=1});
