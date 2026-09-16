import { HttpException, HttpStatus, Injectable, Inject, Logger, forwardRef } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import * as crypto from 'crypto';
import { BrokerConnection } from '../../broker/entities/broker-connection.entity';
import { BrokerService } from '../../broker/broker.service';
import { BrokerProviderRegistryService } from '../../broker/registry/broker-provider-registry.service';
import { CTRADER_FAMILY_BROKER_IDS } from '../../broker/registry/broker-catalog';
import { BrokerCredentialLifecycle } from '../../broker/authorization/broker-credential-status';
import { BrokerConnectionStatus } from '../../broker/interfaces/broker-adapter.interface';
import {
  catalogEntryToEvidence,
  connectionLiveVerificationStatus,
  LIVE_VERIFICATION_MODEL_VERSION,
  PROVIDER_TECHNOLOGY,
  type ProviderLiveVerificationEvidence,
} from '../../broker/verification/provider-live-verification.policy';
import { ExecutionControlService } from '../../execution-control/execution-control.service';
import { AuditService } from '../../audit/audit.service';
import { AuditAction } from '../../../common/enums/audit-action.enum';
import { AuditSeverity } from '../../audit/entities/audit-log.entity';
import { RiskGrant } from '../entities/risk-grant.entity';
import { TradingSession, TradingSessionStatus } from '../entities/trading-session.entity';
import { ExecutionConfirmation } from '../entities/execution-confirmation.entity';
import {
  ExecutionAuthorityContext,
  ExecutionConfirmationStatus,
  ExecutionMode,
  ProviderOperationClass,
  RiskGrantStatus,
  canonicalJson,
} from '../interfaces/execution-authority';
import { RiskGrantService } from '../../risk/risk-grant.service';
import { isExposureIncreasingOperation } from './provider-operation-class';
import { InjectDataSource } from '@nestjs/typeorm';
import { Order } from '../orders/order.entity';
import { OrderStatus } from '../orders/order.enums';
import { RiskProfile } from '../../risk/entities/risk-profile.entity';
import { TradingAuthorityService } from '../../execution-authority/trading-authority.service';
import { SharedControlRevisionService } from '../../execution-authority/shared-control-revision.service';

/** The paper/simulator execution path (broker-catalog.ts 'paper-broker'). */
const PAPER_BROKER_ID = 'paper-broker';

/** Origin of the authorization request — see the SEMI_AUTO note below. */
export type FinalDispatchOrigin = 'PIPELINE' | 'USER_CONFIRMATION';

/** Typed blocked reasons (issue #361 / #301 / #294 / #298 / #299 / #303). */
export type FinalDispatchBlockedReason =
  | 'GRANT_REQUIRED'
  | 'GRANT_NOT_FOUND'
  | 'GRANT_NOT_ACTIVE'
  | 'GRANT_EXPIRED'
  | 'GRANT_CONSUMED'
  | 'GRANT_INVALIDATED'
  | 'GRANT_USER_MISMATCH'
  | 'SESSION_NOT_FOUND'
  | 'SESSION_NOT_ACTIVE'
  | 'SESSION_GENERATION_MISMATCH'
  | 'EXECUTION_MODE_MISMATCH'
  | 'CONFIRMATION_REQUIRED'
  | 'CONFIRMATION_NOT_FOUND'
  | 'CONFIRMATION_USER_MISMATCH'
  | 'CONFIRMATION_NOT_PENDING'
  | 'CONFIRMATION_EXPIRED'
  | 'CONFIRMATION_CONSUMED'
  | 'CONFIRMATION_REVOKED'
  | 'CONFIRMATION_GENERATION_MISMATCH'
  | 'CONFIRMATION_DIGEST_MISMATCH'
  | 'CONNECTION_NOT_FOUND'
  | 'CONNECTION_NOT_OWNED'
  | 'CONNECTION_NOT_CONNECTED'
  | 'CONNECTION_NOT_EXECUTABLE'
  | 'CONNECTION_CREDENTIAL_STATUS_NOT_USABLE'
  | 'CONNECTION_CREDENTIAL_GENERATION_CHANGED'
  | 'PAPER_ONLY_REFUSES_NON_PAPER_CONNECTION'
  | 'LIVE_VERIFICATION_UNVERIFIED'
  | 'PROVIDER_IDENTITY_CHANGED'
  | 'PROVIDER_VERIFICATION_DOWNGRADED'
  | 'EXECUTION_CONTROL_BLOCKED'
  | 'GRANT_CONSUME_RACE_LOST'
  // Round 6 (#300/#363/#299): the unified execution-authority re-checks at
  // the PROVIDER-DISPATCH COMMITMENT (issue #365).
  | 'TRADING_AUTHORITY_GENERATION_MISMATCH'
  | 'SHARED_TRADING_POLICY_REVISION_MISMATCH'
  | 'SHARED_PROVIDER_VERIFICATION_REVISION_MISMATCH'
  | 'EXECUTION_CONTROL_REVISION_MISMATCH'
  | 'KILL_SWITCH_PROFILE_REVISION_MISMATCH'
  | 'ORDER_COMMITMENT_TRANSITION_LOST';

/** 409-style reasons (conflict family — the caller may reload + re-request). */
const CONFLICT_REASONS: readonly FinalDispatchBlockedReason[] = [
  'GRANT_NOT_ACTIVE',
  'GRANT_EXPIRED',
  'GRANT_CONSUMED',
  'GRANT_INVALIDATED',
  'GRANT_CONSUME_RACE_LOST',
  'SESSION_GENERATION_MISMATCH',
  'EXECUTION_MODE_MISMATCH',
  'CONFIRMATION_NOT_PENDING',
  'CONFIRMATION_EXPIRED',
  'CONFIRMATION_CONSUMED',
  'CONFIRMATION_REVOKED',
  'CONFIRMATION_GENERATION_MISMATCH',
  'CONFIRMATION_DIGEST_MISMATCH',
  'CONNECTION_CREDENTIAL_GENERATION_CHANGED',
  'PROVIDER_IDENTITY_CHANGED',
  'PROVIDER_VERIFICATION_DOWNGRADED',
];

/**
 * FinalDispatchBlockedException — the typed zero-provider-call rejection of
 * the final dispatch boundary. NEVER retried automatically (the architect's
 * no-auto-resend rule); the caller surfaces the code + message to the user.
 */
