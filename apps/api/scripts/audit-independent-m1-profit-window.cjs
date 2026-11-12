/**
 * READ-ONLY prospective M1 opportunity/quick-profit counterfactual.
 *
 * Scores independently-eligible M1 specialist decisions EVEN IF Plan B
 * vetoed them. This is NOT a broker fill report, a production backtest, a
 * trade recommendation or model-promotion authority. The sampled portfolio
 * uses a frozen first-signal-per-15-minute rule, not hindsight.
 *
 * Usage (on staging): node scripts/audit-independent-m1-profit-window.cjs
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env'), quiet: true });
const { Client } = require('pg');
const { randomUUID } = require('crypto');

const ARTIFACT = 'independent-m1-profit-window-shadow-v1';
const PIP = 0.0001;
const COST_EXTRA_PIPS = 1.1; // conservative estimated commission + slip
const HORIZONS = [3, 5, 6, 7, 10];
const QUICK_TP_PIPS = [1.5, 2, 3];
const MINUTE_MS = 60_000;

function isPositiveObservedMark(bar) {
  if (!bar) return false;
  const minute = new Date(bar.bucket_time).getTime();
  const lastSample = new Date(bar.last_positive_sample_at).getTime();
  const realSample = Number.isFinite(lastSample)
    && lastSample >= minute && lastSample < minute + MINUTE_MS
    && Number(bar.last_positive_bid) > 0
    && Number(bar.last_positive_ask) > Number(bar.last_positive_bid);
  return realSample ||
    (Number(bar.bid_close) > 0 && Number(bar.ask_close) > Number(bar.bid_close));
}

function observedMark(bar) {
  if (!isPositiveObservedMark(bar)) return null;
  const hasLive = Number(bar.last_positive_bid) > 0
    && Number(bar.last_positive_ask) > Number(bar.last_positive_bid)
    && new Date(bar.last_positive_sample_at).getTime() >= new Date(bar.bucket_time).getTime()
    && new Date(bar.last_positive_sample_at).getTime() < new Date(bar.bucket_time).getTime() + MINUTE_MS;
  return hasLive
    ? { bid: Number(bar.last_positive_bid), ask: Number(bar.last_positive_ask), source: 'POSITIVE_INTRAMINUTE' }
    : { bid: Number(bar.bid_close), ask: Number(bar.ask_close), source: 'POSITIVE_CLOSE' };
}

function quickProfitFirstTouch({ direction, entry, stop, capturePips, bars, quoteSpreadPips }) {
  // This is a pessimistic OHLC proxy: cannot determine tick order within a
  // minute. A stop hit on the same M1 candle wins over a target hit.
  if (!bars.length || !Number.isFinite(quoteSpreadPips)) return { status: 'NO_BARS' };
  const quickTarget = direction === 'BUY' ? entry + capturePips * PIP : entry - capturePips * PIP;
  for (const bar of bars) {
    const midHigh = Number(bar.high), midLow = Number(bar.low);
    if (!Number.isFinite(midHigh) || !Number.isFinite(midLow)) return { status: 'DATA_GAP' };
    const stopHit = direction === 'BUY'
      ? midLow <= stop
      : midHigh + quoteSpreadPips * PIP >= stop;
    const tpHit = direction === 'BUY'
      ? midHigh >= quickTarget
      : midLow + quoteSpreadPips * PIP <= quickTarget;
    if (stopHit) return {
      status: 'STOP_FIRST', netPips: -Math.abs(entry - stop) / PIP - COST_EXTRA_PIPS,
    };
    if (tpHit) return { status: 'QUICK_TP_PROXY', netPips: capturePips - COST_EXTRA_PIPS };
  }
  return { status: 'NO_FIRST_TOUCH' };
}

function summarize(values) {
  const numbers = values.filter(Number.isFinite);
  const profit = numbers.filter(x => x > 0).reduce((a, b) => a+b, 0);
  const loss = -numbers.filter(x => x < 0).reduce((a, b) => a+b, 0);
  return {
    evaluated: numbers.length,
    netPips: +numbers.reduce((a, b) => a+b, 0).toFixed(2),
    profitable: numbers.filter(x => x > 0).length,
    winRate: numbers.length ? +(numbers.filter(x => x > 0).length/numbers.length).toFixed(3) : null,
    profitFactor: loss > 0 ? +(profit/loss).toFixed(3) : null,
  };
}

async function main() {
  const db = new Client({
    host: process.env.DB_HOST,
    port: +(process.env.DB_PORT || 5432),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
    statement_timeout: 18000,
  });
  await db.connect();
  try {
    const active = await db.query(`
      SELECT s.user_id, s.broker_connection_id, b.broker_id, b.account_type
      FROM trading.trading_sessions s
      JOIN broker.broker_connections b ON b.id=s.broker_connection_id AND b.user_id=s.user_id
      WHERE s.status='ACTIVE' AND s.execution_mode='FULL_AUTO'
      ORDER BY s.started_at DESC LIMIT 1`);
    if (active.rowCount!==1 || active.rows[0].broker_id!=='pepperstone-ctrader'
      || active.rows[0].account_type!=='DEMO')
      throw Error('Refusing analysis without owner-bound Pepperstone FULL_AUTO DEMO');
    const { user_id, broker_connection_id } = active.rows[0];
    const decisions=await db.query(`
      SELECT instrument,direction,route,evaluated_at,blockers,
        candidate->>'entry' AS entry,
        candidate->>'stopLoss' AS sl,
        candidate->>'takeProfit' AS tp,
        governance->'independentM1OpportunityShadow'->>'eligibleForStudy' AS eligible,
        governance->'independentM1OpportunityShadow'->>'planBDisagrees' AS planb_disagreed,
        governance->'independentM1OpportunityShadow'->>'m1NetExpectedR' AS m1_r
      FROM trading.m1_tactical_decisions
      WHERE user_id=$1 AND broker_connection_id=$2
        AND instrument=ANY($3::text[])
        AND evaluated_at>now()-interval '48 hours'
        AND evaluated_at<now()-interval '15 minutes'
        AND governance->'independentM1OpportunityShadow'->>'eligibleForStudy'='true'
        AND governance->'independentM1OpportunityShadow'->>'planBDisagrees'='true'
      ORDER BY evaluated_at LIMIT 10000
    `,[user_id,broker_connection_id,['EURUSD','AUDUSD']]);
    const candles=await db.query(`
      SELECT instrument,bucket_time,high,low,bid_close,ask_close,
        last_positive_bid,last_positive_ask,last_positive_sample_at
      FROM market_data.provider_quote_candles
      WHERE connection_id=$1 AND timeframe='M1'
        AND instrument=ANY($2::text[])
        AND bucket_time>now()-interval '49 hours'
        AND bucket_time<date_trunc('minute',now())
      ORDER BY instrument,bucket_time
    `,[broker_connection_id,['EURUSD','AUDUSD']]);
    const marks = new Map(candles.rows.map(bar=>[
      bar.instrument+'|'+new Date(bar.bucket_time).getTime(),bar,
    ]));
    const seenSlots=new Set(), eligible=[];
    for(const d of decisions.rows) {
      const stamp=new Date(d.evaluated_at).getTime();
      const slot=d.instrument+'|'+d.direction+'|'+Math.floor(stamp/(15*MINUTE_MS));
      if (seenSlots.has(slot))continue;
      seenSlots.add(slot);
      eligible.push(d);
    }
    const records=[];
    for(const d of eligible) {
      const stamp=new Date(d.evaluated_at).getTime();
      const source=marks.get(d.instrument+'|'+(stamp-MINUTE_MS));
      const startMark=observedMark(source);
      if(!startMark) continue;
      const entry=d.direction==='SELL'?startMark.bid:startMark.ask;
      const sl=Number(d.sl),tp=Number(d.tp);
      if(!Number.isFinite(sl)||!Number.isFinite(tp))continue;
      const observedCostSpreadPips=(startMark.ask-startMark.bid)/PIP;
      const record={
        pair:d.instrument, direction:d.direction, time:new Date(stamp).toISOString(),
        source:startMark.source, planBDisagreed:true, horizons: {},
      };
      for(const h of HORIZONS) {
        const period=[];
        let gap=false;
        for(let n=0;n<h;n++) {
          const bar=marks.get(d.instrument+'|'+(stamp+n*MINUTE_MS));
          if(!bar || !observedMark(bar)){gap=true;break}
          period.push(bar);
        }
        if(gap) {record.horizons[h]={state:'UNOBSERVABLE_POSITIVE_QUOTE_GAP'};continue;}
        const exitMark=observedMark(period.at(-1));
        const quotePips=(d.direction==='SELL'
          ? (entry-exitMark.ask) / PIP
          : (exitMark.bid-entry) / PIP) - COST_EXTRA_PIPS;
        const firstTouch = Object.fromEntries(QUICK_TP_PIPS.map(target=>[
          String(target),
          quickProfitFirstTouch({
            direction:d.direction,entry,stop:sl,capturePips:target,
            bars:period,quoteSpreadPips:observedCostSpreadPips,
          }),
        ]));
        record.horizons[h]={
          state:'QUOTED_MARK_PROXY',
          fixedHoldNetPips:+quotePips.toFixed(3),
          earlyCapture:firstTouch,
          observedSpreadPips:+observedCostSpreadPips.toFixed(3),
          originalTpPips:+(Math.abs(tp-entry)/PIP).toFixed(2),
          originalStopPips:+(Math.abs(sl-entry)/PIP).toFixed(2),
        };
      }
      records.push(record);
    }
    const summary=[];
    for(const pair of ['EURUSD','AUDUSD'])for(const h of HORIZONS){
      const data=records.filter(r=>r.pair===pair&&r.horizons[h]?.state==='QUOTED_MARK_PROXY');
      summary.push({
        pair,horizonMinutes:h,
        fixedHold:summarize(data.map(r=>r.horizons[h].fixedHoldNetPips)),
        quickCapture:Object.fromEntries(QUICK_TP_PIPS.map(p=>[String(p),{
          firstTouchCases:data.filter(r=>r.horizons[h].earlyCapture[p]?.status==='QUICK_TP_PROXY').length,
          stopCases:data.filter(r=>r.horizons[h].earlyCapture[p]?.status==='STOP_FIRST').length,
          unobservedTouchCases:data.filter(r=>r.horizons[h].earlyCapture[p]?.status==='NO_FIRST_TOUCH').length,
        }])),
      });
    }
    const report = {
      artifact:ARTIFACT,mode:'READ_ONLY_RESEARCH',executionAuthority:'NONE',
      modifiesBrokerOrders:false,modifiesPositions:false,
      createdAtUTC:new Date().toISOString(),
      source:'PEPPERSTONE_CTRADER_DEMO_OWNER_BOUND',
      studiedSignalCount:decisions.rowCount,
      nonOverlappingFirstSignalSlots:eligible.length,
      independentlyPricedEpisodes:records.length,
      assumptions:{
        signalSelection:'FIRST_ELIGIBLE_PER_INSTRUMENT_DIRECTION_UTC_15MIN_SLOT',
        entry:'LAST_OBSERVED_POSITIVE_BID_ASK_PRECEDING_DECISION',
        exit:'LATEST_OBSERVED_POSITIVE_BID_ASK_AT_FUTURE_COMPLETED_M1',
        estimatedAdditionalCommissionAndSlippagePips:COST_EXTRA_PIPS,
        positiveQuoteMarkRequiredForEveryMinute:true,
        stopFirstWhenTPAndSLInSameM1:true,
        hypotheticalFirstTouchNotTickAccurate:true,
        sourceTradeIsNeverAnActualBrokerFill:true,
      },
      summary, episodes:records,
    };
    const name='/tmp/irexpro-m1-opportunity-'+new Date().toISOString().replace(/[-:.]/g,'')+'-'+randomUUID().slice(0,8)+'.json';
    fs.writeFileSync(name,JSON.stringify(report,null,2),{flag:'wx',mode:0o600});
    console.log(JSON.stringify({output:name,signalCount:decisions.rowCount,
      independentlyPricedEpisodes:records.length,summary},null,2));
  }finally{await db.end()}
}
if(require.main===module)main().catch(e=>{console.error('READ_ONLY_AUDIT_FAILED',e.code||'',e.message);process.exitCode=1});
module.exports={observedMark,isPositiveObservedMark,quickProfitFirstTouch,summarize};
