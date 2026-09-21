import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { BrokerConnection } from './entities/broker-connection.entity';
import { BrokerAccount } from './entities/broker-account.entity';
import { BrokerAdapterRegistry } from './adapters/broker-adapter.registry';
import { CredentialEncryptionService } from './services/credential-encryption.service';
import { BrokerOAuthTokenLifecycleService } from './services/broker-oauth-token-lifecycle.service';
import { BrokerLinkOutboxService } from './services/broker-link-outbox.service';
import { TradingAuthorityService } from '../execution-authority/trading-authority.service';
import { GrantInvalidationService } from '../execution-authority/grant-invalidation.service';
import { BrokerLinkOutboxAuditPayload } from './entities/broker-link-outbox.entity';
import { computeLogicalAccountKey } from './utils/logical-account-key';
import { isUniqueViolation } from './utils/db-unique-violation';
import { BrokerLogicalAccountConflictError } from './interfaces/broker-connection.errors';
import {
  BrokerAccountInfo,
  BrokerConnectionStatus,
  BrokerConnectionTestResult,
  BrokerInstrument,
  BrokerMode,
  BrokerPrice,
  DecryptedBrokerCredentials,
  OHLCV,
} from './interfaces/broker-adapter.interface';
// Round 7.1 (P0-1): typed fail-closed environment-mismatch error.
import { BrokerEnvironmentMismatchError } from './interfaces/broker-environment-mismatch.error';
import {
  BrokerAccountSnapshotService,
  type ProviderAccountObservation,
} from './services/broker-account-snapshot.service';
import { BrokerAdapterError } from './interfaces/broker-adapter.errors';
import {
  BrokerAuthorizationStatus,
  BrokerAuthorizationStateMachine,
} from './authorization/broker-authorization-status';
import {
  BrokerCredentialStatus,
  BrokerCredentialLifecycle,
} from './authorization/broker-credential-status';
import { BrokerProviderRegistryService } from './registry/broker-provider-registry.service';
import { CTRADER_FAMILY_BROKER_IDS } from './registry/broker-catalog';
import {
  catalogEntryToEvidence,
  connectionLiveVerificationStatus,
  PROVIDER_TECHNOLOGY,
  type ProviderLiveVerificationEvidence,
} from './verification/provider-live-verification.policy';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../../common/enums/audit-action.enum';
import { AuditSeverity } from '../audit/entities/audit-log.entity';
import { ConnectBrokerDto } from './dto/connect-broker.dto';
import { DomainEventBus } from '../events/event-bus.service';
import { DomainEventType } from '../events/enums/domain-event-type.enum';
import { ModuleRef } from '@nestjs/core';
// Production-LIVE completion round (P13 metrics): dependency-free in-process
// counters (lazy ModuleRef seam — same pattern as risk.service).
import { MetricsService } from '../metrics/metrics.service';
import { METRIC_NAMES } from '../metrics/metric-names';

/**
 * BrokerService — Core broker connection lifecycle management.
 *
 * SECURITY INVARIANTS (enforced throughout):
 * 1. Decrypted credentials exist in memory only for the duration of the adapter call
 * 2. Credentials are NEVER logged — log only accountId, brokerId, connectionId
 * 3. Credentials are NEVER returned from any method or included in any response
 * 4. DEMO mode is mandatory before LIVE mode can be enabled
 * 5. Credential encryption/decryption delegated to CredentialEncryptionService only
 * 6. Mutable adapter mode/account state is scoped to BrokerConnection.id
 *    (#291 / correction round 3): testCredentials uses ephemeral adapters;
 *    persisted-connection operations use registry.getAdapterForConnection().
 *
 * See: docs/architecture/09-broker-integration-architecture.md
 */
/**
 * Server-derived createConnection inputs (Sprint 56 correction rounds 4+5).
 * SERVER-ONLY channel — the public ConnectBrokerDto can never submit or
 * overwrite any of these fields.
 */
export interface BrokerConnectionServerDerived {
  /**
   * Round 4 (finding 9): sanitized normalized identity of the actual broker
   * behind the connection (cTrader 2149 discovery), null = unknown.
   */
  providerBrokerIdentity?: string | null;
  /**
   * Round 5 (issue #332): the SERVER-COMPUTED logical account key. When
   * explicitly provided (the OAuth link path passes the exact key it also
   * pre-checks for adoption), it is persisted verbatim at INSERT time; when
   * omitted, it is DERIVED from (brokerId, providerBrokerIdentity,
   * accountId) — manual connects are idempotency-protected by the same
   * partial unique index.
   */
  logicalAccountKey?: string | null;
  /** Round 5 (#332): originating OAuth flow (outbox traceability only). */
  flowId?: string | null;
  /**
   * Round 5 (#332): the OAuth ACCOUNT_LINKED audit entry committed
   * ATOMICALLY with the connection (durable-truth audit — delivered by the
   * outbox sweep after commit, never lost, never on the critical path).
   */
  linkAudit?: { payload: BrokerLinkOutboxAuditPayload } | null;
}

@Injectable()
export class BrokerService {
  private readonly logger = new Logger(BrokerService.name);

  /** In-process instrument-spec cache TTL (§1a/§4): short enough that an
   * account switch on a connection re-resolves quickly, long enough that a
   * risk validation burst does not hammer the provider. */
  private static readonly INSTRUMENT_SPEC_CACHE_TTL_MS = 60_000;

  private readonly instrumentSpecCache = new Map<
    string,
    { spec: BrokerInstrument; expiresAt: number }
  >();