export class FinalDispatchBlockedException extends HttpException {
  readonly code: FinalDispatchBlockedReason;
  constructor(
    code: FinalDispatchBlockedReason,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(
      {
        statusCode: CONFLICT_REASONS.includes(code)
          ? HttpStatus.CONFLICT
          : code === 'GRANT_NOT_FOUND' || code === 'CONFIRMATION_NOT_FOUND'
            ? HttpStatus.NOT_FOUND
            : HttpStatus.FORBIDDEN,
        code,
        message,
        ...details,
      },
      CONFLICT_REASONS.includes(code)
        ? HttpStatus.CONFLICT
        : code === 'GRANT_NOT_FOUND' || code === 'CONFIRMATION_NOT_FOUND'
          ? HttpStatus.NOT_FOUND
          : HttpStatus.FORBIDDEN,
    );
    this.code = code;
  }
}

/** The immutable result of a successful boundary authorization. */
export interface FinalDispatchAuthorization {
  /** Frozen authority context — the dispatch uses EXACTLY this (no rediscovery). */
  readonly context: ExecutionAuthorityContext;
  /** The CURRENT re-verified connection (same id as the grant's — never another). */
  readonly connection: BrokerConnection;
  /** The SEMI_AUTO confirmation consumed by THIS authorization (if any). */
  readonly confirmationId: string | null;
  readonly operationClass: ProviderOperationClass;
}

export interface FinalDispatchInput {
  userId: string;
  /** Grant id from the risk approval (RiskApprovalResult.grantId). */
  grantId?: string;
  /** SEMI_AUTO confirmation id (USER_CONFIRMATION origin). */
  confirmationId?: string;
  origin: FinalDispatchOrigin;
  operationClass?: ProviderOperationClass;
}

/**
 * FINAL DISPATCH BOUNDARY (Sprint 56 correction round 5, task 50-c — issues
 * #361 / #301-consume / #294-final / #298-SEMI_AUTO-consume / #299 / #303).
 *
 * THE RULE: the orchestrator MUST call this boundary IMMEDIATELY BEFORE any
 * provider state-changing call for NEW exposure. Between risk approval and
 * dispatch, EVERY authority fact is re-read from CURRENT durable state, and
 * only ONE winner may proceed:
 *
 *   1. RiskGrant — exists, ACTIVE, unexpired, unconsumed, not invalidated;
 *   2. BrokerConnection — re-read by the EXACT grant.brokerConnectionId (the
 *      same id, NEVER discovered another way): exists, owned by grant.userId,
 *      CONNECTED, authorization executable, credentialStatus usable, and
 *      credentialGeneration UNCHANGED vs the grant-observed value when the
 *      grant carries one (rotation between approval and dispatch fences NEW
 *      exposure);
 *   3. TradingSession — ACTIVE, id === grant.sessionId, authorityGeneration
 *      === grant.sessionGeneration (a mode change / suspension / end in the
 *      window blocks NEW exposure), executionMode === grant.executionMode;
 *   4. SEMI_AUTO — the PENDING confirmation must exist, be unexpired,
 *      unrevoked, match grant.orderPayloadDigest and the session generation,
 *      and is CONSUMED ATOMICALLY HERE (CAS PENDING → CONSUMED, single
 *      winner): zero NEW-exposure dispatch without a valid confirmation,
 *      exactly-one with it, replay fails;
 *   5. PAPER_ONLY — NEW exposure routes ONLY to the paper execution path; a
 *      real-broker connection is refused (the MODE is authoritative — never
 *      inferred from connection.accountType);
 *   6. LIVE NEW exposure — provider identity + CURRENT identity-scoped
 *      production-LIVE verification re-evaluated (fail-closed on unknown
 *      identity, missing evidence, downgrade, revocation);
 *   7. Kill-switch / execution-control CURRENT state — exposure-increasing
 *      operations are blocked while a control is active (CLOSE / CANCEL /
 *      RECONCILE / risk-reducing operations remain available — issue #303);
 *   8. the RiskGrant is consumed ATOMICALLY (risk-grant.service contract:
 *      CAS ACTIVE+unexpired → CONSUMED with an affected-rows check) — only
 *      ONE winner proceeds; losers get a typed conflict;
 *   9. an immutable ExecutionAuthorityContext is returned — nothing
 *      downstream re-discovers anything.
 *
 * SEMI_AUTO ORIGIN MODEL (the security-critical wiring): a PENDING
 * confirmation is a PROPOSAL awaiting the user's one-time approval — it is
 * consumed ONLY on the USER_CONFIRMATION origin (POST
 * /execution/confirmations/:id/confirm), which then drives the dispatch with
 * the returned authorization. The automated PIPELINE origin is REFUSED for
 * SEMI_AUTO NEW exposure (CONFIRMATION_REQUIRED): consuming a PENDING
 * confirmation from the pipeline would dispatch WITHOUT the user's approval,
 * defeating the mode's entire purpose.
 *
 * ANY failure above → ZERO provider calls, a typed blocked reason, and an
 * EXECUTION_AUTHORITY_BLOCKED audit entry (the operation class is audited on
 * every authorization — issue #303).
 */
@Injectable()
export class FinalDispatchBoundary {
  private readonly logger = new Logger(FinalDispatchBoundary.name);

  constructor(
    @InjectRepository(RiskGrant)
    private readonly riskGrantRepo: Repository<RiskGrant>,
    @InjectRepository(TradingSession)
    private readonly sessionRepo: Repository<TradingSession>,
    @InjectRepository(ExecutionConfirmation)
    private readonly confirmationRepo: Repository<ExecutionConfirmation>,
    private readonly brokerService: BrokerService,
    private readonly executionControlService: ExecutionControlService,
    private readonly providerRegistry: BrokerProviderRegistryService,
    private readonly auditService: AuditService,
    // The 50-b contract owner: RiskGrantService (risk module) issues and
    // consumes durable grants. forwardRef resolves the RiskModule ↔
    // ExecutionModule import cycle.
    @Inject(forwardRef(() => RiskGrantService))
    private readonly riskGrants: RiskGrantService,
    // ── Round 6 (#365): the provider-dispatch commitment seam ──────────────
    @InjectRepository(Order)
    private readonly orderRepo: Repository<Order>,
    @InjectRepository(RiskProfile)
    private readonly riskProfileRepo: Repository<RiskProfile>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    // PLAIN leaf injections from ExecutionAuthorityModule (execution.module
    // imports it plainly — NO new forwardRef anywhere).
    private readonly tradingAuthorityService: TradingAuthorityService,
    private readonly sharedControlRevisions: SharedControlRevisionService,
  ) {}

