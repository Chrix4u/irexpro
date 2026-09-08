import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import * as crypto from 'crypto';
import { ReconciliationRun } from './entities/reconciliation-run.entity';
import { ReconciliationDiscrepancy } from './entities/reconciliation-discrepancy.entity';
import { ReconciliationDiscrepancyStatus, ReconciliationRunStatus } from './reconciliation.enums';
import { DiscrepancyCandidate } from './reconciliation-comparator';

/**
 * ReconciliationPersistenceService — persists reconciliation runs and
 * discrepancies (Directive §25: persist, never silently hide).
 *
 * CONCURRENCY MODEL (Directive §30):
 * - Discrepancy upserts run inside a short transaction guarded by
 *   pg_advisory_xact_lock keyed on the broker connection — two concurrent
 *   runs over the same connection serialize instead of racing the dedup
 *   index into 23505 errors.
 * - The ON CONFLICT clause targets the partial unique OPEN-row index:
 *   re-detected discrepancies refresh last_seen_at/details; brand-new
 *   findings insert. Resolved rows never conflict (a recurring drift opens
 *   a NEW row — honest history).
 * - Resolution uses a guarded UPDATE (WHERE status = 'OPEN') so a duplicate
 *   provider event (or two resolvers) can never double-resolve.
 */
@Injectable()
export class ReconciliationPersistenceService {
  private readonly logger = new Logger(ReconciliationPersistenceService.name);

  constructor(
    @InjectRepository(ReconciliationRun)
    private readonly runRepo: Repository<ReconciliationRun>,
    @InjectRepository(ReconciliationDiscrepancy)
    private readonly discrepancyRepo: Repository<ReconciliationDiscrepancy>,
    private readonly dataSource: DataSource,
  ) {}

  /** SHA-256-derived 31-bit advisory lock key per connection (PR-3 pattern). */
  private connectionLockKey(brokerConnectionId: string): number {
    const digest = crypto.createHash('sha256').update(brokerConnectionId).digest();
    return digest.readUInt32BE(0) & 0x7fffffff;
  }

  /**
   * Unwrap TypeORM's Postgres driver result shape. UPDATE queries return
   * `[rows, rowCount]` (even with RETURNING — the PR-3 applyFill lesson);
   * other queries return the rows array directly. Shape-aware so both work.
   */
  private unwrapQueryRows(result: unknown): Array<Record<string, unknown>> {
    if (Array.isArray(result) && Array.isArray(result[0])) {
      return result[0] as Array<Record<string, unknown>>;
    }
    return (result as Array<Record<string, unknown>>) ?? [];
  }

  // ─── Runs ──────────────────────────────────────────────────────────────────────

  async createRun(input: {
    userId: string;
    brokerConnectionId: string;
    brokerId: string;
  }): Promise<ReconciliationRun> {
    const run = this.runRepo.create({
      userId: input.userId,
      brokerConnectionId: input.brokerConnectionId,
      brokerId: input.brokerId,
      status: ReconciliationRunStatus.RUNNING,
      startedAt: new Date(),
    });
    return this.runRepo.save(run);
  }

  async completeRun(
    runId: string,
    outcome: {
      status: ReconciliationRunStatus;
      counters: Partial<
        Pick<
          ReconciliationRun,
          | 'providerOrdersSeen'
          | 'internalOrdersCompared'
          | 'providerPositionsSeen'
          | 'internalPositionsCompared'
          | 'accountSnapshotCompared'
          | 'discrepanciesDetected'
          | 'discrepanciesNew'
          | 'discrepanciesAutoResolved'
          | 'discrepanciesOpen'
          | 'errors'
        >
      >;
      errorSummary?: string | null;
      metadata?: Record<string, unknown> | null;
    },
  ): Promise<void> {
    await this.runRepo.update(runId, {
      status: outcome.status,
      completedAt: new Date(),
      errorSummary: outcome.errorSummary ?? null,
      metadata: outcome.metadata ?? null,
      ...outcome.counters,
    } as never);
  }

  async failRun(runId: string, errorSummary: string): Promise<void> {
    await this.runRepo.update(runId, {
      status: ReconciliationRunStatus.FAILED,
      completedAt: new Date(),
      errorSummary: errorSummary.slice(0, 2000),
    });
  }

  // ─── Discrepancies ─────────────────────────────────────────────────────────

