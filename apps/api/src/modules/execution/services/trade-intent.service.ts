import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TradeIntent, TradeIntentStatus } from '../entities/trade-intent.entity';
import { isUniqueViolation } from '../../broker/utils/db-unique-violation';
import { ExactDecimal } from '../../../common/utils/exact-decimal';
import { EXECUTION_CONFIRMATION_WINDOW_MS, RISK_GRANT_TTL_MS } from '../../risk/risk-grant.service';

/**
 * INTENT_MAX_AGE_MS — §2: a stale AI decision must not create new exposure.
 * The intent's expiry bounds the ENTRY decision validity measured from the
 * ORIGINAL producer generatedAt (never from a replay's delivery time).
 *
 * ALIGNED with the downstream approval chain by construction: a decision can
 * at most outlive its grant by the SEMI_AUTO confirmation window —
 * RISK_GRANT_TTL_MS (60s) + EXECUTION_CONFIRMATION_WINDOW_MS (300s) — so the
 * full user-confirmation path stays usable while any decision older than
 * that window is STALE and fails closed at the execution gate.
 */
export const INTENT_MAX_AGE_MS = RISK_GRANT_TTL_MS + EXECUTION_CONFIRMATION_WINDOW_MS;

/** Typed outcome of recordOrReuseIntent. */
export type TradeIntentRegistration =
  | { created: true; intent: TradeIntent }
  | { created: false; intent: TradeIntent; reused: true };

/** Typed failure — the intent exists but is no longer usable for execution. */
export class TradeIntentNotUsableError extends Error {
  constructor(
    readonly intentId: string,
    readonly status: TradeIntentStatus,
    readonly reason: string,
  ) {
    super(`Trade intent ${intentId} is not usable for new exposure (status: ${status}): ${reason}`);
    this.name = 'TradeIntentNotUsableError';
  }
}

/** The intent facts the pipeline records at signal intake (§2). */
export interface TradeIntentFacts {
  userId: string;
  signalId: string;
  signalGeneratedAt: Date;
  brokerConnectionId: string;
  logicalAccountKey: string | null;
  tradingSessionId: string | null;
  strategyCode: string | null;
  modelVersion: string | null;
  timeframe: string | null;
  instrument: string;
  direction: 'BUY' | 'SELL';
  requestedLotSize: string;
  requestedEntryPrice: string | null;
  stopLoss: string | null;
  takeProfit: string | null;
  trailingStopPips: string | null;
  rationale: string | null;
  metadata: Record<string, unknown> | null;
  /** Authority/policy generations CURRENT at creation (§2 requirement). */
  authorityGeneration: number;
  tradingPolicyRevision: number | null;
  providerVerificationRevision: number | null;
  executionControlRevision: number | null;
}

/**
 * TradeIntentService — the durable normalized TradeIntent layer
 * (Round 6 live-execution completion §2).
 *
 * DESIGN CONTRACT
 * ───────────────
 *  - recordOrReuseIntent is IDEMPOTENT per (userId, intentKey): the UNIQUE
 *    (user_id, intent_key) backstop converts a concurrent duplicate into a
 *    re-read of the winner — retries, reconnects, worker restarts and queue
 *    redelivery can NEVER create a second equivalent intent (§13 step 1).
 *  - Entry type derivation: a decision carrying a usable requested entry
 *    price is a LIMIT intent; otherwise MARKET. The '0' MARKET sentinel from
 *    the signal layer is normalized to a NULL requested price (never a
 *    fabricated limit price of zero).
 *  - Expiry is computed from the ORIGINAL signal generatedAt (the
 *    identity-gate-registered instant — a replay can never refresh it).
 *  - Authority/policy generations at creation are read fail-closed upstream
 *    (TradingAuthorityService/SharedControlRevisionService) and persisted
 *    verbatim — the §20 reconstruction chain starts here.
 *  - markExecuted/markRejected/markExpired are guarded CAS writes: a
 *    terminal intent never transitions back; EXECUTED binds the trade id.
 */
