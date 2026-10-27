import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BrokerConnection } from '../entities/broker-connection.entity';
import { BrokerService } from '../broker.service';
import { BrokerAdapterRegistry } from '../adapters/broker-adapter.registry';
import { AuditService } from '../../audit/audit.service';
import { AuditAction } from '../../../common/enums/audit-action.enum';
import { AuditSeverity } from '../../audit/entities/audit-log.entity';
import { redactSensitive } from '../../../common/utils/redact-sensitive.util';
import { BrokerMode } from '../interfaces/broker-adapter.interface';
import { withDemoValidationOrderReconciliation } from './demo-validation-order-reconciliation';
import {
  DEMO_VALIDATION_STEPS,
  ProviderVerificationStep,
  ProviderVerificationSummary,
  VerificationOverallStatus,
  runVerificationChecklist,
  sanitizeVerificationDetail,
} from '../verification/provider-verification-harness';

/**
 * BrokerDemoValidationService — the EVIDENCE-BASED write path for
 * BrokerConnection.demoValidated.
 *
 * External broker handshakes prove connectivity and credential validity only;
 * they do NOT set demoValidated. This service exercises the actual DEMO
 * trading surface and is the runtime authority for external DEMO validation:
 *   PASS → demoValidated: true + durable sanitized audit evidence;
 *   FAIL → demoValidated: false and, when automation authority exists,
 *          atomic authorization revocation so ACTIVE cannot survive failed
 *          evidence.
 *
 * The built-in paper simulator deliberately retains its historical
 * connect-time shortcut because it is an internal deterministic adapter and
 * has a separate PAPER_ONLY execution policy. Running this checklist against
 * paper still provides the same stronger step-by-step evidence and can revoke
 * a stale paper validation on failure.
 *
 * SECURITY INVARIANTS:
 * 1. Ownership-checked: the connection must belong to the requesting user.
 * 2. DEMO only: LIVE connections are rejected before provider interaction.
 * 3. Connection state transitions go through BrokerService.connectBroker; the
 *    checklist then exercises the connection-scoped adapter session.
 * 4. Credentials are decrypted only inside connectBroker and never persisted
 *    or returned in plaintext by this service.
 * 5. Evidence is sanitized and persisted in the audit trail; provider-order
 *    identifiers and safe diagnostic detail may be recorded, credentials may not.
 *
 * STORAGE: the connection keeps the compact demoValidated projection while the
 * full sanitized checklist result is durable in BROKER_DEMO_VALIDATION_PASSED /
 * BROKER_DEMO_VALIDATION_FAILED audit metadata and returned to the caller.
 */
@Injectable()
export class BrokerDemoValidationService {
  private readonly logger = new Logger(BrokerDemoValidationService.name);

  constructor(
    @InjectRepository(BrokerConnection)
    private readonly connectionRepo: Repository<BrokerConnection>,
    private readonly brokerService: BrokerService,
    private readonly adapterRegistry: BrokerAdapterRegistry,
    private readonly auditService: AuditService,
  ) {}

