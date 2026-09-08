import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Job } from 'bullmq';
import { BrokerService } from '../broker.service';
import { BrokerConnection } from '../entities/broker-connection.entity';
import { BrokerConnectionStatus } from '../interfaces/broker-adapter.interface';

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
 * See: docs/architecture/09-broker-integration-architecture.md §7
 */
@Processor(BROKER_HEALTH_QUEUE)
export class BrokerHealthCheckJob extends WorkerHost {
  private readonly logger = new Logger(BrokerHealthCheckJob.name);

  constructor(
    private readonly brokerService: BrokerService,
    @InjectRepository(BrokerConnection)
    private readonly connectionRepo: Repository<BrokerConnection>,
  ) {
    super();
  }

  async process(job: Job): Promise<{ checked: number; failed: number }> {
    this.logger.debug(`Running broker health check job: ${job.id}`);

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
          } else {
            failed++;
            this.logger.warn(
              `Health check failed for connection ${conn.id} (broker=${conn.brokerId}, account=${maskLikeId(conn.accountId)})`,
            );
          }
        } catch (err) {
          failed++;
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
