import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BrokerConnection } from './entities/broker-connection.entity';
import { BrokerAccount } from './entities/broker-account.entity';
import { BrokerAdapterRegistry } from './adapters/broker-adapter.registry';
import { CredentialEncryptionService } from './services/credential-encryption.service';
import {
  BrokerAccountInfo,
  BrokerConnectionStatus,
  BrokerMode,
  DecryptedBrokerCredentials,
  OHLCV,
} from './interfaces/broker-adapter.interface';
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
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../../common/enums/audit-action.enum';
import { AuditSeverity } from '../audit/entities/audit-log.entity';
import { ConnectBrokerDto } from './dto/connect-broker.dto';
import { DomainEventBus } from '../events/event-bus.service';
import { DomainEventType } from '../events/enums/domain-event-type.enum';

/**
 * BrokerService — Core broker connection lifecycle management.
 *
 * SECURITY INVARIANTS (enforced throughout):
 * 1. Decrypted credentials exist in memory only for the duration of the adapter call
 * 2. Credentials are NEVER logged — log only accountId, brokerId, connectionId
 * 3. Credentials are NEVER returned from any method or included in any response
 * 4. DEMO mode is mandatory before LIVE mode can be enabled
 * 5. Credential encryption/decryption delegated to CredentialEncryptionService only
 *
 * See: docs/architecture/09-broker-integration-architecture.md
 */
