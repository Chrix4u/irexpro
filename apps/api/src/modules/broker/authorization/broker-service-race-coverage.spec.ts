import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConflictException, Logger } from '@nestjs/common';
import { BrokerService } from '../broker.service';
import { TradingAuthorityService } from '../../execution-authority/trading-authority.service';
import { GrantInvalidationService } from '../../execution-authority/grant-invalidation.service';
import { BrokerOAuthTokenLifecycleService } from '../services/broker-oauth-token-lifecycle.service';
import { BrokerLinkOutboxService } from '../services/broker-link-outbox.service';
import { BrokerConnection } from '../entities/broker-connection.entity';
import { BrokerAccount } from '../entities/broker-account.entity';
import { BrokerAdapterRegistry } from '../adapters/broker-adapter.registry';
import { BrokerProviderRegistryService } from '../registry/broker-provider-registry.service';
import { CredentialEncryptionService } from '../services/credential-encryption.service';
import { AuditService } from '../../audit/audit.service';
import { AuditSeverity } from '../../audit/entities/audit-log.entity';
import { DomainEventBus } from '../../events/event-bus.service';
import { DomainEventType } from '../../events/enums/domain-event-type.enum';
import { AuditAction } from '../../../common/enums/audit-action.enum';
import {
  BrokerAuthorizationStatus,
  BrokerAuthorizationStateMachine,
} from './broker-authorization-status';
import { BrokerCredentialStatus } from './broker-credential-status';
import { BrokerConnectionStatus, BrokerMode } from '../interfaces/broker-adapter.interface';
import { BrokerAccountSnapshotService } from '../services/broker-account-snapshot.service';

/**
 * Sprint 56 correction round 3 / Task 2-b — deterministic race-coverage for the
 * two #291 BrokerService findings fixed in commit 085d35f:
 *
 *  (a) disconnectBroker: the guarded persisted-state transition must win
 *      BEFORE any irreversible provider teardown (a lost race leaves the
 *      provider session + adapter context untouched for the concurrent
 *      winner); teardown after a WON transition is best-effort.
 *  (b) healthCheck suspension: the SUSPENDED write is guarded-only; a LOST
 *      suspension has NO observable side effects (no release, no audit, no
 *      event); the unguarded else-write is gone — even non-transitionable
 *      authorization statuses go through the guarded conditional.
 *
 * Races are orchestrated purely with mock sequencing (mockResolvedValueOnce
 * chains / rejected promises) — no real timers, no waiting.
 */

// Same adapter stub shape as broker-authorization-lifecycle.spec.ts's
// mockAdapter(), plus the getAccountBalance step healthCheck exercises.
const mockAdapter = (over: Record<string, unknown> = {}) => ({
  brokerId: 'metatrader5',
  brokerName: 'MetaTrader 5 (via MetaAPI)',
  supportsDemo: true,
  setMode: jest.fn(),
  connect: jest.fn(),
  disconnect: jest.fn(),
  testConnection: jest.fn(),
  getAccountBalance: jest.fn(),
  ...over,
});

// Same base fixture as broker-authorization-lifecycle.spec.ts.
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

// healthCheck-reachable fixture: CONNECTED status, usable credentials
// (ciphertext fields present for the presence gate), ACTIVE authorization.
const connectableConnection = (over: Partial<Record<string, unknown>> = {}) =>
  baseConnection({
    status: BrokerConnectionStatus.CONNECTED,
    authorizationStatus: BrokerAuthorizationStatus.ACTIVE,
    credentialStatus: BrokerCredentialStatus.VERIFIED,
    ...over,
  });

