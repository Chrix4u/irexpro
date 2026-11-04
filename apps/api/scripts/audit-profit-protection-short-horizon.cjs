'use strict';

// Manually invoked research only. No order/position mutation or promotion side effects.
const ARTIFACT = 'profit-protection-short-horizon-after-exit-audit-v1';
const HORIZONS = Object.freeze([15, 30, 60]);
// Use a separate canonical UUID check below so invalid versions are rejected.
const VALID_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SCOPE_SQL = `
  SELECT CURRENT_TIMESTAMP AS "snapshotAt"
  FROM broker.broker_connections
  WHERE id = $1 AND user_id = $2
    AND account_type = 'DEMO' AND broker_id = 'ctrader'
    AND deleted_at IS NULL
`;
const TRADES_SQL = `
  SELECT t.instrument, t.direction, t.opened_at AS "openedAt",
    t.closed_at AS "closedAt", t.fill_price AS "entryPrice",
    t.stop_loss AS "recordedTradeStopLoss", t.take_profit AS "recordedTradeTakeProfit",
    t.exit_price AS "exitPrice",
    t.realised_pnl AS "realisedPnl", t.commission, t.swap, t.account_currency AS "currency",
    ti.stop_loss AS "originalStopLoss", ti.take_profit AS "originalTakeProfit",
    COALESCE(NULLIF(ti.metadata->>'multimodel_plan_b_route',''), 'UNKNOWN') AS "strategyRoute"
  FROM trading.trades t
  JOIN trading.trade_intents ti ON ti.id = t.trade_intent_id
    AND ti.user_id = $1 AND ti.broker_connection_id = $2
  WHERE t.user_id = $1 AND t.broker_connection_id = $2
    AND t.status = 'CLOSED' AND t.close_reason = 'PROFIT_PROTECTION'
    AND t.closed_at >= $3::timestamptz AND t.closed_at <= $4::timestamptz
  ORDER BY t.closed_at DESC
  LIMIT $5::int
`;
const CANDLES_SQL = `
  SELECT instrument, bucket_time AS "timestamp", high, low,
    positive_quote_sample_count AS "positiveQuotes"
  FROM market_data.provider_quote_candles
  WHERE connection_id = $1 AND timeframe = 'M1'
    AND source = 'ctrader-broker-native'
    AND instrument = ANY($2::text[])
    AND bucket_time >= $3::timestamptz
    AND bucket_time + interval '1 minute' <= $4::timestamptz
    AND positive_quote_sample_count > 0
    AND last_quote_sample_at >= bucket_time
    AND last_quote_sample_at < bucket_time + interval '1 minute'
  ORDER BY instrument, bucket_time
`;

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nextFullMinute(time) {
  const ms = new Date(time).getTime();
  if (!Number.isFinite(ms)) return null;
  return Math.floor(ms / 60_000) * 60_000 + 60_000;
}

function classifyAfterExit({ trade, quoteCandles, snapshotAt, horizonMinutes }) {
  if (!HORIZONS.includes(horizonMinutes)) throw new Error('INVALID_HORIZON');
  const nextMinute = nextFullMinute(trade.closedAt);
  // Use the same closed-trade snapshot barriers as the existing 4h tracer.
  // Requested intent prices can differ from the broker-reconciled trade record.
  const tp = numberOrNull(trade.recordedTradeTakeProfit);
  const sl = numberOrNull(trade.recordedTradeStopLoss);
  const entry = numberOrNull(trade.entryPrice);
  const closeTime = new Date(trade.closedAt).getTime();
  const now = new Date(snapshotAt).getTime();
  const base = {
    horizonMinutes,
    outcome: 'DATA_GAP',
    eventAt: null,
    minutesAfterExit: null,
    observedBars: 0,
  };
  if (
    nextMinute == null ||
    !Number.isFinite(now) ||
    (trade.direction !== 'BUY' && trade.direction !== 'SELL') ||
    tp == null ||
    tp <= 0 ||
    sl == null ||
    sl <= 0 ||
    entry == null ||
    entry <= 0 ||
    (trade.direction === 'BUY' && !(sl < entry && entry < tp)) ||
    (trade.direction === 'SELL' && !(tp < entry && entry < sl)) ||
    !Number.isFinite(closeTime)
  )
    return base;

  const candlesByStart = new Map();
  for (const row of quoteCandles) {
    const ts = new Date(row.timestamp).getTime();
    const high = numberOrNull(row.high);
    const low = numberOrNull(row.low);
    if (
      !Number.isFinite(ts) ||
      high == null ||
      low == null ||
      high < low ||
      numberOrNull(row.positiveQuotes) <= 0
    )
      continue;
    if (!candlesByStart.has(ts)) candlesByStart.set(ts, { high, low });
  }

  let observedBars = 0;
  for (let i = 0; i < horizonMinutes; i++) {
    const barStart = nextMinute + i * 60_000;
    if (barStart + 60_000 > now) return { ...base, outcome: 'PENDING', observedBars };
    const bar = candlesByStart.get(barStart);
    if (!bar) return { ...base, outcome: 'DATA_GAP', observedBars };
    observedBars++;
    const tpHit = trade.direction === 'BUY' ? bar.high >= tp : bar.low <= tp;
    const slHit = trade.direction === 'BUY' ? bar.low <= sl : bar.high >= sl;
    if (tpHit || slHit) {
      return {
        ...base,
        observedBars,
        outcome: tpHit && slHit ? 'AMBIGUOUS_SAME_M1' : tpHit ? 'TP_FIRST' : 'SL_FIRST',
        eventAt: new Date(barStart).toISOString(),
        minutesAfterExit: Number(((barStart - closeTime) / 60_000).toFixed(1)),
      };
    }
  }
  return { ...base, outcome: 'NEITHER', observedBars };
}

