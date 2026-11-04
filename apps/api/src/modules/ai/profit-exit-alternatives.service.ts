import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  compareExitAlternatives,
  EXIT_ALTERNATIVES_ARTIFACT,
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
          const shadow = typeof row.runner_shadow === 'string'
            ? JSON.parse(row.runner_shadow) as unknown
            : row.runner_shadow;
          const runner = shadow && typeof shadow === 'object' && !Array.isArray(shadow)
            ? shadow as Record<string, unknown>
            : {};
          const price = Number(runner.indicativeProtectedStopPrice);
          const result = compareExitAlternatives({
            direction: row.direction,
            closeAt: observedAt,
            entryPrice: Number(row.fill_price),
            exitPrice: Number(row.exit_price),
            stopPrice: Number(row.stop_loss),
            takeProfitPrice: Number(row.take_profit),
            runnerStopPrice: runner.eligibleForFurtherResearch === true &&
              Number.isFinite(price) && price > 0 ? price : null,
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
    } catch (error) {
      this.logger.warn(
        `DEMO exit-alternatives cycle deferred: ${(error as Error).message}`,
      );
    } finally {
      this.running = false;
    }
  }