  constructor(
    @InjectRepository(BrokerConnection)
    private connectionRepo: Repository<BrokerConnection>,
    @InjectRepository(BrokerAccount)
    private accountRepo: Repository<BrokerAccount>,
    private adapterRegistry: BrokerAdapterRegistry,
    private providerRegistry: BrokerProviderRegistryService,
    private encryptionService: CredentialEncryptionService,
    private auditService: AuditService,
    private readonly eventBus: DomainEventBus,
    // Sprint 56 correction round 1 (audit point 1): OAuth credential
    // freshness for the cTrader family (refresh + atomic persist).
    private readonly tokenLifecycle: BrokerOAuthTokenLifecycleService,
    // Sprint 56 correction round 5 (architect issue #332): durable outbox
    // for post-commit audit/event side effects of connection creation.
    private readonly linkOutbox: BrokerLinkOutboxService,
    // Round 6 (#2/#300): broker authority transitions (disconnect, revoke)
    // bump the user TradingAuthorityGeneration + invalidate NEW exposure
    // through the tenant-scoped leaf seams.
    private readonly tradingAuthorityService: TradingAuthorityService,
    private readonly grantInvalidation: GrantInvalidationService,
    // Round 6 live-execution completion (§1a): the accepted snapshot model is
    // the financial authority for broker connections — every provider account
    // observation is accepted as a monotonic snapshot and the legacy
    // broker.broker_accounts row becomes a projection of it.
    private readonly snapshotService: BrokerAccountSnapshotService,
    /**
     * Production-LIVE completion round (P13 metrics): lazy metrics seam —
     * OPTIONAL trailing dependency so the ONE spec that constructs
     * BrokerService directly (broker-authorization.pg-integration.spec.ts)
     * keeps compiling unchanged. Resolved at CALL time via
     * ModuleRef.get(..., { strict: false }); when absent every
     * `this.metrics?.…` call site no-ops (see metrics.module.ts for the DI
     * decision — observability can never break broker control flow).
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

  // ─── Read operations ──────────────────────────────────────────────────────

  /**
   * Sprint 50 PR-4 — load connections by id for the reconciliation worker
   * (it discovers candidate connection ids from internal trading state and
   * needs the full connection rows to reach their adapters).
   */
  async findConnectionsByIds(connectionIds: string[]): Promise<BrokerConnection[]> {
    if (connectionIds.length === 0) return [];
    return this.connectionRepo.find({
      where: connectionIds.map((id) => ({ id }) as never),
    });
  }

  async findConnectionsByUser(userId: string): Promise<BrokerConnection[]> {
    return this.connectionRepo.find({
      where: { userId },
      order: { createdAt: 'DESC' },
    });
  }

  async findConnectionById(connectionId: string, userId: string): Promise<BrokerConnection> {
    const connection = await this.connectionRepo.findOne({
      where: { id: connectionId, userId },
    });
    if (!connection) {
      throw new NotFoundException('Broker connection not found');
    }
    return connection;
  }

  async findActiveConnectionForUser(userId: string): Promise<BrokerConnection | null> {
    return this.connectionRepo.findOne({
      where: { userId, status: BrokerConnectionStatus.CONNECTED },
      order: { createdAt: 'DESC' },
    });
  }

  getSupportedBrokers() {
    return this.adapterRegistry.getSupportedBrokers();
  }

  // ─── Create / Test connection ─────────────────────────────────────────────

  /**
   * Test broker credentials without creating a persistent connection.
   * Returns connection test result. Credentials never logged or persisted here.
   */
  async testCredentials(
    dto: ConnectBrokerDto,
    userId: string,
    ipAddress?: string,
  ): Promise<{ success: boolean; accountId?: string; errorMessage?: string }> {
    // #291 / correction round 3: credential tests run on an EPHEMERAL adapter
    // context — never the metadata root and never a persisted connection's
    // session. The adapter disposes its temporary provider sessions in a
    // finally-safe path (finding 5).
    const adapter = this.adapterRegistry.createEphemeralAdapter(dto.brokerId);
    adapter.setMode(dto.accountType as BrokerMode);

    const credentials: DecryptedBrokerCredentials = {
      apiKey: dto.apiKey,
      apiSecret: dto.apiSecret,
      accountId: dto.accountId,
      serverUrl: dto.serverUrl,
      additionalParams: dto.additionalParams,
    };

    try {
      const result = await adapter.testConnection(credentials);

      await this.auditService.log({
        actorUserId: userId,
        action: result.success
          ? AuditAction.BROKER_CONNECTION_TESTED
          : AuditAction.BROKER_CONNECTION_TEST_FAILED,
        ipAddress,
        metadata: {
          brokerId: dto.brokerId,
          accountType: dto.accountType,
          success: result.success,
          errorCode: result.errorCode,
        },
      });

      return {
        success: result.success,
        accountId: result.accountId,
        errorMessage: result.errorMessage,
      };
    } catch (err) {
      const errMsg = err instanceof BrokerAdapterError ? err.message : 'Connection test failed';
      await this.auditService.log({
        actorUserId: userId,
        action: AuditAction.BROKER_CONNECTION_TEST_FAILED,
        ipAddress,
        metadata: { brokerId: dto.brokerId, error: errMsg },
        severity: AuditSeverity.WARNING,
      });
      return { success: false, errorMessage: errMsg };
    }
  }

  /**
   * Save a broker connection with encrypted credentials.
   * Does NOT establish a live connection — use connectBroker() for that.
   *
   * DURABLE IDEMPOTENCY (Sprint 56 correction round 5, architect issue #332):
   * - The BrokerConnection INSERT, its logical_account_key, and ALL
   *   post-commit side-effect work (connection-created audit, status event,
   *   and the optional OAuth link audit) commit in ONE transaction. The
   *   audit/event delivery itself moved OUT of the critical path into the
   *   broker_link_outbox (swept by BrokerLinkOutboxService) — an audit/event
   *   failure can therefore NEVER make a committed connection look
   *   uncommitted: createConnection throws ⟺ the transaction rolled back
   *   (zero durable rows), and succeeds ⟺ the row AND its outbox work are
   *   durable. This proof is what lets BrokerOAuthService.linkAccount restore
   *   a flow to AUTHORIZED ONLY on a provably side-effect-free failure.
   * - The per-user partial unique index on (user_id, logical_account_key)
   *   protects the INSERT itself: a duplicate logical account throws
   *   BrokerLogicalAccountConflictError carrying the EXISTING connection
   *   (manual connects surface an honest 409; the OAuth link path adopts).
   *
   * PUBLIC BEHAVIOR for manual (non-OAuth) connects: unchanged apart from the
   * two durable-idempotency guarantees above — credentials are still
   * AES-256-GCM encrypted at insert; the BROKER_CONNECTION_CREATED audit is
   * still emitted (asynchronously via the outbox sweep, with retries instead
   * of the old fire-and-forget); the return value is still the saved row.
   */
  async createConnection(
    dto: ConnectBrokerDto,
    userId: string,
    ipAddress?: string,
    serverDerived?: BrokerConnectionServerDerived,
  ): Promise<BrokerConnection> {
    if (!this.adapterRegistry.isSupported(dto.brokerId)) {
      throw new BadRequestException(`Unsupported broker: ${dto.brokerId}`);
    }

    // Registry gate (Directive §11): the provider must explicitly support the
    // requested environment — never inferred from credentials or UI state.
    if (!this.providerRegistry.supportsEnvironment(dto.brokerId, dto.accountType as BrokerMode)) {
      throw new BadRequestException(
        `Broker ${dto.brokerId} does not support ${dto.accountType} accounts`,
      );
    }

    // Phase H (architect): production-LIVE eligibility fails closed —
    // implementation status (BETA) and adapter availability are NOT
    // production-LIVE approval. LIVE connections require a CURRENT protocol
    // certification (CERTIFIED); legacy attestation and UNVERIFIED providers
    // are both DEMO-only. The message names the truthful derived state so the
    // operator/user can distinguish "legacy evidence retained" from "never
    // certified".
    if (
      dto.accountType === BrokerMode.LIVE &&
      !this.providerRegistry.isProductionLiveEligible(dto.brokerId)
    ) {
      const certificationState =
        this.providerRegistry.getEntry(dto.brokerId)?.certificationState ?? 'NOT_CERTIFIED';
      throw new ForbiddenException(
        certificationState === 'LEGACY_VERIFIED'
          ? `Broker ${dto.brokerId} carries only legacy production evidence ` +
              `(LEGACY_VERIFIED) — a current certification run (CERTIFIED) is required ` +
              'before LIVE connections. LIVE is fail-closed.'
          : `Broker ${dto.brokerId} is not production-LIVE certified — ` +
              'LIVE connections are fail-closed (BETA is DEMO-only)',
      );
    }

    // IDENTITY-SCOPED production-LIVE verification (Sprint 56 correction
    // round 4, architect finding 10): for the cTrader FAMILY — where many
    // brokers share ONE technology — catalog-level verification is NEVER
    // blanket evidence. LIVE eligibility additionally requires VERIFIED
    // evidence matching the connection's SERVER-DERIVED provider identity
    // (finding 9) exactly: unknown identity fails closed; one broker's
    // verification never authorizes another; technology-level evidence
    // never applies. (Today every cTrader-family entry is UNVERIFIED, so
    // this gate is redundantly fail-closed — the model exists so a future
    // VERIFIED flip can never leak authorization across identities.)
    if (dto.accountType === BrokerMode.LIVE && CTRADER_FAMILY_BROKER_IDS.includes(dto.brokerId)) {
      const connectionIdentity = serverDerived?.providerBrokerIdentity ?? null;
      const evidence = this.ctraderFamilyLiveEvidence();
      if (
        connectionLiveVerificationStatus({
          brokerId: dto.brokerId,
          providerTechnology: PROVIDER_TECHNOLOGY.CTRADER,
          connectionProviderIdentity: connectionIdentity,
          environment: 'LIVE',
          evidence,
        }) !== 'VERIFIED'
      ) {
        throw new ForbiddenException(
          `Broker ${dto.brokerId} LIVE connections require identity-scoped ` +
            'production-LIVE verification matching the server-derived broker identity ' +
            `(${connectionIdentity ?? 'unknown'}) — fail-closed.`,
        );
      }
    }

    const credentials: DecryptedBrokerCredentials = {
      apiKey: dto.apiKey,
      apiSecret: dto.apiSecret,
      accountId: dto.accountId,
      serverUrl: dto.serverUrl,
      additionalParams: dto.additionalParams,
    };

    const encrypted = this.encryptionService.encrypt(credentials);

    // Logical account key (issue #332): EXPLICIT server-provided key when the
    // OAuth link path passes the exact key it pre-checked for adoption;
    // otherwise DERIVED from the row's own facts (manual connects get the same
    // per-user uniqueness protection — matching the migration backfill).
    const logicalAccountKey =
      serverDerived?.logicalAccountKey !== undefined && serverDerived.logicalAccountKey !== null
        ? serverDerived.logicalAccountKey
        : computeLogicalAccountKey(
            dto.brokerId,
            serverDerived?.providerBrokerIdentity,
            dto.accountId,
          );

    const connection = this.connectionRepo.create({
      userId,
      brokerId: dto.brokerId,
      brokerName: this.adapterRegistry.getAdapter(dto.brokerId).brokerName,
      displayName: dto.displayName ?? `${dto.brokerId} ${dto.accountType}`,
      accountId: dto.accountId,
      accountType: dto.accountType as BrokerMode,
      // SERVER-DERIVED provider identity (correction round 4, finding 9):
      // sanitized normalized identity from provider discovery — set ONLY by
      // the server-side linking path (never the public DTO), null = unknown.
      providerBrokerIdentity: serverDerived?.providerBrokerIdentity ?? null,
      // Durable idempotency key (issue #332) — persisted AT INSERT TIME so the
      // partial unique index protects the INSERT itself.
      logicalAccountKey,
      status: BrokerConnectionStatus.DISCONNECTED,
      authorizationStatus: BrokerAuthorizationStatus.NOT_CONNECTED,
      credentialStatus: BrokerCredentialStatus.CREATED,
      encryptedCredentials: encrypted.ciphertext,
      credentialIv: encrypted.iv,
      credentialTag: encrypted.tag,
      encryptionKeyId: encrypted.keyId,
    });

    // ONE transaction (issue #332): the connection INSERT and ALL of its
    // post-commit side-effect WORK (connection-created audit + status event +
    // the optional OAuth link audit) commit together — or roll back together
    // (zero durable rows). Delivery happens asynchronously via the outbox
    // sweep, so an audit/event failure can NEVER make a committed connection
    // look uncommitted.
    let saved: BrokerConnection;
    try {
      saved = await this.connectionRepo.manager.transaction(async (manager) => {
        const row = await manager.getRepository(BrokerConnection).save(connection);
        await this.linkOutbox.enqueueWithinTransaction(manager, [
          {
            connectionId: row.id,
            flowId: serverDerived?.flowId ?? null,
            eventType: 'connection-created-audit',
            payload: {
              action: AuditAction.BROKER_CONNECTION_CREATED,
              actorUserId: userId,
              ipAddress: ipAddress ?? null,
              metadata: {
                brokerId: dto.brokerId,
                accountId: dto.accountId,
                accountType: dto.accountType,
              },
              severity: AuditSeverity.INFO,
            },
          },
          {
            connectionId: row.id,
            flowId: serverDerived?.flowId ?? null,
            eventType: 'broker-status-event',
            payload: {
              domainEventType: DomainEventType.BROKER_STATUS_CHANGED,
              userId,
              payload: {
                userId,
                connectionId: row.id,
                status: BrokerConnectionStatus.DISCONNECTED,
                previousStatus: null,
                reason: 'created',
              },
            },
          },
          ...(serverDerived?.linkAudit
            ? [
                {
                  connectionId: row.id,
                  flowId: serverDerived?.flowId ?? null,
                  eventType: 'oauth-account-linked-audit' as const,
                  payload: serverDerived.linkAudit.payload,
                },
              ]
            : []),
        ]);
        return row;
      });
    } catch (err) {
      // Durable-idempotency conflict: the INSERT hit the per-user partial
      // unique index — a non-deleted connection for this logical account
      // already exists. Load it and hand it to the caller for ADOPTION (the
      // OAuth link path converges its flow and returns the existing row;
      // manual connects surface the honest 409).
      if (logicalAccountKey && isUniqueViolation(err)) {
        const existing = await this.findLiveConnectionByLogicalKey(userId, logicalAccountKey);
        if (existing) {
          this.logger.warn(
            `Broker connection INSERT hit the logical-account unique index: ` +
              `broker=${dto.brokerId} user=${userId} key=${logicalAccountKey} ` +
              `existing=${existing.id} — adopting the existing connection`,
          );
          throw new BrokerLogicalAccountConflictError(logicalAccountKey, existing);
        }
      }
      throw err;
    }

    this.logger.log(
      `Broker connection created: id=${saved.id} broker=${dto.brokerId} user=${userId}`,
    );
    return saved;
  }

  /**
   * Durable-idempotency lookup (issue #332): the non-deleted (live)
   * connection for a user's logical broker account, or null. The OAuth link
   * path uses this to PROVE whether a prior attempt already committed the
   * durable connection (adoption) before inserting a new row; the partial
   * unique index remains the hard backstop for the check-then-insert race.
   */
  async findLiveConnectionByLogicalKey(
    userId: string,
    logicalAccountKey: string,
  ): Promise<BrokerConnection | null> {
    return this.connectionRepo.findOne({
      where: { userId, logicalAccountKey, deletedAt: IsNull() },
      order: { createdAt: 'DESC' },
    });
  }

  // ─── Connect / Disconnect ─────────────────────────────────────────────────

  /**
   * Credential-lifecycle guard (architect correction A3): fail closed BEFORE
   * persisted credentials are decrypted or used. Only CREATED / VERIFIED /
   * ROTATED credential states may be consumed — INVALID / EXPIRED / REVOKED /
   * missing / unknown states never reach the provider adapter.
   */
  private assertCredentialsUsable(connection: BrokerConnection, operation: string): void {
    if (!BrokerCredentialLifecycle.isUsable(connection.credentialStatus)) {
      throw new ConflictException(
        `Broker credentials for connection ${connection.id} are ` +
          `${connection.credentialStatus ?? 'MISSING'} — ${operation} requires usable ` +
          'credentials (fail-closed; rotate credentials to restore use)',
      );
    }
  }

  /**
   * Establish a live connection to the broker using stored encrypted credentials.
   * Decrypted credentials exist in memory only for the duration of this method.
   */
  async connectBroker(
    connectionId: string,
    userId: string,
    ipAddress?: string,
  ): Promise<BrokerConnection> {
    const connection = await this.findConnectionById(connectionId, userId);
    // #291 / correction round 3: ONE mutable adapter context per persisted
    // BrokerConnection.id — concurrent operations on the same connection share
    // it; other connections can never observe its in-flight setMode/account
    // state. Alias ids (pepperstone-ctrader, icmarkets-ctrader) resolve through
    // the canonical factory while preserving the requested identity.
    const adapter = this.adapterRegistry.getAdapterForConnection(
      connection.id,
      connection.brokerId,
    );

    if (!connection.encryptedCredentials || !connection.credentialIv || !connection.credentialTag) {
      throw new BadRequestException('Broker connection has no stored credentials');
    }

    // A3: the lifecycle gate runs BEFORE any decrypt/adapter call — a revoked,
    // expired, or invalid credential set must never reach the provider.
    this.assertCredentialsUsable(connection, 'connectBroker');

    const canEnterConnecting = BrokerAuthorizationStateMachine.canTransition(
      connection.authorizationStatus,
      BrokerAuthorizationStatus.CONNECTING,
    );

    // A4: conditional write — applies only while the persisted authorization
    // state still matches the loaded row (concurrent writers surface as a
    // Conflict instead of being silently overwritten).
    await this.applyGuardedAuthorizationUpdate(
      connectionId,
      connection.authorizationStatus,
      {
        status: BrokerConnectionStatus.CONNECTING,
        consecutiveFailureCount: 0,
        // State machine: CONNECTING is only valid from these states; when the
        // current state does not allow it (e.g. mid-reconnect), the existing
        // state is preserved and the terminal update below still applies.
        ...(canEnterConnecting
          ? { authorizationStatus: BrokerAuthorizationStatus.CONNECTING }
          : {}),
      },
      'connectBroker CONNECTING transition',
    );

    // Effective in-flight state for terminal-transition validation: when we
    // entered CONNECTING, transitions must be validated FROM CONNECTING (the
    // stale pre-connect state would wrongly reject valid terminal states).
    const inFlightAuthorization = canEnterConnecting
      ? BrokerAuthorizationStatus.CONNECTING
      : connection.authorizationStatus;

    // Decrypt — credentials are in memory only from here
    const credentials = this.encryptionService.decrypt({
      ciphertext: connection.encryptedCredentials,
      iv: connection.credentialIv,
      tag: connection.credentialTag,
      keyId: connection.encryptionKeyId ?? 'env-key-v1',
    });

    adapter.setMode(connection.accountType);

    // Sprint 56 correction round 1 (audit point 1): OAuth credential
    // freshness gate — cTrader-family credentials carrying a refresh token
    // are refreshed (and the new pair ATOMICALLY persisted) BEFORE the
    // adapter sees the token. Reconnect/health paths thereby always run on
    // the current token; a rejected refresh fails closed (INVALID).
    let connectCredentials = credentials;
    try {
      connectCredentials = await this.tokenLifecycle.ensureFreshTokens(connection, credentials);
      const result = await adapter.connect(connectCredentials);

      // Round 7 (P0 — declared-vs-observed environment enforcement): the
      // provider-observed account environment (BrokerConnectionResult.
      // accountType — e.g. MetaApi's info.type) must MATCH the connection's
      // DECLARED accountType. A mislabeled environment is a SECURITY event:
      // a LIVE provider account declared as DEMO would otherwise sail past
      // the demo-authorization path (AUTHORIZED + demoValidated) and the
      // LIVE verification gates — real money executing under DEMO semantics
      // on the only VERIFIED real-money route. Fail-closed: ERROR transition,
      // zero authorization advance, audited with a typed code. Adapters that
      // only echo the requested mode never trip this gate; it bites exactly
      // when the provider CONTRADICTS the declaration.
      const environmentMismatch = this.evaluateEnvironmentMismatch(connection, result);
      const failureError = environmentMismatch.mismatch
        ? `Environment mismatch: the provider reports a ${environmentMismatch.observed} account, ` +
          `but this connection was declared ${connection.accountType} — refusing to ` +
          'authorize a mislabeled environment (fail-closed).'
        : (result.error ?? 'Connection rejected by broker');

      if (!result.success || environmentMismatch.mismatch) {
        // A4: terminal ERROR write guarded on the in-flight state. On a
        // concurrent state change the original broker failure remains the
        // primary outcome (logged), and the winner's authoritative state is
        // NOT overwritten.
        try {
          await this.applyGuardedAuthorizationUpdate(
            connectionId,
            inFlightAuthorization,
            {
              status: BrokerConnectionStatus.ERROR,
              lastErrorMessage: failureError,
              consecutiveFailureCount: () => 'consecutive_failure_count + 1',
              ...(BrokerAuthorizationStateMachine.canTransition(
                inFlightAuthorization,
                BrokerAuthorizationStatus.ERROR,
              )
                ? { authorizationStatus: BrokerAuthorizationStatus.ERROR }
                : {}),
              // Auth-class failures mark the credential set INVALID (Directive §14)
              ...(BrokerCredentialLifecycle.isAuthFailure(result.error)
                ? { credentialStatus: BrokerCredentialStatus.INVALID }
                : {}),
            },
            'connectBroker ERROR transition',
          );
          // Round 6 live-execution completion (§1b): an auth-class failure
          // INVALIDATED the credential set — the user's NEW-exposure authority
          // built on the old credential generation is gone. Durable fact first,
          // then invalidation (logged-never-silent, best effort).
          if (BrokerCredentialLifecycle.isAuthFailure(result.error)) {
            await this.invalidateBrokerAuthority(
              userId,
              'BROKER_CREDENTIAL_INVALIDATED',
              `connect auth-class failure for connection ${connectionId}`,
            );
          }
        } catch (transitionErr) {
          this.logger.warn(
            `connectBroker ERROR transition lost a concurrent state race for ` +
              `${connectionId}: ${(transitionErr as Error).message}`,
          );
        }

        await this.auditService.log({
          actorUserId: userId,
          action: AuditAction.BROKER_CONNECT_FAILED,
          resourceType: 'BrokerConnection',
          resourceId: connectionId,
          ipAddress,
          metadata: {
            brokerId: connection.brokerId,
            error: failureError,
            // Round 7 (P0): typed machine code — the provider CONTRADICTED the
            // declared environment (e.g. a LIVE MetaApi account labeled DEMO).
            ...(environmentMismatch.mismatch
              ? {
                  failureCode: 'ACCOUNT_TYPE_MISMATCH',
                  declaredAccountType: connection.accountType,
                  providerObservedAccountType: result.accountType,
                }
              : {}),
          },
          // A mislabeled REAL-MONEY environment is a security event.
          severity: environmentMismatch.mismatch ? AuditSeverity.CRITICAL : AuditSeverity.WARNING,
        });

        throw new BadRequestException(`Broker connection failed: ${failureError}`);
      }

      // Upsert BrokerAccount with latest synced state
      // Round 6 (#7): an UNKNOWN account currency (null from the widened
      // adapter contract) must never be fabricated — it maps to undefined
      // (absent) at this seam and every risk-authoritative consumer fails
      // closed on missing currency identity.
      await this.upsertBrokerAccount(connectionId, result.currency ?? undefined);

      // Successful handshake verifies the credential set (Directive §14)
      // and advances the authorization state machine (Directive §15):
      //   DEMO account  → AUTHORIZED (demo validation — fixes the previously
      //                   unreachable demoValidated gate; dual-written below)
      //   LIVE account → CONNECTED (explicit enable-live-trading still required)
      const postConnectAuthorization =
        connection.accountType === BrokerMode.DEMO
          ? BrokerAuthorizationStatus.AUTHORIZED
          : BrokerAuthorizationStatus.CONNECTED;

      // Round 6 live-execution completion (§1b): PROVIDER ACCOUNT IDENTITY
      // DRIFT — the handshake reached a DIFFERENT provider account than the
      // one this connection was established with. Prior authority was bound
      // to the old logical account key; it is invalid for the new identity.
      const identityDrift =
        connection.accountId !== null &&
        connection.accountId !== undefined &&
        connection.accountId !== result.accountId;

      // A4: success transition guarded on the in-flight state — a concurrent
      // revoke/suspend between handshake and this write surfaces as a
      // Conflict; the winner's state is never overwritten by a stale success.
      await this.applyGuardedAuthorizationUpdate(
        connectionId,
        inFlightAuthorization,
        {
          status: BrokerConnectionStatus.CONNECTED,
          accountId: result.accountId,
          accountCurrency: result.currency,
          lastHealthCheckAt: new Date(),
          consecutiveFailureCount: 0,
          lastErrorMessage: null,
          credentialStatus: BrokerCredentialStatus.VERIFIED,
          // §1b: a drifted account identity re-keys the logical account in
          // the SAME atomic transition — the daily-risk-period scoping and
          // snapshot authority follow the ACTUAL account, never a stale key.
          ...(identityDrift
            ? {
                logicalAccountKey:
                  computeLogicalAccountKey(
                    connection.brokerId,
                    connection.providerBrokerIdentity,
                    result.accountId,
                  ) ?? connection.logicalAccountKey,
              }
            : {}),
          ...(BrokerAuthorizationStateMachine.canTransition(
            inFlightAuthorization,
            postConnectAuthorization,
          )
            ? { authorizationStatus: postConnectAuthorization }
            : {}),
          // Dual-write legacy booleans (backward compatibility)
          ...(connection.accountType === BrokerMode.DEMO ? { demoValidated: true } : {}),
        },
        'connectBroker CONNECTED transition',
      );

      if (identityDrift) {
        // Durable fact landed — NOW invalidate authority bound to the OLD
        // provider identity (logged-never-silent, best effort after the
        // durable transition — the same ordering discipline as disconnect).
        await this.invalidateBrokerAuthority(
          userId,
          'BROKER_PROVIDER_IDENTITY_CHANGED',
          `provider account identity changed on connection ${connectionId} ` +
            `(${connection.accountId} -> ${result.accountId})`,
        );
      }

      await this.auditService.log({
        actorUserId: userId,
        action: AuditAction.BROKER_CONNECTED,
        resourceType: 'BrokerConnection',
        resourceId: connectionId,
        ipAddress,
        metadata: {
          brokerId: connection.brokerId,
          accountId: result.accountId,
          accountType: result.accountType,
          currency: result.currency,
        },
      });

      // Round 6 live-execution completion (§1a): accept the FIRST full
      // provider account observation as the initial authoritative snapshot
      // (monotonic generation 1) so a freshly connected LIVE account carries
      // provable financial state immediately. A snapshot failure NEVER fails
      // the (already successful) connect — it is logged and the next health
      // check / reconciliation run records the observation.
      try {
        const accountInfo = await adapter.getAccountInfo();
        await this.recordAccountSnapshot(connection, {
          balance: accountInfo.balance,
          equity: accountInfo.equity,
          margin: accountInfo.margin,
          freeMargin: accountInfo.freeMargin,
          marginLevel: accountInfo.marginLevel,
          leverage: accountInfo.leverage,
          currency: accountInfo.currency,
          providerObservedAt: result.serverTime ?? null,
          source: 'connect',
        });
      } catch (snapshotErr) {
        this.logger.warn(
          `Initial account snapshot after connect failed for connection ` +
            `${connectionId}: ${(snapshotErr as Error).message} — the next health ` +
            'check or reconciliation run records the observation',
        );
      }

      this.logger.log(
        `Broker connected: id=${connectionId} account=${result.accountId} user=${userId}`,
      );
    } finally {
      // Explicitly zero out reference — decrypted credentials go out of scope here
      Object.keys(credentials).forEach((k) => {
        (credentials as unknown as Record<string, unknown>)[k] = null;
      });
      // The refreshed copy (audit point 1) is a distinct object — zeroed too.
      if (connectCredentials !== credentials) {
        Object.keys(connectCredentials).forEach((k) => {
          (connectCredentials as unknown as Record<string, unknown>)[k] = null;
        });
      }
    }

    return this.findConnectionById(connectionId, userId);
  }

  /**
   * Disconnect a broker connection. Suspends trading if active.
   */
  async disconnectBroker(connectionId: string, userId: string, ipAddress?: string): Promise<void> {
    const connection = await this.findConnectionById(connectionId, userId);

    // #291 race finding (a) / correction round 3: the guarded persisted-state
    // transition MUST win BEFORE any irreversible provider teardown. If a
    // concurrent enable-live/revoke/connect changed the authoritative state,
    // this write loses the race (ConflictException) and the provider session
    // is left INTACT — a lost race must never strand a CONNECTED persisted
    // state on top of a torn-down provider session. Provider teardown after a
    // WON transition is best-effort: a failed teardown leaves a provider
    // session alive under a DISCONNECTED persisted state, which reconnect
    // resolves safely.
    await this.applyGuardedAuthorizationUpdate(
      connectionId,
      connection.authorizationStatus,
      {
        status: BrokerConnectionStatus.DISCONNECTED,
        ...(this.canTransitionTo(connection, BrokerAuthorizationStatus.DISCONNECTED)
          ? { authorizationStatus: BrokerAuthorizationStatus.DISCONNECTED }
          : {}),
      },
      'disconnectBroker transition',
    );

    // Round 6 (#2/#300): a disconnected connection carries no NEW-exposure
    // authority — the generation bump + user-scoped grant/confirmation
    // invalidation land with the persisted transition (fail-safe best effort
    // AFTER the durable fact: a failure is logged and audited, never silent).
    try {
      await this.tradingAuthorityService.bumpGeneration(userId, 'BROKER_CONNECTION_DISCONNECTED');
      await this.grantInvalidation.invalidateUserNewExposureAuthority(
        userId,
        'BROKER_CONNECTION_DISCONNECTED',
      );
    } catch (err) {
      this.logger.error(
        `Authority invalidation after disconnect failed for user ${userId} ` +
          `(connection ${connectionId}): ${(err as Error).message}`,
      );
    }

    if (connection.status === BrokerConnectionStatus.CONNECTED) {
      try {
        const adapter = this.adapterRegistry.getAdapterForConnection(
          connection.id,
          connection.brokerId,
        );
        await adapter.disconnect();
      } catch (err) {
        this.logger.warn(
          `Adapter disconnect error for connection ${connectionId}: ${(err as Error).message}`,
        );
      }
    }

    // The mutable adapter context must not survive an explicit disconnect,
    // even when best-effort provider teardown failed (#291).
    this.adapterRegistry.releaseAdapterForConnection(connectionId);

    await this.auditService.log({
      actorUserId: userId,
      action: AuditAction.BROKER_DISCONNECTED,
      resourceType: 'BrokerConnection',
      resourceId: connectionId,
      ipAddress,
      metadata: { brokerId: connection.brokerId },
    });
  }

  /**
   * Soft-delete a broker connection.
   * Disconnects first if connected.
   */
  async deleteConnection(connectionId: string, userId: string, ipAddress?: string): Promise<void> {
    const connection = await this.findConnectionById(connectionId, userId);

    if (connection.status === BrokerConnectionStatus.CONNECTED) {
      await this.disconnectBroker(connectionId, userId, ipAddress);
    }

    await this.connectionRepo.softDelete(connectionId);
    // Mutable adapter context does not survive a soft-deleted connection (#291).
    this.adapterRegistry.releaseAdapterForConnection(connectionId);

    await this.auditService.log({
      actorUserId: userId,
      action: AuditAction.BROKER_CONNECTION_DELETED,
      resourceType: 'BrokerConnection',
      resourceId: connectionId,
      ipAddress,
      metadata: { brokerId: connection.brokerId },
    });
  }

  // ─── Live trading / authorization gate ──────────────────────────────────

  /**
   * Enable LIVE trading for a connection — explicit authorization
   * (Directive §15: AUTHORIZED/READY → ACTIVE).
   * ONLY possible after:
   *   1. DEMO connection exists and demoValidated = true (existing invariant)
   *   2. The connection is currently CONNECTED
   *   3. The provider explicitly supports LIVE (registry gate, Directive §11)
   *   4. The provider is production-LIVE VERIFIED (Phase H fail-closed gate —
   *      BETA/UNVERIFIED providers are DEMO-only)
   *   5. The user explicitly enables it
   *
   * Live trading without prior DEMO validation is an architectural violation.
   */
  /**
   * Identity-scoped LIVE verification evidence for the cTrader family
   * (correction round 4, finding 10): derived from the operator catalog —
   * each branded alias contributes evidence scoped to its identity family;
   * the generic entry contributes TECHNOLOGY-LEVEL evidence that can never
   * blanket-authorize a connection. All entries are UNVERIFIED today.
   */
  private ctraderFamilyLiveEvidence(): ProviderLiveVerificationEvidence[] {
    const evidence: ProviderLiveVerificationEvidence[] = [];
    for (const id of CTRADER_FAMILY_BROKER_IDS) {
      const entry = this.providerRegistry.getEntry(id);
      if (!entry) continue;
      // The cTrader family shares the 'ctrader' technology: evidence from
      // every family entry is evaluated for that technology.
      for (const unit of catalogEntryToEvidence(entry, ['LIVE'])) {
        evidence.push({
          ...unit,
          providerTechnology: PROVIDER_TECHNOLOGY.CTRADER,
        });
      }
    }
    return evidence;
  }

  async enableLiveTrading(connectionId: string, userId: string, ipAddress?: string): Promise<void> {
    const connection = await this.findConnectionById(connectionId, userId);

    if (connection.accountType !== BrokerMode.LIVE) {
      throw new BadRequestException('Only LIVE account connections can have live trading enabled');
    }

    // Registry gate: provider must explicitly support LIVE execution
    if (!this.providerRegistry.supportsEnvironment(connection.brokerId, BrokerMode.LIVE)) {
      throw new ForbiddenException(`Broker ${connection.brokerId} does not support LIVE execution`);
    }

    // Phase H (architect): production-LIVE eligibility fails closed —
    // BETA/UNVERIFIED providers can never enable LIVE trading, even with
    // a validated DEMO connection and a LIVE account row. Legacy attestation
    // (LEGACY_VERIFIED) is equally LIVE-ineligible: only a current CERTIFIED
    // state authorizes production LIVE.
    if (!this.providerRegistry.isProductionLiveEligible(connection.brokerId)) {
      const certificationState =
        this.providerRegistry.getEntry(connection.brokerId)?.certificationState ?? 'NOT_CERTIFIED';
      throw new ForbiddenException(
        certificationState === 'LEGACY_VERIFIED'
          ? `Broker ${connection.brokerId} carries only legacy production evidence ` +
              `(LEGACY_VERIFIED) — a current certification run (CERTIFIED) is required ` +
              'before LIVE trading can be enabled. LIVE is fail-closed.'
          : `Broker ${connection.brokerId} is not production-LIVE certified — ` +
              'LIVE trading is fail-closed (BETA is DEMO-only)',
      );
    }

    // State machine gate: must be in a pre-authorization state
    if (!this.canTransitionTo(connection, BrokerAuthorizationStatus.ACTIVE)) {
      throw new ConflictException(
        `Connection authorization state ${connection.authorizationStatus} cannot become ACTIVE — ` +
          'the broker link must be CONNECTED and authorization granted first',
      );
    }

    // Find corresponding DEMO connection to verify demo was validated
    const demoConnection = await this.connectionRepo.findOne({
      where: {
        userId,
        brokerId: connection.brokerId,
        accountType: BrokerMode.DEMO,
        demoValidated: true,
      },
    });

    if (!demoConnection) {
      throw new ForbiddenException(
        'DEMO mode must be validated before LIVE trading can be enabled. ' +
          'Connect and validate a DEMO account for this broker first.',
      );
    }

    // A4: guarded on the loaded authorization state — a concurrent
    // revoke/suspend between validation and this write surfaces as a
    // Conflict; ACTIVE is never set over a concurrently-revoked connection.
    await this.applyGuardedAuthorizationUpdate(
      connectionId,
      connection.authorizationStatus,
      {
        liveTradingEnabled: true,
        authorizationStatus: BrokerAuthorizationStatus.ACTIVE,
        authorizedAt: new Date(),
        authorizationRevokedAt: null,
      },
      'enableLiveTrading ACTIVE transition',
    );

    this.eventBus.publish(DomainEventType.BROKER_AUTHORIZATION_CHANGED, userId, {
      userId,
      connectionId,
      brokerId: connection.brokerId,
      previousStatus: connection.authorizationStatus,
      status: BrokerAuthorizationStatus.ACTIVE,
    });

    await this.auditService.log({
      actorUserId: userId,
      action: AuditAction.BROKER_LIVE_TRADING_ENABLED,
      resourceType: 'BrokerConnection',
      resourceId: connectionId,
      ipAddress,
      metadata: {
        brokerId: connection.brokerId,
        authorizationStatus: BrokerAuthorizationStatus.ACTIVE,
      },
      severity: AuditSeverity.WARNING,
    });
  }

  /**
   * Revoke automation authorization for a connection (Directive §15).
   * State → REVOKED; liveTradingEnabled dual-written false (fail-closed for
   * legacy consumers). Re-authorization requires the full path again.
   */
  async revokeAuthorization(
    connectionId: string,
    userId: string,
    ipAddress?: string,
  ): Promise<void> {
    const connection = await this.findConnectionById(connectionId, userId);

    if (!this.canTransitionTo(connection, BrokerAuthorizationStatus.REVOKED)) {
      throw new ConflictException(
        `Connection authorization state ${connection.authorizationStatus} cannot be revoked`,
      );
    }

    // A4: guarded on the loaded authorization state — a concurrent
    // suspend/enable-live between validation and this write surfaces as a
    // Conflict; REVOKED is never overwritten by a stale revocation write.
    await this.applyGuardedAuthorizationUpdate(
      connectionId,
      connection.authorizationStatus,
      {
        authorizationStatus: BrokerAuthorizationStatus.REVOKED,
        authorizationRevokedAt: new Date(),
        // Fail-closed for legacy consumers
        liveTradingEnabled: false,
      },
      'revokeAuthorization REVOKED transition',
    );

    // Round 6 live-execution completion (§1b): a revoked automation
    // authorization carries no NEW-exposure authority — the generation bump
    // + user-scoped grant/confirmation invalidation land with the durable
    // transition (same discipline as disconnect).
    await this.invalidateBrokerAuthority(
      userId,
      'BROKER_AUTHORIZATION_REVOKED',
      `authorization revoked for connection ${connectionId}`,
    );

    this.eventBus.publish(DomainEventType.BROKER_AUTHORIZATION_CHANGED, userId, {
      userId,
      connectionId,
      brokerId: connection.brokerId,
      previousStatus: connection.authorizationStatus,
      status: BrokerAuthorizationStatus.REVOKED,
    });

    await this.auditService.log({
      actorUserId: userId,
      action: AuditAction.BROKER_AUTHORIZATION_REVOKED,
      resourceType: 'BrokerConnection',
      resourceId: connectionId,
      ipAddress,
      metadata: {
        brokerId: connection.brokerId,
        previousStatus: connection.authorizationStatus,
      },
      severity: AuditSeverity.WARNING,
    });
  }

  /**
   * Rotate stored credentials for a connection (Directive §14).
   * The new credential set is validated against the provider BEFORE the
   * stored ciphertext is replaced. On validation failure the old set is kept.
   * New credentials are NEVER returned; audit records contain no secrets.
   */
  async rotateCredentials(
    connectionId: string,
    dto: ConnectBrokerDto,
    userId: string,
    ipAddress?: string,
  ): Promise<void> {
    const connection = await this.findConnectionById(connectionId, userId);

    if (dto.brokerId !== connection.brokerId) {
      throw new BadRequestException(
        `Credential rotation must use the same broker (${connection.brokerId})`,
      );
    }
    if ((dto.accountType as BrokerMode) !== connection.accountType) {
      throw new BadRequestException('Credential rotation must use the same account type');
    }

    // #291 / correction round 3 (finding 5 reconciliation): the NEW
    // credential set is validated on an EPHEMERAL adapter context — the
    // validation session disposes itself in a finally path and can never
    // invalidate provider sessions owned by this (or any other) persisted
    // connection. The connection's own adapter context (established with the
    // OLD credentials) is released ONLY after the rotation actually persists.
    const validationAdapter = this.adapterRegistry.createEphemeralAdapter(connection.brokerId);
    validationAdapter.setMode(connection.accountType);

    const newCredentials: DecryptedBrokerCredentials = {
      apiKey: dto.apiKey,
      apiSecret: dto.apiSecret,
      accountId: dto.accountId,
      serverUrl: dto.serverUrl,
      additionalParams: dto.additionalParams,
    };

    let testOk = false;
    let testError: string | undefined;
    let testResult: BrokerConnectionTestResult | null = null;
    try {
      testResult = await validationAdapter.testConnection(newCredentials);
      testOk = testResult.success;
      testError = testResult.errorMessage;
    } catch (err) {
      testError = err instanceof BrokerAdapterError ? err.message : 'Rotation test failed';
    }

    if (!testOk) {
      await this.auditService.log({
        actorUserId: userId,
        action: AuditAction.BROKER_CREDENTIAL_ROTATION_FAILED,
        resourceType: 'BrokerConnection',
        resourceId: connectionId,
        ipAddress,
        metadata: { brokerId: connection.brokerId, error: testError },
        severity: AuditSeverity.WARNING,
      });
      throw new BadRequestException(`Credential validation failed: ${testError}`);
    }

    // Round 7.1 (P0-1 — credential-rotation environment enforcement): the
    // user-supplied DTO already had to repeat the declared account type, but
    // the PROVIDER's own classification of the new credential set is the
    // truth that matters — a LIVE account's credentials rotated onto a
    // DEMO-declared connection (or vice versa) would re-bind the connection
    // to a mislabeled environment that only the NEXT health check catches.
    // The provider-observed type is optional on BrokerConnectionTestResult
    // (some adapters cannot classify during a dry test); an ABSENT
    // observation is vacuously consistent, a CONTRADICTORY one is refused
    // BEFORE any ciphertext is replaced (previous credentials kept).
    const rotationEnv = testResult
      ? this.evaluateEnvironmentMismatch(connection, testResult, {
          accountTypeOptional: true,
        })
      : { mismatch: false, observed: null };
    if (rotationEnv.mismatch) {
      await this.auditService.log({
        actorUserId: userId,
        action: AuditAction.BROKER_CREDENTIAL_ROTATION_FAILED,
        resourceType: 'BrokerConnection',
        resourceId: connectionId,
        ipAddress,
        metadata: {
          brokerId: connection.brokerId,
          failureCode: 'ACCOUNT_TYPE_MISMATCH',
          declaredAccountType: connection.accountType,
          providerObservedAccountType: rotationEnv.observed,
        },
        severity: AuditSeverity.CRITICAL,
      });
      throw new BadRequestException(
        `Environment mismatch: the new credentials resolve to a ${rotationEnv.observed} ` +
          `account, but this connection was declared ${connection.accountType} — ` +
          'rotation refused (fail-closed; previous credentials kept).',
      );
    }

    // Validated — replace ciphertext (old plaintext never leaves memory)
    const encrypted = this.encryptionService.encrypt(newCredentials);
    Object.keys(newCredentials).forEach((k) => {
      (newCredentials as unknown as Record<string, unknown>)[k] = null;
    });

    await this.connectionRepo.update(connectionId, {
      encryptedCredentials: encrypted.ciphertext,
      credentialIv: encrypted.iv,
      credentialTag: encrypted.tag,
      encryptionKeyId: encrypted.keyId,
      accountId: dto.accountId,
      credentialStatus: BrokerCredentialStatus.ROTATED,
    });

    // Round 6 live-execution completion (§1b): the credential GENERATION
    // changed (manual rotation) — prior NEW-exposure authority bound to the
    // old credential set is invalid; in-flight grants/confirmations are
    // invalidated (the final dispatch boundary also fences on the generation).
    await this.invalidateBrokerAuthority(
      userId,
      'BROKER_CREDENTIAL_ROTATED',
      `credentials manually rotated for connection ${connectionId}`,
    );

    await this.auditService.log({
      actorUserId: userId,
      action: AuditAction.BROKER_CREDENTIALS_ROTATED,
      resourceType: 'BrokerConnection',
      resourceId: connectionId,
      ipAddress,
      metadata: { brokerId: connection.brokerId, accountId: dto.accountId },
      severity: AuditSeverity.WARNING,
    });
  }

  /**
   * FAIL-CLOSED execution authorization gate for a specific connection.
   * Used by execution-side consumers: only authorizationStatus === ACTIVE
   * may execute. Unknown/null never executes (Directive §16/§48).
   */
  isConnectionExecutable(connection: BrokerConnection): boolean {
    return BrokerAuthorizationStateMachine.isExecutable(connection.authorizationStatus);
  }

  // ─── Health check ─────────────────────────────────────────────────────────

  /**
   * Return IDs of all broker connections currently in CONNECTED status.
   * Used by the BrokerHealthCheckJob to determine which connections to check.
   */
  async getAllConnectedConnectionIds(): Promise<string[]> {
    const connections = await this.connectionRepo.find({
      where: { status: BrokerConnectionStatus.CONNECTED },
      select: ['id'],
    });
    return connections.map((c) => c.id);
  }

  /**
   * Perform a health check on a single connection.
   *
   * Process:
   * 1. Decrypt stored credentials
   * 2. Call adapter.connect() — reuses the MetaAPI connection pool if available
   * 3. Call adapter.getAccountBalance() — verifies the connection is live
   * 4. Update BrokerAccount with latest balance snapshot
   * 5. On failure: increment counter, suspend after 3 consecutive failures
   *
   * Called by BrokerHealthCheckJob (every 60s) and on-demand from admin panel.
   */
  async healthCheck(connectionId: string): Promise<boolean> {
    const connection = await this.connectionRepo.findOne({ where: { id: connectionId } });
    if (!connection || connection.status !== BrokerConnectionStatus.CONNECTED) return false;

    // #291 / correction round 3: the health check operates on the SAME
    // connection-scoped adapter context as connectBroker/dispatch — its
    // reconnect is idempotent for this connection and invisible to others.
    const adapter = this.adapterRegistry.getAdapterForConnection(
      connection.id,
      connection.brokerId,
    );

    if (!connection.encryptedCredentials || !connection.credentialIv || !connection.credentialTag) {
      this.logger.warn(`Connection ${connectionId} has no credentials — cannot health check`);
      return false;
    }

    // A3: unusable credential states fail closed WITHOUT contacting the
    // provider (recorded as a failed check, never a provider call).
    if (!BrokerCredentialLifecycle.isUsable(connection.credentialStatus)) {
      this.logger.warn(
        `Connection ${connectionId} credential status is ` +
          `${connection.credentialStatus ?? 'MISSING'} — skipping provider health check (fail-closed)`,
      );
      return false;
    }

    // Decrypt in-memory only — NEVER logged
    const credentials = this.encryptionService.decrypt({
      ciphertext: connection.encryptedCredentials,
      iv: connection.credentialIv,
      tag: connection.credentialTag,
      keyId: connection.encryptionKeyId ?? 'env-key-v1',
    });

    adapter.setMode(connection.accountType);

    try {
      // Sprint 56 correction round 1 (audit point 1): the same freshness
      // gate as connectBroker — periodic health checks keep OAuth
      // credentials current (refresh + atomic persist before provider use).
      const healthCredentials = await this.tokenLifecycle.ensureFreshTokens(
        connection,
        credentials,
      );
      // connect() reuses the MetaAPI connection pool — only reconnects if stale
      const connectResult = await adapter.connect(healthCredentials);

      // Round 7 (P0 — declared-vs-observed environment enforcement, the same
      // rule as connectBroker): a post-connect provider-side environment
      // change (broker migration, account relabel) must NEVER silently keep a
      // mislabeled connection CONNECTED/executable. Immediate CRITICAL
      // suspension on the FIRST observation — never the 3-failure threshold
      // (a mislabeled REAL-MONEY environment is a security event, not a
      // transient health blip).
      if (
        connectResult.success &&
        this.evaluateEnvironmentMismatch(connection, connectResult).mismatch
      ) {
        // P13 metrics: declared-vs-observed environment mismatch detected at
        // the health-check fence (brokerId + detection source labels only).
        this.metrics?.increment(METRIC_NAMES.BROKER_ENVIRONMENT_MISMATCHES, {
          brokerId: connection.brokerId,
          source: 'health-check',
        });
        let mismatchSuspended = false;
        try {
          await this.applyGuardedAuthorizationUpdate(
            connectionId,
            connection.authorizationStatus,
            {
              status: BrokerConnectionStatus.SUSPENDED,
              lastErrorMessage:
                `Environment mismatch: the provider reports a ${connectResult.accountType} ` +
                `account, but this connection was declared ${connection.accountType} ` +
                '(fail-closed).',
              ...(this.canTransitionTo(connection, BrokerAuthorizationStatus.SUSPENDED)
                ? { authorizationStatus: BrokerAuthorizationStatus.SUSPENDED }
                : {}),
            },
            'healthCheck ENVIRONMENT_MISMATCH suspension',
          );
          mismatchSuspended = true;
        } catch (transitionErr) {
          this.logger.warn(
            `healthCheck environment-mismatch suspension lost a concurrent state race for ` +
              `${connectionId}: ${(transitionErr as Error).message}`,
          );
        }
        if (mismatchSuspended) {
          this.adapterRegistry.releaseAdapterForConnection(connectionId);
          await this.invalidateBrokerAuthority(
            connection.userId,
            'BROKER_CONNECTION_SUSPENDED',
            `environment mismatch on connection ${connectionId} (declared ` +
              `${connection.accountType}, provider reports ${connectResult.accountType})`,
          );
          await this.auditService.log({
            action: AuditAction.BROKER_SUSPENDED_HEALTH_FAILURE,
            resourceType: 'BrokerConnection',
            resourceId: connectionId,
            metadata: {
              brokerId: connection.brokerId,
              userId: connection.userId,
              failureCode: 'ACCOUNT_TYPE_MISMATCH',
              declaredAccountType: connection.accountType,
              providerObservedAccountType: connectResult.accountType,
            },
            severity: AuditSeverity.CRITICAL,
          });
          this.eventBus.publish(DomainEventType.BROKER_STATUS_CHANGED, connection.userId, {
            userId: connection.userId,
            connectionId,
            status: BrokerConnectionStatus.SUSPENDED,
            previousStatus: BrokerConnectionStatus.CONNECTED,
            reason: 'Suspended: provider-reported environment contradicts the declared one',
          });
        }
        return false;
      }

      const balance = await adapter.getAccountBalance();

      await this.connectionRepo.update(connectionId, {
        lastHealthCheckAt: new Date(),
        consecutiveFailureCount: 0,
        lastErrorMessage: null,
      });

      await this.upsertBrokerAccount(connectionId, balance.currency, {
        balance: balance.balance,
        equity: balance.equity,
      });

      // Round 6 live-execution completion (§1a): the health check observes
      // REAL provider financial state — accept it as the next authoritative
      // snapshot (monotonic generation). providerObservedAt = the provider's
      // own balance timestamp, so freshness is NEVER derived from write time.
      await this.recordAccountSnapshot(connection, {
        balance: balance.balance,
        equity: balance.equity,
        currency: balance.currency,
        providerObservedAt: balance.timestamp ?? null,
        source: 'health-check',
      });

      return true;
    } catch (err) {
      const failureCount = (connection.consecutiveFailureCount ?? 0) + 1;
      const SUSPEND_THRESHOLD = 3;

      // Telemetry first (unguarded — not a state transition; WHERE id only).
      await this.connectionRepo.update(connectionId, {
        consecutiveFailureCount: failureCount,
        lastErrorMessage: (err as Error).message,
        lastHealthCheckAt: new Date(),
      });

      if (failureCount >= SUSPEND_THRESHOLD) {
        // A4 + #291 race finding (b): the SUSPENDED transition is a guarded
        // conditional write on the loaded authorization state. A concurrent
        // revoke/enable-live that changed the state makes this stale
        // suspension LOSE the race — and a LOST suspension must have NO
        // observable side effects: the adapter context is NOT released and
        // no SUSPENDED audit/event is emitted (the authoritative winner owns
        // the state). The unconditional unguarded status write that used to
        // sit in the else branch is gone: every suspension path is guarded,
        // even when the authorization status itself is not transitioning.
        let suspensionTransitioned = false;
        try {
          await this.applyGuardedAuthorizationUpdate(
            connectionId,
            connection.authorizationStatus,
            {
              status: BrokerConnectionStatus.SUSPENDED,
              // Fail-closed: suspended connections lose execution authorization
              ...(this.canTransitionTo(connection, BrokerAuthorizationStatus.SUSPENDED)
                ? { authorizationStatus: BrokerAuthorizationStatus.SUSPENDED }
                : {}),
            },
            'healthCheck SUSPENDED transition',
          );
          suspensionTransitioned = true;
        } catch (transitionErr) {
          this.logger.warn(
            `healthCheck suspend lost a concurrent state race for ${connectionId}: ` +
              `${(transitionErr as Error).message} — leaving the authoritative state untouched, ` +
              'adapter context retained, no SUSPENDED audit/event emitted',
          );
        }

        if (suspensionTransitioned) {
          // The guarded transition actually succeeded — ONLY NOW may the
          // mutable adapter context be released and the suspension observed
          // (audit + realtime event) by the rest of the system.
          this.adapterRegistry.releaseAdapterForConnection(connectionId);
          this.logger.error(
            `Broker connection ${connectionId} suspended after ${failureCount} consecutive failures`,
          );
          // Round 6 live-execution completion (§1b): a suspended connection
          // carries no NEW-exposure authority.
          await this.invalidateBrokerAuthority(
            connection.userId,
            'BROKER_CONNECTION_SUSPENDED',
            `connection ${connectionId} suspended after ${failureCount} consecutive health failures`,
          );
          await this.auditService.log({
            action: AuditAction.BROKER_SUSPENDED_HEALTH_FAILURE,
            resourceType: 'BrokerConnection',
            resourceId: connectionId,
            metadata: {
              brokerId: connection.brokerId,
              userId: connection.userId,
              failureCount,
            },
            severity: AuditSeverity.CRITICAL,
          });
          this.eventBus.publish(DomainEventType.BROKER_STATUS_CHANGED, connection.userId, {
            userId: connection.userId,
            connectionId,
            status: BrokerConnectionStatus.SUSPENDED,
            previousStatus: BrokerConnectionStatus.CONNECTED,
            reason: `Suspended after ${failureCount} consecutive health check failures`,
          });
        }
      }

      return false;
    }
  }

  /**
   * Fetch OHLCV candles via the user's connected broker adapter.
   *
   * SECURITY:
   * - Verifies connection belongs to userId
   * - Requires CONNECTED status
   * - Credentials decrypted in-memory only — never logged or returned
   */
  async getOhlcvForConnection(
    userId: string,
    brokerConnectionId: string,
    instrument: string,
    timeframe: string,
    limit: number,
    before?: Date,
  ): Promise<OHLCV[]> {
    const connection = await this.findConnectionById(brokerConnectionId, userId);

    if (connection.status !== BrokerConnectionStatus.CONNECTED) {
      throw new ForbiddenException('Broker connection is not active');
    }

    const adapter = this.adapterRegistry.getAdapterForConnection(
      connection.id,
      connection.brokerId,
    );

    if (!connection.encryptedCredentials || !connection.credentialIv || !connection.credentialTag) {
      throw new ForbiddenException('Broker connection credentials unavailable');
    }

    // A3: lifecycle gate before decrypt — unusable credentials never reach the
    // provider adapter.
    this.assertCredentialsUsable(connection, 'getOhlcvForConnection');

    const credentials = this.encryptionService.decrypt({
      ciphertext: connection.encryptedCredentials,
      iv: connection.credentialIv,
      tag: connection.credentialTag,
      keyId: connection.encryptionKeyId ?? 'env-key-v1',
    });

    adapter.setMode(connection.accountType);

    try {
      await adapter.connect(credentials);
      return await adapter.getOHLCV(instrument, timeframe, limit, before);
    } catch (err) {
      this.logger.warn(
        `OHLCV fetch failed connection=${brokerConnectionId} instrument=${instrument}: ` +
          `${(err as Error).message}`,
      );
      throw err;
    }
  }

  /**
   * Fetch current broker positions for one owned connected account.
   * Credentials remain server-side; callers receive only normalized provider
   * position economics from the adapter contract.
   */
  async getOpenPositionsForConnection(
    connectionId: string,
    userId: string,
  ): Promise<{
    connection: BrokerConnection;
    positions: import('./interfaces/broker-adapter.interface').BrokerPosition[];
  }> {
    const connection = await this.findConnectionById(connectionId, userId);
    if (connection.status !== BrokerConnectionStatus.CONNECTED) {
      throw new ForbiddenException(
        `Broker connection ${connectionId} is not CONNECTED (status: ${connection.status})`,
      );
    }

    const adapter = this.adapterRegistry.getAdapterForConnection(
      connection.id,
      connection.brokerId,
    );
    if (!connection.encryptedCredentials || !connection.credentialIv || !connection.credentialTag) {
      throw new ForbiddenException('Broker connection credentials unavailable');
    }
    this.assertCredentialsUsable(connection, 'getOpenPositionsForConnection');

    const credentials = this.encryptionService.decrypt({
      ciphertext: connection.encryptedCredentials,
      iv: connection.credentialIv,
      tag: connection.credentialTag,
      keyId: connection.encryptionKeyId ?? 'env-key-v1',
    });
    adapter.setMode(connection.accountType);

    try {
      await adapter.connect(credentials);
      const positions = await adapter.getOpenPositions();
      return { connection, positions };
    } catch (err) {
      this.logger.warn(
        `getOpenPositions failed connection=${connectionId}: ${(err as Error).message}`,
      );
      throw err;
    } finally {
      Object.keys(credentials).forEach((key) => {
        (credentials as unknown as Record<string, unknown>)[key] = null;
      });
    }
  }

  /**
   * Fetch closed trades for a broker connection using stored credentials.
   *
   * SECURITY:
   * - Verifies connection belongs to userId.
   * - Credentials decrypted in-memory only; zeroed out after the call.
   * - Returns the raw BrokerClosedTrade array; caller is responsible for normalization.
   *
   * Note: Caller must enforce time-range validation (fromTime < toTime, max window).
   */
  async getClosedTradesForConnection(
    connectionId: string,
    userId: string,
    from: Date,
    to: Date,
  ): Promise<{
    connection: BrokerConnection;
    trades: import('./interfaces/broker-adapter.interface').BrokerClosedTrade[];
  }> {
    const connection = await this.findConnectionById(connectionId, userId);

    if (connection.status !== BrokerConnectionStatus.CONNECTED) {
      throw new ForbiddenException(
        `Broker connection ${connectionId} is not CONNECTED (status: ${connection.status})`,
      );
    }

    const adapter = this.adapterRegistry.getAdapterForConnection(
      connection.id,
      connection.brokerId,
    );

    if (!connection.encryptedCredentials || !connection.credentialIv || !connection.credentialTag) {
      throw new ForbiddenException('Broker connection credentials unavailable');
    }

    // A3: lifecycle gate before decrypt — unusable credentials never reach the
    // provider adapter.
    this.assertCredentialsUsable(connection, 'getClosedTradesForConnection');

    const credentials = this.encryptionService.decrypt({
      ciphertext: connection.encryptedCredentials,
      iv: connection.credentialIv,
      tag: connection.credentialTag,
      keyId: connection.encryptionKeyId ?? 'env-key-v1',
    });

    adapter.setMode(connection.accountType);

    try {
      await adapter.connect(credentials);
      const trades = await adapter.getClosedTrades(from, to);
      return { connection, trades };
    } catch (err) {
      this.logger.warn(
        `getClosedTrades failed connection=${connectionId} from=${from.toISOString()} to=${to.toISOString()}: ` +
          `${(err as Error).message}`,
      );
      throw err;
    } finally {
      Object.keys(credentials).forEach((k) => {
        (credentials as unknown as Record<string, unknown>)[k] = null;
      });
    }
  }

  /**
   * Check whether a user has an active, connected broker account.
   * Used as the broker connection gate before AI trading can start.
   */
  async hasActiveConnection(userId: string): Promise<boolean> {
    const connection = await this.findActiveConnectionForUser(userId);
    return connection !== null;
  }

  // ─── Internal helpers ─────────────────────────────────────────────────────

  /**
   * Unwrap the affected-row count from a TypeORM UPDATE result. Depending on
   * driver/version the repository.update() call resolves either to an
   * UpdateResult ({ affected }) or a raw [rows, rowCount] tuple.
   */
  private unwrapAffectedRows(result: unknown): number {
    if (Array.isArray(result)) {
      const rowCount = result[1];
      return typeof rowCount === 'number' ? rowCount : 0;
    }
    const affected = (result as { affected?: unknown })?.affected;
    return typeof affected === 'number' ? affected : 0;
  }

  /**
   * Atomic conditional transition write (architect correction A4).
   *
   * The UPDATE applies ONLY while the persisted authorization_status still
   * equals `expected` — the state the in-memory state-machine validation was
   * performed against (optimistic concurrency guard, same pattern as the
   * order domain's applyTransition). A concurrent writer that changed the
   * authoritative state in between makes the update match zero rows, which
   * surfaces as a ConflictException instead of silently overwriting the
   * winner. The DB CHECK constraints validate enum membership; THIS guard is
   * what makes the transition itself atomic against concurrent writers.
   */
  private async applyGuardedAuthorizationUpdate(
    connectionId: string,
    expected: BrokerAuthorizationStatus,
    patch: Record<string, unknown>,
    operation: string,
  ): Promise<void> {
    const result = (await this.connectionRepo.update(
      { id: connectionId, authorizationStatus: expected } as never,
      patch as never,
    )) as unknown;
    const affected = this.unwrapAffectedRows(result);
    if (affected === 0) {
      // Reload for an honest error message (best-effort).
      let current = 'UNKNOWN';
      try {
        const fresh = await this.connectionRepo.findOne({ where: { id: connectionId } });
        current = fresh?.authorizationStatus ?? 'DELETED';
      } catch {
        // Keep UNKNOWN — the conflict stands regardless.
      }
      throw new ConflictException(
        `${operation} failed: connection ${connectionId} authorization state changed ` +
          `concurrently (expected ${expected}, persisted ${current}) — refusing to ` +
          'overwrite the authoritative state',
      );
    }
  }

  /**
   * In-memory transition pre-check for fast, honest error messages. The
   * authoritative concurrency guarantee comes from
   * applyGuardedAuthorizationUpdate (conditional UPDATE with affected-rows
   * check), NOT from this check — the loaded row can be stale by the time the
   * UPDATE runs, and the DB CHECK constraints only validate enum membership.
   */
  private canTransitionTo(connection: BrokerConnection, to: BrokerAuthorizationStatus): boolean {
    return BrokerAuthorizationStateMachine.canTransition(connection.authorizationStatus, to);
  }

  /**
   * Get the authoritative financial state for a connection.
   * Used by RiskService for margin and equity checks.
   *
   * Round 6 live-execution completion (§1a): routed through the AUTHORITATIVE
   * accepted BrokerAccountSnapshot model — the latest accepted snapshot (by
   * monotonic generation, never by write time) is the truth; the legacy
   * broker.broker_accounts row is only a projection/compat fallback for
   * connections that have never produced a provider observation.
   *
   * FAIL-CLOSED SHAPE RULE: a partial financial state (missing balance,
   * equity, freeMargin or currency) returns null — the caller treats the
   * account state as UNAVAILABLE. Zero, USD, stale or cached values are
   * NEVER substituted when LIVE authority cannot be proven.
   */
  async getBrokerAccountState(
    connectionId: string,
  ): Promise<{ balance: string; equity: string; freeMargin: string; currency: string } | null> {
    const snapshot = await this.snapshotService.readLatestAcceptedSnapshot(connectionId);
    if (snapshot) {
      const { balance, equity, freeMargin, currency } = snapshot;
      if (
        balance === null ||
        balance === undefined ||
        equity === null ||
        equity === undefined ||
        freeMargin === null ||
        freeMargin === undefined ||
        !currency
      ) {
        // Partial snapshot state cannot authorize exposure — no fabrication.
        return null;
      }
      return { balance, equity, freeMargin, currency };
    }

    // No accepted snapshot exists (connection never observed by connect /
    // health-check / reconciliation) — legacy compat view. Unknown currency
    // stays unknown: null, never a synthetic 'USD'.
    const account = await this.accountRepo.findOne({
      where: { brokerConnectionId: connectionId },
    });
    if (!account || !account.currency) return null;
    return {
      balance: account.balance,
      equity: account.equity,
      freeMargin: account.freeMargin,
      currency: account.currency,
    };
  }

  /**
   * Return the broker adapter's canonical instrument list for one owned,
   * CONNECTED account. This is the capability source used by AI scheduler
   * registration so automation never scans symbols the bound broker cannot
   * actually serve.
   *
   * Security/lifecycle invariants match the other broker market-data seams:
   * ownership is verified, credentials remain server-side/in-memory only,
   * unusable credentials fail closed, and provider failures never invent
   * instruments.
   */
  async getSupportedInstrumentsForConnection(
    userId: string,
    brokerConnectionId: string,
  ): Promise<BrokerInstrument[]> {
    const connection = await this.findConnectionById(brokerConnectionId, userId);

    if (connection.status !== BrokerConnectionStatus.CONNECTED) {
      throw new ForbiddenException('Broker connection is not active');
    }

    if (!connection.encryptedCredentials || !connection.credentialIv || !connection.credentialTag) {
      throw new ForbiddenException('Broker connection credentials unavailable');
    }

    this.assertCredentialsUsable(connection, 'getSupportedInstrumentsForConnection');

    const adapter = this.adapterRegistry.getAdapterForConnection(
      connection.id,
      connection.brokerId,
    );
    const credentials = this.encryptionService.decrypt({
      ciphertext: connection.encryptedCredentials,
      iv: connection.credentialIv,
      tag: connection.credentialTag,
      keyId: connection.encryptionKeyId ?? 'env-key-v1',
    });

    adapter.setMode(connection.accountType);

    try {
      await adapter.connect(credentials);
      const instruments = await adapter.getInstrumentList();
      return Array.isArray(instruments) ? instruments : [];
    } catch (err) {
      this.logger.warn(
        `Instrument-list resolution failed connection=${brokerConnectionId}: ${(err as Error).message}`,
      );
      return [];
    } finally {
      Object.keys(credentials).forEach((k) => {
        (credentials as unknown as Record<string, unknown>)[k] = null;
      });
    }
  }

  /**
   * Round 6 live-execution completion (§1a/§4/§18): resolve the normalized
   * instrument specification (contract size, min/max volume, lot step,
   * digits) for a connection through the adapter's getInstrumentList().
   *
   * This is the missing BrokerService seam behind the risk engine's
   * CONTRACT_SIZE_UNAVAILABLE fail-closed rejection — the risk/sizing layers
   * must never reach into adapter internals or duplicate credential
   * handling. Results are cached in-process for a SHORT TTL (instrument
   * specifications change rarely; connection-scoped key so an account switch
   * on the same connection naturally re-resolves after the TTL).
   *
   * Returns null when the instrument is not tradable through the connection
   * (unknown symbol mapping) or the adapter cannot prove the specification —
   * the caller fails closed, NEVER invents a contract size.
   */
  async getInstrumentSpecForConnection(
    userId: string,
    brokerConnectionId: string,
    instrument: string,
  ): Promise<BrokerInstrument | null> {
    const cacheKey = `${brokerConnectionId}:${instrument}`;
    const cached = this.instrumentSpecCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.spec;
    }

    const connection = await this.findConnectionById(brokerConnectionId, userId);

    if (connection.status !== BrokerConnectionStatus.CONNECTED) {
      throw new ForbiddenException('Broker connection is not active');
    }

    if (!connection.encryptedCredentials || !connection.credentialIv || !connection.credentialTag) {
      throw new ForbiddenException('Broker connection credentials unavailable');
    }

    // A3: lifecycle gate before decrypt — unusable credentials never reach the
    // provider adapter.
    this.assertCredentialsUsable(connection, 'getInstrumentSpecForConnection');

    const adapter = this.adapterRegistry.getAdapterForConnection(
      connection.id,
      connection.brokerId,
    );
    const credentials = this.encryptionService.decrypt({
      ciphertext: connection.encryptedCredentials,
      iv: connection.credentialIv,
      tag: connection.credentialTag,
      keyId: connection.encryptionKeyId ?? 'env-key-v1',
    });

    adapter.setMode(connection.accountType);

    try {
      await adapter.connect(credentials);
      const instruments = await adapter.getInstrumentList();
      // Adapters report CANONICAL symbols (OANDA maps EUR_USD -> EURUSD);
      // exact match first, case-insensitive fallback for safety.
      const spec =
        instruments.find((i) => i.symbol === instrument) ??
        instruments.find((i) => i.symbol.toLowerCase() === instrument.toLowerCase());
      if (spec) {
        this.instrumentSpecCache.set(cacheKey, {
          spec,
          expiresAt: Date.now() + BrokerService.INSTRUMENT_SPEC_CACHE_TTL_MS,
        });
      }
      return spec ?? null;
    } catch (err) {
      this.logger.warn(
        `Instrument spec resolution failed connection=${brokerConnectionId} ` +
          `instrument=${instrument}: ${(err as Error).message}`,
      );
      return null;
    } finally {
      Object.keys(credentials).forEach((k) => {
        (credentials as unknown as Record<string, unknown>)[k] = null;
      });
    }
  }

