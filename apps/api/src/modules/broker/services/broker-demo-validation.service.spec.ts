import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { BrokerConnection } from '../entities/broker-connection.entity';
import { BrokerAccount } from '../entities/broker-account.entity';
import { BrokerService } from '../broker.service';
import { BrokerAdapterRegistry } from '../adapters/broker-adapter.registry';
import { BrokerProviderRegistryService } from '../registry/broker-provider-registry.service';
import { PaperBrokerAdapter } from '../adapters/paper-broker.adapter';
import { CredentialEncryptionService } from './credential-encryption.service';
import { BrokerDemoValidationService } from './broker-demo-validation.service';
import { BrokerOAuthTokenLifecycleService } from './broker-oauth-token-lifecycle.service';
import { CTraderClientService } from '../adapters/ctrader/ctrader-client.service';
import { AuditService } from '../../audit/audit.service';
import { AuditSeverity } from '../../audit/entities/audit-log.entity';
import { AuditAction } from '../../../common/enums/audit-action.enum';
import { DomainEventBus } from '../../events/event-bus.service';
import { BrokerAuthorizationStatus } from '../authorization/broker-authorization-status';
import { BrokerCredentialStatus } from '../authorization/broker-credential-status';
import {
  BrokerConnectionStatus,
  BrokerMode,
  BrokerAccountInfo,
  BrokerBalance,
  BrokerClosedTrade,
  BrokerCloseAllResult,
  BrokerConnectionResult,
  BrokerConnectionTestResult,
  BrokerInstrument,
  BrokerOrderResult,
  BrokerOrderState,
  BrokerPosition,
  BrokerPrice,
  DecryptedBrokerCredentials,
  IBrokerAdapter,
  OHLCV,
  RequiredMarginParams,
  BrokerOrderModification,
  BrokerOrderRequest,
} from '../interfaces/broker-adapter.interface';
import { BrokerAdapterError, BrokerErrorCode } from '../interfaces/broker-adapter.errors';
import { DEMO_VALIDATION_STEPS } from '../verification/provider-verification-harness';

/**
 * BrokerDemoValidationService — the evidence-based write path for
 * BrokerConnection.demoValidated (Sprint 56 / Task 47-C5; re-integrated onto
 * new main as Task 48-D).
 *
 * These specs run the REAL stack: real BrokerService (connectBroker state
 * machine + its connect-time demoValidated auto-write), real
 * CredentialEncryptionService (AES-256-GCM round trip), real
 * BrokerAdapterRegistry + real PaperBrokerAdapter (deterministic, no external
 * API). Only the repositories, audit service and event bus are mocked.
 *
 * Covered:
 * - paper-broker full checklist passes deterministically → demoValidated=true
 *   evidence write + BROKER_DEMO_VALIDATION_PASSED audited with the
 *   sanitized steps (+ the connectBroker auto-write interplay pinned)
 * - the connect-time auto-bless is REVOKED when the checklist fails (the
 *   evidence-based override that catches dead/stale blessed connections)
 * - scripted adapter failure → honest step result, flag stays false,
 *   BROKER_DEMO_VALIDATION_FAILED audited
 * - connect failure → fail-closed cascade (every later step SKIPPED)
 * - re-validation failure on a previously validated connection REVOKES the flag
 * - LIVE connection rejected (BadRequest) before any provider interaction
 * - runtime capability awareness: an adapter whose placeOrder rejects
 *   non-market order kinds (INVALID_ORDER_TYPE) skips the pending-order steps
 *   (stub adapter) and still passes overall
 * - credentials NEVER appear in audit metadata (marker probes)
 * - ownership: a foreign connection is NotFound
 */
