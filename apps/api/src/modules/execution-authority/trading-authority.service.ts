import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository, UpdateResult } from 'typeorm';
import { TradingAuthorityGeneration } from '../users/entities/trading-authority-generation.entity';
import { isUniqueViolation } from '../broker/utils/db-unique-violation';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../../common/enums/audit-action.enum';

/**
 * TradingAuthorityService — the SINGLE server-authoritative per-user monotonic
 * trading-authority generation mechanism (Sprint 56 correction round 6,
 * architect issue #300).
 *
 * SEMANTICS (documented per the architect brief):
 *  - FAIL-CLOSED READS: an unreadable authority store is NEVER "generation 1".
 *    getCurrentGeneration either returns a generation that a durable row
 *    proves, or throws AuthorityStoreUnavailableError carrying the cause.
 *    The forbidden pattern is RiskService's legacy `?? 1` default.
 *  - ATOMIC INITIALIZATION: an absent row is seeded with generation 1 by a
 *    SINGLE-STATEMENT guarded INSERT (createQueryBuilder().insert(), NOT
 *    repository.save() — save's implicit transaction loses the winner under
 *    concurrent seeding on the sqlite harness; proven by the round-6 probe).
 *    A concurrent initializer's unique violation re-reads the winner; a row
 *    that vanishes after the violation fails closed.
 *  - ATOMIC MONOTONIC BUMPS: bumpGeneration is a compare-and-set
 *    `generation = generation + 1` with an affected-rows check — concurrent
 *    bumps never lose an increment. 0 affected rows means the row is absent:
 *    a bump-safe guarded seed + ONE CAS retry converges (the seed is part of
 *    the bump, so a bump on a never-read user still bumps).
 *  - RE-READ RETURN VALUE: bumpGeneration returns the re-read NEW generation.
 *    Under concurrency the value may EXCEED the caller's own increment
 *    (another bump landed in between) but is NEVER lower than it.
 *  - TRANSACTION AWARENESS: the optional EntityManager parameter routes EVERY
 *    statement through the transaction's repository, so the caller's
 *    authority-changing fact (KYC decision, suspension, profile edit, broker
 *    transition) and the bump commit ATOMICALLY. The forbidden
 *    save-fact-then-best-effort-bump-later pattern is impossible to express.
 *
 * AUDIT: every bump is audited with the EXISTING generic
 * AuditAction.ADMIN_ACTION + metadata.actionType 'TRADING_AUTHORITY_GENERATION_BUMPED'
 * (the EligibilityService.reviewKyc precedent — the AuditAction enum file is
 * out of this task's scope, and NO existing enum value fits a generation
 * advance; the metadata.actionType strings already match the recommended
 * future dedicated enum values, so rows stay aligned when they land) PLUS a
 * structured logger.warn carrying reason + generation on every bump as
 * architect-mandated fallback evidence. An audit failure NEVER fails the
 * durable bump — the row is the truth.
 */
@Injectable()
export class TradingAuthorityService {
  private readonly logger = new Logger(TradingAuthorityService.name);

  constructor(
    @InjectRepository(TradingAuthorityGeneration)
    private readonly authorityRepo: Repository<TradingAuthorityGeneration>,
    private readonly auditService: AuditService,
  ) {}

  /**
   * The current trading-authority generation for a user.
   *
   *  - persisted row → its generation (proven, never defaulted);
   *  - absent row → single-statement guarded INSERT of generation 1 (the
   *    acceptable initial generation per the architect brief); a concurrent
   *    initializer that wins the unique race is re-read;
   *  - ANY database failure (read, insert, or the post-violation re-read)
   *    throws AuthorityStoreUnavailableError carrying the cause — this method
   *    NEVER silently returns 1 when the store is unavailable.
   */
  async getCurrentGeneration(userId: string, entityManager?: EntityManager): Promise<number> {
    const repo = this.repositoryFor(entityManager);

    let current: TradingAuthorityGeneration | null;
    try {
      current = await repo.findOne({ where: { userId } });
    } catch (err) {
      throw new AuthorityStoreUnavailableError('read current trading-authority generation', err);
    }
    if (current) return current.generation;

    // Absent ⇒ guarded single-statement INSERT of generation 1. This is an
    // autocommit INSERT (no implicit transaction), so a concurrent loser's
    // unique violation can never roll the winner's row back.
    try {
      await repo.createQueryBuilder().insert().values({ userId, generation: 1 }).execute();
      return 1;
    } catch (err) {
      if (isUniqueViolation(err)) {
        // A concurrent initializer won the uq_trading_authority_generation_user
        // slot — re-read and return the winner's generation.
        let winner: TradingAuthorityGeneration | null;
        try {
          winner = await repo.findOne({ where: { userId } });
        } catch (readErr) {
          throw new AuthorityStoreUnavailableError(
            're-read the winning trading-authority generation after a unique violation',
            readErr,
          );
        }
        if (!winner) {
          // The winner's row vanished between the violation and the re-read —
          // an integrity failure of the authority store. Fail closed; NEVER
          // fall back to generation 1.
          throw new AuthorityStoreUnavailableError(
            'trading-authority generation row vanished after a concurrent-seeding unique violation — failing closed',
            err,
          );
        }
        return winner.generation;
      }
      throw new AuthorityStoreUnavailableError('initialize trading-authority generation', err);
    }
  }

