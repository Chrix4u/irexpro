import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';

export const PROFIT_PROTECTION_COUNTERFACTUAL_ARTIFACT =
  'profit-protection-counterfactual-v1' as const;
export const PROFIT_PROTECTION_COUNTERFACTUAL_CHECKPOINT_MINUTES = 240;
const PROFIT_PROTECTION_COUNTERFACTUAL_INTERVAL_MS = 60_000;

export type ProfitProtectionCounterfactualOutcome =
  | 'TP_FIRST'
  | 'SL_FIRST'
  | 'AMBIGUOUS_SAME_M1'
  | 'NEITHER_4H'
  | 'DATA_GAP';

export interface ProfitProtectionReplayCandle {
  bucket_time: Date | string;
  high: number | string;
  low: number | string;
  sample_count: number | string;
  source: string;
}

export interface ProfitProtectionCounterfactualResult {
  outcome: ProfitProtectionCounterfactualOutcome;
  eventAt: Date | null;
  minutesAfterClose: number | null;
  candleCount: number;
  maxGapSeconds: number | null;
}

function finite(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function classifyProfitProtectionCounterfactual(input: {
  direction: 'BUY' | 'SELL';
  closeAt: Date;
  takeProfit: number;
  stopLoss: number;
  candles: ProfitProtectionReplayCandle[];
}): ProfitProtectionCounterfactualResult {
  const disabled = (outcome: ProfitProtectionCounterfactualOutcome, eventAt: Date | null = null, candleCount = 0, maxGapSeconds: number | null = null): ProfitProtectionCounterfactualResult => ({
    outcome,
    eventAt,
    minutesAfterClose: eventAt
      ? Math.round(((eventAt.getTime() - input.closeAt.getTime()) / 60_000) * 10) / 10
      : null,
    candleCount,
    maxGapSeconds,
  });
  if (
    !Number.isFinite(input.closeAt.getTime()) ||
    !Number.isFinite(input.takeProfit) ||
    !Number.isFinite(input.stopLoss) ||
    input.takeProfit <= 0 ||
    input.stopLoss <= 0
  ) return disabled('DATA_GAP');

  const rows = input.candles
    .flatMap((row) => {
      const at = new Date(row.bucket_time);
      const high = finite(row.high);
      const low = finite(row.low);
      const samples = finite(row.sample_count);
      if (
        !Number.isFinite(at.getTime()) || high === null || low === null || high < low ||
        samples === null || samples <= 0 || row.source !== 'ctrader-broker-native'
      ) return [];
      return [{ at, high, low }];
    })
    .sort((a, b) => a.at.getTime() - b.at.getTime());
  if (!rows.length) return disabled('DATA_GAP');

  const expectedFirst = new Date(input.closeAt);
  expectedFirst.setUTCSeconds(0, 0);
  expectedFirst.setUTCMinutes(expectedFirst.getUTCMinutes() + 1);
  let gapBeforeCurrent = rows[0]!.at.getTime() - expectedFirst.getTime() > 90_000;
  let maxGapSeconds = Math.max(0, (rows[0]!.at.getTime() - expectedFirst.getTime()) / 1000);
  let previousAt: Date | null = null;

  for (const row of rows) {
    if (previousAt) {
      const gapSeconds = (row.at.getTime() - previousAt.getTime()) / 1000;
      maxGapSeconds = Math.max(maxGapSeconds, gapSeconds);
      if (gapSeconds > 90) gapBeforeCurrent = true;
    }
    previousAt = row.at;

    const tpHit = input.direction === 'BUY'
      ? row.high >= input.takeProfit
      : row.low <= input.takeProfit;
    const slHit = input.direction === 'BUY'
      ? row.low <= input.stopLoss
      : row.high >= input.stopLoss;
    if (!tpHit && !slHit) continue;
    if (gapBeforeCurrent) return disabled('DATA_GAP', null, rows.length, maxGapSeconds);
    if (tpHit && slHit) return disabled('AMBIGUOUS_SAME_M1', row.at, rows.length, maxGapSeconds);
    return disabled(tpHit ? 'TP_FIRST' : 'SL_FIRST', row.at, rows.length, maxGapSeconds);
  }

  const horizonEnd = input.closeAt.getTime() + PROFIT_PROTECTION_COUNTERFACTUAL_CHECKPOINT_MINUTES * 60_000;
  const lastCoverageEnd = rows[rows.length - 1]!.at.getTime() + 60_000;
  if (gapBeforeCurrent || lastCoverageEnd < horizonEnd) {
    return disabled('DATA_GAP', null, rows.length, maxGapSeconds);
  }
  return disabled('NEITHER_4H', null, rows.length, maxGapSeconds);
}

interface CandidateRow {
  trade_id: string;
  user_id: string;
  trade_intent_id: string;
  broker_connection_id: string;
  instrument: string;
  direction: 'BUY' | 'SELL';
  realised_pnl: string | number;
  stop_loss: string | number;
  take_profit: string | number;
  closed_at: Date | string;
  initial_risk_pnl: string | number | null;
  strategy_route: string | null;
}

@Injectable()
export class ProfitProtectionCounterfactualService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ProfitProtectionCounterfactualService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly dataSource: DataSource) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') return;
    const initial = setTimeout(() => void this.runOnce(), 20_000);
    initial.unref?.();
    this.timer = setInterval(() => void this.runOnce(), PROFIT_PROTECTION_COUNTERFACTUAL_INTERVAL_MS);
    this.timer.unref?.();
    this.logger.log('profit-protection counterfactual tracer enabled checkpoint=240m authority=NONE modifiesExecution=false');
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async runOnce(now = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const candidates = await this.loadCandidates(now);
      for (const row of candidates) {
        const closeAt = new Date(row.closed_at);
        const tp = finite(row.take_profit);
        const sl = finite(row.stop_loss);
        if (!Number.isFinite(closeAt.getTime()) || tp === null || sl === null) continue;
        const candles = await this.loadCandles(row, closeAt);
        const result = classifyProfitProtectionCounterfactual({
          direction: row.direction,
          closeAt,
          takeProfit: tp,
          stopLoss: sl,
          candles,
        });
        await this.persist(row, closeAt, result);
      }
    } catch (error) {
      this.logger.warn(`profit-protection counterfactual cycle deferred: ${(error as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  private async loadCandidates(now: Date): Promise<CandidateRow[]> {
    return (await this.dataSource.query(
      `
        SELECT
          t.id AS trade_id, t.user_id, t.trade_intent_id, t.broker_connection_id,
          t.instrument, t.direction, t.realised_pnl, t.stop_loss, t.take_profit, t.closed_at,
          COALESCE(
            NULLIF(ca.sizing_inputs->>'finalRiskAtStop', '')::numeric,
            NULLIF(ca.sizing_inputs->>'riskAmount', '')::numeric
          ) AS initial_risk_pnl,
          COALESCE(NULLIF(ti.metadata->>'multimodel_plan_b_route', ''), NULLIF(ti.metadata->>'m1_tactical_route', '')) AS strategy_route
        FROM trading.trades t
        JOIN broker.broker_connections bc ON bc.id = t.broker_connection_id
        JOIN trading.trade_intents ti ON ti.id = t.trade_intent_id
        LEFT JOIN LATERAL (
          SELECT sizing_inputs FROM trading.capital_allocations ca0
          WHERE ca0.trade_intent_id = t.trade_intent_id
          ORDER BY ca0.created_at DESC LIMIT 1
        ) ca ON true
        WHERE t.status = 'CLOSED'
          AND t.close_reason = 'PROFIT_PROTECTION'
          AND t.realised_pnl IS NOT NULL
          AND t.stop_loss IS NOT NULL
          AND t.take_profit IS NOT NULL
          AND t.closed_at IS NOT NULL
          AND bc.account_type = 'DEMO'
          AND bc.broker_id IN ('ctrader', 'pepperstone-ctrader', 'icmarkets-ctrader')
          AND t.closed_at <= $1::timestamptz - interval '4 hours'
          AND NOT EXISTS (
            SELECT 1 FROM trading.post_entry_shadow_observations o
            WHERE o.trade_id = t.id
              AND o.artifact = $2
              AND o.checkpoint_minutes = 240
          )
        ORDER BY t.closed_at ASC
        LIMIT 100
      `,
      [now.toISOString(), PROFIT_PROTECTION_COUNTERFACTUAL_ARTIFACT],
    )) as CandidateRow[];
  }

  private async loadCandles(row: CandidateRow, closeAt: Date): Promise<ProfitProtectionReplayCandle[]> {
    return (await this.dataSource.query(
      `
        SELECT bucket_time, high, low, sample_count, source
        FROM market_data.provider_quote_candles
        WHERE connection_id = $1
          AND instrument = $2
          AND timeframe = 'M1'
          AND source = 'ctrader-broker-native'
          AND bucket_time >= date_trunc('minute', $3::timestamptz) + interval '1 minute'
          AND bucket_time <= $3::timestamptz + interval '4 hours'
        ORDER BY bucket_time ASC
      `,
      [row.broker_connection_id, row.instrument.toUpperCase(), closeAt.toISOString()],
    )) as ProfitProtectionReplayCandle[];
  }

  private async persist(row: CandidateRow, closeAt: Date, result: ProfitProtectionCounterfactualResult): Promise<void> {
    const risk = finite(row.initial_risk_pnl);
    const pnl = finite(row.realised_pnl);
    const actualExitR = risk && risk > 0 && pnl !== null ? pnl / risk : null;
    const response = {
      artifact: PROFIT_PROTECTION_COUNTERFACTUAL_ARTIFACT,
      outcome: result.outcome,
      original_take_profit: finite(row.take_profit),
      original_stop_loss: finite(row.stop_loss),
      realised_pnl: pnl,
      actual_exit_r: actualExitR,
      strategy_route: row.strategy_route,
      event_at: result.eventAt?.toISOString() ?? null,
      minutes_after_close: result.minutesAfterClose,
      candle_count: result.candleCount,
      max_gap_seconds: result.maxGapSeconds,
      methodology: 'NEXT_FULL_M1_FIRST_ORIGINAL_BARRIER_WITHIN_4H',
      execution_authority: 'NONE',
      modifies_execution: false,
    };
    await this.dataSource.query(
      `
        INSERT INTO trading.post_entry_shadow_observations (
          user_id, trade_id, trade_intent_id, execution_broker_connection_id,
          market_data_connection_id, artifact, checkpoint_minutes, checkpoint_at, evaluated_at,
          state, reason, probability, threshold, current_r, eligible_profit_state, action,
          market_data_sources, response, execution_authority, modifies_execution, updated_at
        ) VALUES (
          $1,$2,$3,$4,$4,$5,$6,$7,now(),$8,'ORIGINAL_BARRIER_REPLAY',NULL,NULL,$9,false,$10,
          $11::jsonb,$12::jsonb,'NONE',false,now()
        )
        ON CONFLICT (trade_id, artifact, checkpoint_minutes) DO NOTHING
      `,
      [
        row.user_id, row.trade_id, row.trade_intent_id, row.broker_connection_id,
        PROFIT_PROTECTION_COUNTERFACTUAL_ARTIFACT,
        PROFIT_PROTECTION_COUNTERFACTUAL_CHECKPOINT_MINUTES,
        new Date(closeAt.getTime() + PROFIT_PROTECTION_COUNTERFACTUAL_CHECKPOINT_MINUTES * 60_000).toISOString(),
        result.outcome,
        actualExitR,
        'OBSERVE',
        JSON.stringify({ M1: 'ctrader-broker-native' }),
        JSON.stringify(response),
      ],
    );
  }
}
