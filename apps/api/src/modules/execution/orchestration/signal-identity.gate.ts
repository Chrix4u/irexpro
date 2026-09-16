import { BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AiSignalIdentity } from '../entities/ai-signal-identity.entity';
import { AiSignalIdentityStatus, digestCanonicalPayload } from '../interfaces/execution-authority';
import { AuditService } from '../../audit/audit.service';
import { AuditAction } from '../../../common/enums/audit-action.enum';
import { AuditSeverity } from '../../audit/entities/audit-log.entity';

/**
 * Signal freshness constants (architect issue #302). A production signal is
 * only eligible for evaluation while it is FRESH: not older than
 * SIGNAL_MAX_AGE_MS and not further in the future than SIGNAL_FUTURE_SKEW_MS
 * (producer clock skew tolerance).
 */
export const SIGNAL_MAX_AGE_MS = 120_000; // 120s
export const SIGNAL_FUTURE_SKEW_MS = 30_000; // 30s

/** The material trading-input fields pinned by the signal payload digest. */
export interface SignalIdentityInput {
  signalId: string;
  /** Producer-assigned generation timestamp (freshness + future-skew checks). */
  generatedAt: Date | string | null;
  /** Material trading inputs — snapshotted for conflict detection. */
  materialFields: Record<string, unknown>;
}

/** The durable identity outcome of a signal delivery. */
export interface SignalIdentityRegistration {
  identityId: string;
  signalId: string;
  payloadDigest: string;
  /** True when this delivery re-delivered an already-registered signal. */
  duplicate: boolean;
  /**
   * The PERSISTED authoritative original generatedAt (round 6, #302): on a
   * duplicate re-delivery this is the FIRST registration's timestamp — the
   * producer instant is immutable identity evidence and can never be
   * refreshed forward by a replay.
   */
  generatedAt: Date;
}

/** signalId is MANDATORY for production signals (typed rejection). */
export class SignalIdentityRequiredException extends BadRequestException {
  constructor() {
    super({
      code: 'SIGNAL_IDENTITY_REQUIRED',
      message:
        'signalId is mandatory for production signals — the producer must assign a stable ' +
        'identifier BEFORE network delivery (HTTP retries may never mint fresh identities).',
    });
  }
}

/** generatedAt is mandatory (freshness cannot be enforced without it). */
export class SignalGeneratedAtRequiredException extends BadRequestException {
  constructor() {
    super({
      code: 'SIGNAL_GENERATED_AT_REQUIRED',
      message: 'Signal generatedAt is required (freshness + future-skew enforcement).',
    });
  }
}

/** Stale signal — older than SIGNAL_MAX_AGE_MS. */
export class SignalStaleException extends BadRequestException {
  constructor(generatedAt: Date, ageMs: number) {
    super({
      code: 'SIGNAL_STALE',
      message: `Signal is stale (generatedAt ${generatedAt.toISOString()}, age ${Math.round(ageMs / 1000)}s > ${SIGNAL_MAX_AGE_MS / 1000}s max).`,
    });
  }
}

/** Future-dated signal beyond the producer clock-skew tolerance. */
export class SignalFutureException extends BadRequestException {
  constructor(generatedAt: Date, skewMs: number) {
    super({
      code: 'SIGNAL_FUTURE',
      message: `Signal generatedAt is in the future beyond the ${SIGNAL_FUTURE_SKEW_MS / 1000}s skew tolerance (${generatedAt.toISOString()}, skew ${Math.round(skewMs / 1000)}s).`,
    });
  }
}

/**
 * SAME signalId + DIFFERENT canonical payload digest — a SECURITY EVENT
 * (architect issue #302): never a new logical signal, never a fresh
 * idempotency key. The conflicting delivery is typed-rejected and audited.
 * Round 6: generatedAt is part of the digest, so a replay with a MOVED
 * timestamp is exactly this conflict — a replay can never refresh an old
 * signal's time forward.
 */