function summarize(items, horizonMinutes) {
  const subset = items.filter((x) => x.horizonMinutes === horizonMinutes);
  const counts = {
    total: subset.length,
    tpFirst: 0,
    slFirst: 0,
    neither: 0,
    ambiguous: 0,
    dataGap: 0,
    pending: 0,
    resolved: 0,
  };
  for (const row of subset) {
    if (row.outcome === 'TP_FIRST') counts.tpFirst++;
    if (row.outcome === 'SL_FIRST') counts.slFirst++;
    if (row.outcome === 'NEITHER') counts.neither++;
    if (row.outcome === 'AMBIGUOUS_SAME_M1') counts.ambiguous++;
    if (row.outcome === 'DATA_GAP') counts.dataGap++;
    if (row.outcome === 'PENDING') counts.pending++;
  }
  counts.resolved = counts.tpFirst + counts.slFirst;
  counts.tpFirstRateAmongResolved = counts.resolved
    ? Number((counts.tpFirst / counts.resolved).toFixed(4))
    : null;
  return counts;
}

async function runProfitProtectionShortHorizonAudit({
  client,
  userId,
  connectionId,
  since,
  maxTrades = 200,
}) {
  if (!VALID_UUID.test(userId ?? '') || !VALID_UUID.test(connectionId ?? '')) {
    throw new Error('INVALID_AUDIT_SCOPE');
  }
  if (!Number.isInteger(maxTrades) || maxTrades < 1 || maxTrades > 200) {
    throw new Error('INVALID_AUDIT_LIMIT');
  }
  const from = new Date(since);
  if (!Number.isFinite(from.getTime())) throw new Error('INVALID_AUDIT_WINDOW');
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await client.query("SET LOCAL statement_timeout='30s'");
    const scope = (await client.query(SCOPE_SQL, [connectionId, userId])).rows[0];
    if (!scope) throw new Error('CTRADER_DEMO_SCOPE_UNAVAILABLE');
    const snapshotAt = new Date(scope.snapshotAt);
    if (
      !Number.isFinite(snapshotAt.getTime()) ||
      from.getTime() > snapshotAt.getTime() ||
      snapshotAt.getTime() - from.getTime() > 24 * 3600_000
    )
      throw new Error('INVALID_AUDIT_WINDOW');

    const trades = (
      await client.query(TRADES_SQL, [
        userId,
        connectionId,
        from.toISOString(),
        snapshotAt.toISOString(),
        maxTrades,
      ])
    ).rows;
    const instruments = [...new Set(trades.map((t) => t.instrument))];
    const quoteCandles = instruments.length
      ? (
          await client.query(CANDLES_SQL, [
            connectionId,
            instruments,
            from.toISOString(),
            snapshotAt.toISOString(),
          ])
        ).rows
      : [];
    const byInstrument = new Map();
    for (const candle of quoteCandles) {
      const series = byInstrument.get(candle.instrument) || [];
      series.push(candle);
      byInstrument.set(candle.instrument, series);
    }

    const outcomes = trades.flatMap((trade) =>
      HORIZONS.map((horizonMinutes) => {
        const realized = numberOrNull(trade.realisedPnl);
        const commission = numberOrNull(trade.commission);
        const swap = numberOrNull(trade.swap);
        const netAfterRecordedCosts =
          realized === null || commission === null || swap === null
            ? null
            : Number((realized - Math.abs(commission) + swap).toFixed(2));
        return {
          instrument: trade.instrument,
          direction: trade.direction,
          strategyRoute: trade.strategyRoute,
          closedAt: new Date(trade.closedAt).toISOString(),
          currency: trade.currency,
          realisedPnlBeforeExplicitCosts: realized,
          recordedCommission: commission,
          recordedSwap: swap,
          netAfterRecordedCosts,
          // Preserve BOTH price geometries for auditable provenance.
          // The primary first-barrier result uses the closed-trade record,
          // NOT the originally requested intent price levels.
          barrierGeometrySource: 'CLOSED_TRADE_SNAPSHOT',
          recordedTradeTakeProfit: numberOrNull(trade.recordedTradeTakeProfit),
          recordedTradeStopLoss: numberOrNull(trade.recordedTradeStopLoss),
          requestedIntentTakeProfit: numberOrNull(trade.originalTakeProfit),
          requestedIntentStopLoss: numberOrNull(trade.originalStopLoss),
          differsFromRequestedIntent:
            numberOrNull(trade.recordedTradeTakeProfit) !==
              numberOrNull(trade.originalTakeProfit) ||
            numberOrNull(trade.recordedTradeStopLoss) !== numberOrNull(trade.originalStopLoss),
          ...classifyAfterExit({
            trade,
            quoteCandles: byInstrument.get(trade.instrument) || [],
            snapshotAt,
            horizonMinutes,
          }),
        };
      }),
    );
    const report = {
      artifact: ARTIFACT,
      generatedAt: snapshotAt.toISOString(),
      from: from.toISOString(),
      executionAuthority: 'NONE',
      modifiesExecution: false,
      promotionEligible: false,
      methodology: 'NEXT_COMPLETED_BROKER_NATIVE_M1_FIRST_CLOSED_TRADE_SNAPSHOT_BARRIER',
      warning:
        'Research only: first barriers are CLOSED TRADE SNAPSHOT levels, which may differ from the requested intent or levels at initial fill. M1 quote highs/lows are not guaranteed executable bid/ask fills; partial coverage remains PENDING or DATA_GAP. Never infer actual realised P&L from hypothetical target touches.',
      trades: trades.length,
      truncatedTrades: trades.length === maxTrades,
      quoteCandles: quoteCandles.length,
      byHorizon: Object.fromEntries(HORIZONS.map((h) => [String(h), summarize(outcomes, h)])),
      items: outcomes,
    };
    await client.query('COMMIT');
    return report;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function main() {
  const path = require('node:path');
  require('dotenv').config({
    path: process.env.IREXPRO_API_ENV_PATH || path.join(__dirname, '../.env'),
    quiet: true,
  });
  const { Client } = require('pg');
  const { getDatabaseSslOptions } = require('../dist/config/database-tls');
  const client = new Client({
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 5432),
    user: process.env.DB_USER ?? 'irexpro',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME ?? 'irexpro_dev',
    ssl: getDatabaseSslOptions(process.env.DB_SSL === 'true'),
    connectionTimeoutMillis: 10000,
    query_timeout: 35000,
    application_name: 'irexpro-profit-protection-short-horizon-readonly',
  });
  try {
    await client.connect();
    const report = await runProfitProtectionShortHorizonAudit({
      client,
      userId: process.env.VPS_FOREX_SCANNER_USER_ID,
      connectionId:
        process.env.M1_TACTICAL_MARKET_DATA_CONNECTION_ID ??
        process.env.VPS_FOREX_SCANNER_BROKER_CONNECTION_ID,
      since:
        process.env.PROFIT_PROTECTION_SHORT_AUDIT_SINCE ??
        new Date(Date.now() - 6 * 3600_000).toISOString(),
    });
    console.log('PROFIT_PROTECTION_SHORT_AUDIT ' + JSON.stringify(report));
  } finally {
    await client.end();
  }
}
module.exports = {
  ARTIFACT,
  HORIZONS,
  SCOPE_SQL,
  TRADES_SQL,
  CANDLES_SQL,
  classifyAfterExit,
  summarize,
  runProfitProtectionShortHorizonAudit,
};
if (require.main === module)
  main().catch(() => {
    console.error('PROFIT_PROTECTION_SHORT_AUDIT_FAILED read-only audit could not complete');
    process.exitCode = 1;
  });
