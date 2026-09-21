import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'crypto';
import { Repository } from 'typeorm';
import { BrokerConnection } from '../entities/broker-connection.entity';
import { BrokerService } from '../broker.service';
import { BrokerAdapterRegistry } from '../adapters/broker-adapter.registry';
import { AuditService } from '../../audit/audit.service';
import { AuditAction } from '../../../common/enums/audit-action.enum';
import { AuditSeverity } from '../../audit/entities/audit-log.entity';
import { redactSensitive } from '../../../common/utils/redact-sensitive.util';
import { BrokerMode, IBrokerAdapter } from '../interfaces/broker-adapter.interface';
import {
  DEMO_VALIDATION_STEPS,
  ProviderVerificationStep,
  ProviderVerificationSummary,
  VerificationOverallStatus,
  runVerificationChecklist,
  sanitizeVerificationDetail,
} from '../verification/provider-verification-harness';

// ─── DEMO evidence-record semantics (reconciliation round, Section 5) ─────────

/**
 * Evidence-record schema version. Bump when the record shape changes in a
 * way auditors must distinguish; v1 is the first structured record.
 */
export const DEMO_EVIDENCE_RECORD_VERSION = 1;

/**
 * A DEMO validation is a POINT-IN-TIME observation of the provider's DEMO
 * trading surface. The record carries the expiry truth explicitly: after
 * VALIDITY_DAYS the observation is stale and revalidation is expected.
 * Informational semantics only — this does NOT auto-revoke the persisted
 * demoValidated boolean and does NOT convert to LIVE certification.
 */
export const DEMO_VALIDATION_VALIDITY_DAYS = 180;

/** Revalidation is recommended this many days BEFORE validity expires. */
export const DEMO_VALIDATION_REVALIDATION_LEAD_DAYS = 30;

/** PASS step name → verified capability (the honest lifecycle truth). */
const STEP_TO_CAPABILITY: Readonly<Record<string, string>> = Object.freeze({
  connect: 'CONNECT',
  'account-info': 'ACCOUNT_INFO_READ',
  'market-data': 'MARKET_DATA_READ',
  'positions-snapshot': 'POSITIONS_SNAPSHOT_READ',
  'market-order': 'MARKET_ORDER_FILL',
  'position-verify': 'POSITION_VERIFY',
  'partial-close': 'PARTIAL_CLOSE',
  'full-close': 'FULL_CLOSE',
  'trade-history': 'TRADE_HISTORY_READ',
  'pending-limit-order': 'PENDING_ORDER_PLACE',
  'pending-modify': 'PENDING_ORDER_MODIFY',
  'pending-cancel': 'PENDING_ORDER_CANCEL',
  'order-history': 'ORDER_HISTORY_READ',
  'margin-info': 'MARGIN_QUERY',
});

/**
 * Deterministic canonical JSON (sorted object keys, no whitespace) — the
 * digest input. Sorting makes the digest stable across property-ordering
 * changes and JS engine insertion-order differences.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/** SHA-256 digest of the canonical record (hex, lowercase). */
function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Sanitized DEMO-validation evidence record (reconciliation round, Section 5).
 *
 * EVIDENCE CLASS: this is DEMO-environment evidence ONLY. It is NEVER a
 * provider LIVE certification and never becomes one automatically — LIVE
 * certification is a separate operator-run evidence class (see
 * docs/brokers/live-certification-runbook.md).
 *
 * No credentials by construction: every field is either an enum/id/timestamp
 * or already-sanitized checklist output (the harness redacts free text).
 */
