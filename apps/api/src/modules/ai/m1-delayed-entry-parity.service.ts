import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  DELAY_ENTRY_PARITY_SHADOW_ARTIFACT,
  DELAY_ENTRY_PARITY_HORIZONS,
  DELAY_ENTRY_CONFIRMATION_WINDOW_MINUTES,
  evaluateDelayedEntryParity,
  type DelayEntryParityHorizon,
  type DelayedEntryParityResult,
  type VerifiedNativeMinute,
} from './m1-delayed-entry-parity-shadow';

const INTERVAL_MS = 120_000;
const MAX_CANDIDATES = 25;

interface ShadowTradeRow {
  id: string;
  user_id: string;
  trade_intent_id: string;
  broker_connection_id: string;
  broker_id: string;
  account_currency: string | null;
  instrument: string;
  direction: 'BUY' | 'SELL';
  opened_at: Date | string;
  closed_at: Date | string;
  fill_price: string;
  stop_loss: string;
  take_profit: string;
  exit_price: string | null;
  realised_pnl: string | null;
  commission: string | null;
  swap: string | null;
  lot_size: string;
  close_reason: string;
  timeframe: string | null;
  route: string | null;
  pretrade_features: Record<string, unknown> | null;
}

/**
 * Read-only, quote-indicative, retrospective research worker.
 * It never creates a signal, changes demo risk limits, connects to the broker
 * order gateway or upgrades any strategy to production.
 */
