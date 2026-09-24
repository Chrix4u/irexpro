import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, FindOptionsWhere, Repository, UpdateResult } from 'typeorm';
import { TradingPolicyState } from './entities/trading-policy-state.entity';
import { TradingPolicyRevisionLog } from './entities/trading-policy-revision-log.entity';
import { ProviderLiveVerificationState } from './entities/provider-live-verification-state.entity';
import { ProviderLiveVerificationRevisionLog } from './entities/provider-live-verification-revision-log.entity';
import { ExecutionControlRevisionState } from './entities/execution-control-revision.entity';
import { isUniqueViolation } from '../broker/utils/db-unique-violation';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../../common/enums/audit-action.enum';

/** All three shared-control singletons live at the literal id 1. */
const SINGLETON_ID = 1;

/**
 * Bounded convergence for revision-guarded CAS advances: 1 initial attempt +
 * 2 retries (the architect-mandated bound for replica races).
 */
const SYNC_CAS_MAX_ATTEMPTS = 3;

/** A shared-control fingerprint is exactly 64 lowercase hex chars (SHA-256). */
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;

/** Structural shape shared by all three singleton state rows. */
interface SharedControlStateShape {
  id: number;
  currentRevision: number;
  lastReason: string | null;
  lastBumpedAt: Date | null;
}

/** Per-sync plumbing for the two fingerprinted singletons (policy / catalog). */
interface SharedControlSyncPlan {
  /** 'trading policy' / 'provider LIVE-verification catalog' (typed-error text). */
  label: string;
  fingerprint: string;
  reason?: string;
  entityManager?: EntityManager;
  defaultSeedReason: string;
  defaultAdvanceReason: string;
  readState: () => Promise<{ currentRevision: number; fingerprint: string } | null>;
  seedState: () => Promise<void>;
  seedLog: (seedReason: string) => Promise<void>;
  appendLog: (revision: number, advanceReason: string) => Promise<void>;
  casAdvance: (
    expectedRevision: number,
    nextRevision: number,
    advanceReason: string,
  ) => Promise<number>;
}

/**
 * SharedControlRevisionService — the durable cross-replica shared control
 * plane (Sprint 56 correction round 6, architect issues #363 + #299).
 *
 * WHY A DURABLE SHARED PLANE (issue #363): a "fresh" final recheck against
 * in-process data is not enough. During a rolling deployment replica A can
 * still serve policy/verification revision R1 while replica B already runs
 * R2 — if R2 revokes a jurisdiction or a provider verification, A's "fresh"
 * local check is stale. The three singleton rows below are the single shared
 * truth; RiskGrants bind the revisions observed at issuance and the final
 * dispatch boundary re-reads the CURRENT revisions — a mismatch invalidates
 * NEW exposure (fail closed; a stale replica never executes).
 *
 * SINGLETONS (all id = 1, monotonic CAS-only writes):
 *  - TradingPolicyState — the authoritative eligibility/disclosure trading
 *    policy revision + fingerprint, with the append-only
 *    TradingPolicyRevisionLog history;
 *  - ProviderLiveVerificationState — the authoritative provider
 *    LIVE-verification catalog revision + fingerprint, with the append-only
 *    ProviderLiveVerificationRevisionLog history;
 *  - ExecutionControlRevisionState — the GLOBAL emergency execution-control
 *    revision (issue #299).
 *
 * SYNC SEMANTICS (syncTradingPolicy / syncProviderVerificationCatalog — the
 * deployment bootstrap compares the embedded fingerprint against the shared
 * truth):
 *  - never-seeded ⇒ seed revision 1 + fingerprint + the revision-1 log row
 *    (insert-or-ignore via the unique catch — concurrent bootstrap writers
 *    converge on exactly one row);
 *  - SAME fingerprint ⇒ no-op: the shared revision already covers this
 *    exact embedded content (no log row, no revision change);
 *  - DIFFERENT fingerprint ⇒ append the log row for revision current+1,
 *    then a revision-guarded CAS (`WHERE id = 1 AND current_revision =
 *    :expected`) installs the new fingerprint — with bounded retry 2
 *    (3 attempts) for replica/stale-read races; the loser's pre-appended
 *    log row for the same revision is ignored via the revision unique
 *    (the STATE row stays the authoritative fingerprint for the current
 *    revision; a lost advance is retried, never skipped and never
 *    resurrected);
 *  - malformed fingerprint (not 64 lowercase hex) ⇒ typed rejection BEFORE
 *    any shared state is touched;
 *  - any DB failure ⇒ SharedControlStoreUnavailableError carrying the cause.
 *
 * NO-AUTHORITY-RESURRECTION (issue #299): bumpExecutionControlRevision is an
 * UNCONDITIONAL monotonic CAS (`current_revision = current_revision + 1`)
 * invoked on EVERY safety-relevant emergency-control mutation — activation
 * AND deactivation AND expiry/replacement all bump. Deactivation is another
 * revision, so a boolean flipping back can never resurrect a pre-control
 * grant: control active → old grant blocked; control deactivated → old grant
 * REMAINS blocked. An absent singleton is seeded at revision 1 and the bump
 * retried once (net effect 2). An empty reason is rejected typed. Every bump
 * is audited.
 *
 * AUDIT: bumpExecutionControlRevision is audited with the EXISTING generic
 * AuditAction.ADMIN_ACTION + metadata.actionType
 * 'EXECUTION_CONTROL_REVISION_BUMPED' (the EligibilityService.reviewKyc
 * precedent — the AuditAction enum file is out of this task's scope and no
 * existing value fits a revision advance; the metadata.actionType strings
 * already match the recommended future dedicated enum values, so rows stay
 * aligned when they land) PLUS a structured logger.warn carrying reason +
 * revision on every bump/advance as fallback evidence. Sync advances are not
 * additionally audited — their append-only revision LOG rows are the durable
 * per-revision evidence. An audit failure NEVER fails the durable write.
 */