describe('BrokerDemoValidationService', () => {
  const USER_ID = '11111111-2222-3333-4444-555555555555';
  const FOREIGN_USER_ID = '99999999-8888-7777-6666-555555555555';
  const CONN_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

  const TEST_ENCRYPTION_KEY = 'unit-test-encryption-key-0123456789abcdef';

  let module: TestingModule;
  let service: BrokerDemoValidationService;
  let connectionRepo: { findOne: jest.Mock; update: jest.Mock; create: jest.Mock; save: jest.Mock };
  let accountRepo: { findOne: jest.Mock; create: jest.Mock; save: jest.Mock; update: jest.Mock };
  let auditService: { log: jest.Mock };
  let registry: BrokerAdapterRegistry;
  let paperAdapter: PaperBrokerAdapter;
  let encryptionService: CredentialEncryptionService;

  /** Builds a DEMO paper-broker connection record with REAL encrypted credentials. */
  const buildConnection = (overrides: Record<string, unknown> = {}): Record<string, unknown> => {
    const encrypted = encryptionService.encrypt({
      apiKey: 'PAPER_KEY_MARKER_c3d4e5f6',
      accountId: 'paper-account-001',
    });
    return {
      id: CONN_ID,
      userId: USER_ID,
      brokerId: 'paper-broker',
      brokerName: 'Paper Trading Broker',
      accountType: BrokerMode.DEMO,
      status: BrokerConnectionStatus.DISCONNECTED,
      demoValidated: false,
      consecutiveFailureCount: 0,
      // New-main state machine fields: a usable credential set and a valid
      // pre-connect authorization state are REQUIRED for connectBroker.
      authorizationStatus: BrokerAuthorizationStatus.NOT_CONNECTED,
      credentialStatus: BrokerCredentialStatus.VERIFIED,
      encryptedCredentials: encrypted.ciphertext,
      credentialIv: encrypted.iv,
      credentialTag: encrypted.tag,
      encryptionKeyId: encrypted.keyId,
      ...overrides,
    };
  };

  /** Active connection record — swapped per test. */
  let connectionRecord: Record<string, unknown>;

  const mockConnectionRepo = () => ({
    findOne: jest.fn(),
    find: jest.fn().mockResolvedValue([]),
    create: jest.fn().mockImplementation((obj) => obj),
    save: jest.fn().mockResolvedValue({}),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    softDelete: jest.fn(),
  });

  const mockAccountRepo = () => ({
    findOne: jest.fn().mockResolvedValue(null),
    create: jest.fn().mockImplementation((obj) => obj),
    save: jest.fn().mockResolvedValue({}),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    // Prototype-level spies (the registry factory hands each connection a
    // FRESH adapter instance — instance spies can no longer reach them) MUST
    // be restored between tests, or implementations leak across cases.
    jest.restoreAllMocks();

    module = await Test.createTestingModule({
      providers: [
        BrokerService,
        BrokerDemoValidationService,
        BrokerAdapterRegistry,
        PaperBrokerAdapter,
        CredentialEncryptionService,
        // Sprint 56 correction round 1 (audit point 1): the REAL token
        // lifecycle service — the freshness gate is a no-op for paper-broker
        // fixtures (cTrader family only), proven here end-to-end.
        BrokerOAuthTokenLifecycleService,
        {
          provide: CTraderClientService,
          useValue: { refreshAccessToken: jest.fn() },
        },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string, defaultValue?: string) =>
              key === 'BROKER_ENCRYPTION_KEY' ? TEST_ENCRYPTION_KEY : defaultValue,
          },
        },
        // connectBroker never consults the provider registry — a minimal
        // permissive stub satisfies the new-main BrokerService constructor.
        {
          provide: BrokerProviderRegistryService,
          useValue: {
            supportsEnvironment: jest.fn().mockReturnValue(true),
            isProductionLiveEligible: jest.fn().mockReturnValue(true),
          },
        },
        { provide: getRepositoryToken(BrokerConnection), useFactory: mockConnectionRepo },
        { provide: getRepositoryToken(BrokerAccount), useFactory: mockAccountRepo },
        { provide: AuditService, useValue: { log: jest.fn().mockResolvedValue(undefined) } },
        { provide: DataSource, useValue: {} },
        {
          provide: DomainEventBus,
          useValue: { publish: jest.fn(), subscribe: jest.fn().mockReturnValue(() => {}) },
        },
      ],
    }).compile();

    service = module.get(BrokerDemoValidationService);
    registry = module.get(BrokerAdapterRegistry);
    paperAdapter = module.get(PaperBrokerAdapter);
    encryptionService = module.get(CredentialEncryptionService);
    connectionRepo = module.get(getRepositoryToken(BrokerConnection));
    accountRepo = module.get(getRepositoryToken(BrokerAccount));
    auditService = module.get(AuditService);

    // Same registration the BrokerModule performs in onModuleInit — including
    // the connection-isolation factory (#291 / correction round 3): the real
    // registry hands each BrokerConnection its own mutable adapter context and
    // fails closed without a factory.
    registry.register(paperAdapter, () => new PaperBrokerAdapter());

    connectionRecord = buildConnection();
    connectionRepo.findOne.mockImplementation(
      async ({ where }: { where: Record<string, string | undefined> }) => {
        if (where.id !== undefined) {
          return where.id === CONN_ID && where.userId === USER_ID ? connectionRecord : null;
        }
        return where.userId === USER_ID ? connectionRecord : null;
      },
    );
  });

  afterEach(async () => {
    await module.close();
  });

  /**
   * The EVIDENCE write: the single-key demoValidated patch produced by this
   * service (connectBroker's CONNECTED transition carries demoValidated inside
   * a multi-key patch — the new-main auto-write — and is NOT an evidence
   * write; see autoBlessWrites).
   */
  const evidenceWrites = (): Array<[unknown, Record<string, unknown>]> =>
    connectionRepo.update.mock.calls
      .filter((call: unknown[]) => {
        const patch = (call[1] as Record<string, unknown>) ?? {};
        return (
          typeof patch === 'object' && Object.keys(patch).length === 1 && 'demoValidated' in patch
        );
      })
      .map((call: unknown[]) => [call[0], call[1] as Record<string, unknown>]);

  /** The new-main connectBroker DEMO dual-write (demoValidated inside the CONNECTED patch). */
  const autoBlessWrites = (): Array<Record<string, unknown>> =>
    connectionRepo.update.mock.calls
      .map((call: unknown[]) => call[1] as Record<string, unknown>)
      .filter(
        (patch) =>
          patch &&
          patch.status === BrokerConnectionStatus.CONNECTED &&
          'demoValidated' in patch &&
          patch.demoValidated === true,
      );

  // ─── Happy path: the paper broker checklist passes deterministically ───────

  describe('validateDemoConnection — paper broker happy path', () => {
    it('runs the full checklist, writes demoValidated=true and audits PASSED', async () => {
      const result = await service.validateDemoConnection(CONN_ID, USER_ID);

      expect(result.overall).toBe('PASS');
      expect(result.demoValidated).toBe(true);
      expect(result.connectionId).toBe(CONN_ID);
      expect(result.brokerId).toBe('paper-broker');
      expect(result.accountType).toBe(BrokerMode.DEMO);
      // Exactly the DEMO validation checklist, in order, every step PASS.
      expect(result.steps.map((s) => s.name)).toEqual([...DEMO_VALIDATION_STEPS]);
      expect(result.steps.every((s) => s.status === 'PASS')).toBe(true);
      expect(result.summary).toEqual({
        passed: DEMO_VALIDATION_STEPS.length,
        failed: 0,
        skipped: 0,
      });

      // The evidence write: exactly one single-key update carrying
      // demoValidated=true (the re-read mock does not apply connectBroker's
      // auto-write, so the service still observes the pre-connect false).
      const writes = evidenceWrites();
      expect(writes).toHaveLength(1);
      expect(writes[0]![0]).toBe(CONN_ID);
      expect(writes[0]![1]).toEqual({ demoValidated: true });

      // The audit entry: PASSED with the sanitized step evidence.
      const passLog = auditService.log.mock.calls.find(
        (call: unknown[]) =>
          (call[0] as Record<string, unknown>).action === AuditAction.BROKER_DEMO_VALIDATION_PASSED,
      );
      expect(passLog).toBeDefined();
      const entry = passLog![0] as Record<string, unknown>;
      expect(entry.actorUserId).toBe(USER_ID);
      expect(entry.resourceType).toBe('BrokerConnection');
      expect(entry.resourceId).toBe(CONN_ID);
      expect(entry.severity).toBe(AuditSeverity.INFO);
      const metadata = entry.metadata as Record<string, unknown>;
      expect(metadata.brokerId).toBe('paper-broker');
      expect(metadata.overall).toBe('PASS');
      expect(metadata.demoValidated).toBe(true);
      expect(metadata.previousDemoValidated).toBe(false);
      expect(Array.isArray(metadata.steps)).toBe(true);
      expect((metadata.steps as Array<{ name: string; status: string }>).length).toBe(
        DEMO_VALIDATION_STEPS.length,
      );
    });

    it('connects through the canonical BrokerService.connectBroker state machine (auto-write pinned)', async () => {
      await service.validateDemoConnection(CONN_ID, USER_ID);

      // CONNECTING → CONNECTED transitions + BrokerAccount upsert happened.
      const statuses = connectionRepo.update.mock.calls.map(
        (call: unknown[]) => (call[1] as Record<string, unknown>).status,
      );
      expect(statuses).toContain(BrokerConnectionStatus.CONNECTING);
      expect(statuses).toContain(BrokerConnectionStatus.CONNECTED);
      expect(accountRepo.save).toHaveBeenCalled();
      // New-main interplay: connectBroker's CONNECTED transition carries the
      // DEMO dual-write demoValidated=true (the weak connect-implies-validated
      // proxy). The service does NOT fight it — the evidence write and the
      // proxy AGREE on a PASS.
      expect(autoBlessWrites()).toHaveLength(1);
      // connectBroker's own audit trail is preserved alongside the validation audit.
      const connectLog = auditService.log.mock.calls.find(
        (call: unknown[]) =>
          (call[0] as Record<string, unknown>).action === AuditAction.BROKER_CONNECTED,
      );
      expect(connectLog).toBeDefined();
    });

    it('never exposes the encrypted credential material in the response or audit metadata', async () => {
      const result = await service.validateDemoConnection(CONN_ID, USER_ID);

      // The plaintext apiKey marker never leaves the encryption envelope.
      expect(JSON.stringify(result)).not.toContain('PAPER_KEY_MARKER_c3d4e5f6');
      for (const call of auditService.log.mock.calls) {
        expect(JSON.stringify(call[0])).not.toContain('PAPER_KEY_MARKER_c3d4e5f6');
      }
      // The ciphertext itself is not echoed either.
      expect(JSON.stringify(result)).not.toContain(
        String(connectionRecord.encryptedCredentials).slice(0, 24),
      );
    });
  });

  // ─── The evidence-based override of the connect auto-bless ─────────────────

  describe('validateDemoConnection — evidence overrides the connect-time auto-bless', () => {
    it('REVOKES the auto-blessed flag when the checklist fails (evidence beats the proxy)', async () => {
      const marker = 'AUTOBLESS_SECRET_MARKER_4a5b6c7d';
      // connectBroker will reach CONNECTED and auto-write demoValidated=true;
      // simulate the persisted row flipping to the blessed value exactly as
      // the repository would after the CONNECTED transition.
      // Prototype level: connectBroker operates on the connection-scoped
      // adapter the registry factory produces — the spy must cover every
      // instance, not just the metadata root.
      const originalConnect = PaperBrokerAdapter.prototype.connect;
      jest.spyOn(PaperBrokerAdapter.prototype, 'connect').mockImplementation(async function (
        this: PaperBrokerAdapter,
        credentials,
      ) {
        const result = await originalConnect.call(this, credentials);
        connectionRecord = buildConnection({ demoValidated: true });
        return result;
      });
      // ...and then the evidence contradicts the bless: the checklist fails.
      jest
        .spyOn(PaperBrokerAdapter.prototype, 'getAccountInfo')
        .mockRejectedValueOnce(
          new BrokerAdapterError(
            BrokerErrorCode.BROKER_SERVER_ERROR,
            `provider exploded: apiKey=${marker}`,
          ),
        );

      const result = await service.validateDemoConnection(CONN_ID, USER_ID);

      expect(result.overall).toBe('FAIL');
      expect(result.demoValidated).toBe(false);
      // The revoke write: exactly one evidence write carrying false — the
      // just-blessed true does NOT survive a failing checklist.
      const writes = evidenceWrites();
      expect(writes).toHaveLength(1);
      expect(writes[0]![0]).toBe(CONN_ID);
      expect(writes[0]![1]).toEqual({ demoValidated: false });
      const failLog = auditService.log.mock.calls.find(
        (call: unknown[]) =>
          (call[0] as Record<string, unknown>).action === AuditAction.BROKER_DEMO_VALIDATION_FAILED,
      );
      expect(failLog).toBeDefined();
      const entry = failLog![0] as Record<string, unknown>;
      expect(entry.severity).toBe(AuditSeverity.WARNING);
      expect(entry.metadata as Record<string, unknown>).toMatchObject({
        previousDemoValidated: true,
        demoValidated: false,
      });
      // The revoked connection is the one connectBroker blessed (real write).
      expect(autoBlessWrites()).toHaveLength(1);
    });
  });

  // ─── Failure paths ──────────────────────────────────────────────────────────

  describe('validateDemoConnection — scripted adapter failure', () => {
    it('keeps demoValidated false, returns the honest step result and audits FAILED', async () => {
      const marker = 'SCRIPTED_SECRET_MARKER_9e8d7c6b';
      jest
        .spyOn(PaperBrokerAdapter.prototype, 'getAccountInfo')
        .mockRejectedValueOnce(
          new BrokerAdapterError(
            BrokerErrorCode.BROKER_SERVER_ERROR,
            `provider exploded: apiKey=${marker}`,
          ),
        );

      const result = await service.validateDemoConnection(CONN_ID, USER_ID);

      expect(result.overall).toBe('FAIL');
      expect(result.demoValidated).toBe(false);
      const accountStep = result.steps.find((s) => s.name === 'account-info');
      expect(accountStep?.status).toBe('FAIL');
      // Honest typed detail — sanitized, the credential-shaped fragment redacted.
      expect(accountStep?.detail).toContain('BROKER_SERVER_ERROR');
      expect(accountStep?.detail).not.toContain(marker);
      expect(accountStep?.detail).toContain('apiKey=[REDACTED]');
      // The failing run never writes demoValidated (false === observed false).
      expect(evidenceWrites()).toHaveLength(0);

      const failLog = auditService.log.mock.calls.find(
        (call: unknown[]) =>
          (call[0] as Record<string, unknown>).action === AuditAction.BROKER_DEMO_VALIDATION_FAILED,
      );
      expect(failLog).toBeDefined();
      const entry = failLog![0] as Record<string, unknown>;
      expect(entry.severity).toBe(AuditSeverity.WARNING);
      expect(JSON.stringify(entry.metadata)).not.toContain(marker);
    });

    it('cascades SKIPPED steps when the connection itself fails (fail-closed)', async () => {
      // connectBroker's documented failure path: connect() RESOLVES with
      // success=false → status ERROR + BROKER_CONNECT_FAILED audit + BadRequest.
      jest.spyOn(PaperBrokerAdapter.prototype, 'connect').mockResolvedValueOnce({
        success: false,
        accountId: '',
        accountType: BrokerMode.DEMO,
        currency: '',
        serverTime: new Date(0),
        error: 'broker rejected the credentials',
      });

      const result = await service.validateDemoConnection(CONN_ID, USER_ID);

      expect(result.overall).toBe('FAIL');
      expect(result.demoValidated).toBe(false);
      expect(result.steps[0]?.name).toBe('connect');
      expect(result.steps[0]?.status).toBe('FAIL');
      expect(result.steps[0]?.detail).toContain('broker rejected the credentials');
      // Every subsequent step is honestly SKIPPED, never silently attempted.
      for (const step of result.steps.slice(1)) {
        expect(step.status).toBe('SKIPPED');
        expect(step.detail).toContain('connect failed');
      }
      expect(result.summary).toEqual({
        passed: 0,
        failed: 1,
        skipped: DEMO_VALIDATION_STEPS.length - 1,
      });
      expect(evidenceWrites()).toHaveLength(0);
      // The failed connection itself is audited by connectBroker (not swallowed)
      // and its status machine recorded ERROR.
      const connectFailLog = auditService.log.mock.calls.find(
        (call: unknown[]) =>
          (call[0] as Record<string, unknown>).action === AuditAction.BROKER_CONNECT_FAILED,
      );
      expect(connectFailLog).toBeDefined();
      expect(
        connectionRepo.update.mock.calls.some(
          (call: unknown[]) =>
            (call[1] as Record<string, unknown>).status === BrokerConnectionStatus.ERROR,
        ),
      ).toBe(true);
    });

    it('REVOKES a previously validated connection when re-validation fails (evidence-consistent write)', async () => {
      connectionRecord = buildConnection({ demoValidated: true });
      jest
        .spyOn(PaperBrokerAdapter.prototype, 'getCurrentPrice')
        .mockRejectedValueOnce(
          new BrokerAdapterError(BrokerErrorCode.MARKET_CLOSED, 'market closed for validation'),
        );

      const result = await service.validateDemoConnection(CONN_ID, USER_ID);

      expect(result.overall).toBe('FAIL');
      expect(result.demoValidated).toBe(false);
      const writes = evidenceWrites();
      expect(writes).toHaveLength(1);
      expect(writes[0]![1]).toEqual({ demoValidated: false });
      const failLog = auditService.log.mock.calls.find(
        (call: unknown[]) =>
          (call[0] as Record<string, unknown>).action === AuditAction.BROKER_DEMO_VALIDATION_FAILED,
      );
      expect((failLog![0] as Record<string, unknown>).metadata).toMatchObject({
        previousDemoValidated: true,
        demoValidated: false,
      });
    });
  });

  // ─── Gates ──────────────────────────────────────────────────────────────────

  describe('validateDemoConnection — gates', () => {
    it('rejects a LIVE connection with BadRequest before any provider interaction', async () => {
      connectionRecord = buildConnection({ accountType: BrokerMode.LIVE });

      await expect(service.validateDemoConnection(CONN_ID, USER_ID)).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.validateDemoConnection(CONN_ID, USER_ID)).rejects.toThrow(/DEMO/);
      // No validation audit, no flag writes, no state-machine churn.
      expect(auditService.log).not.toHaveBeenCalled();
      expect(evidenceWrites()).toHaveLength(0);
      expect(connectionRepo.update).not.toHaveBeenCalled();
    });

    it('throws NotFound for a connection the user does not own (ownership check)', async () => {
      await expect(service.validateDemoConnection(CONN_ID, FOREIGN_USER_ID)).rejects.toThrow(
        NotFoundException,
      );
      expect(auditService.log).not.toHaveBeenCalled();
      expect(connectionRepo.update).not.toHaveBeenCalled();
    });
  });

  // ─── Runtime capability awareness (stub adapter without pending orders) ────

  describe('validateDemoConnection — runtime capability awareness', () => {
    it('skips the pending-order steps for an adapter without pending-order support and still passes', async () => {
      const stub = new StubLimitedAdapter();
      // The registry is NOT used for the stub (registering a brokerId without
      // a server-authoritative catalog entry would violate the registry
      // truthfulness rule) — the spec routes getAdapter to the stub instead.
      jest.spyOn(registry, 'getAdapterForConnection').mockReturnValue(stub);
      const bundle = encryptionService.encrypt({
        apiKey: 'STUB_KEY_MARKER_556677',
        accountId: 'stub-account-001',
      });
      connectionRecord = buildConnection({
        brokerId: 'stub-limited',
        encryptedCredentials: bundle.ciphertext,
        credentialIv: bundle.iv,
        credentialTag: bundle.tag,
        encryptionKeyId: bundle.keyId,
      });

      const result = await service.validateDemoConnection(CONN_ID, USER_ID);

      expect(result.overall).toBe('PASS');
      expect(result.demoValidated).toBe(true);

      // The pending-order chain is SKIPPED with the honest reason (the
      // typed INVALID_ORDER_TYPE rejection — new-main replacement for the
      // superseded capability-guard skip).
      const stepByName = new Map(result.steps.map((s) => [s.name, s]));
      expect(stepByName.get('pending-limit-order')).toMatchObject({
        status: 'SKIPPED',
        detail: expect.stringContaining('INVALID_ORDER_TYPE'),
      });
      expect(stepByName.get('pending-modify')?.status).toBe('SKIPPED');
      expect(stepByName.get('pending-cancel')?.status).toBe('SKIPPED');

      // Everything the stub DOES support passed, and the flag was written.
      expect(stepByName.get('market-order')?.status).toBe('PASS');
      expect(stepByName.get('trade-history')?.status).toBe('PASS');
      expect(stepByName.get('margin-info')?.status).toBe('PASS');
      // listOrders is a REQUIRED interface member — the stub implements it
      // honestly (empty) and the step runs.
      expect(stepByName.get('order-history')?.status).toBe('PASS');
      expect(evidenceWrites()[0]![1]).toEqual({ demoValidated: true });
    });
  });

  // ─── Paper adapter state guard (the module shares one instance) ────────────

  it('leaves the connection-scoped adapter connected after a passing validation (no teardown on the service path)', async () => {
    const result = await service.validateDemoConnection(CONN_ID, USER_ID);
    expect(result.overall).toBe('PASS');
    // #291 / correction round 3: the live mutable context is the
    // connection-scoped session adapter — it must stay connected (the
    // validation service never tears it down).
    const scoped = registry.getAdapterForConnection(CONN_ID, 'paper-broker');
    expect(scoped.isConnected()).toBe(true);
  });

  it('rejects Forbidden-style usage gracefully when credentials are absent', async () => {
    // A DEMO connection created without stored credentials: connectBroker
    // fails closed (BadRequest) BEFORE any decryption — the validation
    // reports connect FAIL honestly.
    connectionRecord = buildConnection({
      encryptedCredentials: null,
      credentialIv: null,
      credentialTag: null,
    });

    const result = await service.validateDemoConnection(CONN_ID, USER_ID);
    expect(result.overall).toBe('FAIL');
    expect(result.demoValidated).toBe(false);
    expect(result.steps[0]?.status).toBe('FAIL');
    expect(result.steps[0]?.detail).toContain('credentials');
  });
});

