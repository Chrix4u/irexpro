import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RiskGrant } from '../execution/entities/risk-grant.entity';
import { ExecutionConfirmation } from '../execution/entities/execution-confirmation.entity';
import {
  AuthoritativeOrderPayload,
  ExecutionConfirmationStatus,
  ExecutionMode,
  RiskGrantStatus,
} from '../execution/interfaces/execution-authority';
import { isUniqueViolation } from '../broker/utils/db-unique-violation';
import type { RiskGrantConsumeResult } from '../execution/orchestration/risk-grant-consumer';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../../common/enums/audit-action.enum';

/**
 * RISK_GRANT_TTL_MS — the short validity window of an issued RiskGrant
 * (architect issue #301). Approvals are point-in-time decisions over fresh
 * account/authority state; 60 seconds is the deliberate ceiling before the
 * dispatch boundary must re-derive everything. consumeGrantAtomic() enforces
 * expiry with an affected-rows CAS — an expired ACTIVE row is never
 * consumable and is reported as such.
 */
export const RISK_GRANT_TTL_MS = 60_000;

/**
 * EXECUTION_CONFIRMATION_WINDOW_MS — the SEMI_AUTO user-confirmation window
 * (architect issue #298), measured FROM the grant's expiry: the confirmation
 * outlives its grant by this constant so the UI confirmation flow never
 * races the grant TTL (5 minutes vs 60 seconds by design).
 */
export const EXECUTION_CONFIRMATION_WINDOW_MS = 300_000;

/** Everything RiskService binds into a durable RiskGrant at issuance. */
export interface RiskGrantIssuanceInput {
  userId: string;
  signalId: string;
  /** SHA-256 canonical digest of the ProposedTrade material fields. */
  signalPayloadDigest: string;
  sessionId: string;
  /** Session authority generation observed at issuance. */
  sessionGeneration: number;
  executionMode: ExecutionMode;
  /** EXACT broker connection the grant authorizes — never substituted. */
  brokerConnectionId: string;
  providerBrokerIdentity: string | null;
  providerVerificationFingerprint: string | null;
  riskProfileId: string | null;
  riskProfileVersion: number | null;
  riskProfileHash: string | null;
  /** User trading-authority generation observed at issuance (issue #300). */
  authorityGeneration: number;
  killSwitchGeneration: number | null;
  executionControlRevision: number | null;
  /**
   * BrokerConnection.credentialGeneration observed at issuance (#361 fencing):
   * any credential rotation between approval and dispatch blocks NEW exposure
   * at the final boundary when this is bound. Null = not observed.
   */
  credentialGeneration: number | null;
  /** SHA-256 canonical digest of the EXACT validated order payload. */
  orderPayloadDigest: string;
  /** The exact validated order payload (immutable after issuance). */
  orderPayload: AuthoritativeOrderPayload;
  /** Quote reference observed for MARKET geometry, when one was used. */
  quoteRef: Record<string, unknown> | null;
  issuedAt: Date;
}

export interface RiskGrantIssuanceResult {
  grant: RiskGrant;
  /** true when an equivalent ACTIVE grant already existed and was reused. */
  reused: boolean;
}

/** Issuance could not converge on a single durable ACTIVE grant. */
export class RiskGrantIssuanceConflictError extends Error {
  constructor(signalId: string, detail: string) {
    super(`RiskGrant issuance conflict for signal ${signalId}: ${detail}`);
    this.name = 'RiskGrantIssuanceConflictError';
  }
}