export class SignalIdentityConflictException extends ConflictException {
  readonly existingIdentityId: string;
  readonly signalId: string;
  constructor(details: {
    signalId: string;
    existingIdentityId: string;
    existingDigest: string;
    deliveredDigest: string;
    /** Persisted original generatedAt (ISO UTC) — null only for legacy rows. */
    existingGeneratedAt: string | null;
    /** The delivered (conflicting) generatedAt (ISO UTC). */
    deliveredGeneratedAt: string;
    /** True when the delivered timestamp differs from the persisted original. */
    generatedAtShifted: boolean;
  }) {
    super({
      code: 'SIGNAL_IDENTITY_CONFLICT',
      message:
        `Signal ${details.signalId} was already registered with a DIFFERENT canonical ` +
        'payload digest (material fields or generatedAt) — same identifier may ' +
        'never carry two payloads (security event).',
      ...details,
    });
    this.signalId = details.signalId;
    this.existingIdentityId = details.existingIdentityId;
  }
}

/**
 * AiSignalIdentityGate — the pipeline-entry signal-identity gate (Sprint 56
 * correction round 5, task 50-c, architect issue #302).
 *
 * Called at the strategy→execution handoff BEFORE risk evaluation:
 *  - persist-or-reuse AiSignalIdentity by (userId, signalId);
 *  - same signalId + SAME canonical digest (material fields AND the exact
 *    generatedAt instant — round 6, #302) → idempotent PROCEED (retries and
 *    redeliveries never produce a second logical evaluation);
 *  - same signalId + DIFFERENT digest (changed material OR moved timestamp)
 *    → typed conflict (security event; a new idempotency key is NEVER minted
 *    for it);
 *  - generatedAt freshness enforced on the DELIVERED timestamp (max age
 *    120s, future skew 30s) — stale/future signals are typed-rejected;
 *  - signalId is mandatory for production signals.
 */
@Injectable()
export class AiSignalIdentityGateService {
  private readonly logger = new Logger(AiSignalIdentityGateService.name);

  constructor(
    @InjectRepository(AiSignalIdentity)
    private readonly identityRepo: Repository<AiSignalIdentity>,
    private readonly auditService: AuditService,
  ) {}