  /**
   * Round 6 live-execution completion (§5/§18): the FRESH-QUOTE seam for the
   * final market-safety gate — one provider quote for the canonical
   * instrument through the caller's connection (tenant + CONNECTED +
   * credential-lifecycle gated, exactly like the instrument seam).
   *
   * Deliberately NOT cached: freshness is the entire point. Returns null when
   * the adapter cannot prove a current quote (unknown symbol mapping, market
   * data unavailable) — the caller fails closed, NEVER invents a price or a
   * market state (§18).
   */
  async getCurrentPriceForConnection(
    userId: string,
    brokerConnectionId: string,
    instrument: string,
  ): Promise<BrokerPrice | null> {
    const connection = await this.findConnectionById(brokerConnectionId, userId);

    if (connection.status !== BrokerConnectionStatus.CONNECTED) {
      throw new ForbiddenException('Broker connection is not active');
    }

    if (!connection.encryptedCredentials || !connection.credentialIv || !connection.credentialTag) {
      throw new ForbiddenException('Broker connection credentials unavailable');
    }

    this.assertCredentialsUsable(connection, 'getCurrentPriceForConnection');

    const adapter = this.adapterRegistry.getAdapterForConnection(
      connection.id,
      connection.brokerId,
    );
    const credentials = this.encryptionService.decrypt({
      ciphertext: connection.encryptedCredentials,
      iv: connection.credentialIv,
      tag: connection.credentialTag,
      keyId: connection.encryptionKeyId ?? 'env-key-v1',
    });

    adapter.setMode(connection.accountType);

    try {
      await adapter.connect(credentials);
      const price = await adapter.getCurrentPrice(instrument);
      if (
        !price ||
        !price.bid ||
        !price.ask ||
        !price.timestamp ||
        !Number.isFinite(new Date(price.timestamp).getTime())
      ) {
        return null; // §18 — unprovable is unprovable; never invented.
      }
      return price;
    } catch {
      // Quote failures are the gate's typed MARKET_DATA_UNAVAILABLE — a null
      // return keeps the seam honest without swallowing the reason.
      this.logger.warn(
        `Fresh quote unavailable for ${instrument} on connection ${brokerConnectionId} — ` +
          'the market-safety gate will fail closed',
      );
      return null;
    }
  }