  /**
   * Atomically advance (bump) the user's trading-authority generation.
   *
   * CAS: `generation = generation + 1, last_reason, last_bumped_at,
   * updated_at WHERE user_id` with an affected-rows check:
   *  - 1 affected row → the durable bump landed; the NEW generation is
   *    re-read and returned (may exceed the caller's own increment under
   *    concurrency, never lower);
   *  - 0 affected rows → the row is absent: a bump-safe guarded seed of
   *    generation 1 (a concurrent seeding winner's unique violation is
   *    swallowed) plus ONE CAS retry; if that retry still affects 0 rows the
   *    store is inconsistent → fail closed;
   *  - any DB failure → AuthorityStoreUnavailableError carrying the cause.
   *
   * The reason MUST be one of the AUTHORITY_BUMP_REASONS allowlist codes —
   * an unknown code is rejected typed BEFORE any database access.
   */
  async bumpGeneration(
    userId: string,
    reason: AuthorityBumpReason,
    entityManager?: EntityManager,
  ): Promise<number> {
    if (!(AUTHORITY_BUMP_REASONS as readonly string[]).includes(reason)) {
      throw new AuthorityBumpReasonInvalidError(reason);
    }
    const repo = this.repositoryFor(entityManager);
    const now = new Date();

    const casBump = (): Promise<UpdateResult> =>
      repo
        .createQueryBuilder()
        .update()
        .set({
          generation: () => 'generation + 1',
          lastReason: reason,
          lastBumpedAt: now,
          updatedAt: now,
        })
        .where('user_id = :userId', { userId })
        .execute();

    let result: UpdateResult;
    try {
      result = await casBump();
    } catch (err) {
      throw new AuthorityStoreUnavailableError('bump trading-authority generation', err);
    }

    if ((result.affected ?? 0) === 0) {
      // Row absent (never initialized, or a racing reader has not committed
      // its seed yet). Seed generation 1 guardedly, then retry the CAS ONCE —
      // the seed is part of this bump, so the net effect is still +1 from a
      // clean baseline (a bump on a never-read user returns 2).
      try {
        await repo.createQueryBuilder().insert().values({ userId, generation: 1 }).execute();
      } catch (err) {
        if (!isUniqueViolation(err)) {
          throw new AuthorityStoreUnavailableError(
            'seed trading-authority generation for bump',
            err,
          );
        }
        // A concurrent seeder won — fall through to the retry CAS against
        // their row.
      }
      try {
        result = await casBump();
      } catch (err) {
        throw new AuthorityStoreUnavailableError('retry trading-authority generation bump', err);
      }
      if ((result.affected ?? 0) === 0) {
        throw new AuthorityStoreUnavailableError(
          'trading-authority generation bump did not converge after the guarded seed + retry — failing closed',
          null,
        );
      }
    }

    // Re-read the NEW generation: the CAS guarantees ≥ own increment; a
    // concurrent bump may already have advanced it further (never lower).
    let row: TradingAuthorityGeneration | null;
    try {
      row = await repo.findOne({ where: { userId } });
    } catch (err) {
      throw new AuthorityStoreUnavailableError(
        're-read the bumped trading-authority generation',
        err,
      );
    }
    if (!row) {
      throw new AuthorityStoreUnavailableError(
        'trading-authority generation row vanished after the bump — failing closed',
        null,
      );
    }

    this.logger.warn(
      `Trading authority generation for user ${userId} bumped to ${row.generation} (${reason})`,
    );
    await this.auditBump(userId, reason, row.generation);
    return row.generation;
  }