@Injectable()
export class TradeIntentService {
  private readonly logger = new Logger(TradeIntentService.name);

  constructor(
    @InjectRepository(TradeIntent)
    private readonly intentRepo: Repository<TradeIntent>,
  ) {}

  /** Derive the normalized entry type from the decision's price facts. */
  static deriveEntryType(requestedEntryPrice: string | null): 'MARKET' | 'LIMIT' {
    if (requestedEntryPrice === null) return 'MARKET';
    const parsed = ExactDecimal.tryParse(requestedEntryPrice);
    // '0' is the signal layer's MARKET sentinel — not a limit price.
    if (!parsed || parsed.isZero() || !parsed.isPositive()) return 'MARKET';
    return 'LIMIT';
  }

  /** Normalize the requested price: the MARKET sentinel becomes null. */
  static normalizeRequestedPrice(requestedEntryPrice: string | null): string | null {
    if (requestedEntryPrice === null) return null;
    const parsed = ExactDecimal.tryParse(requestedEntryPrice);
    if (!parsed || parsed.isZero() || !parsed.isPositive()) return null;
    return requestedEntryPrice;
  }

  /** The stable intent identity key (§2: stable unique identity). */
  static intentKeyFor(userId: string, signalId: string): string {
    return `${userId}:${signalId}`;
  }

  /**
   * Record (or reuse) the durable TradeIntent for ONE AI decision.
   *
   * The insert races on UNIQUE (user_id, intent_key): the loser re-reads the
   * winner's row and returns it as reused=true — never a second intent.
   */
  async recordOrReuseIntent(facts: TradeIntentFacts): Promise<TradeIntentRegistration> {
    const intentKey = TradeIntentService.intentKeyFor(facts.userId, facts.signalId);
    const normalizedPrice = TradeIntentService.normalizeRequestedPrice(facts.requestedEntryPrice);
    const expiresAt = new Date(facts.signalGeneratedAt.getTime() + INTENT_MAX_AGE_MS);

    const intent = this.intentRepo.create({
      userId: facts.userId,
      intentKey,
      signalId: facts.signalId,
      signalGeneratedAt: facts.signalGeneratedAt,
      brokerConnectionId: facts.brokerConnectionId,
      logicalAccountKey: facts.logicalAccountKey,
      tradingSessionId: facts.tradingSessionId,
      strategyCode: facts.strategyCode,
      modelVersion: facts.modelVersion,
      timeframe: facts.timeframe,
      instrument: facts.instrument,
      direction: facts.direction,
      entryType: TradeIntentService.deriveEntryType(facts.requestedEntryPrice),
      requestedLotSize: facts.requestedLotSize,
      requestedEntryPrice: normalizedPrice,
      stopLoss: facts.stopLoss,
      takeProfit: facts.takeProfit,
      trailingStopPips: facts.trailingStopPips,
      expiresAt,
      marketDataRef: null,
      rationale: facts.rationale,
      metadata: facts.metadata,
      authorityGeneration: facts.authorityGeneration,
      tradingPolicyRevision: facts.tradingPolicyRevision,
      providerVerificationRevision: facts.providerVerificationRevision,
      executionControlRevision: facts.executionControlRevision,
      status: TradeIntentStatus.CREATED,
    });

    try {
      const saved = await this.intentRepo.save(intent);
      return { created: true, intent: saved };
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // A concurrent worker (or a retry/redelivery) created the intent
      // first — the winner's row is the truth. Re-read and reuse.
      const existing = await this.intentRepo.findOne({
        where: { userId: facts.userId, intentKey },
      });
      if (!existing) {
        // Vanished after the unique violation — an honest re-read failure.
        throw err;
      }
      this.logger.log(
        `Trade intent reused for signal=${facts.signalId} user=${facts.userId} ` +
          `(status=${existing.status}) — exactly-once intent identity`,
      );
      return { created: false, intent: existing, reused: true };
    }
  }

