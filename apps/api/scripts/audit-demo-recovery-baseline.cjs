/**
 * Read-only iRexPro DEMO recovery benchmark.
 *
 * Freezes the interpretation of the Nov 11/12 Pepperstone broker ledger and
 * independent Plan B/M1 M1 scan funnel, not a cherry-picked winning session.
 * No order, allocation, policy, trading session or database writes.
 *
 * Run: cd apps/api && node scripts/audit-demo-recovery-baseline.cjs
 */
const path=require('node:path');
require('dotenv').config({path:path.resolve(__dirname,'../.env'),quiet:true});
const {Client}=require('pg');

const ARTIFACT='irexpro-demo-recovery-baseline-v1';
const BASELINE_DAYS=['2026-11-10','2026-11-11','2026-11-12'];
const FOCUSED_PAIRS=new Set(['EURUSD','AUDUSD']);
const ALL_MAJORS=new Set(['EURUSD','AUDUSD','GBPUSD','USDCHF','USDJPY','USDCAD']);

function finiteMoney(value) {
  if (value===null||value===undefined||value==='')return null;
  const parsed=Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function rounded(value,places=2){return Number(value.toFixed(places))}
function tradeNet(t){
  const gross=finiteMoney(t.realised_pnl);
  const commission=finiteMoney(t.commission);
  const swap=finiteMoney(t.swap);
  if(gross===null||commission===null||swap===null)return null;
  return gross+commission+swap;
}
function groupTrades(trades){
  let complete=0,incomplete=0,winning=0,losing=0,flat=0;
  let net=0,fees=0,winSum=0,lossSum=0,peak=0,cumulative=0,maxDrawdown=0;
  for(const trade of trades){
    const pnl=tradeNet(trade);
    if(pnl===null){incomplete++;continue;}
    complete++;net+=pnl;
    fees+=Number(trade.commission)+Number(trade.swap);
    if(pnl>0){winning++;winSum+=pnl}
    else if(pnl<0){losing++;lossSum+=-pnl}else flat++;
    cumulative+=pnl;peak=Math.max(peak,cumulative);
    maxDrawdown=Math.max(maxDrawdown,peak-cumulative);
  }
  return {
    deals:trades.length,
    completeFeeDeals:complete,
    incompleteFeeDeals:incomplete,
    winners:winning,losers:losing,flat,
    net:rounded(net),netFees:rounded(fees),
    averageNetPerTrade:complete?rounded(net/complete):null,
    netProfitFactor:lossSum>0?rounded(winSum/lossSum,3):null,
    maxClosedTradeDrawdown:rounded(maxDrawdown),
    eligibleForAutomaticPromotion:false,
    reason:'THREE_DAYS_NOT_OUT_OF_SAMPLE_STRATEGY_VALIDATION',
  };
}
function compareFunnel(rows){
  const result={};
  for(const r of rows){
    const key=r.utc_day+':'+r.instrument;
    const scans=Number(r.scans),m1=Number(r.m1_routed),
      planB=Number(r.planb_paper_admitted),overlap=Number(r.route_overlap);
    const authorized=Number(r.broker_authorized);
    if(![scans,m1,planB,overlap,authorized].every(Number.isInteger)
      ||m1>scans||planB>scans||overlap>Math.min(m1,planB))
      throw Error('Invalid decision funnel '+key);
    result[key]={
      scans,m1Routed:m1,planBPaperAdmitted:planB,
      eligibleOverlap:overlap,
      planBOnly:planB-overlap,m1Only:m1-overlap,
      brokerAuthorized:authorized,
      overlapRateOfScans:scans?rounded(overlap/scans,4):null,
      // PlanB paper admission is not equivalent to broker authority.
      admissionIsNotBrokerExecution:true,
    };
  }
  return result;
}
async function audit(){
  const db=new Client({
    host:process.env.DB_HOST,port:Number(process.env.DB_PORT||5432),
    database:process.env.DB_NAME,user:process.env.DB_USER,
    password:process.env.DB_PASSWORD,
    ssl:process.env.DB_SSL==='true'?{rejectUnauthorized:false}:false,
    statement_timeout:20000,connectionTimeoutMillis:7000,
  });
  await db.connect();
  try{
    await db.query('BEGIN READ ONLY');
    const active=await db.query(`
      SELECT s.user_id,s.broker_connection_id,s.status,s.execution_mode,
        b.broker_id,b.account_type,b.status AS broker_status
      FROM trading.trading_sessions s
      JOIN broker.broker_connections b
        ON b.id=s.broker_connection_id AND b.user_id=s.user_id
      WHERE s.status='ACTIVE'
      ORDER BY s.started_at DESC LIMIT 1
    `);
    const owner=active.rows[0];
    if(!owner||owner.execution_mode!=='FULL_AUTO'
      ||owner.broker_id!=='pepperstone-ctrader'
      ||owner.account_type!=='DEMO'
      ||owner.broker_status!=='CONNECTED')
      throw Error('Owner-bound ACTIVE FULL_AUTO Pepperstone DEMO not verified');
    const trades=await db.query(`
      SELECT to_char(t.created_at AT TIME ZONE 'UTC','YYYY-MM-DD') AS utc_day,
        t.created_at,t.instrument,t.direction,t.realised_pnl,t.commission,t.swap,
        t.lot_size,t.status,
        ti.strategy_code,ti.metadata->>'multimodel_execution_authority_path' authority_path,
        ti.metadata->>'m1_tactical_route' route,
        ti.metadata->>'m1_rollout_policy_version' rollout
      FROM trading.trades t
      LEFT JOIN trading.trade_intents ti
        ON ti.id=t.trade_intent_id AND ti.user_id=t.user_id
        AND ti.broker_connection_id=t.broker_connection_id
      WHERE t.user_id=$1 AND t.broker_connection_id=$2
        AND t.created_at >= $3::timestamptz
        AND t.created_at < $4::timestamptz
        AND t.instrument=ANY($5::text[])
        AND t.status='CLOSED'
      ORDER BY t.created_at
    `,[
      owner.user_id,owner.broker_connection_id,
      '2026-11-10T00:00:00Z','2026-11-13T00:00:00Z',
      [...ALL_MAJORS],
    ]);
    const decisions=await db.query(`
      SELECT to_char(evaluated_at AT TIME ZONE 'UTC','YYYY-MM-DD') AS utc_day,
        instrument,count(*)::int scans,
        count(*) FILTER(WHERE route <> 'ABSTAIN')::int m1_routed,
        count(*) FILTER(
          WHERE governance->'multimodelEnsemble'->>'paperAdmitted'='true'
        )::int planb_paper_admitted,
        count(*) FILTER(
          WHERE route <> 'ABSTAIN' AND
            governance->'multimodelEnsemble'->>'paperAdmitted'='true'
        )::int route_overlap,
        count(*) FILTER(WHERE execution_authority='BROKER_NATIVE')::int broker_authorized
      FROM trading.m1_tactical_decisions
      WHERE user_id=$1 AND broker_connection_id=$2
        AND evaluated_at >= $3::timestamptz
        AND evaluated_at < $4::timestamptz
        AND instrument=ANY($5::text[])
      GROUP BY 1,2 ORDER BY 1,2
    `,[
      owner.user_id,owner.broker_connection_id,
      '2026-11-10T00:00:00Z','2026-11-13T00:00:00Z',
      [...FOCUSED_PAIRS],
    ]);
    // A pre-correction minute candle is not proof of a tradable bid/ask.
    // The baseline may use actual broker fills but MUST NOT promote a
    // historical missed-entry counterfactual without true positive spreads.
    const quoteCounts=await db.query(`
      SELECT to_char(bucket_time AT TIME ZONE 'UTC','YYYY-MM-DD') AS utc_day,
        instrument,count(*)::int candle_minutes,
        count(*) FILTER(
          WHERE last_positive_bid > 0
            AND last_positive_ask > last_positive_bid
            AND last_positive_sample_at >= bucket_time
            AND last_positive_sample_at < bucket_time + interval '1 minute'
        )::int positive_quote_minutes
      FROM market_data.provider_quote_candles
      WHERE connection_id=$1 AND timeframe='M1'
        AND bucket_time >= $2::timestamptz
        AND bucket_time < $3::timestamptz
        AND instrument=ANY($4::text[])
      GROUP BY 1,2 ORDER BY 1,2
    `,[
      owner.broker_connection_id,
      '2026-11-10T00:00:00Z','2026-11-13T00:00:00Z',
      [...FOCUSED_PAIRS],
    ]);
    const report={artifact:ARTIFACT,createdAtUTC:new Date().toISOString(),
      mode:'READ_ONLY_REPRODUCIBLE_BROKER_BASELINE',
      ownerVerified:true,
      account:'PEPPERSTONE_CTRADER_DEMO',
      dataTimezone:'UTC_GHANA',
      tradesByDay:{},byPairDay:{},funnel:compareFunnel(decisions.rows),
      quoteCoverage:{},
      unverifiedHistoryCannotAuthorizeStrategyPromotion:true,
      strategyAttribution:{},qualification:{
        automaticPromotion:false,brokerOrdersSubmitted:false,
        executionLogicChanged:false,
        caution:'Positive historical session is not out-of-sample edge',
      },
    };
    for(const q of quoteCounts.rows) {
      const minutes=Number(q.candle_minutes);
      const verified=Number(q.positive_quote_minutes);
      report.quoteCoverage[q.utc_day+':'+q.instrument]={
        candleMinutes:minutes,
        verifiedPositiveBidAskMinutes:verified,
        verifiedMinuteFraction:minutes?rounded(verified/minutes,4):null,
        missingVerifiedQuotesDisallowStopFirstReplay:verified<minutes,
      };
    }
    for(const day of BASELINE_DAYS){
      const sample=trades.rows.filter(t=>t.utc_day===day);
      const focused=sample.filter(t=>FOCUSED_PAIRS.has(t.instrument));
      const other=sample.filter(t=>!FOCUSED_PAIRS.has(t.instrument));
      report.tradesByDay[day]={
        allSix:groupTrades(sample),focusedTwo:groupTrades(focused),
        otherFour:groupTrades(other),
      };
      for(const pair of ALL_MAJORS){
        const selected=sample.filter(t=>t.instrument===pair);
        report.byPairDay[day+':'+pair]=groupTrades(selected);
      }
      for(const t of sample){
        const strategy=(t.authority_path||'NO_INTENT_PROVENANCE');
        const k=day+':'+t.instrument+':'+strategy;
        report.strategyAttribution[k]=(report.strategyAttribution[k]||0)+1;
      }
    }
    console.log('DEMO_RECOVERY_BASELINE '+JSON.stringify(report));
    await db.query('ROLLBACK');
  }finally{await db.end()}
}
if(require.main===module)audit().catch(e=>{
  console.error('DEMO_RECOVERY_BASELINE_FAILED',e.code||'',e.message);
  process.exitCode=1;
});
module.exports={finiteMoney,tradeNet,groupTrades,compareFunnel};