  /**
   * The orchestrator/pipeline entry (immediately before the provider call):
   * authorize + atomically consume the grant for a NEW-exposure dispatch.
   */
  authorizeNewExposureDispatch(input: {
    userId: string;
    grantId: string;
    confirmationId?: string | null;
    origin?: FinalDispatchOrigin;
    operationClass?: ProviderOperationClass;
  }): Promise<FinalDispatchAuthorization> {
    // Round 6 (#365): READ-ONLY — the full authority chain is verified against
    // CURRENT durable state and the EXACT grant-bound connection resolved,
    // but NOTHING is consumed here. The RiskGrant (+ the SEMI_AUTO
    // confirmation) is consumed at the PROVIDER-DISPATCH COMMITMENT
    // (commitProviderDispatch) inside orchestrator.dispatchOrder, immediately
    // before the provider state-changing call.
    return this.authorize(
      {
        userId: input.userId,
        grantId: input.grantId,
        confirmationId: input.confirmationId ?? undefined,
        origin: input.origin ?? 'PIPELINE',
        operationClass: input.operationClass ?? ProviderOperationClass.NEW_EXPOSURE,
      },
      { consume: false },
    );
  }

  /**
   * The server-authoritative USER confirmation entry (SEMI_AUTO): validates
   * the full authority chain, consumes the one-time confirmation AND the
   * grant, and returns the authorization the dispatch then uses. The
   * frontend can never fabricate approval — only this path consumes.
   */
  authorizeFromUserConfirmation(input: {
    userId: string;
    confirmationId: string;
    operationClass?: ProviderOperationClass;
  }): Promise<FinalDispatchAuthorization> {
    // Round 6 (#365/#18): READ-ONLY — verification only; the confirmation +
    // the fresh grant are consumed AT the provider-dispatch commitment.
    return this.authorize(
      {
        userId: input.userId,
        confirmationId: input.confirmationId,
        origin: 'USER_CONFIRMATION',
        operationClass: input.operationClass ?? ProviderOperationClass.NEW_EXPOSURE,
      },
      { consume: false },
    );
  }

