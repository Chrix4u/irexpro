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
const { randomUUID, createHash } = require('crypto');

const ARTIFACT = 'independent-m1-profit-window-shadow-v2';
const PIP = 0.0001;
const COST_EXTRA_PIPS = 1.1; // conservative estimated commission + slip
const HORIZONS = [3, 5, 6, 7, 10];
const QUICK_TP_PIPS = [1.5, 2, 3];
const MINUTE_MS = 60_000;
const MATURE_LAG_MINUTES = Math.max(...HORIZONS) + 2;
const RETROSPECTIVE_FLAG = '--retrospective';
// Explicitly separate legacy observations from separately recorded prospective
// decisions. Neither class qualifies a model without further independent tests.
const RESEARCH_RETROSPECTIVE_CUTOFF = '2026-11-12T17:32:00Z';

function eligibleLegacyM1(row) {
  if (row.route !== 'M1_TREND_CONTINUATION') return false;
  if (row.m1_route_eligible !== 'true' || row.m1_paper_eligible !== 'true') return false;
  if (row.spread_valid !== 'true' || row.event_risk !== 'CLEAR') return false;
  if (row.reliability_eligible !== 'true') return false;
  const entry=Number(row.entry), sl=Number(row.sl), tp=Number(row.tp);
  if (!Number.isFinite(entry)||!Number.isFinite(sl)||!Number.isFinite(tp)||entry<=0) return false;
  return row.direction==='BUY' ? sl<entry && tp>entry : sl>entry && tp<entry;
}

function closeQuickProfitPolicy(firstTouch, fixedHoldNetPips) {
  if (firstTouch.status === 'STOP_FIRST' || firstTouch.status === 'QUICK_TP_PROXY')
    return firstTouch.netPips;
  if (firstTouch.status === 'NO_FIRST_TOUCH') return fixedHoldNetPips;
  return null;
}


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
    // Candle high/low are midpoint proxies, not executable bid/ask highs.
    // For BUY both the stop and target are executed at BID; for SELL at ASK.
    // Treat a same-bar stop as first to avoid optimistic tick ordering.
    const stopHit = direction === 'BUY'
      ? midLow - quoteSpreadPips * PIP <= stop
      : midHigh + quoteSpreadPips * PIP >= stop;
    const tpHit = direction === 'BUY'
      ? midHigh - quoteSpreadPips * PIP >= quickTarget
      : midLow + quoteSpreadPips * PIP <= quickTarget;
    if (stopHit) return {
      status: 'STOP_FIRST', netPips: -Math.abs(entry - stop) / PIP - COST_EXTRA_PIPS,
    };
    if (tpHit) return { status: 'QUICK_TP_PROXY', netPips: capturePips - COST_EXTRA_PIPS };
  }
  return { status: 'NO_FIRST_TOUCH' };
}

/**
 * Pre-registered alternative entry timing: do NOT chase M1 confirmation
 * immediately. Wait at most 3 M1 candles for a one-pip pullback to a
 * passive limit. Never assume the best intrabar price or a fill that cannot
 * be inferred conservatively from high/low and the observed spread.
 *
 * This is an OHLC proxy, NOT a broker limit order fill or tick-accurate
 * intraminute path. Stop may be checked within the fill candle; TP cannot
 * win in that ambiguous same candle.
 */
