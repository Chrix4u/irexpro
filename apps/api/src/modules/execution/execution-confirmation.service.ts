import { ConflictException, Injectable, Logger } from '@nestjs/common';
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
    const authorization = await this.boundary.authorizeFromUserConfirmation({
      userId,
      confirmationId,
    });

    // The consumed grant is the server-side authority for the exact order.
    if (!authorization.context.riskGrantId) {
      throw new ConflictException(
        'The confirmed authorization carries no risk grant — refusing dispatch (fail-closed).',
      );
    }
    const grant = await this.riskGrantRepo.findOne({
      where: { id: authorization.context.riskGrantId },
    });
    if (!grant) {
      throw new ConflictException(
        'The confirmed order risk grant is no longer available — the confirmation was consumed ' +
          '(server authority) but no dispatch happened. A new risk evaluation is required.',
      );
    }

    const decision = await this.decisionFromGrant(userId, grant);
    // Round 6 (#365/#18): the confirmation is consumed AT the provider-dispatch
    // commitment (commitProviderDispatch, tenant + grant scoped CAS) — this
    // call carries the confirmationId through to the orchestrator.
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

  /** Rebuild the execution decision from the CONSUMED grant (server authority). */
  private async decisionFromGrant(userId: string, grant: RiskGrant): Promise<RiskDecision> {
    const payload = grant.orderPayload ?? ({} as Record<string, unknown>);
    const instrument = String(payload.instrument ?? '');
    const direction = String(payload.direction ?? '');
    const lotSize = String(payload.quantity ?? '');
    const stopLoss = payload.stopLoss == null ? null : String(payload.stopLoss);
    const takeProfit = payload.takeProfit == null ? null : String(payload.takeProfit);
    if (!instrument || !direction || !lotSize || stopLoss === null || takeProfit === null) {
      // The grant's authoritative payload is incomplete — fail closed (the
      // exact validated order cannot be reconstructed).
      throw new ConflictException(
        'The confirmed order payload is incomplete — refusing to reconstruct the order ' +
          '(fail-closed). A new risk evaluation is required.',
      );
    }

    // Daily-limit authority: the CURRENT risk profile's maxDailyTrades (the
    // grant pins the risk profile id/version — a missing profile fails closed).
    const profile = grant.riskProfileId
      ? await this.riskProfileRepo.findOne({ where: { id: grant.riskProfileId } })
      : await this.riskProfileRepo.findOne({ where: { userId } });
    if (!profile) {
      throw new ConflictException(
        'No risk profile available for the daily-trade limit — refusing dispatch (fail-closed).',
      );
    }

    return {
      decision: 'APPROVED',
      signalId: grant.signalId,
      validatedOrder: {
        instrument,
        direction: direction as 'BUY' | 'SELL',
        lotSize,
        entryPrice: payload.requestedPrice == null ? '0' : String(payload.requestedPrice),
        stopLoss,
        takeProfit,
        idempotencyKey: `${userId}:${grant.signalId}`,
      },
      appliedRules: ['SEMI_AUTO_USER_CONFIRMATION:CONSUMED'],
      riskScore: 0,
      evaluatedAt: grant.issuedAt,
      maxDailyTrades: profile.maxDailyTrades,
      grantId: grant.id,
      sessionId: grant.sessionId,
      sessionGeneration: grant.sessionGeneration,
      executionMode: grant.executionMode as string,
      brokerConnectionId: grant.brokerConnectionId,
    };
  }

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
