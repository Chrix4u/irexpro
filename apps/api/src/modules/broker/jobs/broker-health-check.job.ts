import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ModuleRef } from '@nestjs/core';
import { Repository } from 'typeorm';
import { Job } from 'bullmq';
import { BrokerService } from '../broker.service';
import { BrokerConnection } from '../entities/broker-connection.entity';
import { BrokerConnectionStatus } from '../interfaces/broker-adapter.interface';
import { BrokerLinkOutboxService } from '../services/broker-link-outbox.service';
// Production-LIVE completion round (P13 metrics): dependency-free in-process
// counters/gauges (lazy ModuleRef seam — see the metrics getter below).
import { MetricsService } from '../../metrics/metrics.service';
import { METRIC_GAUGE_NAMES, METRIC_NAMES } from '../../metrics/metric-names';

export const BROKER_HEALTH_QUEUE = 'broker-health-check';
export const BROKER_HEALTH_JOB = 'health-check-all';

/**
 * Log-privacy helper (Phase F): account identifiers never reach the logs in
 * full — only the last 4 characters survive.
 */
function maskLikeId(value: string | null | undefined): string {
  if (!value || value.length < 4) return '•••';
  return `•••${String(value).slice(-4)}`;
}

/**
 * BrokerHealthCheckJob — BullMQ processor for periodic broker connection health checks.
 *
 * Runs on a configurable interval (default 60s via BrokerHealthCheckProducer).
 * For each BrokerConnection with status=CONNECTED:
 *   1. Calls BrokerService.healthCheck(connectionId)
 *   2. BrokerService decrypts credentials, calls adapter.connect() (pool reuse), then getAccountBalance()
 *   3. On 3 consecutive failures: connection is auto-suspended + audit event logged
 *
 * Sprint 56 correction round 5 (architect issue #332): every tick ALSO sweeps
 * the broker_link_outbox — the durable retry/backoff delivery of post-commit
 * broker-link audit/event work (committed atomically with connection
 * creation). The sweep never throws into the job (its own failure is logged
 * and retried on the next tick).
 *
 * See: docs/architecture/09-broker-integration-architecture.md §7
 */
@Processor(BROKER_HEALTH_QUEUE)
export class BrokerHealthCheckJob extends WorkerHost {
  private readonly logger = new Logger(BrokerHealthCheckJob.name);

  constructor(
    private readonly brokerService: BrokerService,
    @InjectRepository(BrokerConnection)
    private readonly connectionRepo: Repository<BrokerConnection>,
    private readonly linkOutbox: BrokerLinkOutboxService,
    /**
     * Production-LIVE completion round (P13 metrics): lazy metrics seam —
     * OPTIONAL trailing dependency so direct constructions in specs keep
     * compiling unchanged. Resolved at CALL time via ModuleRef.get(...,
     * { strict: false }) exactly like risk.service / execution-orchestrator
     * (see metrics.module.ts for the DI decision). When the lookup fails the
     * getter returns null and every `this.metrics?…` call site no-ops —
     * observability can never break the health loop.
     */
    private readonly moduleRef?: ModuleRef,
  ) {
    super();
  }

  /** Lazy MetricsService lookup (never throws, never affects control flow). */
  private get metrics(): MetricsService | null {
    try {
      return this.moduleRef?.get(MetricsService, { strict: false }) ?? null;
    } catch {
      return null;
    }
  }

  async process(job: Job): Promise<{ checked: number; failed: number }> {
    this.logger.debug(`Running broker health check job: ${job.id}`);

    // #332: outbox sweep first — the audit/event delivery schedule rides the
    // existing 60s broker job cadence (the sweep itself is guarded and never
    // throws).
    const outboxResult = await this.linkOutbox.sweep();
    if (outboxResult.delivered > 0 || outboxResult.failed > 0) {
      this.logger.log(
        `Broker link outbox sweep: ${outboxResult.delivered} delivered, ` +
          `${outboxResult.failed} failed (will retry after backoff), ` +
          `${outboxResult.deferred} deferred`,
      );
    }

    const connections = await this.connectionRepo.find({
      where: { status: BrokerConnectionStatus.CONNECTED },
      select: ['id', 'userId', 'brokerId', 'accountId'],
    });

    if (connections.length === 0) {
      this.logger.debug('No active broker connections to health check');
      return { checked: 0, failed: 0 };
    }

    this.logger.log(`Health checking ${connections.length} active broker connection(s)`);

    let checked = 0;
    let failed = 0;

    await Promise.allSettled(
      connections.map(async (conn) => {
        try {
          const healthy = await this.brokerService.healthCheck(conn.id);
          if (healthy) {
            checked++;
            // P13 metrics: per-provider connectivity probe outcome + the
            // last-success epoch gauge (staleness = time() − value at scrape).
            this.metrics?.increment(METRIC_NAMES.BROKER_HEALTH_CHECKS, {
              brokerId: conn.brokerId,
              outcome: 'HEALTHY',
            });
            this.metrics?.setGauge(
              METRIC_GAUGE_NAMES.BROKER_HEALTH_LAST_SUCCESS_EPOCH_SECONDS,
              Math.floor(Date.now() / 1000),
              { brokerId: conn.brokerId },
            );
          } else {
            failed++;
            this.metrics?.increment(METRIC_NAMES.BROKER_HEALTH_CHECKS, {
              brokerId: conn.brokerId,
              outcome: 'UNHEALTHY',
            });
            this.logger.warn(
              `Health check failed for connection ${conn.id} (broker=${conn.brokerId}, account=${maskLikeId(conn.accountId)})`,
            );
          }
        } catch (err) {
          failed++;
          this.metrics?.increment(METRIC_NAMES.BROKER_HEALTH_CHECKS, {
            brokerId: conn.brokerId,
            outcome: 'ERROR',
          });
          this.logger.error(
            `Health check threw for connection ${conn.id}: ${(err as Error).message}`,
          );
        }
      }),
    );

    this.logger.log(`Health check complete: ${checked} healthy, ${failed} failed`);
    return { checked, failed };
  }
}
