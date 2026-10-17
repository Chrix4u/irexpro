import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job } from 'bullmq';
import { BrokerConnection } from '../../broker/entities/broker-connection.entity';
import { BrokerConnectionStatus } from '../../broker/interfaces/broker-adapter.interface';
import { LivePaperMarketDataService } from '../../broker/services/live-paper-market-data.service';
import { isFxWeeklySessionOpen } from '../../market-data/utils/fx-weekly-session';
import { StateReconciliationService } from '../reconciliation/state-reconciliation.service';
import { ReconciliationRunOutcome } from '../reconciliation/state-reconciliation.service';
import { ExecutionService } from '../execution.service';
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
    private readonly livePaperMarketData: LivePaperMarketDataService,
    private readonly configService: ConfigService,
  ) {
    super();
  }

  private isLivePaperConnection(connectionId: string): boolean {
    if (this.livePaperMarketData.isLiveConnection(connectionId)) return true;

    // The configured binding is durable across process restarts, whereas the
    // LivePaperMarketDataService claim is intentionally in-memory. BullMQ can
    // dispatch reconciliation before the scanner/parity module's onModuleInit
    // has restored that claim, so use the exact enabled binding as a bootstrap
    // fallback. This affects only closed-session heavy-sweep deferral; entry,
    // risk and protection pricing remain governed by fresh provider evidence.
    const vpsScannerEnabled =
      this.configService.get<boolean>('vpsForexScanner.enabled', false) === true;
    const vpsScannerConnectionId = this.configService
      .get<string>('vpsForexScanner.brokerConnectionId', '')
      .trim();
    if (vpsScannerEnabled && vpsScannerConnectionId === connectionId) return true;

    const brokerParityEnabled =
      this.configService.get<boolean>('brokerParityV7.enabled', false) === true;
    const brokerParityConnectionId = this.configService
      .get<string>('brokerParityV7.paperConnectionId', '')
      .trim();
    return brokerParityEnabled && brokerParityConnectionId === connectionId;
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

    let connectionsReconciled = 0;
    let providerQuotaDeferredConnections = 0;
    let suspendedDeferredConnections = 0;
    let marketSessionDeferredConnections = 0;
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
      const quotaCooldownUntil = this.stateReconciliation.getProviderQuotaCooldownUntil(
        connection.id,
      );
      const livePaperMarketClosed =
        connection.brokerId === 'paper-broker' &&
        this.isLivePaperConnection(connection.id) &&
        !isFxWeeklySessionOpen(new Date());
      const brokerSuspended = connection.status === BrokerConnectionStatus.SUSPENDED;
      if (brokerSuspended) {
        suspendedDeferredConnections++;
        this.logger.debug(
          `Deferring full reconciliation sweep for suspended connection ${connection.id}; ` +
            'broker health recovery owns reconnection while safety follow-ups remain active',
        );
      } else if (quotaCooldownUntil) {
        providerQuotaDeferredConnections++;
        this.logger.warn(
          `Deferring full reconciliation sweep for connection ${connection.id} ` +
            `until ${quotaCooldownUntil.toISOString()} because provider quota is cooling down`,
        );
      } else if (livePaperMarketClosed) {
        marketSessionDeferredConnections++;
        this.logger.debug(
          `Deferring full reconciliation sweep for live PAPER connection ${connection.id} ` +
            'while the FX weekly session is closed; safety follow-ups remain active',
        );
      } else {
        connectionsReconciled++;
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
      `Reconciliation cycle complete: ${connectionsReconciled} reconciled, ` +
        `${providerQuotaDeferredConnections} provider-quota deferred, ` +
        `${suspendedDeferredConnections} suspended deferred, ` +
        `${marketSessionDeferredConnections} market-session deferred, ` +
        `${discrepanciesDetected} detected (${discrepanciesNew} new), ` +
        `${discrepanciesAutoResolved} auto-resolved, ${discrepanciesOpen} open discrepancies, ` +
        `${failedConnections} failed; protective orders: ${protectiveOrdersChecked} ` +
        `checked, ${protectiveOrdersRepaired} repaired, ${protectiveRepairsFailed} ` +
        `repair failures`,
    );

    return {
      connectionsReconciled,
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
