import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import {
  BrokerLinkOutbox,
  BrokerLinkOutboxAuditPayload,
  BrokerLinkOutboxEventType,
  BrokerLinkOutboxEventPayload,
} from '../entities/broker-link-outbox.entity';
import { AuditService } from '../../audit/audit.service';
import { AuditSeverity } from '../../audit/entities/audit-log.entity';
import { DomainEventBus } from '../../events/event-bus.service';
import { DomainEventType } from '../../events/enums/domain-event-type.enum';

/**
 * One outbox row to be committed atomically with its connection INSERT.
 * `connectionId` is filled by the caller that owns the connection row.
 */
export interface BrokerLinkOutboxEntry {
  connectionId: string;
  flowId?: string | null;
  eventType: BrokerLinkOutboxEventType;
  payload: Record<string, unknown>;
}

/** Result of one sweep pass (observability + tests). */
export interface BrokerLinkOutboxSweepResult {
  delivered: number;
  failed: number;
  deferred: number;
}

/**
 * BrokerLinkOutboxService — durable outbox for broker-link post-commit side
 * effects (Sprint 56 correction round 5, architect issue #332).
 *
 * TWO WRITE PATHS:
 * 1. `enqueueWithinTransaction(manager, entries)` — called INSIDE the
 *    createConnection DataSource.transaction(): the outbox rows commit
 *    ATOMICALLY with the connection INSERT. This is the critical path —
 *    a failure here rolls the connection back too (zero durable rows).
 * 2. `enqueue(entry)` — standalone auto-commit insert for ADOPTION paths
 *    (the durable connection already exists; the flow already converged).
 *    Best-effort by contract: a failure logs and never breaks convergence.
 *
 * DELIVERY: `sweep()` claims (attempts+1, CAS on processed_at IS NULL),
 * delivers via AuditService / DomainEventBus, then marks processed_at.
 * Failures are retried with exponential backoff measured from `updatedAt`
 * (the last-attempt timestamp). Rows exceeding maxAttempts stay
 * unprocessed — operator-visible poison rows, never silently dropped.
 *
 * SCHEDULING: the broker health-check job (BullMQ, every 60 s) sweeps each
 * tick; the sweep is also safe to call manually/opportunistically.
 *
 * DELIVERY SEMANTICS: at-least-once. Concurrent sweepers never both mark a
 * row processed (the claim CAS), but a crash between claim and mark can
 * re-deliver — audit consumers must tolerate duplicate rows (the audit log
 * is append-only history; a duplicate entry is harmless and visible).
 */
@Injectable()
export class BrokerLinkOutboxService {
  private readonly logger = new Logger(BrokerLinkOutboxService.name);

  // Test seams (protected, overridden via subclass in specs — the pattern
  // used by BrokerOAuthTokenLifecycleService's concurrency specs).
  protected maxAttempts = 8;
  protected backoffScheduleMs: readonly number[] = [
    0, 500, 2_000, 10_000, 60_000, 300_000, 1_800_000,
  ];
  protected sweepBatchSize = 100;

  constructor(
    @InjectRepository(BrokerLinkOutbox)
    private readonly outboxRepo: Repository<BrokerLinkOutbox>,
    private readonly auditService: AuditService,
    private readonly eventBus: DomainEventBus,
  ) {}

  /**
   * Enqueue outbox rows ON an open transaction manager — the connection
   * INSERT and these rows commit together or not at all. Called from
   * BrokerService.createConnection's critical path.
   */
  async enqueueWithinTransaction(
    manager: EntityManager,
    entries: BrokerLinkOutboxEntry[],
  ): Promise<void> {
    if (entries.length === 0) return;
    const repo = manager.getRepository(BrokerLinkOutbox);
    await repo.save(
      entries.map((entry) =>
        repo.create({
          connectionId: entry.connectionId,
          flowId: entry.flowId ?? null,
          eventType: entry.eventType,
          payload: entry.payload,
        }),
      ),
    );
  }