@Injectable()
export class SharedControlRevisionService {
  private readonly logger = new Logger(SharedControlRevisionService.name);

  constructor(
    @InjectRepository(TradingPolicyState)
    private readonly policyStateRepo: Repository<TradingPolicyState>,
    @InjectRepository(TradingPolicyRevisionLog)
    private readonly policyLogRepo: Repository<TradingPolicyRevisionLog>,
    @InjectRepository(ProviderLiveVerificationState)
    private readonly providerStateRepo: Repository<ProviderLiveVerificationState>,
    @InjectRepository(ProviderLiveVerificationRevisionLog)
    private readonly providerLogRepo: Repository<ProviderLiveVerificationRevisionLog>,
    @InjectRepository(ExecutionControlRevisionState)
    private readonly controlStateRepo: Repository<ExecutionControlRevisionState>,
    private readonly auditService: AuditService,
  ) {}

  // ─── Reads (fail closed: store-down ≠ never-seeded ≠ revision 1) ──────────

  /** Current SHARED trading-policy revision (issue #363). */
  async getCurrentTradingPolicyRevision(entityManager?: EntityManager): Promise<number> {
    return this.readSingletonRevision(
      entityManager ? entityManager.getRepository(TradingPolicyState) : this.policyStateRepo,
      'trading policy',
    );
  }

  /** Current SHARED provider LIVE-verification catalog revision (issue #363). */
  async getCurrentProviderVerificationRevision(entityManager?: EntityManager): Promise<number> {
    return this.readSingletonRevision(
      entityManager
        ? entityManager.getRepository(ProviderLiveVerificationState)
        : this.providerStateRepo,
      'provider LIVE-verification catalog',
    );
  }

  /** Current GLOBAL execution-control revision (issue #299). */
  async getCurrentExecutionControlRevision(entityManager?: EntityManager): Promise<number> {
    return this.readSingletonRevision(
      entityManager
        ? entityManager.getRepository(ExecutionControlRevisionState)
        : this.controlStateRepo,
      'execution-control',
    );
  }

  // ─── Syncs (deployment bootstrap vs the embedded fingerprint) ─────────────