  /**
   * Sprint 32 Gate 2: get required margin for a proposed order through the
   * broker adapter abstraction. Delegates to the adapter's
   * getRequiredMargin() which uses broker-specific margin rules.
   *
   * Returns null if the adapter cannot calculate the required margin
   * (instrument not found, price unavailable, adapter error, etc.).
   * The Risk Engine fails closed when this returns null for LIVE execution.
   */
  async getRequiredMargin(
    connectionId: string,
    params: { instrument: string; lotSize: string; direction: 'BUY' | 'SELL' },
  ): Promise<string | null> {
    const connection = await this.connectionRepo.findOne({
      where: { id: connectionId },
    });
    if (!connection) return null;

    // A3: this path was previously FULLY unguarded (no status, no lifecycle).
    // Fail closed for non-CONNECTED connections and unusable credentials —
    // the adapter is never contacted.
    if (connection.status !== BrokerConnectionStatus.CONNECTED) return null;
    if (!BrokerCredentialLifecycle.isUsable(connection.credentialStatus)) return null;

    const adapter = this.adapterRegistry.getAdapterForConnection(
      connection.id,
      connection.brokerId,
    );
    adapter.setMode(connection.accountType);

    let credentials: DecryptedBrokerCredentials | null = null;
    try {
      let connectionReference: string | undefined;
      if (connection.encryptedCredentials && connection.credentialIv && connection.credentialTag) {
        credentials = this.encryptionService.decrypt({
          ciphertext: connection.encryptedCredentials,
          iv: connection.credentialIv,
          tag: connection.credentialTag,
          keyId: connection.encryptionKeyId ?? 'env-key-v1',
        });
        connectionReference = credentials.accountId;
      }

      return await adapter.getRequiredMargin({
        ...params,
        connectionReference,
      });
    } catch {
      return null;
    } finally {
      if (credentials) {
        Object.keys(credentials).forEach((key) => {
          (credentials as unknown as Record<string, unknown>)[key] = null;
        });
      }
    }
  }

