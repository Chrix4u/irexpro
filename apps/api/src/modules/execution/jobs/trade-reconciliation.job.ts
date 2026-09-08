import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { BrokerConnection } from '../../broker/entities/broker-connection.entity';
import { StateReconciliationService } from '../reconciliation/state-reconciliation.service';
import { ReconciliationRunOutcome } from '../reconciliation/state-reconciliation.service';

export const TRADE_RECONCILIATION_QUEUE = 'trade-reconciliation';
export const TRADE_RECONCILIATION_JOB = 'reconcile-open-trades';
export const RECONCILIATION_INTERVAL_MS = 60_000; // 60 seconds

/**
 * TradeReconciliationJob — the scheduled reconciliation worker (Directive
 * PHASE G + §29).
 *
 * Sprint 50 PR-4 REFACTOR: the per-trade inline logic moved into
 * StateReconciliationService, which reconciles the FULL connection state
 * (orders + positions + account snapshot) with persisted runs and
 * discrepancy records. The job now:
 *   1. Discovers candidate connections (internal state worth reconciling).
 *   2. Runs ONE full state reconciliation per connection — SEQUENTIALLY.
 *   3. Aggregates outcomes; per-connection failures never break the loop.
 *
 * WHY SEQUENTIAL: broker adapters are stateful singletons (MetaTrader sets
 * currentAccountId per connect) — the previous Promise.allSettled over
 * trades from DIFFERENT connections could interleave adapter sessions.
 * Sequential per-connection runs are correct for that model.
 *
 * Queue semantics (§29): the BullMQ repeatable job provides stable job
 * identity + exactly-one-run-per-interval; producers strip stale
 * repeatables on boot so restarts never duplicate the schedule. Runs are
 * idempotent (guarded mutations + OPEN-row dedup).
 *
 * See: docs/reconciliation/state-reconciliation.md
 */
@Injectable()
@Processor(TRADE_RECONCILIATION_QUEUE)
export class TradeReconciliationJob extends WorkerHost {
  private readonly logger = new Logger(TradeReconciliationJob.name);

  constructor(private readonly stateReconciliation: StateReconciliationService) {
    super();
  }

  async process(job: Job): Promise<{
    connectionsReconciled: number;
    discrepanciesDetected: number;
    discrepanciesNew: number;
    discrepanciesAutoResolved: number;
    discrepanciesOpen: number;
    failedConnections: number;
  }> {
    this.logger.debug(`Running reconciliation worker cycle ${job.id}`);

    const connections: BrokerConnection[] =
      await this.stateReconciliation.findReconcilableConnections();

    if (connections.length === 0) {
      return {
        connectionsReconciled: 0,
        discrepanciesDetected: 0,
        discrepanciesNew: 0,
        discrepanciesAutoResolved: 0,
        discrepanciesOpen: 0,
        failedConnections: 0,
      };
    }

    this.logger.log(`Reconciling ${connections.length} connection(s)`);

    let discrepanciesDetected = 0;
    let discrepanciesNew = 0;
    let discrepanciesAutoResolved = 0;
    let discrepanciesOpen = 0;
    let failedConnections = 0;

    // Sequential per connection (stateful adapter model — see class docs).
    for (const connection of connections) {
      try {
        const outcome: ReconciliationRunOutcome =
          await this.stateReconciliation.runForConnection(connection);
        discrepanciesDetected += outcome.discrepanciesDetected;
        discrepanciesNew += outcome.discrepanciesNew;
        discrepanciesAutoResolved += outcome.discrepanciesAutoResolved;
        discrepanciesOpen += outcome.discrepanciesOpen;
        if (outcome.status === 'FAILED') failedConnections++;
      } catch (err) {
        // runForConnection handles its own failures; this guards the loop.
        failedConnections++;
        this.logger.error(
          `Reconciliation run threw for connection ${connection.id}: ${(err as Error).message}`,
        );
      }
    }

    this.logger.log(
      `Reconciliation cycle complete: ${connections.length} connections, ` +
        `${discrepanciesDetected} detected (${discrepanciesNew} new), ` +
        `${discrepanciesAutoResolved} auto-resolved, ${discrepanciesOpen} open, ` +
        `${failedConnections} failed`,
    );

    return {
      connectionsReconciled: connections.length,
      discrepanciesDetected,
      discrepanciesNew,
      discrepanciesAutoResolved,
      discrepanciesOpen,
      failedConnections,
    };
  }
}