  /**
   * Sync the embedded eligibility/disclosure trading-policy fingerprint
   * against the shared singleton. Returns the CURRENT shared revision after
   * the sync (seed / no-op / advance — see the class docblock).
   */
  async syncTradingPolicy(
    fingerprint: string,
    reason?: string,
    entityManager?: EntityManager,
  ): Promise<number> {
    assertSharedFingerprint(fingerprint, 'trading policy');
    const stateRepo = entityManager
      ? entityManager.getRepository(TradingPolicyState)
      : this.policyStateRepo;
    const logRepo = entityManager
      ? entityManager.getRepository(TradingPolicyRevisionLog)
      : this.policyLogRepo;
    const now = new Date();

    return this.syncSharedControlRevision({
      label: 'trading policy',
      fingerprint,
      reason,
      entityManager,
      defaultSeedReason: 'embedded policy initialized',
      defaultAdvanceReason: 'embedded policy changed',
      readState: async () => {
        const row = await stateRepo.findOne({ where: { id: SINGLETON_ID } });
        return row
          ? { currentRevision: row.currentRevision, fingerprint: row.policyFingerprint }
          : null;
      },
      seedState: () =>
        stateRepo
          .createQueryBuilder()
          .insert()
          .values({
            id: SINGLETON_ID,
            currentRevision: 1,
            policyFingerprint: fingerprint,
            lastReason: resolveReason(reason, 'embedded policy initialized'),
            lastBumpedAt: now,
          })
          .execute()
          .then(() => undefined),
      seedLog: (seedReason) =>
        logRepo
          .createQueryBuilder()
          .insert()
          .values({
            revision: 1,
            policyFingerprint: fingerprint,
            reason: seedReason,
            description: null,
          })
          .execute()
          .then(() => undefined),
      appendLog: (revision, advanceReason) =>
        logRepo
          .createQueryBuilder()
          .insert()
          .values({
            revision,
            policyFingerprint: fingerprint,
            reason: advanceReason,
            description: null,
          })
          .execute()
          .then(() => undefined),
      casAdvance: (expectedRevision, nextRevision, advanceReason) =>
        stateRepo
          .createQueryBuilder()
          .update()
          .set({
            currentRevision: nextRevision,
            policyFingerprint: fingerprint,
            lastReason: advanceReason,
            lastBumpedAt: now,
            updatedAt: now,
          })
          .where('id = :id AND current_revision = :expected', {
            id: SINGLETON_ID,
            expected: expectedRevision,
          })
          .execute()
          .then((result: UpdateResult) => result.affected ?? 0),
    });
  }

  /**
   * Sync the embedded provider LIVE-verification catalog fingerprint against
   * the shared singleton. Returns the CURRENT shared revision after the sync
   * (seed / no-op / advance — see the class docblock).
   */
  async syncProviderVerificationCatalog(
    fingerprint: string,
    reason?: string,
    entityManager?: EntityManager,
  ): Promise<number> {
    assertSharedFingerprint(fingerprint, 'provider LIVE-verification catalog');
    const stateRepo = entityManager
      ? entityManager.getRepository(ProviderLiveVerificationState)
      : this.providerStateRepo;
    const logRepo = entityManager
      ? entityManager.getRepository(ProviderLiveVerificationRevisionLog)
      : this.providerLogRepo;
    const now = new Date();

    return this.syncSharedControlRevision({
      label: 'provider LIVE-verification catalog',
      fingerprint,
      reason,
      entityManager,
      defaultSeedReason: 'embedded verification catalog initialized',
      defaultAdvanceReason: 'embedded verification catalog changed',
      readState: async () => {
        const row = await stateRepo.findOne({ where: { id: SINGLETON_ID } });
        return row
          ? { currentRevision: row.currentRevision, fingerprint: row.catalogFingerprint }
          : null;
      },
      seedState: () =>
        stateRepo
          .createQueryBuilder()
          .insert()
          .values({
            id: SINGLETON_ID,
            currentRevision: 1,
            catalogFingerprint: fingerprint,
            lastReason: resolveReason(reason, 'embedded verification catalog initialized'),
            lastBumpedAt: now,
          })
          .execute()
          .then(() => undefined),
      seedLog: (seedReason) =>
        logRepo
          .createQueryBuilder()
          .insert()
          .values({
            revision: 1,
            catalogFingerprint: fingerprint,
            reason: seedReason,
            description: null,
          })
          .execute()
          .then(() => undefined),
      appendLog: (revision, advanceReason) =>
        logRepo
          .createQueryBuilder()
          .insert()
          .values({
            revision,
            catalogFingerprint: fingerprint,
            reason: advanceReason,
            description: null,
          })
          .execute()
          .then(() => undefined),
      casAdvance: (expectedRevision, nextRevision, advanceReason) =>
        stateRepo
          .createQueryBuilder()
          .update()
          .set({
            currentRevision: nextRevision,
            catalogFingerprint: fingerprint,
            lastReason: advanceReason,
            lastBumpedAt: now,
            updatedAt: now,
          })
          .where('id = :id AND current_revision = :expected', {
            id: SINGLETON_ID,
            expected: expectedRevision,
          })
          .execute()
          .then((result: UpdateResult) => result.affected ?? 0),
    });
  }

