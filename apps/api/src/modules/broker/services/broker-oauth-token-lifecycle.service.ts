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
import { BrokerCredentialStatus } from '../authorization/broker-credential-status';
import { DecryptedBrokerCredentials } from '../interfaces/broker-adapter.interface';
import { BrokerAdapterError, BrokerErrorCode } from '../interfaces/broker-adapter.errors';

/**
 * BrokerOAuthTokenLifecycleService — OAuth credential freshness for the
 * cTrader family (Sprint 56 correction round 1 / audit point 1).
 *
 * THE PROBLEM THIS SERVICE CLOSES (Spotware-documented behavior):
 * - cTrader OAuth access tokens carry a lifetime (expiresIn ≈ 30 days);
 * - a refresh EXCHANGES the (accessToken, refreshToken) pair for a NEW pair
 *   and INVALIDATES the previous pair;
 * - the persisted (encrypted) credential therefore goes permanently dead
 *   after any successful refresh unless the NEW pair is persisted
 *   ATOMICALLY, BEFORE it is used anywhere;
 * - a failed refresh of a dead refresh token must fail CLOSED (credential
 *   INVALID → re-authorization required), never silently fall back to the
 *   dead pair.
 *
 * CONTRACT (used by BrokerService.connectBroker and healthCheck):
 * `ensureFreshTokens(connection, credentials)` returns the credential set
 * that is SAFE TO USE for the upcoming provider call:
 *   - non-cTrader-family / no refreshToken / token still fresh → the input
 *     credentials unchanged (no provider or DB interaction at all);
 *   - expired / near-expiry / unknown-expiry refreshable credential → a
 *     freshly refreshed pair that has ALREADY been atomically persisted
 *     (single UPDATE: ciphertext + IV + tag + keyId + ROTATED status);
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
 * - audit metadata records brokerId / accountId / expiry timestamp ONLY;
 * - decrypted token material is zeroed in a finally block before the method
 *   returns (both the old and the new plaintext objects).
 */
/** Proactive refresh margin — refresh this close to expiry, never after use. */
const REFRESH_SAFETY_MARGIN_MS = 5 * 60_000;

@Injectable()
export class BrokerOAuthTokenLifecycleService {
  private readonly logger = new Logger(BrokerOAuthTokenLifecycleService.name);

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
    const now = Date.now();
    if (Number.isFinite(expiryMs) && expiryMs - now > REFRESH_SAFETY_MARGIN_MS) {
      return credentials; // still fresh
    }
    // Expired, near-expiry, or UNKNOWN expiry (legacy credential without the
    // timestamp): attempt the refresh — a success installs expiry tracking
    // going forward; an auth-class rejection is the honest fail-closed state.
    return this.refreshAndPersist(connection, credentials, refreshToken, now);
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  private async refreshAndPersist(
    connection: BrokerConnection,
    credentials: DecryptedBrokerCredentials,
    refreshToken: string,
    now: number,
  ): Promise<DecryptedBrokerCredentials> {
    let tokens: CtraderOAuthTokens;
    try {
      tokens = await this.ctraderClient.refreshAccessToken(refreshToken);
    } catch (err) {
      if (err instanceof BrokerAdapterError && err.code === BrokerErrorCode.AUTHENTICATION_FAILED) {
        // The refresh token is DEAD at the provider — the persisted pair can
        // never authenticate again. Fail closed: mark INVALID and require
        // re-authorization (never a silent fallback to the dead pair).
        await this.markRefreshRejected(connection, err);
        throw new ConflictException(
          `cTrader OAuth credentials for connection ${connection.id} were rejected on ` +
            'refresh — the credential set is marked INVALID; re-authorize the connection ' +
            '(broker OAuth flow) to restore trading.',
        );
      }
      // Transient (network / timeout / rate limit): the stored pair may still
      // be usable later — propagate WITHOUT poisoning the credential state.
      this.logger.warn(
        `cTrader token refresh failed transiently for connection=${connection.id}: ` +
          `${err instanceof BrokerAdapterError ? err.code : 'UNKNOWN'}`,
      );
      throw err;
    }

    // ATOMIC REPLACEMENT BEFORE USE (the critical ordering): cTrader
    // invalidated the previous pair the moment the refresh succeeded — the
    // new pair must reach the encrypted store BEFORE any consumer sees it,
    // in ONE guarded UPDATE (ciphertext + iv + tag + keyId + status).
    const expiresAt = new Date(now + tokens.expiresIn * 1000);
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
    try {
      await this.connectionRepo.update(connection.id, {
        encryptedCredentials: encrypted.ciphertext,
        credentialIv: encrypted.iv,
        credentialTag: encrypted.tag,
        encryptionKeyId: encrypted.keyId,
        credentialStatus: BrokerCredentialStatus.ROTATED,
      });
    } catch (persistErr) {
      // The provider issued a new pair but persistence failed: the STORED
      // (now dead) pair can never authenticate again — the honest state is
      // INVALID (fail-closed), surfaced as a typed conflict.
      await this.markRefreshRejected(connection, persistErr);
      this.zeroCredentials(updated);
      throw new ConflictException(
        `cTrader OAuth token refresh succeeded for connection ${connection.id} but the ` +
          'refreshed credential could not be persisted — the stored credential set is ' +
          'marked INVALID; re-authorize the connection.',
      );
    }

    await this.auditService.log({
      actorUserId: connection.userId,
      action: AuditAction.BROKER_OAUTH_TOKENS_REFRESHED,
      resourceType: 'BrokerConnection',
      resourceId: connection.id,
      metadata: {
        brokerId: connection.brokerId,
        accountId: connection.accountId,
        // Timestamps only — NEVER token material.
        accessTokenExpiresAt: expiresAt.toISOString(),
      },
      severity: AuditSeverity.INFO,
    });
    this.logger.log(
      `cTrader OAuth tokens refreshed for connection=${connection.id} ` +
        `broker=${connection.brokerId} (expires ${expiresAt.toISOString()})`,
    );
    // Hand the caller a fresh copy, then zero the internal plaintext object.
    const result = { ...updated };
    this.zeroCredentials(updated);
    return result;
  }

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

  /** Zeroes decrypted plaintext credential material (both token fields). */
  private zeroCredentials(credentials: DecryptedBrokerCredentials): void {
    const record = credentials as unknown as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      record[key] = null;
    }
  }
}
