#!/usr/bin/env node
'use strict';
/**
 * Owner Pepperstone USD DEMO: all closed fills with exact PRE-ENTRY M1
 * decisions, split by trade DATE (Nov 17/18 discovery, Nov 19+ evaluation).
 * NEVER train on a field written after intent creation, settlement, mark P&L,
 * price action after entry, or future decisions. Research-only.
 *
 * cd apps/api && node scripts/audit-owner-demo-win-loss-formation.cjs
 */
const path=require('node:path'),fs=require('node:fs');
const asofCandles=require('./owner-demo-asof-candle-win-loss.cjs');
const ARTIFACT='owner-demo-win-loss-entry-formation-day-separated-v1';
const FROM='2026-11-17T00:00:00Z';
const TO='2026-11-20T00:00:00Z';
const CUTOFF='2026-11-19';
const MAX=800;
const OUT='/home/lightworld/webapps/irexpro-research/entry-formation/latest-report.json';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[89ab0-9a-f]{12}$/i;
const SQL=[
'SELECT t.id::text trade_id,t.instrument,t.direction,t.lot_size,t.opened_at,t.closed_at,',
't.realised_pnl,t.commission,t.swap,t.max_favorable_pnl,t.max_adverse_pnl,t.close_reason,',
'ti.created_at intent_at,ti.metadata,',
'd.id::text decision_id,d.created_at recorded_at,d.evaluated_at decision_at,',
'd.candidate,d.governance,d.route m1_route,',
"d.blockers,d.execution_authority",
'FROM trading.trades t',
'JOIN broker.broker_connections b ON b.id=t.broker_connection_id AND b.user_id=t.user_id',
'JOIN trading.trade_intents ti ON ti.id=t.trade_intent_id',
' AND ti.user_id=t.user_id AND ti.broker_connection_id=t.broker_connection_id',
'LEFT JOIN trading.m1_tactical_decisions d ON d.id=',
" CASE WHEN ti.metadata->>'m1_decision_id' ~ '^[0-9a-f-]{36}$'",
" THEN (ti.metadata->>'m1_decision_id')::uuid ELSE null END",
' AND d.user_id=t.user_id AND d.broker_connection_id=t.broker_connection_id',
'WHERE t.user_id=$1 AND b.user_id=$1 AND b.broker_id=$2',
"AND b.account_type='DEMO' AND b.account_currency='USD'",
"AND t.account_currency='USD' AND t.status='CLOSED'",
'AND t.opened_at>=$3::timestamptz AND t.opened_at<$4::timestamptz',
'ORDER BY t.opened_at,t.id LIMIT 801',
].join(' ');
const n=x=>x==null||x===''?null:Number.isFinite(Number(x))?Number(x):null;
const round=(x,p=4)=>x==null||!Number.isFinite(x)?null:+x.toFixed(p);
const millis=x=>x==null?null:Number.isFinite(new Date(x).getTime())?new Date(x).getTime():null;
const safe=x=>x&&typeof x==='object'&&!Array.isArray(x)?x:{};
const signalSide=(v,dir)=>dir==='BUY'?v==='BUY':v==='SELL';
function normalize(r) {
 const opened=millis(r.opened_at),closed=millis(r.closed_at),
  at=millis(r.decision_at),recorded=millis(r.recorded_at),intent=millis(r.intent_at);
 const m=safe(r.metadata),g=safe(r.governance),c=safe(r.candidate);
 const en=safe(g.multimodelEnsemble),ex=safe(g.multimodelTrainedExpert),
  gov=safe(g.multimodelGovernance);
 const gross=n(r.realised_pnl),commission=n(r.commission),swap=n(r.swap);
 const lot=n(r.lot_size);
 if(!r.trade_id||!['BUY','SELL'].includes(r.direction)||!['USDJPY','USDCAD','EURUSD','AUDUSD','GBPUSD','USDCHF'].includes(r.instrument)||
 opened==null||closed==null||opened>closed||gross==null||commission==null||swap==null||
 lot==null||lot<=0) throw Error('MISSING_BROKER_ECONOMICS_OR_INVALID_TRADE');
 const net=round(gross+commission+swap,2);
 // If the decision is unlinked or recorded after the trade intent, do NOT
 // silently read its features. Include the trade in UNKNOWN coverage.
 const verified=r.decision_id&&at!=null&&recorded!=null&&intent!=null&&
  at<=recorded&&recorded<=intent&&intent<=opened&&at<=opened&&
  opened-at<=10*60_000&&
  (c.direction===r.direction)&&['TREND_CONTINUATION','EARLY_TRANSITION','CONFIRMED_REVERSAL'].includes(en.strategyRoute)&&
  en.strategyRoute===m.multimodel_plan_b_route;
 const entry=verified?{
  m1Route:r.m1_route,
  route:m.multimodel_plan_b_route,
  authority:m.multimodel_execution_authority_path??'UNKNOWN',
  regime:en.regime??null,
  consensus:n(en.consensusPassed),
  planBScore:n(en.ensembleScore),
  metaProbability:n(en.metaProbability),
  forecastNetR:n(gov.netExpectedR),
  m1Confidence:n(c.confidence),
  alignedM1Momentum3:n(c.alignedMomentum3Atr),
  alignedM5:n(c.alignedM5),
  alignedM5Momentum3:n(c.alignedM5Momentum3Atr),
  m5Body:n(c.alignedM5LatestBodyPressure),
  m5Body3:n(c.alignedM5BodyPressure3),
  alignedH1:n(c.alignedH1),
  alignedH4:n(c.alignedH4),
  alignedM15:n(c.alignedM15),
  alignedHigherAgreement:n(c.alignedHigherTimeframeAgreement),
  extension:n(c.alignedEmaSeparationAtr),
  expertState:ex.state??m.multimodel_trained_expert_state??null,
  expertDirection:ex.direction??m.multimodel_trained_expert_direction??null,
  expertLongVotes:n(ex.longVotes??m.multimodel_trained_expert_long_votes),
  expertShortVotes:n(ex.shortVotes??m.multimodel_trained_expert_short_votes),
  expertProbability:n(ex.meanOpportunityProbability??m.multimodel_trained_expert_opportunity_probability),
  expertFreshnessSeconds:n(ex.freshnessSeconds),
  expertAllBrokerNative:ex.allBrokerNative===true,
  spreadProvenance:gov.executionCostSource??null,
  drift:gov.driftState??null,
  advisoryRiskFraction:n(m.m1_advisory_quality_risk_fraction),
  m5SoftCapApplied:m.m1_reversal_m5_soft_cap_applied===true,
  patternHypothesis:m.m1_pattern_memory_hypothesis??null,
 } : null;
 return {
  tradeKey:r.trade_id,
  decisionAt:at==null?null:new Date(at).toISOString(),
  tradeDate:new Date(opened).toISOString().slice(0,10),
  openedAt:new Date(opened).toISOString(),closedAt:new Date(closed).toISOString(),
  instrument:r.instrument,direction:r.direction,
  entryRoute:m.multimodel_plan_b_route??null,
  lot,netUsd:net,netUsdPerLot:round(net/lot,2),
  label:net>0?'WIN':net<0?'LOSS':'FLAT',
  matchedDecision:!!entry,
  entry,
  outcomeOnly:{
   closeReason:r.close_reason??null,
   maxFavorableUsd:n(r.max_favorable_pnl),
   maxAdverseUsd:n(r.max_adverse_pnl),
   positivePeakThenLoss:net<0&&n(r.max_favorable_pnl)>0,
  },
 };
}
const FLAGS=Object.freeze([
 ['M1_ABSTAIN',e=>e.m1Route==='ABSTAIN'],
 ['TRAINED_EXPERT_ABSTAIN',e=>e.expertState==='ABSTAIN'],
 ['TRAINED_EXPERT_OPPOSITE', (e,r)=>e.expertDirection!=null&&e.expertDirection!==r.direction],
 ['EXPERT_OPPORTUNITY_LT_030',e=>e.expertProbability!=null&&e.expertProbability<.30],
 ['M5_DIRECTION_OPPOSES',e=>e.alignedM5!=null&&e.alignedM5<-.20],
 ['M5_BODY_OPPOSES',e=>e.m5Body!=null&&e.m5Body<-.30],
 ['M5_BODY3_OPPOSES',e=>e.m5Body3!=null&&e.m5Body3<-.30],
 ['M5_3BAR_MOMENTUM_OPPOSES',e=>e.alignedM5Momentum3!=null&&e.alignedM5Momentum3<-.30],
 ['M1_3BAR_MOMENTUM_OPPOSES',e=>e.alignedM1Momentum3!=null&&e.alignedM1Momentum3<-.30],
 ['H1_DIRECTION_OPPOSES',e=>e.alignedH1!=null&&e.alignedH1<-.25],
 ['H4_DIRECTION_OPPOSES',e=>e.alignedH4!=null&&e.alignedH4<-.25],
 ['H1_AND_H4_OPPOSE',e=>e.alignedH1!=null&&e.alignedH4!=null&&e.alignedH1<-.25&&e.alignedH4<-.25],
 ['M5_AND_H1_OPPOSE',(e)=>e.alignedM5!=null&&e.alignedH1!=null&&e.alignedM5<-.20&&e.alignedH1<-.25],
 ['M5_BODY_AND_H1_OPPOSE',(e)=>e.m5Body!=null&&e.alignedH1!=null&&e.m5Body<-.30&&e.alignedH1<-.25],
 ['PLAN_B_META_LT_053',e=>e.metaProbability!=null&&e.metaProbability<.53],
 ['PLAN_B_SCORE_LT_064',e=>e.planBScore!=null&&e.planBScore<.64],
 ['NET_EXPECTED_R_LT_012',e=>e.forecastNetR!=null&&e.forecastNetR<.12],
 ['M1_CONFIDENCE_LT_068',e=>e.m1Confidence!=null&&e.m1Confidence<.68],
 ['PLAN_B_CONSENSUS_BELOW_7',e=>e.consensus!=null&&e.consensus<7],
 ['CAUTIOUS_SIZING_HALF_OR_LESS',e=>e.advisoryRiskFraction!=null&&e.advisoryRiskFraction<=.5],
 ['M5_REVERSAL_SOFT_CAP',e=>e.m5SoftCapApplied===true],
]);
function sum(rows) {
 const w=rows.filter(r=>r.label==='WIN'),l=rows.filter(r=>r.label==='LOSS');
 return {
  n:rows.length,wins:w.length,losses:l.length,flat:rows.length-w.length-l.length,
  winRate:rows.length?round(w.length/rows.length):null,
  netUsd:round(rows.reduce((a,r)=>a+r.netUsd,0),2),
  avgNetUsdPerLot:rows.length?round(rows.reduce((a,r)=>a+r.netUsdPerLot,0)/rows.length,2):null,
  days:new Set(rows.map(r=>r.tradeDate)).size,
 };
}
function by(rows,keyFn) {
 const x=new Map();
 for(const r of rows){const key=keyFn(r);if(!x.has(key))x.set(key,[]);x.get(key).push(r)}
 return [...x].map(([key,items])=>({key,...sum(items)})).sort((a,b)=>b.n-a.n||a.key.localeCompare(b.key));
}
function compareFlag(rows,filterFn) {
 const matched=rows.filter(r=>r.matchedDecision),yes=matched.filter(r=>filterFn(r.entry,r));
 const no=matched.filter(r=>!filterFn(r.entry,r));
 const y=sum(yes),z=sum(no);
 return {
  flagged:y,unflagged:z,
  flaggedLoseFraction:y.n?round(y.losses/y.n):null,
  unflaggedLoseFraction:z.n?round(z.losses/z.n):null,
  lossExcessFraction:y.n&&z.n?round(y.losses/y.n-z.losses/z.n):null,
  hypotheticalIfAvoidedFlagged:{
   lostWinners:y.wins,avoidedLosers:y.losses,
   removedNetUsd:y.netUsd,
   // A filter would remove ALL flagged wins as well as losses.
   inSampleIncrementalNetUsd:round(-y.netUsd,2),
  },
 };
}
function winRankingAuc(rows,field){
 const scored=rows.filter(r=>r.matchedDecision&&
  ['WIN','LOSS'].includes(r.label)&&r.entry&&r.entry[field]!=null&&
  Number.isFinite(r.entry[field]));
 const win=scored.filter(r=>r.label==='WIN').map(r=>r.entry[field]);
 const loss=scored.filter(r=>r.label==='LOSS').map(r=>r.entry[field]);
 if(win.length<1||loss.length<1)return {
  available:false,winners:win.length,losers:loss.length,auc:null};
 let pairs=0,correct=0;
 for(const a of win)for(const b of loss){pairs++;correct+=a>b?1:a===b?.5:0}
 return {available:true,winners:win.length,losers:loss.length,
  auc:round(correct/pairs,4),pairComparisons:pairs,
  meaning:'AUC_GT_0_5_MEANS_LARGER_ENTRY_SCORE_MORE_ASSOCIATED_WITH_WIN'};
}
function compare(rows) {
 const matches=rows.filter(r=>r.matchedDecision);
 const training=matches.filter(r=>r.tradeDate<CUTOFF),
 validation=matches.filter(r=>r.tradeDate>=CUTOFF);
 const routes=[...new Set(matches.map(r=>r.entryRoute))].sort();
 const comparisons=FLAGS.flatMap(([flag,fn])=>['ALL',...routes].map(route=>{
  const all=route==='ALL'?matches:matches.filter(r=>r.entryRoute===route);
  const pre=route==='ALL'?training:training.filter(r=>r.entryRoute===route);
  const later=route==='ALL'?validation:validation.filter(r=>r.entryRoute===route);
  const full=compareFlag(all,fn),train=compareFlag(pre,fn),test=compareFlag(later,fn);
  const exploratoryRepeat=
    train.flagged.n>=6&&train.unflagged.n>=6&&test.flagged.n>=5&&test.unflagged.n>=5&&
    train.lossExcessFraction!=null&&test.lossExcessFraction!=null&&
    train.lossExcessFraction>=.10&&test.lossExcessFraction>=.10;
  return {flag,route,all:full,discoveryNov17Nov18:train,laterNov19:test,
   exploratoryRepeat,executableVeto:false};
 }));
 const byTrade=by(matches,r=>r.entryRoute+' / '+r.instrument+' '+r.direction);
 const byExpert=by(matches,r=>r.entryRoute+' / '+r.entry.expertState+' / '+(r.entry.expertDirection===r.direction?'WITH':r.entry.expertDirection?'AGAINST':'UNKNOWN'));
 const winners=matches.filter(r=>r.label==='WIN'),
       losers=matches.filter(r=>r.label==='LOSS');
 const statName=['planBScore','metaProbability','forecastNetR','m1Confidence','alignedM5','alignedH1','alignedH4','m5Body','alignedM1Momentum3','alignedM5Momentum3','expertProbability'];
 const contrasts=routes.map(route=>({
  route,
  byFeature:Object.fromEntries(statName.map(name=>{
    const average=list=>{const values=list.filter(r=>r.entryRoute===route).map(r=>r.entry[name]).filter(v=>v!=null);
      return {n:values.length,mean:values.length?round(values.reduce((a,b)=>a+b,0)/values.length):null}};
    return [name,{winners:average(winners),losers:average(losers)}]
  }))
 }));
 const peaks=by(matches.filter(r=>r.outcomeOnly.positivePeakThenLoss),r=>r.entryRoute);
 const instrumentalWarnings=['M5_DIRECTION_OPPOSES','M5_BODY_OPPOSES','M1_ABSTAIN'];
 const byInstrumentWarning=instrumentalWarnings.flatMap(flag=>{
   const fn=FLAGS.find(([name])=>name===flag)?.[1];
   if(!fn)return [];
   return [...new Set(matches.map(r=>r.entryRoute+' / '+r.instrument))]
    .sort().map(key=>{
      const rowsForKey=matches.filter(r=>r.entryRoute+' / '+r.instrument===key);
      return {flag,key,
       discovery:compareFlag(rowsForKey.filter(r=>r.tradeDate<CUTOFF),fn),
       later:compareFlag(rowsForKey.filter(r=>r.tradeDate>=CUTOFF),fn),
       noTradingAuthority:true};
    });
 });
 const rankingFeatures=['planBScore','forecastNetR','metaProbability',
  'm1Confidence','expertProbability','alignedM5','m5Body'];
 const forecastRanking=['ALL',...routes].flatMap(route=>
  ['discovery','later','all'].flatMap(period=>{
   const subset=route==='ALL'?matches:matches.filter(x=>x.entryRoute===route);
   const rowsForTime=period==='discovery'?subset.filter(x=>x.tradeDate<CUTOFF):
    period==='later'?subset.filter(x=>x.tradeDate>=CUTOFF):subset;
   return rankingFeatures.map(field=>({route,period,field,
    ...winRankingAuc(rowsForTime,field)}));
  })
 );
 const flaggedTop=comparisons.filter(r=>r.route!=='ALL'&&r.exploratoryRepeat);
 return {
  artifact:ARTIFACT,researchOnly:true,modifiesExecution:false,
  hasRetrainedModel:false,hasDeployedNewVeto:false,
  scope:'EXACT_OWNER_PEPPERSTONE_CTRADER_USD_DEMO',
  windowUTC:{from:FROM,to:TO,discoveryBefore:CUTOFF},
  allClosedTrades:rows.length,
  entryDecisionVerified:matches.length,
  unmatchedPreEntry:rows.length-matches.length,
  summary:sum(rows),matchedSummary:sum(matches),
  discoverySummary:sum(training),laterDateSummary:sum(validation),
  byRoute:by(matches,r=>r.entryRoute),
  byTradeDay:by(matches,r=>r.tradeDate),
  byRouteInstrumentDirection:byTrade,
  byInstrumentWarning,
  forecastRanking,
  byExpertStateDirection:byExpert,
  winnersVersusLosersFeatureMeans:contrasts,
  lostAfterPositiveBrokerPeak:peaks,
  exploratoryRepeatedWarnings:flaggedTop,
  allFlagComparisons:comparisons,
  limitations:[
   'All data are historical observed broker fills. This is not a randomized signal classifier.',
   'Discovery dates Nov17-18 and later Nov19 were already viewed for some purposes; later date is NOT pristine sealed holdout.',
   'Feature contrasts come only from exactly linked original pre-intent M1 snapshot; do not use settled PnL or peak as prediction input.',
   'Expert ABSTAIN is often present in both winners and losers, and candle-body pressure is not a trained candlestick expert confirmation.',
   'A seemingly profitable avoidance filter also removes flagged winning trades; false-positive cost is reported.',
   'Overlapping trades, correlated USD pairs, stop placement and variable lot sizes bias dollar profit comparisons.',
   'No warnings authorize or block trades; prospective matched bar and after-fee broker evidence is required.',
  ],
 };
}
async function main(){
 require('dotenv').config({path:path.resolve(__dirname,'..','.env'),quiet:true});
 const {Client}=require('pg'),owner=process.env.VPS_FOREX_SCANNER_USER_ID;
 if(!UUID.test(owner||''))throw Error('OWNER_DEMO_ID_REQUIRED');
 const db=new Client({host:process.env.DB_HOST||'localhost',port:+(process.env.DB_PORT||5432),
 user:process.env.DB_USER,password:process.env.DB_PASSWORD,database:process.env.DB_NAME,
 ssl:process.env.DB_SSL==='true'?{rejectUnauthorized:false}:undefined,
 connectionTimeoutMillis:8000,statement_timeout:23000});
 try{
  await db.connect();await db.query('BEGIN READ ONLY');
  const x=await db.query(SQL,[owner,'pepperstone-ctrader',FROM,TO]);
  await db.query('ROLLBACK');
  if(x.rows.length>MAX)throw Error('TRADE_QUERY_TRUNCATED');
  const trades=x.rows.map(normalize);
  const candles=await asofCandles.annotate(trades);
  const report={...compare(trades),preEntryCandleFormation:asofCandles.analyze(trades,candles)};
  fs.mkdirSync(path.dirname(OUT),{recursive:true,mode:0o700});
  fs.writeFileSync(OUT,JSON.stringify(report,null,2),{mode:0o600});
  const summarized={
   artifact:report.artifact,scope:report.scope,all:report.summary,
   lineage:report.entryDecisionVerified,discovery:report.discoverySummary,
   later:report.laterDateSummary,byRoute:report.byRoute,
   byExpertStateDirection:report.byExpertStateDirection,
   forecastRanking:report.forecastRanking,
   repeated:report.exploratoryRepeatedWarnings.map(x=>({
    flag:x.flag,route:x.route,train:x.discoveryNov17Nov18,
    later:x.laterNov19,
   })),
   flags:report.allFlagComparisons.filter(x=>x.route!=='ALL').map(x=>({
    flag:x.flag,route:x.route,discovery:x.discoveryNov17Nov18,
    later:x.laterNov19,
   })),
   candleCoverage:report.preEntryCandleFormation.coverage,
   candleRouteCoverage:report.preEntryCandleFormation.byRouteBothVerified,
   candleFlags:report.preEntryCandleFormation.formationComparisons.map(x=>({
    flag:x.flag,route:x.route,eligibleVerifiedBoth:x.eligibleVerifiedBoth,
    discovery:x.discoveryNov17Nov18,later:x.laterNov19,
   })),
   output:OUT
  };
  console.log('WIN_LOSS_FORMATION_REPORT',JSON.stringify(summarized).slice(0,42000));
 }finally{await db.end().catch(()=>{})}
}
module.exports={ARTIFACT,SQL,FLAGS,normalize,compare,compareFlag,sum,winRankingAuc};
if(require.main===module)main().catch(e=>{console.error('ENTRY_FORMATION_RESEARCH_ERROR',e.message);process.exitCode=1});
