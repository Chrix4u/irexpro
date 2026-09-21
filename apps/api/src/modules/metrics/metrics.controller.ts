import { Controller, Get, Header, Logger, UseGuards } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Public } from '../../common/decorators/public.decorator';
import {
  INTERNAL_API_KEY_HEADER,
  InternalApiKeyGuard,
} from '../../common/guards/internal-api-key.guard';
import { BrokerAccountSnapshot } from '../broker/entities/broker-account-snapshot.entity';
import { BROKER_AUTHORIZATION_STATUSES } from '../broker/authorization/broker-authorization-status';
import { BrokerConnection } from '../broker/entities/broker-connection.entity';
import { Order } from '../execution/orders/order.entity';
import { OrderStatus } from '../execution/orders/order.enums';
import { ReconciliationRun } from '../execution/reconciliation/entities/reconciliation-run.entity';
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
 * DB-backed gauges are computed ON SCRAPE (cheap single queries — counts and
 * grouped counts). FAIL-OPEN for observability only: if a backing query
 * fails, the gauge lines are OMITTED (never a 500, never a stale value from
 * a previous successful scrape).
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
    @InjectRepository(BrokerConnection)
    private readonly connectionRepo: Repository<BrokerConnection>,
    @InjectRepository(BrokerAccountSnapshot)
    private readonly snapshotRepo: Repository<BrokerAccountSnapshot>,
    @InjectRepository(ReconciliationRun)
    private readonly runRepo: Repository<ReconciliationRun>,
    @InjectRepository(Order)
    private readonly orderRepo: Repository<Order>,
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
   * Refresh the DB-backed gauges. Each query is independently fail-open: on
   * failure the gauge is REMOVED (a failed scrape omits the lines — it never
   * serves the previous scrape's stale values and never throws).
   */
  private async refreshGauges(): Promise<void> {
    await this.refreshLiveSessionsGauge();
    await this.refreshOpenTradesGauge();
    await this.refreshBrokerConnectionsGauge();
    await this.refreshSnapshotStalenessGauge();
    await this.refreshReconciliationAgeGauge();
    await this.refreshReconciliationPendingOrdersGauge();
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

  /**
   * Live authorization state: count of broker connections grouped by
   * authorizationStatus. Every enum status materializes (0 when absent) so
   * the scrape exposes explicit zeros rather than absent series.
   */
  private async refreshBrokerConnectionsGauge(): Promise<void> {
    const gauge = METRIC_GAUGE_NAMES.BROKER_CONNECTIONS_BY_AUTHORIZATION;
    try {
      const rows: Array<{ authorizationStatus: string; count: string }> = await this.connectionRepo
        .createQueryBuilder('conn')
        .select('conn.authorizationStatus', 'authorizationStatus')
        .addSelect('COUNT(*)', 'count')
        .groupBy('conn.authorizationStatus')
        .getRawMany();
      const byStatus = new Map(rows.map((row) => [row.authorizationStatus, Number(row.count)]));
      for (const status of BROKER_AUTHORIZATION_STATUSES) {
        this.metrics.setGauge(gauge, byStatus.get(status) ?? 0, { authorizationStatus: status });
      }
    } catch (err) {
      this.metrics.removeGauge(gauge);
      this.logger.warn(
        `Gauge ${gauge} omitted this scrape (connection authorization count query failed): ` +
          `${(err as Error).message}`,
      );
    }
  }

  /**
   * Account snapshot staleness: seconds since the observation instant
   * (providerObservedAt ?? acceptedAt — the snapshot service's documented
   * freshness semantics) of each connection's LATEST ACCEPTED snapshot,
   * selected BY GENERATION (never by write time). The connectionId label is
   * the internal row id — never a provider account id, never a secret.
   * Connections with no accepted snapshot have no series (absent = honest).
   */
  private async refreshSnapshotStalenessGauge(): Promise<void> {
    const gauge = METRIC_GAUGE_NAMES.BROKER_SNAPSHOT_STALENESS_SECONDS;
    try {
      // DISTINCT ON keeps exactly the highest-generation row per connection
      // (PostgreSQL — the production driver; the repo is mocked in unit tests).
      const rows: Array<{ connection_id: string; observed_at: string | Date | null }> =
        await this.snapshotRepo.query(
          `SELECT DISTINCT ON (connection_id) connection_id, ` +
            `COALESCE(provider_observed_at, accepted_at) AS observed_at ` +
            `FROM broker.broker_account_snapshots ORDER BY connection_id, generation DESC`,
        );
      for (const row of rows) {
        const observedAt = row.observed_at ? new Date(row.observed_at).getTime() : null;
        if (observedAt === null || !Number.isFinite(observedAt)) continue;
        // Clamp at zero — a provider clock slightly ahead must never yield a
        // negative age.
        const ageSeconds = Math.max(0, (Date.now() - observedAt) / 1000);
        this.metrics.setGauge(gauge, ageSeconds, { connectionId: row.connection_id });
      }
    } catch (err) {
      this.metrics.removeGauge(gauge);
      this.logger.warn(
        `Gauge ${gauge} omitted this scrape (snapshot staleness query failed): ` +
          `${(err as Error).message}`,
      );
    }
  }

  /**
   * Reconciliation liveness: seconds since the most recent reconciliation
   * run reached a terminal state (MAX(completed_at) across all runs — both
   * COMPLETED and FAILED runs set completed_at). This proves the sweep is
   * ticking, not that every connection reconciled cleanly; per-run outcomes
   * live in the reconciliation_discrepancies counters. Omitted when no run
   * has ever completed (honest absence).
   */
  private async refreshReconciliationAgeGauge(): Promise<void> {
    const gauge = METRIC_GAUGE_NAMES.RECONCILIATION_LAST_CYCLE_AGE_SECONDS;
    try {
      const rows: Array<{ last_completed_at: string | Date | null }> = await this.runRepo.query(
        `SELECT MAX(completed_at) AS last_completed_at FROM reconciliation.runs`,
      );
      const lastCompleted = rows[0]?.last_completed_at;
      const completedMs = lastCompleted ? new Date(lastCompleted).getTime() : null;
      if (completedMs !== null && Number.isFinite(completedMs)) {
        this.metrics.setGauge(gauge, Math.max(0, (Date.now() - completedMs) / 1000));
      }
    } catch (err) {
      this.metrics.removeGauge(gauge);
      this.logger.warn(
        `Gauge ${gauge} omitted this scrape (reconciliation age query failed): ` +
          `${(err as Error).message}`,
      );
    }
  }

  /**
   * Orphaned/uncertain orders: count of Order rows stuck in
   * RECONCILIATION_PENDING — a dispatch whose outcome is unproven (no
   * confirmed provider truth). The state-reconciliation sweep converges or
   * surfaces every one of these; a non-zero value that persists across
   * cycles warrants operator attention.
   */
  private async refreshReconciliationPendingOrdersGauge(): Promise<void> {
    const gauge = METRIC_GAUGE_NAMES.RECONCILIATION_PENDING_ORDERS;
    try {
      const pending = await this.orderRepo.count({
        where: { status: OrderStatus.RECONCILIATION_PENDING },
      });
      this.metrics.setGauge(gauge, pending);
    } catch (err) {
      this.metrics.removeGauge(gauge);
      this.logger.warn(
        `Gauge ${gauge} omitted this scrape (reconciliation-pending order count query failed): ` +
          `${(err as Error).message}`,
      );
    }
  }
}