  // ─── Execution-control revision (#299 no-resurrection invariant) ──────────

  /**
   * Ensure the GLOBAL execution-control revision singleton exists without
   * recording a safety-control mutation. Deployment/bootstrap uses this to
   * establish revision 1 before any trade-intent/risk read occurs.
   *
   * Concurrent bootstraps converge through the singleton PK. A pre-existing
   * row is returned unchanged; this method never increments the revision.
   */
  async ensureExecutionControlRevisionInitialized(
    reason = 'deployment bootstrap initialized execution-control revision',
    entityManager?: EntityManager,
  ): Promise<number> {
    const repo = entityManager
      ? entityManager.getRepository(ExecutionControlRevisionState)
      : this.controlStateRepo;
    const trimmedReason = reason.trim().slice(0, 200);
    const now = new Date();

    try {
      const existing = await repo.findOne({ where: { id: SINGLETON_ID } });
      if (existing) {
        return existing.currentRevision;
      }

      try {
        await repo
          .createQueryBuilder()
          .insert()
          .values({
            id: SINGLETON_ID,
            currentRevision: 1,
            lastReason: trimmedReason || 'deployment bootstrap initialized execution-control revision',
            lastBumpedAt: null,
          })
          .execute();
      } catch (err) {
        if (!isUniqueViolation(err)) {
          throw new SharedControlStoreUnavailableError(
            'seed the execution-control revision during bootstrap',
            err,
          );
        }
      }

      const seeded = await repo.findOne({ where: { id: SINGLETON_ID } });
      if (!seeded) {
        throw new SharedControlRevisionConvergenceError(
          'execution-control bootstrap seed did not converge',
        );
      }

      this.logger.log(
        `Shared execution-control revision initialized: revision=${seeded.currentRevision}`,
      );
      return seeded.currentRevision;
    } catch (err) {
      if (
        err instanceof SharedControlStoreUnavailableError ||
        err instanceof SharedControlRevisionConvergenceError
      ) {
        throw err;
      }
      throw new SharedControlStoreUnavailableError(
        'initialize the execution-control revision during bootstrap',
        err,
      );
    }
  }

  /**
   * Unconditionally advance the GLOBAL execution-control revision.
   *
   * CAS: `current_revision = current_revision + 1, last_reason,
   * last_bumped_at, updated_at WHERE id = 1` — activation AND deactivation
   * AND expiry/replacement ALL bump (deactivation is another revision, never
   * a resurrection). An absent singleton is seeded at revision 1 and the CAS
   * retried ONCE (net effect: bump to 2). Returns the re-read NEW revision
   * (may exceed the caller's own increment under concurrency, never lower).
   * An empty/whitespace reason is rejected typed BEFORE any database access.
   */
  async bumpExecutionControlRevision(
    reason: string,
    entityManager?: EntityManager,
  ): Promise<number> {
    const trimmedReason = typeof reason === 'string' ? reason.trim() : '';
    if (!trimmedReason) {
      throw new SharedControlBumpReasonInvalidError(reason);
    }
    const repo = entityManager
      ? entityManager.getRepository(ExecutionControlRevisionState)
      : this.controlStateRepo;
    const now = new Date();

    const casBump = (): Promise<UpdateResult> =>
      repo
        .createQueryBuilder()
        .update()
        .set({
          currentRevision: () => 'current_revision + 1',
          lastReason: trimmedReason.slice(0, 200),
          lastBumpedAt: now,
          updatedAt: now,
        })
        .where('id = :id', { id: SINGLETON_ID })
        .execute();

    let result: UpdateResult;
    try {
      result = await casBump();
    } catch (err) {
      throw new SharedControlStoreUnavailableError('bump the execution-control revision', err);
    }

    if ((result.affected ?? 0) === 0) {
      // Singleton never seeded (or a racing bootstrap has not committed yet):
      // seed revision 1 guardedly, then retry the CAS ONCE — the seed is part
      // of this bump, so the first-ever bump lands at revision 2.
      try {
        await repo
          .createQueryBuilder()
          .insert()
          .values({ id: SINGLETON_ID, currentRevision: 1 })
          .execute();
      } catch (err) {
        if (!isUniqueViolation(err)) {
          throw new SharedControlStoreUnavailableError(
            'seed the execution-control revision for bump',
            err,
          );
        }
        // A concurrent seeder won — fall through to the retry CAS.
      }
      try {
        result = await casBump();
      } catch (err) {
        throw new SharedControlStoreUnavailableError(
          'retry the execution-control revision bump',
          err,
        );
      }
      if ((result.affected ?? 0) === 0) {
        throw new SharedControlRevisionConvergenceError(
          'execution-control revision bump did not converge after the guarded seed + retry',
        );
      }
    }

    // Re-read the NEW revision (never lower than the caller's increment).
    let row: ExecutionControlRevisionState | null;
    try {
      row = await repo.findOne({ where: { id: SINGLETON_ID } });
    } catch (err) {
      throw new SharedControlStoreUnavailableError(
        're-read the bumped execution-control revision',
        err,
      );
    }
    if (!row) {
      throw new SharedControlStoreUnavailableError(
        'execution-control revision row vanished after the bump — failing closed',
        null,
      );
    }

    this.logger.warn(
      `Execution-control revision bumped to ${row.currentRevision} (${trimmedReason})`,
    );
    await this.auditControlBump(trimmedReason, row.currentRevision);
    return row.currentRevision;
  }

