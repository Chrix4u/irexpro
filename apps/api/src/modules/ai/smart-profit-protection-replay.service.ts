import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CTRADER_FAMILY_BROKER_IDS } from '../broker/registry/broker-catalog';
import {
  replaySmartProfitProtection,
  SMART_PROTECTION_POLICIES,
  SMART_PROTECTION_SHADOW_VERSION,
  type SmartProtectionCandle,
  type SmartProtectionPolicy,
  type SmartProtectionReplayResult,
  type SmartProtectionTrade,
} from './smart-profit-protection-shadow';

const MAX_TRADES = 12;
const HISTORICAL_WINDOW_DAYS = 14;
const MAX_QUOTE_ROWS_PER_TRADE = 1_200;
const MIN_TRADE_SAMPLES_FOR_PROMOTION = 60;

interface TradeRow {
  instrument: string;
  direction: 'BUY' | 'SELL';
  strategy_route: string | null;
  opened_at: Date | string;
  closed_at: Date | string;
  fill_price: string | number;
  stop_loss: string | number;
  take_profit: string | number;
  exit_price: string | number;
  initial_risk_pnl: string | number | null;
  realised_pnl: string | number;
  commission: string | number;
  swap: string | number;
  broker_connection_id: string;
  account_currency: string;
}

interface ActiveBrokerRow {
  broker_connection_id: string;
  broker_id: string;
  account_currency: string;
}

function validNumber(value: unknown): number {
  return value === null || value === '' ? NaN : Number(value);
}

function policySummary(rows: SmartProtectionReplayResult[], policy: SmartProtectionPolicy) {
  const needsTrendContext =
    policy === 'CONFIRMED_TREND_EXIT' || policy === 'STAGED_PARTIAL_TREND_RUNNER';
  const cohort = rows.filter(
    (r) =>
      r.dataQuality === 'COMPLETE' &&
      (!needsTrendContext || (r.contextualM5Bars >= 3 && r.contextualM15Bars >= 3)),
  );
  const all = cohort.map((r) => ({
    baseline: r.actualNetPnl,
    tp: r.actualTpWinner,
    candidate: r.alternatives.find((a) => a.policy === policy)!,
  }));
  const tpWinners = all.filter((r) => r.tp);
  const netTotal = (items: number[]) =>
    Math.round(items.reduce((sum, value) => sum + value, 0) * 100) / 100;
  const tpCutShort = tpWinners.filter((r) => r.candidate.truncatedActualTpWinner).length;
  const wasLoss = all.filter((r) => r.baseline < 0);
  return {
    policy,
    qualifiedTrades: all.length,
    tpWinners: tpWinners.length,
    tpWinnersPrematureFullExit: tpCutShort,
    tpWinnersStillHeldToActualTp: tpWinners.length - tpCutShort,
    actualNetPnl: netTotal(all.map((r) => r.baseline)),
    hypotheticalNetPnl: netTotal(all.map((r) => r.candidate.hypotheticalNetPnl)),
    hypotheticalNetDelta: netTotal(all.map((r) => r.candidate.deltaVsActualNet)),
    actualNetLosersImproved: wasLoss.filter((r) => r.candidate.improvedActualNetLoser).length,
    partialRunnerActionCount: all.filter(
      (r) => r.candidate.action === 'PARTIAL_AND_HOLD' || r.candidate.action === 'PARTIAL_AND_EXIT',
    ).length,
    dataSufficientForPromotion: false as const,
    whyNotPromotable:
      all.length < MIN_TRADE_SAMPLES_FOR_PROMOTION
        ? 'INSUFFICIENT_INDEPENDENT_CLOSED_TRADES'
        : 'HISTORICAL_REPLAY_NOT_PROSPECTIVE_BROKER_VALIDATION',
  };
}

/**
 * Bounded authenticated, account/currency-isolated broker-native replay.
 * Read-only. Historical bar-close simulations cannot validate a live broker
 * stop amendment, partial-close fill, stop distance, slippage or order ack.
 */
@Injectable()
export class SmartProfitProtectionReplayService {
  constructor(private readonly dataSource: DataSource) {}