  /**
   * Register (or idempotently re-use) the durable identity of one signal
   * delivery. THROWS the typed rejections above; never silently proceeds on
   * conflicting or stale material.
   */
  async registerOrReuse(
    userId: string,
    signal: SignalIdentityInput,
  ): Promise<SignalIdentityRegistration> {
    // ── Mandatory identity ─────────────────────────────────────────────────
    const signalId = typeof signal.signalId === 'string' ? signal.signalId.trim() : '';
    if (!signalId) {
      throw new SignalIdentityRequiredException();
    }

    // ── Freshness (max age + future skew) ──────────────────────────────────
    const generatedAt = this.toDate(signal.generatedAt);
    if (!generatedAt) {
      throw new SignalGeneratedAtRequiredException();
    }
    const now = Date.now();
    const age = now - generatedAt.getTime();
    if (age > SIGNAL_MAX_AGE_MS) {
      throw new SignalStaleException(generatedAt, age);
    }
    if (-age > SIGNAL_FUTURE_SKEW_MS) {
      throw new SignalFutureException(generatedAt, -age);
    }

    // ── Canonical payload digest of the material trading inputs ───────────
    // Round 6 (#302): the producer timestamp is IMMUTABLE identity evidence
    // and is part of the digest. Same material + the exact same canonical
    // instant → idempotent duplicate; a DIFFERENT instant is a different
    // payload (SIGNAL_IDENTITY_CONFLICT) — a replay can never refresh an old
    // signal's time forward.
    const payloadDigest = await digestCanonicalPayload({
      signalId,
      generatedAt: generatedAt.toISOString(),
      materialFields: signal.materialFields,
    });

    // ── Persist-or-reuse by (userId, signalId) ─────────────────────────────
    try {
      const identity = await this.identityRepo.save(
        this.identityRepo.create({
          userId,
          signalId,
          payloadDigest,
          materialFields: signal.materialFields,
          generatedAt,
          receivedAt: new Date(),
          status: AiSignalIdentityStatus.RECEIVED,
        }),
      );
      return {
        identityId: identity.id,
        signalId,
        payloadDigest,
        duplicate: false,
        generatedAt: this.persistedDate(identity.generatedAt),
      };
    } catch (err) {
      if (!this.isUniqueViolation(err)) {
        throw err;
      }
      // (userId, signalId) already registered — idempotency OR conflict.
      const existing = await this.identityRepo.findOne({ where: { userId, signalId } });
      if (!existing) {
        throw err; // vanished between violation and re-read — fail closed
      }
      if (existing.payloadDigest !== payloadDigest) {
        // SECURITY EVENT: same identifier, different canonical payload
        // (changed material fields and/or a moved generatedAt).
        const existingGeneratedAtIso =
          existing.generatedAt instanceof Date
            ? existing.generatedAt.toISOString()
            : existing.generatedAt
              ? new Date(existing.generatedAt).toISOString()
              : null;
        const generatedAtShifted =
          existingGeneratedAtIso !== null &&
          new Date(existingGeneratedAtIso).getTime() !== generatedAt.getTime();
        await this.auditService.log({
          actorUserId: userId,
          action: AuditAction.AI_SIGNAL_IDENTITY_CONFLICT,
          resourceType: 'AiSignalIdentity',
          resourceId: existing.id,
          severity: AuditSeverity.CRITICAL,
          metadata: {
            signalId,
            existingDigest: existing.payloadDigest,
            deliveredDigest: payloadDigest,
            existingGeneratedAt: existingGeneratedAtIso,
            deliveredGeneratedAt: generatedAt.toISOString(),
            generatedAtShifted,
          },
        });
        throw new SignalIdentityConflictException({
          signalId,
          existingIdentityId: existing.id,
          existingDigest: existing.payloadDigest,
          deliveredDigest: payloadDigest,
          existingGeneratedAt: existingGeneratedAtIso,
          deliveredGeneratedAt: generatedAt.toISOString(),
          generatedAtShifted,
        });
      }
      // Same digest — idempotent re-delivery: proceed with the SAME identity
      // (and the PERSISTED original generatedAt — never the replay's clock).
      return {
        identityId: existing.id,
        signalId,
        payloadDigest,
        duplicate: true,
        generatedAt: this.persistedDate(existing.generatedAt),
      };
    }
  }

  /** Mark the identity PROCESSED (first successful evaluation completion). */
  async markProcessed(userId: string, signalId: string): Promise<void> {
    await this.identityRepo
      .createQueryBuilder()
      .update()
      .set({
        status: AiSignalIdentityStatus.PROCESSED,
        firstProcessedAt: new Date(),
      })
      .where('user_id = :userId AND signal_id = :signalId AND first_processed_at IS NULL', {
        userId,
        signalId,
      })
      .execute();
  }

  /** SQLSTATE 23505 / sqlite unique-violation detection. */
  private isUniqueViolation(err: unknown): boolean {
    const candidate = err as { code?: string; message?: string };
    if (candidate?.code === '23505' || candidate?.code === 'SQLITE_CONSTRAINT') return true;
    const msg = candidate?.message ?? '';
    return (
      msg.includes('23505') ||
      msg.includes('duplicate key value') ||
      msg.includes('UNIQUE constraint failed')
    );
  }

  private toDate(value: Date | string | null): Date | null {
    if (value === null || value === undefined) return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  /** Coerce a persisted timestamp back to a Date (defensive vs. drivers). */
  private persistedDate(value: Date | string): Date {
    return value instanceof Date ? value : new Date(value);
  }
}