  // ─── Internal helpers ─────────────────────────────────────────────────────

  /**
   * Fail-closed singleton read: a store failure throws
   * SharedControlStoreUnavailableError (cause carried) and a never-seeded
   * singleton throws SharedControlStateNotInitializedError — neither is ever
   * reported as revision 1.
   */
  private async readSingletonRevision<T extends SharedControlStateShape>(
    repo: Repository<T>,
    label: string,
  ): Promise<number> {
    let row: T | null;
    try {
      row = await repo.findOne({ where: { id: SINGLETON_ID } as FindOptionsWhere<T> });
    } catch (err) {
      throw new SharedControlStoreUnavailableError(`read the shared ${label} revision`, err);
    }
    if (!row) {
      throw new SharedControlStateNotInitializedError(label);
    }
    return row.currentRevision;
  }

  /**
   * The shared seed / no-op / advance convergence loop for the two
   * fingerprinted singletons (trading policy + provider verification
   * catalog). Bounded: SYNC_CAS_MAX_ATTEMPTS total; exhaustion is a typed
   * convergence failure (fail closed — never a skipped advance).
   */
  private async syncSharedControlRevision(plan: SharedControlSyncPlan): Promise<number> {
    const { label, fingerprint } = plan;

    for (let attempt = 1; attempt <= SYNC_CAS_MAX_ATTEMPTS; attempt++) {
      let state: { currentRevision: number; fingerprint: string } | null;
      try {
        state = await plan.readState();
      } catch (err) {
        throw new SharedControlStoreUnavailableError(`read the shared ${label} state`, err);
      }

      if (!state) {
        // Never seeded: install revision 1 + fingerprint + the revision-1 log
        // row, both insert-or-ignore (a concurrent bootstrap writer that won
        // either slot is adopted on the next attempt's read).
        try {
          await plan.seedState();
        } catch (err) {
          if (!isUniqueViolation(err)) {
            throw new SharedControlStoreUnavailableError(`seed the shared ${label} state`, err);
          }
        }
        try {
          await plan.seedLog(resolveReason(plan.reason, plan.defaultSeedReason));
        } catch (err) {
          if (!isUniqueViolation(err)) {
            throw new SharedControlStoreUnavailableError(
              `append the ${label} revision-1 log row`,
              err,
            );
          }
        }
        continue;
      }

      if (state.fingerprint === fingerprint) {
        // No-op: the shared revision already covers this exact embedded
        // content. No log row, no revision change, no audit noise.
        return state.currentRevision;
      }

      // Different fingerprint ⇒ append the log row for current+1, then the
      // revision-guarded CAS. A concurrent advance that wins the CAS makes
      // this attempt's CAS affect 0 rows — the bounded retry re-reads and
      // either no-ops (the winner installed our fingerprint) or advances.
      const nextRevision = state.currentRevision + 1;
      const advanceReason = resolveReason(plan.reason, plan.defaultAdvanceReason);
      try {
        await plan.appendLog(nextRevision, advanceReason);
      } catch (err) {
        if (!isUniqueViolation(err)) {
          throw new SharedControlStoreUnavailableError(
            `append the ${label} revision-${nextRevision} log row`,
            err,
          );
        }
        // The revision-unique log row already exists (a concurrent or crashed
        // predecessor appended it) — the CAS below either installs exactly
        // that revision or loses and retries.
      }
      let affected: number;
      try {
        affected = await plan.casAdvance(state.currentRevision, nextRevision, advanceReason);
      } catch (err) {
        throw new SharedControlStoreUnavailableError(
          `advance the shared ${label} revision to ${nextRevision}`,
          err,
        );
      }
      if (affected > 0) {
        this.logger.warn(`Shared ${label} revision advanced to ${nextRevision} (${advanceReason})`);
        return nextRevision;
      }
      // CAS lost (revision moved concurrently) — bounded retry.
    }

    throw new SharedControlRevisionConvergenceError(
      `shared ${label} sync did not converge after ${SYNC_CAS_MAX_ATTEMPTS} attempts`,
    );
  }

