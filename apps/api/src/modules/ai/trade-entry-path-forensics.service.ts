import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { PostCloseQuoteCandle } from './post-close-path-forensics.service';

/**
 * Read-only evidence of what happened DURING each completed DEMO trade.
 * Uses the same broker's positive live M1 quote samples. This is not a
 * backtest, broker fill simulator, stop-widening recommendation, or a source
 * of execution authority. Historical observations cannot enter a live signal.
 */
export const TRADE_ENTRY_PATH_FORENSICS_ARTIFACT = 'trade-entry-path-forensics-verified-m1-v1';
export const TRADE_ENTRY_PATH_HORIZONS = [5, 15, 60] as const;
export type TradeEntryHorizon = (typeof TRADE_ENTRY_PATH_HORIZONS)[number];
const INTERVAL_MS = 90_000;
const MAX_CANDIDATES = 35;

export type EntryPathState =
  | 'OBSERVED_TO_HORIZON'
  | 'OBSERVED_TO_CLOSE'
  | 'NO_COMPLETE_M1'
  | 'DATA_GAP'
  | 'INVALID_GEOMETRY';
export type FirstMovement =
  | 'FAVORABLE_FIRST'
  | 'ADVERSE_FIRST'
  | 'SAME_MINUTE_AMBIGUOUS'
  | 'ONE_SIDED'
  | 'NO_MOVE';

export interface EntryMinuteTrace {
  at: string;
  favorablePips: number;
  adversePips: number;
  alignedClosePips: number;
  stopQuoteTouched: boolean;
  targetQuoteTouched: boolean;
  bothBarriersTouched: boolean;
}

export interface TradeEntryPathResult {
  state: EntryPathState;
  horizonMinutes: TradeEntryHorizon;
  observedMinutes: number;
  fullMinuteWindowEndsAt: string | null;
  firstMissingMinute: string | null;
  firstFavorableMinute: string | null;
  firstAdverseMinute: string | null;
  firstStopQuoteTouchMinute: string | null;
  firstTargetQuoteTouchMinute: string | null;
  firstMovement: FirstMovement;
  maxFavorablePips: number | null;
  maxAdversePips: number | null;
  maxObservedCloseGivebackPips: number | null;
  lastAlignedClosePips: number | null;
  trace: EntryMinuteTrace[];
  method: 'CONTIGUOUS_BROKER_NATIVE_FULL_M1_DURING_OPEN_POSITION';
}

const roundPip = (value: number): number => Math.round(value * 100) / 100;

function isVerifiedM1Candle(
  candle: PostCloseQuoteCandle | undefined,
  atMs: number,
): candle is PostCloseQuoteCandle {
  if (!candle || candle.source !== 'ctrader-broker-native') return false;
  // Null database values must not be coerced to 0 and mistaken for quotes.
  if (candle.high == null || candle.low == null || candle.close == null) return false;
  const high = Number(candle.high);
  const low = Number(candle.low);
  const close = Number(candle.close);
  const count = Number(candle.sample_count);
  const positives = Number(candle.positive_quote_sample_count);
  const observedMs = candle.last_quote_sample_at
    ? new Date(candle.last_quote_sample_at).getTime()
    : Number.NaN;
  return (
    Number.isFinite(high) &&
    Number.isFinite(low) &&
    Number.isFinite(close) &&
    high >= low &&
    low > 0 &&
    close >= low &&
    close <= high &&
    Number.isInteger(count) &&
    count >= 1 &&
    Number.isInteger(positives) &&
    positives >= 1 &&
    positives <= count &&
    Number.isFinite(observedMs) &&
    observedMs >= atMs &&
    observedMs < atMs + 60_000
  );
}

/**
 * Only complete, post-entry M1 candle buckets strictly before the actual
 * broker close minute are considered. We cannot order events within the
 * entry minute, exit minute or any single OHLC bar.
 *
 * No post-exit quotes, synthetic backfill, other broker accounts or market
 * future are used. Outcomes with missing prior candles are DATA_GAP.
 */
