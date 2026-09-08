import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { BrokerService } from '../broker.service';
import { BrokerConnection } from '../entities/broker-connection.entity';
import { BrokerAccount } from '../entities/broker-account.entity';
import { BrokerAdapterRegistry } from '../adapters/broker-adapter.registry';
import { BrokerProviderRegistryService } from '../registry/broker-provider-registry.service';
import { CredentialEncryptionService } from '../services/credential-encryption.service';
import { AuditService } from '../../audit/audit.service';
import { DomainEventBus } from '../../events/event-bus.service';
import { BrokerAuthorizationStatus } from '../authorization/broker-authorization-status';
import { BrokerCredentialStatus } from '../authorization/broker-credential-status';
import { BrokerConnectionStatus, BrokerMode } from '../interfaces/broker-adapter.interface';

/**
 * Sprint 50 — BrokerService authorization lifecycle integration tests.
 *
 * Directive §15 (explicit authorization state machine), §14 (credential
 * lifecycle), §16 (DEMO/PAPER/LIVE isolation — a demo account must never
 * reach live execution infrastructure), §37 (credentials never returned).
 */

const mockAdapter = (over: Record<string, unknown> = {}) => ({
  brokerId: 'metatrader5',
  brokerName: 'MetaTrader 5 (via MetaAPI)',
  supportsDemo: true,
  setMode: jest.fn(),
  connect: jest.fn(),
  disconnect: jest.fn(),
  testConnection: jest.fn(),
  ...over,
});

const baseConnection = (over: Partial<Record<string, unknown>> = {}) => ({
  id: 'conn-1',
  userId: 'user-1',
  brokerId: 'metatrader5',
  brokerName: 'MetaTrader 5 (via MetaAPI)',
  accountType: BrokerMode.LIVE,
  status: BrokerConnectionStatus.DISCONNECTED,
  authorizationStatus: BrokerAuthorizationStatus.NOT_CONNECTED,
  credentialStatus: BrokerCredentialStatus.CREATED,
  demoValidated: false,
  liveTradingEnabled: false,
  encryptedCredentials: 'cipher',
  credentialIv: 'iv',
  credentialTag: 'tag',
  encryptionKeyId: 'env-key-v1',
  consecutiveFailureCount: 0,
  ...over,
});

