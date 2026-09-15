import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { ExecutionConfirmation } from './entities/execution-confirmation.entity';
import { RiskGrant } from './entities/risk-grant.entity';
import { RiskProfile } from '../risk/entities/risk-profile.entity';
import { ExecutionConfirmationStatus, ExecutionMode } from './interfaces/execution-authority';
import { FinalDispatchBoundary } from './orchestration/final-dispatch-boundary';
import { ExecutionService } from './execution.service';
import { Trade } from './entities/trade.entity';
import { RiskDecision } from '../risk/interfaces/risk.interface';
import { RiskService } from '../risk/risk.service';

/** Frontend-safe view of ONE pending SEMI_AUTO confirmation (full order detail). */
export interface PendingExecutionConfirmationView {
  id: string;
  signalId: string;
  sessionId: string;
  sessionGeneration: number;
  brokerConnectionId: string;
  riskGrantId: string | null;
  instrument: string;
  direction: string;
  quantity: string;
  stopLoss: string | null;
  takeProfit: string | null;
  orderPayloadDigest: string;
  /** Full order detail from the bound RiskGrant's authoritative payload. */
  orderPayload: {
    orderType: string;
    requestedPrice: string | null;
    marketRegime: string | null;
  } | null;
  executionMode: string | null;
  createdAt: string;
  expiresAt: string;
}

/** The result of a successful one-time confirmation. */
export interface ExecutionConfirmationResult {
  confirmationId: string;
  /** CONSUMED is the ONLY success status — never fabricated. */
  status: 'CONSUMED';
  tradeId: string;
  tradeStatus: string;
}

/**
 * Round 6 (§18): the fresh CURRENT risk evaluation changed material order
 * facts beyond the explicitly permitted MARKET current-quote semantics (lot
 * size capped, different SL/TP, instrument or direction). The changed order
 * is NEVER silently dispatched — the user must confirm the NEW proposal.
 */
export class ReconfirmationRequiredException extends Error {
  constructor(details: {
    confirmationId: string;
    confirmed: {
      instrument: string;
      direction: string;
      quantity: string;
      stopLoss: string | null;
      takeProfit: string | null;
    };
    fresh: {
      instrument: string;
      direction: string;
      quantity: string;
      stopLoss: string;
      takeProfit: string;
    };
  }) {
    super(
      `Reconfirmation required for confirmation ${details.confirmationId}: the fresh risk ` +
        `evaluation changed material order facts (confirmed ${details.confirmed.quantity} ` +
        `${details.confirmed.direction} ${details.confirmed.instrument} → fresh ` +
        `${details.fresh.quantity} ${details.fresh.direction} ${details.fresh.instrument}) — ` +
        'the changed order is never silently dispatched.',
    );
    this.name = 'ReconfirmationRequiredException';
    this.details = details;
  }
  readonly details: unknown;
}

/**
 * ExecutionConfirmationService — the server-authoritative SEMI_AUTO
 * confirmation surface (Sprint 56 correction round 5, task 50-c, issue #298).
 *
 *  - listPending(userId): ONLY the authenticated user's PENDING confirmations,
 *    joined with the bound RiskGrant's authoritative order payload (full
 *    order detail: order type, requested price, market regime).
 *  - confirm(userId, confirmationId): drives the FINAL DISPATCH BOUNDARY's
 *    USER_CONFIRMATION origin — the one-time confirmation AND the RiskGrant
 *    are consumed atomically (CAS, single winner) and the authorized dispatch
 *    executes immediately. The frontend can never fabricate approval: only
 *    this server path consumes a confirmation.
 *
 * Typed 409-style failures (expired / consumed / revoked / generation
 * mismatch / grant or session drift) propagate from
 * FinalDispatchBlockedException — they are NEVER silently retried.
 */
@Injectable()
export class ExecutionConfirmationService {
  private readonly logger = new Logger(ExecutionConfirmationService.name);