function passivePullbackCounterfactual({
  direction, referenceEntry, originalStopDistancePips, bars,
  entryPullbackPips = 1, waitMinutes = 3,
  capturePips = 2, quoteSpreadPips, estimatedExtraCostPips = COST_EXTRA_PIPS,
}) {
  if(!['BUY','SELL'].includes(direction) ||
     !Number.isFinite(referenceEntry) || referenceEntry<=0 ||
     !Number.isFinite(originalStopDistancePips) || originalStopDistancePips<=0 ||
     !Number.isFinite(quoteSpreadPips) || quoteSpreadPips<=0 ||
     !Number.isInteger(waitMinutes) || waitMinutes<1 ||
     !Number.isFinite(entryPullbackPips) || entryPullbackPips<=0 ||
     !Array.isArray(bars) || !bars.length)
    return {state:'INVALID_STUDY_INPUT',netPips:null};
  const limit = direction==='SELL'
    ? referenceEntry + entryPullbackPips * PIP
    : referenceEntry - entryPullbackPips * PIP;
  const stop=direction==='SELL'
    ? limit + originalStopDistancePips * PIP
    : limit - originalStopDistancePips * PIP;
  const tp=direction==='SELL' ? limit-capturePips*PIP : limit+capturePips*PIP;
  let fillAt=-1;
  for(let i=0;i<bars.length;i++) {
    const b=bars[i];
    const high=Number(b.high),low=Number(b.low);
    if(!Number.isFinite(high)||!Number.isFinite(low)||high<low)
      return {state:'DATA_GAP',netPips:null};
    if(fillAt<0 && i<waitMinutes) {
      const conservativeFill=direction==='SELL'
        ? high-quoteSpreadPips*PIP>=limit
        : low+quoteSpreadPips*PIP<=limit;
      if(conservativeFill) fillAt=i;
    }
    if(fillAt<0)continue;
    const stopHit=direction==='SELL'
      ? high+quoteSpreadPips*PIP>=stop
      : low-quoteSpreadPips*PIP<=stop;
    if(stopHit) return {
      state:'STOP_FIRST_PROXY',entryPrice:limit,fillMinute:fillAt,
      netPips:-(originalStopDistancePips+estimatedExtraCostPips),
    };
    // Never claim a profitable TP on the same candle as an estimated
    // limit fill: ordering is unknown, whereas a stop is assumed first.
    if(i===fillAt)continue;
    const takeProfitHit=direction==='SELL'
      ? low+quoteSpreadPips*PIP<=tp
      : high-quoteSpreadPips*PIP>=tp;
    if(takeProfitHit) return {
      state:'TAKE_PROFIT_PROXY',entryPrice:limit,fillMinute:fillAt,
      netPips:capturePips-estimatedExtraCostPips,
    };
  }
  if(fillAt<0)return {state:'NOT_FILLED',netPips:null};
  const last = observedMark(bars.at(-1));
  if(!last) return {state:'DATA_GAP',netPips:null};
  const net=(direction==='SELL' ? (limit-last.ask)/PIP : (last.bid-limit)/PIP)
    - estimatedExtraCostPips;
  return {
    state:'TIMED_EXIT_PROXY',entryPrice:limit,fillMinute:fillAt,
    netPips:+net.toFixed(3),
  };
}