/**
 * RiskGrantService — durable RiskGrant issuance + lifecycle (issue #301).
 *
 * OWNERSHIP: RiskService is the ONLY issuer of grants; other services
 * (execution-side authority gates) consume/invalidate them through the CAS
 * methods below. Grants are IMMUTABLE after issuance — the only permitted
 * writes are lifecycle status transitions (consume / invalidate), each
 * guarded by an affected-rows compare-and-set so concurrent callers have
 * exactly one winner.
 *
 * ONE-ACTIVE-GRANT-PER-SIGNAL (partial unique uq_risk_grants_one_active_per_signal):
 *  - an ACTIVE grant with the SAME digests + binding → reused idempotently
 *    (same grantId returned; no second row);
 *  - an ACTIVE grant with DIFFERENT digests/binding → the stale row is
 *    CAS-invalidated (reason SUPERSEDED_BY_REVALIDATION) and a fresh grant
 *    is issued. CHOSEN POLICY (documented per the task): invalidate + reissue
 *    rather than reject-as-conflict, because a re-validated signal (e.g. a
 *    lot-size cap change) is the newest authoritative risk decision and the
 *    old approval must never survive it;
 *  - a concurrent INSERT losing the unique race reloads the winner and
 *    applies the same reuse/supersede logic (bounded retries).
 *
 * SEMI_AUTO: every fresh issuance ALSO creates the PENDING
 * ExecutionConfirmation bound to the grant + exact order so the execution
 * side can require its one-time consumption. FULL_AUTO / PAPER_ONLY create
 * no confirmation row.
 */
@Injectable()
export class RiskGrantService {
  private readonly logger = new Logger(RiskGrantService.name);

  constructor(
    @InjectRepository(RiskGrant)
    private readonly grantRepo: Repository<RiskGrant>,
    @InjectRepository(ExecutionConfirmation)
    private readonly confirmationRepo: Repository<ExecutionConfirmation>,
    private readonly auditService: AuditService,
  ) {}

  /**
   * Issue (or idempotently reuse) the durable ACTIVE grant for a signal.
   * Throws on any failure — the caller MUST NOT approve without a durable
   * grant (fail closed).
   */
  async issueGrant(input: RiskGrantIssuanceInput): Promise<RiskGrantIssuanceResult> {
    const expiresAt = new Date(input.issuedAt.getTime() + RISK_GRANT_TTL_MS);

    // Bounded convergence loop: each iteration either reuses, supersedes, or
    // inserts; a lost unique-race reloads the winner and tries once more.
    for (let attempt = 0; attempt < 3; attempt++) {
      const existing = await this.findActiveGrantForSignal(input.signalId);
      if (existing) {
        if (this.isSameIssuance(existing, input)) {
          return { grant: existing, reused: true };
        }
        // Different digests/binding: the re-validation is authoritative.
        await this.casInvalidateGrant(existing.id, 'SUPERSEDED_BY_REVALIDATION');
        continue;
      }

      try {
        const grant = await this.grantRepo.save(
          this.grantRepo.create({
            userId: input.userId,
            signalId: input.signalId,
            signalPayloadDigest: input.signalPayloadDigest,
            sessionId: input.sessionId,
            sessionGeneration: input.sessionGeneration,
            executionMode: input.executionMode,
            brokerConnectionId: input.brokerConnectionId,
            providerBrokerIdentity: input.providerBrokerIdentity,
            providerVerificationFingerprint: input.providerVerificationFingerprint,
            riskProfileId: input.riskProfileId,
            riskProfileVersion: input.riskProfileVersion,
            riskProfileHash: input.riskProfileHash,
            // Round 5: account snapshot infra is wired by another agent; the
            // columns exist and stay null until that lands.
            accountSnapshotId: null,
            accountSnapshotGeneration: null,
            accountSnapshotObservedAt: null,
            authorityGeneration: input.authorityGeneration,
            killSwitchGeneration: input.killSwitchGeneration,
            executionControlRevision: input.executionControlRevision,
            credentialGeneration: input.credentialGeneration,
            orderPayloadDigest: input.orderPayloadDigest,
            orderPayload: input.orderPayload,
            quoteRef: input.quoteRef,
            issuedAt: input.issuedAt,
            expiresAt,
            consumedAt: null,
            invalidatedAt: null,
            invalidationReason: null,
            status: RiskGrantStatus.ACTIVE,
          }),
        );

        if (input.executionMode === ExecutionMode.SEMI_AUTO) {
          await this.createPendingConfirmation(grant, input);
        }

        await this.auditIssuance(grant, false);
        return { grant, reused: false };
      } catch (err) {
        if (isUniqueViolation(err)) {
          // A concurrent issuance won the one-ACTIVE-per-signal slot.
          // Reload the winner and converge on the next loop iteration.
          this.logger.warn(
            `Concurrent RiskGrant issuance for signal ${input.signalId} — reloading the winner`,
          );
          continue;
        }
        throw err;
      }
    }

    throw new RiskGrantIssuanceConflictError(
      input.signalId,
      'could not converge on a single ACTIVE grant after concurrent issuance attempts',
    );
  }

