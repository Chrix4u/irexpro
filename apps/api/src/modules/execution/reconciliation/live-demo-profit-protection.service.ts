import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { BrokerService } from '../../broker/broker.service';
import { ExecutionService } from '../execution.service';
import { TradeCloseReason } from '../entities/trade.entity';
import { evaluatePaperProfitLock } from '../../broker/adapters/paper-broker.adapter';

const LIVE_DEMO_PROFIT_PROTECTION_INTERVAL_MS = 5_000;

export interface LiveDemoM1AdverseEvidence {
  completedBars: number;
  adverseBars: number;
  alignedLatestBodyPressure: number;
  alignedMomentum3: number;
  latestAgeSeconds: number;
}

export interface LiveDemoAdverseProtectionDecision {
  shouldClose: boolean;
  reason:
    | 'TOO_EARLY'
    | 'INVALID_RISK'
    | 'PROFIT_PROTECTION_OWNS_TRADE'
    | 'NOT_ADVERSE'
    | 'M1_EVIDENCE_UNAVAILABLE'
    | 'RECOVERY_FORMING'
    | 'ADVERSE_THESIS_FAILED'
    | 'EMERGENCY_ADVERSE_CUT'
    | 'HOLD';
  currentR: number | null;
}

/**
 * DEMO-only adverse-thesis guard.
 *
 * Broker SL remains the hard backstop. This guard only acts after at least one
 * completed broker-native M1 candle confirms that a materially losing trade is
 * still moving against its entry thesis. A trade that already armed the
 * profit-lock is owned by profit protection instead, preventing competing exit
 * authorities.
 */
export function evaluateLiveDemoAdverseProtection(input: {
  elapsedMinutes: number;
  currentPnl: number;
  initialRiskPnl: number;
  maxFavorablePnl: number;
  profitLockArmed: boolean;
  m1Evidence: LiveDemoM1AdverseEvidence | null;
}): LiveDemoAdverseProtectionDecision {
  const hold = (
    reason: LiveDemoAdverseProtectionDecision['reason'],
    currentR: number | null,
  ): LiveDemoAdverseProtectionDecision => ({ shouldClose: false, reason, currentR });
  if (!Number.isFinite(input.initialRiskPnl) || input.initialRiskPnl <= 0) {
    return hold('INVALID_RISK', null);
  }
  const currentR = input.currentPnl / input.initialRiskPnl;
  if (!Number.isFinite(input.elapsedMinutes) || input.elapsedMinutes < 1) {
    return hold('TOO_EARLY', currentR);
  }
  if (input.profitLockArmed) return hold('PROFIT_PROTECTION_OWNS_TRADE', currentR);
  if (currentR >= 0) return hold('NOT_ADVERSE', currentR);

  const evidence = input.m1Evidence;
  if (
    !evidence ||
    evidence.completedBars < 1 ||
    evidence.latestAgeSeconds < 0 ||
    evidence.latestAgeSeconds > 90
  ) {
    return hold('M1_EVIDENCE_UNAVAILABLE', currentR);
  }

  if (evidence.alignedLatestBodyPressure > 0.2 && evidence.alignedMomentum3 >= 0) {
    return hold('RECOVERY_FORMING', currentR);
  }

  const favorableR = Math.max(0, input.maxFavorablePnl) / input.initialRiskPnl;
  const latestStillOpposing = evidence.alignedLatestBodyPressure <= -0.35;
  const persistentOpposition =
    evidence.completedBars >= 2 &&
    evidence.adverseBars >= Math.min(2, evidence.completedBars) &&
    evidence.alignedMomentum3 <= -0.15;

  if (currentR <= -0.65 && favorableR < 0.15 && latestStillOpposing) {
    return { shouldClose: true, reason: 'EMERGENCY_ADVERSE_CUT', currentR };
  }
  if (currentR <= -0.45 && favorableR < 0.15 && latestStillOpposing && persistentOpposition) {
    return { shouldClose: true, reason: 'ADVERSE_THESIS_FAILED', currentR };
  }
  return hold('HOLD', currentR);
}