  /**
   * Standalone (auto-commit) enqueue — for adoption paths where the durable
   * connection already exists. Best-effort: failures are logged, never
   * propagated (convergence of the flow is already the durable truth).
   */
  async enqueue(entry: BrokerLinkOutboxEntry): Promise<void> {
    await this.outboxRepo.save(
      this.outboxRepo.create({
        connectionId: entry.connectionId,
        flowId: entry.flowId ?? null,
        eventType: entry.eventType,
        payload: entry.payload,
      }),
    );
  }

  /**
   * Sweep: deliver every due unprocessed outbox row (oldest first).
   * Never throws — a broken sweep logs and returns its counts.
   */
  async sweep(): Promise<BrokerLinkOutboxSweepResult> {
    const result: BrokerLinkOutboxSweepResult = { delivered: 0, failed: 0, deferred: 0 };
    try {
      const pending = await this.outboxRepo
        .createQueryBuilder('outbox')
        .where('outbox.processedAt IS NULL AND outbox.attempts < :maxAttempts', {
          maxAttempts: this.maxAttempts,
        })
        .orderBy('outbox.createdAt', 'ASC')
        .take(this.sweepBatchSize)
        .getMany();

      for (const entry of pending) {
        // Backoff from the LAST attempt (updatedAt); attempt 0 is due now.
        const backoffMs =
          this.backoffScheduleMs[Math.min(entry.attempts, this.backoffScheduleMs.length - 1)];
        if (entry.updatedAt.getTime() + backoffMs > Date.now()) {
          result.deferred++;
          continue;
        }

        // Claim (attempts+1 under processed_at IS NULL): exactly one
        // concurrent sweeper delivers; a crash mid-delivery is retried later.
        const claimed = await this.outboxRepo
          .createQueryBuilder()
          .update(BrokerLinkOutbox)
          .set({ attempts: entry.attempts + 1 })
          .where('id = :id AND processed_at IS NULL', { id: entry.id })
          .execute();
        if (claimed.affected !== 1) continue;

        try {
          await this.deliver(entry);
          await this.outboxRepo.update({ id: entry.id } as never, { processedAt: new Date() });
          result.delivered++;
        } catch (err) {
          result.failed++;
          this.logger.warn(
            `Broker link outbox delivery failed for entry=${entry.id} ` +
              `type=${entry.eventType} attempts=${entry.attempts + 1}: ` +
              `${err instanceof Error ? err.constructor.name : 'UNKNOWN'} — retried after backoff`,
          );
        }
      }
    } catch (err) {
      this.logger.warn(
        `Broker link outbox sweep failed: ${err instanceof Error ? err.constructor.name : 'UNKNOWN'}`,
      );
    }
    return result;
  }

  /** Dispatches one entry to its destination service. */
  private async deliver(entry: BrokerLinkOutbox): Promise<void> {
    switch (entry.eventType) {
      case 'connection-created-audit':
      case 'oauth-account-linked-audit': {
        const payload = entry.payload as unknown as BrokerLinkOutboxAuditPayload;
        await this.auditService.log({
          actorUserId: payload.actorUserId,
          action: payload.action,
          resourceType: 'BrokerConnection',
          resourceId: entry.connectionId,
          ipAddress: payload.ipAddress ?? undefined,
          metadata: payload.metadata ?? undefined,
          severity: (payload.severity as AuditSeverity | undefined) ?? AuditSeverity.INFO,
        });
        return;
      }
      case 'broker-status-event': {
        const payload = entry.payload as unknown as BrokerLinkOutboxEventPayload;
        this.eventBus.publish(
          payload.domainEventType as DomainEventType,
          payload.userId,
          payload.payload,
        );
        return;
      }
      default: {
        // Unknown event type — permanently undeliverable poison row; the
        // attempts ceiling keeps it from being retried forever.
        throw new Error(`Unknown broker link outbox event type: ${entry.eventType}`);
      }
    }
  }
}