  /**
   * Consume a grant atomically (single-use for NEW exposure).
   *
   * CAS: the row transitions ACTIVE → CONSUMED only while it is still ACTIVE
   * AND unexpired. Exactly one concurrent caller wins (affected-rows check);
   * every loser gets a TYPED reason — never a guessed status. The return
   * shape satisfies the execution module's RiskGrantConsumerPort contract
   * (RISK_GRANT_CONSUMER seam, task 50-c) so the final dispatch boundary can
   * alias this service directly.
   */
  async consumeGrantAtomic(grantId: string): Promise<RiskGrantConsumeResult> {
    const result = await this.grantRepo
      .createQueryBuilder()
      .update()
      .set({ status: RiskGrantStatus.CONSUMED, consumedAt: new Date() })
      .where('id = :id AND status = :active AND expires_at > :now', {
        id: grantId,
        active: RiskGrantStatus.ACTIVE,
        now: new Date(),
      })
      .execute();
    const affected = result.affected ?? 0;

    if (affected > 0) {
      this.logger.log(`RiskGrant ${grantId} CONSUMED (single-winner CAS)`);
      const grant = await this.grantRepo.findOne({ where: { id: grantId } });
      return { consumed: true, grant: grant ?? null };
    }

    // Lost the CAS — reload and classify the failure (typed, never guessed).
    const grant = await this.grantRepo.findOne({ where: { id: grantId } });
    if (!grant) return { consumed: false, reason: 'NOT_FOUND', grant: null };
    if (grant.status === RiskGrantStatus.CONSUMED) {
      return { consumed: false, reason: 'ALREADY_CONSUMED', grant };
    }
    if (grant.status === RiskGrantStatus.INVALIDATED) {
      return { consumed: false, reason: 'INVALIDATED', grant };
    }
    if (grant.status === RiskGrantStatus.EXPIRED || grant.expiresAt.getTime() <= Date.now()) {
      return { consumed: false, reason: 'EXPIRED', grant };
    }
    // Row was ACTIVE+unexpired at reload but the CAS lost — a concurrent
    // consumer won between the UPDATE and this read.
    return { consumed: false, reason: 'CAS_RACE_LOST', grant };
  }

  /**
   * Invalidate every still-ACTIVE grant bound to a session (authority
   * change, mode change, suspension, end). CAS on status = ACTIVE only —
   * terminal rows (CONSUMED/EXPIRED/INVALIDATED) are never rewritten.
   * Returns the number of grants actually invalidated.
   */
  async invalidateGrantsForSession(sessionId: string, reason: string): Promise<number> {
    const result = await this.grantRepo
      .createQueryBuilder()
      .update()
      .set({
        status: RiskGrantStatus.INVALIDATED,
        invalidatedAt: new Date(),
        invalidationReason: reason.slice(0, 200),
      })
      .where('session_id = :sessionId AND status = :active', {
        sessionId,
        active: RiskGrantStatus.ACTIVE,
      })
      .execute();
    const affected = result.affected ?? 0;
    if (affected > 0) {
      this.logger.warn(
        `Invalidated ${affected} ACTIVE RiskGrant(s) for session ${sessionId} — ${reason}`,
      );
    }
    return affected;
  }

  /** Revoke outstanding PENDING confirmations for a session (CAS on status). */
  async revokeConfirmationsForSession(sessionId: string): Promise<number> {
    const result = await this.confirmationRepo
      .createQueryBuilder()
      .update()
      .set({ status: ExecutionConfirmationStatus.REVOKED, revokedAt: new Date() })
      .where('session_id = :sessionId AND status = :pending', {
        sessionId,
        pending: ExecutionConfirmationStatus.PENDING,
      })
      .execute();
    return result.affected ?? 0;
  }

