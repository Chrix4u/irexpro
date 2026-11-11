#!/usr/bin/env node
'use strict';
/**
 * Pepperstone cTrader DEMO: read-only inspection of broker BUY-at-ask /
 * SELL-at-bid entry fills and future bid/ask quote MARKS 1/3/5/10 minutes
 * later, if the position was STILL OPEN at the quote time.
 *
 * IMPORTANT: Not a backtest or profit claim. No tick-first-touch of SL/TP,
 * no modelled latency/slippage, conditional survival selection, and only
 * trades that were actually opened by the current engine.
 *
 * NEVER sends broker orders or updates database records.
 */
const HORIZONS = Object.freeze([1, 3, 5, 10]);
const CURRENCY_PAIRS = new Set(['AUDUSD','EURUSD','GBPUSD','USDCHF','USDJPY','USDCAD']);

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function timestamp(value) {
  const n = new Date(value).getTime();
  return Number.isFinite(n) ? n : null;
}
function pricePip(instrument) {
  return instrument?.endsWith('JPY') ? 0.01 : 0.0001;
}
function brokerMarkNetUSD(trade, mark) {
  const instrument = String(trade.instrument || '').toUpperCase();
  const entry = finiteNumber(trade.fill_price);
  const volume = finiteNumber(trade.lot_size);
  const exit = finiteNumber(mark);
  const commission = finiteNumber(trade.commission);
  const swap = finiteNumber(trade.swap) ?? 0;
  if (!CURRENCY_PAIRS.has(instrument) || !['BUY','SELL'].includes(trade.direction)
    || entry === null || entry <= 0 || volume === null || volume <= 0
    || exit === null || exit <= 0 || commission === null || commission > 0) return null;
  const sign = trade.direction === 'BUY' ? 1 : -1;
  const grossInQuote = sign * (exit - entry) * (volume * 100000);
  const grossUSD = instrument.endsWith('USD') ? grossInQuote : grossInQuote / exit;
  const pips = sign * (exit - entry) / pricePip(instrument);
  return {grossUSD, netUSD: grossUSD + commission + swap, pips};
}
function eligibleMark(trade, horizon, quotes) {
  if (!HORIZONS.includes(horizon)) return null;
  const opened = timestamp(trade.opened_at);
  const closed = timestamp(trade.closed_at);
  if (opened === null || closed === null || closed <= opened) return null;
  const target = opened + horizon * 60000;
  // We must use an observed quote after the selected horizon, before the
  // ACTUAL broker close. A minute's OHLC after that would leak future prices.
  if (target >= closed) return null;
  const ceiling = Math.min(closed, target + 60000);
  const candidates = (Array.isArray(quotes) ? quotes : [])
    .filter(q => q.source === 'ctrader-broker-native'
      && Number(q.positive_quote_sample_count) > 0
      && finiteNumber(q.bid_close) > 0 && finiteNumber(q.ask_close) > 0
      && finiteNumber(q.ask_close) >= finiteNumber(q.bid_close))
    .map(q => ({...q, at: timestamp(q.last_quote_sample_at)}))
    .filter(q => q.at !== null && q.at >= target && q.at <= ceiling)
    .sort((a,b) => a.at-b.at);
  if (candidates.length === 0) return null;
  const q = candidates[0];
  // At this mark, a BUY must liquidate at BID, and a SELL at ASK.
  const mark = trade.direction === 'BUY' ? q.bid_close : q.ask_close;
  const pnl = brokerMarkNetUSD(trade, mark);
  return pnl ? {
    quoteTime: new Date(q.at).toISOString(),
    minutesFromEntry: (q.at-opened)/60000,
    quoteDelaySec: (q.at-target)/1000,
    bid: Number(q.bid_close),
    ask: Number(q.ask_close),
    ...pnl,
  } : null;
}
function summarize(trades) {
  const periods = HORIZONS.map(horizon => ({
    horizonMinutes: horizon, eligible:0, netPositive:0, netNegative:0,
    sumNetUSD:0, sumGrossUSD:0, sumPips:0, sumQuoteDelaySec:0,
    actualClosedBeforeMark:0, quoteMissingWhileStillOpen:0,
  }));
  const lossProfiles = {actualLosingTrades:0, observedPriorPeakPositive:0,
    observedPriorPeakAboveActualCommission:0, recordedPeakMissing:0,
    actualWinningTrades:0, brokerClosedByProfitProtection:0,
    earlyAINegativeCloses:0};
  let actualGross=0,actualCommission=0,actualSwap=0,actualNet=0;
  const cases=[];
  for (const trade of trades) {
    const gross=finiteNumber(trade.realised_pnl);
    const fee=finiteNumber(trade.commission);
    const swap=finiteNumber(trade.swap)??0;
    if (gross === null || fee === null) continue;
    const net=gross+fee+swap;
    actualGross+=gross;actualCommission+=fee;actualSwap+=swap;actualNet+=net;
    if (net>0) lossProfiles.actualWinningTrades++;
    if (trade.close_reason==='PROFIT_PROTECTION') lossProfiles.brokerClosedByProfitProtection++;
    if (net<0) {
      lossProfiles.actualLosingTrades++;
      const peak=finiteNumber(trade.max_favorable_pnl);
      if (peak===null) lossProfiles.recordedPeakMissing++;
      else {
        if (peak>0) lossProfiles.observedPriorPeakPositive++;
        if (peak>Math.abs(fee)) lossProfiles.observedPriorPeakAboveActualCommission++;
      }
      if (trade.close_reason==='AI_CLOSE_SIGNAL') lossProfiles.earlyAINegativeCloses++;
    }
    const outputs={};
    for (const p of periods) {
      const target=timestamp(trade.opened_at) + p.horizonMinutes*60000;
      const closed=timestamp(trade.closed_at);
      if (target>=closed) {
        p.actualClosedBeforeMark++;
        outputs[p.horizonMinutes]={state:'TRADE_CLOSED_BEFORE_HORIZON'};
        continue;
      }
      const q=eligibleMark(trade,p.horizonMinutes,trade.quotes);
      if (!q) {
        p.quoteMissingWhileStillOpen++;
        outputs[p.horizonMinutes]={state:'NO_CAUSAL_BROKER_MARK'};
        continue;
      }
      p.eligible++;
      p.sumNetUSD+=q.netUSD;p.sumGrossUSD+=q.grossUSD;
      p.sumPips+=q.pips;p.sumQuoteDelaySec+=q.quoteDelaySec;
      if(q.netUSD>0)p.netPositive++;
      else if(q.netUSD<0)p.netNegative++;
      outputs[p.horizonMinutes]={state:'OBSERVED_WHILE_STILL_OPEN',netUSD:Number(q.netUSD.toFixed(2)),
        signedPips:Number(q.pips.toFixed(2)),lagSeconds:Number(q.quoteDelaySec.toFixed(1))};
    }
    cases.push({instrument:trade.instrument,direction:trade.direction,
      openedAt:new Date(trade.opened_at).toISOString(),actualCloseAt:new Date(trade.closed_at).toISOString(),
      actualNetUSD:Number(net.toFixed(2)),reason:trade.close_reason,
      recordedPeakUSD:finiteNumber(trade.max_favorable_pnl),
      horizons:outputs});
  }
  return {
    artifact:'irexpro-broker-native-executed-trade-horizon-marks-readonly-v1',
    warnings:[
      'Horizon observations exist only if the original trade was still OPEN at the quote mark: substantial survivor bias.',
      'These are M1 quote MARKS, not executable orders, and are sampled 0–60 seconds after horizon.',
      'Uses historical actually charged commission as conservative proxy, not a new fee schedule. No additional slippage.',
      'Broker stop-loss/take-profit first-touch cannot be inferred from bar closes. Not a tradable backtest.',
      'Trade-history sample is small; repeated/recent strategies and market days are not independent.',
    ],
    count:cases.length,
    actual:{
      grossUSD:Number(actualGross.toFixed(2)),
      commissionUSD:Number(actualCommission.toFixed(2)),
      swapUSD:Number(actualSwap.toFixed(2)),
      netUSD:Number(actualNet.toFixed(2)),
    },
    lossProfiles,
    horizonObservations:periods.map(p=>({
      horizonMinutes:p.horizonMinutes, eligible:p.eligible, netPositive:p.netPositive,
      netNegative:p.netNegative,
      positiveShare:p.eligible?Number((p.netPositive/p.eligible).toFixed(3)):null,
      conditionalAverageNetUSD:p.eligible?Number((p.sumNetUSD/p.eligible).toFixed(2)):null,
      conditionalAverageSignedPips:p.eligible?Number((p.sumPips/p.eligible).toFixed(2)):null,
      conditionalAverageQuoteLagSec:p.eligible?Number((p.sumQuoteDelaySec/p.eligible).toFixed(1)):null,
      closedBeforeHorizon:p.actualClosedBeforeMark,
      missingBrokerQuote:p.quoteMissingWhileStillOpen,
    })),
    cases,
  };
}
async function main() {
  require('dotenv').config({path:'.env',quiet:true});
  const {Client}=require('pg');
  const {getDatabaseSslOptions}=require(require('node:path').resolve(process.cwd(),'dist/config/database-tls'));
  const userId=process.env.VPS_FOREX_SCANNER_USER_ID;
  if(!userId)throw new Error('OWNED_DEMO_USER_NOT_CONFIGURED');
  const start=process.env.IREXPRO_HORIZON_AUDIT_START||'2026-11-10T00:00:00Z';
  const end=process.env.IREXPRO_HORIZON_AUDIT_END||new Date().toISOString();
  if(timestamp(start)===null||timestamp(end)===null||timestamp(end)<=timestamp(start)) {
    throw new Error('INVALID_AUDIT_TIME_WINDOW');
  }
  const c=new Client({
    host:process.env.DB_HOST||'localhost',port:Number(process.env.DB_PORT||5432),
    database:process.env.DB_NAME||'irexpro_dev',user:process.env.DB_USER||'irexpro',
    password:process.env.DB_PASSWORD,ssl:getDatabaseSslOptions(process.env.DB_SSL==='true'),
    application_name:'irexpro-readonly-broker-native-horizon-marks-v1',
  });
  await c.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SET LOCAL statement_timeout='25s'");
    const sessions=await c.query(`
      SELECT b.broker_id,b.account_type,s.broker_connection_id
      FROM trading.trading_sessions s
      JOIN broker.broker_connections b ON b.id=s.broker_connection_id AND b.user_id=s.user_id
      WHERE s.user_id=$1 AND s.status='ACTIVE' AND s.execution_mode='FULL_AUTO'
      ORDER BY s.started_at DESC LIMIT 1
    `,[userId]);
    if(sessions.rows.length!==1||sessions.rows[0].broker_id!=='pepperstone-ctrader'
      ||sessions.rows[0].account_type!=='DEMO')throw new Error('NOT_OWNED_PEPPERSTONE_DEMO');
    const connection=sessions.rows[0].broker_connection_id;
    const rows=await c.query(`
      SELECT t.instrument,t.direction,t.opened_at,t.closed_at,t.close_reason,
             t.fill_price,t.exit_price,t.lot_size,t.realised_pnl,
             t.commission,t.swap,t.max_favorable_pnl,
             q.quotes
      FROM trading.trades t
      LEFT JOIN LATERAL (
        SELECT coalesce(jsonb_agg(jsonb_build_object(
          'last_quote_sample_at', c.last_quote_sample_at,
          'positive_quote_sample_count',c.positive_quote_sample_count,
          'bid_close',c.bid_close,'ask_close',c.ask_close,'source',c.source
        ) ORDER BY c.bucket_time),'[]'::jsonb) AS quotes
        FROM market_data.provider_quote_candles c
        WHERE c.connection_id=t.broker_connection_id
          AND c.instrument=t.instrument AND c.timeframe='M1'
          AND c.bucket_time>=date_trunc('minute',t.opened_at)
          AND c.bucket_time<date_trunc('minute',t.opened_at)+interval '12 minutes'
          AND c.positive_quote_sample_count>0
      ) q ON true
      WHERE t.user_id=$1 AND t.broker_connection_id=$2
        AND t.status='CLOSED'
        AND t.opened_at>=$3::timestamptz
        AND t.opened_at<$4::timestamptz
        AND t.realised_pnl IS NOT NULL AND t.commission IS NOT NULL
      ORDER BY t.opened_at LIMIT 300
    `,[userId,connection,start,end]);
    await c.query('COMMIT');
    const results=summarize(rows.rows);
    console.log(JSON.stringify({window:{start,end},...results},null,2));
  } catch(e){try{await c.query('ROLLBACK')}catch{};throw e}
  finally{await c.end()}
}
module.exports={finiteNumber,timestamp,pricePip,brokerMarkNetUSD,eligibleMark,summarize};
if(require.main===module)main().catch(e=>{console.error('AUDIT_FAILED:',e.message);process.exitCode=1});