/**
 * Deterministic stub adapter WITHOUT pending-order support — placeOrder
 * rejects every non-MARKET order kind with the typed INVALID_ORDER_TYPE
 * error (the new-main fail-closed dispatch convention). This exercises the
 * engine's runtime-capability-aware step skipping with an honest, working
 * trading surface for everything it DOES implement.
 */
class StubLimitedAdapter implements IBrokerAdapter {
  readonly brokerId = 'stub-limited';
  readonly brokerName = 'Stub Limited (no pending-order surface)';
  readonly supportsDemo = true;

  private connected = false;
  private counter = 0;
  private readonly positions: BrokerPosition[] = [];
  private readonly closed: BrokerClosedTrade[] = [];

  setMode(_mode: BrokerMode): void {
    // DEMO by definition.
  }

  async connect(_credentials: DecryptedBrokerCredentials): Promise<BrokerConnectionResult> {
    this.connected = true;
    return {
      success: true,
      accountId: 'stub-account-001',
      accountType: BrokerMode.DEMO,
      currency: 'USD',
      serverTime: new Date(0),
    };
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async testConnection(
    _credentials: DecryptedBrokerCredentials,
  ): Promise<BrokerConnectionTestResult> {
    return { success: true, accountId: 'stub-account-001', accountType: BrokerMode.DEMO };
  }

  isConnected(): boolean {
    return this.connected;
  }

  async getAccountInfo(): Promise<BrokerAccountInfo> {
    return {
      accountId: 'stub-account-001',
      currency: 'USD',
      leverage: 100,
      balance: '1000.00',
      equity: '1000.00',
      margin: '0.00',
      freeMargin: '1000.00',
      marginLevel: '0.00',
    };
  }

  async getAccountBalance(): Promise<BrokerBalance> {
    return { balance: '1000.00', equity: '1000.00', currency: 'USD', timestamp: new Date(0) };
  }

  async getOpenPositions(): Promise<BrokerPosition[]> {
    return this.positions.map((p) => ({ ...p }));
  }

  async getPositionById(externalOrderId: string): Promise<BrokerPosition | null> {
    return this.positions.find((p) => p.externalOrderId === externalOrderId) ?? null;
  }

  async getRequiredMargin(_params: RequiredMarginParams): Promise<string | null> {
    return '5.50';
  }

  async getInstrumentList(): Promise<BrokerInstrument[]> {
    return [
      {
        symbol: 'EURUSD',
        description: 'Stub EURUSD',
        digits: 5,
        minLot: '0.01',
        maxLot: '1.00',
        lotStep: '0.01',
        contractSize: '100000',
      },
    ];
  }

  async getCurrentPrice(_instrument: string): Promise<BrokerPrice> {
    return {
      instrument: 'EURUSD',
      bid: '1.10000',
      ask: '1.10010',
      spread: '0.00010',
      timestamp: new Date(0),
    };
  }

  async getOHLCV(_instrument: string, _timeframe: string, _count: number): Promise<OHLCV[]> {
    return [];
  }

  async placeOrder(order: BrokerOrderRequest): Promise<BrokerOrderResult> {
    // New-main fail-closed dispatch: non-market kinds are rejected LOUDLY
    // with the typed INVALID_ORDER_TYPE error (never silently downgraded).
    if ((order.orderKind ?? 'MARKET') !== 'MARKET') {
      throw new BrokerAdapterError(
        BrokerErrorCode.INVALID_ORDER_TYPE,
        `stub supports MARKET orders only (received ${order.orderKind})`,
      );
    }
    this.counter += 1;
    const id = `stub-order-${this.counter.toString().padStart(3, '0')}`;
    this.positions.push({
      externalOrderId: id,
      instrument: order.instrument,
      direction: order.direction,
      lotSize: order.lotSize,
      openPrice: '1.10020',
      currentPrice: '1.10000',
      stopLoss: '0',
      takeProfit: '0',
      unrealisedPnl: '-0.20',
      openedAt: new Date(0),
      commission: '0',
      swap: '0',
    });
    return {
      success: true,
      externalOrderId: id,
      filledPrice: '1.10020',
      filledQuantity: order.lotSize,
      filledAt: new Date(0),
      status: 'FILLED',
    };
  }

  async modifyOrder(
    _externalOrderId: string,
    _modifications: BrokerOrderModification,
  ): Promise<BrokerOrderResult> {
    throw new BrokerAdapterError(BrokerErrorCode.INVALID_REQUEST, 'stub has no modify');
  }

  async closeOrder(externalOrderId: string, lotSize?: string): Promise<BrokerOrderResult> {
    const index = this.positions.findIndex((p) => p.externalOrderId === externalOrderId);
    if (index === -1) {
      throw new BrokerAdapterError(BrokerErrorCode.POSITION_NOT_FOUND, 'stub: unknown position');
    }
    const position = this.positions[index]!;
    const remaining =
      lotSize === undefined ? 0 : Math.max(0, Number(position.lotSize) - Number(lotSize));
    this.closed.push({
      externalOrderId: position.externalOrderId,
      instrument: position.instrument,
      direction: position.direction,
      lotSize: lotSize ?? position.lotSize,
      openPrice: position.openPrice,
      closePrice: '1.10000',
      stopLoss: '0',
      takeProfit: '0',
      realisedPnl: '-0.10',
      openedAt: new Date(0),
      closedAt: new Date(0),
      commission: '0',
      swap: '0',
      closeReason: 'MANUAL',
    });
    if (remaining > 0) {
      this.positions[index] = { ...position, lotSize: remaining.toFixed(2) };
    } else {
      this.positions.splice(index, 1);
    }
    return {
      success: true,
      externalOrderId,
      filledPrice: '1.10000',
      filledAt: new Date(0),
      status: 'FILLED',
    };
  }

  async closeAllOrders(): Promise<BrokerCloseAllResult> {
    return { closedCount: 0, failedCount: 0, errors: [] };
  }

  async getClosedTrades(_from: Date, _to: Date): Promise<BrokerClosedTrade[]> {
    return this.closed.map((t) => ({ ...t }));
  }

  async listOrders(): Promise<BrokerOrderState[]> {
    // The stub never rests working orders (non-market kinds are rejected).
    return [];
  }

  async getOrderById(_providerOrderId: string): Promise<BrokerOrderState | null> {
    return null;
  }
}
