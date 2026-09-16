import { Test, TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { BrokerService } from './broker.service';
import { TradingAuthorityService } from '../execution-authority/trading-authority.service';
import { GrantInvalidationService } from '../execution-authority/grant-invalidation.service';
import { BrokerConnection } from './entities/broker-connection.entity';
import { BrokerAccount } from './entities/broker-account.entity';
import { BrokerAdapterRegistry } from './adapters/broker-adapter.registry';
import { BrokerProviderRegistryService } from './registry/broker-provider-registry.service';
import { CredentialEncryptionService } from './services/credential-encryption.service';
import { AuditService } from '../audit/audit.service';
import { BrokerOAuthTokenLifecycleService } from './services/broker-oauth-token-lifecycle.service';
import { BrokerAccountSnapshotService } from './services/broker-account-snapshot.service';
import {
  BrokerLinkOutboxService,
  BrokerLinkOutboxEntry,
} from './services/broker-link-outbox.service';
import { BrokerConnectionServerDerived } from './broker.service';
import { BrokerLogicalAccountConflictError } from './interfaces/broker-connection.errors';
import { AuditAction } from '../../common/enums/audit-action.enum';
import { BrokerConnectionStatus, BrokerMode } from './interfaces/broker-adapter.interface';
import { BrokerAuthorizationStatus } from './authorization/broker-authorization-status';
import { DomainEventBus } from '../events/event-bus.service';

// ─── Mock factories ───────────────────────────────────────────────────────────

const mockLinkOutbox = () => ({
  enqueue: jest.fn().mockResolvedValue(undefined),
  // The critical-path seam: called INSIDE createConnection's transaction.
  enqueueWithinTransaction: jest.fn().mockResolvedValue(undefined),
  sweep: jest.fn().mockResolvedValue({ delivered: 0, failed: 0, deferred: 0 }),
});

const mockConnectionRepo = () => {
  const repo: Record<string, jest.Mock> = {
    find: jest.fn(),
    findOne: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    softDelete: jest.fn(),
  };
  // Sprint 56 correction round 5 (#332): createConnection commits the
  // connection INSERT + its outbox rows in ONE DataSource.transaction(). The
  // mock delegates the transaction to a manager whose repository is the SAME
  // repo mock — so save/findOne expectations keep working unchanged.
  const txManager = { getRepository: () => repo };
  (repo as unknown as { manager: unknown }).manager = {
    transaction: jest.fn(async (cb: (m: unknown) => Promise<unknown>) => cb(txManager)),
  };
  return repo;
};

const mockAccountRepo = () => ({
  findOne: jest.fn().mockResolvedValue(null),
  create: jest.fn().mockImplementation((obj) => obj),
  save: jest.fn().mockResolvedValue({}),
  update: jest.fn().mockResolvedValue({ affected: 1 }),
});

const mockRegistry = () => {
  const getAdapter = jest.fn();
  return {
    isSupported: jest.fn().mockReturnValue(true),
    getAdapter,
    // #291 / correction round 3: production code resolves connection-scoped
    // and ephemeral adapters through the registry session API — the mock
    // delegates to the same per-broker adapter stubs the legacy getAdapter
    // expectations use.
    getAdapterForConnection: jest.fn((_connectionId: string, brokerId: string) =>
      getAdapter(brokerId),
    ),
    createEphemeralAdapter: jest.fn((brokerId: string) => getAdapter(brokerId)),
    releaseAdapterForConnection: jest.fn(),
    getSupportedBrokers: jest
      .fn()
      .mockReturnValue([
        { brokerId: 'metatrader5', brokerName: 'MetaTrader 5 (via MetaAPI)', supportsDemo: true },
      ]),
  };
};

// Sprint 50 — provider registry mock (permissive defaults preserve legacy
// test expectations; dedicated registry specs exercise the real service)
const mockProviderRegistry = () => ({
  getCatalog: jest.fn().mockReturnValue([]),
  getEntry: jest.fn().mockReturnValue(null),
  isConnectable: jest.fn().mockReturnValue(true),
  hasCapability: jest.fn().mockReturnValue(true),
  supportsEnvironment: jest.fn().mockReturnValue(true),
  // Phase H: fixtures are metatrader5 (the VERIFIED provider); the real
  // fail-closed semantics are proven in broker-authorization-lifecycle.spec.
  isProductionLiveEligible: jest.fn().mockReturnValue(true),
  catalogVersion: 'v1',
});

const mockEncryption = () => ({
  encrypt: jest.fn().mockReturnValue({
    ciphertext: 'ciphertext_abc',
    iv: 'iv_abc',
    tag: 'tag_abc',
    keyId: 'env-key-v1',
  }),
  decrypt: jest.fn().mockReturnValue({
    apiKey: 'test-key',
    accountId: '123456',
  }),
});

const mockAudit = () => ({
  log: jest.fn().mockResolvedValue(undefined),
});

const mockEventBus = () => ({
  publish: jest.fn(),
  subscribe: jest.fn().mockReturnValue(() => {}),
});

// Sprint 56 correction round 1 — OAuth token lifecycle mock (passthrough by
// default; dedicated tests override ensureFreshTokens to return a refreshed pair).
const mockTokenLifecycle = () => ({
  ensureFreshTokens: jest.fn((_connection: unknown, credentials: unknown) =>
    Promise.resolve(credentials),
  ),
});

// ─── Connected-connection fixture with full credentials ───────────────────────

const connectedConnection = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: 'conn-1',
  userId: 'user-1',
  brokerId: 'metatrader5',
  accountType: BrokerMode.DEMO,
  status: BrokerConnectionStatus.CONNECTED,
  consecutiveFailureCount: 0,
  // A3: usable credential state — the lifecycle gate must pass
  credentialStatus: 'VERIFIED',
  authorizationStatus: 'ACTIVE',
  encryptedCredentials: 'ciphertext',
  credentialIv: 'iv',
  credentialTag: 'tag',
  encryptionKeyId: 'env-key-v1',
  ...overrides,
});

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('BrokerService', () => {
  let module: TestingModule;
  let service: BrokerService;
  let connectionRepo: ReturnType<typeof mockConnectionRepo>;
  let accountRepo: ReturnType<typeof mockAccountRepo>;
  let registry: ReturnType<typeof mockRegistry>;
  let encryption: ReturnType<typeof mockEncryption>;
  let auditService: ReturnType<typeof mockAudit>;
  let linkOutbox: ReturnType<typeof mockLinkOutbox>;
  let snapshotService: {
    readLatestAcceptedSnapshot: jest.Mock;
    acceptSnapshot: jest.Mock;
    projectToLegacyAccount: jest.Mock;
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    module = await Test.createTestingModule({
      providers: [
        BrokerService,
        // Round 6 (#300): the unified execution-authority seams (mocked —
        // the bump/invalidation matrices live in the execution-authority suites).
        {
          provide: TradingAuthorityService,
          useValue: {
            getCurrentGeneration: jest.fn().mockResolvedValue(1),
            bumpGeneration: jest.fn().mockResolvedValue(2),
          },
        },
        {
          provide: GrantInvalidationService,
          useValue: {
            invalidateUserNewExposureAuthority: jest
              .fn()
              .mockResolvedValue({ invalidatedGrants: 0, revokedConfirmations: 0 }),
          },
        },
        { provide: getRepositoryToken(BrokerConnection), useFactory: mockConnectionRepo },
        { provide: getRepositoryToken(BrokerAccount), useFactory: mockAccountRepo },
        { provide: BrokerAdapterRegistry, useFactory: mockRegistry },
        { provide: BrokerProviderRegistryService, useFactory: mockProviderRegistry },
        { provide: CredentialEncryptionService, useFactory: mockEncryption },
        { provide: AuditService, useFactory: mockAudit },
        { provide: BrokerLinkOutboxService, useFactory: mockLinkOutbox },
        { provide: DataSource, useValue: {} },
        { provide: DomainEventBus, useFactory: mockEventBus },
        { provide: BrokerOAuthTokenLifecycleService, useFactory: mockTokenLifecycle },
        // Round 6 live-execution completion (§1a): the snapshot authority
        // seam — mocked here (the monotonic accept/project matrices live in
        // broker-account-snapshot.service.spec.ts).
        {
          provide: BrokerAccountSnapshotService,
          useValue: {
            readLatestAcceptedSnapshot: jest.fn().mockResolvedValue(null),
            acceptSnapshot: jest.fn().mockResolvedValue({
              accepted: true,
              snapshot: { connectionId: 'conn-1', generation: 1 },
            }),
            projectToLegacyAccount: jest.fn().mockResolvedValue(undefined),
          },
        },
      ],
    }).compile();

    service = module.get<BrokerService>(BrokerService);
    connectionRepo = module.get(getRepositoryToken(BrokerConnection));
    accountRepo = module.get(getRepositoryToken(BrokerAccount));
    registry = module.get(BrokerAdapterRegistry);
    encryption = module.get(CredentialEncryptionService);
    auditService = module.get(AuditService);
    linkOutbox = module.get(BrokerLinkOutboxService);
    snapshotService = module.get(BrokerAccountSnapshotService);
  });

  afterEach(async () => {
    await module.close();
  });

  // ─── getSupportedBrokers ──────────────────────────────────────────────────

  describe('getSupportedBrokers()', () => {
    it('returns the list from the registry', () => {
      const result = service.getSupportedBrokers();
      expect(result).toHaveLength(1);
      expect(result[0].brokerId).toBe('metatrader5');
    });
  });

  // ─── findConnectionsByUser ────────────────────────────────────────────────

  describe('findConnectionsByUser()', () => {
    it('returns connections for the given user', async () => {
      const mockConns = [{ id: 'conn-1', userId: 'user-1' }];
      connectionRepo.find.mockResolvedValue(mockConns);

      const result = await service.findConnectionsByUser('user-1');
      expect(result).toEqual(mockConns);
      expect(connectionRepo.find).toHaveBeenCalledWith({
        where: { userId: 'user-1' },
        order: { createdAt: 'DESC' },
      });
    });
  });

  // ─── findConnectionById ───────────────────────────────────────────────────

  describe('findConnectionById()', () => {
    it('returns a connection when found', async () => {
      const mockConn = { id: 'conn-1', userId: 'user-1' };
      connectionRepo.findOne.mockResolvedValue(mockConn);

      const result = await service.findConnectionById('conn-1', 'user-1');
      expect(result).toEqual(mockConn);
    });

    it('throws NotFoundException when not found', async () => {
      connectionRepo.findOne.mockResolvedValue(null);
      await expect(service.findConnectionById('bad-id', 'user-1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ─── createConnection ─────────────────────────────────────────────────────

  describe('createConnection()', () => {
    it('encrypts credentials and saves the connection', async () => {
      const dto = {
        brokerId: 'metatrader5',
        accountType: BrokerMode.DEMO,
        accountId: '123456',
        apiKey: 'test-api-key',
        apiSecret: 'test-api-secret',
      };
      const savedConn = { id: 'conn-new', ...dto };
      connectionRepo.create.mockReturnValue(savedConn);
      connectionRepo.save.mockResolvedValue(savedConn);
      registry.getAdapter.mockReturnValue({ brokerName: 'MetaTrader 5 (via MetaAPI)' });

      const result = await service.createConnection(dto as any, 'user-1');

      expect(encryption.encrypt).toHaveBeenCalledWith(
        expect.objectContaining({ apiKey: 'test-api-key', accountId: '123456' }),
      );
      // The save happens INSIDE the single transaction (via the delegating
      // manager) — and the audit is now durable outbox work, NOT a
      // synchronous call (issue #332).
      expect(connectionRepo.save).toHaveBeenCalled();
      expect(linkOutbox.enqueueWithinTransaction).toHaveBeenCalledTimes(1);
      const entries: BrokerLinkOutboxEntry[] = linkOutbox.enqueueWithinTransaction.mock.calls[0][1];
      expect(entries).toHaveLength(2); // connection-created audit + status event
      expect(auditService.log).not.toHaveBeenCalled();
      expect(result.id).toBe('conn-new');
    });

    it('persists the DERIVED logical account key at INSERT time (manual connects are idempotency-protected, #332)', async () => {
      const dto = {
        brokerId: 'metatrader5',
        accountType: BrokerMode.DEMO,
        accountId: '123456',
        apiKey: 'k',
      };
      registry.getAdapter.mockReturnValue({ brokerName: 'MetaTrader 5' });
      connectionRepo.create.mockImplementation((obj) => obj);
      connectionRepo.save.mockImplementation(async (obj) => ({ id: 'new-id', ...obj }));

      await service.createConnection(dto as any, 'user-1');

      expect(connectionRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ logicalAccountKey: 'metatrader5|metatrader5|123456' }),
      );
    });

    it('persists the EXPLICIT server-derived logical account key verbatim (OAuth link path, #332)', async () => {
      const dto = {
        brokerId: 'ctrader',
        accountType: BrokerMode.DEMO,
        accountId: '1234567',
        apiKey: 'k',
      };
      registry.getAdapter.mockReturnValue({ brokerName: 'cTrader' });
      connectionRepo.create.mockImplementation((obj) => obj);
      connectionRepo.save.mockImplementation(async (obj) => ({ id: 'new-id', ...obj }));
      const serverDerived: BrokerConnectionServerDerived = {
        providerBrokerIdentity: 'spotware',
        logicalAccountKey: 'ctrader|spotware|1234567',
        flowId: 'flow-1',
        // the OAuth ACCOUNT_LINKED audit rides the SAME atomic outbox batch
        linkAudit: {
          payload: {
            action: 'BROKER_OAUTH_ACCOUNT_LINKED',
            actorUserId: 'user-1',
            ipAddress: '1.2.3.4',
            metadata: { brokerId: 'ctrader' },
            severity: 'INFO',
          },
        },
      };

      await service.createConnection(dto as any, 'user-1', '1.2.3.4', serverDerived);

      expect(connectionRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ logicalAccountKey: 'ctrader|spotware|1234567' }),
      );
      // The optional OAuth link audit rides the SAME atomic outbox batch.
      const entries: BrokerLinkOutboxEntry[] = linkOutbox.enqueueWithinTransaction.mock.calls[0][1];
      expect(entries).toHaveLength(3);
      expect(entries.every((e) => e.flowId === 'flow-1')).toBe(true);
    });

    it('throws the typed logical-account conflict (carrying the existing row) on a unique-violation INSERT (#332)', async () => {
      const dto = {
        brokerId: 'ctrader',
        accountType: BrokerMode.DEMO,
        accountId: '1234567',
        apiKey: 'k',
      };
      registry.getAdapter.mockReturnValue({ brokerName: 'cTrader' });
      connectionRepo.create.mockImplementation((obj) => obj);
      const uniqueViolation = Object.assign(
        new Error(
          'UNIQUE constraint failed: broker_connections.user_id, broker_connections.logical_account_key',
        ),
        { code: '23505' },
      );
      // BOTH calls in this test hit the unique violation (second call below
      // re-throws to capture the typed error object)
      connectionRepo.save.mockRejectedValueOnce(uniqueViolation);
      connectionRepo.save.mockRejectedValueOnce(uniqueViolation);
      const existing = {
        id: 'existing-conn',
        logicalAccountKey: 'ctrader|spotware|1234567',
      } as never;
      connectionRepo.findOne.mockResolvedValue(existing);

      await expect(
        service.createConnection(dto as any, 'user-1', '1.2.3.4', {
          // server-derived identity: the derived key is ctrader|spotware|1234567
          providerBrokerIdentity: 'spotware',
        }),
      ).rejects.toBeInstanceOf(BrokerLogicalAccountConflictError);
      // The existing non-deleted connection is loaded by (userId, key) for ADOPTION.
      expect(connectionRepo.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            userId: 'user-1',
            logicalAccountKey: 'ctrader|spotware|1234567',
            // IsNull() find-operator (soft-deleted rows excluded).
            deletedAt: expect.anything(),
          },
        }),
      );
      const err = await service
        .createConnection(dto as any, 'user-1', '1.2.3.4', {
          providerBrokerIdentity: 'spotware',
        })
        .catch((e: unknown) => e);
      expect((err as BrokerLogicalAccountConflictError).existingConnection).toBeDefined();
      expect((err as BrokerLogicalAccountConflictError).existingConnection).toMatchObject({
        id: 'existing-conn',
      });
    });

    it('a NON-unique INSERT failure propagates unchanged (no adoption lookup)', async () => {
      const dto = {
        brokerId: 'ctrader',
        accountType: BrokerMode.DEMO,
        accountId: '1234567',
        apiKey: 'k',
      };
      registry.getAdapter.mockReturnValue({ brokerName: 'cTrader' });
      connectionRepo.create.mockImplementation((obj) => obj);
      connectionRepo.save.mockRejectedValueOnce(new Error('connection refused'));

      await expect(service.createConnection(dto as any, 'user-1')).rejects.toThrow(
        'connection refused',
      );
      expect(connectionRepo.findOne).not.toHaveBeenCalled();
    });

    it('an OUTBOX enqueue failure fails the whole createConnection (one transaction: rollback semantics, #332)', async () => {
      const dto = {
        brokerId: 'ctrader',
        accountType: BrokerMode.DEMO,
        accountId: '1234567',
        apiKey: 'k',
      };
      registry.getAdapter.mockReturnValue({ brokerName: 'cTrader' });
      connectionRepo.create.mockImplementation((obj) => obj);
      connectionRepo.save.mockImplementation(async (obj) => ({ id: 'new-id', ...obj }));
      linkOutbox.enqueueWithinTransaction.mockRejectedValueOnce(new Error('outbox insert failed'));

      // createConnection throws ⟺ its transaction rolled back — an outbox
      // failure means ZERO durable rows (the audit work can never be lost
      // while the connection persists).
      await expect(service.createConnection(dto as any, 'user-1')).rejects.toThrow(
        'outbox insert failed',
      );
      // No synchronous audit — nothing was committed.
      expect(auditService.log).not.toHaveBeenCalled();
    });

    it('never includes raw credentials in the saved entity', async () => {
      const dto = {
        brokerId: 'metatrader5',
        accountType: BrokerMode.DEMO,
        accountId: '123456',
        apiKey: 'super-secret-key',
      };
      registry.getAdapter.mockReturnValue({ brokerName: 'MetaTrader 5' });
      connectionRepo.create.mockImplementation((obj) => obj);
      connectionRepo.save.mockImplementation(async (obj) => ({ id: 'new-id', ...obj }));

      const result = await service.createConnection(dto as any, 'user-1');

      expect(JSON.stringify(result)).not.toContain('super-secret-key');
    });

    // Sprint 29 amendment: verify audit metadata never contains sensitive fields
    it('never includes credentials in audit metadata (Sprint 29 — now the outbox payload, #332)', async () => {
      const dto = {
        brokerId: 'metatrader5',
        accountType: BrokerMode.DEMO,
        accountId: '123456',
        apiKey: 'super-secret-api-key',
        apiSecret: 'super-secret-api-secret',
      };
      registry.getAdapter.mockReturnValue({ brokerName: 'MetaTrader 5' });
      connectionRepo.create.mockImplementation((obj) => obj);
      connectionRepo.save.mockImplementation(async (obj) => ({ id: 'new-id', ...obj }));

      await service.createConnection(dto as any, 'user-1');

      // The audit payload is committed to the outbox atomically with the row
      // (delivery happens later via the sweep).
      expect(linkOutbox.enqueueWithinTransaction).toHaveBeenCalled();
      const entries: BrokerLinkOutboxEntry[] = linkOutbox.enqueueWithinTransaction.mock.calls[0][1];
      const auditEntry = entries.find((e) => e.eventType === 'connection-created-audit')!;
      expect(auditEntry.payload.action).toBe(AuditAction.BROKER_CONNECTION_CREATED);
      const metadataStr = JSON.stringify(auditEntry.payload.metadata);
      // Audit metadata must NOT contain any credential fields
      expect(metadataStr).not.toContain('super-secret-api-key');
      expect(metadataStr).not.toContain('super-secret-api-secret');
      expect(metadataStr).not.toContain('apiKey');
      expect(metadataStr).not.toContain('apiSecret');
      expect(metadataStr).not.toContain('password');
      expect(metadataStr).not.toContain('token');
      expect(metadataStr).not.toContain('encryptedCredentials');
      // Metadata should only contain safe fields
      expect(metadataStr).toContain('brokerId');
      expect(metadataStr).toContain('accountId');
    });

    it('findLiveConnectionByLogicalKey looks up the non-deleted connection by (userId, key) (#332)', async () => {
      const existing = { id: 'existing-conn' } as never;
      connectionRepo.findOne.mockResolvedValueOnce(existing);
      connectionRepo.findOne.mockResolvedValueOnce(null);

      await expect(
        service.findLiveConnectionByLogicalKey('user-1', 'ctrader|spotware|1234567'),
      ).resolves.toMatchObject({ id: 'existing-conn' });
      await expect(
        service.findLiveConnectionByLogicalKey('user-1', 'ctrader|spotware|1234567'),
      ).resolves.toBeNull();
      expect(connectionRepo.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            userId: 'user-1',
            logicalAccountKey: 'ctrader|spotware|1234567',
            // IsNull() find-operator (soft-deleted rows excluded).
            deletedAt: expect.anything(),
          },
        }),
      );
    });
  });

  // ─── hasActiveConnection ──────────────────────────────────────────────────

  describe('hasActiveConnection()', () => {
    it('returns true when a connected broker exists', async () => {
      connectionRepo.findOne.mockResolvedValue({
        id: 'conn-1',
        status: BrokerConnectionStatus.CONNECTED,
      });
      expect(await service.hasActiveConnection('user-1')).toBe(true);
    });

    it('returns false when no connected broker exists', async () => {
      connectionRepo.findOne.mockResolvedValue(null);
      expect(await service.hasActiveConnection('user-1')).toBe(false);
    });
  });

  // ─── connectBroker ────────────────────────────────────────────────────────

  describe('connectBroker()', () => {
    it('throws BadRequestException when credentials are missing', async () => {
      connectionRepo.findOne.mockResolvedValue({
        id: 'conn-1',
        userId: 'user-1',
        brokerId: 'metatrader5',
        encryptedCredentials: null,
        credentialIv: null,
        credentialTag: null,
      });

      await expect(service.connectBroker('conn-1', 'user-1')).rejects.toThrow(
        'Broker connection has no stored credentials',
      );
    });

    it('calls decrypt and adapter.connect with decrypted credentials', async () => {
      const mockAdapter = {
        setMode: jest.fn(),
        connect: jest.fn().mockResolvedValue({
          success: true,
          accountId: '123456',
          accountType: BrokerMode.DEMO,
          currency: 'USD',
          serverTime: new Date(),
        }),
      };
      registry.getAdapter.mockReturnValue(mockAdapter);

      const mockConn = {
        id: 'conn-1',
        userId: 'user-1',
        brokerId: 'metatrader5',
        accountType: BrokerMode.DEMO,
        encryptedCredentials: 'ciphertext',
        credentialIv: 'iv',
        credentialTag: 'tag',
        encryptionKeyId: 'env-key-v1',
        authorizationStatus: BrokerAuthorizationStatus.NOT_CONNECTED,
        credentialStatus: 'CREATED',
        consecutiveFailureCount: 0,
      };
      connectionRepo.findOne
        .mockResolvedValueOnce(mockConn)
        .mockResolvedValueOnce({ ...mockConn, status: BrokerConnectionStatus.CONNECTED });
      // A4: repository.update must resolve an UpdateResult with affected > 0
      connectionRepo.update.mockResolvedValue({ affected: 1 });
      accountRepo.findOne.mockResolvedValue(null);
      accountRepo.create.mockReturnValue({});
      accountRepo.save.mockResolvedValue({});

      await service.connectBroker('conn-1', 'user-1');

      expect(encryption.decrypt).toHaveBeenCalled();
      // Credentials zeroed in finally block — verify connect was called, not the values
      expect(mockAdapter.connect).toHaveBeenCalledTimes(1);
      expect(auditService.log).toHaveBeenCalled();
    });

    it('connects with the REFRESHED credentials when the OAuth lifecycle rotates the pair (audit point 1)', async () => {
      const mockAdapter = {
        setMode: jest.fn(),
        connect: jest.fn().mockResolvedValue({
          success: true,
          accountId: '123456',
          accountType: BrokerMode.DEMO,
          currency: 'USD',
          serverTime: new Date(),
        }),
      };
      registry.getAdapter.mockReturnValue(mockAdapter);

      const refreshedCredentials = {
        apiKey: 'refreshed-access-token',
        accountId: '123456',
        additionalParams: {
          refreshToken: 'rotated-refresh-token',
          accessTokenExpiresAt: new Date(Date.now() + 2_628_000_000).toISOString(),
        },
      };
      const lifecycle = module.get<ReturnType<typeof mockTokenLifecycle>>(
        BrokerOAuthTokenLifecycleService,
      );
      lifecycle.ensureFreshTokens.mockResolvedValue(refreshedCredentials);

      const mockConn = {
        id: 'conn-1',
        userId: 'user-1',
        brokerId: 'ctrader',
        accountType: BrokerMode.DEMO,
        encryptedCredentials: 'ciphertext',
        credentialIv: 'iv',
        credentialTag: 'tag',
        encryptionKeyId: 'env-key-v1',
        authorizationStatus: BrokerAuthorizationStatus.NOT_CONNECTED,
        credentialStatus: 'ROTATED',
        consecutiveFailureCount: 0,
      };
      connectionRepo.findOne
        .mockResolvedValueOnce(mockConn)
        .mockResolvedValueOnce({ ...mockConn, status: BrokerConnectionStatus.CONNECTED });
      connectionRepo.update.mockResolvedValue({ affected: 1 });
      accountRepo.findOne.mockResolvedValue(null);
      accountRepo.create.mockReturnValue({});
      accountRepo.save.mockResolvedValue({});

      await service.connectBroker('conn-1', 'user-1');

      // The lifecycle gate ran BEFORE the adapter call and its refreshed pair
      // (not the stale decrypted pair) reached the provider — the exact
      // "reconnect with the newly refreshed token" requirement.
      expect(lifecycle.ensureFreshTokens).toHaveBeenCalledTimes(1);
      expect(mockAdapter.connect).toHaveBeenCalledTimes(1);
      const passedCredentials = mockAdapter.connect.mock.calls[0][0];
      expect(passedCredentials).toBe(refreshedCredentials);
      // Both plaintext copies are zeroed in the finally block.
      expect(refreshedCredentials.apiKey).toBeNull();
    });

    // ─── Sprint 56 / Task 48-D — the connect-time demoValidated auto-write ────
    // This is the WEAK connect-implies-validated proxy: connectBroker
    // dual-writes demoValidated: true when a DEMO connection reaches
    // CONNECTED. BrokerDemoValidationService (the evidence-based
    // re-validation service) builds ON TOP of it — PASS confirms the proxy,
    // FAIL revokes it — so its behavior is pinned here.

    it('dual-writes demoValidated: true on a successful DEMO connect (connect-implies-validated proxy)', async () => {
      const mockAdapter = {
        setMode: jest.fn(),
        connect: jest.fn().mockResolvedValue({
          success: true,
          accountId: '123456',
          accountType: BrokerMode.DEMO,
          currency: 'USD',
          serverTime: new Date(),
        }),
      };
      registry.getAdapter.mockReturnValue(mockAdapter);

      const mockConn = {
        id: 'conn-1',
        userId: 'user-1',
        brokerId: 'metatrader5',
        accountType: BrokerMode.DEMO,
        demoValidated: false,
        encryptedCredentials: 'ciphertext',
        credentialIv: 'iv',
        credentialTag: 'tag',
        encryptionKeyId: 'env-key-v1',
        authorizationStatus: BrokerAuthorizationStatus.NOT_CONNECTED,
        credentialStatus: 'CREATED',
        consecutiveFailureCount: 0,
      };
      connectionRepo.findOne
        .mockResolvedValueOnce(mockConn)
        .mockResolvedValueOnce({ ...mockConn, status: BrokerConnectionStatus.CONNECTED });
      connectionRepo.update.mockResolvedValue({ affected: 1 });
      accountRepo.findOne.mockResolvedValue(null);
      accountRepo.create.mockReturnValue({});
      accountRepo.save.mockResolvedValue({});

      await service.connectBroker('conn-1', 'user-1');

      const connectedPatch = connectionRepo.update.mock.calls
        .map((call) => call[1])
        .find((patch) => patch.status === BrokerConnectionStatus.CONNECTED);
      expect(connectedPatch).toBeDefined();
      // The weak proxy write rides inside the CONNECTED transition (DEMO only).
      expect(connectedPatch).toMatchObject({
        demoValidated: true,
        credentialStatus: 'VERIFIED',
      });
    });

    it('does NOT write demoValidated for LIVE connections (the proxy is DEMO-only)', async () => {
      const mockAdapter = {
        setMode: jest.fn(),
        connect: jest.fn().mockResolvedValue({
          success: true,
          accountId: '123456',
          accountType: BrokerMode.LIVE,
          currency: 'USD',
          serverTime: new Date(),
        }),
      };
      registry.getAdapter.mockReturnValue(mockAdapter);

      const mockConn = {
        id: 'conn-live',
        userId: 'user-1',
        brokerId: 'metatrader5',
        accountType: BrokerMode.LIVE,
        encryptedCredentials: 'ciphertext',
        credentialIv: 'iv',
        credentialTag: 'tag',
        encryptionKeyId: 'env-key-v1',
        authorizationStatus: BrokerAuthorizationStatus.NOT_CONNECTED,
        credentialStatus: 'CREATED',
        consecutiveFailureCount: 0,
      };
      connectionRepo.findOne
        .mockResolvedValueOnce(mockConn)
        .mockResolvedValueOnce({ ...mockConn, status: BrokerConnectionStatus.CONNECTED });
      connectionRepo.update.mockResolvedValue({ affected: 1 });
      accountRepo.findOne.mockResolvedValue(null);
      accountRepo.create.mockReturnValue({});
      accountRepo.save.mockResolvedValue({});

      await service.connectBroker('conn-live', 'user-1');

      const connectedPatch = connectionRepo.update.mock.calls
        .map((call) => call[1])
        .find((patch) => patch.status === BrokerConnectionStatus.CONNECTED);
      expect(connectedPatch).toBeDefined();
      // LIVE connects never touch demoValidated — evidence-based validation
      // is a DEMO-only concept (enableLiveTrading checks the DEMO flag).
      expect('demoValidated' in connectedPatch).toBe(false);
    });

    // ─── Round 7 (P0): declared-vs-observed environment enforcement ─────────

    it('P0: a provider-reported environment that CONTRADICTS the declared type fails CLOSED (ERROR, no authorization advance, CRITICAL audit)', async () => {
      // A LIVE MetaApi account declared as DEMO — the exact real-money
      // mislabeling that previously sailed to AUTHORIZED + demoValidated.
      const mockAdapter = {
        setMode: jest.fn(),
        connect: jest.fn().mockResolvedValue({
          success: true,
          accountId: '123456',
          accountType: BrokerMode.LIVE, // provider TRUTH
          currency: 'USD',
          serverTime: new Date(),
        }),
      };
      registry.getAdapter.mockReturnValue(mockAdapter);

      const mockConn = {
        id: 'conn-1',
        userId: 'user-1',
        brokerId: 'metatrader5',
        accountType: BrokerMode.DEMO, // declared LIE
        encryptedCredentials: 'ciphertext',
        credentialIv: 'iv',
        credentialTag: 'tag',
        encryptionKeyId: 'env-key-v1',
        authorizationStatus: BrokerAuthorizationStatus.NOT_CONNECTED,
        credentialStatus: 'CREATED',
        consecutiveFailureCount: 0,
      };
      connectionRepo.findOne.mockResolvedValue(mockConn);
      connectionRepo.update.mockResolvedValue({ affected: 1 });

      await expect(service.connectBroker('conn-1', 'user-1')).rejects.toThrow(
        'Environment mismatch',
      );

      // Fail-closed: an ERROR transition is written; NO CONNECTED/AUTHORIZED
      // transition, NO demoValidated proxy, NO credential VERIFIED write.
      const patches = connectionRepo.update.mock.calls.map((call) => call[1]);
      const errorPatch = patches.find((patch) => patch.status === BrokerConnectionStatus.ERROR);
      expect(errorPatch).toBeDefined();
      expect(errorPatch.lastErrorMessage).toContain('Environment mismatch');
      expect(
        patches.find((patch) => patch.status === BrokerConnectionStatus.CONNECTED),
      ).toBeUndefined();
      expect(patches.some((patch) => patch.demoValidated === true)).toBe(false);
      expect(patches.some((patch) => patch.credentialStatus === 'VERIFIED')).toBe(false);

      // CRITICAL audit with the typed machine code.
      const auditCall = (auditService.log as jest.Mock).mock.calls.find(
        (call) => call[0]?.action === 'BROKER_CONNECT_FAILED',
      );
      expect(auditCall).toBeDefined();
      expect(auditCall[0].metadata).toMatchObject({
        failureCode: 'ACCOUNT_TYPE_MISMATCH',
        declaredAccountType: BrokerMode.DEMO,
        providerObservedAccountType: BrokerMode.LIVE,
      });
    });

    it('P0: a matching provider-reported environment connects normally (no false positives)', async () => {
      const mockAdapter = {
        setMode: jest.fn(),
        connect: jest.fn().mockResolvedValue({
          success: true,
          accountId: '123456',
          accountType: BrokerMode.DEMO, // matches the declaration
          currency: 'USD',
          serverTime: new Date(),
        }),
      };
      registry.getAdapter.mockReturnValue(mockAdapter);

      const mockConn = {
        id: 'conn-1',
        userId: 'user-1',
        brokerId: 'metatrader5',
        accountType: BrokerMode.DEMO,
        demoValidated: false,
        encryptedCredentials: 'ciphertext',
        credentialIv: 'iv',
        credentialTag: 'tag',
        encryptionKeyId: 'env-key-v1',
        authorizationStatus: BrokerAuthorizationStatus.NOT_CONNECTED,
        credentialStatus: 'CREATED',
        consecutiveFailureCount: 0,
      };
      connectionRepo.findOne
        .mockResolvedValueOnce(mockConn)
        .mockResolvedValueOnce({ ...mockConn, status: BrokerConnectionStatus.CONNECTED });
      connectionRepo.update.mockResolvedValue({ affected: 1 });
      accountRepo.findOne.mockResolvedValue(null);
      accountRepo.create.mockReturnValue({});
      accountRepo.save.mockResolvedValue({});

      await expect(service.connectBroker('conn-1', 'user-1')).resolves.toBeDefined();
      const patches = connectionRepo.update.mock.calls.map((call) => call[1]);
      expect(
        patches.find((patch) => patch.status === BrokerConnectionStatus.ERROR),
      ).toBeUndefined();
    });
  });

  // ─── enableLiveTrading ────────────────────────────────────────────────────

  describe('enableLiveTrading()', () => {
    it('throws ForbiddenException if DEMO has not been validated', async () => {
      connectionRepo.findOne
        .mockResolvedValueOnce({
          id: 'conn-live',
          userId: 'user-1',
          accountType: BrokerMode.LIVE,
          brokerId: 'metatrader5',
          authorizationStatus: BrokerAuthorizationStatus.CONNECTED,
        })
        .mockResolvedValueOnce(null);

      await expect(service.enableLiveTrading('conn-live', 'user-1')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('enables live trading when DEMO is validated', async () => {
      connectionRepo.findOne
        .mockResolvedValueOnce({
          id: 'conn-live',
          userId: 'user-1',
          accountType: BrokerMode.LIVE,
          brokerId: 'metatrader5',
          authorizationStatus: BrokerAuthorizationStatus.CONNECTED,
        })
        .mockResolvedValueOnce({
          id: 'conn-demo',
          userId: 'user-1',
          accountType: BrokerMode.DEMO,
          demoValidated: true,
        });
      // A4: repository.update must resolve an UpdateResult with affected > 0
      // and the transition criteria now pins the expected authorization state.
      connectionRepo.update.mockResolvedValue({ affected: 1 });

      await expect(service.enableLiveTrading('conn-live', 'user-1')).resolves.not.toThrow();
      // Sprint 50: dual-write — legacy boolean + authoritative state machine
      expect(connectionRepo.update).toHaveBeenCalledWith(
        { id: 'conn-live', authorizationStatus: BrokerAuthorizationStatus.CONNECTED },
        {
          liveTradingEnabled: true,
          authorizationStatus: BrokerAuthorizationStatus.ACTIVE,
          authorizedAt: expect.any(Date),
          authorizationRevokedAt: null,
        },
      );
    });

    it('rejects state-machine-invalid transitions with ConflictException (Sprint 50)', async () => {
      // A connection still NOT_CONNECTED can never jump straight to ACTIVE
      connectionRepo.findOne.mockResolvedValueOnce({
        id: 'conn-live',
        userId: 'user-1',
        accountType: BrokerMode.LIVE,
        brokerId: 'metatrader5',
        authorizationStatus: BrokerAuthorizationStatus.NOT_CONNECTED,
      });

      await expect(service.enableLiveTrading('conn-live', 'user-1')).rejects.toThrow(
        ConflictException,
      );
    });
  });

  // ─── healthCheck ─────────────────────────────────────────────────────────

  describe('healthCheck()', () => {
    /** Standard healthy adapter — connect + getAccountBalance both succeed. */
    const healthyAdapter = () => ({
      setMode: jest.fn(),
      // Round 7: BrokerConnectionResult contract — the observed environment
      // must be reported (matches the declared DEMO connection fixture).
      connect: jest.fn().mockResolvedValue({ success: true, accountType: BrokerMode.DEMO }),
      getAccountBalance: jest.fn().mockResolvedValue({
        balance: '10000.00',
        equity: '10000.00',
        currency: 'USD',
        timestamp: new Date(),
      }),
    });

    /** Failing adapter — connect succeeds but getAccountBalance throws. */
    const failingAdapter = (error = 'connection timeout') => ({
      setMode: jest.fn(),
      connect: jest.fn().mockResolvedValue({ success: true, accountType: BrokerMode.DEMO }),
      getAccountBalance: jest.fn().mockRejectedValue(new Error(error)),
    });

    it('returns false when connection is not CONNECTED status', async () => {
      connectionRepo.findOne.mockResolvedValue({
        id: 'conn-1',
        status: BrokerConnectionStatus.DISCONNECTED,
      });
      expect(await service.healthCheck('conn-1')).toBe(false);
    });

    it('returns false when connection is not found', async () => {
      connectionRepo.findOne.mockResolvedValue(null);
      expect(await service.healthCheck('conn-1')).toBe(false);
    });

    it('returns true and resets failure count on successful health check', async () => {
      const adapter = healthyAdapter();
      registry.getAdapter.mockReturnValue(adapter);
      connectionRepo.findOne.mockResolvedValue(connectedConnection({ consecutiveFailureCount: 1 }));

      const result = await service.healthCheck('conn-1');

      expect(result).toBe(true);
      expect(connectionRepo.update).toHaveBeenCalledWith(
        'conn-1',
        expect.objectContaining({ consecutiveFailureCount: 0, lastErrorMessage: null }),
      );
      // Status must NOT be set to SUSPENDED on success
      const updateCall = (connectionRepo.update as jest.Mock).mock.calls[0][1];
      expect(updateCall.status).toBeUndefined();
    });

    it('1st failure: increments failureCount to 1 — does NOT suspend', async () => {
      // suppress expected logger.error output
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
      const adapter = failingAdapter();
      registry.getAdapter.mockReturnValue(adapter);
      connectionRepo.findOne.mockResolvedValue(connectedConnection({ consecutiveFailureCount: 0 }));

      const result = await service.healthCheck('conn-1');

      expect(result).toBe(false);
      const updateCall = (connectionRepo.update as jest.Mock).mock.calls[0][1];
      expect(updateCall.consecutiveFailureCount).toBe(1);
      expect(updateCall.status).toBeUndefined(); // not yet suspended
    });

    it('2nd failure: increments failureCount to 2 — does NOT suspend', async () => {
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
      const adapter = failingAdapter();
      registry.getAdapter.mockReturnValue(adapter);
      connectionRepo.findOne.mockResolvedValue(connectedConnection({ consecutiveFailureCount: 1 }));

      const result = await service.healthCheck('conn-1');

      expect(result).toBe(false);
      const updateCall = (connectionRepo.update as jest.Mock).mock.calls[0][1];
      expect(updateCall.consecutiveFailureCount).toBe(2);
      expect(updateCall.status).toBeUndefined();
    });

    it('3rd consecutive failure: suspends the connection and writes audit event', async () => {
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
      const adapter = failingAdapter('connection timeout');
      registry.getAdapter.mockReturnValue(adapter);
      connectionRepo.findOne.mockResolvedValue(connectedConnection({ consecutiveFailureCount: 2 }));

      const result = await service.healthCheck('conn-1');

      expect(result).toBe(false);
      // A4: the SUSPENDED transition is a guarded conditional write — the
      // criteria pins the expected authorization state (ACTIVE here).
      expect(connectionRepo.update).toHaveBeenCalledWith(
        { id: 'conn-1', authorizationStatus: BrokerAuthorizationStatus.ACTIVE },
        expect.objectContaining({ status: BrokerConnectionStatus.SUSPENDED }),
      );
      // Must write a CRITICAL audit event
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({ severity: 'CRITICAL' }),
      );
    });

    // ─── Round 7 (P0): environment mismatch at the health check ─────────────

    it('P0: a provider environment mismatch observed at health check suspends IMMEDIATELY (first occurrence, CRITICAL) and invalidates broker authority', async () => {
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
      // The connection is declared DEMO but the provider now reports LIVE
      // (broker-side migration/relabel) — a security event, not a blip.
      const adapter = {
        setMode: jest.fn(),
        connect: jest.fn().mockResolvedValue({ success: true, accountType: BrokerMode.LIVE }),
        getAccountBalance: jest.fn(),
      };
      registry.getAdapter.mockReturnValue(adapter);
      connectionRepo.findOne.mockResolvedValue(connectedConnection({ consecutiveFailureCount: 0 }));
      connectionRepo.update.mockResolvedValue({ affected: 1 });

      const result = await service.healthCheck('conn-1');

      expect(result).toBe(false);
      // Immediate guarded SUSPENDED transition (NOT the 3-failure path —
      // this ran with consecutiveFailureCount 0).
      expect(connectionRepo.update).toHaveBeenCalledWith(
        { id: 'conn-1', authorizationStatus: BrokerAuthorizationStatus.ACTIVE },
        expect.objectContaining({
          status: BrokerConnectionStatus.SUSPENDED,
          lastErrorMessage: expect.stringContaining('Environment mismatch'),
        }),
      );
      // CRITICAL audit with the typed machine code.
      const auditCall = (auditService.log as jest.Mock).mock.calls.find(
        (call) => call[0]?.metadata?.failureCode === 'ACCOUNT_TYPE_MISMATCH',
      );
      expect(auditCall).toBeDefined();
      expect(auditCall[0].severity).toBe('CRITICAL');
      expect(auditCall[0].metadata).toMatchObject({
        declaredAccountType: BrokerMode.DEMO,
        providerObservedAccountType: BrokerMode.LIVE,
      });
    });

    it('health check exception does not propagate — returns false safely', async () => {
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
      // Adapter connect itself throws (not just getAccountBalance)
      const adapter = {
        setMode: jest.fn(),
        connect: jest.fn().mockRejectedValue(new Error('MetaAPI SDK unavailable')),
        getAccountBalance: jest.fn(),
      };
      registry.getAdapter.mockReturnValue(adapter);
      connectionRepo.findOne.mockResolvedValue(connectedConnection());

      // Must not throw — must return false
      await expect(service.healthCheck('conn-1')).resolves.toBe(false);
      expect(connectionRepo.update).toHaveBeenCalled();
    });

    it('suspended connection is rejected by hasActiveConnection()', async () => {
      // A SUSPENDED connection should not be returned as "active"
      connectionRepo.findOne.mockResolvedValue(null); // no CONNECTED connection
      expect(await service.hasActiveConnection('user-1')).toBe(false);
    });
  });

  // ─── Round 6 live-execution completion (§1a): snapshot-authority routing ──

  describe('getBrokerAccountState() — authoritative snapshot routing', () => {
    it('serves the latest ACCEPTED snapshot (by generation) when one exists', async () => {
      snapshotService.readLatestAcceptedSnapshot.mockResolvedValue({
        connectionId: 'conn-1',
        generation: 7,
        balance: '1500.25',
        equity: '1512.50',
        freeMargin: '800.00',
        currency: 'EUR',
      });

      await expect(service.getBrokerAccountState('conn-1')).resolves.toEqual({
        balance: '1500.25',
        equity: '1512.50',
        freeMargin: '800.00',
        currency: 'EUR',
      });
      // The legacy row is NOT consulted when the snapshot authority exists.
      expect(accountRepo.findOne).not.toHaveBeenCalled();
    });

    it('returns null for a PARTIAL snapshot (missing freeMargin) — no zero/USD substitution', async () => {
      snapshotService.readLatestAcceptedSnapshot.mockResolvedValue({
        connectionId: 'conn-1',
        generation: 2,
        balance: '100.00',
        equity: '101.00',
        freeMargin: null,
        currency: 'USD',
      });

      await expect(service.getBrokerAccountState('conn-1')).resolves.toBeNull();
      expect(accountRepo.findOne).not.toHaveBeenCalled();
    });

    it('returns null for a snapshot with unknown currency — never a synthetic USD', async () => {
      snapshotService.readLatestAcceptedSnapshot.mockResolvedValue({
        connectionId: 'conn-1',
        generation: 3,
        balance: '100.00',
        equity: '101.00',
        freeMargin: '50.00',
        currency: null,
      });

      await expect(service.getBrokerAccountState('conn-1')).resolves.toBeNull();
    });

    it('falls back to the legacy current-view when NO snapshot exists (currency known)', async () => {
      snapshotService.readLatestAcceptedSnapshot.mockResolvedValue(null);
      accountRepo.findOne.mockResolvedValue({
        brokerConnectionId: 'conn-1',
        balance: '200.00',
        equity: '205.00',
        freeMargin: '100.00',
        currency: 'USD',
      });

      await expect(service.getBrokerAccountState('conn-1')).resolves.toEqual({
        balance: '200.00',
        equity: '205.00',
        freeMargin: '100.00',
        currency: 'USD',
      });
    });

    it('falls back to legacy and returns null when the legacy currency is unknown (NO USD fabrication)', async () => {
      snapshotService.readLatestAcceptedSnapshot.mockResolvedValue(null);
      accountRepo.findOne.mockResolvedValue({
        brokerConnectionId: 'conn-1',
        balance: '200.00',
        equity: '205.00',
        freeMargin: '100.00',
        currency: null,
      });

      await expect(service.getBrokerAccountState('conn-1')).resolves.toBeNull();
    });

    it('returns null when neither snapshot nor legacy row exists', async () => {
      snapshotService.readLatestAcceptedSnapshot.mockResolvedValue(null);
      accountRepo.findOne.mockResolvedValue(null);

      await expect(service.getBrokerAccountState('conn-1')).resolves.toBeNull();
    });
  });

  describe('connectBroker() — initial authoritative snapshot (§1a)', () => {
    it('accepts the first full provider account observation as snapshot generation 1', async () => {
      const serverTime = new Date('2026-09-15T12:00:00Z');
      const mockAdapter = {
        setMode: jest.fn(),
        connect: jest.fn().mockResolvedValue({
          success: true,
          accountId: '123456',
          accountType: BrokerMode.DEMO,
          currency: 'USD',
          serverTime,
        }),
        getAccountInfo: jest.fn().mockResolvedValue({
          accountId: '123456',
          currency: 'USD',
          leverage: 30,
          balance: '10000.00',
          equity: '10050.00',
          margin: '0.00',
          freeMargin: '10050.00',
          marginLevel: '0',
        }),
      };
      registry.getAdapter.mockReturnValue(mockAdapter);

      const mockConn = {
        id: 'conn-1',
        userId: 'user-1',
        brokerId: 'metatrader5',
        accountType: BrokerMode.DEMO,
        encryptedCredentials: 'ciphertext',
        credentialIv: 'iv',
        credentialTag: 'tag',
        encryptionKeyId: 'env-key-v1',
        authorizationStatus: BrokerAuthorizationStatus.NOT_CONNECTED,
        credentialStatus: 'VERIFIED',
        consecutiveFailureCount: 0,
        accountId: '123456',
      };
      connectionRepo.findOne
        .mockResolvedValueOnce(mockConn)
        .mockResolvedValueOnce({ ...mockConn, status: BrokerConnectionStatus.CONNECTED });
      connectionRepo.update.mockResolvedValue({ affected: 1 });
      accountRepo.findOne.mockResolvedValue(null);

      await service.connectBroker('conn-1', 'user-1');

      expect(mockAdapter.getAccountInfo).toHaveBeenCalledTimes(1);
      expect(snapshotService.acceptSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({
          connectionId: 'conn-1',
          balance: '10000.00',
          equity: '10050.00',
          freeMargin: '10050.00',
          currency: 'USD',
          providerObservedAt: serverTime,
          providerAccountIdentity: '123456',
          source: 'connect',
        }),
      );
      expect(snapshotService.projectToLegacyAccount).toHaveBeenCalledTimes(1);
    });

    it('survives a snapshot-authority failure — the successful connect is NOT rolled back', async () => {
      const mockAdapter = {
        setMode: jest.fn(),
        connect: jest.fn().mockResolvedValue({
          success: true,
          accountId: '123456',
          accountType: BrokerMode.DEMO,
          currency: 'USD',
          serverTime: new Date(),
        }),
        getAccountInfo: jest.fn().mockRejectedValue(new Error('provider account info down')),
      };
      registry.getAdapter.mockReturnValue(mockAdapter);

      const mockConn = {
        id: 'conn-1',
        userId: 'user-1',
        brokerId: 'metatrader5',
        accountType: BrokerMode.DEMO,
        encryptedCredentials: 'ciphertext',
        credentialIv: 'iv',
        credentialTag: 'tag',
        encryptionKeyId: 'env-key-v1',
        authorizationStatus: BrokerAuthorizationStatus.NOT_CONNECTED,
        credentialStatus: 'VERIFIED',
        consecutiveFailureCount: 0,
      };
      connectionRepo.findOne
        .mockResolvedValueOnce(mockConn)
        .mockResolvedValueOnce({ ...mockConn, status: BrokerConnectionStatus.CONNECTED });
      connectionRepo.update.mockResolvedValue({ affected: 1 });
      accountRepo.findOne.mockResolvedValue(null);

      await expect(service.connectBroker('conn-1', 'user-1')).resolves.toBeDefined();
      expect(snapshotService.acceptSnapshot).not.toHaveBeenCalled();
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: AuditAction.BROKER_CONNECTED }),
      );
    });
  });

  describe('getInstrumentSpecForConnection() — the contract-size seam (§1a/§4/§18)', () => {
    const connectedConn = {
      id: 'conn-1',
      userId: 'user-1',
      brokerId: 'metatrader5',
      status: BrokerConnectionStatus.CONNECTED,
      accountType: BrokerMode.LIVE,
      credentialStatus: 'VERIFIED',
      encryptedCredentials: 'ciphertext',
      credentialIv: 'iv',
      credentialTag: 'tag',
      encryptionKeyId: 'env-key-v1',
    };

    const specFixture = {
      symbol: 'EURUSD',
      description: 'Euro vs US Dollar',
      digits: 5,
      minLot: '0.01',
      maxLot: '100',
      lotStep: '0.01',
      contractSize: '100000',
    };

    it('resolves the normalized instrument spec through the adapter (canonical symbol)', async () => {
      connectionRepo.findOne.mockResolvedValue(connectedConn);
      const adapter = {
        setMode: jest.fn(),
        connect: jest.fn().mockResolvedValue(undefined),
        getInstrumentList: jest
          .fn()
          .mockResolvedValue([specFixture, { ...specFixture, symbol: 'GBPUSD' }]),
      };
      registry.getAdapterForConnection.mockReturnValue(adapter);
      encryption.decrypt.mockReturnValue({ accountId: 'acc-1' });

      await expect(
        service.getInstrumentSpecForConnection('user-1', 'conn-1', 'EURUSD'),
      ).resolves.toEqual(specFixture);

      expect(adapter.getInstrumentList).toHaveBeenCalledTimes(1);
    });

    it('caches the spec in-process — a second resolution within the TTL does not hit the adapter', async () => {
      connectionRepo.findOne.mockResolvedValue(connectedConn);
      const adapter = {
        setMode: jest.fn(),
        connect: jest.fn().mockResolvedValue(undefined),
        getInstrumentList: jest.fn().mockResolvedValue([specFixture]),
      };
      registry.getAdapterForConnection.mockReturnValue(adapter);
      encryption.decrypt.mockReturnValue({ accountId: 'acc-1' });

      await service.getInstrumentSpecForConnection('user-1', 'conn-1', 'EURUSD');
      await service.getInstrumentSpecForConnection('user-1', 'conn-1', 'EURUSD');

      expect(adapter.getInstrumentList).toHaveBeenCalledTimes(1);
    });

    it('returns null for an instrument the connection cannot trade (unknown symbol mapping)', async () => {
      connectionRepo.findOne.mockResolvedValue(connectedConn);
      const adapter = {
        setMode: jest.fn(),
        connect: jest.fn().mockResolvedValue(undefined),
        getInstrumentList: jest.fn().mockResolvedValue([specFixture]),
      };
      registry.getAdapterForConnection.mockReturnValue(adapter);
      encryption.decrypt.mockReturnValue({ accountId: 'acc-1' });

      await expect(
        service.getInstrumentSpecForConnection('user-1', 'conn-1', 'XAUUSD'),
      ).resolves.toBeNull();
    });

    it('returns null (typed) when the adapter fails — never an invented spec', async () => {
      connectionRepo.findOne.mockResolvedValue(connectedConn);
      const adapter = {
        setMode: jest.fn(),
        connect: jest.fn().mockRejectedValue(new Error('provider down')),
        getInstrumentList: jest.fn(),
      };
      registry.getAdapterForConnection.mockReturnValue(adapter);
      encryption.decrypt.mockReturnValue({ accountId: 'acc-1' });

      await expect(
        service.getInstrumentSpecForConnection('user-1', 'conn-1', 'EURUSD'),
      ).resolves.toBeNull();
      expect(adapter.getInstrumentList).not.toHaveBeenCalled();
    });

    it('fails closed for a non-CONNECTED connection — the adapter is never contacted', async () => {
      connectionRepo.findOne.mockResolvedValue({
        ...connectedConn,
        status: BrokerConnectionStatus.SUSPENDED,
      });

      await expect(
        service.getInstrumentSpecForConnection('user-1', 'conn-1', 'EURUSD'),
      ).rejects.toThrow('not active');
      expect(registry.getAdapterForConnection).not.toHaveBeenCalled();
    });
  });

  describe('getCurrentPriceForConnection() — the fresh-quote seam (§5/§18 market safety)', () => {
    const connectedConn = {
      id: 'conn-1',
      userId: 'user-1',
      brokerId: 'metatrader5',
      status: BrokerConnectionStatus.CONNECTED,
      accountType: BrokerMode.LIVE,
      credentialStatus: 'VERIFIED',
      encryptedCredentials: 'ciphertext',
      credentialIv: 'iv',
      credentialTag: 'tag',
      encryptionKeyId: 'env-key-v1',
    };

    const priceFixture = {
      instrument: 'EURUSD',
      bid: '1.08490',
      ask: '1.08510',
      spread: '0.00020',
      timestamp: new Date('2025-09-15T10:00:00Z'),
    };

    it('resolves ONE fresh provider quote through the connection (never cached)', async () => {
      connectionRepo.findOne.mockResolvedValue(connectedConn);
      const adapter = {
        setMode: jest.fn(),
        connect: jest.fn().mockResolvedValue(undefined),
        getCurrentPrice: jest.fn().mockResolvedValue(priceFixture),
      };
      registry.getAdapterForConnection.mockReturnValue(adapter);
      encryption.decrypt.mockReturnValue({ accountId: 'acc-1' });

      await expect(
        service.getCurrentPriceForConnection('user-1', 'conn-1', 'EURUSD'),
      ).resolves.toEqual(priceFixture);
      expect(adapter.getCurrentPrice).toHaveBeenCalledTimes(1);
    });

    it('rejects a non-active connection (tenant + lifecycle gated)', async () => {
      connectionRepo.findOne.mockResolvedValue({
        ...connectedConn,
        status: BrokerConnectionStatus.DISCONNECTED,
      });
      await expect(
        service.getCurrentPriceForConnection('user-1', 'conn-1', 'EURUSD'),
      ).rejects.toThrow();
    });

    it('returns null when the adapter cannot prove a quote — never an invented price (§18)', async () => {
      connectionRepo.findOne.mockResolvedValue(connectedConn);
      const adapter = {
        setMode: jest.fn(),
        connect: jest.fn().mockResolvedValue(undefined),
        getCurrentPrice: jest.fn().mockRejectedValue(new Error('market data down')),
      };
      registry.getAdapterForConnection.mockReturnValue(adapter);
      encryption.decrypt.mockReturnValue({ accountId: 'acc-1' });

      await expect(
        service.getCurrentPriceForConnection('user-1', 'conn-1', 'EURUSD'),
      ).resolves.toBeNull();
    });

    it('returns null for a quote with an unparseable timestamp (unprovable is unprovable)', async () => {
      connectionRepo.findOne.mockResolvedValue(connectedConn);
      const adapter = {
        setMode: jest.fn(),
        connect: jest.fn().mockResolvedValue(undefined),
        getCurrentPrice: jest.fn().mockResolvedValue({ ...priceFixture, timestamp: 'garbage' }),
      };
      registry.getAdapterForConnection.mockReturnValue(adapter);
      encryption.decrypt.mockReturnValue({ accountId: 'acc-1' });

      await expect(
        service.getCurrentPriceForConnection('user-1', 'conn-1', 'EURUSD'),
      ).resolves.toBeNull();
    });
  });
});