  /**
   * Persist detected candidates with OPEN-row dedup. Returns:
   * - `inserted`: rows inserted this run (first detection)
   * - `refreshed`: existing OPEN rows re-seen (lastSeenAt/details updated)
   * - `newRows`: identity of INSERTED rows (for discrepancy.detected events)
   */
  async persistDiscrepancies(
    connection: { userId: string; brokerConnectionId: string },
    runId: string,
    candidates: DiscrepancyCandidate[],
  ): Promise<{
    inserted: number;
    refreshed: number;
    newRows: Array<{
      id: string;
      type: string;
      severity: string;
      internalRefId: string | null;
      providerRef: string | null;
      clientOrderId: string | null;
    }>;
  }> {
    if (candidates.length === 0) {
      return { inserted: 0, refreshed: 0, newRows: [] };
    }

    const lockKey = this.connectionLockKey(connection.brokerConnectionId);
    let inserted = 0;
    let refreshed = 0;
    const newRows: Array<{
      id: string;
      type: string;
      severity: string;
      internalRefId: string | null;
      providerRef: string | null;
      clientOrderId: string | null;
    }> = [];

    // One short transaction for the whole batch: serialized against other
    // runs on the same connection; provider I/O happens BEFORE this method.
    await this.dataSource.transaction(async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock($1)', [lockKey]);

      for (const candidate of candidates) {
        // ON CONFLICT infers the partial unique index on OPEN rows
        // (COALESCE expressions match the index definition exactly).
        const result = await manager.query(
          `INSERT INTO reconciliation.discrepancies
             (user_id, broker_connection_id, run_id, discrepancy_type, severity,
              status, internal_ref_type, internal_ref_id, client_order_id,
              provider_ref, details, first_detected_at, last_seen_at)
           VALUES ($1, $2, $3, $4, $5, 'OPEN', $6, $7, $8, $9, $10, $11, $11)
           ON CONFLICT
             (broker_connection_id, discrepancy_type,
              COALESCE(internal_ref_id, ''), COALESCE(provider_ref, ''))
             WHERE status = 'OPEN'
           DO UPDATE SET
             last_seen_at = EXCLUDED.last_seen_at,
             details = EXCLUDED.details,
             severity = EXCLUDED.severity,
             run_id = EXCLUDED.run_id,
             updated_at = now()
           RETURNING id, discrepancy_type, severity, internal_ref_id,
                     provider_ref, client_order_id, (xmax = 0) AS inserted_new`,
          [
            connection.userId,
            connection.brokerConnectionId,
            runId,
            candidate.type,
            candidate.severity,
            candidate.internalRefType,
            candidate.internalRefId,
            candidate.clientOrderId,
            candidate.providerRef,
            JSON.stringify(candidate.details ?? {}),
            new Date(),
          ],
        );

        // Shape-aware: INSERT ... RETURNING may arrive as rows or as
        // [rows, rowCount] depending on driver/statement shape.
        const rows = this.unwrapQueryRows(result);
        const row = rows[0];
        if (row?.inserted_new === true || row?.inserted_new === 'true') {
          inserted++;
          newRows.push({
            id: String(row.id),
            type: String(row.discrepancy_type),
            severity: String(row.severity),
            internalRefId: (row.internal_ref_id as string | null) ?? null,
            providerRef: (row.provider_ref as string | null) ?? null,
            clientOrderId: (row.client_order_id as string | null) ?? null,
          });
        } else {
          refreshed++;
        }
      }
    });

    this.logger.debug(
      `Persisted ${candidates.length} discrepancy candidates: ` +
        `${inserted} new, ${refreshed} refreshed (connection ${connection.brokerConnectionId})`,
    );

    return { inserted, refreshed, newRows };
  }

  /**
   * Guarded resolution: only an OPEN row flips to RESOLVED — duplicate
   * provider events / concurrent resolvers get rowCount 0 and no-op.
   * Returns the identity of rows THIS call resolved (for resolved events).
   */
  async resolveDiscrepanciesByRef(
    brokerConnectionId: string,
    refs: Array<{
      type: string;
      internalRefId: string | null;
      providerRef: string | null;
      resolution: string;
    }>,
  ): Promise<
    Array<{ id: string; type: string; internalRefId: string | null; providerRef: string | null }>
  > {
    if (refs.length === 0) return [];

    const lockKey = this.connectionLockKey(brokerConnectionId);
    const resolved: Array<{
      id: string;
      type: string;
      internalRefId: string | null;
      providerRef: string | null;
    }> = [];

    await this.dataSource.transaction(async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock($1)', [lockKey]);

      for (const ref of refs) {
        const result = await manager.query(
          `UPDATE reconciliation.discrepancies
           SET status = 'RESOLVED',
               resolved_at = now(),
               resolution = $3,
               resolved_by = 'AUTO',
               updated_at = now()
           WHERE broker_connection_id = $1
             AND discrepancy_type = $2
             AND COALESCE(internal_ref_id, '') = COALESCE($4, '')
             AND COALESCE(provider_ref, '') = COALESCE($5, '')
             AND status = 'OPEN'
           RETURNING id, discrepancy_type, internal_ref_id, provider_ref`,
          [
            brokerConnectionId,
            ref.type,
            ref.resolution.slice(0, 500),
            ref.internalRefId,
            ref.providerRef,
          ],
        );
        // UPDATE ... RETURNING arrives as [rows, rowCount] on the Postgres
        // driver — unwrap before reading (PR-3 applyFill lesson).
        const rows = this.unwrapQueryRows(result);
        for (const row of rows) {
          resolved.push({
            id: String(row.id),
            type: String(row.discrepancy_type),
            internalRefId: (row.internal_ref_id as string | null) ?? null,
            providerRef: (row.provider_ref as string | null) ?? null,
          });
        }
      }
    });

    return resolved;
  }

  /** Count OPEN discrepancies for a connection (run outcome classification). */
  async countOpenDiscrepancies(brokerConnectionId: string): Promise<number> {
    const rows = await this.discrepancyRepo
      .createQueryBuilder('d')
      .where('d.brokerConnectionId = :connectionId', { connectionId: brokerConnectionId })
      .andWhere('d.status = :status', { status: ReconciliationDiscrepancyStatus.OPEN })
      .getCount();
    return rows;
  }
}