  // ─── Internal helpers ─────────────────────────────────────────────────────

  /**
   * Every statement of every method flows through the transaction's
   * repository when a caller supplies its EntityManager — the authority fact
   * and the bump share one transaction (atomic commit / rollback).
   */
  private repositoryFor(entityManager?: EntityManager): Repository<TradingAuthorityGeneration> {
    return entityManager
      ? entityManager.getRepository(TradingAuthorityGeneration)
      : this.authorityRepo;
  }

  /**
   * Audit one durable bump. ADMIN_ACTION + metadata.actionType
   * 'TRADING_AUTHORITY_GENERATION_BUMPED' per the EligibilityService.reviewKyc
   * precedent (no existing AuditAction value fits a generation advance; the
   * enum file is out of scope). An audit failure NEVER fails the durable
   * write — the generation row is the truth.
   */
  private async auditBump(
    userId: string,
    reason: AuthorityBumpReason,
    newGeneration: number,
  ): Promise<void> {
    try {
      await this.auditService.log({
        actorUserId: userId,
        action: AuditAction.ADMIN_ACTION,
        resourceType: 'TradingAuthorityGeneration',
        resourceId: userId,
        metadata: {
          actionType: 'TRADING_AUTHORITY_GENERATION_BUMPED',
          userId,
          reason,
          newGeneration,
        },
      });
    } catch (err) {
      this.logger.error(`Trading-authority bump audit failed: ${(err as Error).message}`);
    }
  }
}

/**
 * The runtime allowlist of authority-bump reason codes (issue #300: "audited
 * reason codes"). One code per architect-enumerated authority-changing
 * mutation path — an unknown code is a programming/config error and is
 * rejected typed before any database access.
 */
export const AUTHORITY_BUMP_REASONS = [
  // User profile / identity (UsersService.updateMyProfile)
  'USER_PROFILE_COUNTRY_CHANGED',
  'USER_PROFILE_DATE_OF_BIRTH_CHANGED',
  'USER_PROFILE_DOB_KYC_RESET',
  // KYC / jurisdiction (EligibilityService.reviewKyc / reviewUser)
  'KYC_REVIEW_DECIDED',
  'JURISDICTION_DECISION_CHANGED',
  // Account governance (AccountGovernanceService)
  'ACCOUNT_SUSPENDED',
  'ACCOUNT_PERMANENTLY_LOCKED',
  'ACCOUNT_CLOSED',
  'ACCOUNT_REACTIVATED',
  // Risk profile (material edits, acknowledgement, kill switch)
  'RISK_PROFILE_MATERIAL_EDIT',
  'RISK_ACKNOWLEDGEMENT_CHANGED',
  'KILL_SWITCH_TOGGLED',
  // Broker authority transitions
  'BROKER_AUTHORIZATION_REVOKED',
  'BROKER_CONNECTION_SUSPENDED',
  'BROKER_CONNECTION_DISCONNECTED',
  'BROKER_CREDENTIAL_INVALIDATED',
  'BROKER_CREDENTIAL_ROTATED',
  'BROKER_PROVIDER_IDENTITY_CHANGED',
  'BROKER_EXECUTABLE_STATUS_CHANGED',
] as const;

export type AuthorityBumpReason = (typeof AUTHORITY_BUMP_REASONS)[number];

/**
 * The per-user trading-authority store could not be read or written. The
 * cause is carried — fail-closed consumers must block NEW exposure (never
 * default to generation 1).
 */
export class AuthorityStoreUnavailableError extends Error {
  /** The underlying database/driver failure, when there is one. */
  public readonly cause: unknown;

  constructor(operation: string, cause: unknown) {
    super(
      `Trading-authority store unavailable while trying to ${operation}: ${describeCause(cause)}`,
    );
    this.name = 'AuthorityStoreUnavailableError';
    this.cause = cause;
  }
}

/** An authority bump was attempted with a reason outside the allowlist. */
export class AuthorityBumpReasonInvalidError extends Error {
  constructor(reason: string) {
    super(
      `Unknown trading-authority bump reason "${reason}" — must be one of the ${AUTHORITY_BUMP_REASONS.length} AUTHORITY_BUMP_REASONS codes`,
    );
    this.name = 'AuthorityBumpReasonInvalidError';
  }
}

function describeCause(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (cause === null || cause === undefined) return 'no underlying cause recorded';
  return String(cause);
}