function fullyObservedQuotePath(bars, expectedMinutes) {
  return bars.length === expectedMinutes && bars.every(isPositiveObservedMark);
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
    const retrospective = process.argv.includes(RETROSPECTIVE_FLAG);
    if (process.argv.some(a=>a.startsWith('--') && a !== RETROSPECTIVE_FLAG))
      throw Error('Unsupported research flag');

    const decisions=await db.query(`
      SELECT instrument,direction,route,evaluated_at,blockers,
        candidate->>'entry' AS entry,
        candidate->>'stopLoss' AS sl,
        candidate->>'takeProfit' AS tp,
        governance->'independentM1OpportunityShadow'->>'eligibleForStudy' AS eligible,
        governance->'independentM1OpportunityShadow'->>'planBDisagrees' AS planb_disagreed,
        governance->'independentM1OpportunityShadow'->>'m1NetExpectedR' AS m1_r,
        governance->'routeDecision'->>'eligible' AS m1_route_eligible,
        governance->>'paperEligible' AS m1_paper_eligible,
        governance->'genericGovernance'->>'eventRisk' AS event_risk,
        governance->'genericGovernance'->>'executionSpreadEvidenceValid' AS spread_valid,
        governance->'reliability'->>'eligible' AS reliability_eligible,
        candidate->>'confidence' AS confidence,
        candidate->>'directionQuality' AS direction_quality
      FROM trading.m1_tactical_decisions
      WHERE user_id=$1 AND broker_connection_id=$2
        AND instrument=ANY($3::text[])
        AND evaluated_at>now()-interval '48 hours'
        AND evaluated_at < now() - ($6::int * interval '1 minute')
        AND (
          ($4::boolean = true
            AND evaluated_at >= '2026-11-12T10:19:00Z'
            AND evaluated_at < $5::timestamptz
            AND route = 'M1_TREND_CONTINUATION')
          OR
          ($4::boolean = false
            AND governance->'independentM1OpportunityShadow'->>'eligibleForStudy'='true'
            AND governance->'independentM1OpportunityShadow'->>'planBDisagrees'='true')
        )
      ORDER BY evaluated_at LIMIT 10000
    `,[user_id,broker_connection_id,['EURUSD','AUDUSD'],
      retrospective,RESEARCH_RETROSPECTIVE_CUTOFF,MATURE_LAG_MINUTES]);
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
    // Choose the FIRST as-of eligible candidate for an instrument in each
    // predefined UTC 15-min bucket. No hindsight selection and no concurrent
    // BUY+SELL position in the same market/horizon bucket.
    const seenSlots=new Set(), eligible=[];
    const eligibleUnsampled=decisions.rows.filter(d=>
      retrospective
        ? eligibleLegacyM1(d)
        : d.eligible === 'true' && d.planb_disagreed === 'true'
    );
    for(const d of eligibleUnsampled) {
      const stamp=new Date(d.evaluated_at).getTime();
      const slot=d.instrument+'|'+Math.floor(stamp/(15*MINUTE_MS));
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
        // A two-point forecast needs broker-observed quotes at the
        // *entry and exit*, but cannot assert stop survival if any
        // intermediate quote is missing. Keep those evidence levels apart.
        const period=Array.from({length:h},(_,n)=>
          marks.get(d.instrument+'|'+(stamp+n*MINUTE_MS))||null);
        const exitMark=observedMark(period.at(-1));
        if(!exitMark) {
          record.horizons[h]={state:'UNOBSERVABLE_EXIT_MARK',
            fixedHoldNetPips:null,stopPathVerified:false};
          continue;
        }
        const quotePips=(d.direction==='SELL'
          ? (entry-exitMark.ask) / PIP
          : (exitMark.bid-entry) / PIP) - COST_EXTRA_PIPS;
        const stopPathVerified=fullyObservedQuotePath(period,h);
        const firstTouch = stopPathVerified
          ? Object.fromEntries(QUICK_TP_PIPS.map(target=>[
              String(target),
              quickProfitFirstTouch({
                direction:d.direction,entry,stop:sl,capturePips:target,
                bars:period,quoteSpreadPips:observedCostSpreadPips,
              }),
            ]))
          : null;
        const passivePullback = stopPathVerified
          ? passivePullbackCounterfactual({
              direction:d.direction,
              referenceEntry:entry,
              originalStopDistancePips:Math.abs(sl-entry)/PIP,
              bars:period,
              quoteSpreadPips:observedCostSpreadPips,
            })
          : null;
        record.horizons[h]={
          state:stopPathVerified
            ? 'QUOTED_MARK_PROXY_FULL_PATH'
            : 'QUOTED_ENDPOINT_ONLY_STOP_PATH_UNVERIFIED',
          stopPathVerified,passivePullback,
          fixedHoldNetPips:+quotePips.toFixed(3),
          earlyCapture:firstTouch,
          captureAfterCosts:stopPathVerified
            ? Object.fromEntries(QUICK_TP_PIPS.map(p=>[
                String(p),closeQuickProfitPolicy(firstTouch[p],quotePips)
              ])) : null,
          observedSpreadPips:+observedCostSpreadPips.toFixed(3),
          originalTpPips:+(Math.abs(tp-entry)/PIP).toFixed(2),
          originalStopPips:+(Math.abs(sl-entry)/PIP).toFixed(2),
        };
      }
      records.push(record);
    }
    const summary=[];
    for(const pair of ['EURUSD','AUDUSD'])for(const h of HORIZONS){
      const data=records.filter(r=>r.pair===pair&&
        Number.isFinite(r.horizons[h]?.fixedHoldNetPips));
      const pathVerified=data.filter(r=>r.horizons[h].stopPathVerified===true);
      summary.push({
        pair,horizonMinutes:h,
        fixedHold:summarize(data.map(r=>r.horizons[h].fixedHoldNetPips)),
        endpointOnlyCannotVerifyStop:data.length-pathVerified.length,
        validatedStopPaths:pathVerified.length,
        passivePullback:{
          rule:'ONE_PIP_WAIT_UP_TO_3M_2PIP_CAPTURE_OR_ORIGINAL_DISTANCE_STOP',
          eligibleCases:pathVerified.length,
          fills:pathVerified.filter(r=>[
            'STOP_FIRST_PROXY','TAKE_PROFIT_PROXY','TIMED_EXIT_PROXY',
          ].includes(r.horizons[h].passivePullback.state)).length,
          unfilled:pathVerified.filter(r=>
            r.horizons[h].passivePullback.state==='NOT_FILLED').length,
          results:summarize(pathVerified.map(r=>r.horizons[h].passivePullback.netPips)),
          outcomes:Object.fromEntries([
            'STOP_FIRST_PROXY','TAKE_PROFIT_PROXY','TIMED_EXIT_PROXY',
            'NOT_FILLED','DATA_GAP','INVALID_STUDY_INPUT',
          ].map(x=>[x,pathVerified.filter(r=>
            r.horizons[h].passivePullback.state===x).length])),
        },
        quickCapture:Object.fromEntries(QUICK_TP_PIPS.map(p=>[String(p),{
          completeTradePolicy:summarize(pathVerified.map(r=>
            r.horizons[h].captureAfterCosts[p])),
          firstTouchCases:pathVerified.filter(r=>r.horizons[h].earlyCapture[p]?.status==='QUICK_TP_PROXY').length,
          stopCases:pathVerified.filter(r=>r.horizons[h].earlyCapture[p]?.status==='STOP_FIRST').length,
          unobservedTouchCases:pathVerified.filter(r=>r.horizons[h].earlyCapture[p]?.status==='NO_FIRST_TOUCH').length,
        }])),
      });
    }
    const report = {
      artifact:ARTIFACT,
      mode:retrospective?'RETROSPECTIVE_RECONSTRUCTION':'READ_ONLY_RESEARCH',
      executionAuthority:'NONE',
      recordedProspectively:!retrospective,
      qualifiesForDemoExecution:false,
      qualificationReason:'NO_PROSPECTIVE_BROKER_FILL_EVIDENCE_OR_STABLE_AFTER_COST_EDGE',
      modifiesBrokerOrders:false,modifiesPositions:false,
      createdAtUTC:new Date().toISOString(),
      source:'PEPPERSTONE_CTRADER_DEMO_OWNER_BOUND',
      brokerIdentityHash:createHash('sha256')
        .update(user_id+'|'+broker_connection_id).digest('hex').slice(0,24),
      frozenStrategy:'M1_PASSIVE_PULLBACK_1PIP_WAIT3M_TP2PIP_EXIT7M_V1',
      studiedSignalCount:decisions.rowCount,
      eligibleBeforeTimeSampling:eligibleUnsampled.length,
      nonOverlappingFirstSignalSlots:eligible.length,
      independentlyPricedEpisodes:records.length,
      withUsableStopPathAtAnyHorizon:records.filter(r=>
        Object.values(r.horizons).some(h=>h.stopPathVerified===true)).length,
      assumptions:{
        signalSelection:'FIRST_ELIGIBLE_PER_INSTRUMENT_UTC_15MIN_SLOT',
        retrospectiveMode:retrospective,
        matureLagMinutes:MATURE_LAG_MINUTES,
        retrospectiveCannotQualifyDemoPromotion:retrospective,
        entry:'LAST_OBSERVED_POSITIVE_BID_ASK_PRECEDING_DECISION',
        exit:'LATEST_OBSERVED_POSITIVE_BID_ASK_AT_FUTURE_COMPLETED_M1',
        estimatedAdditionalCommissionAndSlippagePips:COST_EXTRA_PIPS,
        positiveEntryAndExitQuoteRequired:true,
        positiveQuoteMarkRequiredForEveryStopPathMinute:true,
        allMinutesPositiveQuotesRequiredForStopFirst:true,
        observedEntryExitMarksSufficientOnlyForDirectionalResearch:true,
        endpointOnlyCannotProveStopSurvival:true,
        stopFirstWhenTPAndSLInSameM1:true,
        hypotheticalFirstTouchNotTickAccurate:true,
        sourceTradeIsNeverAnActualBrokerFill:true,
      },
      summary, episodes:records,
    };
    const name='/tmp/irexpro-m1-opportunity-'+new Date().toISOString().replace(/[-:.]/g,'')+'-'+randomUUID().slice(0,8)+'.json';
    fs.writeFileSync(name,JSON.stringify(report,null,2),{flag:'wx',mode:0o600});
    console.log(JSON.stringify({output:name,signalCount:decisions.rowCount,
      independentlyPricedEpisodes:records.length,
      mode:report.mode,summary},null,2));
  }finally{await db.end()}
}
if(require.main===module)main().catch(e=>{console.error('READ_ONLY_AUDIT_FAILED',e.code||'',e.message);process.exitCode=1});
module.exports={observedMark,isPositiveObservedMark,quickProfitFirstTouch,summarize,eligibleLegacyM1,closeQuickProfitPolicy,passivePullbackCounterfactual,fullyObservedQuotePath,HORIZONS,MATURE_LAG_MINUTES};