describe('BrokerService — Sprint 50 authorization lifecycle', () => {
  let service: BrokerService;
  let connectionRepo: {
    findOne: jest.Mock;
    find: jest.Mock;
    update: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    softDelete: jest.Mock;
  };
  let accountRepo: { findOne: jest.Mock; create: jest.Mock; save: jest.Mock; update: jest.Mock };
  let adapter: ReturnType<typeof mockAdapter>;
  let providerRegistry: {
    supportsEnvironment: jest.Mock;
    isConnectable: jest.Mock;
    isProductionLiveEligible: jest.Mock;
  };
  let encryption: { encrypt: jest.Mock; decrypt: jest.Mock };
  let audit: { log: jest.Mock };
  let eventBus: { publish: jest.Mock };

  beforeEach(async () => {
    adapter = mockAdapter();
    connectionRepo = {
      findOne: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      create: jest.fn().mockImplementation((o) => o),
      save: jest.fn().mockImplementation(async (o) => ({ ...o, id: 'saved-1' })),
      softDelete: jest.fn(),
    };
    accountRepo = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation((o) => o),
      save: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    providerRegistry = {
      supportsEnvironment: jest.fn().mockReturnValue(true),
      isConnectable: jest.fn().mockReturnValue(true),
      // Phase H: fixtures use metatrader5 (the one VERIFIED provider) —
      // default true mirrors the real registry for that broker. Tests that
      // simulate an UNVERIFIED provider (e.g. oanda BETA) override this.
      isProductionLiveEligible: jest.fn().mockReturnValue(true),
    };
    encryption = {
      encrypt: jest.fn().mockReturnValue({ ciphertext: 'c1', iv: 'i1', tag: 't1', keyId: 'k1' }),
      decrypt: jest.fn().mockReturnValue({ apiKey: 'k', accountId: '123' }),
    };
    audit = { log: jest.fn().mockResolvedValue(undefined) };
    eventBus = { publish: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BrokerService,
        { provide: getRepositoryToken(BrokerConnection), useValue: connectionRepo },
        { provide: getRepositoryToken(BrokerAccount), useValue: accountRepo },
        {
          provide: BrokerAdapterRegistry,
          useValue: {
            getAdapter: jest.fn().mockReturnValue(adapter),
            isSupported: jest.fn().mockReturnValue(true),
          },
        },
        { provide: BrokerProviderRegistryService, useValue: providerRegistry },
        { provide: CredentialEncryptionService, useValue: encryption },
        { provide: AuditService, useValue: audit },
        { provide: DomainEventBus, useValue: eventBus },
      ],
    }).compile();

    service = module.get(BrokerService);
  });

  describe('connectBroker() — state machine + credential advancement', () => {
    it('DEMO connect success → AUTHORIZED + demoValidated dual-write + VERIFIED credentials', async () => {
      connectionRepo.findOne
        .mockResolvedValueOnce(baseConnection({ accountType: BrokerMode.DEMO }))
        .mockResolvedValue(baseConnection());
      adapter.connect.mockResolvedValue({
        success: true,
        accountId: '123',
        accountType: BrokerMode.DEMO,
        currency: 'USD',
        serverTime: new Date(),
      });

      await service.connectBroker('conn-1', 'user-1');

      const updateCall = connectionRepo.update.mock.calls.find(
        (c) => c[1].status === BrokerConnectionStatus.CONNECTED,
      );
      expect(updateCall).toBeDefined();
      expect(updateCall![1].authorizationStatus).toBe(BrokerAuthorizationStatus.AUTHORIZED);
      expect(updateCall![1].credentialStatus).toBe(BrokerCredentialStatus.VERIFIED);
      expect(updateCall![1].demoValidated).toBe(true);
    });

    it('LIVE connect success → CONNECTED (NOT ACTIVE — explicit authorization still required)', async () => {
      connectionRepo.findOne
        .mockResolvedValueOnce(baseConnection())
        .mockResolvedValue(baseConnection());
      adapter.connect.mockResolvedValue({
        success: true,
        accountId: '123',
        accountType: BrokerMode.LIVE,
        currency: 'USD',
        serverTime: new Date(),
      });

      await service.connectBroker('conn-1', 'user-1');

      const updateCall = connectionRepo.update.mock.calls.find(
        (c) => c[1].status === BrokerConnectionStatus.CONNECTED,
      );
      expect(updateCall![1].authorizationStatus).toBe(BrokerAuthorizationStatus.CONNECTED);
      expect(updateCall![1].demoValidated).toBeUndefined();
    });

    it('connect failure → ERROR state + INVALID credentials on auth-class errors', async () => {
      connectionRepo.findOne
        .mockResolvedValueOnce(baseConnection())
        .mockResolvedValue(baseConnection());
      adapter.connect.mockResolvedValue({
        success: false,
        accountId: '',
        accountType: BrokerMode.LIVE,
        currency: '',
        serverTime: new Date(),
        error: 'AUTH_INVALID_TOKEN (401)',
      });

      await expect(service.connectBroker('conn-1', 'user-1')).rejects.toThrow(BadRequestException);

      const updateCall = connectionRepo.update.mock.calls.find(
        (c) => c[1].status === BrokerConnectionStatus.ERROR,
      );
      expect(updateCall).toBeDefined();
      expect(updateCall![1].authorizationStatus).toBe(BrokerAuthorizationStatus.ERROR);
      expect(updateCall![1].credentialStatus).toBe(BrokerCredentialStatus.INVALID);
    });
  });

  describe('createConnection() — environment registry gate (Directive §11)', () => {
    it('rejects LIVE when the provider does not support LIVE (fail closed)', async () => {
      providerRegistry.supportsEnvironment.mockReturnValue(false);

      await expect(
        service.createConnection(
          {
            brokerId: 'paper-broker',
            accountType: BrokerMode.LIVE,
            accountId: 'x',
          } as never,
          'user-1',
        ),
      ).rejects.toThrow(BadRequestException);
      expect(providerRegistry.supportsEnvironment).toHaveBeenCalledWith(
        'paper-broker',
        BrokerMode.LIVE,
      );
    });

    it('Phase H: rejects LIVE for a production-LIVE UNVERIFIED provider even though the adapter exists (fail closed)', async () => {
      // OANDA-shaped: supportsEnvironment(LIVE) is true (the catalog declares
      // LIVE environments) but productionLiveVerification is UNVERIFIED.
      providerRegistry.supportsEnvironment.mockReturnValue(true);
      providerRegistry.isProductionLiveEligible.mockReturnValue(false);

      await expect(
        service.createConnection(
          {
            brokerId: 'oanda',
            accountType: BrokerMode.LIVE,
            accountId: 'x',
          } as never,
          'user-1',
        ),
      ).rejects.toThrow(ForbiddenException);
      expect(providerRegistry.isProductionLiveEligible).toHaveBeenCalledWith('oanda');
      // Fail-closed before any persistence: nothing saved, nothing encrypted.
      expect(connectionRepo.save).not.toHaveBeenCalled();
      expect(connectionRepo.create).not.toHaveBeenCalled();
    });

    it('Phase H: the same UNVERIFIED provider remains DEMO-connectable (BETA is DEMO-only, not blocked)', async () => {
      providerRegistry.supportsEnvironment.mockReturnValue(true);
      providerRegistry.isProductionLiveEligible.mockReturnValue(false);

      await service.createConnection(
        { brokerId: 'oanda', accountType: BrokerMode.DEMO, accountId: '123' } as never,
        'user-1',
      );

      expect(connectionRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          brokerId: 'oanda',
          accountType: BrokerMode.DEMO,
          authorizationStatus: BrokerAuthorizationStatus.NOT_CONNECTED,
        }),
      );
      expect(connectionRepo.save).toHaveBeenCalledTimes(1);
    });

    it('initializes the state machine at NOT_CONNECTED / CREATED', async () => {
      await service.createConnection(
        { brokerId: 'metatrader5', accountType: BrokerMode.DEMO, accountId: '123' } as never,
        'user-1',
      );

      expect(connectionRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          authorizationStatus: BrokerAuthorizationStatus.NOT_CONNECTED,
          credentialStatus: BrokerCredentialStatus.CREATED,
        }),
      );
    });
  });

  describe('enableLiveTrading() — isolation gates (Directive §16)', () => {
    it('rejects when the provider lacks LIVE support even with demo validated', async () => {
      providerRegistry.supportsEnvironment.mockReturnValue(false);
      connectionRepo.findOne.mockResolvedValue(
        baseConnection({ authorizationStatus: BrokerAuthorizationStatus.CONNECTED }),
      );

      await expect(service.enableLiveTrading('conn-1', 'user-1')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('Phase H: rejects on a production-LIVE UNVERIFIED provider even with a validated DEMO (fail closed)', async () => {
      // OANDA-shaped: LIVE environment supported, DEMO validated, CONNECTED
      // LIVE connection — still rejected because production verification
      // evidence is absent.
      providerRegistry.supportsEnvironment.mockReturnValue(true);
      providerRegistry.isProductionLiveEligible.mockReturnValue(false);
      connectionRepo.findOne.mockResolvedValue(
        baseConnection({
          brokerId: 'oanda',
          authorizationStatus: BrokerAuthorizationStatus.CONNECTED,
        }),
      );

      await expect(service.enableLiveTrading('conn-1', 'user-1')).rejects.toThrow(
        ForbiddenException,
      );
      expect(providerRegistry.isProductionLiveEligible).toHaveBeenCalledWith('oanda');
      // Fail-closed BEFORE the state machine write and the demo lookup.
      expect(connectionRepo.update).not.toHaveBeenCalled();
    });

    it('rejects CONNECTED→ACTIVE transition when no DEMO was validated (unchanged invariant)', async () => {
      connectionRepo.findOne
        .mockResolvedValueOnce(
          baseConnection({ authorizationStatus: BrokerAuthorizationStatus.CONNECTED }),
        )
        .mockResolvedValueOnce(null); // no validated demo connection

      await expect(service.enableLiveTrading('conn-1', 'user-1')).rejects.toThrow(
        ForbiddenException,
      );
      expect(connectionRepo.update).not.toHaveBeenCalled();
    });
  });

  describe('revokeAuthorization() (Directive §15)', () => {
    it('transitions ACTIVE → REVOKED and fail-closes liveTradingEnabled', async () => {
      connectionRepo.findOne.mockResolvedValue(
        baseConnection({
          authorizationStatus: BrokerAuthorizationStatus.ACTIVE,
          liveTradingEnabled: true,
        }),
      );

      await service.revokeAuthorization('conn-1', 'user-1');

      // A4: the transition write is CONDITIONAL on the persisted state —
      // the criteria must pin the expected authorization status.
      expect(connectionRepo.update).toHaveBeenCalledWith(
        { id: 'conn-1', authorizationStatus: BrokerAuthorizationStatus.ACTIVE },
        expect.objectContaining({
          authorizationStatus: BrokerAuthorizationStatus.REVOKED,
          liveTradingEnabled: false,
          authorizationRevokedAt: expect.any(Date),
        }),
      );
      // Realtime event emitted so clients update immediately
      expect(eventBus.publish).toHaveBeenCalled();
    });

    it('rejects revocation from NOT_CONNECTED (invalid transition)', async () => {
      connectionRepo.findOne.mockResolvedValue(
        baseConnection({ authorizationStatus: BrokerAuthorizationStatus.NOT_CONNECTED }),
      );

      await expect(service.revokeAuthorization('conn-1', 'user-1')).rejects.toThrow(
        ConflictException,
      );
    });

    it('A4: stale revoke loses to a concurrent winner — Conflict, no overwrite', async () => {
      // Loaded as ACTIVE (valid revoke target) …
      connectionRepo.findOne
        .mockResolvedValueOnce(
          baseConnection({
            authorizationStatus: BrokerAuthorizationStatus.ACTIVE,
            liveTradingEnabled: true,
          }),
        )
        // … but by the time the guarded UPDATE runs the row was re-read as
        // SUSPENDED (a concurrent writer won) → affected = 0.
        .mockResolvedValueOnce(
          baseConnection({ authorizationStatus: BrokerAuthorizationStatus.SUSPENDED }),
        );
      connectionRepo.update.mockResolvedValue({ affected: 0 });

      await expect(service.revokeAuthorization('conn-1', 'user-1')).rejects.toThrow(
        ConflictException,
      );
      // The only update attempt was the guarded one — no unguarded overwrite
      expect(connectionRepo.update).toHaveBeenCalledTimes(1);
      expect(eventBus.publish).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalled();
    });
  });

  describe('A4: atomic conditional transitions (architect correction)', () => {
    it('enableLiveTrading writes only when the persisted state still matches', async () => {
      connectionRepo.findOne
        .mockResolvedValueOnce(
          baseConnection({ authorizationStatus: BrokerAuthorizationStatus.CONNECTED }),
        )
        .mockResolvedValueOnce(baseConnection({ demoValidated: true })) // demo lookup
        .mockResolvedValue(
          baseConnection({ authorizationStatus: BrokerAuthorizationStatus.CONNECTED }),
        );

      await service.enableLiveTrading('conn-1', 'user-1');

      expect(connectionRepo.update).toHaveBeenCalledWith(
        { id: 'conn-1', authorizationStatus: BrokerAuthorizationStatus.CONNECTED },
        expect.objectContaining({ authorizationStatus: BrokerAuthorizationStatus.ACTIVE }),
      );
    });

    it('enableLiveTrading loses to a concurrent revoke — Conflict, ACTIVE never written', async () => {
      connectionRepo.findOne
        .mockResolvedValueOnce(
          baseConnection({ authorizationStatus: BrokerAuthorizationStatus.CONNECTED }),
        )
        .mockResolvedValueOnce(baseConnection({ demoValidated: true }))
        .mockResolvedValue(
          baseConnection({ authorizationStatus: BrokerAuthorizationStatus.REVOKED }),
        );
      connectionRepo.update.mockResolvedValue({ affected: 0 });

      await expect(service.enableLiveTrading('conn-1', 'user-1')).rejects.toThrow(
        ConflictException,
      );
      const patch = connectionRepo.update.mock.calls[0]?.[1];
      // nothing else was attempted beyond the guarded (failed) write
      expect(patch).toEqual(
        expect.objectContaining({ authorizationStatus: BrokerAuthorizationStatus.ACTIVE }),
      );
      expect(eventBus.publish).not.toHaveBeenCalled();
    });

    it('disconnectBroker guards the write on the loaded authorization state', async () => {
      connectionRepo.findOne.mockResolvedValue(
        baseConnection({
          status: BrokerConnectionStatus.CONNECTED,
          authorizationStatus: BrokerAuthorizationStatus.ACTIVE,
        }),
      );
      connectionRepo.update.mockResolvedValue({ affected: 0 }); // concurrent writer won

      await expect(service.disconnectBroker('conn-1', 'user-1')).rejects.toThrow(ConflictException);
      expect(connectionRepo.update).toHaveBeenCalledTimes(1);
    });

    it('healthCheck suspend loses to a concurrent revoke — conflict logged, state untouched, returns false', async () => {
      connectionRepo.findOne.mockResolvedValue(
        baseConnection({
          status: BrokerConnectionStatus.CONNECTED,
          authorizationStatus: BrokerAuthorizationStatus.ACTIVE,
          consecutiveFailureCount: 2, // next failure = 3 → suspend threshold
        }),
      );
      adapter.connect.mockRejectedValue(new Error('provider down'));
      connectionRepo.update.mockImplementation(
        async (criteria: unknown, patch: Record<string, unknown>) => {
          // Telemetry write succeeds; the guarded SUSPENDED write loses the race.
          if (patch && patch.authorizationStatus) return { affected: 0 };
          return { affected: 1 };
        },
      );

      const result = await service.healthCheck('conn-1');

      expect(result).toBe(false);
      // Telemetry recorded …
      const telemetryCall = connectionRepo.update.mock.calls.find(
        (c) => c[1].consecutiveFailureCount === 3,
      );
      expect(telemetryCall).toBeDefined();
      // … but no unguarded state overwrite happened (only telemetry + guarded attempt)
      const stateWrites = connectionRepo.update.mock.calls.filter(
        (c) => c[1].status === BrokerConnectionStatus.SUSPENDED,
      );
      expect(stateWrites).toHaveLength(1);
      expect(stateWrites[0][0]).toEqual(
        expect.objectContaining({ authorizationStatus: BrokerAuthorizationStatus.ACTIVE }),
      );
    });

    it('unwrapAffectedRows handles both UpdateResult and [rows, rowCount] driver shapes', async () => {
      connectionRepo.findOne.mockResolvedValue(
        baseConnection({
          status: BrokerConnectionStatus.CONNECTED,
          authorizationStatus: BrokerAuthorizationStatus.ACTIVE,
        }),
      );
      // Raw tuple shape: [rows, rowCount] with rowCount 0 → conflict
      connectionRepo.update.mockResolvedValue([[], 0]);

      await expect(service.disconnectBroker('conn-1', 'user-1')).rejects.toThrow(ConflictException);
    });
  });

  describe('rotateCredentials() (Directive §14)', () => {
    it('validates new credentials BEFORE persisting — failure keeps old set', async () => {
      connectionRepo.findOne.mockResolvedValue(baseConnection());
      adapter.testConnection.mockResolvedValue({
        success: false,
        errorCode: 'AUTH_FAILED',
        errorMessage: 'invalid key',
      });

      await expect(
        service.rotateCredentials(
          'conn-1',
          { brokerId: 'metatrader5', accountType: BrokerMode.LIVE, accountId: '123' } as never,
          'user-1',
        ),
      ).rejects.toThrow(BadRequestException);

      expect(connectionRepo.update).not.toHaveBeenCalled();
    });

    it('replaces ciphertext and marks credentials ROTATED on success — no plaintext persisted', async () => {
      connectionRepo.findOne.mockResolvedValue(baseConnection());
      adapter.testConnection.mockResolvedValue({ success: true, accountId: '123' });

      await service.rotateCredentials(
        'conn-1',
        { brokerId: 'metatrader5', accountType: BrokerMode.LIVE, accountId: '123' } as never,
        'user-1',
      );

      expect(encryption.encrypt).toHaveBeenCalled();
      expect(connectionRepo.update).toHaveBeenCalledWith(
        'conn-1',
        expect.objectContaining({
          encryptedCredentials: 'c1',
          credentialStatus: BrokerCredentialStatus.ROTATED,
        }),
      );
      // The update payload must never contain plaintext credential fields
      const payload = JSON.stringify(connectionRepo.update.mock.calls[0][1]);
      expect(payload).not.toMatch(/"apiKey"|"apiSecret"/);
    });

    it('refuses rotation to a different broker or account type', async () => {
      connectionRepo.findOne.mockResolvedValue(baseConnection());

      await expect(
        service.rotateCredentials(
          'conn-1',
          { brokerId: 'oanda', accountType: BrokerMode.LIVE, accountId: '123' } as never,
          'user-1',
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('A3: credential lifecycle gates every decrypt/consume path (fail closed)', () => {
    it.each([
      ['INVALID', BrokerCredentialStatus.INVALID],
      ['EXPIRED', BrokerCredentialStatus.EXPIRED],
      ['REVOKED', BrokerCredentialStatus.REVOKED],
      ['missing', undefined],
    ])(
      'connectBroker NEVER reaches the provider adapter when credentialStatus is %s',
      async (_label, credentialStatus) => {
        connectionRepo.findOne.mockResolvedValue(
          baseConnection({
            status: BrokerConnectionStatus.DISCONNECTED,
            authorizationStatus: BrokerAuthorizationStatus.NOT_CONNECTED,
            credentialStatus,
          }),
        );

        await expect(service.connectBroker('conn-1', 'user-1')).rejects.toThrow(ConflictException);
        expect(adapter.connect).not.toHaveBeenCalled();
        expect(encryption.decrypt).not.toHaveBeenCalled();
      },
    );

    it.each([
      ['INVALID', BrokerCredentialStatus.INVALID],
      ['EXPIRED', BrokerCredentialStatus.EXPIRED],
      ['REVOKED', BrokerCredentialStatus.REVOKED],
      ['missing', undefined],
    ])(
      'healthCheck NEVER reaches the provider adapter when credentialStatus is %s',
      async (_label, credentialStatus) => {
        connectionRepo.findOne.mockResolvedValue(
          baseConnection({
            status: BrokerConnectionStatus.CONNECTED,
            authorizationStatus: BrokerAuthorizationStatus.ACTIVE,
            credentialStatus,
          }),
        );

        const result = await service.healthCheck('conn-1');
        expect(result).toBe(false);
        expect(adapter.connect).not.toHaveBeenCalled();
        expect(encryption.decrypt).not.toHaveBeenCalled();
      },
    );

    it.each([
      ['INVALID', BrokerCredentialStatus.INVALID],
      ['EXPIRED', BrokerCredentialStatus.EXPIRED],
      ['REVOKED', BrokerCredentialStatus.REVOKED],
      ['missing', undefined],
    ])(
      'getOhlcvForConnection NEVER reaches the provider when credentialStatus is %s',
      async (_label, credentialStatus) => {
        connectionRepo.findOne.mockResolvedValue(
          baseConnection({
            status: BrokerConnectionStatus.CONNECTED,
            authorizationStatus: BrokerAuthorizationStatus.ACTIVE,
            credentialStatus,
          }),
        );

        await expect(
          service.getOhlcvForConnection('user-1', 'conn-1', 'EURUSD', 'M15', 10),
        ).rejects.toThrow(ConflictException);
        expect(adapter.connect).not.toHaveBeenCalled();
        expect(encryption.decrypt).not.toHaveBeenCalled();
      },
    );

    it.each([
      ['INVALID', BrokerCredentialStatus.INVALID],
      ['EXPIRED', BrokerCredentialStatus.EXPIRED],
      ['REVOKED', BrokerCredentialStatus.REVOKED],
      ['missing', undefined],
    ])(
      'getClosedTradesForConnection NEVER reaches the provider when credentialStatus is %s',
      async (_label, credentialStatus) => {
        connectionRepo.findOne.mockResolvedValue(
          baseConnection({
            status: BrokerConnectionStatus.CONNECTED,
            authorizationStatus: BrokerAuthorizationStatus.ACTIVE,
            credentialStatus,
          }),
        );

        await expect(
          service.getClosedTradesForConnection(
            'conn-1',
            'user-1',
            new Date(Date.now() - 86_400_000),
            new Date(),
          ),
        ).rejects.toThrow(ConflictException);
        expect(adapter.connect).not.toHaveBeenCalled();
        expect(encryption.decrypt).not.toHaveBeenCalled();
      },
    );

    it.each([
      ['INVALID', BrokerCredentialStatus.INVALID],
      ['EXPIRED', BrokerCredentialStatus.EXPIRED],
      ['REVOKED', BrokerCredentialStatus.REVOKED],
      ['missing', undefined],
    ])(
      'getRequiredMargin (previously fully unguarded) fails closed with null when credentialStatus is %s',
      async (_label, credentialStatus) => {
        connectionRepo.findOne.mockResolvedValue(
          baseConnection({
            status: BrokerConnectionStatus.CONNECTED,
            authorizationStatus: BrokerAuthorizationStatus.ACTIVE,
            credentialStatus,
          }),
        );

        const result = await service.getRequiredMargin('conn-1', {
          instrument: 'EURUSD',
          lotSize: '0.10',
          direction: 'BUY',
        });
        expect(result).toBeNull();
        expect(adapter.connect).not.toHaveBeenCalled();
        expect(encryption.decrypt).not.toHaveBeenCalled();
      },
    );

    it('getRequiredMargin also fails closed for non-CONNECTED connection status', async () => {
      connectionRepo.findOne.mockResolvedValue(
        baseConnection({
          status: BrokerConnectionStatus.SUSPENDED,
          authorizationStatus: BrokerAuthorizationStatus.SUSPENDED,
          credentialStatus: BrokerCredentialStatus.VERIFIED,
        }),
      );

      const result = await service.getRequiredMargin('conn-1', {
        instrument: 'EURUSD',
        lotSize: '0.10',
        direction: 'BUY',
      });
      expect(result).toBeNull();
      expect(adapter.connect).not.toHaveBeenCalled();
    });

    it('usable states (CREATED/VERIFIED/ROTATED) still pass the gate', async () => {
      connectionRepo.findOne.mockResolvedValue(
        baseConnection({
          status: BrokerConnectionStatus.CONNECTED,
          authorizationStatus: BrokerAuthorizationStatus.NOT_CONNECTED,
          credentialStatus: BrokerCredentialStatus.ROTATED,
        }),
      );
      adapter.connect.mockResolvedValue({ success: true });

      // connectBroker proceeds past the gate (the decrypt + adapter call happen)
      await service.connectBroker('conn-1', 'user-1').catch(() => {
        // connect flow may fail later on other mocks — irrelevant here
      });
      expect(adapter.connect).toHaveBeenCalled();
    });
  });

  describe('isConnectionExecutable() — fail-closed gate (Directive §48)', () => {
    it('allows ONLY ACTIVE connections', () => {
      expect(
        service.isConnectionExecutable(
          baseConnection({ authorizationStatus: BrokerAuthorizationStatus.ACTIVE }) as never,
        ),
      ).toBe(true);
      expect(
        service.isConnectionExecutable(
          baseConnection({ authorizationStatus: BrokerAuthorizationStatus.CONNECTED }) as never,
        ),
      ).toBe(false);
      expect(
        service.isConnectionExecutable(
          baseConnection({ authorizationStatus: BrokerAuthorizationStatus.AUTHORIZED }) as never,
        ),
      ).toBe(false);
    });

    it('fails closed on missing state (legacy rows / corrupted state)', () => {
      expect(service.isConnectionExecutable(baseConnection() as never)).toBe(false);
      expect(
        service.isConnectionExecutable(baseConnection({ authorizationStatus: undefined }) as never),
      ).toBe(false);
    });
  });
});