interface OpenAiTradeRow {
  trade_id: string;
  user_id: string;
  broker_connection_id: string;
  external_order_id: string | null;
  external_position_id: string | null;
  instrument: string;
  direction: 'BUY' | 'SELL';
  max_favorable_pnl: string | number | null;
  max_adverse_pnl: string | number | null;
  profit_giveback: string | number | null;
  path_observation_count: string | number | null;
  path_peak_observed_at: Date | string | null;
  initial_risk_pnl: string | number | null;
  stop_loss: string | number | null;
  opened_at: Date | string | null;
  is_m1_strategy: boolean;
}

function finite(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function money(value: number): string {
  return value.toFixed(8);
}

/**
 * Fast post-entry manager for promoted cTrader DEMO positions.
 *
 * It intentionally has NO authority over real-money LIVE accounts. Broker SL/TP
 * remain the hard backstop; this layer restores the already-validated PAPER
 * MFE/MAE/giveback profit-lock policy to the promoted DEMO execution path.
 */
@Injectable()
export class LiveDemoProfitProtectionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LiveDemoProfitProtectionService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly dataSource: DataSource,
    private readonly brokerService: BrokerService,
    private readonly executionService: ExecutionService,
  ) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') return;
    const initial = setTimeout(() => void this.runOnce(), 2_000);
    initial.unref?.();
    this.timer = setInterval(() => void this.runOnce(), LIVE_DEMO_PROFIT_PROTECTION_INTERVAL_MS);
    this.timer.unref?.();
    this.logger.log(
      `cTrader DEMO profit protection enabled cadence=${LIVE_DEMO_PROFIT_PROTECTION_INTERVAL_MS / 1000}s authority=PROFIT_PROTECTION LIVE=false`,
    );
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async runOnce(observedAt = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const rows = await this.loadOpenAiTrades();
      const groups = new Map<string, OpenAiTradeRow[]>();
      for (const row of rows) {
        const key = `${row.user_id}:${row.broker_connection_id}`;
        const group = groups.get(key) ?? [];
        group.push(row);
        groups.set(key, group);
      }

      for (const trades of groups.values()) {
        const first = trades[0];
        if (!first) continue;
        try {
          const snapshot = await this.brokerService.getOpenPositionsForConnection(
            first.broker_connection_id,
            first.user_id,
          );
          if (
            snapshot.connection.brokerId !== 'ctrader' ||
            String(snapshot.connection.accountType).toUpperCase() !== 'DEMO'
          ) {
            continue;
          }
          const positions = new Map(
            snapshot.positions.map((position) => [position.externalOrderId, position] as const),
          );

          for (const trade of trades) {
            const providerPositionId = trade.external_position_id ?? trade.external_order_id;
            if (!providerPositionId) continue;
            const position = positions.get(providerPositionId);
            if (!position) continue;
            const currentPnl = finite(position.unrealisedPnl);
            const initialRisk = finite(trade.initial_risk_pnl);
            if (currentPnl === null || initialRisk === null || initialRisk <= 0) continue;

            const previousPeak = finite(trade.max_favorable_pnl) ?? 0;
            const previousAdverse = finite(trade.max_adverse_pnl) ?? 0;
            const maxFavorablePnl = Math.max(0, previousPeak, currentPnl);
            const maxAdversePnl = Math.min(0, previousAdverse, currentPnl);
            const profitGiveback = Math.max(0, maxFavorablePnl - currentPnl);
            const observationCount = Math.max(0, Number(trade.path_observation_count) || 0) + 1;
            const isNewPeak = currentPnl > previousPeak;
            const peakObservedAt = isNewPeak
              ? observedAt
              : trade.path_peak_observed_at
                ? new Date(trade.path_peak_observed_at)
                : observedAt;

            await this.persistTelemetry({
              tradeId: trade.trade_id,
              maxFavorablePnl,
              maxAdversePnl,
              profitGiveback,
              observationCount,
              peakObservedAt,
              observedAt,
            });

            const authoritativeStop = finite(trade.stop_loss);
            const currentPrice = finite(position.currentPrice);
            const stopBreached =
              authoritativeStop !== null &&
              authoritativeStop > 0 &&
              currentPrice !== null &&
              ((trade.direction === 'BUY' && currentPrice <= authoritativeStop) ||
                (trade.direction === 'SELL' && currentPrice >= authoritativeStop));
            if (stopBreached) {
              this.logger.warn(
                `cTrader DEMO STOP_LOSS_CATCHUP trade=${trade.trade_id} ${trade.instrument} ${trade.direction} ` +
                  `current=${currentPrice} authorityStop=${authoritativeStop}`,
              );
              await this.executionService.closeTrade(
                trade.trade_id,
                trade.user_id,
                TradeCloseReason.STOP_LOSS_HIT,
              );
              continue;
            }

            const decision = evaluatePaperProfitLock({
              maxFavorablePnl: money(maxFavorablePnl),
              currentPnl: money(currentPnl),
              initialRiskPnl: money(initialRisk),
              isM1Strategy: trade.is_m1_strategy,
            });
            if (decision.shouldClose) {
              this.logger.warn(
                `cTrader DEMO PROFIT_PROTECTION trade=${trade.trade_id} ${trade.instrument} ${trade.direction} ` +
                  `peak=${money(maxFavorablePnl)} current=${money(currentPnl)} risk=${money(initialRisk)} ` +
                  `giveback=${money(profitGiveback)} floor=${decision.protectedFloorPnl} retain=${decision.retentionFraction}`,
              );
              await this.executionService.closeTrade(
                trade.trade_id,
                trade.user_id,
                TradeCloseReason.PROFIT_PROTECTION,
              );
              continue;
            }

            if (currentPnl >= 0 || !trade.opened_at) continue;
            const openedAt = new Date(trade.opened_at);
            if (!Number.isFinite(openedAt.getTime())) continue;
            const m1Evidence = await this.loadCausalM1Evidence(trade, observedAt);
            const adverseDecision = evaluateLiveDemoAdverseProtection({
              elapsedMinutes: Math.max(0, (observedAt.getTime() - openedAt.getTime()) / 60_000),
              currentPnl,
              initialRiskPnl: initialRisk,
              maxFavorablePnl,
              profitLockArmed: decision.armed,
              m1Evidence,
            });
            if (!adverseDecision.shouldClose) continue;

            this.logger.warn(
              `cTrader DEMO AI_CLOSE_SIGNAL trade=${trade.trade_id} ${trade.instrument} ${trade.direction} ` +
                `reason=${adverseDecision.reason} currentR=${adverseDecision.currentR?.toFixed(3) ?? 'n/a'} ` +
                `peak=${money(maxFavorablePnl)} current=${money(currentPnl)} risk=${money(initialRisk)}`,
            );
            await this.executionService.closeTrade(
              trade.trade_id,
              trade.user_id,
              TradeCloseReason.AI_CLOSE_SIGNAL,
            );
          }
        } catch (error) {
          this.logger.warn(
            `cTrader DEMO profit-protection cycle deferred connection=${first.broker_connection_id}: ${(error as Error).message}`,
          );
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async loadOpenAiTrades(): Promise<OpenAiTradeRow[]> {
    return (await this.dataSource.query(`
      SELECT
        t.id AS trade_id,
        t.user_id,
        t.broker_connection_id,
        t.external_order_id,
        t.external_position_id,
        t.instrument,
        t.direction,
        t.max_favorable_pnl,
        t.max_adverse_pnl,
        t.profit_giveback,
        t.path_observation_count,
        t.path_peak_observed_at,
        t.opened_at,
        COALESCE(
          NULLIF(ca.sizing_inputs->>'finalRiskAtStop', '')::numeric,
          NULLIF(ca.sizing_inputs->>'riskAmount', '')::numeric
        ) AS initial_risk_pnl,
        t.stop_loss,
        (
          COALESCE(ti.metadata->>'m1_rollout_phase', '') <> ''
          OR COALESCE(ti.metadata->>'timeframe', '') = 'M1'
          OR COALESCE(ti.strategy_code, '') LIKE '%multimodel%'
        ) AS is_m1_strategy
      FROM trading.trades t
      LEFT JOIN trading.trade_intents ti ON ti.id = t.trade_intent_id
      LEFT JOIN LATERAL (
        SELECT sizing_inputs
        FROM trading.capital_allocations ca0
        WHERE ca0.trade_intent_id = t.trade_intent_id
        ORDER BY ca0.created_at DESC
        LIMIT 1
      ) ca ON true
      WHERE t.status = 'OPEN'
        AND t.signal_id IS NOT NULL
        AND (t.external_position_id IS NOT NULL OR t.external_order_id IS NOT NULL)
      ORDER BY t.opened_at ASC
    `)) as OpenAiTradeRow[];
  }

  private async loadCausalM1Evidence(
    trade: OpenAiTradeRow,
    observedAt: Date,
  ): Promise<LiveDemoM1AdverseEvidence | null> {
    const rows = (await this.dataSource.query(
      `
        SELECT bucket_time, open, high, low, close, sample_count, source
        FROM market_data.provider_quote_candles
        WHERE connection_id = $1
          AND instrument = $2
          AND timeframe = 'M1'
          AND source = 'ctrader-broker-native'
          AND bucket_time + interval '1 minute' <= $3::timestamptz
        ORDER BY bucket_time DESC
        LIMIT 3
      `,
      [trade.broker_connection_id, trade.instrument.toUpperCase(), observedAt.toISOString()],
    )) as Array<{
      bucket_time: Date | string;
      open: string | number;
      high: string | number;
      low: string | number;
      close: string | number;
      sample_count: string | number;
      source: string;
    }>;
    if (!rows.length) return null;
    const sign = trade.direction === 'BUY' ? 1 : -1;
    const parsed = rows.flatMap((row) => {
      const open = finite(row.open);
      const high = finite(row.high);
      const low = finite(row.low);
      const close = finite(row.close);
      const samples = finite(row.sample_count);
      const bucketTime = new Date(row.bucket_time);
      if (
        open === null ||
        high === null ||
        low === null ||
        close === null ||
        samples === null ||
        samples <= 0 ||
        row.source !== 'ctrader-broker-native' ||
        !Number.isFinite(bucketTime.getTime())
      ) {
        return [];
      }
      const range = Math.max(high - low, Number.EPSILON);
      return [
        {
          open,
          high,
          low,
          close,
          bucketTime,
          alignedBodyPressure: sign * ((close - open) / range),
          range,
        },
      ];
    });
    if (!parsed.length) return null;
    const latest = parsed[0]!;
    const oldest = parsed[parsed.length - 1]!;
    const totalRange = parsed.reduce((sum, row) => sum + row.range, 0);
    const alignedMomentum3 =
      totalRange > 0 ? sign * ((latest.close - oldest.open) / totalRange) : 0;
    const latestCloseAt = latest.bucketTime.getTime() + 60_000;
    return {
      completedBars: parsed.length,
      adverseBars: parsed.filter((row) => row.alignedBodyPressure <= -0.15).length,
      alignedLatestBodyPressure: latest.alignedBodyPressure,
      alignedMomentum3,
      latestAgeSeconds: (observedAt.getTime() - latestCloseAt) / 1000,
    };
  }

  private async persistTelemetry(input: {
    tradeId: string;
    maxFavorablePnl: number;
    maxAdversePnl: number;
    profitGiveback: number;
    observationCount: number;
    peakObservedAt: Date;
    observedAt: Date;
  }): Promise<void> {
    await this.dataSource.query(
      `
        UPDATE trading.trades
        SET max_favorable_pnl = $2,
            max_adverse_pnl = $3,
            profit_giveback = $4,
            path_observation_count = $5,
            path_peak_observed_at = $6,
            path_last_observed_at = $7,
            updated_at = now()
        WHERE id = $1
          AND status = 'OPEN'
      `,
      [
        input.tradeId,
        money(input.maxFavorablePnl),
        money(input.maxAdversePnl),
        money(input.profitGiveback),
        input.observationCount,
        input.peakObservedAt,
        input.observedAt,
      ],
    );
  }
}
