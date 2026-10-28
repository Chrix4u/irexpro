import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { BrokerService } from '../../broker/broker.service';
import { ExecutionService } from '../execution.service';
import { TradeCloseReason } from '../entities/trade.entity';
import { evaluatePaperProfitLock } from '../../broker/adapters/paper-broker.adapter';

const LIVE_DEMO_PROFIT_PROTECTION_INTERVAL_MS = 5_000;

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
    this.timer = setInterval(
      () => void this.runOnce(),
      LIVE_DEMO_PROFIT_PROTECTION_INTERVAL_MS,
    );
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

            const decision = evaluatePaperProfitLock({
              maxFavorablePnl: money(maxFavorablePnl),
              currentPnl: money(currentPnl),
              initialRiskPnl: money(initialRisk),
              isM1Strategy: trade.is_m1_strategy,
            });
            if (!decision.shouldClose) continue;

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
        COALESCE(
          NULLIF(ca.sizing_inputs->>'finalRiskAtStop', '')::numeric,
          NULLIF(ca.sizing_inputs->>'riskAmount', '')::numeric
        ) AS initial_risk_pnl,
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
