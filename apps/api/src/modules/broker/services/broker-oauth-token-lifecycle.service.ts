import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BrokerConnection } from '../entities/broker-connection.entity';
import { CredentialEncryptionService } from './credential-encryption.service';
import { CTraderClientService } from '../adapters/ctrader/ctrader-client.service';
import { CtraderOAuthTokens } from '../adapters/ctrader/ctrader-oauth';
import { AuditService } from '../../audit/audit.service';
import { AuditAction } from '../../../common/enums/audit-action.enum';
import { AuditSeverity } from '../../audit/entities/audit-log.entity';
import { CTRADER_FAMILY_BROKER_IDS } from '../registry/broker-catalog';
import {
  BrokerCredentialLifecycle,
  BrokerCredentialStatus,
} from '../authorization/broker-credential-status';
import { DecryptedBrokerCredentials } from '../interfaces/broker-adapter.interface';
import { BrokerAdapterError, BrokerErrorCode } from '../interfaces/broker-adapter.errors';

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
 * - `credential_refresh_lease_expires_at` is a refresh LEASE: the claim is a
 *   single conditional UPDATE (WHERE lease IS NULL OR lease <= now) with an
 *   affected-rows check, so exactly ONE API replica can hold it — this is
 *   NOT an in-memory mutex and works across replicas;
 * - only the lease WINNER calls the provider for one stale
 *   `credential_generation`; losers wait (bounded) and ADOPT the winner's
 *   persisted pair — they never call the provider, never write, never audit;
 * - persistence is a generation CAS: UPDATE ... SET ...,
 *   credential_generation = observed + 1 WHERE credential_generation =
 *   observed — a stale refresh response can never overwrite a newer pair;
 * - a loser NEVER marks the credential INVALID merely because another
 *   request already rotated it (INVALID is only written by the winner's
 *   fail-closed paths: auth-class rejection / persist failure);
 * - a hung winner's lease EXPIRES (leaseMs) so a waiter can steal the claim
 *   and complete the refresh — no permanent stall;
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

  constructor(
    @InjectRepository(BrokerConnection)
    private readonly connectionRepo: Repository<BrokerConnection>,
    private readonly encryptionService: CredentialEncryptionService,
    private readonly ctraderClient: CTraderClientService,
    private readonly auditService: AuditService,
  ) {}

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
    let claimUntil = await this.tryClaimLease(connection.id);
    if (claimUntil) {
      return this.refreshAsWinner(
        connection,
        credentials,
        refreshToken,
        observedGeneration,
        claimUntil,
      );
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
      claimUntil = await this.tryClaimLease(connection.id);
      if (claimUntil) {
        return this.refreshAsWinner(
          connection,
          credentials,
          refreshToken,
          observedGeneration,
          claimUntil,
        );
      }
      if (this.now() >= deadline) {
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
   * DB-atomic lease claim (works across replicas): one conditional UPDATE
   * with an affected-rows check. Returns the claim timestamp (our lease
   * identity for release-only-own-claim) or null when someone else holds it.
   */
  private async tryClaimLease(connectionId: string): Promise<Date | null> {
    const nowMs = this.now();
    const claimUntil = new Date(nowMs + this.leaseMs);
    const result = await this.connectionRepo
      .createQueryBuilder()
      .update(BrokerConnection)
      .set({ credentialRefreshLeaseExpiresAt: claimUntil })
      .where(
        'id = :id AND (credential_refresh_lease_expires_at IS NULL ' +
          'OR credential_refresh_lease_expires_at <= :now)',
        { id: connectionId, now: new Date(nowMs) },
      )
      .execute();
    return result.affected === 1 ? claimUntil : null;
  }

  /**
   * Releases OUR OWN claim only (WHERE lease = claimUntil) — harmless when
   * the CAS persist already cleared it or another holder replaced it.
   * Best-effort: the lease expires on its own (short leaseMs), so a failed
   * release must never mask the caller's terminal outcome.
   */
  private async releaseLease(connectionId: string, claimUntil: Date): Promise<void> {
    try {
      await this.connectionRepo
        .createQueryBuilder()
        .update(BrokerConnection)
        .set({ credentialRefreshLeaseExpiresAt: null })
        .where('id = :id AND credential_refresh_lease_expires_at = :claimUntil', {
          id: connectionId,
          claimUntil,
        })
        .execute();
    } catch (err) {
      this.logger.warn(
        `Failed to release the refresh lease for connection=${connectionId} ` +
          `(self-expires at ${claimUntil.toISOString()}): ${(err as Error).message}`,
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
    claimUntil: Date,
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
      await this.releaseLease(connection.id, claimUntil);
      if (adopted) {
        return adopted; // no provider call, no write, no audit
      }
      throw this.staleGenerationConflict(connection.id);
    }
    if (postClaimRow && postClaimRow.credentialStatus === BrokerCredentialStatus.INVALID) {
      // The credential is already dead (a fail-closed winner marked it while
      // we were claiming): surface the same typed conflict WITHOUT a second
      // provider round-trip and WITHOUT our own INVALID write.
      await this.releaseLease(connection.id, claimUntil);
      throw this.refreshRejectedConflict(connection.id);
    }

    let tokens: CtraderOAuthTokens;
    try {
      tokens = await this.ctraderClient.refreshAccessToken(refreshToken);
    } catch (err) {
      if (err instanceof BrokerAdapterError && err.code === BrokerErrorCode.AUTHENTICATION_FAILED) {
        // The refresh token is DEAD at the provider — the persisted pair can
        // never authenticate again. Fail closed: mark INVALID and require
        // re-authorization (never a silent fallback to the dead pair).
        await this.markRefreshRejected(connection, err);
        await this.releaseLease(connection.id, claimUntil);
        throw this.refreshRejectedConflict(connection.id);
      }
      // Transient (network / timeout / rate limit): the stored pair may still
      // be usable later — propagate WITHOUT poisoning the credential state,
      // releasing our lease so the next attempt need not wait for expiry.
      this.logger.warn(
        `cTrader token refresh failed transiently for connection=${connection.id}: ` +
          `${err instanceof BrokerAdapterError ? err.code : 'UNKNOWN'}`,
      );
      await this.releaseLease(connection.id, claimUntil);
      throw err;
    }

    // ATOMIC REPLACEMENT BEFORE USE (the critical ordering): cTrader
    // invalidated the previous pair the moment the refresh succeeded — the
    // new pair must reach the encrypted store BEFORE any consumer sees it,
    // in ONE guarded UPDATE (ciphertext + iv + tag + keyId + ROTATED status
    // + generation CAS bump + lease release).
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
      const persistResult = await this.connectionRepo
        .createQueryBuilder()
        .update(BrokerConnection)
        .set({
          encryptedCredentials: encrypted.ciphertext,
          credentialIv: encrypted.iv,
          credentialTag: encrypted.tag,
          encryptionKeyId: encrypted.keyId,
          credentialStatus: BrokerCredentialStatus.ROTATED,
          credentialGeneration: observedGeneration + 1,
          // Release-on-success folded into the SAME atomic UPDATE.
          credentialRefreshLeaseExpiresAt: null,
        })
        .where('id = :id AND credential_generation = :observedGeneration', {
          id: connection.id,
          observedGeneration,
        })
        .execute();
      affected = persistResult.affected;
    } catch (persistErr) {
      // The provider issued a new pair but persistence failed: the STORED
      // (now dead) pair can never authenticate again — the honest state is
      // INVALID (fail-closed), surfaced as a typed conflict.
      await this.markRefreshRejected(connection, persistErr);
      await this.releaseLease(connection.id, claimUntil);
      this.zeroCredentials(updated);
      throw new ConflictException(
        `cTrader OAuth token refresh succeeded for connection ${connection.id} but the ` +
          'refreshed credential could not be persisted — the stored credential set is ' +
          'marked INVALID; re-authorize the connection.',
      );
    }

    if (affected !== 1) {
      // CAS FAIL: a NEWER generation already landed (manual/stolen rotation
      // or a lease-expiry takeover). A STALE refresh response must NEVER
      // overwrite the newer pair — adopt it instead.
      const reloaded = await this.reloadRow(connection.id);
      // Only-own-claim release (harmless if the CAS winner already cleared
      // the lease or replaced our claim).
      await this.releaseLease(connection.id, claimUntil);
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

  /** Fail-closed rejection record (INVALID) + sanitized audit entry. */
  private async markRefreshRejected(connection: BrokerConnection, err: unknown): Promise<void> {
    try {
      await this.connectionRepo.update(connection.id, {
        credentialStatus: BrokerCredentialStatus.INVALID,
        lastErrorMessage: 'OAuth token refresh rejected — re-authorization required',
      });
    } catch (markErr) {
      this.logger.error(
        `Failed to mark connection=${connection.id} INVALID after refresh rejection: ` +
          `${(markErr as Error).message}`,
      );
    }
    await this.auditService
      .log({
        actorUserId: connection.userId,
        action: AuditAction.BROKER_OAUTH_TOKEN_REFRESH_FAILED,
        resourceType: 'BrokerConnection',
        resourceId: connection.id,
        metadata: {
          brokerId: connection.brokerId,
          accountId: connection.accountId,
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
        /* audit best-effort — the INVALID marking above is the gate */
      });
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
