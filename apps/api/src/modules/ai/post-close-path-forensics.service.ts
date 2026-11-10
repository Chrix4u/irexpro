import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';

/**
 * Historical-only, broker-native M1 replay across DEMO closed trades.
 * NO order adapter, trading authority, model promotion or execution dependency.
 * Future quote observations are never available to the entry/exit scheduler.
 */
export const POST_CLOSE_PATH_FORENSICS_ARTIFACT = 'post-close-path-forensics-verified-m1-v1';
export const POST_CLOSE_PATH_FORENSICS_HORIZONS = [15, 60, 240] as const;
const OBSERVATION_INTERVAL_MS = 90_000;
const MAX_CANDIDATES_PER_HORIZON = 35;

export interface PostCloseQuoteCandle {
  bucket_time: Date | string;
  high: number | string;
  low: number | string;
  close: number | string;
  source: string;
  sample_count: number | string;
  positive_quote_sample_count: number | string;
  last_quote_sample_at: Date | string | null;
}

export type PostClosePathState =
  | 'TARGET_REACHED'
  | 'TARGET_NOT_REACHED'
  | 'DATA_GAP'
  | 'INVALID_GEOMETRY';

export interface PostClosePathResult {
  state: PostClosePathState;
  firstTargetMinute: string | null;
  minutesFromCloseToTarget: number | null;
  observedMinutesBeforeDecision: number;
  firstMissingMinute: string | null;
  adverseBeyondOriginalStopPipsBeforeTarget: number | null;
  lastVerifiedClose: number | null;
  targetMinuteSequenceUnknown: boolean;
  method: 'CONTIGUOUS_BROKER_NATIVE_M1_AFTER_FULL_CLOSE_MINUTE';
}

/**
 * Exactly N full broker-observed M1 buckets AFTER the close minute.
 * A gap before target evidence is UNKNOWN, not a failed prediction.
 * High/low are quote-derived indicative levels, not executable bid/ask fills.
 * Adverse extremes from the target minute are excluded: their ordering vs
 * target touch is unknowable from one OHLC candle.
 */
export function evaluatePostClosePath(input: {
  closedAt: Date;
  direction: 'BUY' | 'SELL';
  instrument: string;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  horizonMinutes: 15 | 60 | 240;
  candles: PostCloseQuoteCandle[];
}): PostClosePathResult {
  const result = (
    state: PostClosePathState,
    count = 0,
    missing: string | null = null,
    targetAt: Date | null = null,
    adverse: number | null = null,
    close: number | null = null,
  ): PostClosePathResult => ({
    state,
    firstTargetMinute: targetAt?.toISOString() ?? null,
    minutesFromCloseToTarget: targetAt
      ? Math.round(((targetAt.getTime() - input.closedAt.getTime()) / 60_000) * 10) / 10
      : null,
    observedMinutesBeforeDecision: count,
    firstMissingMinute: missing,
    adverseBeyondOriginalStopPipsBeforeTarget: adverse,
    lastVerifiedClose: close,
    targetMinuteSequenceUnknown: targetAt !== null,
    method: 'CONTIGUOUS_BROKER_NATIVE_M1_AFTER_FULL_CLOSE_MINUTE',
  });
  const { entryPrice, stopLoss, takeProfit, direction, horizonMinutes } = input;
  if (
    !Number.isFinite(input.closedAt.getTime()) ||
    ![entryPrice, stopLoss, takeProfit].every((x) => Number.isFinite(x) && x > 0) ||
    (direction !== 'BUY' && direction !== 'SELL') ||
    !POST_CLOSE_PATH_FORENSICS_HORIZONS.includes(horizonMinutes) ||
    (direction === 'BUY'
      ? !(stopLoss < entryPrice && entryPrice < takeProfit)
      : !(takeProfit < entryPrice && entryPrice < stopLoss))
  )
    return result('INVALID_GEOMETRY');

  const pip = input.instrument.toUpperCase().endsWith('JPY') ? 0.01 : 0.0001;
  const start = (Math.floor(input.closedAt.getTime() / 60_000) + 1) * 60_000;
  const rows = new Map<number, PostCloseQuoteCandle>();
  for (const candle of input.candles) {
    const at = new Date(candle.bucket_time).getTime();
    if (!Number.isFinite(at) || rows.has(at)) continue;
    rows.set(at, candle);
  }
  let observed = 0;
  let lastClose: number | null = null;
  let worstBeforeTarget: number | null = null;
  for (let i = 0; i < horizonMinutes; i += 1) {
    const atMs = start + i * 60_000;
    const at = new Date(atMs);
    const row = rows.get(atMs);
    const high = Number(row?.high);
    const low = Number(row?.low);
    const close = Number(row?.close);
    const sampleCount = Number(row?.sample_count);
    const quotes = Number(row?.positive_quote_sample_count);
    const observedAt = row?.last_quote_sample_at
      ? new Date(row.last_quote_sample_at).getTime()
      : Number.NaN;
    if (
      !row ||
      row.source !== 'ctrader-broker-native' ||
      !Number.isFinite(high) ||
      !Number.isFinite(low) ||
      !Number.isFinite(close) ||
      high <= 0 ||
      low <= 0 ||
      close <= 0 ||
      high < low ||
      close < low ||
      close > high ||
      !Number.isInteger(sampleCount) ||
      sampleCount < 1 ||
      !Number.isInteger(quotes) ||
      quotes < 1 ||
      quotes > sampleCount ||
      !Number.isFinite(observedAt) ||
      observedAt < atMs ||
      observedAt >= atMs + 60_000
    )
      return result('DATA_GAP', observed, at.toISOString(), null, null, lastClose);

    observed += 1;
    lastClose = close;
    const target = direction === 'BUY' ? high >= takeProfit : low <= takeProfit;
    if (target) {
      return result('TARGET_REACHED', observed, null, at, worstBeforeTarget, lastClose);
    }
    const adverse = direction === 'BUY' ? low : high;
    const beyond =
      direction === 'BUY' ? Math.max(0, stopLoss - adverse) : Math.max(0, adverse - stopLoss);
    worstBeforeTarget = Math.round(Math.max(worstBeforeTarget ?? 0, beyond / pip) * 100) / 100;
  }
  return result('TARGET_NOT_REACHED', observed, null, null, worstBeforeTarget, lastClose);
}

