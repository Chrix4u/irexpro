import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Job } from 'bullmq';
import { BrokerConnection } from '../../broker/entities/broker-connection.entity';
import { StateReconciliationService } from '../reconciliation/state-reconciliation.service';
import { ReconciliationRunOutcome } from '../reconciliation/state-reconciliation.service';
import { ExecutionService } from '../execution.service';
// Production-LIVE completion round (P13 metrics): dependency-free in-process
// counters (lazy ModuleRef seam — same pattern as risk.service).
import { MetricsService } from '../../metrics/metrics.service';
import { METRIC_NAMES } from '../../metrics/metric-names';
// Round 6 live-execution completion (§8): the protective-order loop runs
// after every per-connection state sweep.
import {
  ProtectiveOrderReconciliationService,
  ProtectiveReconciliationOutcome,
} from '../reconciliation/protective-order-reconciliation.service';

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
 *   3. Round 6 §8: runs the protective-order reconciliation loop (per-trade
 *      SL/TP verify/repair) after each state sweep — same sequential adapter
 *      model, same per-connection failure isolation.
 *   4. Aggregates outcomes; per-connection failures never break the loop.
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

  constructor(
    private readonly stateReconciliation: StateReconciliationService,
    // Round 6 §8: the protective-order loop (per-trade SL/TP verify/repair).
    private readonly protectiveOrderReconciliation: ProtectiveOrderReconciliationService,
    // Explicit user Stop AI Trading continuation: after provider truth has
    // been reconciled, flatten any late fill tied to a durably marked session.
    private readonly executionService: ExecutionService,
    /**
     * Production-LIVE completion round (P13 metrics): lazy metrics seam —
     * OPTIONAL trailing dependency (specs keep compiling; the ModuleRef
     * lookup resolves the app-wide MetricsService singleton at CALL time and
     * no-ops when absent — see metrics.module.ts for the DI decision).
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

  async process(job: Job): Promise<{
    connectionsReconciled: number;
    discrepanciesDetected: number;
    discrepanciesNew: number;
    discrepanciesAutoResolved: number;
    discrepanciesOpen: number;
    failedConnections: number;
    protectiveOrdersChecked: number;
    protectiveOrdersRepaired: number;
    protectiveRepairsFailed: number;
  }> {
    this.logger.debug(`Running reconciliation worker cycle ${job.id}`);

    const connections: BrokerConnection[] =
      await this.stateReconciliation.findReconcilableConnections();

    if (connections.length === 0) {
      // P13 metrics: a tick that found nothing to reconcile is still a
      // COMPLETED cycle (sweep liveness proof — the age gauge backs it).
      this.metrics?.increment(METRIC_NAMES.RECONCILIATION_CYCLES);
      return {
        connectionsReconciled: 0,
        discrepanciesDetected: 0,
        discrepanciesNew: 0,
        discrepanciesAutoResolved: 0,
        discrepanciesOpen: 0,
        failedConnections: 0,
        protectiveOrdersChecked: 0,
        protectiveOrdersRepaired: 0,
        protectiveRepairsFailed: 0,
      };
    }

    this.logger.log(`Reconciling ${connections.length} connection(s)`);

    let discrepanciesDetected = 0;
    let discrepanciesNew = 0;
    let discrepanciesAutoResolved = 0;
    let discrepanciesOpen = 0;
    let failedConnections = 0;
    // Round 6 §8: protective-order aggregates.
    let protectiveOrdersChecked = 0;
    let protectiveOrdersRepaired = 0;
    let protectiveRepairsFailed = 0;

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

      // A provider dispatch can cross the final commitment immediately before
      // the user presses Stop. The state sweep above first converges that
      // provider truth; this follow-up then closes any newly OPEN position
      // belonging to a session durably marked closeAiPositionsOnStop.
      try {
        await this.executionService.closeStopRequestedAiPositions(connection.userId, connection.id);
      } catch (err) {
        this.logger.error(
          `AI-stop reconciliation flatten threw for connection ${connection.id}: ` +
            `${(err as Error).message}`,
        );
      }

      // Round 6 §8: the protective-order loop AFTER the state sweep (same
      // connection, sequential adapter model). A protective-loop failure
      // never breaks the cycle — every failure is typed + audited inside.
      try {
        const protective: ProtectiveReconciliationOutcome =
          await this.protectiveOrderReconciliation.reconcileProtectiveOrders(connection);
        protectiveOrdersChecked += protective.checked;
        protectiveOrdersRepaired += protective.repairedCount;
        protectiveRepairsFailed += protective.repairFailedCount;
      } catch (err) {
        this.logger.error(
          `Protective-order reconciliation threw for connection ${connection.id}: ` +
            `${(err as Error).message}`,
        );
      }
    }

    this.logger.log(
      `Reconciliation cycle complete: ${connections.length} connections, ` +
        `${discrepanciesDetected} detected (${discrepanciesNew} new), ` +
        `${discrepanciesAutoResolved} auto-resolved, ${discrepanciesOpen} open, ` +
        `${failedConnections} failed; protective orders: ${protectiveOrdersChecked} ` +
        `checked, ${protectiveOrdersRepaired} repaired, ${protectiveRepairsFailed} ` +
        `repair failures`,
    );

    // P13 metrics: one completed worker cycle (per-connection discrepancy
    // counts live in the state-reconciliation service's own counters).
    this.metrics?.increment(METRIC_NAMES.RECONCILIATION_CYCLES);

    return {
      connectionsReconciled: connections.length,
      discrepanciesDetected,
      discrepanciesNew,
      discrepanciesAutoResolved,
      discrepanciesOpen,
      failedConnections,
      protectiveOrdersChecked,
      protectiveOrdersRepaired,
      protectiveRepairsFailed,
    };
  }
}
