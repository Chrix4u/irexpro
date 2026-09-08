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
 * BrokerConnection.demoValidated (Sprint 56 / Task 47-C5; re-integrated onto
 * new main as Task 48-D).
 *
 * RELATIONSHIP TO THE CONNECT AUTO-WRITE (new main): BrokerService.connectBroker
 * already dual-writes `demoValidated: true` when a DEMO connection reaches
 * CONNECTED — a WEAK connect-implies-validated proxy that unblocks the
 * enableLiveTrading gate for anything that can complete a handshake. This
 * service is the STRONGER, checklist-driven re-validation on top: it
 * exercises the adapter's actual trading surface, records per-step sanitized
 * evidence, and OVERRIDES the proxy when the evidence contradicts it:
 *   PASS  → demoValidated: true (idempotent when the auto-write already set
 *           it — the proxy and the evidence now agree; fresh evidence is
 *           recorded either way);
 *   FAIL  → demoValidated: false — the evidence-based revocation that catches
 *           dead/stale connections the connect auto-write blessed.
 *
 * SECURITY INVARIANTS:
 * 1. Ownership-checked: the connection must belong to the requesting user
 *    (NotFound for anyone else — same rule as every BrokerService method).
 * 2. DEMO only: LIVE connections are rejected (BadRequest) — LIVE trading is
 *    gated BEHIND a validated DEMO connection, never validated itself. The
 *    paper broker is allowed: its connections are DEMO by definition.
 * 3. Connection state transitions go through BrokerService.connectBroker
 *    (the canonical CONNECTING→CONNECTED machine with BrokerAccount upsert
 *    and BROKER_CONNECTED audit) — the checklist then exercises the adapter
 *    directly, exactly like BrokerService's market-data methods.
 * 4. Credentials are decrypted inside connectBroker only (memory-only, zeroed
 *    in its finally block); this service never touches plaintext credentials.
 * 5. Evidence is SANITIZED: step results carry statuses, provider order ids
 *    (non-secret by entity design), instrument symbols and sanitized details —
 *    never credentials (fragment redaction on every free-text detail + a final
 *    redactSensitive pass over the audit metadata).
 *
 * STORAGE DECISION (documented, no migrations): BrokerConnection has a
 * `demoValidated` boolean but NO column for the checklist result — and this
 * task deliberately ships NO schema change (the stack owns migrations). The
 * FULL sanitized checklist evidence therefore lives in TWO places only: the
 * API response (returned to the user so they can see exactly WHY a validation
 * failed) and the audit trail (BROKER_DEMO_VALIDATION_PASSED/_FAILED with the
 * step results in the audit log's metadata jsonb). Only the boolean persists
 * on the connection.
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
   *      trade must appear in getClosedTrades
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

    // Step 1 — connect through the canonical state machine. connectBroker
    // audits BROKER_CONNECTED/_CONNECT_FAILED itself and (new main)
    // auto-writes demoValidated: true on a successful DEMO connect; only its
    // OUTCOME is recorded in the validation evidence here.
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

    // Re-read the persisted flag AFTER the connect step: this is the value
    // the evidence-based decision is measured against. When connectBroker's
    // auto-write blessed it to true, a FAILING checklist must revoke that
    // bless — and a PASSING one simply confirms it (idempotent). When the
    // connect itself failed, this still reflects the last persisted value
    // (the ERROR path never touches demoValidated), so a previously
    // validated connection whose re-validation cannot even connect is
    // honestly revoked too.
    let previousDemoValidated = connection.demoValidated ?? false;
    try {
      const postConnect = await this.brokerService.findConnectionById(connectionId, userId);
      previousDemoValidated = postConnect.demoValidated ?? false;
    } catch {
      // Deleted mid-run or storage hiccup — keep the pre-connect observation
      // (fail-closed for the decision, evidence still recorded).
    }

    // Steps 2–7 — the adapter the registry resolved is the SAME instance
    // connectBroker just connected (the checklist's injected connect step
    // prevents a second adapter.connect()).
    const adapter = this.adapterRegistry.getAdapter(connection.brokerId);
    const evidence = await runVerificationChecklist(adapter, {
      brokerId: connection.brokerId,
      mode: 'DEMO',
      steps: DEMO_VALIDATION_STEPS,
      connectStep,
      connectionId,
    });

    const demoValidated = evidence.overall === 'PASS';

    // Persist ONLY the boolean (see the storage decision in the class docs).
    // Evidence-consistent write: PASS sets true (no-op when the connect
    // auto-write already set it); FAIL revokes any blessed/stale true.
    if (demoValidated !== previousDemoValidated) {
      await this.connectionRepo.update(connectionId, { demoValidated });
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
        // The persisted value observed after the connect step — i.e. the
        // value this run confirms (PASS) or overrides (FAIL). Includes the
        // connect auto-write when it fired.
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
   * The evidence-consistent flag value (PASS ⇒ true, FAIL ⇒ false — a FAIL
   * revokes any connect-time auto-bless, see the class docs).
   */
  demoValidated: boolean;
  overall: VerificationOverallStatus;
  summary: ProviderVerificationSummary;
  steps: ProviderVerificationStep[];
  startedAt: string;
  finishedAt: string;
}