  constructor(
    @InjectRepository(ExecutionConfirmation)
    private readonly confirmationRepo: Repository<ExecutionConfirmation>,
    @InjectRepository(RiskGrant)
    private readonly riskGrantRepo: Repository<RiskGrant>,
    @InjectRepository(RiskProfile)
    private readonly riskProfileRepo: Repository<RiskProfile>,
    private readonly boundary: FinalDispatchBoundary,
    private readonly executionService: ExecutionService,
    // Round 6 (§18): resolved at CALL time — constructor-injecting RiskService
    // here would stack a provider-level dependency onto the existing
    // RiskModule↔ExecutionModule forwardRef cycle (the crash pattern).
    private readonly moduleRef: ModuleRef,
  ) {}

  /** The user's PENDING confirmations with full order detail. */
  async listPending(userId: string): Promise<PendingExecutionConfirmationView[]> {
    const confirmations = await this.confirmationRepo.find({
      where: { userId, status: ExecutionConfirmationStatus.PENDING },
      order: { createdAt: 'ASC' },
    });
    if (confirmations.length === 0) return [];

    const grants = await this.riskGrantRepo.find({
      where: { signalId: In(confirmations.map((c) => c.signalId)) },
      order: { issuedAt: 'DESC' },
    });
    const grantBySignal = new Map<string, RiskGrant>();
    for (const grant of grants) {
      const existing = grantBySignal.get(grant.signalId);
      if (!existing || grant.issuedAt > existing.issuedAt) {
        grantBySignal.set(grant.signalId, grant);
      }
    }

    return confirmations.map((c) => this.toView(c, grantBySignal.get(c.signalId) ?? null));
  }