@Injectable()
export class M1DelayedEntryParityService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(M1DelayedEntryParityService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly dataSource: DataSource) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') return;
    setTimeout(() => void this.runOnce(), 61_000).unref?.();
    this.timer = setInterval(() => void this.runOnce(), INTERVAL_MS);
    this.timer.unref?.();
    this.logger.log('M1 confirmed-delay risk-parity counterfactual active 60/240m, shadow only');
  }
  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async runOnce(now = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const horizon of DELAY_ENTRY_PARITY_HORIZONS) {
        const candidates = await this.loadCandidates(now, horizon);
        for (const row of candidates) {
          try {
            const openedAt = new Date(row.opened_at);
            const start = (Math.floor(openedAt.getTime() / 60_000) + 1) * 60_000;
            const until = start + (DELAY_ENTRY_CONFIRMATION_WINDOW_MINUTES + 1 + horizon) * 60_000;
            const candles = await this.loadNativeCandles(
              row.broker_connection_id,
              row.instrument,
              new Date(start),
              new Date(until),
            );
            const evaluated = evaluateDelayedEntryParity({
              instrument: row.instrument,
              direction: row.direction,
              openedAt,
              originalFill: Number(row.fill_price),
              originalStop: Number(row.stop_loss),
              originalTarget: Number(row.take_profit),
              originalExit: row.exit_price == null ? null : Number(row.exit_price),
              actualGrossPnl: row.realised_pnl == null ? null : Number(row.realised_pnl),
              actualCommission: row.commission == null ? null : Number(row.commission),
              horizonMinutes: horizon,
              candles,
            });
            await this.persist(row, horizon, evaluated, new Date(until));
          } catch (error) {
            this.logger.warn(
              'Delayed-entry research observation deferred: ' + (error as Error).message,
            );
          }
        }
      }
    } catch (error) {
      this.logger.warn('Delayed-entry research pass deferred: ' + (error as Error).message);
    } finally {
      this.running = false;
    }
  }

  private async loadCandidates(
    now: Date,
    horizon: DelayEntryParityHorizon,
  ): Promise<ShadowTradeRow[]> {
    return (await this.dataSource.query(
      `
        SELECT t.id, t.user_id, t.trade_intent_id, t.broker_connection_id,
          bc.broker_id, t.account_currency, t.instrument, t.direction,
          t.opened_at, t.closed_at, t.fill_price, t.stop_loss, t.take_profit,
          t.exit_price, t.realised_pnl, t.commission, t.swap, t.lot_size,
          t.close_reason, ti.timeframe,
          ti.metadata->>'multimodel_plan_b_route' AS route,
          jsonb_build_object(
            'source', ti.metadata->'signal_source',
            'policy', ti.metadata->'m1_policy_version',
            'confidence', ti.metadata->'confidenceScore',
            'route', ti.metadata->'m1_tactical_route',
            'marketRegime', ti.metadata->'marketRegime',
            'trainedExpertConfidence', ti.metadata->'multimodel_trained_expert_confidence'
          ) AS pretrade_features
        FROM trading.trades t
        JOIN broker.broker_connections bc
          ON bc.id = t.broker_connection_id AND bc.user_id = t.user_id
        JOIN trading.trade_intents ti
          ON ti.id = t.trade_intent_id AND ti.user_id = t.user_id
          AND ti.broker_connection_id = t.broker_connection_id
        WHERE t.status='CLOSED'
          AND bc.account_type='DEMO'
          AND bc.broker_id IN ('ctrader','pepperstone-ctrader','icmarkets-ctrader')
          AND t.opened_at IS NOT NULL AND t.closed_at IS NOT NULL
          AND t.fill_price IS NOT NULL AND t.stop_loss IS NOT NULL
          AND t.take_profit IS NOT NULL
          -- Never evaluate before all hypothetical future quotes could exist.
          AND t.opened_at < $1::timestamptz - ($2::int + $3::int + 8) * interval '1 minute'
          AND t.closed_at <= $1::timestamptz - interval '2 minutes'
          AND t.closed_at >= $1::timestamptz - interval '21 days'
          AND NOT EXISTS (
            SELECT 1 FROM trading.post_entry_shadow_observations o
            WHERE o.trade_id=t.id AND o.artifact=$4 AND o.checkpoint_minutes=$2
          )
        ORDER BY t.closed_at DESC, t.id DESC
        LIMIT $5
      `,
      [
        now.toISOString(),
        horizon,
        DELAY_ENTRY_CONFIRMATION_WINDOW_MINUTES,
        DELAY_ENTRY_PARITY_SHADOW_ARTIFACT,
        MAX_CANDIDATES,
      ],
    )) as ShadowTradeRow[];
  }

  private async loadNativeCandles(
    connectionId: string,
    instrument: string,
    from: Date,
    until: Date,
  ): Promise<VerifiedNativeMinute[]> {
    return (await this.dataSource.query(
      `
        SELECT bucket_time, open, high, low, close, sample_count,
          positive_quote_sample_count, first_sample_at, last_quote_sample_at,
          spread_close, source
        FROM market_data.provider_quote_candles
        WHERE connection_id = $1 AND instrument = $2
          AND timeframe = 'M1'
          AND bucket_time >= $3::timestamptz
          AND bucket_time < $4::timestamptz
        ORDER BY bucket_time ASC
      `,
      [connectionId, instrument.toUpperCase(), from.toISOString(), until.toISOString()],
    )) as VerifiedNativeMinute[];
  }

  private async persist(
    row: ShadowTradeRow,
    horizon: DelayEntryParityHorizon,
    evaluated: DelayedEntryParityResult,
    checkpointAt: Date,
  ): Promise<void> {
    const response = {
      ...evaluated,
      brokerId: row.broker_id,
      instrument: row.instrument,
      originalOpenedAt: new Date(row.opened_at).toISOString(),
      actualClosedAt: new Date(row.closed_at).toISOString(),
      originalTimeframe: row.timeframe,
      originalRoute: row.route,
      pretradeFeatures: row.pretrade_features,
      originalFill: row.fill_price,
      originalStop: row.stop_loss,
      originalTarget: row.take_profit,
      actualExit: row.exit_price,
      actualGrossPnl: row.realised_pnl,
      actualCommission: row.commission,
      actualSwap: row.swap,
      lotSize: row.lot_size,
      accountCurrency: row.account_currency,
      originalCloseReason: row.close_reason,
      methodology: 'CAUSAL_COMPLETED_M1_CONFIRMATION_THEN_NEXT_BAR_OPEN_INDICATIVE_QUOTE_REPLAY',
      limitation:
        'Not executable P&L: M1 OHLC high/low is unordered; quote opens are not broker fills. Excludes spread at actual entry, slippage, swaps and opportunity costs. Commission is extrapolated from actual fill/exit geometry; counterfactual hold period differs from actual.',
      stopVariationAuthority: 'NONE',
      execution_authority: 'NONE',
      modifies_execution: false,
    };
    await this.dataSource.query(
      `
        INSERT INTO trading.post_entry_shadow_observations (
          user_id, trade_id, trade_intent_id, execution_broker_connection_id,
          market_data_connection_id, artifact, checkpoint_minutes, checkpoint_at,
          evaluated_at, state, reason, current_r, eligible_profit_state,
          action, market_data_sources, response, execution_authority,
          modifies_execution, updated_at
        ) VALUES (
          $1,$2,$3,$4,$4,$5,$6,$7,now(),$8,$9,NULL,false,
          'OBSERVE',$10::jsonb,$11::jsonb,'NONE',false,now()
        ) ON CONFLICT (trade_id, artifact, checkpoint_minutes) DO NOTHING
      `,
      [
        row.user_id,
        row.id,
        row.trade_intent_id,
        row.broker_connection_id,
        DELAY_ENTRY_PARITY_SHADOW_ARTIFACT,
        horizon,
        checkpointAt.toISOString(),
        evaluated.state,
        evaluated.state,
        JSON.stringify({ M1: 'ctrader-broker-native' }),
        JSON.stringify(response),
      ],
    );
  }
}