  /**
   * Find the intent for (userId, signalId) — null when none was recorded.
   */
  async findBySignal(userId: string, signalId: string): Promise<TradeIntent | null> {
    return this.intentRepo.findOne({
      where: { userId, intentKey: TradeIntentService.intentKeyFor(userId, signalId) },
    });
  }

  /**
   * Resolve the intent for execution by (userId, signalId) — the lookup the
   * execution path uses (executeTrade knows the signal, not the intent id).
   */
  async resolveIntentForExecutionBySignal(userId: string, signalId: string): Promise<TradeIntent> {
    const intent = await this.findBySignal(userId, signalId);
    if (!intent) {
      throw new TradeIntentNotUsableError(
        signalId,
        TradeIntentStatus.REJECTED,
        'no trade intent recorded for this signal — intents are recorded at signal intake',
      );
    }
    return this.assertIntentUsable(intent);
  }

  /**
   * Resolve the intent for execution by id — a stale/expired or terminal
   * intent fails closed with a typed error (§2: a stale/expired/replaced AI
   * decision must not create new exposure).
   */
  async resolveIntentForExecution(intentId: string, userId: string): Promise<TradeIntent> {
    const intent = await this.intentRepo.findOne({
      where: { id: intentId, userId },
    });
    if (!intent) {
      throw new TradeIntentNotUsableError(intentId, TradeIntentStatus.REJECTED, 'not found');
    }
    return this.assertIntentUsable(intent);
  }

  /** The §2 usability guard — every terminal or stale state fails closed. */
  private async assertIntentUsable(intent: TradeIntent): Promise<TradeIntent> {
    if (intent.status === TradeIntentStatus.EXPIRED) {
      throw new TradeIntentNotUsableError(intent.id, intent.status, 'intent expired');
    }
    if (intent.status === TradeIntentStatus.SUPERSEDED) {
      throw new TradeIntentNotUsableError(intent.id, intent.status, 'intent superseded');
    }
    if (intent.status === TradeIntentStatus.EXECUTED) {
      throw new TradeIntentNotUsableError(intent.id, intent.status, 'already executed');
    }
    if (intent.status === TradeIntentStatus.REJECTED) {
      throw new TradeIntentNotUsableError(intent.id, intent.status, 'previously rejected');
    }
    // CREATED — enforce the expiry against CURRENT time (a redelivery near
    // the boundary or a stalled worker cannot resurrect a stale decision).
    if (intent.expiresAt.getTime() <= Date.now()) {
      await this.markExpired(intent.id);
      throw new TradeIntentNotUsableError(
        intent.id,
        TradeIntentStatus.EXPIRED,
        `expired at ${intent.expiresAt.toISOString()}`,
      );
    }
    return intent;
  }

  /** Guarded CAS transition to EXECUTED — binds the created trade id. */
  async markExecuted(intentId: string, tradeId: string): Promise<void> {
    await this.intentRepo
      .createQueryBuilder()
      .update()
      .set({ status: TradeIntentStatus.EXECUTED, tradeId, updatedAt: new Date() })
      .where('id = :id AND status = :status', {
        id: intentId,
        status: TradeIntentStatus.CREATED,
      })
      .execute();
  }

  /** Guarded CAS transition to REJECTED (risk/control rejection). */
  async markRejected(intentId: string): Promise<void> {
    await this.intentRepo
      .createQueryBuilder()
      .update()
      .set({ status: TradeIntentStatus.REJECTED, updatedAt: new Date() })
      .where('id = :id AND status = :status', {
        id: intentId,
        status: TradeIntentStatus.CREATED,
      })
      .execute();
  }

  /** Guarded transition to EXPIRED (lazily applied on resolution). */
  async markExpired(intentId: string): Promise<void> {
    await this.intentRepo
      .createQueryBuilder()
      .update()
      .set({ status: TradeIntentStatus.EXPIRED, updatedAt: new Date() })
      .where('id = :id AND status = :status', {
        id: intentId,
        status: TradeIntentStatus.CREATED,
      })
      .execute();
  }
}