  /**
   * Confirm ONE pending confirmation (server authority): consume the
   * confirmation + grant through the final dispatch boundary and execute the
   * authorized dispatch. Exactly one caller wins; replays and drift fail
   * with typed 409-style errors.
   */
  async confirm(userId: string, confirmationId: string): Promise<ExecutionConfirmationResult> {
    // ── ROUND 6 (§18/#298): the SEMI_AUTO re-risk model ────────────────────
    // A confirmation is the user's intent to approve the EXACT proposed order
    // — NEVER a five-minute-old financial authorization. Confirming triggers
    // a FULL CURRENT risk re-evaluation (authority, fresh snapshot, quote,
    // geometry, limits, policy); the FRESH short-lived grant drives the
    // dispatch and is consumed — together with this confirmation — at the
    // provider-dispatch commitment.
    const confirmation = await this.confirmationRepo.findOne({
      where: { id: confirmationId, userId, status: ExecutionConfirmationStatus.PENDING },
    });
    if (!confirmation) {
      throw new ConflictException(
        'No PENDING confirmation found for this id and user — it may already be consumed, ' +
          'revoked, or belong to another account.',
      );
    }
    if (confirmation.expiresAt.getTime() <= Date.now()) {
      throw new ConflictException(
        'This confirmation window has expired — a new risk evaluation is required.',
      );
    }

    // CURRENT risk re-evaluation. ModuleRef at CALL time: constructor-injecting
    // RiskService would stack a provider dependency onto the existing
    // RiskModule↔ExecutionModule forwardRef cycle.
    const riskService = this.moduleRef.get(RiskService, { strict: false });
    const decision: RiskDecision = await riskService.validateProposedTrade(userId, {
      signalId: confirmation.signalId,
      instrument: confirmation.instrument,
      direction: confirmation.direction as 'BUY' | 'SELL',
      requestedLotSize: String(confirmation.quantity),
      // MARKET sentinel ('0'): the original authorization was a MARKET
      // instruction — current-quote risk semantics apply (§18).
      entryPrice: '0',
      stopLoss: confirmation.stopLoss ?? undefined,
      takeProfit: confirmation.takeProfit ?? undefined,
      idempotencyKey: `${userId}:${confirmation.signalId}`,
      sessionId: confirmation.sessionId,
      sessionGeneration: confirmation.sessionGeneration,
      executionMode: ExecutionMode.SEMI_AUTO,
      brokerConnectionId: confirmation.brokerConnectionId,
    });

    if (decision.decision !== 'APPROVED') {
      // Fresh risk rejection ⇒ ZERO provider calls (fail-closed).
      this.logger.warn(
        `SEMI_AUTO confirmation ${confirmationId} rejected by CURRENT risk: ` +
          `[${decision.rejectionCode}] ${decision.rejectionReason}`,
      );
      throw new ConflictException(
        `Current risk evaluation rejected this order (${decision.rejectionCode}) — ` +
          'the confirmation was not executed.',
      );
    }

    // Material-change check: the fresh validated order must match the EXACT
    // proposal the user confirmed. A changed lot size (risk cap), different
    // SL/TP, instrument or direction requires RECONFIRMATION — never a
    // silent dispatch of the changed order.
    const confirmedQuantity = String(confirmation.quantity);
    const materialChange =
      decision.validatedOrder.instrument !== confirmation.instrument ||
      decision.validatedOrder.direction !== confirmation.direction ||
      decision.validatedOrder.lotSize !== confirmedQuantity ||
      (confirmation.stopLoss != null && decision.validatedOrder.stopLoss !== confirmation.stopLoss) ||
      (confirmation.takeProfit != null &&
        decision.validatedOrder.takeProfit !== confirmation.takeProfit);
    if (materialChange) {
      this.logger.warn(
        `SEMI_AUTO confirmation ${confirmationId} requires reconfirmation — the fresh ` +
          'evaluation changed material order facts',
      );
      throw new ReconfirmationRequiredException({
        confirmationId,
        confirmed: {
          instrument: confirmation.instrument,
          direction: confirmation.direction,
          quantity: confirmedQuantity,
          stopLoss: confirmation.stopLoss,
          takeProfit: confirmation.takeProfit,
        },
        fresh: {
          instrument: decision.validatedOrder.instrument,
          direction: decision.validatedOrder.direction,
          quantity: decision.validatedOrder.lotSize,
          stopLoss: decision.validatedOrder.stopLoss,
          takeProfit: decision.validatedOrder.takeProfit,
        },
      });
    }

    const trade: Trade = await this.executionService.executeTrade(
      userId,
      decision,
      confirmationId,
    );

    return {
      confirmationId,
      status: 'CONSUMED',
      tradeId: trade.id,
      tradeStatus: trade.status,
    };
  }

  // ─── Internal helpers ─────────────────────────────────────────────────────

  private toView(
    confirmation: ExecutionConfirmation,
    grant: RiskGrant | null,
  ): PendingExecutionConfirmationView {
    const payload = grant?.orderPayload ?? null;
    return {
      id: confirmation.id,
      signalId: confirmation.signalId,
      sessionId: confirmation.sessionId,
      sessionGeneration: confirmation.sessionGeneration,
      brokerConnectionId: confirmation.brokerConnectionId,
      riskGrantId: confirmation.riskGrantId,
      instrument: confirmation.instrument,
      direction: confirmation.direction,
      quantity: String(confirmation.quantity ?? ''),
      stopLoss: confirmation.stopLoss == null ? null : String(confirmation.stopLoss),
      takeProfit: confirmation.takeProfit == null ? null : String(confirmation.takeProfit),
      orderPayloadDigest: confirmation.orderPayloadDigest,
      orderPayload: payload
        ? {
            orderType: String(payload.orderType ?? 'MARKET'),
            requestedPrice: payload.requestedPrice == null ? null : String(payload.requestedPrice),
            marketRegime: payload.marketRegime == null ? null : String(payload.marketRegime),
          }
        : null,
      executionMode: (grant?.executionMode as ExecutionMode | undefined) ?? null,
      createdAt: confirmation.createdAt.toISOString(),
      expiresAt: confirmation.expiresAt.toISOString(),
    };
  }
}