  /**
   * Audit one durable execution-control revision bump. ADMIN_ACTION +
   * metadata.actionType 'EXECUTION_CONTROL_REVISION_BUMPED' per the
   * EligibilityService.reviewKyc precedent. An audit failure NEVER fails the
   * durable write — the revision row is the truth.
   */
  private async auditControlBump(reason: string, newRevision: number): Promise<void> {
    try {
      await this.auditService.log({
        action: AuditAction.ADMIN_ACTION,
        resourceType: 'ExecutionControlRevisionState',
        resourceId: String(SINGLETON_ID),
        metadata: {
          actionType: 'EXECUTION_CONTROL_REVISION_BUMPED',
          reason,
          newRevision,
        },
      });
    } catch (err) {
      this.logger.error(`Execution-control revision bump audit failed: ${(err as Error).message}`);
    }
  }
}

/** Caller-supplied reason, or the documented default. */
function resolveReason(reason: string | undefined, defaultReason: string): string {
  const trimmed = typeof reason === 'string' ? reason.trim() : '';
  return trimmed ? trimmed.slice(0, 200) : defaultReason;
}

/** Typed rejection of any fingerprint that is not exactly 64 lowercase hex. */
function assertSharedFingerprint(fingerprint: string, label: string): void {
  if (typeof fingerprint !== 'string' || !FINGERPRINT_PATTERN.test(fingerprint)) {
    throw new SharedControlFingerprintInvalidError(fingerprint, label);
  }
}

/**
 * A shared-control singleton could not be read or written. The cause is
 * carried — fail-closed consumers must block NEW exposure (never treat a
 * store failure as a revision match).
 */
export class SharedControlStoreUnavailableError extends Error {
  /** The underlying database/driver failure, when there is one. */
  public readonly cause: unknown;

  constructor(operation: string, cause: unknown) {
    super(`Shared control store unavailable while trying to ${operation}: ${describeCause(cause)}`);
    this.name = 'SharedControlStoreUnavailableError';
    this.cause = cause;
  }
}

/**
 * The requested shared-control singleton was never seeded. This is a
 * deployment/bootstrap ordering failure, NOT a store failure — distinct
 * typed error so consumers can distinguish never-initialized (bootstrap
 * missing) from store-down (fail closed differently).
 */
export class SharedControlStateNotInitializedError extends Error {
  constructor(label: string) {
    super(
      `Shared ${label} state was never initialized — the deployment bootstrap must sync it before it is read`,
    );
    this.name = 'SharedControlStateNotInitializedError';
  }
}

/** A shared-control fingerprint is not exactly 64 lowercase hex characters. */
export class SharedControlFingerprintInvalidError extends Error {
  constructor(fingerprint: string, label: string) {
    super(
      `Malformed ${label} fingerprint "${String(fingerprint).slice(0, 80)}" — expected exactly 64 lowercase hex characters; shared state was not touched`,
    );
    this.name = 'SharedControlFingerprintInvalidError';
  }
}

/** An execution-control revision bump requires a non-empty reason. */
export class SharedControlBumpReasonInvalidError extends Error {
  constructor(reason: string) {
    super(
      `Execution-control revision bump requires a non-empty reason (received: ${JSON.stringify(reason)})`,
    );
    this.name = 'SharedControlBumpReasonInvalidError';
  }
}

/**
 * A revision-guarded shared-control advance could not converge within the
 * bounded retry budget (sustained concurrent advances). Fail closed — the
 * advance is never silently skipped.
 */
export class SharedControlRevisionConvergenceError extends Error {
  constructor(detail: string) {
    super(`Shared control revision convergence failure: ${detail}`);
    this.name = 'SharedControlRevisionConvergenceError';
  }
}

function describeCause(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (cause === null || cause === undefined) return 'no underlying cause recorded';
  return String(cause);
}
