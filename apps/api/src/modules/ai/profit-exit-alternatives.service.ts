import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  compareExitAlternatives,
  compareAdverseExitCounterfactual,
  EXIT_ALTERNATIVES_ARTIFACT,
  ADVERSE_EXIT_COUNTERFACTUAL_ARTIFACT,
  ExitCandle,
} from './profit-exit-alternatives';

interface Candidate {
  trade_id: string;
  user_id: string;
  trade_intent_id: string;
  broker_connection_id: string;
  instrument: string;
  account_currency: string;
  direction: 'BUY' | 'SELL';
  closed_at: Date | string;
  observed_at: Date | string;
  fill_price: string;
  exit_price: string;
  stop_loss: string;
  take_profit: string;
  realised_pnl: string;
  commission: string;
  swap: string;
  runner_shadow: Record<string, unknown> | string | null;
}

interface AdverseCandidate extends Pick<
  Candidate,
  | 'trade_id'
  | 'user_id'
  | 'trade_intent_id'
  | 'broker_connection_id'
  | 'instrument'
  | 'account_currency'
  | 'direction'
  | 'closed_at'
  | 'fill_price'
  | 'exit_price'
  | 'stop_loss'
  | 'take_profit'
  | 'realised_pnl'
  | 'commission'
  | 'swap'
> {
  trigger_reason: 'ADVERSE_THESIS_FAILED' | 'EMERGENCY_ADVERSE_CUT' | 'UNVERIFIED_IN_TRADE_AUDIT';
}

/** Read-only prospective 60-minute exit comparison, 60s background audit.
 *
 * This worker cannot call an adapter, adjust stops, close a partial position
 * or influence execution. Only the user-scoped DEMO trade's *past* broker-native
 * quotes are inspected after the checkpoint has matured.
 */