  /**
   * ROUND 6 (#365): the PROVIDER-DISPATCH COMMITMENT — ONE short DB
   * transaction, invoked by ExecutionOrchestrator.dispatchOrder IMMEDIATELY
   * before the provider state-changing adapter call, with NOTHING awaited in
   * between (no audits, no events, no unrelated writes — those derive from
   * durable state AFTER the dispatch outcome; this method therefore performs
   * no audit writes of its own).
   *
   * Inside the single transaction (no network I/O):
   *   1. re-verify the grant is still ACTIVE/unexpired + tenant-owned;
   *   2. re-verify the CURRENT unified authority chain: user
   *      TradingAuthorityGeneration (#300), shared cross-replica
   *      trading-policy / provider-verification / execution-control
   *      revisions (#363), risk-profile revision — the kill-switch
   *      generation (#299/#15), session ACTIVE/generation/mode, connection
   *      CONNECTED + credential generation (#361);
   *   3. ATOMICALLY consume the RiskGrant (tenant-scoped CAS
   *      ACTIVE+unexpired → CONSUMED — exactly one winner per grant);
   *   4. ATOMICALLY consume the SEMI_AUTO confirmation driving this dispatch
   *      (tenant + grant scoped CAS PENDING+unexpired → CONSUMED);
   *   5. transition the local order SUBMITTED → DISPATCH_COMMITTED (CAS).
   *
   * Cutoff semantics: any authority change BEFORE this commitment ⇒ ZERO
   * provider calls (typed FinalDispatchBlockedException). Any change AFTER ⇒
   * the request is already in-flight — resolved through
   * ProviderDispatchCertainty + reconciliation, never replayed.
   */
  async commitProviderDispatch(input: {
    userId: string;
    grantId: string;
    confirmationId?: string | null;
    orderId: string;
    origin: FinalDispatchOrigin;
  }): Promise<FinalDispatchAuthorization> {
    const operationClass = ProviderOperationClass.NEW_EXPOSURE;
    const boundaryInput: FinalDispatchInput = {
      userId: input.userId,
      grantId: input.grantId,
      confirmationId: input.confirmationId ?? undefined,
      origin: input.origin,
      operationClass,
    };

    const grant = await this.riskGrantRepo.findOne({
      where: { id: input.grantId, userId: input.userId },
    });
    if (!grant) {
      throw await this.blocked(boundaryInput, operationClass, 'GRANT_NOT_FOUND', {
        grantId: input.grantId,
        message: 'Commitment: the grant does not exist for this user (tenant-scoped).',
      });
    }
    if (grant.status !== RiskGrantStatus.ACTIVE || grant.expiresAt.getTime() <= Date.now()) {
      throw await this.blocked(
        boundaryInput,
        operationClass,
        grant.status === RiskGrantStatus.CONSUMED
          ? 'GRANT_CONSUMED'
          : grant.status === RiskGrantStatus.INVALIDATED
            ? 'GRANT_INVALIDATED'
            : 'GRANT_EXPIRED',
        { grantId: grant.id, grantStatus: grant.status },
      );
    }

    // ── CURRENT unified authority re-verification (#300/#363/#299/#15) ─────
    const currentGeneration = await this.tradingAuthorityService.getCurrentGeneration(input.userId);
    if (currentGeneration !== grant.authorityGeneration) {
      throw await this.blocked(
        boundaryInput,
        operationClass,
        'TRADING_AUTHORITY_GENERATION_MISMATCH',
        {
          grantId: grant.id,
          grantAuthorityGeneration: grant.authorityGeneration,
          currentGeneration,
          message:
            'The user trading-authority generation advanced after this grant was issued ' +
            '(KYC/jurisdiction/governance/risk/kill-switch change) — NEW exposure is blocked.',
        },
      );
    }

    let policyRevision: number;
    let providerRevision: number;
    let controlRevision: number;
    try {
      policyRevision = await this.sharedControlRevisions.getCurrentTradingPolicyRevision();
      providerRevision = await this.sharedControlRevisions.getCurrentProviderVerificationRevision();
      controlRevision = await this.sharedControlRevisions.getCurrentExecutionControlRevision();
    } catch {
      // §16: shared control-plane store unreadable ⇒ NEW exposure fails closed.
      throw await this.blocked(
        boundaryInput,
        operationClass,
        'EXECUTION_CONTROL_REVISION_MISMATCH',
        {
          grantId: grant.id,
          message:
            'The shared cross-replica control-plane revision store is unreadable — ' +
            'NEW exposure fails closed (a stale replica must never execute).',
        },
      );
    }
    if (grant.tradingPolicyRevision !== null && policyRevision !== grant.tradingPolicyRevision) {
      throw await this.blocked(
        boundaryInput,
        operationClass,
        'SHARED_TRADING_POLICY_REVISION_MISMATCH',
        { grantId: grant.id, bound: grant.tradingPolicyRevision, current: policyRevision },
      );
    }
    if (
      grant.providerVerificationRevision !== null &&
      providerRevision !== grant.providerVerificationRevision
    ) {
      throw await this.blocked(
        boundaryInput,
        operationClass,
        'SHARED_PROVIDER_VERIFICATION_REVISION_MISMATCH',
        { grantId: grant.id, bound: grant.providerVerificationRevision, current: providerRevision },
      );
    }
    if (
      grant.executionControlRevision !== null &&
      controlRevision !== grant.executionControlRevision
    ) {
      throw await this.blocked(
        boundaryInput,
        operationClass,
        'EXECUTION_CONTROL_REVISION_MISMATCH',
        { grantId: grant.id, bound: grant.executionControlRevision, current: controlRevision },
      );
    }
    if (grant.killSwitchGeneration !== null) {
      const profile = await this.riskProfileRepo.findOne({ where: { userId: input.userId } });
      const currentRevision = profile?.revision ?? null;
      if (currentRevision !== null && currentRevision !== grant.killSwitchGeneration) {
        throw await this.blocked(
          boundaryInput,
          operationClass,
          'KILL_SWITCH_PROFILE_REVISION_MISMATCH',
          {
            grantId: grant.id,
            bound: grant.killSwitchGeneration,
            current: currentRevision,
            message:
              'The risk profile (kill switch / material policy) changed after this grant ' +
              'was issued — NEW exposure is blocked (no boolean resurrection).',
          },
        );
      }
    }

    // ── Session + connection CURRENT state (quick re-reads) ────────────────
    const session = await this.sessionRepo.findOne({ where: { id: grant.sessionId } });
    if (
      !session ||
      session.status !== TradingSessionStatus.ACTIVE ||
      session.authorityGeneration !== grant.sessionGeneration ||
      session.executionMode !== grant.executionMode
    ) {
      throw await this.blocked(
        boundaryInput,
        operationClass,
        !session
          ? 'SESSION_NOT_FOUND'
          : session.status !== TradingSessionStatus.ACTIVE
            ? 'SESSION_NOT_ACTIVE'
            : session.authorityGeneration !== grant.sessionGeneration
              ? 'SESSION_GENERATION_MISMATCH'
              : 'EXECUTION_MODE_MISMATCH',
        { grantId: grant.id, sessionId: grant.sessionId },
      );
    }
    let connection: BrokerConnection;
    try {
      connection = await this.brokerService.findConnectionById(
        grant.brokerConnectionId,
        input.userId,
      );
    } catch {
      throw await this.blocked(boundaryInput, operationClass, 'CONNECTION_NOT_FOUND', {
        grantId: grant.id,
        brokerConnectionId: grant.brokerConnectionId,
      });
    }
    if (connection.status !== BrokerConnectionStatus.CONNECTED) {
      throw await this.blocked(boundaryInput, operationClass, 'CONNECTION_NOT_CONNECTED', {
        brokerConnectionId: connection.id,
        status: connection.status,
      });
    }
    if (
      grant.credentialGeneration !== null &&
      connection.credentialGeneration !== grant.credentialGeneration
    ) {
      throw await this.blocked(
        boundaryInput,
        operationClass,
        'CONNECTION_CREDENTIAL_GENERATION_CHANGED',
        {
          brokerConnectionId: connection.id,
          bound: grant.credentialGeneration,
          current: connection.credentialGeneration,
        },
      );
    }

    // ── THE COMMITMENT (one short transaction; no network I/O inside) ──────
    const now = new Date();
    const context: ExecutionAuthorityContext = Object.freeze({
      userId: grant.userId,
      signalId: grant.signalId,
      operationType: operationClass,
      sessionId: session.id,
      sessionGeneration: session.authorityGeneration,
      executionMode: session.executionMode,
      brokerConnectionId: connection.id,
      brokerAccountId: connection.accountId ?? null,
      providerTechnology: connection.brokerId,
      providerBrokerIdentity: connection.providerBrokerIdentity ?? null,
      providerVerificationFingerprint: grant.providerVerificationFingerprint,
      financialSnapshotGeneration: grant.accountSnapshotGeneration ?? null,
      riskProfileId: grant.riskProfileId ?? null,
      riskProfileVersion: grant.riskProfileVersion ?? null,
      riskGrantId: grant.id,
      authorityGeneration: grant.authorityGeneration,
      validatedOrderDigest: grant.orderPayloadDigest,
    });

    try {
      await this.dataSource.transaction(async (em) => {
        const grantConsume = await em
          .getRepository(RiskGrant)
          .createQueryBuilder()
          .update()
          .set({ status: RiskGrantStatus.CONSUMED, consumedAt: now })
          .where('id = :id AND user_id = :userId AND status = :active AND expires_at > :now', {
            id: grant.id,
            userId: input.userId,
            active: RiskGrantStatus.ACTIVE,
            now,
          })
          .execute();
        if ((grantConsume.affected ?? 0) !== 1) {
          throw new Error('COMMITMENT_GRANT_CAS_LOST');
        }

        if (input.confirmationId) {
          const confirmationConsume = await em
            .getRepository(ExecutionConfirmation)
            .createQueryBuilder()
            .update()
            .set({ status: ExecutionConfirmationStatus.CONSUMED, consumedAt: now })
            .where(
              'id = :id AND user_id = :userId AND risk_grant_id = :grantId ' +
                'AND status = :pending AND expires_at > :now',
              {
                id: input.confirmationId,
                userId: input.userId,
                grantId: grant.id,
                pending: ExecutionConfirmationStatus.PENDING,
                now,
              },
            )
            .execute();
          if ((confirmationConsume.affected ?? 0) !== 1) {
            throw new Error('COMMITMENT_CONFIRMATION_CAS_LOST');
          }
        }

        const orderTransition = await em
          .getRepository(Order)
          .createQueryBuilder()
          .update()
          .set({ status: OrderStatus.DISPATCH_COMMITTED })
          .where('id = :orderId AND status = :submitted', {
            orderId: input.orderId,
            submitted: OrderStatus.SUBMITTED,
          })
          .execute();
        if ((orderTransition.affected ?? 0) !== 1) {
          throw new Error('COMMITMENT_ORDER_TRANSITION_LOST');
        }
      });
    } catch (err) {
      const message = (err as Error).message ?? '';
      throw await this.blocked(
        boundaryInput,
        operationClass,
        message === 'COMMITMENT_ORDER_TRANSITION_LOST'
          ? 'ORDER_COMMITMENT_TRANSITION_LOST'
          : 'GRANT_CONSUME_RACE_LOST',
        {
          grantId: grant.id,
          confirmationId: input.confirmationId ?? null,
          orderId: input.orderId,
          message:
            'The commitment CAS lost (a concurrent winner consumed this authority, or the ' +
            'order was no longer SUBMITTED) — exactly one dispatch commitment survives.',
        },
      );
    }

    this.logger.log(
      `PROVIDER-DISPATCH COMMITTED: grant ${grant.id}` +
        `${input.confirmationId ? ` + confirmation ${input.confirmationId}` : ''} ` +
        `→ order ${input.orderId} DISPATCH_COMMITTED (user ${input.userId}, ` +
        `session ${session.id}@${session.authorityGeneration})`,
    );

    return {
      context,
      connection,
      confirmationId: input.confirmationId ?? null,
      operationClass,
    };
  }