interface ForensicsCandidate {
  trade_id: string;
  trade_intent_id: string;
  user_id: string;
  broker_connection_id: string;
  instrument: string;
  account_currency: string | null;
  direction: 'BUY' | 'SELL';
  closed_at: Date | string;
  opened_at: Date | string;
  fill_price: string;
  requested_entry_price: string;
  stop_loss: string;
  take_profit: string;
  exit_price: string;
  close_reason: string;
  realised_pnl: string;
  commission: string | null;
  swap: string | null;
  entry_timeframe: string;
  strategy_route: string | null;
}

function safeMoney(value: string | null): string | null {
  if (value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? value : null;
}

@Injectable()
export class PostClosePathForensicsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PostClosePathForensicsService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly dataSource: DataSource) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') return;
    setTimeout(() => void this.runOnce(), 42_000).unref?.();
    this.timer = setInterval(() => void this.runOnce(), OBSERVATION_INTERVAL_MS);
    this.timer.unref?.();
    this.logger.log(
      'Post-close broker-native path forensics active horizons=15,60,240m authority=NONE',
    );
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async runOnce(now = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const horizon of POST_CLOSE_PATH_FORENSICS_HORIZONS) {
        const candidates = await this.loadCandidates(now, horizon);
        for (const row of candidates) {
          try {
            const closedAt = new Date(row.closed_at);
            const startMs = (Math.floor(closedAt.getTime() / 60_000) + 1) * 60_000;
            const candles = await this.loadCandles(
              row.broker_connection_id,
              row.instrument,
              new Date(startMs),
              new Date(startMs + horizon * 60_000),
            );
            const result = evaluatePostClosePath({
              closedAt,
              direction: row.direction,
              instrument: row.instrument,
              entryPrice: Number(row.fill_price),
              stopLoss: Number(row.stop_loss),
              takeProfit: Number(row.take_profit),
              horizonMinutes: horizon,
              candles,
            });
            await this.persist(row, horizon, new Date(startMs + horizon * 60_000), result);
          } catch (error) {
            this.logger.warn(
              'Post-close forensic observation deferred: ' + (error as Error).message,
            );
          }
        }
      }
    } catch (error) {
      this.logger.warn('Post-close forensic pass deferred: ' + (error as Error).message);
    } finally {
      this.running = false;
    }
  }

  private async loadCandidates(now: Date, horizon: 15 | 60 | 240): Promise<ForensicsCandidate[]> {
    return (await this.dataSource.query(
      `
        SELECT t.id AS trade_id, t.trade_intent_id, t.user_id, t.broker_connection_id,
          t.instrument, t.account_currency, t.direction, t.closed_at, t.opened_at,
          t.fill_price, t.requested_entry_price, t.stop_loss, t.take_profit, t.exit_price, t.close_reason,
          t.realised_pnl, t.commission, t.swap,
          ti.timeframe AS entry_timeframe,
          NULLIF(ti.metadata->>'multimodel_plan_b_route', '') AS strategy_route
        FROM trading.trades t
        INNER JOIN trading.trade_intents ti ON ti.id = t.trade_intent_id
          AND ti.user_id = t.user_id AND ti.broker_connection_id = t.broker_connection_id
        INNER JOIN broker.broker_connections bc ON bc.id = t.broker_connection_id
          AND bc.user_id = t.user_id
        WHERE bc.account_type = 'DEMO'
          AND bc.broker_id IN ('ctrader','pepperstone-ctrader','icmarkets-ctrader')
          AND t.status = 'CLOSED'
          AND t.closed_at IS NOT NULL
          AND t.fill_price IS NOT NULL AND t.stop_loss IS NOT NULL
          AND t.take_profit IS NOT NULL AND t.exit_price IS NOT NULL
          AND t.realised_pnl IS NOT NULL
          AND t.closed_at <= $1::timestamptz - ($2::int + 2) * interval '1 minute'
          AND t.closed_at >= $1::timestamptz - interval '21 days'
          AND NOT EXISTS (
            SELECT 1 FROM trading.post_entry_shadow_observations o
            WHERE o.trade_id = t.id AND o.artifact = $3 AND o.checkpoint_minutes = $2
          )
        ORDER BY t.closed_at DESC, t.id DESC
        LIMIT $4
      `,
      [now.toISOString(), horizon, POST_CLOSE_PATH_FORENSICS_ARTIFACT, MAX_CANDIDATES_PER_HORIZON],
    )) as ForensicsCandidate[];
  }

  private async loadCandles(
    brokerConnectionId: string,
    instrument: string,
    start: Date,
    end: Date,
  ): Promise<PostCloseQuoteCandle[]> {
    return (await this.dataSource.query(
      `
        SELECT bucket_time, high, low, close, source, sample_count,
          positive_quote_sample_count, last_quote_sample_at
        FROM market_data.provider_quote_candles
        WHERE connection_id = $1 AND instrument = $2 AND timeframe = 'M1'
          AND bucket_time >= $3::timestamptz AND bucket_time < $4::timestamptz
        ORDER BY bucket_time ASC
      `,
      [brokerConnectionId, instrument.toUpperCase(), start.toISOString(), end.toISOString()],
    )) as PostCloseQuoteCandle[];
  }

  private async persist(
    row: ForensicsCandidate,
    horizon: 15 | 60 | 240,
    checkpointAt: Date,
    evaluation: PostClosePathResult,
  ): Promise<void> {
    const entry = Number(row.fill_price);
    const stop = Number(row.stop_loss);
    const target = Number(row.take_profit);
    const pip = row.instrument.toUpperCase().endsWith('JPY') ? 0.01 : 0.0001;
    const response = {
      artifact: POST_CLOSE_PATH_FORENSICS_ARTIFACT,
      observation: evaluation,
      instrument: row.instrument,
      direction: row.direction,
      entryTimeframe: row.entry_timeframe,
      strategyRoute: row.strategy_route,
      openedAt: new Date(row.opened_at).toISOString(),
      closedAt: new Date(row.closed_at).toISOString(),
      actualCloseReason: row.close_reason,
      actualGrossRealisedPnl: safeMoney(row.realised_pnl),
      commission: safeMoney(row.commission),
      swap: safeMoney(row.swap),
      accountCurrency: row.account_currency,
      entryPrice: row.fill_price,
      requestedEntryPrice: row.requested_entry_price,
      originalStop: row.stop_loss,
      originalTarget: row.take_profit,
      actualExitPrice: row.exit_price,
      holdMinutes:
        Math.round(
          ((new Date(row.closed_at).getTime() - new Date(row.opened_at).getTime()) / 60_000) * 10,
        ) / 10,
      requestedEntryStopDistancePips:
        Number.isFinite(Number(row.requested_entry_price)) && Number.isFinite(stop)
          ? Math.round((Math.abs(Number(row.requested_entry_price) - stop) / pip) * 100) / 100
          : null,
      actualFillVersusRequestedPips:
        Number.isFinite(Number(row.requested_entry_price)) && Number.isFinite(entry)
          ? Math.round((Math.abs(entry - Number(row.requested_entry_price)) / pip) * 100) / 100
          : null,
      stopDistancePips:
        Number.isFinite(entry) && Number.isFinite(stop)
          ? Math.round((Math.abs(entry - stop) / pip) * 100) / 100
          : null,
      targetDistancePips:
        Number.isFinite(entry) && Number.isFinite(target)
          ? Math.round((Math.abs(target - entry) / pip) * 100) / 100
          : null,
      warning:
        'Quote-derived future price path only. Not a proof wider SL would survive; no spread, gap, slippage or intra-minute ordering guarantee.',
      modelTrainingStatus: 'RESEARCH_ONLY_NOT_TRAINED',
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
        )
        ON CONFLICT (trade_id, artifact, checkpoint_minutes) DO NOTHING
      `,
      [
        row.user_id,
        row.trade_id,
        row.trade_intent_id,
        row.broker_connection_id,
        POST_CLOSE_PATH_FORENSICS_ARTIFACT,
        horizon,
        checkpointAt.toISOString(),
        evaluation.state,
        evaluation.state,
        JSON.stringify({ M1: 'ctrader-broker-native' }),
        JSON.stringify(response),
      ],
    );
  }
}