@Injectable()
export class ProfitExitAlternativesService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ProfitExitAlternativesService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly dataSource: DataSource) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') return;
    const initial = setTimeout(() => void this.runOnce(), 25_000);
    initial.unref?.();
    this.timer = setInterval(() => void this.runOnce(), 60_000);
    this.timer.unref?.();
    this.logger.log('DEMO profit-exit alternatives audit enabled authority=NONE horizon=60m');
  }
  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async runOnce(now = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const rows = await this.loadCandidates(now);
      for (const row of rows) {
        try {
          const observedAt = new Date(row.observed_at);
          if (!Number.isFinite(observedAt.getTime())) continue;
          const candles = await this.loadVerifiedCandles(row, observedAt);
          const shadow =
            typeof row.runner_shadow === 'string'
              ? (JSON.parse(row.runner_shadow) as unknown)
              : row.runner_shadow;
          const runner =
            shadow && typeof shadow === 'object' && !Array.isArray(shadow)
              ? (shadow as Record<string, unknown>)
              : {};
          const price = Number(runner.indicativeProtectedStopPrice);
          const result = compareExitAlternatives({
            direction: row.direction,
            closeAt: observedAt,
            entryPrice: Number(row.fill_price),
            exitPrice: Number(row.exit_price),
            stopPrice: Number(row.stop_loss),
            takeProfitPrice: Number(row.take_profit),
            runnerStopPrice:
              runner.eligibleForFurtherResearch === true && Number.isFinite(price) && price > 0
                ? price
                : null,
            runnerEligible: runner.eligibleForFurtherResearch === true,
            grossPnl: Number(row.realised_pnl),
            commission: Number(row.commission),
            swap: Number(row.swap),
            candles,
          });
          await this.persist(row, observedAt, result);
        } catch (error) {
          this.logger.warn(
            `DEMO exit alternatives deferred trade=${row.trade_id}: ${(error as Error).message}`,
          );
        }
      }
      // Existing profit-lock study is independent; this second, separate
      // artifact observes *losing* adverse-thesis closes after broker closure.
      // It never changes the active session, provider order or exit policy.
      const adverseRows = await this.loadAdverseCandidates(now);
      for (const row of adverseRows) {
        try {
          const closedAt = new Date(row.closed_at);
          if (!Number.isFinite(closedAt.getTime())) continue;
          const candles = await this.loadVerifiedCandles(row, closedAt);
          const result = compareAdverseExitCounterfactual({
            direction: row.direction,
            closeAt: closedAt,
            entryPrice: Number(row.fill_price),
            exitPrice: Number(row.exit_price),
            stopPrice: Number(row.stop_loss),
            takeProfitPrice: Number(row.take_profit),
            grossPnl: Number(row.realised_pnl),
            commission: Number(row.commission),
            swap: Number(row.swap),
            candles,
          });
          await this.persistAdverse(row, closedAt, result);
        } catch (error) {
          this.logger.warn(`DEMO adverse-exit audit deferred: ${(error as Error).message}`);
        }
      }
    } catch (error) {
      this.logger.warn(`DEMO exit-alternatives cycle deferred: ${(error as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  private async loadCandidates(now: Date): Promise<Candidate[]> {
    return (await this.dataSource.query(
      `
        SELECT t.id AS trade_id, t.user_id, t.trade_intent_id,
          t.broker_connection_id, t.instrument, t.account_currency,
          t.direction, t.closed_at, t.fill_price, t.exit_price,
          t.stop_loss, t.take_profit, t.realised_pnl, t.commission, t.swap,
          a.metadata->>'observedAt' AS observed_at,
          a.metadata->'runnerShadow' AS runner_shadow
        FROM trading.trades t
        JOIN trading.trade_intents ti ON ti.id = t.trade_intent_id
          AND ti.user_id = t.user_id AND ti.broker_connection_id = t.broker_connection_id
        JOIN broker.broker_connections bc ON bc.id = t.broker_connection_id
          AND bc.user_id = t.user_id
        JOIN LATERAL (
          SELECT metadata FROM audit.audit_logs audit0
          WHERE audit0.action = 'DEMO_PROFIT_LOCK_TREND_RECHECK'
            AND audit0.resource_type = 'Trade'
            AND audit0.resource_id = t.id::text
            AND audit0.actor_user_id = t.user_id
            AND audit0.metadata->>'mode' = 'SHADOW_ONLY'
            AND audit0.metadata->>'observedAt' IS NOT NULL
          ORDER BY audit0.created_at DESC LIMIT 1
        ) a ON true
        WHERE t.status = 'CLOSED'
          AND t.close_reason = 'PROFIT_PROTECTION'
          AND bc.account_type = 'DEMO'
          AND bc.broker_id IN ('ctrader', 'pepperstone-ctrader', 'icmarkets-ctrader')
          AND t.closed_at <= $1::timestamptz - interval '65 minutes'
          AND t.closed_at >= $1::timestamptz - interval '21 days'
          AND t.realised_pnl IS NOT NULL
          AND t.commission IS NOT NULL
          AND t.fill_price IS NOT NULL AND t.exit_price IS NOT NULL
          AND t.stop_loss IS NOT NULL AND t.take_profit IS NOT NULL
          AND t.account_currency IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM trading.post_entry_shadow_observations o
            WHERE o.trade_id = t.id AND o.artifact = $2
              AND o.checkpoint_minutes = 60
          )
        ORDER BY t.closed_at DESC, t.id DESC
        LIMIT 25
      `,
      [now.toISOString(), EXIT_ALTERNATIVES_ARTIFACT],
    )) as Candidate[];
  }

  private async loadAdverseCandidates(now: Date): Promise<AdverseCandidate[]> {
    return (await this.dataSource.query(
      `
        SELECT t.id AS trade_id, t.user_id, t.trade_intent_id,
          t.broker_connection_id, t.instrument, t.account_currency,
          t.direction, t.closed_at, t.fill_price, t.exit_price,
          t.stop_loss, t.take_profit, t.realised_pnl, t.commission, t.swap,
          COALESCE(closure.metadata #>> '{aiCloseTrigger,reasonCode}',
            'UNVERIFIED_IN_TRADE_AUDIT') AS trigger_reason
        FROM trading.trades t
        JOIN trading.trade_intents ti ON ti.id = t.trade_intent_id
          AND ti.user_id = t.user_id AND ti.broker_connection_id = t.broker_connection_id
        JOIN broker.broker_connections bc ON bc.id = t.broker_connection_id
          AND bc.user_id = t.user_id
        LEFT JOIN LATERAL (
          SELECT metadata FROM audit.audit_logs audit0
          WHERE audit0.action = 'TRADE_CLOSED'
            AND audit0.resource_type = 'Trade'
            AND audit0.resource_id = t.id::text
            AND audit0.actor_user_id = t.user_id
            AND audit0.metadata #>> '{aiCloseTrigger,source}' = 'BROKER_ADVERSE_PROTECTION'
            AND audit0.metadata #>> '{aiCloseTrigger,reasonCode}'
              IN ('ADVERSE_THESIS_FAILED', 'EMERGENCY_ADVERSE_CUT')
          ORDER BY audit0.created_at DESC LIMIT 1
        ) closure ON true
        WHERE t.status = 'CLOSED'
          AND t.close_reason = 'AI_CLOSE_SIGNAL'
          AND t.realised_pnl < 0
          AND bc.account_type = 'DEMO'
          AND bc.broker_id IN ('ctrader', 'pepperstone-ctrader', 'icmarkets-ctrader')
          AND t.closed_at <= $1::timestamptz - interval '65 minutes'
          AND t.closed_at >= $1::timestamptz - interval '21 days'
          AND t.commission IS NOT NULL AND t.swap IS NOT NULL
          AND t.fill_price IS NOT NULL AND t.exit_price IS NOT NULL
          AND t.stop_loss IS NOT NULL AND t.take_profit IS NOT NULL
          AND t.account_currency IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM trading.post_entry_shadow_observations o
            WHERE o.trade_id = t.id AND o.artifact = $2
              AND o.checkpoint_minutes = 60
          )
        ORDER BY t.closed_at DESC, t.id DESC
        LIMIT 25
      `,
      [now.toISOString(), ADVERSE_EXIT_COUNTERFACTUAL_ARTIFACT],
    )) as AdverseCandidate[];
  }

  private async loadVerifiedCandles(
    row: Pick<Candidate, 'broker_connection_id' | 'instrument'>,
    closeAt: Date,
  ): Promise<ExitCandle[]> {
    return (await this.dataSource.query(
      `
        SELECT bucket_time, high, low, close, source,
          sample_count, positive_quote_sample_count, last_quote_sample_at
        FROM market_data.provider_quote_candles
        WHERE connection_id = $1 AND instrument = $2
          AND timeframe = 'M1' AND source = 'ctrader-broker-native'
          AND positive_quote_sample_count > 0
          AND last_quote_sample_at >= bucket_time
          AND last_quote_sample_at < bucket_time + interval '1 minute'
          AND bucket_time >= date_trunc('minute', $3::timestamptz) + interval '1 minute'
          AND bucket_time + interval '1 minute' <= $3::timestamptz + interval '60 minutes'
        ORDER BY bucket_time ASC LIMIT 60
      `,
      [row.broker_connection_id, row.instrument.toUpperCase(), closeAt.toISOString()],
    )) as ExitCandle[];
  }

  private async persistAdverse(
    row: AdverseCandidate,
    closeAt: Date,
    result: ReturnType<typeof compareAdverseExitCounterfactual>,
  ): Promise<void> {
    const checkpointAt = new Date(closeAt.getTime() + 60 * 60_000);
    const response = {
      artifact: ADVERSE_EXIT_COUNTERFACTUAL_ARTIFACT,
      snapshotAt: closeAt.toISOString(),
      originalTradeCurrency: row.account_currency,
      brokerAdverseReason: row.trigger_reason,
      brokerAdverseTriggerAudited: row.trigger_reason !== 'UNVERIFIED_IN_TRADE_AUDIT',
      ...result,
      quoteProvenance: 'CTRADER_POSITIVE_LIVE_QUOTES_WITHIN_M1_BUCKET',
      limitations: 'MIDPOINT_BAR_TOUCH_NOT_BROKER_FILL;SLIPPAGE_SWAP_AND_FUTURE_FEES_UNKNOWN',
    };
    await this.dataSource.query(
      `
        INSERT INTO trading.post_entry_shadow_observations (
          user_id, trade_id, trade_intent_id, execution_broker_connection_id,
          market_data_connection_id, artifact, checkpoint_minutes, checkpoint_at, evaluated_at,
          state, reason, probability, threshold, current_r, eligible_profit_state, action,
          market_data_sources, response, execution_authority, modifies_execution, updated_at
        ) VALUES (
          $1,$2,$3,$4,$4,$5,60,$6,now(),$7,'ADVERSE_EXIT_RESEARCH_ONLY',
          NULL,NULL,NULL,false,'OBSERVE',$8::jsonb,$9::jsonb,'NONE',false,now()
        )
        ON CONFLICT (trade_id, artifact, checkpoint_minutes) DO NOTHING
      `,
      [
        row.user_id,
        row.trade_id,
        row.trade_intent_id,
        row.broker_connection_id,
        ADVERSE_EXIT_COUNTERFACTUAL_ARTIFACT,
        checkpointAt.toISOString(),
        result.originalSlTpHold.outcome,
        JSON.stringify({ M1: 'ctrader-broker-native-positive-live-quotes' }),
        JSON.stringify(response),
      ],
    );
  }

  private async persist(
    row: Candidate,
    closeAt: Date,
    result: ReturnType<typeof compareExitAlternatives>,
  ): Promise<void> {
    const checkpointAt = new Date(closeAt.getTime() + 60 * 60_000);
    const response = {
      artifact: EXIT_ALTERNATIVES_ARTIFACT,
      snapshotAt: closeAt.toISOString(),
      originalTradeCurrency: row.account_currency,
      ...result,
      brokerFillCertified: false,
      partialCloseAccountingCertified: false,
      quoteProvenance: 'CTRADER_POSITIVE_LIVE_QUOTES_WITHIN_M1_BUCKET',
    };
    await this.dataSource.query(
      `
        INSERT INTO trading.post_entry_shadow_observations (
          user_id, trade_id, trade_intent_id, execution_broker_connection_id,
          market_data_connection_id, artifact, checkpoint_minutes, checkpoint_at, evaluated_at,
          state, reason, probability, threshold, current_r, eligible_profit_state, action,
          market_data_sources, response, execution_authority, modifies_execution, updated_at
        ) VALUES (
          $1,$2,$3,$4,$4,$5,60,$6,now(),$7,'EXIT_ALTERNATIVES_QUOTE_VERIFIED',
          NULL,NULL,NULL,false,'OBSERVE',$8::jsonb,$9::jsonb,'NONE',false,now()
        )
        ON CONFLICT (trade_id, artifact, checkpoint_minutes) DO NOTHING
      `,
      [
        row.user_id,
        row.trade_id,
        row.trade_intent_id,
        row.broker_connection_id,
        EXIT_ALTERNATIVES_ARTIFACT,
        checkpointAt.toISOString(),
        result.runner.outcome,
        JSON.stringify({ M1: 'ctrader-broker-native-positive-live-quotes' }),
        JSON.stringify(response),
      ],
    );
  }
}