  private async upsertBrokerAccount(
    connectionId: string,
    currency?: string,
    updates?: { balance?: string; equity?: string },
  ): Promise<void> {
    const existing = await this.accountRepo.findOne({
      where: { brokerConnectionId: connectionId },
    });

    if (existing) {
      await this.accountRepo.update(existing.id, {
        currency: currency ?? existing.currency,
        balance: updates?.balance ?? existing.balance,
        equity: updates?.equity ?? existing.equity,
        syncedAt: new Date(),
      });
    } else {
      await this.accountRepo.save(
        this.accountRepo.create({
          brokerConnectionId: connectionId,
          currency: currency ?? null,
          balance: updates?.balance ?? '0',
          equity: updates?.equity ?? '0',
          syncedAt: new Date(),
        }),
      );
    }
  }

  /**
   * Sprint 50 PR-4 — full account-snapshot sync from provider-observed state.
   *
   * Called by the state reconciliation run AFTER comparing the previously
   * stored snapshot against the provider's account info (mismatch detection
   * happens on the PRE-sync stored values — the point is to observe drift,
   * then converge). Unlike upsertBrokerAccount (balance/equity only), this
   * refreshes margin, freeMargin, marginLevel, leverage, currency and the
   * open-positions count — fields the health check never populated.
   *
   * Idempotent upsert keyed on broker_connection_id (unique constraint).
   */
  async applyProviderAccountSnapshot(
    connectionId: string,
    account: BrokerAccountInfo,
    openPositionsCount: number,
  ): Promise<void> {
    // Round 6 live-execution completion (§1a): the reconciliation run's
    // provider account observation is accepted into the AUTHORITATIVE
    // snapshot model FIRST (monotonic generation); the legacy write below is
    // the compat projection. providerAccountIdentity is the observed
    // provider account id — identity drift is detectable across snapshots.
    try {
      const outcome = await this.snapshotService.acceptSnapshot({
        connectionId,
        balance: account.balance,
        equity: account.equity,
        margin: account.margin,
        freeMargin: account.freeMargin,
        marginLevel: account.marginLevel,
        leverage: account.leverage,
        openPositionsCount,
        currency: account.currency,
        providerObservedAt: null,
        providerAccountIdentity: account.accountId ?? null,
        source: 'state-reconciliation',
      });
      if (outcome.accepted) {
        await this.snapshotService.projectToLegacyAccount(outcome.snapshot);
      }
    } catch (err) {
      // Fail-safe: the reconciliation run's primary purpose (state
      // convergence) is not blocked by a snapshot-authority write failure —
      // logged loudly, never silent.
      this.logger.error(
        `Account snapshot acceptance failed for connection ${connectionId} ` +
          `during reconciliation: ${(err as Error).message}`,
      );
    }

    const existing = await this.accountRepo.findOne({
      where: { brokerConnectionId: connectionId },
    });

    const patch = {
      balance: account.balance,
      equity: account.equity,
      margin: account.margin,
      freeMargin: account.freeMargin,
      marginLevel: account.marginLevel,
      currency: account.currency,
      leverage: account.leverage,
      openPositionsCount,
      syncedAt: new Date(),
    };

    if (existing) {
      await this.accountRepo.update(existing.id, patch as never);
    } else {
      await this.accountRepo.save(
        this.accountRepo.create({
          brokerConnectionId: connectionId,
          ...patch,
        } as never),
      );
    }
  }

