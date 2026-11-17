#!/usr/bin/env node
'use strict';

/**
 * Owner-scoped Pepperstone USD DEMO, read-only, causal directional audit.
 *
 * Scores the original prediction at +1/+3/+5/+10 minutes using only genuine
 * subsequent broker M1 bid/ask closings. Historical decision-time features
 * and broker mark observations never authorize a new order. No entry quota.
 *
 * node scripts/research-owner-demo-direction-horizons.cjs [--out=/tmp/direction.json]
 */
const path = require('node:path');
const fs = require('node:fs');
const HORIZONS = Object.freeze([1, 3, 5, 10]);
const FOCUS = Object.freeze(['EURUSD', 'AUDUSD', 'USDJPY', 'USDCAD']);
const BROKER_SOURCE = 'ctrader-broker-native';
const MARKET_EPISODE_MS = 20 * 60_000;
const MIN_PRIOR_FEE_SAMPLES = 5;
const LOOKBACK_HOURS = 24;
const MAX_DECISION_ROWS = 18000;

function finiteNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function iso(v) {
  const ms = new Date(v).getTime();
  return Number.isFinite(ms) ? ms : null;
}
function quantile(sorted, frac) {
  if (!sorted.length) return null;
  const k = Math.ceil(sorted.length * frac) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, k))];
}
/** Repeat M1 checks inside one 20-minute episode do not imply independent predictions. */
function deduplicateMarketEpisodes(rows) {
  const seen = new Set();
  return rows.filter(row => {
    const ms = iso(row.evaluated_at);
    if (ms === null) return false;
    const route = row.strategy_route || 'UNKNOWN';
    const key = [
      row.instrument, row.direction, route, Math.floor(ms / MARKET_EPISODE_MS),
    ].join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
/**
 * Select the FIRST completed M1 bar whose close is at or within 60s AFTER
 * the horizon. This is a post-event OUTCOME label, not an input at prediction
 * time. Never label a 5-minute horizon using a 4-minute candle.
 * A broker closing bid/ask sample must be from the last 30s of the selected
 * M1 bar, captured by analysis time, and never from mid-only history.
 */
function selectCausalM1Mark(bars, decisionAt, horizonMinutes, asOf) {
  const decision = iso(decisionAt), now = iso(asOf);
  if (decision === null || now === null || !HORIZONS.includes(horizonMinutes)) return null;
  const target = decision + horizonMinutes * 60_000;
  // The complete horizon label must be observable; no partial future bar.
  if (target > now - 2_000) return null;
  let best = null;
  for (const c of bars || []) {
    const bucket = iso(c.bucket_time);
    const quote = iso(c.last_quote_sample_at);
    if (bucket === null || quote === null || c.source !== BROKER_SOURCE) continue;
    const barClose = bucket + 60_000;
    if (barClose < target || barClose > target + 60_000 ||
        barClose <= decision || quote > now ||
        quote < bucket + 30_000 || quote >= barClose + 1_000) continue;
    const bid = finiteNumber(c.bid_close), ask = finiteNumber(c.ask_close);
    if (bid === null || ask === null || bid <= 0 || ask < bid ||
        (finiteNumber(c.sample_count) ?? 0) < 2) continue;
    if (!best || barClose < best.closedAtMs) {
      best = {closedAtMs: barClose, bid, ask, spread: ask - bid};
    }
  }
  return best;
}
function priorFeeCostR(fees, decisionTime) {
  const asOf = iso(decisionTime);
  if (asOf === null) return {samples:0, p90FeeR:null};
  const eligible = (fees || [])
    .filter(row => {
      const at = iso(row.closed_at);
      return at !== null && at < asOf &&
        at >= asOf - 30 * 24 * 3600_000 &&
        finiteNumber(row.fee_r) !== null && Number(row.fee_r) >= 0;
    })
    .slice(-24)
    .map(row => Number(row.fee_r)).sort((a,b) => a-b);
  return {samples:eligible.length,
    p90FeeR:eligible.length >= MIN_PRIOR_FEE_SAMPLES ?
      quantile(eligible, 0.90) : null};
}
function evaluatePrediction(decision, mark, feeEvidence) {
  if (!mark) return null;
  const candidate = decision.candidate || {};
  const entry = finiteNumber(candidate.entry);
  const stop = finiteNumber(candidate.stopLoss);
  if (entry === null || stop === null || entry <= 0 ||
      Math.abs(entry - stop) <= 0) return null;
  if (!['BUY','SELL'].includes(decision.direction)) return null;
  const stopDistance = Math.abs(entry-stop);
  // BUY hypothetically exits at a real bid; SELL at a real ask. Original
  // signal entry is not a guaranteed executable fill; mark as research.
  const exit = decision.direction === 'BUY' ? mark.bid : mark.ask;
  const directionalR = (decision.direction === 'BUY' ? exit-entry : entry-exit) / stopDistance;
  const p90FeeR = feeEvidence && finiteNumber(feeEvidence.p90FeeR);
  return {
    directionalR,
    estimatedAfterFeeR: p90FeeR === null ? null : directionalR - p90FeeR,
    feeSamples: feeEvidence?.samples ?? 0,
    observedSpread: mark.spread,
    markClosedAt: new Date(mark.closedAtMs).toISOString(),
  };
}
function summarizeHorizon(scored) {
  const n = scored.length;
  const estimated = scored.filter(x => x.estimatedAfterFeeR !== null);
  const sum = key => scored.reduce((acc,v) => acc + v[key],0);
  return {
    episodes: n,
    directionalWinRate: n ? scored.filter(x => x.directionalR > 0).length/n : null,
    meanDirectionalR: n ? sum('directionalR') / n : null,
    estimatedAfterFeeCoverage: estimated.length,
    estimatedAfterFeeWinRate: estimated.length ?
      estimated.filter(x => x.estimatedAfterFeeR > 0).length / estimated.length : null,
    meanEstimatedAfterFeeR: estimated.length ?
      estimated.reduce((a,x) => a+x.estimatedAfterFeeR,0)/estimated.length : null,
  };
}
/** One-minute confirmation enters at the one-minute observed ask/bid.
 * The initial direction must already have moved favorably *after spread*.
 * This is a forward-tested hypothetical entry, not a broker order.
 */
function evaluateDelayedOneMinute(decision, firstMark, exitMark, feeEvidence) {
  if (!firstMark || !exitMark) return null;
  const entry = finiteNumber(decision.candidate?.entry);
  const stop = finiteNumber(decision.candidate?.stopLoss);
  if (entry === null || stop === null || Math.abs(entry-stop) <= 0) return null;
  const buy = decision.direction === 'BUY', sell = decision.direction === 'SELL';
  if (!buy && !sell) return null;
  const delayedEntry = buy ? firstMark.ask : firstMark.bid;
  const delayedExit = buy ? exitMark.bid : exitMark.ask;
  const directionalR = (buy ? delayedExit-delayedEntry : delayedEntry-delayedExit) /
    Math.abs(entry-stop);
  const feeR = finiteNumber(feeEvidence?.p90FeeR);
  return {
    directionalR,estimatedAfterFeeR:feeR === null ? null : directionalR-feeR,
    feeSamples:feeEvidence?.samples ?? 0,
    observedSpread:exitMark.spread,
    markClosedAt:new Date(exitMark.closedAtMs).toISOString(),
  };
}

function summarizeResearch(decisions, candlesByInstrument, feesByInstrument, asOf) {
  const episodes = deduplicateMarketEpisodes(decisions);
  const overall = {}, byRoute = {}, byPatternHypothesis = {}, byAuthority = {};
  const delayedByRoute = {}, delayedByAuthority = {};
  const horizons = HORIZONS;
  let missingCausalMarks = 0, unmatchedOriginalEntry = 0;
  for (const decision of episodes) {
    const bars = candlesByInstrument[decision.instrument] || [];
    const fee = priorFeeCostR(feesByInstrument[decision.instrument] || [],decision.evaluated_at);
    for (const horizon of horizons) {
      const mark = selectCausalM1Mark(bars,decision.evaluated_at,horizon,asOf);
      const result = evaluatePrediction(decision,mark,fee);
      if (!result) {
        if (!mark) missingCausalMarks++;
        else unmatchedOriginalEntry++;
        continue;
      }
      const route = decision.strategy_route || 'UNKNOWN';
      const hypothesis = decision.pattern_hypothesis || 'NO_MEMORY';
      const authority = decision.execution_authority === 'BROKER_NATIVE'
      ? decision.outcome_state === 'EXECUTION_SUCCEEDED'
        ? 'EXECUTION_SUCCEEDED'
        : 'BROKER_AUTHORIZED_NOT_FILLED'
      : 'NOT_BROKER_AUTHORIZED';
      const add = (map,key) => {
        if (!map[key]) map[key] = {};
        if (!map[key][horizon]) map[key][horizon] = [];
        map[key][horizon].push(result);
      };
      add(overall,'ALL');
      add(byRoute,route);
      add(byPatternHypothesis,hypothesis);
      add(byAuthority,authority);
    }
    const first = selectCausalM1Mark(bars,decision.evaluated_at,1,asOf);
    const firstOutcome = evaluatePrediction(decision,first,fee);
    if (firstOutcome) {
      for (const h of [3,5,10]) {
        const later = selectCausalM1Mark(bars,decision.evaluated_at,h,asOf);
        const immediate = evaluatePrediction(decision,later,fee);
        const delayed = evaluateDelayedOneMinute(decision,first,later,fee);
        if (!immediate || !delayed) continue;
        const route = decision.strategy_route || 'UNKNOWN';
        const authority = decision.execution_authority === 'BROKER_NATIVE'
          ? 'BROKER_AUTHORIZED' : 'NOT_BROKER_AUTHORIZED';
        for(const [map,key] of [[delayedByRoute,route],[delayedByAuthority,authority]]) {
          (map[key] ||= {});
          const group = (map[key][h] ||= {
            eligible:0,confirmed:0,pairedImmediate:[],afterDelayedEntry:[],unconfirmedImmediate:[],
          });
          group.eligible++;
          if(firstOutcome.directionalR > 0) {
            group.confirmed++;
            group.pairedImmediate.push(immediate);
            group.afterDelayedEntry.push(delayed);
          } else {
            group.unconfirmedImmediate.push(immediate);
          }
        }
      }
    }
  }
  const finalize = value => Object.fromEntries(Object.entries(value).map(([k,buckets])=>
    [k,Object.fromEntries(horizons.map(h=>[h+'m',summarizeHorizon(buckets[h] || [])]))]));
  const finalizeDelayed = groups => Object.fromEntries(
    Object.entries(groups).map(([k,group])=>[k,Object.fromEntries([3,5,10].map(h=>{
      const b=group[h] || {eligible:0,confirmed:0,pairedImmediate:[],afterDelayedEntry:[],unconfirmedImmediate:[]};
      return [h+'m',{
        eligibleEpisodes:b.eligible,confirmedEpisodes:b.confirmed,
        skippedEpisodes:b.eligible-b.confirmed,
        confirmationRate:b.eligible?b.confirmed/b.eligible:null,
        pairedImmediate:summarizeHorizon(b.pairedImmediate),
        delayedOneMinute:summarizeHorizon(b.afterDelayedEntry),
        afterUnfavorableFirstMinute:summarizeHorizon(b.unconfirmedImmediate),
      }];
    }))]));
  return {
    artifact:'irexpro-owner-demo-directional-horizon-replay-v1',
    researchOnly:true,modifiesExecution:false,
    asOf:new Date(asOf).toISOString(), lookbackHours:LOOKBACK_HOURS,
    source:BROKER_SOURCE, instruments:[...FOCUS], horizonsMinutes:horizons,
    meaning:'Original M1 candidate entry versus first complete broker bid/ask M1 close at/within 60s after each horizon, in initial stop-risk units R. Research labels, not executable fills or verified trade profitability.',
    feeMeaning:'p90 of at least 5 prior settled normalized broker commission/swap costs, otherwise missing; an after-fee estimate only, not realized P&L.',
    independence:'deduplicated pair-side-route 20-minute episode keys; overlapping opposite sides, routes and USD exposures are NOT statistically independent',
    rawDecisions:decisions.length, independentMarketEpisodes:episodes.length,
    unavailableMarks:missingCausalMarks, invalidOriginalEntry:unmatchedOriginalEntry,
    byHorizon:finalize(overall).ALL,
    byRoute:finalize(byRoute), byPatternHypothesis:finalize(byPatternHypothesis),
    byExecutionAuthority:finalize(byAuthority),
    oneMinuteConfirmationResearch:{
      trigger:'Original side moves above original spread-inclusive entry after the first fully closed M1 minute; enter at that observed ask/bid, compare +3/+5/+10 minute exits.',
      noExecutionAuthority:true,noModelPromotion:true,
      byRoute:finalizeDelayed(delayedByRoute),
      byExecutionAuthority:finalizeDelayed(delayedByAuthority),
    },
  };
}
async function main() {
  const envPath = path.join(__dirname,'..','.env');
  require('dotenv').config({path:envPath,quiet:true});
  const {Client} = require('pg');
  const owner = process.env.VPS_FOREX_SCANNER_USER_ID;
  if (!owner) throw new Error('OWNER_DEMO_SCOPE_REQUIRED');
  const asOf = new Date();
  const since = new Date(asOf.getTime()-LOOKBACK_HOURS*3600_000);
  const mature = new Date(asOf.getTime()-11*60_000);
  const client = new Client({
    host:process.env.DB_HOST,port:Number(process.env.DB_PORT||5432),
    database:process.env.DB_NAME,user:process.env.DB_USER,
    password:process.env.DB_PASSWORD,ssl:process.env.DB_SSL==='true'?
      {rejectUnauthorized:false}:false,statement_timeout:25000,
  });
  try {
    await client.connect();
    await client.query('BEGIN READ ONLY');
    const broker = await client.query([
      'SELECT id FROM broker.broker_connections',
      "WHERE user_id=$1 AND broker_id='pepperstone-ctrader'",
      "AND account_type='DEMO' AND deleted_at IS NULL",
      "AND status='CONNECTED' AND authorization_status='ACTIVE'",
      'ORDER BY created_at DESC LIMIT 1',
    ].join(' '),[owner]);
    if(broker.rows.length!==1) throw new Error('ACTIVE_CONNECTED_OWNER_DEMO_REQUIRED');
    const connection = broker.rows[0].id;
    const decisions = (await client.query([
      'SELECT d.evaluated_at,d.instrument,d.direction,d.execution_authority,d.outcome_state,',
      "d.governance #>> '{multimodelEnsemble,strategyRoute}' AS strategy_route,",
      "d.governance #>> '{patternMemory,hypothesis}' AS pattern_hypothesis,",
      'd.candidate',
      'FROM trading.m1_tactical_decisions d',
      'WHERE d.user_id=$1 AND d.broker_connection_id=$2',
      'AND d.instrument=ANY($3::text[])',
      'AND d.evaluated_at >= $4::timestamptz AND d.evaluated_at <= $5::timestamptz',
      'ORDER BY d.evaluated_at ASC',
      'LIMIT '+MAX_DECISION_ROWS,
    ].join(' '),[owner,connection,[...FOCUS],since,mature])).rows;
    const marks = (await client.query([
      'SELECT instrument,bucket_time,bid_close,ask_close,source,sample_count,last_quote_sample_at',
      'FROM market_data.provider_quote_candles',
      "WHERE connection_id=$1 AND timeframe='M1'",
      'AND instrument=ANY($2::text[])',
      'AND bucket_time >= $3::timestamptz - interval \'1 minute\'',
      'AND bucket_time < $4::timestamptz',
      'ORDER BY instrument,bucket_time',
    ].join(' '),[connection,[...FOCUS],since,asOf])).rows;
    const fees = (await client.query([
      'SELECT t.instrument,t.closed_at,',
      'GREATEST(0,-(t.commission+t.swap)/NULLIF((ca.sizing_inputs->>\'finalRiskAtStop\')::numeric,0)) AS fee_r',
      'FROM trading.trades t JOIN broker.broker_connections b',
      'ON b.id=t.broker_connection_id AND b.user_id=t.user_id',
      'LEFT JOIN LATERAL (SELECT sizing_inputs FROM trading.capital_allocations',
      'WHERE trade_intent_id=t.trade_intent_id ORDER BY created_at DESC LIMIT 1) ca ON true',
      'WHERE t.user_id=$1 AND t.broker_connection_id=$2',
      "AND b.broker_id='pepperstone-ctrader' AND b.account_type='DEMO'",
      'AND t.instrument=ANY($3::text[]) AND t.status=\'CLOSED\'',
      'AND t.commission IS NOT NULL AND t.swap IS NOT NULL',
      'AND t.closed_at < $4::timestamptz',
      'AND t.closed_at >= $5::timestamptz - interval \'30 days\'',
      'ORDER BY t.instrument,t.closed_at ASC',
    ].join(' '),[owner,connection,[...FOCUS],asOf,since])).rows;
    await client.query('COMMIT');
    const candlesByInstrument = {}, feesByInstrument = {};
    for(const v of marks) (candlesByInstrument[v.instrument] ||= []).push(v);
    for(const v of fees) (feesByInstrument[v.instrument] ||= []).push(v);
    const report = summarizeResearch(decisions,candlesByInstrument,feesByInstrument,asOf);
    const arg=process.argv.find(x=>x.startsWith('--out='));
    if(arg){
      const target=path.resolve(arg.slice('--out='.length));
      fs.writeFileSync(target,JSON.stringify(report,null,2)+'\n',{mode:0o600});
      console.log('REPORT_WRITTEN '+target);
    }
    console.log(JSON.stringify(report,null,2));
  } catch(error) {
    await client.query('ROLLBACK').catch(()=>{});
    throw error;
  } finally {await client.end();}
}
module.exports = {HORIZONS,FOCUS,deduplicateMarketEpisodes,selectCausalM1Mark,
  priorFeeCostR,evaluatePrediction,evaluateDelayedOneMinute,summarizeResearch};
if(require.main===module) main().catch(err=>{console.error('READ_ONLY_REPLAY_FAILED',err.message);process.exitCode=1});