@Injectable()
export class BrokerService {
  private readonly logger = new Logger(BrokerService.name);

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
  ) {}

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
    const adapter = this.adapterRegistry.getAdapter(dto.brokerId);
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
   */
  async createConnection(
    dto: ConnectBrokerDto,
    userId: string,
    ipAddress?: string,
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

    const credentials: DecryptedBrokerCredentials = {
      apiKey: dto.apiKey,
      apiSecret: dto.apiSecret,
      accountId: dto.accountId,
      serverUrl: dto.serverUrl,
      additionalParams: dto.additionalParams,
    };

    const encrypted = this.encryptionService.encrypt(credentials);

    const connection = this.connectionRepo.create({
      userId,
      brokerId: dto.brokerId,
      brokerName: this.adapterRegistry.getAdapter(dto.brokerId).brokerName,
      displayName: dto.displayName ?? `${dto.brokerId} ${dto.accountType}`,
      accountId: dto.accountId,
      accountType: dto.accountType as BrokerMode,
      status: BrokerConnectionStatus.DISCONNECTED,
      authorizationStatus: BrokerAuthorizationStatus.NOT_CONNECTED,
      credentialStatus: BrokerCredentialStatus.CREATED,
      encryptedCredentials: encrypted.ciphertext,
      credentialIv: encrypted.iv,
      credentialTag: encrypted.tag,
      encryptionKeyId: encrypted.keyId,
    });

    const saved = await this.connectionRepo.save(connection);

    await this.auditService.log({
      actorUserId: userId,
      action: AuditAction.BROKER_CONNECTION_CREATED,
      resourceType: 'BrokerConnection',
      resourceId: saved.id,
      ipAddress,
      metadata: {
        brokerId: dto.brokerId,
        accountId: dto.accountId,
        accountType: dto.accountType,
      },
    });

    this.logger.log(
      `Broker connection created: id=${saved.id} broker=${dto.brokerId} user=${userId}`,
    );
    return saved;
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
    const adapter = this.adapterRegistry.getAdapter(connection.brokerId);

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

    try {
      const result = await adapter.connect(credentials);

      if (!result.success) {
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
              lastErrorMessage: result.error ?? 'Connection rejected by broker',
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
          metadata: { brokerId: connection.brokerId, error: result.error },
          severity: AuditSeverity.WARNING,
        });

        throw new BadRequestException(`Broker connection failed: ${result.error}`);
      }

      // Upsert BrokerAccount with latest synced state
      await this.upsertBrokerAccount(connectionId, result.currency);

      // Successful handshake verifies the credential set (Directive §14)
      // and advances the authorization state machine (Directive §15):
      //   DEMO account  → AUTHORIZED (demo validation — fixes the previously
      //                   unreachable demoValidated gate; dual-written below)
      //   LIVE account → CONNECTED (explicit enable-live-trading still required)
      const postConnectAuthorization =
        connection.accountType === BrokerMode.DEMO
          ? BrokerAuthorizationStatus.AUTHORIZED
          : BrokerAuthorizationStatus.CONNECTED;

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

      this.logger.log(
        `Broker connected: id=${connectionId} account=${result.accountId} user=${userId}`,
      );
    } finally {
      // Explicitly zero out reference — decrypted credentials go out of scope here
      Object.keys(credentials).forEach((k) => {
        (credentials as unknown as Record<string, unknown>)[k] = null;
      });
    }

    return this.findConnectionById(connectionId, userId);
  }

  /**
   * Disconnect a broker connection. Suspends trading if active.
   */
  async disconnectBroker(connectionId: string, userId: string, ipAddress?: string): Promise<void> {
    const connection = await this.findConnectionById(connectionId, userId);

    if (connection.status === BrokerConnectionStatus.CONNECTED) {
      try {
        const adapter = this.adapterRegistry.getAdapter(connection.brokerId);
        await adapter.disconnect();
      } catch (err) {
        this.logger.warn(
          `Adapter disconnect error for connection ${connectionId}: ${(err as Error).message}`,
        );
      }
    }

    // A4: guarded on the loaded authorization state — a concurrent
    // enable-live/revoke/connect that changed the state makes this stale
    // disconnect fail visibly instead of overwriting the winner.
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
   *   4. The user explicitly enables it
   *
   * Live trading without prior DEMO validation is an architectural violation.
   */
  async enableLiveTrading(connectionId: string, userId: string, ipAddress?: string): Promise<void> {
    const connection = await this.findConnectionById(connectionId, userId);

    if (connection.accountType !== BrokerMode.LIVE) {
      throw new BadRequestException('Only LIVE account connections can have live trading enabled');
    }

    // Registry gate: provider must explicitly support LIVE execution
    if (!this.providerRegistry.supportsEnvironment(connection.brokerId, BrokerMode.LIVE)) {
      throw new ForbiddenException(`Broker ${connection.brokerId} does not support LIVE execution`);
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

    const adapter = this.adapterRegistry.getAdapter(connection.brokerId);
    adapter.setMode(connection.accountType);

    const newCredentials: DecryptedBrokerCredentials = {
      apiKey: dto.apiKey,
      apiSecret: dto.apiSecret,
      accountId: dto.accountId,
      serverUrl: dto.serverUrl,
      additionalParams: dto.additionalParams,
    };

    let testOk = false;
    let testError: string | undefined;
    try {
      const result = await adapter.testConnection(newCredentials);
      testOk = result.success;
      testError = result.errorMessage;
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

    const adapter = this.adapterRegistry.getAdapter(connection.brokerId);

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
      // connect() reuses the MetaAPI connection pool — only reconnects if stale
      await adapter.connect(credentials);
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
        // A4: the SUSPENDED transition is a guarded conditional write on the
        // loaded authorization state. A concurrent revoke/enable-live that
        // changed the state means this stale suspension MUST NOT overwrite
        // the winner — the conflict is logged and the state is left alone
        // (fail-closed for state, telemetry already recorded above).
        const canSuspend = this.canTransitionTo(connection, BrokerAuthorizationStatus.SUSPENDED);
        try {
          if (canSuspend) {
            await this.applyGuardedAuthorizationUpdate(
              connectionId,
              connection.authorizationStatus,
              {
                status: BrokerConnectionStatus.SUSPENDED,
                // Fail-closed: suspended connections lose execution authorization
                authorizationStatus: BrokerAuthorizationStatus.SUSPENDED,
              },
              'healthCheck SUSPENDED transition',
            );
          } else {
            await this.connectionRepo.update(connectionId, {
              status: BrokerConnectionStatus.SUSPENDED,
            });
          }
        } catch (transitionErr) {
          this.logger.warn(
            `healthCheck suspend lost a concurrent state race for ${connectionId}: ` +
              `${(transitionErr as Error).message} — leaving the authoritative state untouched`,
          );
        }
      }

      if (failureCount >= SUSPEND_THRESHOLD) {
        this.logger.error(
          `Broker connection ${connectionId} suspended after ${failureCount} consecutive failures`,
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
  ): Promise<OHLCV[]> {
    const connection = await this.findConnectionById(brokerConnectionId, userId);

    if (connection.status !== BrokerConnectionStatus.CONNECTED) {
      throw new ForbiddenException('Broker connection is not active');
    }

    const adapter = this.adapterRegistry.getAdapter(connection.brokerId);

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
      return await adapter.getOHLCV(instrument, timeframe, limit);
    } catch (err) {
      this.logger.warn(
        `OHLCV fetch failed connection=${brokerConnectionId} instrument=${instrument}: ` +
          `${(err as Error).message}`,
      );
      throw err;
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

    const adapter = this.adapterRegistry.getAdapter(connection.brokerId);

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
   * Get the last-synced BrokerAccount state for a connection.
   * Used by RiskService for margin and equity checks.
   */
  async getBrokerAccountState(
    connectionId: string,
  ): Promise<{ balance: string; equity: string; freeMargin: string; currency: string } | null> {
    const account = await this.accountRepo.findOne({
      where: { brokerConnectionId: connectionId },
    });
    if (!account) return null;
    return {
      balance: account.balance,
      equity: account.equity,
      freeMargin: account.freeMargin,
      currency: account.currency ?? 'USD',
    };
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

    const adapter = this.adapterRegistry.getAdapter(connection.brokerId);
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
}