  // ─── The boundary ─────────────────────────────────────────────────────────

  private async authorize(
    input: FinalDispatchInput,
    options?: { consume?: boolean },
  ): Promise<FinalDispatchAuthorization> {
    const operationClass = input.operationClass ?? ProviderOperationClass.NEW_EXPOSURE;
    const exposureIncreasing = isExposureIncreasingOperation(operationClass);

    // ── Load the confirmation (USER_CONFIRMATION origin) ───────────────────
    let confirmation: ExecutionConfirmation | null = null;
    if (input.confirmationId) {
      confirmation = await this.confirmationRepo.findOne({
        where: { id: input.confirmationId, userId: input.userId },
      });
      if (!confirmation) {
        throw await this.blocked(input, operationClass, 'CONFIRMATION_NOT_FOUND', {
          confirmationId: input.confirmationId,
          message: 'Execution confirmation not found or does not belong to you.',
        });
      }
      if (confirmation.status !== ExecutionConfirmationStatus.PENDING) {
        throw await this.blocked(
          input,
          operationClass,
          confirmation.status === ExecutionConfirmationStatus.CONSUMED
            ? 'CONFIRMATION_CONSUMED'
            : confirmation.status === ExecutionConfirmationStatus.REVOKED
              ? 'CONFIRMATION_REVOKED'
              : 'CONFIRMATION_EXPIRED',
          {
            confirmationId: confirmation.id,
            confirmationStatus: confirmation.status,
            message: `Execution confirmation is ${confirmation.status} — one-time use, replay fails.`,
          },
        );
      }
      if (confirmation.userId !== input.userId) {
        throw await this.blocked(input, operationClass, 'CONFIRMATION_USER_MISMATCH', {
          confirmationId: confirmation.id,
        });
      }
    }

    // ── 1. Load the RiskGrant (by id, or via the confirmation) ──────────────
    let grant: RiskGrant | null = null;
    if (input.grantId) {
      grant = await this.riskGrantRepo.findOne({ where: { id: input.grantId } });
    } else if (confirmation) {
      if (confirmation.riskGrantId) {
        grant = await this.riskGrantRepo.findOne({ where: { id: confirmation.riskGrantId } });
      } else {
        // Legacy/parallel-issuer shape: resolve the grant by the confirmation's
        // authority binding (signal + session + generation).
        grant = await this.riskGrantRepo.findOne({
          where: {
            signalId: confirmation.signalId,
            sessionId: confirmation.sessionId,
            sessionGeneration: confirmation.sessionGeneration,
          },
          order: { issuedAt: 'DESC' },
        });
      }
    }
    if (!grant) {
      throw await this.blocked(
        input,
        operationClass,
        input.grantId ? 'GRANT_NOT_FOUND' : 'GRANT_REQUIRED',
        {
          grantId: input.grantId ?? null,
          confirmationId: confirmation?.id ?? null,
          message: input.grantId
            ? `Risk grant ${input.grantId} not found — a server-issued grant is required for dispatch.`
            : 'A server-issued RiskGrant is required for NEW-exposure dispatch (fail-closed).',
        },
      );
    }
    if (grant.userId !== input.userId) {
      throw await this.blocked(input, operationClass, 'GRANT_USER_MISMATCH', {
        grantId: grant.id,
      });
    }
    if (grant.status === RiskGrantStatus.CONSUMED) {
      throw await this.blocked(input, operationClass, 'GRANT_CONSUMED', {
        grantId: grant.id,
        consumedAt: grant.consumedAt?.toISOString() ?? null,
        message: 'Risk grant already consumed — exactly one dispatch per grant (single-use).',
      });
    }
    if (grant.status === RiskGrantStatus.INVALIDATED) {
      throw await this.blocked(input, operationClass, 'GRANT_INVALIDATED', {
        grantId: grant.id,
        invalidationReason: grant.invalidationReason,
        message: `Risk grant invalidated (${grant.invalidationReason ?? 'authority change'}) — a new risk evaluation is required.`,
      });
    }
    if (grant.status !== RiskGrantStatus.ACTIVE) {
      throw await this.blocked(input, operationClass, 'GRANT_NOT_ACTIVE', {
        grantId: grant.id,
        grantStatus: grant.status,
      });
    }
    if (grant.expiresAt.getTime() <= Date.now()) {
      throw await this.blocked(input, operationClass, 'GRANT_EXPIRED', {
        grantId: grant.id,
        expiresAt: grant.expiresAt.toISOString(),
        message: 'Risk grant expired — a new risk evaluation is required.',
      });
    }

    // ── 3. Session: ACTIVE, exact id + generation + mode ───────────────────
    const session = await this.sessionRepo.findOne({ where: { id: grant.sessionId } });
    if (!session) {
      throw await this.blocked(input, operationClass, 'SESSION_NOT_FOUND', {
        sessionId: grant.sessionId,
      });
    }
    if (session.status !== TradingSessionStatus.ACTIVE) {
      throw await this.blocked(input, operationClass, 'SESSION_NOT_ACTIVE', {
        sessionId: session.id,
        sessionStatus: session.status,
        message: `Trading session is ${session.status} — NEW exposure is blocked (fail-closed).`,
      });
    }
    if (session.authorityGeneration !== grant.sessionGeneration) {
      throw await this.blocked(input, operationClass, 'SESSION_GENERATION_MISMATCH', {
        sessionId: session.id,
        grantSessionGeneration: grant.sessionGeneration,
        currentSessionGeneration: session.authorityGeneration,
        message:
          'Session authority generation changed between approval and dispatch — NEW exposure blocked.',
      });
    }
    if (session.executionMode !== grant.executionMode) {
      throw await this.blocked(input, operationClass, 'EXECUTION_MODE_MISMATCH', {
        sessionId: session.id,
        grantExecutionMode: grant.executionMode,
        currentExecutionMode: session.executionMode,
      });
    }
    if (confirmation && confirmation.sessionGeneration !== session.authorityGeneration) {
      throw await this.blocked(input, operationClass, 'CONFIRMATION_GENERATION_MISMATCH', {
        confirmationId: confirmation.id,
        confirmationSessionGeneration: confirmation.sessionGeneration,
        currentSessionGeneration: session.authorityGeneration,
        message: 'The confirmation belongs to an older session authority generation.',
      });
    }

    // ── 2. CURRENT exact BrokerConnection (SAME id — never discovered) ─────
    const connections = await this.brokerService.findConnectionsByIds([grant.brokerConnectionId]);
    const connection = connections.find((c) => c.id === grant!.brokerConnectionId) ?? null;
    if (!connection) {
      throw await this.blocked(input, operationClass, 'CONNECTION_NOT_FOUND', {
        brokerConnectionId: grant.brokerConnectionId,
        message: 'The exact broker connection bound to the grant no longer exists (fail-closed).',
      });
    }
    if (connection.userId !== grant.userId) {
      throw await this.blocked(input, operationClass, 'CONNECTION_NOT_OWNED', {
        brokerConnectionId: connection.id,
      });
    }
    if (connection.status !== BrokerConnectionStatus.CONNECTED) {
      throw await this.blocked(input, operationClass, 'CONNECTION_NOT_CONNECTED', {
        brokerConnectionId: connection.id,
        connectionStatus: connection.status,
      });
    }
    if (!this.brokerService.isConnectionExecutable(connection)) {
      throw await this.blocked(input, operationClass, 'CONNECTION_NOT_EXECUTABLE', {
        brokerConnectionId: connection.id,
        authorizationStatus: connection.authorizationStatus ?? 'UNKNOWN',
        message: `Connection authorization status ${connection.authorizationStatus ?? 'UNKNOWN'} is not executable (fail-closed).`,
      });
    }
    if (!BrokerCredentialLifecycle.isUsable(connection.credentialStatus)) {
      throw await this.blocked(input, operationClass, 'CONNECTION_CREDENTIAL_STATUS_NOT_USABLE', {
        brokerConnectionId: connection.id,
        credentialStatus: connection.credentialStatus ?? 'MISSING',
      });
    }
    if (
      grant.credentialGeneration != null &&
      connection.credentialGeneration !== grant.credentialGeneration
    ) {
      // Credential rotation between approval and dispatch fences NEW exposure
      // (issue #361): the grant was approved against a different credential
      // generation than the one that would now be decrypted and used.
      throw await this.blocked(input, operationClass, 'CONNECTION_CREDENTIAL_GENERATION_CHANGED', {
        brokerConnectionId: connection.id,
        grantCredentialGeneration: grant.credentialGeneration,
        currentCredentialGeneration: connection.credentialGeneration,
        message:
          'Credential generation changed between approval and dispatch — NEW exposure blocked.',
      });
    }

    // Grant-observed provider identity fencing: when the issuer recorded the
    // identity, ANY drift (relinked connection / different discovered broker)
    // blocks the dispatch. When the grant did not observe it, the CURRENT
    // value flows into the returned context (fail-closed for LIVE below).
    if (
      grant.providerBrokerIdentity != null &&
      connection.providerBrokerIdentity !== grant.providerBrokerIdentity
    ) {
      throw await this.blocked(input, operationClass, 'PROVIDER_IDENTITY_CHANGED', {
        brokerConnectionId: connection.id,
        grantProviderIdentity: grant.providerBrokerIdentity,
        currentProviderIdentity: connection.providerBrokerIdentity ?? null,
        message: 'The server-derived provider identity behind this connection changed.',
      });
    }

    // ── 4/5. Mode gates (NEW exposure only) ─────────────────────────────────
    if (exposureIncreasing) {
      if (session.executionMode === ExecutionMode.PAPER_ONLY) {
        // The MODE is authoritative — never inferred from connection.accountType.
        if (connection.brokerId !== PAPER_BROKER_ID) {
          throw await this.blocked(
            input,
            operationClass,
            'PAPER_ONLY_REFUSES_NON_PAPER_CONNECTION',
            {
              brokerConnectionId: connection.id,
              brokerId: connection.brokerId,
              executionMode: session.executionMode,
              message:
                'PAPER_ONLY session: NEW exposure routes exclusively to the paper execution path — ' +
                'a real-broker connection is refused regardless of account type.',
            },
          );
        }
      } else if (session.executionMode === ExecutionMode.SEMI_AUTO) {
        if (input.origin === 'PIPELINE') {
          // The pipeline may NEVER consume the user's one-time confirmation.
          throw await this.blocked(input, operationClass, 'CONFIRMATION_REQUIRED', {
            grantId: grant.id,
            sessionId: session.id,
            executionMode: session.executionMode,
            message:
              'SEMI_AUTO NEW exposure requires the user one-time confirmation ' +
              '(POST /execution/confirmations/:id/confirm) — the automated pipeline may not consume it.',
          });
        }
        if (!confirmation) {
          throw await this.blocked(input, operationClass, 'CONFIRMATION_REQUIRED', {
            grantId: grant.id,
            message: 'SEMI_AUTO NEW exposure requires a valid PENDING confirmation.',
          });
        }
        if (confirmation.signalId !== grant.signalId) {
          throw await this.blocked(input, operationClass, 'CONFIRMATION_DIGEST_MISMATCH', {
            confirmationId: confirmation.id,
            grantSignalId: grant.signalId,
            confirmationSignalId: confirmation.signalId,
            message: 'The confirmation authorizes a different signal than the grant.',
          });
        }
        if (confirmation.orderPayloadDigest !== grant.orderPayloadDigest) {
          throw await this.blocked(input, operationClass, 'CONFIRMATION_DIGEST_MISMATCH', {
            confirmationId: confirmation.id,
            message: 'The confirmation was issued for a different order payload (digest mismatch).',
          });
        }
        if (confirmation.sessionId !== session.id) {
          throw await this.blocked(input, operationClass, 'CONFIRMATION_DIGEST_MISMATCH', {
            confirmationId: confirmation.id,
            message: 'The confirmation belongs to a different session.',
          });
        }
        if (confirmation.brokerConnectionId !== connection.id) {
          throw await this.blocked(input, operationClass, 'CONFIRMATION_DIGEST_MISMATCH', {
            confirmationId: confirmation.id,
            message: 'The confirmation targets a different broker connection.',
          });
        }
        if (confirmation.expiresAt.getTime() <= Date.now()) {
          throw await this.blocked(input, operationClass, 'CONFIRMATION_EXPIRED', {
            confirmationId: confirmation.id,
            expiresAt: confirmation.expiresAt.toISOString(),
          });
        }
      }
    }

    // ── 6. LIVE NEW exposure: current identity-scoped verification ─────────
    let verificationFingerprint: string | null = grant.providerVerificationFingerprint ?? null;
    if (exposureIncreasing && connection.accountType === 'LIVE') {
      const verification = this.evaluateCurrentLiveVerification(connection);
      if (!verification.eligible) {
        throw await this.blocked(input, operationClass, 'LIVE_VERIFICATION_UNVERIFIED', {
          brokerConnectionId: connection.id,
          brokerId: connection.brokerId,
          providerBrokerIdentity: connection.providerBrokerIdentity ?? null,
          verificationStatus: verification.status,
          message:
            'LIVE NEW exposure requires CURRENT identity-scoped production-LIVE verification ' +
            '(fail-closed on unknown identity, missing evidence, downgrade or revocation).',
        });
      }
      // Fingerprint fencing: a grant that observed a VERIFIED fingerprint is
      // blocked when the CURRENT evaluation differs (downgrade between
      // approval and dispatch).
      if (
        grant.providerVerificationFingerprint != null &&
        grant.providerVerificationFingerprint !== verification.fingerprint
      ) {
        throw await this.blocked(input, operationClass, 'PROVIDER_VERIFICATION_DOWNGRADED', {
          brokerConnectionId: connection.id,
          grantFingerprint: grant.providerVerificationFingerprint,
          currentFingerprint: verification.fingerprint,
          message: 'Provider LIVE-verification evidence changed since approval (downgrade fence).',
        });
      }
      verificationFingerprint = verification.fingerprint;
    }

    // ── 7. Kill-switch / execution-control CURRENT state (operation-aware) ─
    if (exposureIncreasing) {
      const permission = await this.executionControlService.checkExecutionPermission({
        userId: input.userId,
        brokerId: connection.brokerId,
        brokerConnectionId: connection.id,
      });
      if (!permission.allowed) {
        throw await this.blocked(input, operationClass, 'EXECUTION_CONTROL_BLOCKED', {
          brokerConnectionId: connection.id,
          controlScope: permission.blockedBy?.scope ?? 'UNKNOWN',
          controlScopeKey: permission.blockedBy?.scopeKey ?? null,
          controlReason: permission.blockedBy?.reason ?? 'UNKNOWN',
          message:
            `NEW exposure blocked by the execution control plane ` +
            `(${permission.blockedBy?.scope ?? 'UNKNOWN'} scope) — CLOSE/CANCEL/RECONCILE remain available.`,
        });
      }
    }

    // ── 4b. Consume the SEMI_AUTO confirmation ATOMICALLY (single winner) ───
    if (
      options?.consume !== false &&
      exposureIncreasing &&
      session.executionMode === ExecutionMode.SEMI_AUTO &&
      confirmation
    ) {
      const consumed = await this.confirmationRepo
        .createQueryBuilder()
        .update()
        .set({ status: ExecutionConfirmationStatus.CONSUMED, consumedAt: new Date() })
        .where('id = :id AND status = :pending AND expires_at > :now AND revoked_at IS NULL', {
          id: confirmation.id,
          pending: ExecutionConfirmationStatus.PENDING,
          now: new Date(),
        })
        .execute();
      if (!consumed.affected) {
        // Another confirm request won the one-time consumption — replay fails.
        const reloaded = await this.confirmationRepo.findOne({ where: { id: confirmation.id } });
        throw await this.blocked(
          input,
          operationClass,
          reloaded?.status === ExecutionConfirmationStatus.REVOKED
            ? 'CONFIRMATION_REVOKED'
            : reloaded?.status === ExecutionConfirmationStatus.CONSUMED
              ? 'CONFIRMATION_CONSUMED'
              : 'CONFIRMATION_EXPIRED',
          {
            confirmationId: confirmation.id,
            confirmationStatus: reloaded?.status ?? 'UNKNOWN',
            message: 'The confirmation was consumed concurrently — replay fails (single winner).',
          },
        );
      }
      await this.auditService.log({
        actorUserId: input.userId,
        action: AuditAction.EXECUTION_CONFIRMATION_CONSUMED,
        resourceType: 'ExecutionConfirmation',
        resourceId: confirmation.id,
        severity: AuditSeverity.WARNING,
        metadata: {
          confirmationId: confirmation.id,
          grantId: grant.id,
          signalId: grant.signalId,
          sessionId: session.id,
          sessionGeneration: session.authorityGeneration,
          orderPayloadDigest: grant.orderPayloadDigest,
          operationClass,
        },
      });
    }

    // ── 8. Consume the RiskGrant ATOMICALLY (single winner proceeds) ───────
    // Round 6 (#365): SKIPPED in read-only mode — the consuming CAS runs at
    // the PROVIDER-DISPATCH COMMITMENT (commitProviderDispatch).
    // The 50-b contract: RiskGrantService.consumeGrantAtomic is the CAS
    // ACTIVE+unexpired → CONSUMED with an affected-rows check — exactly one
    // winner (a second attempt, an invalidated grant, an expired grant, a
    // replica racing us: all fail with a TYPED reason, never a guess).
    let consume: { consumed: boolean; grant: RiskGrant | null; reason?: string };
    if (options?.consume === false) {
      consume = { consumed: true, grant };
    } else {
      consume = await this.riskGrants.consumeGrantAtomic(grant.id);
    }
    if (!consume.consumed) {
      throw await this.blocked(
        input,
        operationClass,
        consume.reason === 'ALREADY_CONSUMED'
          ? 'GRANT_CONSUMED'
          : consume.reason === 'INVALIDATED'
            ? 'GRANT_INVALIDATED'
            : consume.reason === 'EXPIRED'
              ? 'GRANT_EXPIRED'
              : 'GRANT_CONSUME_RACE_LOST',
        {
          grantId: grant.id,
          grantStatus: consume.grant?.status ?? 'UNKNOWN',
          consumeReason: consume.reason ?? 'UNKNOWN',
          message: 'The risk grant was consumed concurrently — exactly one dispatch per grant.',
        },
      );
    }

    // ── 9. Immutable authority context (nothing downstream re-discovers) ───
    const context: ExecutionAuthorityContext = Object.freeze({
      userId: grant.userId,
      signalId: grant.signalId,
      operationType: operationClass,
      sessionId: session.id,
      sessionGeneration: session.authorityGeneration,
      executionMode: session.executionMode,
      brokerConnectionId: connection.id,
      brokerAccountId: connection.accountId ?? null,
      providerTechnology: connection.brokerId,
      providerBrokerIdentity: connection.providerBrokerIdentity ?? null,
      providerVerificationFingerprint: verificationFingerprint,
      financialSnapshotGeneration: grant.accountSnapshotGeneration ?? null,
      riskProfileId: grant.riskProfileId ?? null,
      riskProfileVersion: grant.riskProfileVersion ?? null,
      riskGrantId: grant.id,
      authorityGeneration: grant.authorityGeneration,
      validatedOrderDigest: grant.orderPayloadDigest,
    });

    await this.auditService.log({
      actorUserId: input.userId,
      action: AuditAction.ORDER_SUBMITTED,
      resourceType: 'RiskGrant',
      resourceId: grant.id,
      severity: AuditSeverity.INFO,
      metadata: {
        boundary: 'FINAL_DISPATCH_AUTHORIZED',
        operationClass,
        origin: input.origin,
        grantId: grant.id,
        confirmationId: confirmation?.id ?? null,
        sessionId: session.id,
        sessionGeneration: session.authorityGeneration,
        executionMode: session.executionMode,
        brokerConnectionId: connection.id,
        credentialGeneration: connection.credentialGeneration ?? null,
        orderPayloadDigest: grant.orderPayloadDigest,
      },
    });

    return {
      context,
      connection,
      confirmationId: confirmation?.id ?? null,
      operationClass,
    };
  }