  async getUserReplay(userId: string) {
    const selected = (await this.dataSource.query(
      `
      SELECT b.id AS broker_connection_id, b.broker_id, b.account_currency
      FROM trading.trading_sessions s
      JOIN broker.broker_connections b
        ON b.id = s.broker_connection_id AND b.user_id = s.user_id
      WHERE s.user_id = $1
        AND s.execution_mode = 'FULL_AUTO'
        AND s.started_at >= NOW() - interval '30 days'
        AND b.account_type = 'DEMO'
        AND b.status = 'CONNECTED'
        AND b.broker_id = ANY($2::text[])
      ORDER BY (s.ended_at IS NULL) DESC, s.started_at DESC
      LIMIT 1
    `,
      [userId, [...CTRADER_FAMILY_BROKER_IDS]],
    )) as ActiveBrokerRow[];
    const broker = selected[0];
    const base = {
      version: SMART_PROTECTION_SHADOW_VERSION,
      executionAuthority: 'NONE' as const,
      modifiesExecution: false as const,
      liveStopAmendmentEnabled: false as const,
      autoPromotionEnabled: false as const,
      evidenceType: 'ONE_MINUTE_BID_ASK_CLOSE_REPLAY' as const,
      caveats: [
        'Each decision uses only fully completed broker-native bars, then a hypothetical NEXT valid M1 quote close.',
        'Historical settled commissions and swaps are used only for scoring; not for signal formation.',
        'Intra-minute stop/TP order sequencing, slippage, partial-close commissions and exact fill prices are unproven.',
        'Partial runner assumes pro-rata broker gross P&L and unchanged total settled transaction costs.',
        'A historical win or loss cannot prove whether a live broker stop modification would have been acknowledged.',
      ],
      windowDays: HISTORICAL_WINDOW_DAYS,
      maxTrades: MAX_TRADES,
      minimumIndependentTradesBeforePromotion: MIN_TRADE_SAMPLES_FOR_PROMOTION,
      broker: broker?.broker_id ?? null,
      accountCurrency: broker?.account_currency ?? null,
    };
    if (!broker) {
      return {
        ...base,
        closedTradesInspected: 0,
        completeReplays: 0,
        routeComparisons: [],
        trades: [],
      };
    }

    // Fee evidence is complete or the row is excluded. No mixture of
    // different broker accounts, currencies, users, or LIVE data.
    const closed = (await this.dataSource.query(
      `
      SELECT t.instrument, t.direction,
        ti.metadata->>'multimodel_plan_b_route' AS strategy_route,
        t.opened_at, t.closed_at, t.fill_price, t.stop_loss, t.take_profit,
        t.exit_price, t.realised_pnl, t.commission, t.swap,
        t.broker_connection_id, t.account_currency,
        COALESCE(
          NULLIF(ca.sizing_inputs->>'finalRiskAtStop','')::numeric,
          NULLIF(ca.sizing_inputs->>'riskAmount','')::numeric
        ) AS initial_risk_pnl
      FROM trading.trades t
      JOIN trading.trade_intents ti
        ON ti.id = t.trade_intent_id AND ti.user_id = t.user_id
        AND ti.broker_connection_id = t.broker_connection_id
      JOIN broker.broker_connections b
        ON b.id = t.broker_connection_id AND b.user_id = t.user_id
      LEFT JOIN LATERAL (
        SELECT sizing_inputs FROM trading.capital_allocations ca
        WHERE ca.trade_intent_id = t.trade_intent_id
        ORDER BY ca.created_at DESC LIMIT 1
      ) ca ON true
      WHERE t.user_id = $1 AND t.broker_connection_id = $2::uuid
        AND t.account_currency = $3
        AND b.account_type = 'DEMO'
        AND t.status = 'CLOSED'
        AND t.closed_at >= NOW() - interval '14 days'
        AND t.closed_at <= NOW()
        AND t.fill_price IS NOT NULL AND t.stop_loss IS NOT NULL
        AND t.take_profit IS NOT NULL AND t.exit_price IS NOT NULL
        AND t.realised_pnl IS NOT NULL AND t.commission IS NOT NULL
        AND t.swap IS NOT NULL
      ORDER BY t.closed_at DESC, t.id DESC LIMIT $4
    `,
      [userId, broker.broker_connection_id, broker.account_currency, MAX_TRADES],
    )) as TradeRow[];

    const trades: Array<SmartProtectionReplayResult & { closedAt: string }> = [];
    for (const row of closed) {
      // The positive historical quote count must be backed by observed quotes
      // on the SAME broker connection and exact instrument. Only M1/M5/M15.
      const candles = (await this.dataSource.query(
        `
        SELECT timeframe, bucket_time, source, close, bid_close, ask_close,
          sample_count, positive_quote_sample_count, last_quote_sample_at
        FROM market_data.provider_quote_candles
        WHERE connection_id = $1::uuid AND instrument = $2
          AND timeframe = ANY($3::text[])
          AND bucket_time >= date_trunc('minute', $4::timestamptz) - interval '45 minutes'
          AND bucket_time <= date_trunc('minute', $5::timestamptz)
        ORDER BY bucket_time ASC, timeframe ASC LIMIT $6
      `,
        [
          row.broker_connection_id,
          row.instrument,
          ['M1', 'M5', 'M15'],
          row.opened_at,
          row.closed_at,
          MAX_QUOTE_ROWS_PER_TRADE,
        ],
      )) as SmartProtectionCandle[];

      const trade: SmartProtectionTrade = {
        instrument: row.instrument,
        direction: row.direction,
        strategyRoute: row.strategy_route,
        openedAt: new Date(row.opened_at),
        closedAt: new Date(row.closed_at),
        entryPrice: validNumber(row.fill_price),
        stopLoss: validNumber(row.stop_loss),
        takeProfit: validNumber(row.take_profit),
        exitPrice: validNumber(row.exit_price),
        initialRiskCash: validNumber(row.initial_risk_pnl),
        settledGrossPnl: validNumber(row.realised_pnl),
        settledCommission: validNumber(row.commission),
        settledSwap: validNumber(row.swap),
        candles,
      };
      trades.push({
        ...replaySmartProfitProtection(trade),
        closedAt: trade.closedAt.toISOString(),
      });
    }
    return {
      ...base,
      closedTradesInspected: trades.length,
      completeReplays: trades.filter((t) => t.dataQuality === 'COMPLETE').length,
      routeComparisons: SMART_PROTECTION_POLICIES.map((policy) => policySummary(trades, policy)),
      trades,
    };
  }
}
