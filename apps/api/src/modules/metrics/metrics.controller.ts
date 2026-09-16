import { Controller, Get, Header, Logger, UseGuards } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Public } from '../../common/decorators/public.decorator';
import {
  INTERNAL_API_KEY_HEADER,
  InternalApiKeyGuard,
} from '../../common/guards/internal-api-key.guard';
import { TradingSession, TradingSessionStatus } from '../execution/entities/trading-session.entity';
import { Trade, TradeStatus } from '../execution/entities/trade.entity';
import { METRIC_GAUGE_NAMES } from './metric-names';
import { MetricsService } from './metrics.service';
import { renderPrometheusText } from './prometheus-text';

/**
 * Round 7 (P1 metrics — audit R7-audit-C finding A6): the internal
 * Prometheus scrape endpoint.
 *
 * GET /api/v1/metrics → Prometheus TEXT exposition format
 *
 * Security (mirrors the ai/market-data internal routes):
 *  - @Public() bypasses the global JwtAuthGuard and
 *  - @UseGuards(InternalApiKeyGuard) requires the constant-time-validated
 *    x-irexpro-internal-api-key header — the endpoint is NEVER public.
 *
 * DB-backed gauges are computed ON SCRAPE (two cheap single queries — a
 * count and a grouped count). FAIL-OPEN for observability only: if a backing
 * query fails, the gauge lines are OMITTED (never a 500, never a stale value
 * from a previous successful scrape).
 */
@ApiTags('Metrics')
@Public()
@UseGuards(InternalApiKeyGuard)
@Controller('metrics')
export class MetricsController {
  private readonly logger = new Logger(MetricsController.name);

  constructor(
    private readonly metrics: MetricsService,
    @InjectRepository(TradingSession)
    private readonly sessionRepo: Repository<TradingSession>,
    @InjectRepository(Trade)
    private readonly tradeRepo: Repository<Trade>,
  ) {}

  /**
   * Render the full metrics registry (in-process counters + on-scrape
   * DB-backed gauges) as Prometheus text exposition format.
   */
  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  @ApiOperation({
    summary: '[INTERNAL] Prometheus metrics exposition',
    description:
      'Service-to-service scrape endpoint. Protected by internal API key ' +
      '(x-irexpro-internal-api-key). In-process counters plus the on-scrape ' +
      'gauges irexpro_live_sessions_active and irexpro_open_trades.',
  })
  @ApiHeader({
    name: INTERNAL_API_KEY_HEADER,
    description: 'Internal service API key',
    required: true,
  })
  async getMetrics(): Promise<string> {
    await this.refreshGauges();
    return renderPrometheusText(this.metrics.snapshot());
  }

  // ─── On-scrape DB-backed gauges (fail-open) ────────────────────────────────

  /**
   * Refresh the two DB-backed gauges. Each query is independently fail-open:
   * on failure the gauge is REMOVED (a failed scrape omits the lines — it
   * never serves the previous scrape's stale values and never throws).
   */
  private async refreshGauges(): Promise<void> {
    await this.refreshLiveSessionsGauge();
    await this.refreshOpenTradesGauge();
  }

  private async refreshLiveSessionsGauge(): Promise<void> {
    const gauge = METRIC_GAUGE_NAMES.LIVE_SESSIONS_ACTIVE;
    try {
      const activeSessions = await this.sessionRepo.count({
        where: { status: TradingSessionStatus.ACTIVE },
      });
      this.metrics.setGauge(gauge, activeSessions);
    } catch (err) {
      this.metrics.removeGauge(gauge);
      this.logger.warn(
        `Gauge ${gauge} omitted this scrape (session count query failed): ${(err as Error).message}`,
      );
    }
  }

  private async refreshOpenTradesGauge(): Promise<void> {
    const gauge = METRIC_GAUGE_NAMES.OPEN_TRADES;
    const statuses: TradeStatus[] = [TradeStatus.OPEN, TradeStatus.RECONCILIATION_PENDING];
    try {
      const rows: Array<{ status: string; count: string }> = await this.tradeRepo
        .createQueryBuilder('trade')
        .select('trade.status', 'status')
        .addSelect('COUNT(*)', 'count')
        .where('trade.status IN (:...statuses)', { statuses })
        .groupBy('trade.status')
        .getRawMany();
      const byStatus = new Map(rows.map((row) => [row.status, Number(row.count)]));
      // Both status series always materialize (0 when absent) so the scrape
      // exposes an explicit zero rather than an absent series.
      for (const status of statuses) {
        this.metrics.setGauge(gauge, byStatus.get(status) ?? 0, { status });
      }
    } catch (err) {
      this.metrics.removeGauge(gauge);
      this.logger.warn(
        `Gauge ${gauge} omitted this scrape (open-trade count query failed): ${(err as Error).message}`,
      );
    }
  }
}