  // ─── LIVE verification (round-4 identity-scoped model, re-evaluated) ──────

  /**
   * CURRENT production-LIVE eligibility for the connection (mirrors the
   * broker.service createConnection/enableLiveTrading gates — the boundary
   * NEVER grants eligibility the connection-creation path would refuse):
   *  - cTrader family: identity-scoped evidence — VERIFIED requires VERIFIED
   *    evidence matching the technology + environment + the connection's
   *    EXACT server-derived identity (unknown identity fails closed; one
   *    broker's verification never authorizes another; technology-level
   *    evidence never applies);
   *  - single-broker-per-technology providers: the catalog-level
   *    production-LIVE eligibility is the identity-scoped evidence.
   */
  private evaluateCurrentLiveVerification(connection: BrokerConnection): {
    eligible: boolean;
    status: 'VERIFIED' | 'UNVERIFIED';
    fingerprint: string;
  } {
    if (CTRADER_FAMILY_BROKER_IDS.includes(connection.brokerId)) {
      const status = connectionLiveVerificationStatus({
        brokerId: connection.brokerId,
        providerTechnology: PROVIDER_TECHNOLOGY.CTRADER,
        connectionProviderIdentity: connection.providerBrokerIdentity ?? null,
        environment: 'LIVE',
        evidence: this.ctraderFamilyLiveEvidence(),
      });
      return {
        eligible: status === 'VERIFIED',
        status,
        fingerprint: this.verificationFingerprint(
          PROVIDER_TECHNOLOGY.CTRADER,
          connection.providerBrokerIdentity ?? null,
          status,
        ),
      };
    }
    const eligible = this.providerRegistry.isProductionLiveEligible(connection.brokerId);
    const status = eligible ? 'VERIFIED' : 'UNVERIFIED';
    return {
      eligible,
      status,
      fingerprint: this.verificationFingerprint(connection.brokerId, null, status),
    };
  }

