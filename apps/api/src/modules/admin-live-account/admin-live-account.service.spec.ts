import { Repository } from 'typeorm';
import { BrokerAccount } from '../broker/entities/broker-account.entity';
import { BrokerConnection } from '../broker/entities/broker-connection.entity';
import { BrokerService } from '../broker/broker.service';
import { BrokerConnectionStatus, BrokerMode } from '../broker/interfaces/broker-adapter.interface';
import { BrokerAuthorizationStatus } from '../broker/authorization/broker-authorization-status';
import { BrokerCredentialStatus } from '../broker/authorization/broker-credential-status';
import { BrokerProviderRegistryService } from '../broker/registry/broker-provider-registry.service';
import { TradingSession, TradingSessionStatus } from '../execution/entities/trading-session.entity';
import {
  ExecutionControlScope,
  ExecutionControlStatus,
} from '../execution-control/entities/execution-control.entity';
import {
  ExecutionControlService,
  ExecutionControlView,
} from '../execution-control/execution-control.service';
import { ReconciliationRun } from '../execution/reconciliation/entities/reconciliation-run.entity';
import { ReconciliationDiscrepancy } from '../execution/reconciliation/entities/reconciliation-discrepancy.entity';
import {
  ReconciliationDiscrepancySeverity,
  ReconciliationDiscrepancyStatus,
  ReconciliationDiscrepancyType,
} from '../execution/reconciliation/reconciliation.enums';
import { AuditLog, AuditSeverity } from '../audit/entities/audit-log.entity';
import {
  ADMIN_AUDIT_ACTOR_FILTER_MAX_LENGTH,
  ADMIN_AUDIT_RESOURCE_FILTER_MAX_LENGTH,
  ADMIN_DESCRIPTION_MAX_LENGTH,
  ADMIN_ERROR_MESSAGE_MAX_LENGTH,
  ADMIN_EXPIRED_CONTROLS_MAX_ROWS,
  ADMIN_RESOLVED_WINDOW_MS,
  ADMIN_UNKNOWN_BROKER_ID,
  AdminLiveAccountService,
  boundAdminAuditFilter,
  clampPaginationLimit,
  clampPaginationOffset,
  maskControlScopeTarget,
  normalizeAdminAuditFilter,
  normalizeAdminConnectionFilter,
  normalizeAdminDiscrepancyFilter,
  sanitizeAdminText,
} from './admin-live-account.service';
import {
  AdminAuditLogFilter,
  AdminConnectionFilter,
  AdminDiscrepancyFilter,
} from './dto/admin-live-account.enums';
import { deriveDiscrepancyDescription } from './dto/admin-discrepancies-response.dto';
import { deriveAdminAuditSeverity } from './dto/admin-audit-response.dto';

/**
 * AdminLiveAccountService — Sprint 50 PR-6 unit specs (Directive §51).
 *
 * Covers: overview bucket correctness (connection + authorization + environment
 * matrices), discrepancy counts incl. the resolvedLast24h window, active-control
 * mapping + reason sanitization, provider registry mapping, automation counts,
 * the connection/discrepancy/audit filter matrices, maskedAccountId, executable
 * delegation (fail-closed on throw), lastErrorMessage sanitization + truncation,
 * openDiscrepancies enrichment, description derivation + sanitization, brokerId
 * enrichment, audit equality-only filters, and output redaction (JSON.stringify
 * absence assertions for credential material + audit metadata/ip/userAgent).
 */

const NOW = new Date('2026-01-15T12:00:00.000Z');

/** Minimal structural view of a TypeORM FindOperator for assertions. */
interface FindOperatorLike<T> {
  type: string;
  value: T;
}

function expectInOperator(actual: unknown, expected: readonly unknown[]): void {
  const operator = actual as FindOperatorLike<unknown[]>;
  expect(operator).toBeDefined();
  expect(operator.type).toBe('in');
  expect(operator.value).toEqual([...expected]);
}

function expectMoreThanOrEqualDate(actual: unknown, expected: Date): void {
  const operator = actual as FindOperatorLike<Date>;
  expect(operator).toBeDefined();
  expect(operator.type).toBe('moreThanOrEqual');
  expect(operator.value).toEqual(expected);
}