export interface DemoValidationEvidenceRecord {
  /** Record schema version (see DEMO_EVIDENCE_RECORD_VERSION). */
  evidenceVersion: number;
  /** Provider registry id (brokerId). */
  provider: string;
  /** The validated BrokerConnection id. */
  connectionId: string;
  /** Always 'DEMO' — the service rejects LIVE connections before any run. */
  environment: BrokerMode.DEMO;
  /** ISO timestamp of the observation (the checklist finish time). */
  validatedAt: string;
  /** Who produced the record: the system service on behalf of the owner. */
  source: 'system';
  /** Adapter implementation version (null when the adapter declares none). */
  adapterVersion: string | null;
  /** Provider-observed account truth (never user-declared input). */
  account: {
    providerAccountId: string | null;
    currency: string | null;
    /** 'PROVIDER_OBSERVED' when the post-checklist account read succeeded. */
    accountTruth: 'PROVIDER_OBSERVED' | 'UNAVAILABLE';
    /** Sanitized reason when the account read failed. */
    reason?: string;
  };
  /** The sanitized checklist steps (unchanged from the harness output). */
  checks: ProviderVerificationStep[];
  summary: ProviderVerificationSummary;
  /** Capabilities actually VERIFIED by PASS steps (SKIPPED/FAILED ⇒ absent). */
  capabilitiesVerified: string[];
  /** Post-checklist observation that the validation's own orders/positions
   * are closed/cancelled — the run's order-lifecycle reconciliation. */
  orderLifecycleReconciliation: {
    openPositionCount: number | null;
    workingOrderCount: number | null;
    /** True when no validation artifact remains open/working. */
    reconciled: boolean | null;
    /** Sanitized reason when the observation is unavailable/moot. */
    reason?: string;
  };
  overall: VerificationOverallStatus;
  /** The evidence-consistent boolean persisted on the connection. */
  demoValidated: boolean;
  /** ISO timestamp after which the observation is stale. */
  validUntil: string;
  /** ISO timestamp after which revalidation is recommended. */
  revalidationRecommendedAfter: string;
  /** SHA-256 over the canonical record (this field excluded) — tamper
   * evidence for the audit-trail copy. */
  evidenceSha256: string;
}

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

    // Steps 2–7 — the connection-scoped adapter context the registry resolves
    // IS the same instance connectBroker just connected (same
    // BrokerConnection.id → same session; the checklist's injected connect
    // step prevents a second adapter.connect()). #291 / correction round 3.
    const adapter = this.adapterRegistry.getAdapterForConnection(
      connection.id,
      connection.brokerId,
    );
    const evidence = await runVerificationChecklist(adapter, {
      brokerId: connection.brokerId,
      mode: 'DEMO',
      steps: DEMO_VALIDATION_STEPS,
      connectStep,
      connectionId,
    });

    const demoValidated = evidence.overall === 'PASS';

    // ── DEMO evidence record (reconciliation round, Section 5) ──────────────
    // Provider-observed account truth + order-lifecycle reconciliation, both
    // read AFTER the checklist on the already-connected adapter (one account
    // read + one positions/orders read). Observation failures degrade the
    // record honestly (null + reason) and never affect the decision path.
    const evidenceRecord = await this.buildEvidenceRecord(adapter, connection, evidence, {
      demoValidated,
    });

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
        // Structured DEMO evidence record (reconciliation round, Section 5):
        // the audit trail is its persisted home. DEMO evidence ONLY — never
        // a LIVE certification (separate operator evidence class).
        evidenceRecord,
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
      evidenceRecord,
    };
  }

  /**
   * Builds the sanitized DEMO evidence record (reconciliation round,
   * Section 5). Observation reads (account truth, order-lifecycle
   * reconciliation) happen on the already-connected adapter AFTER the
   * checklist; every failure degrades the corresponding field honestly
   * (null + sanitized reason) and never affects the validation decision.
   */
  private async buildEvidenceRecord(
    adapter: IBrokerAdapter & { adapterVersion?: unknown },
    connection: BrokerConnection,
    evidence: ProviderVerificationEvidenceLike,
    decision: { demoValidated: boolean },
  ): Promise<DemoValidationEvidenceRecord> {
    // Adapter version — a plain public constant the newer adapters declare;
    // honestly null for adapters that predate the surface.
    const rawVersion = adapter.adapterVersion;
    const adapterVersion =
      typeof rawVersion === 'string' && rawVersion.length > 0 ? rawVersion : null;

    // Provider-observed account truth (one read; never user-declared input).
    let account: DemoValidationEvidenceRecord['account'] = {
      providerAccountId: null,
      currency: null,
      accountTruth: 'UNAVAILABLE',
    };
    try {
      const info = await adapter.getAccountInfo();
      const accountId =
        typeof info.accountId === 'string' && info.accountId.length > 0 ? info.accountId : null;
      const currency =
        typeof info.currency === 'string' && info.currency.length > 0 ? info.currency : null;
      account =
        accountId !== null || currency !== null
          ? { providerAccountId: accountId, currency, accountTruth: 'PROVIDER_OBSERVED' }
          : { ...account, reason: 'account read returned no identifiable fields' };
    } catch (err) {
      account = {
        ...account,
        reason: sanitizeVerificationDetail(
          err instanceof Error ? err.message : 'account read failed',
        ),
      };
    }

    // Order-lifecycle reconciliation: the validation's own artifacts (the
    // market-order position and the pending limit order) must all be gone —
    // closed/cancelled — for the run to be reconciled. Provider order ids are
    // non-secret by entity design. When the run produced NO artifacts (early
    // failure cascade), the question is moot: no provider reads are made and
    // the record says so honestly.
    const artifactIds = new Set(
      evidence.steps
        .map((step) => step.providerOrderId)
        .filter((id): id is string => typeof id === 'string' && id.length > 0),
    );
    let reconciliation: DemoValidationEvidenceRecord['orderLifecycleReconciliation'] = {
      openPositionCount: null,
      workingOrderCount: null,
      reconciled: null,
    };
    if (artifactIds.size === 0) {
      reconciliation = {
        openPositionCount: null,
        workingOrderCount: null,
        reconciled: null,
        reason: 'NO_VALIDATION_ARTIFACTS_PRODUCED',
      };
    } else {
      try {
        const [positions, orders] = await Promise.all([
          adapter.getOpenPositions(),
          adapter.listOrders(),
        ]);
        const workingOrders = orders.filter((o) => o.status === 'WORKING');
        const openPositionIds = new Set(positions.map((p) => String(p.externalOrderId)));
        const workingOrderIds = new Set(workingOrders.map((o) => String(o.providerOrderId)));
        const artifactsRemaining = [...artifactIds].filter(
          (id) => openPositionIds.has(id) || workingOrderIds.has(id),
        );
        reconciliation = {
          openPositionCount: positions.length,
          workingOrderCount: workingOrders.length,
          reconciled: artifactsRemaining.length === 0,
        };
      } catch (err) {
        reconciliation = {
          ...reconciliation,
          reason: sanitizeVerificationDetail(
            err instanceof Error ? err.message : 'positions/orders read failed',
          ),
        };
      }
    }

    // Capabilities VERIFIED = PASS steps only (SKIPPED/FAILED never listed).
    const capabilitiesVerified = evidence.steps
      .filter((step) => step.status === 'PASS')
      .map((step) => STEP_TO_CAPABILITY[step.name])
      .filter((capability): capability is string => typeof capability === 'string');

    const validatedAt = evidence.finishedAt;
    const validUntil = addIsoDays(validatedAt, DEMO_VALIDATION_VALIDITY_DAYS);
    const revalidationRecommendedAfter = addIsoDays(
      validUntil,
      -DEMO_VALIDATION_REVALIDATION_LEAD_DAYS,
    );

    // Digest over the canonical record (digest field excluded) — tamper
    // evidence for the audit-trail copy.
    const record: Omit<DemoValidationEvidenceRecord, 'evidenceSha256'> = {
      evidenceVersion: DEMO_EVIDENCE_RECORD_VERSION,
      provider: connection.brokerId,
      connectionId: connection.id,
      environment: BrokerMode.DEMO,
      validatedAt,
      source: 'system',
      adapterVersion,
      account,
      checks: evidence.steps,
      summary: evidence.summary,
      capabilitiesVerified,
      orderLifecycleReconciliation: reconciliation,
      overall: evidence.overall,
      demoValidated: decision.demoValidated,
      validUntil,
      revalidationRecommendedAfter,
    };
    return { ...record, evidenceSha256: sha256Hex(canonicalJson(record)) };
  }
}

/** Provider-verification evidence shape the record builder consumes. */
type ProviderVerificationEvidenceLike = {
  brokerId: string;
  steps: ProviderVerificationStep[];
  summary: ProviderVerificationSummary;
  overall: VerificationOverallStatus;
  finishedAt: string;
};

/** Adds (or subtracts, for negative deltas) whole days to an ISO timestamp. */
function addIsoDays(iso: string, days: number): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid ISO timestamp for evidence record: ${iso}`);
  }
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
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
  /**
   * Structured DEMO evidence record (reconciliation round, Section 5):
   * provider, environment, adapter version, account truth, verified
   * capabilities, order-lifecycle reconciliation, expiry semantics and a
   * SHA-256 digest. DEMO evidence ONLY — never a LIVE certification.
   */
  evidenceRecord: DemoValidationEvidenceRecord;
}
