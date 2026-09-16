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
  digestCanonicalPayload,
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
  /**
   * Round 6 (#297/#312): the DURABLE accepted account snapshot the decision
   * was derived from. NON-NULL for LIVE NEW-exposure (RiskService Step 2-live
   * resolves a fresh exact-connection snapshot before issuance). Null only on
   * paths that genuinely derive from non-financial state (PAPER/DEMO
   * projections) — never fabricated.
   */
  accountSnapshotId: string | null;
  accountSnapshotGeneration: number | null;
  accountSnapshotObservedAt: Date | null;
  /** User trading-authority generation observed at issuance (issue #300). */
  authorityGeneration: number;
  /** Round 6 (#299/#15): monotonic risk-profile revision (kill-switch gen). */
  killSwitchGeneration: number | null;
  executionControlRevision: number | null;
  /**
   * Round 6 (#363): shared cross-replica control-plane revisions observed at
   * issuance — the final dispatch boundary re-reads and compares them, so a
   * stale replica can never execute a grant minted against newer policy.
   */
  tradingPolicyRevision: number | null;
  providerVerificationRevision: number | null;
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
  /**
   * Round 7 (SEMI_AUTO confirm-path P0 fix): when the fresh issuance is
   * driven by the user CONFIRMING an existing PENDING confirmation
   * (ExecutionConfirmationService.confirm → §18 fresh re-evaluation), the
   * EXISTING PENDING confirmation is RE-BOUND to the fresh grant instead of
   * being revoked + re-created. Without this, every confirm() superseded the
   * in-flight confirmation (fresh quoteRef ⇒ different authority digest ⇒
   * SUPERSEDED_BY_REVALIDATION + revoke) and the commitment CAS could then
   * NEVER match (CONFIRMATION_REVOKED / DIGEST_MISMATCH) — SEMI_AUTO
   * dispatch was structurally impossible. Only the confirm() path sets this;
   * every other supersession keeps the revoke semantics.
   */
  rebindConfirmationId?: string;
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
 * Round 7 (SEMI_AUTO confirm-path P0 fix): the PENDING confirmation to
 * re-bind to the fresh grant was not re-bindable (consumed / revoked /
 * expired / not PENDING for this user+signal concurrently). Fail-closed —
 * the confirm() call aborts with ZERO provider calls.
 */
export class PendingConfirmationRebindError extends Error {
  constructor(
    readonly confirmationId: string,
    readonly signalId: string,
    detail: string,
  ) {
    super(
      `PENDING confirmation ${confirmationId} (signal ${signalId}) could not be ` +
        `re-bound to the fresh grant: ${detail}`,
    );
    this.name = 'PendingConfirmationRebindError';
  }
}

/**
 * Round 6 (#301): the CANONICAL authority binding digest.
 *
 * Canonical object → canonical JSON → SHA-256 over ALL safety-relevant
 * authority inputs of an issuance. Two grants are "the same issuance" ONLY if
 * every authority fact matches — a hand-written five-field equality check
 * would drift as facts are added. The individual fields stay persisted for
 * audit/queryability; THIS digest is the sameness authority.
 */