  // ─── Broker authority invalidation (§1b) ──────────────────────────────

  /**
   * Round 6 live-execution completion (§1b): invalidate the user's
   * NEW-exposure authority after a broker authority transition — bumps the
   * TradingAuthorityGeneration (every in-flight grant/confirmation fences on
   * it at the final dispatch boundary) AND revokes the currently-active
   * grants/PENDING confirmations through the tenant-scoped leaf seams.
   *
   * Ordering discipline (same as the disconnect hook): the DURABLE transition
   * lands first; this invalidation runs after it — a failure is logged and
   * audited, never silent, and never rolls back the durable fact.
   */
  private async invalidateBrokerAuthority(
    userId: string,
    reason:
      | 'BROKER_AUTHORIZATION_REVOKED'
      | 'BROKER_CONNECTION_SUSPENDED'
      | 'BROKER_CREDENTIAL_INVALIDATED'
      | 'BROKER_CREDENTIAL_ROTATED'
      | 'BROKER_PROVIDER_IDENTITY_CHANGED',
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

  // ─── Broker environment-mismatch enforcement (Round 7.1 P0-1) ──────────

  /**
   * Round 7.1 (P0-1 — shared environment-mismatch truth): evaluate a
   * broker-observed account environment against the connection's DECLARED
   * environment. This is the ONE truth shared by every synchronous
   * observation path (connect, health check, on-demand risk refresh,
   * reconciliation, credential rotation, dispatch) — no path may trust a
   * provider observation whose environment contradicts the declaration.
   *
   * Semantics:
   * - only SUCCESSFUL connections are evaluated (a failed connect is the
   *   caller's own failure path, never an environment verdict);
   * - `BrokerConnectionResult.accountType` is CONTRACTUALLY REQUIRED — a
   *   successful result without it is a contract violation and fails closed
   *   as a mismatch (an unclassifiable environment is never trusted);
   * - `accountTypeOptional` (credential-rotation `testConnection` results,
   *   where the field is genuinely optional) treats an ABSENT observation as
   *   "provider did not report" — vacuously consistent, never a mismatch.
   *
   * Returns `{ mismatch, observed }` — `observed` carries the provider's
   * classification (null when absent) for messages, audits and typed errors.
   */
  private evaluateEnvironmentMismatch(
    connection: BrokerConnection,
    result: { success: boolean; accountType?: BrokerMode | null },
    options: { accountTypeOptional?: boolean } = {},
  ): { mismatch: boolean; observed: BrokerMode | null } {
    if (!result.success) {
      return { mismatch: false, observed: result.accountType ?? null };
    }
    const observed = result.accountType ?? null;
    if (observed === null && options.accountTypeOptional) {
      return { mismatch: false, observed: null };
    }
    return { mismatch: observed !== connection.accountType, observed };
  }

  /**
   * Round 7.1 (P0-1 — synchronous observation environment enforcement):
   * assert that a broker-observed connection environment MATCHES the
   * declared one, applying the full fail-closed discipline on mismatch —
   * the same side-effect chain the health check performs:
   *
   *   guarded SUSPENDED transition → adapter release → trading-authority
   *   invalidation → CRITICAL audit (typed ACCOUNT_TYPE_MISMATCH metadata)
   *   → realtime status event → typed BrokerEnvironmentMismatchError.
   *
   * The typed error propagates so the CALLER fails closed too: the risk
   * engine keeps its original staleness rejection, a reconciliation run
   * records FAILED (no provider snapshot is persisted), and a dispatch
   * boundary refuses the provider call.
   *
   * No-op when the connection result is unsuccessful (the caller's own
   * failure handling owns that path) or the environment matches.
   */
  async assertConnectionEnvironment(
    connection: BrokerConnection,
    connectResult: { success: boolean; accountType?: BrokerMode | null },
    source: string,
  ): Promise<void> {
    const { mismatch, observed } = this.evaluateEnvironmentMismatch(connection, connectResult);
    if (!connectResult.success || !mismatch) {
      return;
    }
    let suspended = false;
    try {
      await this.applyGuardedAuthorizationUpdate(
        connection.id,
        connection.authorizationStatus,
        {
          status: BrokerConnectionStatus.SUSPENDED,
          lastErrorMessage:
            `Environment mismatch (${source}): the provider reports a ${observed ?? 'UNKNOWN'} ` +
            `account, but this connection was declared ${connection.accountType} (fail-closed).`,
          ...(this.canTransitionTo(connection, BrokerAuthorizationStatus.SUSPENDED)
            ? { authorizationStatus: BrokerAuthorizationStatus.SUSPENDED }
            : {}),
        },
        `environment-mismatch suspension (${source})`,
      );
      suspended = true;
    } catch (transitionErr) {
      this.logger.warn(
        `environment-mismatch suspension (${source}) lost a concurrent state race for ` +
          `${connection.id}: ${(transitionErr as Error).message}`,
      );
    }
    if (suspended) {
      this.adapterRegistry.releaseAdapterForConnection(connection.id);
      await this.invalidateBrokerAuthority(
        connection.userId,
        'BROKER_CONNECTION_SUSPENDED',
        `environment mismatch on connection ${connection.id} via ${source} (declared ` +
          `${connection.accountType}, provider reports ${observed ?? 'UNKNOWN'})`,
      );
      await this.auditService.log({
        action: AuditAction.BROKER_ENVIRONMENT_MISMATCH_SUSPENDED,
        resourceType: 'BrokerConnection',
        resourceId: connection.id,
        metadata: {
          brokerId: connection.brokerId,
          userId: connection.userId,
          failureCode: 'ACCOUNT_TYPE_MISMATCH',
          detectionSource: source,
          declaredAccountType: connection.accountType,
          providerObservedAccountType: observed ?? 'UNKNOWN',
        },
        severity: AuditSeverity.CRITICAL,
      });
      this.eventBus.publish(DomainEventType.BROKER_STATUS_CHANGED, connection.userId, {
        userId: connection.userId,
        connectionId: connection.id,
        status: BrokerConnectionStatus.SUSPENDED,
        previousStatus: BrokerConnectionStatus.CONNECTED,
        reason: `Suspended: provider-reported environment contradicts the declared one (${source})`,
      });
    }
    // P13 metrics: declared-vs-observed environment mismatch detected at the
    // synchronous-observation fence (every assertConnectionEnvironment caller
    // — state-reconciliation, on-demand risk evaluation — funnels through this
    // single throw site; the source label names the detecting path).
    this.metrics?.increment(METRIC_NAMES.BROKER_ENVIRONMENT_MISMATCHES, {
      brokerId: connection.brokerId,
      source,
    });
    throw new BrokerEnvironmentMismatchError(connection.accountType, observed ?? 'UNKNOWN', source);
  }

  // ─── Snapshot authority recording (§1a) ────────────────────────────────

  /**
   * Round 7 (P1 — LIVE snapshot availability): ONE bounded synchronous
   * provider observation, persisted as the next authoritative account
   * snapshot (the same §1a write path the health check uses).
   *
   * WHY: the LIVE NEW-exposure freshness window (30s) is tighter than the
   * health-check writer cadence (60s) — without an on-demand observation a
   * LIVE evaluation whose latest accepted snapshot is moments past the
   * window would fail closed SNAPSHOT_STALE even though the account is
   * perfectly reachable. The risk engine calls this (at most once per
   * evaluation) when the fresh-snapshot resolution reports staleness, then
   * re-resolves.
   *
   * Fail-closed semantics: ANY failure here propagates — the caller keeps
   * the ORIGINAL typed staleness error (a failed refresh must never
   * authorize a stale snapshot). No health-state transitions occur (this is
   * an observation, not a health check).
   */
  async observeAccountSnapshotNow(userId: string, connectionId: string): Promise<void> {
    const connection = await this.findConnectionById(connectionId, userId);
    if (!connection || connection.status !== BrokerConnectionStatus.CONNECTED) {
      throw new Error(`connection ${connectionId} is not CONNECTED — cannot observe`);
    }
    if (!connection.encryptedCredentials || !connection.credentialIv || !connection.credentialTag) {
      throw new Error(`connection ${connectionId} has no stored credentials — cannot observe`);
    }
    // A3: unusable credential states never reach the provider.
    this.assertCredentialsUsable(connection, 'observeAccountSnapshotNow');

    const adapter = this.adapterRegistry.getAdapterForConnection(
      connection.id,
      connection.brokerId,
    );
    const credentials = this.encryptionService.decrypt({
      ciphertext: connection.encryptedCredentials,
      iv: connection.credentialIv,
      tag: connection.credentialTag,
      keyId: connection.encryptionKeyId ?? 'env-key-v1',
    });
    adapter.setMode(connection.accountType);

    // Round 7.1 (P0-1): the SAME OAuth freshness gate as connectBroker and
    // healthCheck — an on-demand LIVE observation must run on the CURRENT
    // token pair (cTrader-family refresh + atomic persist before provider
    // use); a rejected refresh fails closed.
    const observationCredentials = await this.tokenLifecycle.ensureFreshTokens(
      connection,
      credentials,
    );

    // Reconnect first (idempotent — adapters reuse their connection pool and
    // only reconnect when stale): the observation must succeed even when the
    // pooled session aged out since the last health check.
    const connectResult = await adapter.connect(observationCredentials);

    // Round 7.1 (P0-1 — synchronous observation environment enforcement): a
    // successful API call is NOT sufficient trust — the provider-observed
    // account environment must MATCH the declared one before ANY snapshot
    // from this session is persisted. This path exists precisely to serve
    // in-flight LIVE risk evaluations; without the fence a provider-side
    // relabel (LIVE→DEMO or DEMO→LIVE) would become the freshest TRUSTED
    // snapshot up to a full health-check cadence before detection. On
    // mismatch the full fail-closed discipline applies (suspension +
    // authority invalidation + CRITICAL audit) and the typed error makes
    // the risk evaluation fail closed (no snapshot is persisted).
    await this.assertConnectionEnvironment(connection, connectResult, 'on-demand-risk-evaluation');

    if (!connectResult.success) {
      throw new Error(
        `connection ${connectionId} reconnect failed — cannot observe: ` +
          (connectResult.error ?? 'provider rejected the session'),
      );
    }

    const balance = await adapter.getAccountBalance();
    await this.recordAccountSnapshot(connection, {
      balance: balance.balance,
      equity: balance.equity,
      currency: balance.currency,
      providerObservedAt: balance.timestamp ?? null,
      source: 'on-demand-risk-evaluation',
    });
  }

  /**
   * Accept ONE provider account observation into the authoritative snapshot
   * model and project it into the legacy current-view.
   *
   * Fail-safe semantics: a snapshot-authority failure NEVER fails the
   * caller's primary flow (connect / health check succeeded provider-side);
   * it is logged loudly and the next observation records fresh truth. The
   * observation is fully materialized by the caller BEFORE this call — no
   * provider I/O happens inside the snapshot write path.
   */
  private async recordAccountSnapshot(
    connection: BrokerConnection,
    observation: {
      balance: string | null;
      equity: string | null;
      margin?: string | null;
      freeMargin?: string | null;
      marginLevel?: string | null;
      leverage?: number | null;
      openPositionsCount?: number | null;
      currency: string | null;
      providerObservedAt?: Date | null;
      source: string;
    },
  ): Promise<void> {
    const providerObservation: ProviderAccountObservation = {
      connectionId: connection.id,
      balance: observation.balance,
      equity: observation.equity,
      margin: observation.margin ?? null,
      freeMargin: observation.freeMargin ?? null,
      marginLevel: observation.marginLevel ?? null,
      leverage: observation.leverage ?? null,
      openPositionsCount: observation.openPositionsCount ?? null,
      currency: observation.currency,
      providerObservedAt: observation.providerObservedAt ?? null,
      providerAccountIdentity: connection.accountId ?? null,
      source: observation.source,
    };

    const outcome = await this.snapshotService.acceptSnapshot(providerObservation);
    if (outcome.accepted) {
      await this.snapshotService.projectToLegacyAccount(outcome.snapshot);
    } else {
      this.logger.warn(
        `Snapshot ${outcome.reason} for connection ${connection.id} ` +
          `(source=${observation.source}, currentGeneration=${outcome.currentGeneration}) — ` +
          'observation not accepted; the winning writer is the authority',
      );
    }
  }
}