describe('BrokerService — #291 race coverage (correction round 3)', () => {
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
  let adapterRegistry: {
    getAdapter: jest.Mock;
    getAdapterForConnection: jest.Mock;
    createEphemeralAdapter: jest.Mock;
    releaseAdapterForConnection: jest.Mock;
    isSupported: jest.Mock;
  };
  let providerRegistry: {
    supportsEnvironment: jest.Mock;
    isConnectable: jest.Mock;
    isProductionLiveEligible: jest.Mock;
    getEntry: jest.Mock;
  };
  let encryption: { encrypt: jest.Mock; decrypt: jest.Mock };
  let audit: { log: jest.Mock };
  let eventBus: { publish: jest.Mock };
  let moduleRef: TestingModule;

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
      isProductionLiveEligible: jest.fn().mockReturnValue(true),
      getEntry: jest.fn().mockReturnValue(null),
    };
    encryption = {
      encrypt: jest.fn().mockReturnValue({ ciphertext: 'c1', iv: 'i1', tag: 't1', keyId: 'k1' }),
      decrypt: jest.fn().mockReturnValue({ apiKey: 'k', accountId: '123' }),
    };
    audit = { log: jest.fn().mockResolvedValue(undefined) };
    eventBus = { publish: jest.fn() };
    adapterRegistry = {
      getAdapter: jest.fn().mockReturnValue(adapter),
      // #291 / correction round 3: the session API the production code
      // resolves connection-scoped/ephemeral adapters through.
      getAdapterForConnection: jest.fn().mockReturnValue(adapter),
      createEphemeralAdapter: jest.fn().mockReturnValue(adapter),
      releaseAdapterForConnection: jest.fn(),
      isSupported: jest.fn().mockReturnValue(true),
    };

    moduleRef = await Test.createTestingModule({
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
        { provide: getRepositoryToken(BrokerConnection), useValue: connectionRepo },
        { provide: getRepositoryToken(BrokerAccount), useValue: accountRepo },
        { provide: BrokerAdapterRegistry, useValue: adapterRegistry },
        { provide: BrokerProviderRegistryService, useValue: providerRegistry },
        { provide: CredentialEncryptionService, useValue: encryption },
        { provide: AuditService, useValue: audit },
        // Round 6 live-execution completion (§1a): snapshot authority seam
        // (unused by the authorization-transition paths under test).
        {
          provide: BrokerAccountSnapshotService,
          useValue: { readLatestAcceptedSnapshot: jest.fn().mockResolvedValue(null) },
        },
        { provide: DomainEventBus, useValue: eventBus },
        // Passthrough OAuth token lifecycle (fixtures are metatrader-family —
        // the freshness gate hands the decrypted credentials straight through).
        {
          provide: BrokerOAuthTokenLifecycleService,
          useValue: {
            ensureFreshTokens: jest.fn((_c: unknown, credentials: unknown) =>
              Promise.resolve(credentials),
            ),
          },
        },
        {
          provide: BrokerLinkOutboxService,
          useValue: {
            enqueueWithinTransaction: jest.fn().mockResolvedValue(undefined),
            enqueue: jest.fn().mockResolvedValue(undefined),
            sweep: jest.fn().mockResolvedValue({ delivered: 0, failed: 0, deferred: 0 }),
          },
        },
      ],
    }).compile();

    service = moduleRef.get(BrokerService);
  });

  afterEach(async () => {
    // Restore Logger.prototype spies created in individual tests.
    jest.restoreAllMocks();
    await moduleRef.close();
  });

  describe('disconnectBroker — provider teardown ordering vs the guarded transition', () => {
    // #291 race finding (a): the guarded persisted-state transition must win
    // BEFORE any irreversible provider teardown.
    it('won transition: guarded update precedes adapter.disconnect, release follows teardown, audit lands', async () => {
      connectionRepo.findOne.mockResolvedValue(
        baseConnection({
          status: BrokerConnectionStatus.CONNECTED,
          authorizationStatus: BrokerAuthorizationStatus.ACTIVE,
        }),
      );

      // Shared sequence array: both mocks push labels as they fire, giving a
      // deterministic total order of the teardown choreography.
      const sequence: string[] = [];
      connectionRepo.update.mockImplementation(async () => {
        sequence.push('guarded-update');
        return { affected: 1 };
      });
      adapter.disconnect.mockImplementation(async () => {
        sequence.push('adapter-disconnect');
      });
      adapterRegistry.releaseAdapterForConnection.mockImplementation((id: string) => {
        sequence.push(`adapter-release:${id}`);
      });
      audit.log.mockImplementation(async () => {
        sequence.push('audit-BROKER_DISCONNECTED');
      });

      await service.disconnectBroker('conn-1', 'user-1', '203.0.113.7');

      // (a) the guarded persisted-state transition happened BEFORE the
      // irreversible provider teardown (never the other way around).
      expect(sequence.indexOf('guarded-update')).toBeGreaterThanOrEqual(0);
      expect(sequence.indexOf('guarded-update')).toBeLessThan(
        sequence.indexOf('adapter-disconnect'),
      );
      // (b) the provider teardown actually happened for the won transition.
      expect(adapter.disconnect).toHaveBeenCalledTimes(1);
      // (c) the connection-scoped adapter context was released AFTER the
      // teardown, with the connection id.
      expect(sequence.indexOf('adapter-disconnect')).toBeLessThan(
        sequence.indexOf('adapter-release:conn-1'),
      );
      expect(adapterRegistry.releaseAdapterForConnection).toHaveBeenCalledWith('conn-1');
      // (d) the disconnection is audited.
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.BROKER_DISCONNECTED,
          actorUserId: 'user-1',
          resourceId: 'conn-1',
          ipAddress: '203.0.113.7',
        }),
      );
      // The persisted transition is the guarded conditional write pinned to
      // the loaded authorization state (ACTIVE → DISCONNECTED allowed).
      expect(connectionRepo.update).toHaveBeenCalledWith(
        { id: 'conn-1', authorizationStatus: BrokerAuthorizationStatus.ACTIVE },
        expect.objectContaining({
          status: BrokerConnectionStatus.DISCONNECTED,
          authorizationStatus: BrokerAuthorizationStatus.DISCONNECTED,
        }),
      );
      // The teardown ran through the connection-scoped adapter factory.
      expect(adapterRegistry.getAdapterForConnection).toHaveBeenCalledWith('conn-1', 'metatrader5');
    });

    it('LOST RACE: guarded update matches 0 rows → ConflictException, provider session + adapter context untouched', async () => {
      connectionRepo.findOne.mockResolvedValue(
        baseConnection({
          status: BrokerConnectionStatus.CONNECTED,
          authorizationStatus: BrokerAuthorizationStatus.ACTIVE,
        }),
      );
      // The guarded conditional UPDATE matches ZERO rows — a concurrent
      // enable-live/revoke changed the authoritative authorization state
      // between the load and the write.
      connectionRepo.update.mockResolvedValueOnce({ affected: 0 });

      await expect(service.disconnectBroker('conn-1', 'user-1')).rejects.toThrow(ConflictException);

      // Exactly ONE update attempt — the guarded one; no unguarded fallback.
      expect(connectionRepo.update).toHaveBeenCalledTimes(1);
      expect(connectionRepo.update).toHaveBeenCalledWith(
        { id: 'conn-1', authorizationStatus: BrokerAuthorizationStatus.ACTIVE },
        expect.objectContaining({ status: BrokerConnectionStatus.DISCONNECTED }),
      );
      // The error-message reload still sees a persisted row (the winner's
      // state) — findOne stays available for the honest Conflict message.
      expect(connectionRepo.findOne).toHaveBeenCalledTimes(2);

      // No irreversible provider teardown for a lost race: the adapter is
      // never even resolved, and the provider session is never disconnected.
      expect(adapterRegistry.getAdapterForConnection).not.toHaveBeenCalled();
      expect(adapter.disconnect).not.toHaveBeenCalled();
      // The mutable adapter context survives untouched for the concurrent
      // winner.
      expect(adapterRegistry.releaseAdapterForConnection).not.toHaveBeenCalled();
      // No disconnection audit — the disconnect never happened.
      expect(audit.log).not.toHaveBeenCalled();
    });

    it('won transition + failed provider teardown: still resolves (best-effort warn), persisted DISCONNECTED stands, release + audit still run', async () => {
      connectionRepo.findOne.mockResolvedValue(
        baseConnection({
          status: BrokerConnectionStatus.CONNECTED,
          authorizationStatus: BrokerAuthorizationStatus.ACTIVE,
        }),
      );
      adapter.disconnect.mockRejectedValue(new Error('provider RPC failed'));
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});

      await expect(service.disconnectBroker('conn-1', 'user-1')).resolves.toBeUndefined();

      // The failed teardown is logged as a WARNING — best-effort, not fatal.
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Adapter disconnect error for connection conn-1'),
      );
      // The persisted DISCONNECTED state stands — exactly the one guarded
      // write, no rollback/compensation write.
      expect(connectionRepo.update).toHaveBeenCalledTimes(1);
      // The mutable adapter context must not survive an explicit disconnect
      // even when the provider teardown itself failed (#291).
      expect(adapterRegistry.releaseAdapterForConnection).toHaveBeenCalledWith('conn-1');
      // The disconnection audit still lands.
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: AuditAction.BROKER_DISCONNECTED, resourceId: 'conn-1' }),
      );
    });

    it('NON-CONNECTED connection: no provider teardown, but guarded transition + release + audit still run', async () => {
      connectionRepo.findOne.mockResolvedValue(
        baseConnection({
          status: BrokerConnectionStatus.DISCONNECTED,
          authorizationStatus: BrokerAuthorizationStatus.AUTHORIZED,
        }),
      );

      await service.disconnectBroker('conn-1', 'user-1');

      // Connection status is already DISCONNECTED → no provider call at all.
      expect(adapterRegistry.getAdapterForConnection).not.toHaveBeenCalled();
      expect(adapter.disconnect).not.toHaveBeenCalled();
      // …but the guarded authorization transition still runs
      // (AUTHORIZED → DISCONNECTED is a valid state-machine transition).
      expect(connectionRepo.update).toHaveBeenCalledWith(
        { id: 'conn-1', authorizationStatus: BrokerAuthorizationStatus.AUTHORIZED },
        expect.objectContaining({
          status: BrokerConnectionStatus.DISCONNECTED,
          authorizationStatus: BrokerAuthorizationStatus.DISCONNECTED,
        }),
      );
      // The adapter context never survives an explicit disconnect.
      expect(adapterRegistry.releaseAdapterForConnection).toHaveBeenCalledWith('conn-1');
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: AuditAction.BROKER_DISCONNECTED }),
      );
    });
  });

  describe('healthCheck suspension — no observable side effects when the guarded suspension loses the race', () => {
    /** Drive the health check down the failure path deterministically. */
    const failProvider = (message = 'provider down') => {
      adapter.connect.mockRejectedValue(new Error(message));
      adapter.getAccountBalance.mockRejectedValue(new Error(message));
    };

    // #291 race finding (b): a LOST suspension must have NO observable side
    // effects; a WON one releases the adapter context and is audited/evented.
    it('WON SUSPENSION: telemetry first, guarded SUSPENDED write, release, CRITICAL audit, status event — all once', async () => {
      connectionRepo.findOne.mockResolvedValue(
        connectableConnection({ consecutiveFailureCount: 2 }),
      );
      failProvider();
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});

      const result = await service.healthCheck('conn-1');

      expect(result).toBe(false);
      // The check ran on the connection-scoped adapter.
      expect(adapterRegistry.getAdapterForConnection).toHaveBeenCalledWith('conn-1', 'metatrader5');

      // Failure telemetry is recorded FIRST (unguarded — counting is not a
      // state transition; criteria is the bare connection id).
      expect(connectionRepo.update).toHaveBeenCalledTimes(2);
      expect(connectionRepo.update.mock.calls[0][0]).toBe('conn-1');
      expect(connectionRepo.update.mock.calls[0][1]).toEqual(
        expect.objectContaining({
          consecutiveFailureCount: 3,
          lastErrorMessage: 'provider down',
          lastHealthCheckAt: expect.any(Date),
        }),
      );

      // The suspension itself is the guarded conditional write pinned to the
      // loaded authorization state (ACTIVE → SUSPENDED allowed).
      expect(connectionRepo.update).toHaveBeenLastCalledWith(
        { id: 'conn-1', authorizationStatus: BrokerAuthorizationStatus.ACTIVE },
        expect.objectContaining({
          status: BrokerConnectionStatus.SUSPENDED,
          authorizationStatus: BrokerAuthorizationStatus.SUSPENDED,
        }),
      );

      // The mutable adapter context is released ONLY after the WON suspension.
      expect(adapterRegistry.releaseAdapterForConnection).toHaveBeenCalledWith('conn-1');
      // CRITICAL suspension audit — exactly once.
      expect(audit.log).toHaveBeenCalledTimes(1);
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.BROKER_SUSPENDED_HEALTH_FAILURE,
          resourceId: 'conn-1',
          severity: AuditSeverity.CRITICAL,
          metadata: expect.objectContaining({ failureCount: 3 }),
        }),
      );
      // Realtime status event — exactly once, SUSPENDED.
      expect(eventBus.publish).toHaveBeenCalledTimes(1);
      expect(eventBus.publish).toHaveBeenCalledWith(
        DomainEventType.BROKER_STATUS_CHANGED,
        'user-1',
        expect.objectContaining({
          connectionId: 'conn-1',
          status: BrokerConnectionStatus.SUSPENDED,
          previousStatus: BrokerConnectionStatus.CONNECTED,
        }),
      );
    });

    it('LOST RACE: 3rd failure, guarded write matches 0 rows → NO release, NO audit, NO event; telemetry still written', async () => {
      connectionRepo.findOne.mockResolvedValue(
        connectableConnection({ consecutiveFailureCount: 2 }),
      );
      failProvider();
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
      // update sequence: 1st call = failure telemetry (unguarded), 2nd call =
      // guarded SUSPENDED transition — the concurrent winner changed the
      // authorization state in between, so the conditional matches ZERO rows.
      connectionRepo.update
        .mockResolvedValueOnce({ affected: 1 }) // telemetry write succeeds
        .mockResolvedValueOnce({ affected: 0 }); // guarded suspension loses

      const result = await service.healthCheck('conn-1');

      // The check still reports failure …
      expect(result).toBe(false);
      // … and the failure telemetry IS recorded (failure counting is not a
      // state transition and must not be lost with the race).
      expect(connectionRepo.update).toHaveBeenCalledWith(
        'conn-1',
        expect.objectContaining({
          consecutiveFailureCount: 3,
          lastErrorMessage: 'provider down',
          lastHealthCheckAt: expect.any(Date),
        }),
      );
      // Exactly telemetry + the ONE guarded attempt — no unguarded status
      // retry after the lost race.
      expect(connectionRepo.update).toHaveBeenCalledTimes(2);
      expect(connectionRepo.update.mock.calls[1][0]).toEqual({
        id: 'conn-1',
        authorizationStatus: BrokerAuthorizationStatus.ACTIVE,
      });

      // The lost race is logged as a warning, never thrown.
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('suspend lost a concurrent state race'),
      );

      // NO observable suspension side effects: the adapter context was
      // acquired for the check but is RETAINED for the concurrent winner …
      expect(adapterRegistry.getAdapterForConnection).toHaveBeenCalledWith('conn-1', 'metatrader5');
      expect(adapterRegistry.releaseAdapterForConnection).not.toHaveBeenCalled();
      // … and the suspension is neither audited nor published.
      expect(audit.log).not.toHaveBeenCalled();
      expect(eventBus.publish).not.toHaveBeenCalled();
    });

    it('SUSPENSION WITH NON-TRANSITIONABLE AUTH STATUS (REVOKED): status-only patch through the GUARDED write, side effects fire', async () => {
      // Sanity: the state machine forbids REVOKED → SUSPENDED.
      expect(
        BrokerAuthorizationStateMachine.canTransition(
          BrokerAuthorizationStatus.REVOKED,
          BrokerAuthorizationStatus.SUSPENDED,
        ),
      ).toBe(false);

      connectionRepo.findOne.mockResolvedValue(
        connectableConnection({
          authorizationStatus: BrokerAuthorizationStatus.REVOKED,
          consecutiveFailureCount: 2,
        }),
      );
      failProvider();
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
      // Both writes succeed — the GUARDED write WINS the race.
      connectionRepo.update.mockResolvedValue({ affected: 1 });

      const result = await service.healthCheck('conn-1');
      expect(result).toBe(false);

      // 1st call = telemetry; 2nd call = the suspension write.
      expect(connectionRepo.update).toHaveBeenCalledTimes(2);
      const [guardedCriteria, guardedPatch] = connectionRepo.update.mock.calls[1];
      // The old unguarded else-write is truly gone: even without an
      // authorizationStatus transition, the status-only patch goes through
      // the GUARDED conditional write (criteria pin the loaded REVOKED state).
      expect(guardedCriteria).toEqual({
        id: 'conn-1',
        authorizationStatus: BrokerAuthorizationStatus.REVOKED,
      });
      expect(guardedPatch).toEqual({ status: BrokerConnectionStatus.SUSPENDED });
      expect(guardedPatch.authorizationStatus).toBeUndefined();

      // … and because the guarded write WON, every side effect fires.
      expect(adapterRegistry.releaseAdapterForConnection).toHaveBeenCalledWith('conn-1');
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.BROKER_SUSPENDED_HEALTH_FAILURE,
          resourceId: 'conn-1',
        }),
      );
      expect(eventBus.publish).toHaveBeenCalledWith(
        DomainEventType.BROKER_STATUS_CHANGED,
        'user-1',
        expect.objectContaining({ status: BrokerConnectionStatus.SUSPENDED }),
      );
    });

    it('BELOW THRESHOLD: 2nd failure → telemetry write only — no release, no audit, no event', async () => {
      connectionRepo.findOne.mockResolvedValue(
        connectableConnection({ consecutiveFailureCount: 1 }),
      );
      failProvider();

      const result = await service.healthCheck('conn-1');

      expect(result).toBe(false);
      // The ONLY write is the failure telemetry (count 2) — criteria is the
      // bare connection id, never a status transition.
      expect(connectionRepo.update).toHaveBeenCalledTimes(1);
      expect(connectionRepo.update).toHaveBeenCalledWith(
        'conn-1',
        expect.objectContaining({
          consecutiveFailureCount: 2,
          lastErrorMessage: 'provider down',
          lastHealthCheckAt: expect.any(Date),
        }),
      );
      // No suspension artifacts at all.
      expect(adapterRegistry.releaseAdapterForConnection).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalled();
      expect(eventBus.publish).not.toHaveBeenCalled();
    });
  });
});