export function evaluateTradeEntryPath(input: {
  instrument: string;
  direction: 'BUY' | 'SELL';
  openedAt: Date;
  closedAt: Date;
  fillPrice: number;
  stopLoss: number;
  takeProfit: number;
  horizonMinutes: TradeEntryHorizon;
  candles: PostCloseQuoteCandle[];
}): TradeEntryPathResult {
  const base = (state: EntryPathState): TradeEntryPathResult => ({
    state,
    horizonMinutes: input.horizonMinutes,
    observedMinutes: 0,
    fullMinuteWindowEndsAt: null,
    firstMissingMinute: null,
    firstFavorableMinute: null,
    firstAdverseMinute: null,
    firstStopQuoteTouchMinute: null,
    firstTargetQuoteTouchMinute: null,
    firstMovement: 'NO_MOVE',
    maxFavorablePips: null,
    maxAdversePips: null,
    maxObservedCloseGivebackPips: null,
    lastAlignedClosePips: null,
    trace: [],
    method: 'CONTIGUOUS_BROKER_NATIVE_FULL_M1_DURING_OPEN_POSITION',
  });
  const { direction, fillPrice, stopLoss, takeProfit, horizonMinutes } = input;
  if (
    !Number.isFinite(input.openedAt.getTime()) ||
    !Number.isFinite(input.closedAt.getTime()) ||
    input.closedAt <= input.openedAt ||
    !TRADE_ENTRY_PATH_HORIZONS.includes(horizonMinutes) ||
    ![fillPrice, stopLoss, takeProfit].every((x) => Number.isFinite(x) && x > 0) ||
    (direction !== 'BUY' && direction !== 'SELL') ||
    (direction === 'BUY'
      ? !(stopLoss < fillPrice && fillPrice < takeProfit)
      : !(takeProfit < fillPrice && fillPrice < stopLoss))
  )
    return base('INVALID_GEOMETRY');

  const startMs = (Math.floor(input.openedAt.getTime() / 60_000) + 1) * 60_000;
  const closeMinuteMs = Math.floor(input.closedAt.getTime() / 60_000) * 60_000;
  const endMs = Math.min(startMs + horizonMinutes * 60_000, closeMinuteMs);
  if (endMs <= startMs) return base('NO_COMPLETE_M1');
  const pip = input.instrument.toUpperCase().endsWith('JPY') ? 0.01 : 0.0001;
  const lookup = new Map<number, PostCloseQuoteCandle>();
  for (const candle of input.candles) {
    const at = new Date(candle.bucket_time).getTime();
    if (Number.isFinite(at) && !lookup.has(at)) lookup.set(at, candle);
  }

  const result = base('DATA_GAP');
  let previousAlignedPeak = 0;
  let maxGiveback = 0;
  let worstAdverse = 0;
  let bestFavorable = 0;
  for (let ms = startMs; ms < endMs; ms += 60_000) {
    const candle = lookup.get(ms);
    if (!isVerifiedM1Candle(candle, ms)) {
      result.firstMissingMinute = new Date(ms).toISOString();
      break;
    }
    const high = Number(candle.high);
    const low = Number(candle.low);
    const close = Number(candle.close);
    const favorable =
      direction === 'BUY'
        ? Math.max(0, (high - fillPrice) / pip)
        : Math.max(0, (fillPrice - low) / pip);
    const adverse =
      direction === 'BUY'
        ? Math.max(0, (fillPrice - low) / pip)
        : Math.max(0, (high - fillPrice) / pip);
    const alignedClose =
      direction === 'BUY' ? (close - fillPrice) / pip : (fillPrice - close) / pip;
    const stopTouch = direction === 'BUY' ? low <= stopLoss : high >= stopLoss;
    const targetTouch = direction === 'BUY' ? high >= takeProfit : low <= takeProfit;
    const at = new Date(ms).toISOString();

    if (favorable > 0 && result.firstFavorableMinute === null) result.firstFavorableMinute = at;
    if (adverse > 0 && result.firstAdverseMinute === null) result.firstAdverseMinute = at;
    if (stopTouch && result.firstStopQuoteTouchMinute === null)
      result.firstStopQuoteTouchMinute = at;
    if (targetTouch && result.firstTargetQuoteTouchMinute === null)
      result.firstTargetQuoteTouchMinute = at;
    bestFavorable = Math.max(bestFavorable, favorable);
    worstAdverse = Math.max(worstAdverse, adverse);
    // Only a *previously profitable* completed-minute close can generate
    // profit giveback. Initial adverse drawdown from 0 is NOT giveback.
    if (previousAlignedPeak > 0) {
      maxGiveback = Math.max(maxGiveback, previousAlignedPeak - alignedClose);
    }
    previousAlignedPeak = Math.max(previousAlignedPeak, alignedClose);
    result.lastAlignedClosePips = roundPip(alignedClose);
    result.trace.push({
      at,
      favorablePips: roundPip(favorable),
      adversePips: roundPip(adverse),
      alignedClosePips: roundPip(alignedClose),
      stopQuoteTouched: stopTouch,
      targetQuoteTouched: targetTouch,
      bothBarriersTouched: stopTouch && targetTouch,
    });
  }

  result.observedMinutes = result.trace.length;
  result.fullMinuteWindowEndsAt = new Date(startMs + result.observedMinutes * 60_000).toISOString();
  if (result.trace.length) {
    result.maxFavorablePips = roundPip(bestFavorable);
    result.maxAdversePips = roundPip(worstAdverse);
    result.maxObservedCloseGivebackPips = roundPip(maxGiveback);
  }
  if (result.firstFavorableMinute && result.firstAdverseMinute) {
    result.firstMovement =
      result.firstFavorableMinute === result.firstAdverseMinute
        ? 'SAME_MINUTE_AMBIGUOUS'
        : result.firstFavorableMinute < result.firstAdverseMinute
          ? 'FAVORABLE_FIRST'
          : 'ADVERSE_FIRST';
  } else if (result.firstFavorableMinute || result.firstAdverseMinute) {
    result.firstMovement = 'ONE_SIDED';
  }
  if (!result.firstMissingMinute) {
    result.state =
      endMs < startMs + horizonMinutes * 60_000 ? 'OBSERVED_TO_CLOSE' : 'OBSERVED_TO_HORIZON';
  }
  return result;
}

