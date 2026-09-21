import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ModuleRef } from '@nestjs/core';
import { Repository } from 'typeorm';
import { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { randomUUID } from 'crypto';
import { BrokerConnection } from '../entities/broker-connection.entity';
import { CredentialEncryptionService } from './credential-encryption.service';
import { CTraderClientService } from '../adapters/ctrader/ctrader-client.service';
import { CtraderOAuthTokens } from '../adapters/ctrader/ctrader-oauth';
import { AuditService } from '../../audit/audit.service';
import { TradingAuthorityService } from '../../execution-authority/trading-authority.service';
import { GrantInvalidationService } from '../../execution-authority/grant-invalidation.service';
import { AuditAction } from '../../../common/enums/audit-action.enum';
import { AuditSeverity } from '../../audit/entities/audit-log.entity';
import { CTRADER_FAMILY_BROKER_IDS } from '../registry/broker-catalog';
import {
  BrokerCredentialLifecycle,
  BrokerCredentialStatus,
} from '../authorization/broker-credential-status';
import { DecryptedBrokerCredentials } from '../interfaces/broker-adapter.interface';
import { BrokerAdapterError, BrokerErrorCode } from '../interfaces/broker-adapter.errors';
// Production-LIVE completion round (P13 metrics): dependency-free in-process
// counters (lazy ModuleRef seam — same pattern as risk.service).
import { MetricsService } from '../../metrics/metrics.service';
import { METRIC_NAMES } from '../../metrics/metric-names';

/**
 * BrokerOAuthTokenLifecycleService — OAuth credential freshness for the
 * cTrader family (Sprint 56 correction round 1 / audit point 1; Sprint 56
 * correction round 2 / architect finding 3: concurrent refresh protection).
 *
 * THE PROBLEM THIS SERVICE CLOSES (Spotware-documented behavior):
 * - cTrader OAuth access tokens carry a lifetime (expiresIn ≈ 30 days);
 * - a refresh EXCHANGES the (accessToken, refreshToken) pair for a NEW pair
 *   and INVALIDATES the previous pair;
 * - the persisted (encrypted) credential therefore goes permanently dead
 *   after any successful refresh unless the NEW pair is persisted
 *   ATOMICALLY, BEFORE it is used anywhere;
 * - TWO CONCURRENT requests observing the same near-expiry credential both
 *   refresh → Spotware rotates BOTH pairs → BOTH refresh tokens dead →
 *   credential permanently killed even though every step "succeeded"
 *   (architect finding 3);
 * - a failed refresh of a dead refresh token must fail CLOSED (credential
 *   INVALID → re-authorization required), never silently fall back to the
 *   dead pair.
 *
 * CONCURRENT REFRESH PROTECTION (cross-replica, DB-atomic):
 * - `credential_refresh_lease_expires_at` + `credential_refresh_lease_owner`
 *   form a refresh LEASE: the claim is a single conditional UPDATE (WHERE
 *   lease IS NULL OR lease <= now) with an affected-rows check that sets BOTH
 *   the expiry AND a FRESH UNIQUE owner token (crypto.randomUUID), so exactly
 *   ONE API replica can hold it — this is NOT an in-memory mutex and works
 *   across replicas;
 * - only the lease WINNER calls the provider for one stale
 *   `credential_generation`; losers wait (bounded) and ADOPT the winner's
 *   persisted pair — they never call the provider, never write, never audit;
 * - persistence is a generation CAS: UPDATE ... SET ...,
 *   credential_generation = observed + 1 WHERE credential_generation =
 *   observed — a stale refresh response can never overwrite a newer pair;
 * - a loser NEVER marks the credential INVALID merely because another
 *   request already rotated it (INVALID is only written by the winner's
 *   fail-closed paths: auth-class rejection / persist failure);
 * - LEASE-OWNER FENCING (Sprint 56 correction round 6, task 6-d — stale
 *   refresh owners): EVERY winner-only operation (successful pair
 *   persistence, terminal INVALID transition, lease release) is guarded by
 *   the EXACT owner token claimed with the lease — there is NO
 *   `credential_refresh_lease_expires_at IS NULL` ownership alternative
 *   anywhere. A request whose lease EXPIRED — whose provider request was
 *   overtaken by a takeover winner, or whose successor claimed, failed
 *   transiently and RELEASED — can therefore NEVER mutate the row: an
 *   expired lease alone is never proof that the old owner regained
 *   ownership. A genuine CURRENT-owner rejection marks exactly ITS
 *   generation INVALID once, releases its own lease in the same atomic
 *   write, and emits exactly one sanitized audit event; a stale owner's
 *   late rejection matches ZERO rows and stays USABLE (no false audit);
 * - a hung winner's lease EXPIRES (leaseMs) so a waiter can steal the claim
 *   (minting a NEW owner token) and complete the refresh — no permanent stall;
 * - budget exhaustion surfaces as a RETRYABLE, sanitized RATE_LIMITED error.
 *
 * CONTRACT (used by BrokerService.connectBroker and healthCheck):
 * `ensureFreshTokens(connection, credentials)` returns the credential set
 * that is SAFE TO USE for the upcoming provider call:
 *   - non-cTrader-family / no refreshToken / token still fresh → the input
 *     credentials unchanged (no provider or DB interaction at all);
 *   - expired / near-expiry / unknown-expiry refreshable credential → a
 *     freshly refreshed pair that has ALREADY been atomically persisted
 *     (single UPDATE: ciphertext + IV + tag + keyId + ROTATED status +
 *     generation bump + lease release);
 *   - refresh REJECTED by the provider (auth-class) → credentialStatus
 *     INVALID persisted + typed ConflictException (fail-closed);
 *   - refresh failed TRANSIENTLY (network/timeout/rate-limit) → the error
 *     propagates WITHOUT poisoning the stored credential (the old pair may
 *     still be alive; the caller's existing failure semantics apply).
 *
 * TOKEN SECRECY INVARIANTS (adversarially tested):
 * - access tokens and refresh tokens NEVER appear in logs, audit metadata,
 *   exception text, or any plaintext-at-rest field — they live ONLY inside
 *   the AES-256-GCM ciphertext columns;
 * - audit metadata records brokerId / accountId / expiry timestamp /
 *   credential generation ONLY;
 * - decrypted token material is zeroed in a finally-style discipline before
 *   the method returns (both the old and the new plaintext objects).
 */
/** Proactive refresh margin — refresh this close to expiry, never after use. */
const REFRESH_SAFETY_MARGIN_MS = 5 * 60_000;

/** Refresh lease duration — how long ONE replica may hold the refresh right. */
export const REFRESH_LEASE_MS = 30_000;
/** Bounded wait budget for lease losers — retryable RATE_LIMITED beyond it. */
export const REFRESH_WAIT_BUDGET_MS = 10_000;
/** Lease-loser poll interval while waiting for the winner's generation. */
export const REFRESH_POLL_INTERVAL_MS = 25;

/**
 * Outcome of a guarded refresh-rejection (INVALID) write (Sprint 56
 * correction round 4, architect finding 1; ownership hardened round 6).
 * - MARKED_INVALID: this request was the CURRENT owner of the observed
 *   generation — the write marked exactly that generation INVALID and
 *   released this request's own lease atomically.
 * - SUPERSEDED_USABLE: a takeover winner persisted a NEWER USABLE pair —
 *   the newer row is authoritative (never overwritten, never falsely
 *   audited).
 * - SUPERSEDED_NOT_USABLE: a newer generation exists but is NOT usable, or
 *   another owner holds a LIVE lease on the same generation — never a write.
 * - MARK_FAILED: the guarded write itself failed (logged, no false audit).
 */
type RefreshRejectionOutcome =
  | 'MARKED_INVALID'
  | 'SUPERSEDED_USABLE'
  | 'SUPERSEDED_NOT_USABLE'
  | 'MARK_FAILED';

/**
 * One held refresh lease (round 6, task 6-d): the expiry instant AND the
 * UNIQUE owner token that fences every winner-only write. Claimed atomically
 * (both columns in ONE conditional UPDATE); a takeover mints a NEW token.
 */
export interface RefreshLeaseClaim {
  claimUntil: Date;
  ownerToken: string;
}

/**
 * Update-patch typing for the lease columns (round 6, task 6-d): the claim
 * atomically sets BOTH `credential_refresh_lease_expires_at` AND
 * `credential_refresh_lease_owner`. The owner property ships on the
 * BrokerConnection entity with the round-6 migration (1754300000000 —
 * credential_refresh_lease_owner varchar(64) NULL); the widened intersection
 * below keeps this module compiling against trees where that entity restore
 * is still in flight WITHOUT changing the emitted UPDATE — once the entity
 * carries the column, this is exactly the plain typed patch.
 */
type BrokerConnectionUpdatePatch = QueryDeepPartialEntity<BrokerConnection> & {
  credentialRefreshLeaseOwner?: string | null;
};

@Injectable()
export class BrokerOAuthTokenLifecycleService {
  private readonly logger = new Logger(BrokerOAuthTokenLifecycleService.name);

  /** Refresh lease duration (determinism seam — production: REFRESH_LEASE_MS). */
  protected leaseMs: number = REFRESH_LEASE_MS;
  /** Loser wait budget (determinism seam — production: REFRESH_WAIT_BUDGET_MS). */
  protected waitBudgetMs: number = REFRESH_WAIT_BUDGET_MS;
  /** Loser poll interval (determinism seam — production: REFRESH_POLL_INTERVAL_MS). */
  protected pollIntervalMs: number = REFRESH_POLL_INTERVAL_MS;

  /** Clock seam for deterministic lease/CAS tests. */
  protected now(): number {
    return Date.now();
  }

  /** Sleep seam for the loser wait loop (tests keep real timers, tiny values). */
  protected sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Fresh lease-owner token (round 6): a random UUID (≤ 64 chars) minted at
   * every claim/takeover — the fencing identity for ALL winner-only writes.
   * Protected seam for tests.
   */
  protected newLeaseOwnerToken(): string {
    return randomUUID();
  }

  constructor(
    @InjectRepository(BrokerConnection)
    private readonly connectionRepo: Repository<BrokerConnection>,
    private readonly encryptionService: CredentialEncryptionService,
    private readonly ctraderClient: CTraderClientService,
    private readonly auditService: AuditService,
    // Round 6 live-execution completion (§1b): credential-set transitions
    // (INVALID on refresh rejection, ROTATED on refresh success) invalidate
    // the user's NEW-exposure authority bound to the old credential
    // generation — leaf seams only, no module import cycle.
    private readonly tradingAuthorityService: TradingAuthorityService,
    private readonly grantInvalidation: GrantInvalidationService,
    /**
     * Production-LIVE completion round (P13 metrics): lazy metrics seam —
     * OPTIONAL trailing dependency (the spec's TestableLifecycleService
     * super() call keeps compiling unchanged). Resolved at CALL time via
     * ModuleRef.get(..., { strict: false }); when absent every
     * `this.metrics?.…` call site no-ops.
     */
    private readonly moduleRef?: ModuleRef,
  ) {}

  /** Lazy MetricsService lookup (never throws, never affects control flow). */
  private get metrics(): MetricsService | null {
    try {
      return this.moduleRef?.get(MetricsService, { strict: false }) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Pre-connect freshness gate. Returns the credentials the caller must use.
   * See the class docs for the full contract; NEVER mutates the input object.
   */
  async ensureFreshTokens(
    connection: BrokerConnection,
    credentials: DecryptedBrokerCredentials,
  ): Promise<DecryptedBrokerCredentials> {
    if (!CTRADER_FAMILY_BROKER_IDS.includes(connection.brokerId)) {
      return credentials;
    }
    const additionalParams = credentials.additionalParams ?? {};
    const refreshToken = additionalParams.refreshToken;
    if (!refreshToken || refreshToken.trim() === '') {
      // No refresh capability (access-token-only credential) — used as-is.
      return credentials;
    }
    const expiryRaw = additionalParams.accessTokenExpiresAt;
    const expiryMs = expiryRaw !== undefined ? Date.parse(expiryRaw) : NaN;
    if (Number.isFinite(expiryMs) && expiryMs - this.now() > REFRESH_SAFETY_MARGIN_MS) {
      return credentials; // still fresh
    }
    // Expired, near-expiry, or UNKNOWN expiry (legacy credential without the
    // timestamp): attempt the refresh — a success installs expiry tracking
    // going forward; an auth-class rejection is the honest fail-closed state.
    const observedGeneration = connection.credentialGeneration ?? 0;
    return this.refreshUnderLease(connection, credentials, refreshToken, observedGeneration);
  }

  // ─── Lease acquisition + bounded loser wait loop ───────────────────────────

  /**
   * Serializes the refresh per connection across replicas:
   * claim lease → winner refreshes and CAS-persists; losers adopt the
   * winner's generation, observe INVALID honestly, steal an EXPIRED lease,
   * or exhaust their bounded budget with a retryable RATE_LIMITED error.
   */
  private async refreshUnderLease(
    connection: BrokerConnection,
    credentials: DecryptedBrokerCredentials,
    refreshToken: string,
    observedGeneration: number,
  ): Promise<DecryptedBrokerCredentials> {
    // Fast path (the common case): nobody else is refreshing — claim once.
    let claim = await this.tryClaimLease(connection.id);
    if (claim) {
      return this.refreshAsWinner(connection, credentials, refreshToken, observedGeneration, claim);
    }

    // LOSER path: another replica/request holds a live lease for this
    // connection. Wait BOUNDED for its outcome instead of racing it — a
    // second provider refresh of the same generation would rotate BOTH
    // pairs and permanently kill the credential.
    const deadline = this.now() + this.waitBudgetMs;
    for (;;) {
      const row = await this.reloadRow(connection.id);
      if (row) {
        if (row.credentialGeneration > observedGeneration) {
          // The winner rotated the pair successfully → adopt its persisted
          // result. NEVER call the provider, NEVER write, NEVER audit, and
          // NEVER mark INVALID for the same generation we just observed.
          const adopted = this.adoptUsableNewerCredential(row);
          if (adopted) {
            return adopted;
          }
          throw this.staleGenerationConflict(connection.id);
        }
        if (row.credentialStatus === BrokerCredentialStatus.INVALID) {
          // The credential is genuinely dead (the winner's fail-closed path
          // already marked it): surface the SAME typed conflict — never a
          // false success, and never our own INVALID write.
          throw this.refreshRejectedConflict(connection.id);
        }
      }
      // The lease is free (released or EXPIRED) → try to become the winner
      // ourselves; if another claimer won again, keep waiting.
      claim = await this.tryClaimLease(connection.id);
      if (claim) {
        return this.refreshAsWinner(
          connection,
          credentials,
          refreshToken,
          observedGeneration,
          claim,
        );
      }
      if (this.now() >= deadline) {
        // P13 metrics: the bounded loser wait budget was exhausted while
        // another holder kept the refresh lease — the retryable RATE_LIMITED
        // outcome (terminal for THIS attempt).
        this.metrics?.increment(METRIC_NAMES.OAUTH_TOKEN_REFRESHES, {
          brokerId: connection.brokerId,
          outcome: 'LEASE_FAIL',
        });
        // Retryable, sanitized (connection id only — never token data).
        throw new BrokerAdapterError(
          BrokerErrorCode.RATE_LIMITED,
          `cTrader token refresh already in progress for connection ${connection.id} — retry shortly.`,
          undefined,
          true,
        );
      }
      await this.sleep(this.pollIntervalMs);
    }
  }

  /**
   * DB-atomic lease claim (works across replicas): ONE conditional UPDATE
   * with an affected-rows check that sets BOTH the lease expiry AND a FRESH
   * UNIQUE owner token (round 6). Returns the claim (expiry + our fencing
   * token for every winner-only write) or null when someone else holds it.
   */
  private async tryClaimLease(connectionId: string): Promise<RefreshLeaseClaim | null> {
    const nowMs = this.now();
    const claimUntil = new Date(nowMs + this.leaseMs);
    const ownerToken = this.newLeaseOwnerToken();
    const claimPatch: BrokerConnectionUpdatePatch = {
      credentialRefreshLeaseExpiresAt: claimUntil,
      credentialRefreshLeaseOwner: ownerToken,
    };
    const result = await this.connectionRepo
      .createQueryBuilder()
      .update(BrokerConnection)
      .set(claimPatch)
      .where(
        'id = :id AND (credential_refresh_lease_expires_at IS NULL ' +
          'OR credential_refresh_lease_expires_at <= :now)',
        { id: connectionId, now: new Date(nowMs) },
      )
      .execute();
    return result.affected === 1 ? { claimUntil, ownerToken } : null;
  }

  /**
   * Releases OUR OWN claim only — guarded by the EXACT owner token (round 6):
   * the WHERE clause requires our fencing token, and BOTH lease columns are
   * cleared. Harmless when the CAS persist already released it or another
   * holder (a takeover) replaced the token.
   * Best-effort: the lease expires on its own (short leaseMs), so a failed
   * release must never mask the caller's terminal outcome.
   */
  private async releaseLease(connectionId: string, ownerToken: string): Promise<void> {
    try {
      const releasePatch: BrokerConnectionUpdatePatch = {
        credentialRefreshLeaseExpiresAt: null,
        credentialRefreshLeaseOwner: null,
      };
      await this.connectionRepo
        .createQueryBuilder()
        .update(BrokerConnection)
        .set(releasePatch)
        .where('id = :id AND credential_refresh_lease_owner = :ownerToken', {
          id: connectionId,
          ownerToken,
        })
        .execute();
    } catch (err) {
      this.logger.warn(
        `Failed to release the refresh lease for connection=${connectionId} ` +
          `(owner ${ownerToken.slice(0, 8)}, self-expires anyway): ${(err as Error).message}`,
      );
    }
  }

  private async reloadRow(connectionId: string): Promise<BrokerConnection | null> {
    return this.connectionRepo.findOne({ where: { id: connectionId } });
  }

  /**
   * Decrypts the stored bundle when the row carries a NEWER generation in a
   * USABLE state (CREATED/VERIFIED/ROTATED). Returns null otherwise.
   */
  private adoptUsableNewerCredential(row: BrokerConnection): DecryptedBrokerCredentials | null {
    if (!BrokerCredentialLifecycle.isUsable(row.credentialStatus)) {
      return null;
    }
    if (
      row.encryptedCredentials === null ||
      row.credentialIv === null ||
      row.credentialTag === null ||
      row.encryptionKeyId === null
    ) {
      return null;
    }
    return this.encryptionService.decrypt({
      ciphertext: row.encryptedCredentials,
      iv: row.credentialIv,
      tag: row.credentialTag,
      keyId: row.encryptionKeyId,
    });
  }

  // ─── Winner path: provider refresh + generation-CAS persistence ───────────

  private async refreshAsWinner(
    connection: BrokerConnection,
    credentials: DecryptedBrokerCredentials,
    refreshToken: string,
    observedGeneration: number,
    claim: RefreshLeaseClaim,
  ): Promise<DecryptedBrokerCredentials> {
    // CLAIM-THEN-VERIFY: the lease can be acquired in the very instant a
    // newer generation (or a fail-closed INVALID) lands — a waiter's reload
    // snapshot may be older than its claim. Re-read the row BEFORE spending
    // the single provider refresh this lease grants: a stale claimer adopts
    // the newer pair and releases its claim instead of refreshing a
    // generation that was already rotated away (the persist-CAS below is the
    // final guard; this check keeps the provider call count at ONE per
    // generation in the contended case).
    const postClaimRow = await this.reloadRow(connection.id);
    if (postClaimRow && postClaimRow.credentialGeneration > observedGeneration) {
      const adopted = this.adoptUsableNewerCredential(postClaimRow);
      await this.releaseLease(connection.id, claim.ownerToken);
      if (adopted) {
        return adopted; // no provider call, no write, no audit
      }
      throw this.staleGenerationConflict(connection.id);
    }
    if (postClaimRow && postClaimRow.credentialStatus === BrokerCredentialStatus.INVALID) {
      // The credential is already dead (a fail-closed winner marked it while
      // we were claiming): surface the same typed conflict WITHOUT a second
      // provider round-trip and WITHOUT our own INVALID write.
      await this.releaseLease(connection.id, claim.ownerToken);
      throw this.refreshRejectedConflict(connection.id);
    }

    let tokens: CtraderOAuthTokens;
    try {
      tokens = await this.ctraderClient.refreshAccessToken(refreshToken);
    } catch (err) {
      if (err instanceof BrokerAdapterError && err.code === BrokerErrorCode.AUTHENTICATION_FAILED) {
        // The refresh token is DEAD at the provider — the persisted pair can
        // never authenticate again. Fail closed: mark INVALID (guarded by OUR
        // observed generation + EXACT lease-owner token — a lease-expiry
        // takeover that already persisted a NEWER pair, or a successor that
        // claimed and released after us, is authoritative and must survive)
        // and require re-authorization (never a silent fallback to the dead
        // pair).
        const outcome = await this.markRefreshRejected(connection, err, {
          observedGeneration,
          claim,
        });
        await this.releaseLease(connection.id, claim.ownerToken);
        if (outcome === 'SUPERSEDED_USABLE') {
          // A takeover winner persisted a NEWER usable pair while our provider
          // request was in flight — the rejection we saw belongs to the OLD
          // generation (already rotated away). The newer row is the truth.
          const adopted = await this.tryAdoptNewerUsable(connection.id, observedGeneration);
          if (adopted) {
            return adopted; // no INVALID write, no audit, no error
          }
        }
        throw this.refreshRejectedConflict(connection.id);
      }
      // Transient (network / timeout / rate limit): the stored pair may still
      // be usable later — propagate WITHOUT poisoning the credential state,
      // releasing our lease so the next attempt need not wait for expiry.
      this.logger.warn(
        `cTrader token refresh failed transiently for connection=${connection.id}: ` +
          `${err instanceof BrokerAdapterError ? err.code : 'UNKNOWN'}`,
      );
      await this.releaseLease(connection.id, claim.ownerToken);
      throw err;
    }

    // ATOMIC REPLACEMENT BEFORE USE (the critical ordering): cTrader
    // invalidated the previous pair the moment the refresh succeeded — the
    // new pair must reach the encrypted store BEFORE any consumer sees it,
    // in ONE guarded UPDATE (ciphertext + iv + tag + keyId + ROTATED status
    // + generation CAS bump + lease release). Round 6: the WHERE clause
    // carries the EXACT lease-owner token — a request whose lease was taken
    // over (or expired and reclaimed) matches ZERO rows and adopts instead.
    const expiresAt = new Date(this.now() + tokens.expiresIn * 1000);
    const updated: DecryptedBrokerCredentials = {
      ...credentials,
      apiKey: tokens.accessToken,
      accountId: credentials.accountId,
      additionalParams: {
        ...credentials.additionalParams,
        refreshToken: tokens.refreshToken,
        accessTokenExpiresAt: expiresAt.toISOString(),
      },
    };
    const encrypted = this.encryptionService.encrypt(updated);

    let affected: number | undefined;
    try {
      const persistPatch: BrokerConnectionUpdatePatch = {
        encryptedCredentials: encrypted.ciphertext,
        credentialIv: encrypted.iv,
        credentialTag: encrypted.tag,
        encryptionKeyId: encrypted.keyId,
        credentialStatus: BrokerCredentialStatus.ROTATED,
        credentialGeneration: observedGeneration + 1,
        // Release-on-success folded into the SAME atomic UPDATE (BOTH
        // lease columns — the owner token is dead the moment we land).
        credentialRefreshLeaseExpiresAt: null,
        credentialRefreshLeaseOwner: null,
      };
      const persistResult = await this.connectionRepo
        .createQueryBuilder()
        .update(BrokerConnection)
        .set(persistPatch)
        .where(
          'id = :id AND credential_generation = :observedGeneration AND ' +
            'credential_refresh_lease_owner = :ownerToken',
          {
            id: connection.id,
            observedGeneration,
            ownerToken: claim.ownerToken,
          },
        )
        .execute();
      affected = persistResult.affected;
    } catch (persistErr) {
      // The provider issued a new pair but persistence failed: the STORED
      // (now dead) pair can never authenticate again — the honest state is
      // INVALID (fail-closed), surfaced as a typed conflict. CORRECTION
      // ROUND 4 (finding 1) + ROUND 6 (lease-owner fencing): the INVALID
      // write is generation/owner-guarded — when a takeover winner already
      // persisted a NEWER usable generation, that newer pair stays
      // authoritative and THIS request converges onto it instead of
      // poisoning it.
      const outcome = await this.markRefreshRejected(connection, persistErr, {
        observedGeneration,
        claim,
      });
      await this.releaseLease(connection.id, claim.ownerToken);
      this.zeroCredentials(updated);
      if (outcome === 'SUPERSEDED_USABLE') {
        const adopted = await this.tryAdoptNewerUsable(connection.id, observedGeneration);
        if (adopted) {
          return adopted; // the takeover winner's pair is the truth
        }
      }
      if (outcome === 'SUPERSEDED_NOT_USABLE') {
        throw this.staleGenerationConflict(connection.id);
      }
      throw new ConflictException(
        `cTrader OAuth token refresh succeeded for connection ${connection.id} but the ` +
          'refreshed credential could not be persisted — the stored credential set is ' +
          'marked INVALID; re-authorize the connection.',
      );
    }

    if (affected !== 1) {
      // CAS FAIL: a NEWER generation already landed (manual/stolen rotation
      // or a lease-expiry takeover — our owner token no longer fences the
      // row). A STALE refresh response must NEVER overwrite the newer pair —
      // adopt it instead.
      const reloaded = await this.reloadRow(connection.id);
      // Own-token-only release (harmless if the CAS winner already cleared
      // the lease or replaced our claim).
      await this.releaseLease(connection.id, claim.ownerToken);
      this.zeroCredentials(updated);
      if (reloaded && reloaded.credentialGeneration > observedGeneration) {
        const adopted = this.adoptUsableNewerCredential(reloaded);
        if (adopted) {
          // No audit, no write, no error — the newer pair is the truth.
          return adopted;
        }
      }
      throw this.staleGenerationConflict(connection.id);
    }

    // Round 6 live-execution completion (§1b): the credential GENERATION
    // advanced (automatic OAuth rotation) — prior NEW-exposure authority
    // bound to the old generation is invalidated (the final dispatch
    // boundary also fences on credentialGeneration).
    //
    // P13 metrics: the terminal SUCCESS outcome of this refresh (the pair was
    // atomically persisted — brokerId label only, never token material).
    this.metrics?.increment(METRIC_NAMES.OAUTH_TOKEN_REFRESHES, {
      brokerId: connection.brokerId,
      outcome: 'SUCCESS',
    });
    await this.invalidateAuthorityAfterCredentialTransition(
      connection.userId,
      'BROKER_CREDENTIAL_ROTATED',
      `OAuth token refresh advanced credential generation for connection ` +
        `${connection.id} (${observedGeneration} -> ${observedGeneration + 1})`,
    );

    // Exactly ONE successful rotation audit event for this generation.
    await this.auditService.log({
      actorUserId: connection.userId,
      action: AuditAction.BROKER_OAUTH_TOKENS_REFRESHED,
      resourceType: 'BrokerConnection',
      resourceId: connection.id,
      metadata: {
        brokerId: connection.brokerId,
        accountId: connection.accountId,
        // Timestamps/generation only — NEVER token material.
        accessTokenExpiresAt: expiresAt.toISOString(),
        credentialGeneration: observedGeneration + 1,
      },
      severity: AuditSeverity.INFO,
    });
    this.logger.log(
      `cTrader OAuth tokens refreshed for connection=${connection.id} ` +
        `broker=${connection.brokerId} (generation ${observedGeneration} → ` +
        `${observedGeneration + 1}, expires ${expiresAt.toISOString()})`,
    );
    // Hand the caller a fresh copy, then zero the internal plaintext object.
    const result = { ...updated };
    this.zeroCredentials(updated);
    return result;
  }

  // ─── Fail-closed rejection + shared conflict messages ─────────────────────

  /**
   * Fail-closed rejection record (INVALID) — LEASE-OWNER FENCED (Sprint 56
   * correction round 4, architect finding 1; ownership hardened round 6).
   *
   * The write is a single conditional UPDATE on:
   *   - connection id matches; AND
   *   - credential_generation = observedGeneration (generation CAS); AND
   *   - credential_refresh_lease_owner = OUR EXACT owner token.
   *
   * There is NO `credential_refresh_lease_expires_at IS NULL` ownership
   * alternative (round 6): an expired-but-unreclaimed lease keeps its owner
   * token, so the ORIGINAL owner's honest fail-closed write still lands (F),
   * while a stale owner whose lease was TAKEN OVER — or whose successor
   * claimed and RELEASED — matches ZERO rows and can never mutate the row.
   *
   * Semantics:
   * - MARKED_INVALID: THIS request was the current owner of the observed
   *   generation and the row is exactly that generation — the write marks
   *   exactly that generation INVALID, releases OUR OWN lease (BOTH columns)
   *   in the SAME atomic UPDATE, and emits EXACTLY ONE sanitized audit event
   *   (timestamps / ids / generation only — never token material).
   * - affected rows = 0 → reload the authoritative row: a NEWER usable
   *   generation is the truth — NEVER overwrite it, NEVER emit a false
   *   "refresh failed" audit against it (SUPERSEDED_USABLE). A newer
   *   non-usable generation yields SUPERSEDED_NOT_USABLE.
   * - A row still held by a DIFFERENT owner's live lease (takeover in
   *   flight, same generation) is also never overwritten — the takeover
   *   winner's own terminal path decides that generation's fate.
   * - A DB write failure is MARK_FAILED (logged; the audit may still record
   *   the observed-generation provider rejection truthfully).
   */
  /**
   * Round 6 live-execution completion (§1b): fail-safe authority
   * invalidation after a durable credential-set transition. The transition
   * already landed; a failure here is logged loudly, never silent, and never
   * rolls back the durable fact.
   */
  private async invalidateAuthorityAfterCredentialTransition(
    userId: string,
    reason: 'BROKER_CREDENTIAL_INVALIDATED' | 'BROKER_CREDENTIAL_ROTATED',
    context: string,
  ): Promise<void> {
    try {
      await this.tradingAuthorityService.bumpGeneration(userId, reason);
      await this.grantInvalidation.invalidateUserNewExposureAuthority(userId, reason);
    } catch (err) {
      this.logger.error(
        `Authority invalidation (${reason}) failed for user ${userId} ` +
          `— ${context}: ${(err as Error).message}`,
      );
    }
  }

  private async markRefreshRejected(
    connection: BrokerConnection,
    err: unknown,
    guard: { observedGeneration: number; claim: RefreshLeaseClaim },
  ): Promise<RefreshRejectionOutcome> {
    let affected: number | undefined;
    try {
      const invalidPatch: BrokerConnectionUpdatePatch = {
        credentialStatus: BrokerCredentialStatus.INVALID,
        lastErrorMessage: 'OAuth token refresh rejected — re-authorization required',
        // Release OUR OWN lease in the SAME atomic write — BOTH columns
        // (a stale owner's token is never matched here, so a stale claim's
        // lease is never cleared by this write).
        credentialRefreshLeaseExpiresAt: null,
        credentialRefreshLeaseOwner: null,
      };
      const result = await this.connectionRepo
        .createQueryBuilder()
        .update(BrokerConnection)
        .set(invalidPatch)
        .where(
          'id = :id AND credential_generation = :observedGeneration AND ' +
            'credential_refresh_lease_owner = :ownerToken',
          {
            id: connection.id,
            observedGeneration: guard.observedGeneration,
            ownerToken: guard.claim.ownerToken,
          },
        )
        .execute();
      affected = result.affected;
    } catch (markErr) {
      this.logger.error(
        `Failed to mark connection=${connection.id} INVALID after refresh rejection: ` +
          `${(markErr as Error).message}`,
      );
      return 'MARK_FAILED';
    }

    if (affected === 1) {
      // P13 metrics: the terminal INVALID outcome — this request owned the
      // observed generation and the fail-closed credential rejection landed.
      this.metrics?.increment(METRIC_NAMES.OAUTH_TOKEN_REFRESHES, {
        brokerId: connection.brokerId,
        outcome: 'INVALID',
      });
      // Exactly ONE sanitized audit event for EXACTLY this generation.
      await this.auditService
        .log({
          actorUserId: connection.userId,
          action: AuditAction.BROKER_OAUTH_TOKEN_REFRESH_FAILED,
          resourceType: 'BrokerConnection',
          resourceId: connection.id,
          metadata: {
            brokerId: connection.brokerId,
            accountId: connection.accountId,
            credentialGeneration: guard.observedGeneration,
            error:
              err instanceof BrokerAdapterError
                ? `${err.code}`
                : err instanceof Error
                  ? err.name
                  : 'UNKNOWN',
          },
          severity: AuditSeverity.WARNING,
        })
        .catch(() => {
          /* audit best-effort — the guarded INVALID marking above is the gate */
        });
      // Round 6 live-execution completion (§1b): the credential set is now
      // INVALID (generation-fenced write landed) — the user's NEW-exposure
      // authority built on this credential set is gone.
      await this.invalidateAuthorityAfterCredentialTransition(
        connection.userId,
        'BROKER_CREDENTIAL_INVALIDATED',
        `OAuth token refresh rejected — connection ${connection.id} marked INVALID ` +
          `at credential generation ${guard.observedGeneration}`,
      );
      return 'MARKED_INVALID';
    }

    // affected = 0: the row moved — reload the AUTHORITATIVE row and let a
    // newer USABLE generation win. NEVER overwrite it; NEVER audit a false
    // "refresh failed" against a generation this request did not own.
    const authoritative = await this.reloadRow(connection.id);
    if (
      authoritative &&
      authoritative.credentialGeneration > guard.observedGeneration &&
      BrokerCredentialLifecycle.isUsable(authoritative.credentialStatus)
    ) {
      return 'SUPERSEDED_USABLE';
    }
    if (authoritative && authoritative.credentialGeneration > guard.observedGeneration) {
      return 'SUPERSEDED_NOT_USABLE';
    }
    // Same generation but another owner holds a LIVE lease (takeover in
    // flight): never write, never audit — the current lease owner's own
    // terminal path decides this generation. Surface the typed conflict.
    return 'SUPERSEDED_NOT_USABLE';
  }

  /**
   * Post-guard adoption: reload the row and decrypt a NEWER USABLE
   * generation, if any (the takeover winner's pair is the truth). Returns
   * null when no newer usable pair exists.
   */
  private async tryAdoptNewerUsable(
    connectionId: string,
    observedGeneration: number,
  ): Promise<DecryptedBrokerCredentials | null> {
    const row = await this.reloadRow(connectionId);
    if (!row || (row.credentialGeneration ?? 0) <= observedGeneration) {
      return null;
    }
    return this.adoptUsableNewerCredential(row);
  }

  /** The typed conflict thrown on BOTH the winner's and loser's INVALID path. */
  private refreshRejectedConflict(connectionId: string): ConflictException {
    return new ConflictException(
      `cTrader OAuth credentials for connection ${connectionId} were rejected on ` +
        'refresh — the credential set is marked INVALID; re-authorize the connection ' +
        '(broker OAuth flow) to restore trading.',
    );
  }

  /** CAS-fail conflict: a newer generation landed but is NOT usable. */
  private staleGenerationConflict(connectionId: string): ConflictException {
    return new ConflictException(
      `cTrader OAuth token refresh for connection ${connectionId} observed a stale ` +
        'credential generation — a newer rotated credential is already stored but is ' +
        'not usable; re-authorize the connection (broker OAuth flow) to restore trading.',
    );
  }

  /** Zeroes decrypted plaintext credential material (both token fields). */
  private zeroCredentials(credentials: DecryptedBrokerCredentials): void {
    const record = credentials as unknown as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      record[key] = null;
    }
  }
}