describe('AdminLiveAccountService', () => {
  let service: AdminLiveAccountService;
  let connectionRepo: { find: jest.Mock; count: jest.Mock };
  let accountRepo: { find: jest.Mock };
  let sessionRepo: { count: jest.Mock };
  let runRepo: { find: jest.Mock };
  let discrepancyRepo: { find: jest.Mock; count: jest.Mock };
  let auditRepo: { find: jest.Mock; count: jest.Mock };
  let executionControlService: {
    listActiveControls: jest.Mock;
    listControlsIncludingExpired: jest.Mock;
  };
  let providerRegistry: { getCatalog: jest.Mock };
  let brokerService: { isConnectionExecutable: jest.Mock };

  const connection = (overrides: Partial<BrokerConnection> = {}): BrokerConnection =>
    ({
      id: 'conn-1',
      userId: 'user-1',
      brokerId: 'metatrader5',
      brokerName: 'MetaTrader 5',
      displayName: 'Primary account',
      accountId: '1234567890123',
      accountType: BrokerMode.DEMO,
      accountCurrency: 'USD',
      accountLeverage: 100,
      status: BrokerConnectionStatus.CONNECTED,
      authorizationStatus: BrokerAuthorizationStatus.ACTIVE,
      credentialStatus: BrokerCredentialStatus.VERIFIED,
      authorizedAt: new Date('2026-01-01T00:00:00Z'),
      authorizationRevokedAt: null,
      encryptedCredentials: 'aGVsbG8gd29ybGQgc2VjcmV0IHZhbHVl',
      credentialIv: '001122334455667788990011',
      credentialTag: 'aabbccdd0011223344556677889900aabb',
      encryptionKeyId: 'kms-live-key-42',
      lastHealthCheckAt: new Date('2026-01-15T11:55:00Z'),
      lastSyncAt: new Date('2026-01-15T11:55:00Z'),
      consecutiveFailureCount: 0,
      lastErrorMessage: null,
      demoValidated: true,
      liveTradingEnabled: true,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-15T11:55:00Z'),
      deletedAt: null,
      ...overrides,
    }) as BrokerConnection;

  const discrepancy = (
    overrides: Partial<ReconciliationDiscrepancy> = {},
  ): ReconciliationDiscrepancy =>
    ({
      id: 'disc-1',
      userId: 'user-1',
      brokerConnectionId: 'conn-1',
      runId: null,
      type: ReconciliationDiscrepancyType.STALE_ORDER_STATE,
      severity: ReconciliationDiscrepancySeverity.WARNING,
      status: ReconciliationDiscrepancyStatus.OPEN,
      internalRefType: 'ORDER',
      internalRefId: 'order-1',
      clientOrderId: null,
      providerRef: 'ticket-1',
      details: { expected: 'FILLED', observed: 'ACKNOWLEDGED' },
      firstDetectedAt: NOW,
      lastSeenAt: NOW,
      resolvedAt: null,
      resolution: null,
      resolvedBy: null,
      createdAt: NOW,
      updatedAt: NOW,
      ...overrides,
    }) as ReconciliationDiscrepancy;

  const auditLog = (overrides: Partial<AuditLog> = {}): AuditLog =>
    ({
      id: 'audit-1',
      actorUserId: 'user-1',
      actorType: 'USER',
      action: 'ORDER_SUBMITTED',
      resourceType: 'Order',
      resourceId: 'order-1',
      correlationId: null,
      ipAddress: '203.0.113.10',
      userAgent: 'Mozilla/5.0',
      metadata: { brokerId: 'metatrader5', apiKey: 'secret-never-expose' },
      severity: AuditSeverity.INFO,
      createdAt: new Date('2026-01-15T11:00:00Z'),
      ...overrides,
    }) as unknown as AuditLog;

  const controlView = (overrides: Partial<ExecutionControlView> = {}): ExecutionControlView =>
    ({
      id: 'ctl-1',
      scope: ExecutionControlScope.GLOBAL,
      scopeKey: null,
      reason: 'incident response',
      activatedByUserId: 'admin-1',
      activatedAt: new Date('2026-01-15T10:00:00Z'),
      expiresAt: null,
      status: ExecutionControlStatus.ACTIVE,
      ...overrides,
    }) as ExecutionControlView;

  const registryEntry = (overrides: Record<string, unknown> = {}) => ({
    id: 'metatrader5',
    name: 'MetaTrader 5',
    description: 'MetaApi-backed MT5 integration',
    status: 'SUPPORTED',
    connectionRoutes: [],
    capabilities: ['ACCOUNT_READ', 'ORDER_READ'],
    authenticationType: 'API_TOKEN',
    environments: ['DEMO', 'LIVE'],
    regions: ['global'],
    adapterAvailable: true,
    ...overrides,
  });

  beforeEach(() => {
    connectionRepo = {
      find: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    };
    accountRepo = { find: jest.fn().mockResolvedValue([]) };
    sessionRepo = { count: jest.fn().mockResolvedValue(0) };
    runRepo = { find: jest.fn().mockResolvedValue([]) };
    discrepancyRepo = {
      find: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    };
    auditRepo = { find: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) };
    executionControlService = {
      listActiveControls: jest.fn().mockResolvedValue([]),
      listControlsIncludingExpired: jest.fn().mockResolvedValue([]),
    };
    providerRegistry = { getCatalog: jest.fn().mockReturnValue([]) };
    brokerService = { isConnectionExecutable: jest.fn().mockReturnValue(true) };

    service = new AdminLiveAccountService(
      connectionRepo as unknown as Repository<BrokerConnection>,
      accountRepo as unknown as Repository<BrokerAccount>,
      sessionRepo as unknown as Repository<TradingSession>,
      runRepo as unknown as Repository<ReconciliationRun>,
      discrepancyRepo as unknown as Repository<ReconciliationDiscrepancy>,
      auditRepo as unknown as Repository<AuditLog>,
      executionControlService as unknown as ExecutionControlService,
      providerRegistry as unknown as BrokerProviderRegistryService,
      brokerService as unknown as BrokerService,
    );
  });

  // ─── GET /admin/live-account/overview ─────────────────────────────────────

  describe('overview — connection state counts (bucket mapping)', () => {
    it('buckets connectionStatus / authorizationStatus / accountType correctly', async () => {
      connectionRepo.find.mockResolvedValue([
        connection({
          id: 'c1',
          status: BrokerConnectionStatus.CONNECTED,
          authorizationStatus: BrokerAuthorizationStatus.ACTIVE,
          accountType: BrokerMode.LIVE,
        }),
        connection({
          id: 'c2',
          status: BrokerConnectionStatus.CONNECTED,
          authorizationStatus: BrokerAuthorizationStatus.AUTHORIZED,
          accountType: BrokerMode.LIVE,
        }),
        connection({
          id: 'c3',
          status: BrokerConnectionStatus.CONNECTING,
          authorizationStatus: BrokerAuthorizationStatus.READY,
          accountType: BrokerMode.DEMO,
        }),
        connection({
          id: 'c4',
          status: BrokerConnectionStatus.ERROR,
          authorizationStatus: BrokerAuthorizationStatus.AUTHORIZATION_REQUIRED,
          accountType: BrokerMode.DEMO,
        }),
        connection({
          id: 'c5',
          status: BrokerConnectionStatus.DISCONNECTED,
          authorizationStatus: BrokerAuthorizationStatus.REVOKED,
          accountType: BrokerMode.DEMO,
        }),
        connection({
          id: 'c6',
          status: BrokerConnectionStatus.SUSPENDED,
          authorizationStatus: BrokerAuthorizationStatus.SUSPENDED,
          accountType: BrokerMode.LIVE,
        }),
        connection({
          id: 'c7',
          status: BrokerConnectionStatus.CONNECTED,
          authorizationStatus: BrokerAuthorizationStatus.NOT_CONNECTED,
          accountType: BrokerMode.DEMO,
        }),
      ]);

      const overview = await service.getOverview(NOW);

      expect(overview.connections).toEqual({
        total: 7,
        connected: 3,
        connecting: 1,
        error: 1,
        disconnected: 1,
        suspendedConnectionStatus: 1,
        authorized: 3,
        authorizationRequired: 1,
        revoked: 1,
        suspended: 1,
        demo: 4,
        live: 3,
      });
    });

    it('counts connectionStatus SUSPENDED into suspendedConnectionStatus AND toward total (distinct from the authorizationStatus bucket)', async () => {
      connectionRepo.find.mockResolvedValue([
        connection({ status: BrokerConnectionStatus.SUSPENDED }),
      ]);

      const overview = await service.getOverview(NOW);

      expect(overview.connections.total).toBe(1);
      expect(overview.connections.connected).toBe(0);
      expect(overview.connections.connecting).toBe(0);
      expect(overview.connections.error).toBe(0);
      expect(overview.connections.disconnected).toBe(0);
      expect(overview.connections.suspendedConnectionStatus).toBe(1);
    });

    it('accounts for EVERY BrokerConnectionStatus enum value (exhaustiveness)', async () => {
      // One connection per enum member: the counts matrix must account for
      // each of them in an explicit bucket (nothing silently dropped).
      connectionRepo.find.mockResolvedValue(
        (
          [
            BrokerConnectionStatus.CONNECTING,
            BrokerConnectionStatus.CONNECTED,
            BrokerConnectionStatus.DISCONNECTED,
            BrokerConnectionStatus.ERROR,
            BrokerConnectionStatus.SUSPENDED,
          ] as const
        ).map((status, index) => connection({ id: `cx-${index}`, status })),
      );

      const overview = await service.getOverview(NOW);

      expect(overview.connections.total).toBe(5);
      expect(overview.connections.connecting).toBe(1);
      expect(overview.connections.connected).toBe(1);
      expect(overview.connections.disconnected).toBe(1);
      expect(overview.connections.error).toBe(1);
      expect(overview.connections.suspendedConnectionStatus).toBe(1);
      // Every connectionStatus bucket is explicitly represented — the five
      // buckets sum to total (no status counted twice, none missing).
      expect(
        overview.connections.connected +
          overview.connections.connecting +
          overview.connections.error +
          overview.connections.disconnected +
          overview.connections.suspendedConnectionStatus,
      ).toBe(overview.connections.total);
    });

    it('reads ALL connections (admin scope — no user filter)', async () => {
      await service.getOverview(NOW);
      expect(connectionRepo.find).toHaveBeenCalledWith();
    });
  });

  describe('overview — discrepancy counts incl. resolvedLast24h window', () => {
    it('groups OPEN discrepancies by severity', async () => {
      discrepancyRepo.find.mockResolvedValue([
        discrepancy({ severity: ReconciliationDiscrepancySeverity.CRITICAL }),
        discrepancy({ severity: ReconciliationDiscrepancySeverity.CRITICAL }),
        discrepancy({ severity: ReconciliationDiscrepancySeverity.WARNING }),
        discrepancy({ severity: ReconciliationDiscrepancySeverity.INFO }),
      ]);
      discrepancyRepo.count.mockResolvedValue(5);

      const overview = await service.getOverview(NOW);

      expect(discrepancyRepo.find).toHaveBeenCalledWith({
        where: { status: ReconciliationDiscrepancyStatus.OPEN },
      });
      expect(overview.discrepancies).toEqual({
        open: 4,
        openCritical: 2,
        openWarning: 1,
        openInfo: 1,
        resolvedLast24h: 5,
      });
    });

    it('counts resolvedLast24h against the 24h window on resolvedAt', async () => {
      discrepancyRepo.count.mockResolvedValue(2);

      await service.getOverview(NOW);

      const countArgs = discrepancyRepo.count.mock.calls[0][0];
      expect(countArgs.where.status).toBe(ReconciliationDiscrepancyStatus.RESOLVED);
      const expectedCutoff = new Date(NOW.getTime() - ADMIN_RESOLVED_WINDOW_MS);
      expectMoreThanOrEqualDate(countArgs.where.resolvedAt, expectedCutoff);
    });

    it('returns zeroed discrepancy counts on an empty store', async () => {
      const overview = await service.getOverview(NOW);
      expect(overview.discrepancies).toEqual({
        open: 0,
        openCritical: 0,
        openWarning: 0,
        openInfo: 0,
        resolvedLast24h: 0,
      });
    });
  });

  describe('overview — active controls (REUSED ExecutionControlService)', () => {
    it('maps listActiveControls views with normalized targets + ISO dates', async () => {
      executionControlService.listActiveControls.mockResolvedValue([
        controlView({ id: 'ctl-global', scope: ExecutionControlScope.GLOBAL, scopeKey: null }),
        controlView({
          id: 'ctl-provider',
          scope: ExecutionControlScope.PROVIDER,
          scopeKey: 'metatrader5',
        }),
        controlView({
          id: 'ctl-user',
          scope: ExecutionControlScope.USER,
          scopeKey: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
        }),
        controlView({
          id: 'ctl-conn',
          scope: ExecutionControlScope.BROKER_CONNECTION,
          scopeKey: '12345678-1234-5678-9012-abcdefabcdef',
          expiresAt: new Date('2026-01-16T10:00:00Z'),
        }),
      ]);

      const overview = await service.getOverview(NOW);

      expect(executionControlService.listActiveControls).toHaveBeenCalledTimes(1);
      expect(overview.activeControls).toEqual([
        {
          id: 'ctl-global',
          scope: 'GLOBAL',
          scopeTarget: null,
          reason: 'incident response',
          activatedBy: 'admin-1',
          activatedAt: '2026-01-15T10:00:00.000Z',
          expiresAt: null,
          status: 'ACTIVE',
        },
        {
          id: 'ctl-provider',
          scope: 'PROVIDER',
          scopeTarget: 'metatrader5',
          reason: 'incident response',
          activatedBy: 'admin-1',
          activatedAt: '2026-01-15T10:00:00.000Z',
          expiresAt: null,
          status: 'ACTIVE',
        },
        {
          id: 'ctl-user',
          scope: 'USER',
          scopeTarget: '•••7890',
          reason: 'incident response',
          activatedBy: 'admin-1',
          activatedAt: '2026-01-15T10:00:00.000Z',
          expiresAt: null,
          status: 'ACTIVE',
        },
        {
          id: 'ctl-conn',
          scope: 'BROKER_CONNECTION',
          scopeTarget: '•••cdef',
          reason: 'incident response',
          activatedBy: 'admin-1',
          activatedAt: '2026-01-15T10:00:00.000Z',
          expiresAt: '2026-01-16T10:00:00.000Z',
          status: 'ACTIVE',
        },
      ]);
    });

    it('sanitizes control reasons to plain text (secret-like runs stripped)', async () => {
      executionControlService.listActiveControls.mockResolvedValue([
        controlView({
          reason: 'MetaApi token abcdefghijklmnop123 rejected by provider',
        }),
      ]);

      const overview = await service.getOverview(NOW);

      expect(overview.activeControls[0].reason).not.toMatch(/abcdefghijklmnop123/);
      expect(overview.activeControls[0].reason).toContain('…');
    });

    it('caps sanitized reasons at the 500-char entity limit', async () => {
      executionControlService.listActiveControls.mockResolvedValue([
        controlView({ reason: 'incident in progress. '.repeat(35) }),
      ]);

      const overview = await service.getOverview(NOW);

      expect(overview.activeControls[0].reason?.length).toBe(500);
    });
  });

  describe('overview — expired controls (retained records, never blocking)', () => {
    it('includes expiredControls with status EXPIRED rows; activeControls excludes them', async () => {
      executionControlService.listActiveControls.mockResolvedValue([
        controlView({ id: 'ctl-live', status: ExecutionControlStatus.ACTIVE }),
      ]);
      executionControlService.listControlsIncludingExpired.mockResolvedValue([
        controlView({ id: 'ctl-live', status: ExecutionControlStatus.ACTIVE }),
        controlView({
          id: 'ctl-old',
          status: ExecutionControlStatus.EXPIRED,
          activatedAt: new Date('2026-01-10T10:00:00Z'),
          expiresAt: new Date('2026-01-11T10:00:00Z'),
        }),
      ]);

      const overview = await service.getOverview(NOW);

      // Active inventory: ACTIVE only (the "currently blocking" list).
      expect(overview.activeControls.map((control) => control.id)).toEqual(['ctl-live']);
      expect(overview.activeControls.every((control) => control.status === 'ACTIVE')).toBe(true);
      // Expired inventory: EXPIRED rows only, count + rows.
      expect(overview.expiredControls.count).toBe(1);
      expect(overview.expiredControls.controls).toEqual([
        {
          id: 'ctl-old',
          scope: 'GLOBAL',
          scopeTarget: null,
          reason: 'incident response',
          activatedBy: 'admin-1',
          activatedAt: '2026-01-10T10:00:00.000Z',
          expiresAt: '2026-01-11T10:00:00.000Z',
          status: 'EXPIRED',
        },
      ]);
    });

    it('uses listActiveControls for the active inventory and listControlsIncludingExpired for the expired one', async () => {
      await service.getOverview(NOW);

      expect(executionControlService.listActiveControls).toHaveBeenCalledTimes(1);
      expect(executionControlService.listControlsIncludingExpired).toHaveBeenCalledTimes(1);
    });

    it('bounds the expired list to the 50 most recent rows by activatedAt desc (count keeps the total)', async () => {
      const expiredViews = Array.from({ length: ADMIN_EXPIRED_CONTROLS_MAX_ROWS + 20 }, (_, i) =>
        controlView({
          id: `ctl-exp-${i}`,
          status: ExecutionControlStatus.EXPIRED,
          activatedAt: new Date(Date.UTC(2026, 0, 1 + i, 10, 0, 0)),
        }),
      );
      executionControlService.listControlsIncludingExpired.mockResolvedValue(expiredViews);

      const overview = await service.getOverview(NOW);

      expect(overview.expiredControls.count).toBe(ADMIN_EXPIRED_CONTROLS_MAX_ROWS + 20);
      expect(overview.expiredControls.controls).toHaveLength(ADMIN_EXPIRED_CONTROLS_MAX_ROWS);
      // Most recent first: the newest activation leads the bounded list.
      expect(overview.expiredControls.controls[0].id).toBe(
        `ctl-exp-${ADMIN_EXPIRED_CONTROLS_MAX_ROWS + 19}`,
      );
      expect(overview.expiredControls.controls[ADMIN_EXPIRED_CONTROLS_MAX_ROWS - 1].id).toBe(
        'ctl-exp-20',
      );
    });

    it('returns a zeroed expired inventory on an empty store', async () => {
      const overview = await service.getOverview(NOW);

      expect(overview.expiredControls).toEqual({ count: 0, controls: [] });
    });
  });

  describe('overview — provider registry mapping', () => {
    it('maps brokerId/brokerName/capabilities/supportsDemo/supportsLive', async () => {
      providerRegistry.getCatalog.mockReturnValue([
        registryEntry(),
        registryEntry({
          id: 'oanda',
          name: 'OANDA',
          capabilities: ['OAUTH'],
          environments: ['DEMO'],
        }),
        registryEntry({
          id: 'paper-broker',
          name: 'Paper Broker',
          capabilities: [],
          environments: ['LIVE'],
        }),
      ]);

      const overview = await service.getOverview(NOW);

      expect(overview.providers).toEqual([
        {
          brokerId: 'metatrader5',
          brokerName: 'MetaTrader 5',
          capabilities: ['ACCOUNT_READ', 'ORDER_READ'],
          supportsDemo: true,
          supportsLive: true,
        },
        {
          brokerId: 'oanda',
          brokerName: 'OANDA',
          capabilities: ['OAUTH'],
          supportsDemo: true,
          supportsLive: false,
        },
        {
          brokerId: 'paper-broker',
          brokerName: 'Paper Broker',
          capabilities: [],
          supportsDemo: false,
          supportsLive: true,
        },
      ]);
    });

    it('copies the capabilities array (no shared reference with the registry)', async () => {
      const capabilities = ['ACCOUNT_READ'];
      providerRegistry.getCatalog.mockReturnValue([registryEntry({ capabilities })]);

      const overview = await service.getOverview(NOW);

      expect(overview.providers[0].capabilities).not.toBe(capabilities);
    });
  });

  describe('overview — automation counts', () => {
    it('counts ACTIVE sessions and risk/broker-suspended sessions separately', async () => {
      sessionRepo.count.mockImplementation((options: { where: { status: unknown } }) =>
        Promise.resolve(options.where.status === TradingSessionStatus.ACTIVE ? 4 : 2),
      );

      const overview = await service.getOverview(NOW);

      expect(sessionRepo.count).toHaveBeenCalledTimes(2);
      expect(sessionRepo.count).toHaveBeenNthCalledWith(1, {
        where: { status: TradingSessionStatus.ACTIVE },
      });
      expect(overview.automation).toEqual({ activeSessions: 4, suspendedSessions: 2 });
    });

    it('uses an In() operator for the suspended-status pair', async () => {
      await service.getOverview(NOW);

      const secondCallArgs = sessionRepo.count.mock.calls[1][0];
      expectInOperator(secondCallArgs.where.status, [
        TradingSessionStatus.SUSPENDED_RISK_LIMIT,
        TradingSessionStatus.SUSPENDED_BROKER,
      ]);
    });
  });

  describe('overview — output redaction', () => {
    it('never serializes credential material into the overview payload', async () => {
      connectionRepo.find.mockResolvedValue([connection()]);

      const overview = await service.getOverview(NOW);
      const serialized = JSON.stringify(overview);

      expect(serialized).not.toContain('encryptedCredentials');
      expect(serialized).not.toContain('credentialIv');
      expect(serialized).not.toContain('credentialTag');
      expect(serialized).not.toContain('encryptionKeyId');
      expect(serialized).not.toContain('aGVsbG8gd29ybGQ');
    });

    it('stamps generatedAt with the request-time ISO timestamp', async () => {
      const overview = await service.getOverview(NOW);
      expect(overview.generatedAt).toBe(NOW.toISOString());
    });
  });

  // ─── GET /admin/live-account/connections ──────────────────────────────────

  describe('connections — filter matrix', () => {
    const expectWhere = async (
      filter: string,
      expectedWhere: Record<string, unknown> | undefined,
    ) => {
      connectionRepo.find.mockResolvedValue([]);
      await service.getConnections(filter, 25, 10);
      const findArgs = connectionRepo.find.mock.calls[0][0];
      if (expectedWhere === undefined) {
        expect(findArgs.where).toBeUndefined();
        expect(connectionRepo.count).toHaveBeenCalledWith({});
      } else {
        expect(findArgs.where).toEqual(expectedWhere);
        expect(connectionRepo.count).toHaveBeenCalledWith({ where: expectedWhere });
      }
      expect(findArgs.order).toEqual({ createdAt: 'DESC' });
      expect(findArgs.take).toBe(25);
      expect(findArgs.skip).toBe(10);
    };

    it('ALL → no where filter', async () => {
      await expectWhere('ALL', undefined);
    });

    it('CONNECTED → connectionStatus = CONNECTED', async () => {
      await expectWhere('CONNECTED', { status: BrokerConnectionStatus.CONNECTED });
    });

    it('ERROR → connectionStatus = ERROR', async () => {
      await expectWhere('ERROR', { status: BrokerConnectionStatus.ERROR });
    });

    it('LIVE → accountType = LIVE', async () => {
      await expectWhere('LIVE', { accountType: BrokerMode.LIVE });
    });

    it('DEMO → accountType = DEMO', async () => {
      await expectWhere('DEMO', { accountType: BrokerMode.DEMO });
    });

    it('invalid filter falls back to ALL', async () => {
      await expectWhere('NOT_A_FILTER', undefined);
    });

    it('undefined filter falls back to ALL', async () => {
      await expectWhere(undefined as unknown as string, undefined);
    });
  });

  describe('connections — pagination', () => {
    it('applies take/skip from limit/offset and returns the count total', async () => {
      connectionRepo.count.mockResolvedValue(137);

      const page = await service.getConnections('ALL', 50, 100);

      expect(connectionRepo.find.mock.calls[0][0].take).toBe(50);
      expect(connectionRepo.find.mock.calls[0][0].skip).toBe(100);
      expect(page.total).toBe(137);
      expect(page.limit).toBe(50);
      expect(page.offset).toBe(100);
    });

    it('clamps limit into 1..100 and offset to ≥ 0 (idempotent with the controller)', async () => {
      await service.getConnections('ALL', 5000, -42);

      const findArgs = connectionRepo.find.mock.calls[0][0];
      expect(findArgs.take).toBe(100);
      expect(findArgs.skip).toBe(0);
    });
  });

  describe('connections — row mapping', () => {
    it('masks the account id to the last 4 characters', async () => {
      connectionRepo.find.mockResolvedValue([connection({ accountId: '1234567890123' })]);

      const page = await service.getConnections('ALL', 50, 0);

      expect(page.connections[0].maskedAccountId).toBe('•••0123');
      expect(JSON.stringify(page)).not.toContain('1234567890123');
    });

    it('returns null maskedAccountId for absent or too-short identifiers', async () => {
      connectionRepo.find.mockResolvedValue([
        connection({ id: 'c-null', accountId: null }),
        connection({ id: 'c-short', accountId: '123' }),
      ]);

      const page = await service.getConnections('ALL', 50, 0);

      expect(page.connections[0].maskedAccountId).toBeNull();
      expect(page.connections[1].maskedAccountId).toBeNull();
    });

    it('delegates executable to the Sprint 50 gate (true passes through)', async () => {
      brokerService.isConnectionExecutable.mockReturnValue(true);
      connectionRepo.find.mockResolvedValue([connection()]);

      const page = await service.getConnections('ALL', 50, 0);

      expect(brokerService.isConnectionExecutable).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'conn-1' }),
      );
      expect(page.connections[0].executable).toBe(true);
    });

    it('propagates gate=false as executable=false', async () => {
      brokerService.isConnectionExecutable.mockReturnValue(false);
      connectionRepo.find.mockResolvedValue([connection()]);

      const page = await service.getConnections('ALL', 50, 0);

      expect(page.connections[0].executable).toBe(false);
    });

    it('fails CLOSED (executable=false, no throw) when the gate throws', async () => {
      brokerService.isConnectionExecutable.mockImplementation(() => {
        throw new Error('gate unavailable');
      });
      connectionRepo.find.mockResolvedValue([connection()]);

      const page = await service.getConnections('ALL', 50, 0);

      expect(page.connections[0].executable).toBe(false);
    });

    it('sanitizes lastErrorMessage (secret-like runs stripped) and truncates to 200 chars', async () => {
      connectionRepo.find.mockResolvedValue([
        connection({ id: 'c-secret', lastErrorMessage: 'token abcdefghijklmnop rejected' }),
        connection({ id: 'c-long', lastErrorMessage: 'provider handshake failed. '.repeat(10) }),
        connection({ id: 'c-null', lastErrorMessage: null }),
      ]);

      const page = await service.getConnections('ALL', 50, 0);

      expect(page.connections[0].lastErrorMessage).not.toContain('abcdefghijklmnop');
      expect(page.connections[0].lastErrorMessage).toContain('…');
      expect(page.connections[1].lastErrorMessage?.length).toBe(ADMIN_ERROR_MESSAGE_MAX_LENGTH);
      expect(page.connections[2].lastErrorMessage).toBeNull();
    });

    it('maps the full row shape with ISO dates and strict liveTradingEnabled coercion', async () => {
      connectionRepo.find.mockResolvedValue([
        connection({ id: 'c-strict', liveTradingEnabled: 'yes' as unknown as boolean }),
      ]);

      const page = await service.getConnections('ALL', 50, 0);

      // Strict `=== true` — a non-boolean truthy value must NOT flip the flag.
      expect(page.connections[0].liveTradingEnabled).toBe(false);
      expect(page.connections[0]).toMatchObject({
        id: 'c-strict',
        userId: 'user-1',
        brokerId: 'metatrader5',
        brokerName: 'MetaTrader 5',
        displayName: 'Primary account',
        accountType: 'DEMO',
        connectionStatus: 'CONNECTED',
        authorizationStatus: 'ACTIVE',
        credentialStatus: 'VERIFIED',
        lastSyncAt: '2026-01-15T11:55:00.000Z',
        lastHealthCheckAt: '2026-01-15T11:55:00.000Z',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-15T11:55:00.000Z',
      });
    });
  });

  describe('connections — openDiscrepancies enrichment', () => {
    it('runs a single grouped count query over OPEN discrepancies by connectionId', async () => {
      connectionRepo.find.mockResolvedValue([
        connection({ id: 'conn-1' }),
        connection({ id: 'conn-2' }),
      ]);
      discrepancyRepo.find.mockResolvedValue([
        { brokerConnectionId: 'conn-1' },
        { brokerConnectionId: 'conn-1' },
        { brokerConnectionId: 'conn-2' },
      ] as ReconciliationDiscrepancy[]);

      const page = await service.getConnections('ALL', 50, 0);

      expect(discrepancyRepo.find).toHaveBeenCalledWith({
        where: { status: ReconciliationDiscrepancyStatus.OPEN },
        select: ['brokerConnectionId'],
      });
      expect(page.connections[0].openDiscrepancies).toBe(2);
      expect(page.connections[1].openDiscrepancies).toBe(1);
    });

    it('defaults openDiscrepancies to 0 for connections without OPEN rows', async () => {
      connectionRepo.find.mockResolvedValue([connection({ id: 'conn-9' })]);
      discrepancyRepo.find.mockResolvedValue([]);

      const page = await service.getConnections('ALL', 50, 0);

      expect(page.connections[0].openDiscrepancies).toBe(0);
    });
  });

  // ─── GET /admin/live-account/reconciliation/discrepancies ─────────────────

  describe('discrepancies — filter matrix', () => {
    const expectWhere = async (
      filter: string,
      expectedWhere: Record<string, unknown> | undefined,
    ) => {
      discrepancyRepo.find.mockResolvedValue([]);
      await service.getDiscrepancies(filter, 25, 10);
      const findArgs = discrepancyRepo.find.mock.calls[0][0];
      if (expectedWhere === undefined) {
        expect(findArgs.where).toBeUndefined();
        expect(discrepancyRepo.count).toHaveBeenCalledWith({});
      } else {
        expect(findArgs.where).toEqual(expectedWhere);
        expect(discrepancyRepo.count).toHaveBeenCalledWith({ where: expectedWhere });
      }
      expect(findArgs.order).toEqual({ firstDetectedAt: 'DESC' });
      expect(findArgs.take).toBe(25);
      expect(findArgs.skip).toBe(10);
    };

    it('ALL → no where filter', async () => {
      await expectWhere('ALL', undefined);
    });

    it('OPEN → status = OPEN', async () => {
      await expectWhere('OPEN', { status: ReconciliationDiscrepancyStatus.OPEN });
    });

    it('RESOLVED → status = RESOLVED', async () => {
      await expectWhere('RESOLVED', { status: ReconciliationDiscrepancyStatus.RESOLVED });
    });

    it('CRITICAL → severity = CRITICAL AND status = OPEN (severity implies open)', async () => {
      await expectWhere('CRITICAL', {
        severity: ReconciliationDiscrepancySeverity.CRITICAL,
        status: ReconciliationDiscrepancyStatus.OPEN,
      });
    });

    it('WARNING → severity = WARNING AND status = OPEN (severity implies open)', async () => {
      await expectWhere('WARNING', {
        severity: ReconciliationDiscrepancySeverity.WARNING,
        status: ReconciliationDiscrepancyStatus.OPEN,
      });
    });

    it('invalid filter falls back to ALL', async () => {
      await expectWhere('BOGUS', undefined);
    });
  });

  describe('discrepancies — pagination', () => {
    it('applies take/skip and returns the count total', async () => {
      discrepancyRepo.count.mockResolvedValue(42);

      const page = await service.getDiscrepancies('OPEN', 30, 60);

      expect(discrepancyRepo.find.mock.calls[0][0].take).toBe(30);
      expect(discrepancyRepo.find.mock.calls[0][0].skip).toBe(60);
      expect(page.total).toBe(42);
      expect(page.limit).toBe(30);
      expect(page.offset).toBe(60);
    });
  });

  describe('discrepancies — row mapping + description derivation', () => {
    it('prefers the details note as the description', async () => {
      discrepancyRepo.find.mockResolvedValue([
        discrepancy({
          details: { note: 'Provider reports neither a working order nor an open position' },
        }),
      ]);

      const page = await service.getDiscrepancies('ALL', 50, 0);

      expect(page.discrepancies[0].description).toBe(
        'Provider reports neither a working order nor an open position',
      );
    });

    it('falls back to key=value pairs when there is no note', async () => {
      discrepancyRepo.find.mockResolvedValue([discrepancy()]);

      const page = await service.getDiscrepancies('ALL', 50, 0);

      expect(page.discrepancies[0].description).toBe('expected=FILLED; observed=ACKNOWLEDGED');
    });

    it('falls back to the discrepancy type when details are empty', async () => {
      discrepancyRepo.find.mockResolvedValue([discrepancy({ details: null })]);

      const page = await service.getDiscrepancies('ALL', 50, 0);

      expect(page.discrepancies[0].description).toBe('STALE_ORDER_STATE');
    });

    it('sanitizes the description (secret-like runs stripped) and truncates to 300 chars', async () => {
      discrepancyRepo.find.mockResolvedValue([
        discrepancy({ details: { note: 'secret abcdefghijklmnop leaked' } }),
        discrepancy({ details: { note: 'provider drift detected. '.repeat(15) } }),
      ]);

      const page = await service.getDiscrepancies('ALL', 50, 0);

      expect(page.discrepancies[0].description).not.toContain('abcdefghijklmnop');
      expect(page.discrepancies[1].description.length).toBe(ADMIN_DESCRIPTION_MAX_LENGTH);
    });

    it('maps resolved rows with resolutionNote and ISO detectedAt/resolvedAt', async () => {
      discrepancyRepo.find.mockResolvedValue([
        discrepancy({
          status: ReconciliationDiscrepancyStatus.RESOLVED,
          resolvedAt: new Date('2026-01-15T11:00:00Z'),
          resolution: 'Order confirmed at provider after re-fetch',
          firstDetectedAt: new Date('2026-01-15T10:00:00Z'),
        }),
      ]);

      const page = await service.getDiscrepancies('RESOLVED', 50, 0);

      expect(page.discrepancies[0]).toMatchObject({
        id: 'disc-1',
        userId: 'user-1',
        brokerConnectionId: 'conn-1',
        type: 'STALE_ORDER_STATE',
        severity: 'WARNING',
        status: 'RESOLVED',
        internalRefId: 'order-1',
        providerRef: 'ticket-1',
        detectedAt: '2026-01-15T10:00:00.000Z',
        resolvedAt: '2026-01-15T11:00:00.000Z',
        resolutionNote: 'Order confirmed at provider after re-fetch',
      });
    });

    it('enriches brokerId from a single connection query (In operator, deduplicated)', async () => {
      discrepancyRepo.find.mockResolvedValue([
        discrepancy({ id: 'd1', brokerConnectionId: 'conn-1' }),
        discrepancy({ id: 'd2', brokerConnectionId: 'conn-1' }),
        discrepancy({ id: 'd3', brokerConnectionId: 'conn-2' }),
      ]);
      connectionRepo.find.mockResolvedValue([
        connection({ id: 'conn-1', brokerId: 'metatrader5' }),
        connection({ id: 'conn-2', brokerId: 'oanda' }),
      ]);

      const page = await service.getDiscrepancies('ALL', 50, 0);

      expectInOperator(connectionRepo.find.mock.calls[0][0].where.id, ['conn-1', 'conn-2']);
      expect(connectionRepo.find.mock.calls[0][0].select).toEqual(['id', 'brokerId']);
      expect(page.discrepancies[0].brokerId).toBe('metatrader5');
      expect(page.discrepancies[2].brokerId).toBe('oanda');
    });

    it("maps orphaned discrepancies (connection row gone) to brokerId 'unknown'", async () => {
      discrepancyRepo.find.mockResolvedValue([discrepancy({ brokerConnectionId: 'conn-gone' })]);
      connectionRepo.find.mockResolvedValue([]);

      const page = await service.getDiscrepancies('ALL', 50, 0);

      expect(page.discrepancies[0].brokerId).toBe(ADMIN_UNKNOWN_BROKER_ID);
    });

    it('skips the enrichment query when there are no rows', async () => {
      discrepancyRepo.find.mockResolvedValue([]);

      await service.getDiscrepancies('ALL', 50, 0);

      expect(connectionRepo.find).not.toHaveBeenCalled();
    });
  });

  // ─── GET /admin/audit/logs ────────────────────────────────────────────────

  describe('audit — filters (equality-only, only when non-empty)', () => {
    const expectWhere = async (
      args: {
        filter?: string;
        actorUserId?: string | null;
        resourceType?: string | null;
      },
      expectedWhere: Record<string, unknown>,
    ) => {
      auditRepo.find.mockResolvedValue([]);
      await service.getAuditLogs(args.filter, args.actorUserId, args.resourceType, 25, 10);
      const findArgs = auditRepo.find.mock.calls[0][0];
      expect(findArgs.where).toEqual(expectedWhere);
      expect(auditRepo.count).toHaveBeenCalledWith({ where: expectedWhere });
      expect(findArgs.order).toEqual({ createdAt: 'DESC' });
      expect(findArgs.take).toBe(25);
      expect(findArgs.skip).toBe(10);
    };

    it('ALL → empty where (no severity, actor, or resource filters)', async () => {
      await expectWhere({ filter: 'ALL' }, {});
    });

    it('CRITICAL → severity equality', async () => {
      await expectWhere({ filter: 'CRITICAL' }, { severity: 'CRITICAL' });
    });

    it('WARNING → severity equality', async () => {
      await expectWhere({ filter: 'WARNING' }, { severity: 'WARNING' });
    });

    it('invalid filter falls back to ALL', async () => {
      await expectWhere({ filter: 'INFO' }, {});
    });

    it('actorUserId is applied as an equality filter when non-empty', async () => {
      await expectWhere(
        { filter: 'ALL', actorUserId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' },
        { actorUserId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' },
      );
    });

    it('whitespace-only actorUserId is ignored', async () => {
      await expectWhere({ filter: 'ALL', actorUserId: '   ' }, {});
    });

    it('resourceType is applied as an equality filter when non-empty (trimmed)', async () => {
      await expectWhere(
        { filter: 'ALL', resourceType: '  ExecutionControl  ' },
        {
          resourceType: 'ExecutionControl',
        },
      );
    });

    it('null actor/resource filters are ignored', async () => {
      await expectWhere(
        { filter: 'CRITICAL', actorUserId: null, resourceType: null },
        {
          severity: 'CRITICAL',
        },
      );
    });

    it('combines severity + actor + resource equality filters', async () => {
      await expectWhere(
        {
          filter: 'CRITICAL',
          actorUserId: 'user-9',
          resourceType: 'ExecutionControl',
        },
        { severity: 'CRITICAL', actorUserId: 'user-9', resourceType: 'ExecutionControl' },
      );
    });

    it('truncates an over-long actorUserId to the 64-char bound (trimmed first)', async () => {
      const overLong = `x`.repeat(ADMIN_AUDIT_ACTOR_FILTER_MAX_LENGTH + 40);
      await expectWhere(
        { filter: 'ALL', actorUserId: overLong },
        { actorUserId: overLong.slice(0, ADMIN_AUDIT_ACTOR_FILTER_MAX_LENGTH) },
      );
    });

    it('truncates an over-long resourceType to the 100-char bound (trimmed first)', async () => {
      const overLong = `R`.repeat(ADMIN_AUDIT_RESOURCE_FILTER_MAX_LENGTH + 75);
      await expectWhere(
        { filter: 'ALL', resourceType: overLong },
        { resourceType: overLong.slice(0, ADMIN_AUDIT_RESOURCE_FILTER_MAX_LENGTH) },
      );
    });

    it('keeps values at exactly the bound untouched (boundary)', async () => {
      const actor = `a`.repeat(ADMIN_AUDIT_ACTOR_FILTER_MAX_LENGTH);
      const resource = `r`.repeat(ADMIN_AUDIT_RESOURCE_FILTER_MAX_LENGTH);
      await expectWhere(
        { filter: 'ALL', actorUserId: actor, resourceType: resource },
        { actorUserId: actor, resourceType: resource },
      );
    });
  });

  describe('audit — pagination', () => {
    it('applies take/skip and returns the count total', async () => {
      auditRepo.count.mockResolvedValue(500);

      const page = await service.getAuditLogs('ALL', null, null, 100, 400);

      expect(auditRepo.find.mock.calls[0][0].take).toBe(100);
      expect(auditRepo.find.mock.calls[0][0].skip).toBe(400);
      expect(page.total).toBe(500);
      expect(page.limit).toBe(100);
      expect(page.offset).toBe(400);
    });

    it('clamps pagination defensively', async () => {
      await service.getAuditLogs('ALL', null, null, -3, -10);

      const findArgs = auditRepo.find.mock.calls[0][0];
      expect(findArgs.take).toBe(1);
      expect(findArgs.skip).toBe(0);
    });
  });

  describe('audit — row mapping + severity fallback', () => {
    it('maps the persisted severity column directly', async () => {
      auditRepo.find.mockResolvedValue([
        auditLog({ severity: AuditSeverity.CRITICAL }),
        auditLog({ severity: AuditSeverity.WARNING }),
        auditLog({ severity: AuditSeverity.INFO }),
      ]);

      const page = await service.getAuditLogs('ALL', null, null, 50, 0);

      expect(page.logs.map((log) => log.severity)).toEqual(['CRITICAL', 'WARNING', 'INFO']);
    });

    it('derives severity from the action name for null legacy rows', async () => {
      auditRepo.find.mockResolvedValue([
        auditLog({
          severity: null as unknown as AuditSeverity,
          action: 'EXECUTION_CONTROL_ACTIVATED',
        }),
        auditLog({ severity: null as unknown as AuditSeverity, action: 'ORDER_REJECTED' }),
        auditLog({ severity: null as unknown as AuditSeverity, action: 'ORDER_SUBMITTED' }),
      ]);

      const page = await service.getAuditLogs('ALL', null, null, 50, 0);

      expect(page.logs.map((log) => log.severity)).toEqual(['CRITICAL', 'WARNING', 'INFO']);
    });

    it('maps the full row shape with ISO createdAt', async () => {
      auditRepo.find.mockResolvedValue([
        auditLog({
          correlationId: 'b2c3d4e5-f6a7-8901-bcde-f12345678901',
          actorType: 'ADMIN',
        }),
      ]);

      const page = await service.getAuditLogs('ALL', null, null, 50, 0);

      expect(page.logs[0]).toMatchObject({
        id: 'audit-1',
        action: 'ORDER_SUBMITTED',
        actorType: 'ADMIN',
        actorUserId: 'user-1',
        resourceType: 'Order',
        resourceId: 'order-1',
        correlationId: 'b2c3d4e5-f6a7-8901-bcde-f12345678901',
        severity: 'INFO',
        createdAt: '2026-01-15T11:00:00.000Z',
      });
    });

    it('NEVER serializes metadata, ipAddress, or userAgent into the page', async () => {
      auditRepo.find.mockResolvedValue([auditLog()]);

      const page = await service.getAuditLogs('ALL', null, null, 50, 0);
      const serialized = JSON.stringify(page);

      expect(serialized).not.toContain('metadata');
      expect(serialized).not.toContain('apiKey');
      expect(serialized).not.toContain('secret-never-expose');
      expect(serialized).not.toContain('ipAddress');
      expect(serialized).not.toContain('203.0.113.10');
      expect(serialized).not.toContain('userAgent');
      expect(serialized).not.toContain('Mozilla');
    });
  });

  // ─── Pure helpers ─────────────────────────────────────────────────────────

  describe('pure helpers', () => {
    it('clampPaginationLimit clamps into 1..100', () => {
      expect(clampPaginationLimit(0)).toBe(1);
      expect(clampPaginationLimit(-10)).toBe(1);
      expect(clampPaginationLimit(50)).toBe(50);
      expect(clampPaginationLimit(101)).toBe(100);
      expect(clampPaginationLimit(Number.NaN)).toBe(50);
    });

    it('clampPaginationOffset clamps to ≥ 0', () => {
      expect(clampPaginationOffset(-1)).toBe(0);
      expect(clampPaginationOffset(0)).toBe(0);
      expect(clampPaginationOffset(7)).toBe(7);
      expect(clampPaginationOffset(Number.POSITIVE_INFINITY)).toBe(0);
    });

    it('normalizeAdminConnectionFilter accepts only the five valid values', () => {
      expect(normalizeAdminConnectionFilter('CONNECTED')).toBe(AdminConnectionFilter.CONNECTED);
      expect(normalizeAdminConnectionFilter('ERROR')).toBe(AdminConnectionFilter.ERROR);
      expect(normalizeAdminConnectionFilter('LIVE')).toBe(AdminConnectionFilter.LIVE);
      expect(normalizeAdminConnectionFilter('DEMO')).toBe(AdminConnectionFilter.DEMO);
      expect(normalizeAdminConnectionFilter('ALL')).toBe(AdminConnectionFilter.ALL);
      expect(normalizeAdminConnectionFilter('live')).toBe(AdminConnectionFilter.ALL);
      expect(normalizeAdminConnectionFilter(null)).toBe(AdminConnectionFilter.ALL);
      expect(normalizeAdminConnectionFilter(undefined)).toBe(AdminConnectionFilter.ALL);
    });

    it('normalizeAdminDiscrepancyFilter accepts only the five valid values', () => {
      expect(normalizeAdminDiscrepancyFilter('OPEN')).toBe(AdminDiscrepancyFilter.OPEN);
      expect(normalizeAdminDiscrepancyFilter('RESOLVED')).toBe(AdminDiscrepancyFilter.RESOLVED);
      expect(normalizeAdminDiscrepancyFilter('CRITICAL')).toBe(AdminDiscrepancyFilter.CRITICAL);
      expect(normalizeAdminDiscrepancyFilter('WARNING')).toBe(AdminDiscrepancyFilter.WARNING);
      expect(normalizeAdminDiscrepancyFilter('ALL')).toBe(AdminDiscrepancyFilter.ALL);
      expect(normalizeAdminDiscrepancyFilter('critical')).toBe(AdminDiscrepancyFilter.ALL);
    });

    it('normalizeAdminAuditFilter accepts ALL/CRITICAL/WARNING only', () => {
      expect(normalizeAdminAuditFilter('CRITICAL')).toBe(AdminAuditLogFilter.CRITICAL);
      expect(normalizeAdminAuditFilter('WARNING')).toBe(AdminAuditLogFilter.WARNING);
      expect(normalizeAdminAuditFilter('ALL')).toBe(AdminAuditLogFilter.ALL);
      expect(normalizeAdminAuditFilter('INFO')).toBe(AdminAuditLogFilter.ALL);
      expect(normalizeAdminAuditFilter(undefined)).toBe(AdminAuditLogFilter.ALL);
    });

    it('sanitizeAdminText strips secret-like runs, truncates, and nulls empties', () => {
      expect(sanitizeAdminText('key abcdefghijklmnop leaked', 200)).toBe('key … leaked');
      expect(sanitizeAdminText('provider failed. '.repeat(20), 200)?.length).toBe(200);
      expect(sanitizeAdminText(null, 200)).toBeNull();
      expect(sanitizeAdminText('', 200)).toBeNull();
      expect(sanitizeAdminText('   ', 200)).toBeNull();
    });

    it('maskControlScopeTarget masks to the last 4 characters', () => {
      expect(maskControlScopeTarget('a1b2c3d4-e5f6-7890-abcd-ef1234567890')).toBe('•••7890');
      expect(maskControlScopeTarget(null)).toBeNull();
      expect(maskControlScopeTarget('abc')).toBeNull();
    });

    it('boundAdminAuditFilter trims, truncates to the bound, and empties unusable values', () => {
      expect(boundAdminAuditFilter(null, 64)).toBe('');
      expect(boundAdminAuditFilter(undefined, 64)).toBe('');
      expect(boundAdminAuditFilter('   ', 64)).toBe('');
      expect(boundAdminAuditFilter('  user-9  ', 64)).toBe('user-9');
      const overLong = 'x'.repeat(80);
      expect(boundAdminAuditFilter(overLong, 64)).toBe(overLong.slice(0, 64));
      expect(boundAdminAuditFilter(overLong, 64).length).toBe(64);
    });

    it('deriveDiscrepancyDescription prefers note → pairs → type', () => {
      expect(
        deriveDiscrepancyDescription({
          type: 'STALE_ORDER_STATE' as ReconciliationDiscrepancyType,
          details: { note: 'note text' },
        }),
      ).toBe('note text');
      expect(
        deriveDiscrepancyDescription({
          type: 'STALE_ORDER_STATE' as ReconciliationDiscrepancyType,
          details: { expected: 'FILLED' },
        }),
      ).toBe('expected=FILLED');
      expect(
        deriveDiscrepancyDescription({
          type: 'STALE_ORDER_STATE' as ReconciliationDiscrepancyType,
          details: null,
        }),
      ).toBe('STALE_ORDER_STATE');
    });

    it('deriveAdminAuditSeverity maps direct severities and action-name fallbacks', () => {
      expect(deriveAdminAuditSeverity({ severity: AuditSeverity.CRITICAL, action: 'X' })).toBe(
        'CRITICAL',
      );
      expect(deriveAdminAuditSeverity({ severity: AuditSeverity.WARNING, action: 'X' })).toBe(
        'WARNING',
      );
      expect(deriveAdminAuditSeverity({ severity: AuditSeverity.INFO, action: 'X' })).toBe('INFO');
      expect(
        deriveAdminAuditSeverity({
          severity: undefined as unknown as AuditSeverity,
          action: 'KILL_SWITCH_ACTIVATED',
        }),
      ).toBe('CRITICAL');
      expect(
        deriveAdminAuditSeverity({
          severity: undefined as unknown as AuditSeverity,
          action: 'CREDENTIALS_REVOKED',
        }),
      ).toBe('WARNING');
      expect(
        deriveAdminAuditSeverity({
          severity: undefined as unknown as AuditSeverity,
          action: 'ORDER_SUBMITTED',
        }),
      ).toBe('INFO');
    });
  });
});