export async function computeAuthorityBindingDigest(
  input: RiskGrantIssuanceInput,
): Promise<string> {
  return digestCanonicalPayload({
    // Canonical schema version — bump when the authority fact set changes so
    // old and new bindings never compare equal by accident.
    v: 1,
    userId: input.userId,
    signalId: input.signalId,
    signalPayloadDigest: input.signalPayloadDigest,
    orderPayloadDigest: input.orderPayloadDigest,
    sessionId: input.sessionId,
    sessionGeneration: input.sessionGeneration,
    executionMode: input.executionMode,
    brokerConnectionId: input.brokerConnectionId,
    providerBrokerIdentity: input.providerBrokerIdentity,
    providerVerificationFingerprint: input.providerVerificationFingerprint,
    riskProfileId: input.riskProfileId,
    riskProfileVersion: input.riskProfileVersion,
    riskProfileHash: input.riskProfileHash,
    accountSnapshotId: input.accountSnapshotId,
    accountSnapshotGeneration: input.accountSnapshotGeneration,
    authorityGeneration: input.authorityGeneration,
    killSwitchGeneration: input.killSwitchGeneration,
    executionControlRevision: input.executionControlRevision,
    tradingPolicyRevision: input.tradingPolicyRevision,
    providerVerificationRevision: input.providerVerificationRevision,
    credentialGeneration: input.credentialGeneration,
    quoteRef: input.quoteRef ?? null,
  });
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
 * Round 6 (#364 — TENANT ISOLATION): every lookup, supersession, consumption
 * and invalidation of grants/confirmations is scoped by (user_id, signal_id).
 * The partial unique indexes are tenant-scoped
 * (uq_risk_grants_one_active_per_signal on (user_id, signal_id) WHERE ACTIVE;
 * uq_execution_confirmations_one_pending_per_signal on (user_id, signal_id)
 * WHERE PENDING) — two users may hold the SAME signalId independently and
 * neither can discover, supersede, consume or block the other's authority.
 *
 * ONE-ACTIVE-GRANT-PER-(USER,SIGNAL):
 *  - an ACTIVE grant with the SAME authority binding digest → reused
 *    idempotently (same grantId returned; no second row);
 *  - an ACTIVE grant with a DIFFERENT binding → the stale row is
 *    CAS-invalidated (SUPERSEDED_BY_REVALIDATION), its PENDING confirmation
 *    is REVOKED (never left occupying the tenant slot), and a fresh grant is
 *    issued (SEMI_AUTO: exactly one NEW confirmation bound to the NEW grant);
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
    const authorityBindingDigest = await computeAuthorityBindingDigest(input);

    // Bounded convergence loop: each iteration either reuses, supersedes, or
    // inserts; a lost unique-race reloads the winner and tries once more.
    for (let attempt = 0; attempt < 3; attempt++) {
      const existing = await this.findActiveGrantForSignal(input.userId, input.signalId);
      if (existing) {
        if (
          existing.authorityBindingDigest !== null &&
          existing.authorityBindingDigest === authorityBindingDigest
        ) {
          // Round 7 (SEMI_AUTO confirm-path): an identical binding reused —
          // defensively re-point the PENDING confirmation at the reused grant
          // (idempotent when already bound; a consumed/revoked confirmation
          // is a typed fail-closed abort).
          if (input.rebindConfirmationId) {
            await this.rebindPendingConfirmation(
              input.rebindConfirmationId,
              existing,
              input.userId,
              input.signalId,
            );
          }
          return { grant: existing, reused: true };
        }
        // Round 6 (#301/#364): different authority binding — the
        // re-validation is authoritative. Supersede TENANT-SCOPED: invalidate
        // the old grant AND revoke any PENDING confirmation still bound to it
        // (a stale PENDING confirmation must never occupy the tenant slot),
        // then issue exactly one fresh grant (+ one fresh SEMI_AUTO
        // confirmation on the NEW grant).
        //
        // Round 7 (SEMI_AUTO confirm-path P0 fix): when this issuance is
        // driven by the user CONFIRMING a PENDING confirmation, the
        // in-flight confirmation is NOT revoked — it is RE-BOUND to the
        // fresh grant below (the user's one-time confirmation survives the
        // fresh §18 evaluation that must necessarily issue a fresh grant;
        // revoking it made the commitment CAS permanently unwinnable).
        await this.casInvalidateGrant(
          existing.id,
          input.rebindConfirmationId
            ? 'SUPERSEDED_BY_CONFIRMATION_RE_EVALUATION'
            : 'SUPERSEDED_BY_REVALIDATION',
        );
        if (!input.rebindConfirmationId) {
          await this.revokeConfirmationsForGrant(existing.id);
        }
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
            // Round 6 (#297/#312): snapshot authority binding — the durable
            // accepted snapshot the decision derived from (LIVE: non-null).
            accountSnapshotId: input.accountSnapshotId,
            accountSnapshotGeneration: input.accountSnapshotGeneration,
            accountSnapshotObservedAt: input.accountSnapshotObservedAt,
            authorityGeneration: input.authorityGeneration,
            killSwitchGeneration: input.killSwitchGeneration,
            executionControlRevision: input.executionControlRevision,
            // Round 6 (#363): shared cross-replica control-plane revisions.
            tradingPolicyRevision: input.tradingPolicyRevision,
            providerVerificationRevision: input.providerVerificationRevision,
            // Round 6 (#301): canonical authority binding digest.
            authorityBindingDigest,
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

        if (input.rebindConfirmationId) {
          // Round 7 (SEMI_AUTO confirm-path P0 fix): carry the user's
          // EXISTING one-time confirmation over to the fresh grant (CAS on
          // status = PENDING for this user+signal). No second confirmation
          // row is created — the user's single confirmation remains
          // single-use, expiring and replay-proof, now bound to the grant
          // that will actually be consumed at the commitment.
          await this.rebindPendingConfirmation(
            input.rebindConfirmationId,
            grant,
            input.userId,
            input.signalId,
          );
        } else if (input.executionMode === ExecutionMode.SEMI_AUTO) {
          await this.createPendingConfirmation(grant, input);
        }

        await this.auditIssuance(grant, false);
        return { grant, reused: false };
      } catch (err) {
        if (isUniqueViolation(err)) {
          // A concurrent issuance won the one-ACTIVE-per-(user,signal) slot.
          // Reload the winner and converge on the next loop iteration.
          this.logger.warn(
            `Concurrent RiskGrant issuance for user ${input.userId} signal ${input.signalId} — reloading the winner`,
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
   * every loser gets a TYPED reason — never a guessed status.
   *
   * Round 6 (#364): pass `userId` to tenant-fence the CAS (id + user_id) so a
   * cross-tenant caller can neither consume another user's grant nor use the
   * failure classification as an existence oracle beyond not-found.
   */
  async consumeGrantAtomic(grantId: string, userId?: string): Promise<RiskGrantConsumeResult> {
    const qb = this.grantRepo
      .createQueryBuilder()
      .update()
      .set({ status: RiskGrantStatus.CONSUMED, consumedAt: new Date() })
      .where('id = :id AND status = :active AND expires_at > :now', {
        id: grantId,
        active: RiskGrantStatus.ACTIVE,
        now: new Date(),
      });
    if (userId) {
      qb.andWhere('user_id = :userId', { userId });
    }
    const result = await qb.execute();
    const affected = result.affected ?? 0;

    if (affected > 0) {
      this.logger.log(`RiskGrant ${grantId} CONSUMED (single-winner CAS)`);
      const grant = await this.grantRepo.findOne({
        where: userId ? { id: grantId, userId } : { id: grantId },
      });
      return { consumed: true, grant: grant ?? null };
    }

    // Lost the CAS — reload and classify the failure (typed, never guessed).
    // Tenant-scoped reload: a cross-tenant id is indistinguishable from
    // NOT_FOUND (no existence oracle).
    const grant = await this.grantRepo.findOne({
      where: userId ? { id: grantId, userId } : { id: grantId },
    });
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

  /**
   * Round 6 (#11 supersession / #364): revoke the PENDING confirmation bound
   * to ONE grant (tenant-safe: the grant id is already tenant-scoped by the
   * caller). CAS on status = PENDING only.
   */
  async revokeConfirmationsForGrant(grantId: string): Promise<number> {
    const result = await this.confirmationRepo
      .createQueryBuilder()
      .update()
      .set({ status: ExecutionConfirmationStatus.REVOKED, revokedAt: new Date() })
      .where('risk_grant_id = :grantId AND status = :pending', {
        grantId,
        pending: ExecutionConfirmationStatus.PENDING,
      })
      .execute();
    return result.affected ?? 0;
  }

  // ─── Internal helpers ─────────────────────────────────────────────────────

  /** Round 6 (#364): ACTIVE grant lookup is TENANT-SCOPED (user + signal). */
  private async findActiveGrantForSignal(
    userId: string,
    signalId: string,
  ): Promise<RiskGrant | null> {
    return this.grantRepo.findOne({
      where: { userId, signalId, status: RiskGrantStatus.ACTIVE },
    });
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
   * Round 7 (SEMI_AUTO confirm-path P0 fix): re-bind an existing PENDING
   * confirmation to a grant — CAS on (id, user_id, signal_id, status=PENDING).
   * The confirmation keeps its ORIGINAL expiry (anchored at the user's
   * original proposal view — the window never extends). Any concurrent
   * terminal transition (consumed/revoked/expired) is a TYPED fail-closed
   * abort: the confirm() call fails with zero provider calls.
   */
  private async rebindPendingConfirmation(
    confirmationId: string,
    grant: RiskGrant,
    userId: string,
    signalId: string,
  ): Promise<void> {
    const result = await this.confirmationRepo
      .createQueryBuilder()
      .update()
      .set({ riskGrantId: grant.id })
      .where('id = :id AND user_id = :userId AND signal_id = :signalId AND status = :pending', {
        id: confirmationId,
        userId,
        signalId,
        pending: ExecutionConfirmationStatus.PENDING,
      })
      .execute();
    if ((result.affected ?? 0) !== 1) {
      throw new PendingConfirmationRebindError(
        confirmationId,
        signalId,
        'the confirmation is no longer PENDING for this user+signal ' +
          '(consumed/revoked/expired concurrently) — fail-closed, zero provider calls',
      );
    }
    this.logger.log(
      `PENDING confirmation ${confirmationId} re-bound to fresh grant ${grant.id} ` +
        `(signal ${signalId}) — the user's one-time confirmation survives the §18 fresh evaluation`,
    );
  }

  /**
   * SEMI_AUTO confirmation row, bound to the grant + EXACT order. The
   * one-PENDING-per-(user,signal) partial unique index arbitrates concurrent
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
          `PENDING confirmation already exists for user ${grant.userId} signal ${grant.signalId} — keeping the original`,
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
          killSwitchGeneration: grant.killSwitchGeneration,
          executionControlRevision: grant.executionControlRevision,
          tradingPolicyRevision: grant.tradingPolicyRevision,
          providerVerificationRevision: grant.providerVerificationRevision,
          accountSnapshotId: grant.accountSnapshotId,
          accountSnapshotGeneration: grant.accountSnapshotGeneration,
          authorityBindingDigest: grant.authorityBindingDigest,
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
