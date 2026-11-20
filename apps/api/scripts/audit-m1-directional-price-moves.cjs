// iRexPro DEMO: read-only as-of M1 forecast calibration audit.
// It NEVER sends broker orders, changes risk controls or promotes a model.
// Run from apps/api: node scripts/audit-m1-directional-price-moves.cjs
const fs = require('fs');
const path = require('path');
require('dotenv').config({path:path.resolve(__dirname,'../.env'),quiet:true});
const {Client} = require('pg');

const PIP=0.0001;
const EST_COMMISSION_PIPS=0.9;
const EST_SLIPPAGE_PIPS=0.2;
const HORIZONS=[1,3,5,10,30,60];
const PAIRS=['EURUSD','AUDUSD'];
const MS_PER_MIN=60_000;

function stats(values) {
  const wins=values.filter(v=>v>0),losses=values.filter(v=>v<0);
  const positive=wins.reduce((a,b)=>a+b,0);
  const negative=-losses.reduce((a,b)=>a+b,0);
  return {observations:values.length,
    winRate:values.length?Number((wins.length/values.length).toFixed(3)):null,
    netPips:Number(values.reduce((a,b)=>a+b,0).toFixed(2)),
    meanNetPips:values.length?Number((values.reduce((a,b)=>a+b,0)/values.length).toFixed(3)):null,
    profitFactor:negative>0?Number((positive/negative).toFixed(3)):null};
}
async function main(){
  const db=new Client({host:process.env.DB_HOST,port:+(process.env.DB_PORT||5432),
    database:process.env.DB_NAME,user:process.env.DB_USER,
    password:process.env.DB_PASSWORD,ssl:process.env.DB_SSL==='true'?{rejectUnauthorized:false}:false,
    statement_timeout:20000});
  await db.connect();
  try {
    const session=await db.query(`SELECT s.user_id,s.broker_connection_id,
      b.broker_id,b.account_type
      FROM trading.trading_sessions s JOIN broker.broker_connections b
      ON b.id=s.broker_connection_id AND b.user_id=s.user_id
      WHERE s.status='ACTIVE' AND s.execution_mode='FULL_AUTO'
      ORDER BY s.started_at DESC LIMIT 1`);
    if(session.rowCount!==1 || session.rows[0].broker_id!=='pepperstone-ctrader'
      || session.rows[0].account_type!=='DEMO')
      throw Error('Read-only audit requires connected Pepperstone FULL_AUTO DEMO');
    const {user_id,broker_connection_id}=session.rows[0];
    const decisions=await db.query(`SELECT instrument,direction,route,bar_time,evaluated_at,
        governance->'multimodelGovernance'->>'netExpectedR' AS estimated_net_r,
        governance->'multimodelEnsemble'->>'paperAdmitted' AS planb_admitted,
        governance->'genericGovernance'->>'driftState' AS drift_state,
        execution_authority
      FROM trading.m1_tactical_decisions
      WHERE user_id=$1 AND broker_connection_id=$2
        AND instrument=ANY($3::text[])
        AND bar_time >= now()-interval '72 hours'
        AND bar_time < now()-interval '65 minutes'
      ORDER BY bar_time ASC LIMIT 20000`,
      [user_id,broker_connection_id,PAIRS]);
    const quotes=await db.query(`SELECT instrument,bucket_time,bid_close,ask_close
      FROM market_data.provider_quote_candles
      WHERE connection_id=$1 AND instrument=ANY($2::text[])
        AND timeframe='M1' AND bucket_time >= now()-interval '74 hours'
        AND bucket_time < date_trunc('minute',now())-interval '1 minute'
        AND bid_close>0 AND ask_close>=bid_close
      ORDER BY instrument,bucket_time`,[broker_connection_id,PAIRS]);
    const marks=new Map(quotes.rows.map(r=>[
      r.instrument+'|'+new Date(r.bucket_time).getTime(),
      {bid:Number(r.bid_close),ask:Number(r.ask_close)}]));
    // Differentiate every measured BUY/SELL hypothesis from *actual* M1
    // routed candidates. An ABSTAIN-side forecast is not an executable
    // recommendation and must never be presented as one.
    function firstSignalInEachClockBucket(rows, predicate) {
      const seen=new Set(), selected=[];
      for(const r of rows) {
        if(!predicate(r))continue;
        const stamp=new Date(r.evaluated_at).getTime();
        if(!Number.isFinite(stamp))continue;
        const key=r.instrument+'|'+r.direction+'|'+Math.floor(stamp/(15*MS_PER_MIN));
        if(seen.has(key))continue;
        seen.add(key);
        selected.push({instrument:r.instrument,direction:r.direction,
          route:r.route,barTime:new Date(r.bar_time).toISOString(),
          entryTime:Math.floor(stamp/MS_PER_MIN)*MS_PER_MIN+MS_PER_MIN,
          estimatedNetR:Number(r.estimated_net_r),
          planBAdmitted:r.planb_admitted==='true',drift:r.drift_state});
      }
      return selected;
    }
    const families={
      ALL_BUY_SELL_HYPOTHESES:firstSignalInEachClockBucket(decisions.rows,()=>true),
      M1_ROUTED_CANDIDATES:firstSignalInEachClockBucket(
        decisions.rows,r=>r.route!=='ABSTAIN'),
      PLAN_B_PAPER_ADMITTED:firstSignalInEachClockBucket(
        decisions.rows,r=>r.planb_admitted==='true' && r.route!=='ABSTAIN'),
    };
    const entries=[];
    for(const [family,sample] of Object.entries(families)) {
      for(const h of HORIZONS){
        const nextEligible=new Map();
        for(const signal of sample) {
          const side=signal.instrument+'|'+signal.direction;
          if(signal.entryTime < (nextEligible.get(side)||0))continue;
          const entry=marks.get(signal.instrument+'|'+signal.entryTime);
          const later=marks.get(signal.instrument+'|'+(signal.entryTime+h*MS_PER_MIN));
          if(!entry||!later)continue;
          const buy=(later.bid-entry.ask)/PIP-EST_COMMISSION_PIPS-EST_SLIPPAGE_PIPS;
          const sell=(entry.bid-later.ask)/PIP-EST_COMMISSION_PIPS-EST_SLIPPAGE_PIPS;
          const net=signal.direction==='BUY'?buy:sell;
          entries.push({family,instrument:signal.instrument,direction:signal.direction,
            route:signal.route,planBAdmitted:signal.planBAdmitted,
            utcDay:new Date(signal.entryTime).toISOString().slice(0,10),
            h,net,oracleBest:Math.max(buy,sell)});
          nextEligible.set(side,signal.entryTime+h*MS_PER_MIN);
        }
      }
    }
    const report={
      artifact:'irexpro-m1-both-sides-asof-broker-mark-audit-v2',
      authority:'RESEARCH_ONLY_NO_BROKER_ORDERS',
      calculatedAtUTC:new Date().toISOString(),pairs:PAIRS,horizonsMinutes:HORIZONS,
      brokerDataSource:'ACTIVE_PEPPERSTONE_CTRADER_DEMO_M1',
      rawDecisionRows:decisions.rowCount,
      sampled15mWindows:Object.fromEntries(
        Object.entries(families).map(([name,rows])=>[name,rows.length])),
      quoteRows:quotes.rowCount,
      assumptions:{realBrokerBidAsk:true,estimatedRoundTripCommissionPips:EST_COMMISSION_PIPS,
        extraSlippagePips:EST_SLIPPAGE_PIPS,
        nonOverlappingPerInstrumentDirection:true,
        entryAtNextMinuteMark:true,
        noStopLossOrTakeProfitFirstTouch:true,
        oracleHindsightOnly:true,
        allHypothesesIncludeAbstain:true,
        m1RoutedDoesNotImplyBrokerExecution:true},
      results:[]
    };
    for(const family of Object.keys(families)){
      for(const h of HORIZONS){
        for(const instrument of PAIRS){
          const group=entries.filter(x=>x.family===family&&x.h===h&&x.instrument===instrument);
          if(!group.length)continue;
          report.results.push({
            family,horizonMinutes:h,instrument,
            markResults:stats(group.map(x=>x.net)),
            hindsightBestDirection:stats(group.map(x=>x.oracleBest)),
            byDirection:Object.fromEntries(['BUY','SELL'].map(d=>[d,stats(group.filter(x=>x.direction===d).map(x=>x.net))])),
            byUtcDay:Object.fromEntries([...new Set(group.map(x=>x.utcDay))].sort().map(day=>[day,stats(group.filter(x=>x.utcDay===day).map(x=>x.net))])),
          });
        }
      }
    }
    const output=process.argv[2] ||
      '/tmp/irexpro-m1-directional-audit-v2-'+new Date().toISOString().replace(/[-:.]/g,'')+'.json';
    if(!/^\/tmp\/irexpro-[A-Za-z0-9-]+\.json$/.test(output))
      throw Error('Output must be a private /tmp/irexpro-*.json file');
    fs.writeFileSync(output,JSON.stringify(report,null,2),{flag:'wx',mode:0o600});
    console.log(JSON.stringify({output,rawDecisions:report.rawDecisionRows,
      sampledWindows:report.sampled15mWindows,
      summary:report.results.filter(r=>[5,10,30].includes(r.horizonMinutes)).map(r=>({
        family:r.family,pair:r.instrument,h:r.horizonMinutes,
        markResults:r.markResults,byDay:r.byUtcDay
      }))},null,2));
  } finally {await db.end()}
}
main().catch(e=>{console.error('AUDIT_FAILED',e.code||'',e.message);process.exitCode=1});