  /** Identity-scoped LIVE-verification evidence for the cTrader family. */
  private ctraderFamilyLiveEvidence(): ProviderLiveVerificationEvidence[] {
    const evidence: ProviderLiveVerificationEvidence[] = [];
    for (const id of CTRADER_FAMILY_BROKER_IDS) {
      const entry = this.providerRegistry.getEntry(id);
      if (!entry) continue;
      for (const unit of catalogEntryToEvidence(entry, ['LIVE'])) {
        evidence.push({ ...unit, providerTechnology: PROVIDER_TECHNOLOGY.CTRADER });
      }
    }
    return evidence;
  }

  /**
   * Versioned fingerprint of the CURRENT identity-scoped verification
   * evaluation (canonical JSON digest, 128 hex chars max) — pinned on the
   * grant at issuance and fenced at the boundary.
   */
  private verificationFingerprint(
    providerTechnology: string,
    providerIdentity: string | null,
    status: 'VERIFIED' | 'UNVERIFIED',
  ): string {
    const canonical = canonicalJson({
      modelVersion: LIVE_VERIFICATION_MODEL_VERSION,
      providerTechnology,
      providerIdentity,
      environment: 'LIVE',
      status,
    });
    return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 128);
  }

  // ─── Typed blocking + audit (zero provider calls) ─────────────────────────

  /** Record the typed block and return the exception to throw. */
  private async blocked(
    input: FinalDispatchInput,
    operationClass: ProviderOperationClass,
    reason: FinalDispatchBlockedReason,
    details: Record<string, unknown>,
  ): Promise<FinalDispatchBlockedException> {
    const message =
      typeof details.message === 'string' ? details.message : `Final dispatch blocked: ${reason}`;
    const metadata = { ...details, message: undefined };
    delete metadata.message;
    this.logger.warn(
      `Final dispatch boundary BLOCKED (${reason}) for user ${input.userId} ` +
        `origin=${input.origin} operationClass=${operationClass}`,
    );
    try {
      await this.auditService.log({
        actorUserId: input.userId,
        action: AuditAction.EXECUTION_AUTHORITY_BLOCKED,
        resourceType: 'RiskGrant',
        resourceId: (details.grantId as string) ?? 'not-authorized',
        severity: AuditSeverity.WARNING,
        metadata: {
          blockedReason: reason,
          origin: input.origin,
          operationClass,
          grantId: details.grantId ?? input.grantId ?? null,
          confirmationId: details.confirmationId ?? input.confirmationId ?? null,
          ...metadata,
        },
      });
    } catch (err) {
      // Audit failure must never turn a typed block into an untyped 500.
      this.logger.error(`Boundary block audit failed: ${(err as Error).message}`);
    }
    return new FinalDispatchBlockedException(reason, message, details);
  }
}