  // ─── Internal helpers ─────────────────────────────────────────────────────

  private async findActiveGrantForSignal(signalId: string): Promise<RiskGrant | null> {
    return this.grantRepo.findOne({ where: { signalId, status: RiskGrantStatus.ACTIVE } });
  }

  /**
   * Sameness = identical signal payload digest, order payload digest and
   * authority binding. A generation/mode/connection change is a DIFFERENT
   * authority state even when the order bytes match.
   */
  private isSameIssuance(existing: RiskGrant, input: RiskGrantIssuanceInput): boolean {
    return (
      existing.signalPayloadDigest === input.signalPayloadDigest &&
      existing.orderPayloadDigest === input.orderPayloadDigest &&
      existing.sessionGeneration === input.sessionGeneration &&
      existing.executionMode === input.executionMode &&
      existing.brokerConnectionId === input.brokerConnectionId
    );
  }

  /** CAS single-writer invalidation of one grant (only while still ACTIVE). */
  private async casInvalidateGrant(grantId: string, reason: string): Promise<void> {
    await this.grantRepo
      .createQueryBuilder()
      .update()
      .set({
        status: RiskGrantStatus.INVALIDATED,
        invalidatedAt: new Date(),
        invalidationReason: reason.slice(0, 200),
      })
      .where('id = :id AND status = :active', { id: grantId, active: RiskGrantStatus.ACTIVE })
      .execute();
  }

  /**
   * SEMI_AUTO confirmation row, bound to the grant + EXACT order. The
   * one-PENDING-per-signal partial unique index arbitrates concurrent
   * creation; a unique violation means an equivalent PENDING row already
   * exists — swallowed deliberately (idempotent creation).
   */
  private async createPendingConfirmation(
    grant: RiskGrant,
    input: RiskGrantIssuanceInput,
  ): Promise<void> {
    const expiresAt = new Date(grant.expiresAt.getTime() + EXECUTION_CONFIRMATION_WINDOW_MS);
    try {
      await this.confirmationRepo.save(
        this.confirmationRepo.create({
          userId: input.userId,
          sessionId: grant.sessionId,
          sessionGeneration: grant.sessionGeneration,
          signalId: grant.signalId,
          brokerConnectionId: grant.brokerConnectionId,
          riskGrantId: grant.id,
          orderPayloadDigest: grant.orderPayloadDigest,
          instrument: input.orderPayload.instrument,
          direction: input.orderPayload.direction,
          quantity: input.orderPayload.quantity,
          stopLoss: input.orderPayload.stopLoss ?? null,
          takeProfit: input.orderPayload.takeProfit ?? null,
          expiresAt,
          consumedAt: null,
          revokedAt: null,
          status: ExecutionConfirmationStatus.PENDING,
        }),
      );
    } catch (err) {
      if (isUniqueViolation(err)) {
        this.logger.warn(
          `PENDING confirmation already exists for signal ${grant.signalId} — keeping the original`,
        );
        return;
      }
      throw err;
    }
  }

  private async auditIssuance(grant: RiskGrant, reused: boolean): Promise<void> {
    try {
      await this.auditService.log({
        actorUserId: grant.userId,
        action: AuditAction.RISK_GRANT_ISSUED,
        resourceType: 'RiskGrant',
        resourceId: grant.id,
        metadata: {
          signalId: grant.signalId,
          sessionId: grant.sessionId,
          sessionGeneration: grant.sessionGeneration,
          executionMode: grant.executionMode,
          brokerConnectionId: grant.brokerConnectionId,
          authorityGeneration: grant.authorityGeneration,
          orderPayloadDigest: grant.orderPayloadDigest,
          signalPayloadDigest: grant.signalPayloadDigest,
          expiresAt: grant.expiresAt,
          reused,
        },
      });
    } catch (err) {
      // Audit failure must not un-issue a durable grant — the row is the truth.
      this.logger.error(`RiskGrant audit log failed: ${(err as Error).message}`);
    }
  }
}