  /**
   * Validate a DEMO broker connection end-to-end.
   *
   * Checklist (runtime-capability-aware — steps whose surface the adapter
   * does not expose are SKIPPED with the honest reason; every executed step
   * must PASS):
   *   1. connect — BrokerService.connectBroker must reach CONNECTED
   *   2. account info — decimal-string sanity on balance/equity/margin/…
   *   3. market data — instrument catalog + current price (first instrument)
   *   4. positions snapshot — getOpenPositions must resolve
   *   5. small market order (2 × minLot, 0.01 fallback floor) → verify the
   *      position is open → partial close (minLot) → full close → the closed
   *      trade must appear in getClosedTrades. Providers that acknowledge a
   *      MARKET order as PENDING are reconciled for a short bounded window;
   *      only a provider-proven FILLED state may continue the checklist.
   *   6. pending limit order far from market (10% below the ask — stays
   *      working) → modify its SL/TP → cancel it (where the adapter exposes
   *      cancelOrder) → verify it is gone from listOrders
   *   7. getRequiredMargin sanity (string or null — null is acceptable and
   *      noted)
   *
   * Returns the SANITIZED step-by-step result plus the resulting
   * demoValidated boolean. A validation that fails never throws for step
   * failures — the user sees exactly which step failed and why.
   */
  async validateDemoConnection(
    connectionId: string,
    userId: string,
    ipAddress?: string,
  ): Promise<BrokerDemoValidationResult> {
    // Ownership + DEMO gate (fail-closed before any provider interaction).
    const connection = await this.brokerService.findConnectionById(connectionId, userId);
    if (connection.accountType !== BrokerMode.DEMO) {
      throw new BadRequestException(
        'Only DEMO connections can be validated. ' +
          'LIVE trading is enabled on a LIVE connection only after a DEMO connection ' +
          'for the same broker has passed validation.',
      );
    }

    // Step 1 — connect through the canonical state machine. External brokers
    // remain CONNECTED and unvalidated after this handshake; paper-broker keeps
    // its explicit simulator shortcut. Only the connection OUTCOME is recorded
    // as the checklist's first evidence step.
    let connectStep: ProviderVerificationStep;
    try {
      await this.brokerService.connectBroker(connectionId, userId, ipAddress);
      connectStep = {
        name: 'connect',
        status: 'PASS',
        detail: 'DEMO connection reached CONNECTED state',
      };
    } catch (err) {
      connectStep = {
        name: 'connect',
        status: 'FAIL',
        detail: sanitizeVerificationDetail(
          err instanceof Error ? err.message : 'connection failed',
        ),
      };
    }

    // Re-read the persisted flag AFTER the connect step. External brokers stay
    // false until checklist PASS; paper-broker may already be true from its
    // simulator shortcut. A failing re-validation revokes stale evidence in
    // either case, including when reconnect itself fails.
    let previousDemoValidated = connection.demoValidated ?? false;
    try {
      const postConnect = await this.brokerService.findConnectionById(connectionId, userId);
      previousDemoValidated = postConnect.demoValidated ?? false;
    } catch {
      // Deleted mid-run or storage hiccup — keep the pre-connect observation
      // (fail-closed for the decision, evidence still recorded).
    }

    // Steps 2–7 — the connection-scoped adapter context the registry resolves
    // IS the same instance connectBroker just connected (same
    // BrokerConnection.id → same session; the checklist's injected connect
    // step prevents a second adapter.connect()). #291 / correction round 3.
    //
    // Some real providers (notably cTrader) acknowledge a market order before
    // the asynchronous execution event arrives. The DEMO-only wrapper below
    // reconciles that transient PENDING state via getOrderById. It NEVER turns
    // PENDING into success: only provider-proven FILLED proceeds; rejection,
    // cancellation, expiry, unknown state or timeout remain validation FAILs.
    const adapter = withDemoValidationOrderReconciliation(
      this.adapterRegistry.getAdapterForConnection(
        connection.id,
        connection.brokerId,
      ),
    );
    const evidence = await runVerificationChecklist(adapter, {
      brokerId: connection.brokerId,
      mode: 'DEMO',
      steps: DEMO_VALIDATION_STEPS,
      connectStep,
      connectionId,
    });

    const demoValidated = evidence.overall === 'PASS';

    // PASS persists the evidence flag. FAIL is stronger: if the connection
    // currently carries automation authority, BrokerService atomically clears
    // the flag and revokes that authority so ACTIVE can never survive failed
    // evidence. Non-authorized rows are simply left false/cleared as needed.
    if (demoValidated) {
      if (!previousDemoValidated) {
        await this.connectionRepo.update(connectionId, { demoValidated: true });
      }
    } else {
      await this.brokerService.applyDemoValidationFailure(connectionId, userId);
    }

    await this.auditService.log({
      actorUserId: userId,
      action:
        evidence.overall === 'PASS'
          ? AuditAction.BROKER_DEMO_VALIDATION_PASSED
          : AuditAction.BROKER_DEMO_VALIDATION_FAILED,
      resourceType: 'BrokerConnection',
      resourceId: connectionId,
      ipAddress,
      metadata: redactSensitive({
        brokerId: connection.brokerId,
        accountType: connection.accountType,
        // Persisted value observed after connect: normally false for external
        // brokers; paper-broker may already carry its simulator shortcut.
        previousDemoValidated,
        demoValidated,
        overall: evidence.overall,
        summary: evidence.summary,
        // Sanitized checklist evidence (the full result — the audit trail is
        // the persisted home of the step-by-step proof; see storage decision).
        steps: evidence.steps.map((step) => ({
          name: step.name,
          status: step.status,
          ...(step.detail ? { detail: step.detail } : {}),
          ...(step.providerOrderId ? { providerOrderId: step.providerOrderId } : {}),
        })),
      }),
      severity: evidence.overall === 'PASS' ? AuditSeverity.INFO : AuditSeverity.WARNING,
    });

    this.logger.log(
      `DEMO validation ${evidence.overall} for connection=${connectionId} ` +
        `broker=${connection.brokerId} user=${userId} ` +
        `(passed=${evidence.summary.passed} failed=${evidence.summary.failed} ` +
        `skipped=${evidence.summary.skipped})`,
    );

    return {
      connectionId,
      brokerId: connection.brokerId,
      accountType: BrokerMode.DEMO,
      demoValidated,
      overall: evidence.overall,
      summary: evidence.summary,
      steps: evidence.steps,
      startedAt: evidence.startedAt,
      finishedAt: evidence.finishedAt,
    };
  }
}

/** Sanitized API response shape for POST /broker/connections/:id/validate-demo. */
export interface BrokerDemoValidationResult {
  connectionId: string;
  brokerId: string;
  accountType: BrokerMode.DEMO;
  /**
   * Evidence-consistent flag value (PASS ⇒ true, FAIL ⇒ false).
   */
  demoValidated: boolean;
  overall: VerificationOverallStatus;
  summary: ProviderVerificationSummary;
  steps: ProviderVerificationStep[];
  startedAt: string;
  finishedAt: string;
}