interface ClosedDemoTrade {
  trade_id: string;
  trade_intent_id: string;
  user_id: string;
  broker_connection_id: string;
  instrument: string;
  account_currency: string | null;
  direction: 'BUY' | 'SELL';
  opened_at: Date | string;
  closed_at: Date | string;
  fill_price: string;
  requested_entry_price: string | null;
  stop_loss: string;
  take_profit: string;
  exit_price: string | null;
  realised_pnl: string | null;
  commission: string | null;
  swap: string | null;
  close_reason: string;
  lot_size: string;
  timeframe: string | null;
  route: string | null;
  pretrade_features: Record<string, unknown> | null;
}

@Injectable()
export class TradeEntryPathForensicsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TradeEntryPathForensicsService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly dataSource: DataSource) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') return;
    setTimeout(() => void this.runOnce(), 54_000).unref?.();
    this.timer = setInterval(() => void this.runOnce(), INTERVAL_MS);
    this.timer.unref?.();
    this.logger.log('Closed DEMO entry-path forensics started: M1 5/15/60m, authority=NONE');
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async runOnce(now = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const horizon of TRADE_ENTRY_PATH_HORIZONS) {
        const candidates = await this.loadCandidates(now, horizon);
        for (const row of candidates) {
          try {
            const openedAt = new Date(row.opened_at);
            const closedAt = new Date(row.closed_at);
            const from = new Date((Math.floor(openedAt.getTime() / 60_000) + 1) * 60_000);
            const until = new Date(
              Math.min(
                from.getTime() + horizon * 60_000,
                Math.floor(closedAt.getTime() / 60_000) * 60_000,
              ),
            );
            const candles =
              until > from
                ? await this.loadCandles(row.broker_connection_id, row.instrument, from, until)
                : [];
            const result = evaluateTradeEntryPath({
              instrument: row.instrument,
              direction: row.direction,
              openedAt,
              closedAt,
              fillPrice: Number(row.fill_price),
              stopLoss: Number(row.stop_loss),
              takeProfit: Number(row.take_profit),
              horizonMinutes: horizon,
              candles,
            });
            const horizonAt = new Date(from.getTime() + horizon * 60_000);
            // If closed earlier, the research checkpoint is the actual close;
            // never claim a future checkpoint was observed while still open.
            await this.persist(row, horizon, result, horizonAt < closedAt ? horizonAt : closedAt);
          } catch (error) {
            this.logger.warn('DEMO entry-path research deferred: ' + (error as Error).message);
          }
        }
      }
    } catch (error) {
      this.logger.warn('DEMO entry-path cycle deferred: ' + (error as Error).message);
    } finally {
      this.running = false;
    }
  }

  private async loadCandidates(now: Date, horizon: TradeEntryHorizon): Promise<ClosedDemoTrade[]> {
    return (await this.dataSource.query(
      `
        SELECT t.id AS trade_id, t.trade_intent_id, t.user_id, t.broker_connection_id,
          t.instrument, t.account_currency, t.direction, t.opened_at, t.closed_at,
          t.fill_price, t.requested_entry_price, t.stop_loss, t.take_profit, t.exit_price,
          t.realised_pnl, t.commission, t.swap, t.close_reason, t.lot_size,
          ti.timeframe, ti.metadata->>'multimodel_plan_b_route' AS route,
          jsonb_build_object(
            'confidenceScore', ti.metadata->'confidenceScore',
            'signalSource', ti.metadata->'signal_source',
            'm1PolicyVersion', ti.metadata->'m1_policy_version',
            'm1TacticalRoute', ti.metadata->'m1_tactical_route',
            'marketRegime', ti.metadata->'marketRegime',
            'featureRsi14', ti.metadata->'feature_rsi14',
            'featureMtfStrength', ti.metadata->'feature_mtf_strength',
            'featureExtensionAtr', ti.metadata->'feature_extension_atr',
            'trainedExpertConfidence', ti.metadata->'multimodel_trained_expert_confidence',
            'trainedExpertDirection', ti.metadata->'multimodel_trained_expert_direction',
            'expectancySource', ti.metadata->'m1_expectancy_source'
          ) AS pretrade_features
        FROM trading.trades t
        JOIN trading.trade_intents ti ON ti.id = t.trade_intent_id
          AND ti.user_id = t.user_id AND ti.broker_connection_id = t.broker_connection_id
        JOIN broker.broker_connections bc ON bc.id = t.broker_connection_id
          AND bc.user_id = t.user_id
        WHERE t.status = 'CLOSED'
          AND bc.account_type = 'DEMO'
          AND bc.broker_id IN ('ctrader','pepperstone-ctrader','icmarkets-ctrader')
          AND t.trade_intent_id IS NOT NULL
          AND t.opened_at IS NOT NULL AND t.closed_at IS NOT NULL
          AND t.fill_price IS NOT NULL AND t.stop_loss IS NOT NULL AND t.take_profit IS NOT NULL
          AND t.closed_at <= $1::timestamptz - interval '2 minutes'
          AND t.closed_at >= $1::timestamptz - interval '21 days'
          AND NOT EXISTS (
            SELECT 1 FROM trading.post_entry_shadow_observations o
            WHERE o.trade_id = t.id AND o.artifact = $2 AND o.checkpoint_minutes = $3
          )
        ORDER BY t.closed_at DESC, t.id DESC
        LIMIT $4
      `,
      [now.toISOString(), TRADE_ENTRY_PATH_FORENSICS_ARTIFACT, horizon, MAX_CANDIDATES],
    )) as ClosedDemoTrade[];
  }

  private async loadCandles(
    connectionId: string,
    instrument: string,
    from: Date,
    until: Date,
  ): Promise<PostCloseQuoteCandle[]> {
    return (await this.dataSource.query(
      `
        SELECT bucket_time, high, low, close, source, sample_count,
          positive_quote_sample_count, last_quote_sample_at
        FROM market_data.provider_quote_candles
        WHERE connection_id = $1 AND instrument = $2 AND timeframe = 'M1'
          AND bucket_time >= $3::timestamptz
          AND bucket_time < $4::timestamptz
        ORDER BY bucket_time ASC
      `,
      [connectionId, instrument.toUpperCase(), from.toISOString(), until.toISOString()],
    )) as PostCloseQuoteCandle[];
  }

  private async persist(
    row: ClosedDemoTrade,
    horizon: TradeEntryHorizon,
    result: TradeEntryPathResult,
    checkpointAt: Date,
  ): Promise<void> {
    const pip = row.instrument.toUpperCase().endsWith('JPY') ? 0.01 : 0.0001;
    const entry = Number(row.fill_price);
    const stop = Number(row.stop_loss);
    const response = {
      artifact: TRADE_ENTRY_PATH_FORENSICS_ARTIFACT,
      ...result,
      instrument: row.instrument,
      direction: row.direction,
      openedAt: new Date(row.opened_at).toISOString(),
      closedAt: new Date(row.closed_at).toISOString(),
      originalStrategyTimeframe: row.timeframe,
      originalStrategyRoute: row.route,
      pretradeFeatures: row.pretrade_features,
      originalEntryPrice: row.fill_price,
      requestedEntryPrice: row.requested_entry_price,
      stopLoss: row.stop_loss,
      takeProfit: row.take_profit,
      originalStopDistancePips:
        Number.isFinite(entry) && Number.isFinite(stop)
          ? roundPip(Math.abs(entry - stop) / pip)
          : null,
      actualCloseReason: row.close_reason,
      exitPrice: row.exit_price,
      realisedPnl: row.realised_pnl,
      commission: row.commission,
      swap: row.swap,
      lotSize: row.lot_size,
      accountCurrency: row.account_currency,
      note: 'Quote OHLC does not prove executable fills or intraminute order; exclude partial entry/exit minutes. Closed DEMO history only.',
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
        ) ON CONFLICT (trade_id, artifact, checkpoint_minutes) DO NOTHING
      `,
      [
        row.user_id,
        row.trade_id,
        row.trade_intent_id,
        row.broker_connection_id,
        TRADE_ENTRY_PATH_FORENSICS_ARTIFACT,
        horizon,
        checkpointAt.toISOString(),
        result.state,
        result.state,
        JSON.stringify({ M1: 'ctrader-broker-native' }),
        JSON.stringify(response),
      ],
    );
  }
}
