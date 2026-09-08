import { Repository } from 'typeorm';
import { BrokerAccount } from '../broker/entities/broker-account.entity';
import { BrokerConnection } from '../broker/entities/broker-connection.entity';
import { BrokerService } from '../broker/broker.service';
import { BrokerConnectionStatus, BrokerMode } from '../broker/interfaces/broker-adapter.interface';
import { BrokerAuthorizationStatus } from '../broker/authorization/broker-authorization-status';
import { BrokerCredentialStatus } from '../broker/authorization/broker-credential-status';
import { Trade, TradeDirection, TradeStatus } from '../execution/entities/trade.entity';
import { TradingSession, TradingSessionStatus } from '../execution/entities/trading-session.entity';
import { Order } from '../execution/orders/order.entity';
import { OrderKind, OrderStatus, OrderTimeInForce } from '../execution/orders/order.enums';
import { ReconciliationRun } from '../execution/reconciliation/entities/reconciliation-run.entity';
import { ReconciliationDiscrepancy } from '../execution/reconciliation/entities/reconciliation-discrepancy.entity';
import {
  ReconciliationDiscrepancySeverity,
  ReconciliationDiscrepancyStatus,
  ReconciliationRunStatus,
} from '../execution/reconciliation/reconciliation.enums';
import { AuditLog, AuditSeverity } from '../audit/entities/audit-log.entity';
import { RiskProfile } from '../risk/entities/risk-profile.entity';
import { LiveAccountAlertSeverity, LiveConnectionHealth } from './dto/live-account.enums';
import { accountTypeToEnvironment } from './dto/live-account-positions-response.dto';
import {
  clampPaginationLimit,
  clampPaginationOffset,
  LIVE_ACCOUNT_TERMINAL_WINDOW_MS,
  LiveAccountService,
  maskAccountId,
  normalizeOrderStatusFilter,
  ORDER_HISTORY_STATUSES,
  ORDER_WORKING_STATUSES,
  sanitizeErrorMessage,
} from './live-account.service';

/**
 * LiveAccountService — Sprint 50 PR-5 unit specs (Directive §51).
 *
 * Covers: tenant scoping of every repository call, environment roll-up,
 * executable-gate delegation (fail-closed), the health derivation matrix,
 * all 8 server-derived alert kinds + ordering, account-id masking, financial
 * null-safety, reconciliation summaries, execution-health 24h windows,
 * output redaction, order status filter mapping + pagination, position
 * enrichment, and activity severity mapping.
 */

const USER_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const NOW = new Date('2026-01-15T12:00:00.000Z');

/** Minimal structural view of a TypeORM FindOperator for assertions. */
interface FindOperatorLike<T> {
  type: string;
  value: T;
}

function expectInOperator(actual: unknown, expected: readonly string[]): void {
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

describe('LiveAccountService', () => {
  let service: LiveAccountService;
  let connectionRepo: { find: jest.Mock };
  let accountRepo: { find: jest.Mock };
  let tradeRepo: { find: jest.Mock; count: jest.Mock };
  let sessionRepo: { findOne: jest.Mock };
  let orderRepo: { find: jest.Mock; count: jest.Mock };
  let runRepo: { findOne: jest.Mock };
  let discrepancyRepo: { find: jest.Mock };
  let auditRepo: { find: jest.Mock; count: jest.Mock };
  let riskProfileRepo: { findOne: jest.Mock };
  let brokerService: { isConnectionExecutable: jest.Mock };

  const connection = (overrides: Partial<BrokerConnection> = {}): BrokerConnection =>
    ({
      id: 'conn-1',
      userId: USER_ID,
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

  const account = (overrides: Partial<BrokerAccount> = {}): BrokerAccount =>
    ({
      id: 'acct-1',
      brokerConnectionId: 'conn-1',
      balance: '10000.00000000',
      equity: '10050.50000000',
      margin: '500.00000000',
      freeMargin: '9550.50000000',
      marginLevel: '2010.1000',
      currency: 'USD',
      leverage: 100,
      openPositionsCount: 2,
      syncedAt: new Date('2026-01-15T11:30:00Z'),
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-15T11:30:00Z'),
      connection: null,
      ...overrides,
    }) as BrokerAccount;

  const openDiscrepancy = (
    brokerConnectionId: string,
    severity: ReconciliationDiscrepancySeverity,
  ): ReconciliationDiscrepancy =>
    ({
      id: `disc-${brokerConnectionId}-${severity}`,
      userId: USER_ID,
      brokerConnectionId,
      runId: null,
      type: 'STALE_ORDER_STATE',
      severity,
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
    }) as ReconciliationDiscrepancy;

  const run = (overrides: Partial<ReconciliationRun> = {}): ReconciliationRun =>
    ({
      id: 'run-1',
      userId: USER_ID,
      brokerConnectionId: 'conn-1',
      brokerId: 'metatrader5',
      status: ReconciliationRunStatus.COMPLETED_WITH_WARNINGS,
      startedAt: new Date('2026-01-15T10:30:00Z'),
      completedAt: new Date('2026-01-15T10:31:00Z'),
      providerOrdersSeen: 3,
      internalOrdersCompared: 3,
      providerPositionsSeen: 2,
      internalPositionsCompared: 2,
      accountSnapshotCompared: 1,
      discrepanciesDetected: 2,
      discrepanciesNew: 2,
      discrepanciesAutoResolved: 0,
      discrepanciesOpen: 2,
      errors: 0,
      errorSummary: null,
      metadata: { window: '60s' },
      createdAt: new Date('2026-01-15T10:30:00Z'),
      updatedAt: new Date('2026-01-15T10:31:00Z'),
      ...overrides,
    }) as ReconciliationRun;

  const session = (overrides: Partial<TradingSession> = {}): TradingSession =>
    ({
      id: 'session-1',
      userId: USER_ID,
      brokerConnectionId: 'conn-1',
      status: TradingSessionStatus.ACTIVE,
      openingBalance: '10000.00',
      peakEquity: '10100.00',
      riskProfileSnapshot: null,
      startedAt: new Date('2026-01-14T08:00:00Z'),
      endedAt: null,
      createdAt: new Date('2026-01-14T08:00:00Z'),
      updatedAt: new Date('2026-01-14T08:00:00Z'),
      ...overrides,
    }) as TradingSession;

  const riskProfile = (overrides: Partial<RiskProfile> = {}): RiskProfile =>
    ({
      id: 'risk-1',
      userId: USER_ID,
      killSwitchActive: false,
      killSwitchReason: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
      ...overrides,
    }) as RiskProfile;

  const order = (overrides: Partial<Order> = {}): Order =>
    ({
      id: 'order-1',
      userId: USER_ID,
      brokerConnectionId: 'conn-1',
      tradeId: 'trade-1',
      signalId: null,
      clientOrderId: 'client-1',
      idempotencyKey: 'idem-key-1',
      providerOrderId: 'ticket-1',
      orderKind: OrderKind.LIMIT,
      timeInForce: OrderTimeInForce.GTC,
      instrument: 'EURUSD',
      direction: TradeDirection.BUY,
      requestedQuantity: '1.0000',
      requestedPrice: '1.10000000',
      stopPrice: null,
      filledQuantity: '0.5000',
      avgFillPrice: '1.10005000',
      status: OrderStatus.PARTIALLY_FILLED,
      rejectReason: null,
      submittedAt: new Date('2026-01-15T10:00:00Z'),
      finalizedAt: null,
      createdAt: new Date('2026-01-15T09:59:00Z'),
      updatedAt: new Date('2026-01-15T10:00:00Z'),
      ...overrides,
    }) as unknown as Order;

  const trade = (overrides: Partial<Trade> = {}): Trade =>
    ({
      id: 'trade-1',
      userId: USER_ID,
      brokerConnectionId: 'conn-1',
      signalId: null,
      idempotencyKey: 'trade-idem-1',
      instrument: 'EURUSD',
      direction: TradeDirection.BUY,
      lotSize: '1.0000',
      requestedEntryPrice: '1.10000000',
      fillPrice: '1.10005000',
      stopLoss: '1.09500000',
      takeProfit: '1.11000000',
      trailingStopPips: null,
      externalOrderId: 'pos-1',
      externalPositionId: null,
      commission: null,
      swap: null,
      status: TradeStatus.OPEN,
      exitPrice: null,
      realisedPnl: null,
      closeReason: null,
      brokerRejectionReason: null,
      openedAt: new Date('2026-01-15T10:00:00Z'),
      closedAt: null,
      createdAt: new Date('2026-01-15T09:59:00Z'),
      updatedAt: new Date('2026-01-15T10:00:00Z'),
      ...overrides,
    }) as unknown as Trade;

  const auditLog = (overrides: Partial<AuditLog> = {}): AuditLog =>
    ({
      id: 'audit-1',
      actorUserId: USER_ID,
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

  beforeEach(() => {
    connectionRepo = { find: jest.fn().mockResolvedValue([]) };
    accountRepo = { find: jest.fn().mockResolvedValue([]) };
    tradeRepo = { find: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) };
    sessionRepo = { findOne: jest.fn().mockResolvedValue(null) };
    orderRepo = { find: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) };
    runRepo = { findOne: jest.fn().mockResolvedValue(null) };
    discrepancyRepo = { find: jest.fn().mockResolvedValue([]) };
    auditRepo = { find: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) };
    riskProfileRepo = { findOne: jest.fn().mockResolvedValue(null) };
    brokerService = { isConnectionExecutable: jest.fn().mockReturnValue(true) };

    service = new LiveAccountService(
      connectionRepo as unknown as Repository<BrokerConnection>,
      accountRepo as unknown as Repository<BrokerAccount>,
      tradeRepo as unknown as Repository<Trade>,
      sessionRepo as unknown as Repository<TradingSession>,
      orderRepo as unknown as Repository<Order>,
      runRepo as unknown as Repository<ReconciliationRun>,
      discrepancyRepo as unknown as Repository<ReconciliationDiscrepancy>,
      auditRepo as unknown as Repository<AuditLog>,
      riskProfileRepo as unknown as Repository<RiskProfile>,
      brokerService as unknown as BrokerService,
    );
  });

  // ─── Tenant scoping (Directive §40) ───────────────────────────────────────

  describe('tenant scoping', () => {
    it('scopes every overview repository call to the authenticated user', async () => {
      connectionRepo.find.mockResolvedValue([connection()]);
      accountRepo.find.mockResolvedValue([account()]);

      await service.getOverview(USER_ID, NOW);

      expect(connectionRepo.find).toHaveBeenCalledWith({
        where: { userId: USER_ID },
        order: { createdAt: 'DESC' },
      });
      expect(discrepancyRepo.find).toHaveBeenCalledWith({
        where: { userId: USER_ID, status: ReconciliationDiscrepancyStatus.OPEN },
      });
      expect(sessionRepo.findOne).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ where: expect.objectContaining({ userId: USER_ID }) }),
      );
      expect(riskProfileRepo.findOne).toHaveBeenCalledWith({ where: { userId: USER_ID } });
      for (const callArgs of tradeRepo.count.mock.calls) {
        expect(callArgs[0].where.userId).toBe(USER_ID);
      }
      for (const callArgs of orderRepo.count.mock.calls) {
        expect(callArgs[0].where.userId).toBe(USER_ID);
      }
    });

    it('scopes account snapshots to the user-owned connection ids only', async () => {
      const own = connection();
      connectionRepo.find.mockResolvedValue([own]);

      await service.getOverview(USER_ID, NOW);

      const accountArgs = accountRepo.find.mock.calls[0][0];
      expectInOperator(accountArgs.where.brokerConnectionId, [own.id]);
    });

    it('scopes per-connection run lookups with the userId', async () => {
      connectionRepo.find.mockResolvedValue([connection()]);

      await service.getOverview(USER_ID, NOW);

      expect(runRepo.findOne).toHaveBeenCalledWith({
        where: { userId: USER_ID, brokerConnectionId: 'conn-1' },
        order: { startedAt: 'DESC', createdAt: 'DESC' },
      });
    });

    it('scopes orders to the authenticated user', async () => {
      await service.getOrders(USER_ID, 'ALL', 10, 0);

      expect(orderRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: USER_ID } }),
      );
      expect(orderRepo.count).toHaveBeenCalledWith({ where: { userId: USER_ID } });
    });

    it('scopes positions to the authenticated user', async () => {
      await service.getPositions(USER_ID);

      const findArgs = tradeRepo.find.mock.calls[0][0];
      expect(findArgs.where.userId).toBe(USER_ID);
      expect(tradeRepo.count).toHaveBeenCalledWith({ where: findArgs.where });
    });

    it('scopes activity to the authenticated actor', async () => {
      await service.getActivity(USER_ID, 10, 0);

      expect(auditRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { actorUserId: USER_ID },
          order: { createdAt: 'DESC' },
          take: 10,
          skip: 0,
        }),
      );
      expect(auditRepo.count).toHaveBeenCalledWith({ where: { actorUserId: USER_ID } });
    });
  });

  // ─── Environment roll-up (Directive §36) ──────────────────────────────────

  describe('environment roll-up', () => {
    it('LIVE beats DEMO when both connection types exist', async () => {
      connectionRepo.find.mockResolvedValue([
        connection({ id: 'conn-demo', accountType: BrokerMode.DEMO }),
        connection({ id: 'conn-live', accountType: BrokerMode.LIVE }),
      ]);

      const overview = await service.getOverview(USER_ID, NOW);

      expect(overview.environment).toBe('LIVE');
      expect(overview.hasConnections).toBe(true);
    });

    it('DEMO wins over an explicitly PAPER connection', async () => {
      connectionRepo.find.mockResolvedValue([
        connection({ id: 'conn-demo', accountType: BrokerMode.DEMO }),
        connection({
          id: 'conn-paper',
          accountType: 'PAPER' as unknown as BrokerMode,
        }),
      ]);

      const overview = await service.getOverview(USER_ID, NOW);

      expect(overview.environment).toBe('DEMO');
    });

    it('rolls up to PAPER only when a connection is explicitly PAPER mode', async () => {
      connectionRepo.find.mockResolvedValue([
        connection({
          id: 'conn-paper',
          accountType: 'PAPER' as unknown as BrokerMode,
        }),
      ]);

      const overview = await service.getOverview(USER_ID, NOW);

      expect(overview.environment).toBe('PAPER');
      expect(overview.hasConnections).toBe(true);
    });

    it('empty account rolls up to UNKNOWN with hasConnections false (fail-closed)', async () => {
      const overview = await service.getOverview(USER_ID, NOW);

      expect(overview.environment).toBe('UNKNOWN');
      expect(overview.hasConnections).toBe(false);
      expect(overview.connections).toEqual([]);
    });

    it('connections with an unprovable mode roll up to UNKNOWN, never PAPER', async () => {
      connectionRepo.find.mockResolvedValue([
        connection({
          id: 'conn-mystery',
          accountType: undefined as unknown as BrokerMode,
        }),
      ]);

      const overview = await service.getOverview(USER_ID, NOW);

      expect(overview.environment).toBe('UNKNOWN');
    });
  });

  // ─── Position environment mapping (Directive §36 fail-closed provenance) ──

  describe('accountTypeToEnvironment', () => {
    it('maps explicit LIVE and DEMO modes to their environments', () => {
      expect(accountTypeToEnvironment(BrokerMode.LIVE)).toBe('LIVE');
      expect(accountTypeToEnvironment(BrokerMode.DEMO)).toBe('DEMO');
    });

    it('maps only an explicit PAPER mode to PAPER', () => {
      expect(accountTypeToEnvironment('PAPER')).toBe('PAPER');
    });

    it('returns UNKNOWN for undefined and unrecognized account types (never PAPER)', () => {
      expect(accountTypeToEnvironment(undefined)).toBe('UNKNOWN');
      expect(accountTypeToEnvironment(null)).toBe('UNKNOWN');
      expect(accountTypeToEnvironment('SOMETHING_ELSE')).toBe('UNKNOWN');
      expect(accountTypeToEnvironment('')).toBe('UNKNOWN');
    });
  });

  // ─── Executable gate delegation (Sprint 50 fail-closed gate) ──────────────

  describe('executable delegation', () => {
    it('delegates to the Sprint 50 gate per connection', async () => {
      connectionRepo.find.mockResolvedValue([connection()]);

      const overview = await service.getOverview(USER_ID, NOW);

      expect(brokerService.isConnectionExecutable).toHaveBeenCalledTimes(1);
      expect(brokerService.isConnectionExecutable).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'conn-1' }),
      );
      expect(overview.connections[0].executable).toBe(true);
    });

    it('treats a false gate verdict as not executable', async () => {
      brokerService.isConnectionExecutable.mockReturnValue(false);
      connectionRepo.find.mockResolvedValue([connection()]);

      const overview = await service.getOverview(USER_ID, NOW);

      expect(overview.connections[0].executable).toBe(false);
    });

    it('treats a throwing gate as not executable (fail-closed)', async () => {
      brokerService.isConnectionExecutable.mockImplementation(() => {
        throw new Error('gate unavailable');
      });
      connectionRepo.find.mockResolvedValue([connection()]);

      const overview = await service.getOverview(USER_ID, NOW);

      expect(overview.connections[0].executable).toBe(false);
    });
  });

  // ─── Health derivation matrix ─────────────────────────────────────────────

  describe('health derivation', () => {
    it('HEALTHY when CONNECTED + authorization ACTIVE + credentials VERIFIED', async () => {
      connectionRepo.find.mockResolvedValue([connection()]);
      accountRepo.find.mockResolvedValue([account()]);

      const overview = await service.getOverview(USER_ID, NOW);

      expect(overview.connections[0].health).toBe(LiveConnectionHealth.HEALTHY);
    });

    it('HEALTHY when authorization is AUTHORIZED (pre-activation)', async () => {
      connectionRepo.find.mockResolvedValue([
        connection({ authorizationStatus: BrokerAuthorizationStatus.AUTHORIZED }),
      ]);
      accountRepo.find.mockResolvedValue([account()]);

      const overview = await service.getOverview(USER_ID, NOW);

      expect(overview.connections[0].health).toBe(LiveConnectionHealth.HEALTHY);
    });

    it('UNHEALTHY when authorization is REVOKED', async () => {
      connectionRepo.find.mockResolvedValue([
        connection({ authorizationStatus: BrokerAuthorizationStatus.REVOKED }),
      ]);

      const overview = await service.getOverview(USER_ID, NOW);

      expect(overview.connections[0].health).toBe(LiveConnectionHealth.UNHEALTHY);
    });

    it('UNHEALTHY when authorization is SUSPENDED or ERROR', async () => {
      connectionRepo.find.mockResolvedValue([
        connection({ authorizationStatus: BrokerAuthorizationStatus.SUSPENDED }),
        connection({ id: 'conn-2', authorizationStatus: BrokerAuthorizationStatus.ERROR }),
      ]);

      const overview = await service.getOverview(USER_ID, NOW);

      expect(overview.connections[0].health).toBe(LiveConnectionHealth.UNHEALTHY);
      expect(overview.connections[1].health).toBe(LiveConnectionHealth.UNHEALTHY);
    });

    it('UNHEALTHY when connection status is ERROR', async () => {
      connectionRepo.find.mockResolvedValue([connection({ status: BrokerConnectionStatus.ERROR })]);

      const overview = await service.getOverview(USER_ID, NOW);

      expect(overview.connections[0].health).toBe(LiveConnectionHealth.UNHEALTHY);
    });

    it('DEGRADED when credentials are EXPIRED, INVALID, or ROTATED', async () => {
      connectionRepo.find.mockResolvedValue([
        connection({ credentialStatus: BrokerCredentialStatus.EXPIRED }),
        connection({ id: 'conn-2', credentialStatus: BrokerCredentialStatus.INVALID }),
        connection({ id: 'conn-3', credentialStatus: BrokerCredentialStatus.ROTATED }),
      ]);

      const overview = await service.getOverview(USER_ID, NOW);

      expect(overview.connections[0].health).toBe(LiveConnectionHealth.DEGRADED);
      expect(overview.connections[1].health).toBe(LiveConnectionHealth.DEGRADED);
      expect(overview.connections[2].health).toBe(LiveConnectionHealth.DEGRADED);
    });

    it('DEGRADED when financial sync is older than 24h', async () => {
      connectionRepo.find.mockResolvedValue([connection()]);
      accountRepo.find.mockResolvedValue([
        account({ syncedAt: new Date(NOW.getTime() - 25 * 60 * 60 * 1000) }),
      ]);

      const overview = await service.getOverview(USER_ID, NOW);

      expect(overview.connections[0].health).toBe(LiveConnectionHealth.DEGRADED);
    });

    it('DEGRADED when a non-error connection carries an error message', async () => {
      connectionRepo.find.mockResolvedValue([connection({ lastErrorMessage: 'dropped' })]);
      accountRepo.find.mockResolvedValue([account()]);

      const overview = await service.getOverview(USER_ID, NOW);

      expect(overview.connections[0].health).toBe(LiveConnectionHealth.DEGRADED);
    });

    it('UNKNOWN for states that satisfy no rule (fail-closed default)', async () => {
      connectionRepo.find.mockResolvedValue([
        connection({
          status: BrokerConnectionStatus.CONNECTING,
          authorizationStatus: BrokerAuthorizationStatus.CONNECTED,
          credentialStatus: BrokerCredentialStatus.CREATED,
        }),
      ]);

      const overview = await service.getOverview(USER_ID, NOW);

      expect(overview.connections[0].health).toBe(LiveConnectionHealth.UNKNOWN);
    });

    it('UNKNOWN when the authorization status is missing (fail-closed)', async () => {
      connectionRepo.find.mockResolvedValue([connection({ authorizationStatus: undefined })]);

      const overview = await service.getOverview(USER_ID, NOW);

      expect(overview.connections[0].health).toBe(LiveConnectionHealth.UNKNOWN);
    });
  });

  // ─── Alert derivation (server-side, Directive §38) ────────────────────────

  describe('alert derivation', () => {
    it('AUTHORIZATION_REQUIRED — WARNING with re-authorization action', async () => {
      connectionRepo.find.mockResolvedValue([
        connection({
          authorizationStatus: BrokerAuthorizationStatus.AUTHORIZATION_REQUIRED,
        }),
      ]);
      accountRepo.find.mockResolvedValue([account()]);

      const overview = await service.getOverview(USER_ID, NOW);

      const alert = overview.alerts.find((a) => a.kind === 'AUTHORIZATION_REQUIRED');
      expect(alert).toBeDefined();
      expect(alert?.severity).toBe('WARNING');
      expect(alert?.key).toBe('AUTHORIZATION_REQUIRED:conn-1');
      expect(alert?.connectionId).toBe('conn-1');
      expect(alert?.brokerName).toBe('MetaTrader 5');
      expect(alert?.action).toBe(
        'Re-authorize this broker connection in Settings → Broker Accounts',
      );
    });

    it('CREDENTIALS_INVALID — CRITICAL with rotation action', async () => {
      connectionRepo.find.mockResolvedValue([
        connection({ credentialStatus: BrokerCredentialStatus.INVALID }),
      ]);
      accountRepo.find.mockResolvedValue([account()]);

      const overview = await service.getOverview(USER_ID, NOW);

      const alert = overview.alerts.find((a) => a.kind === 'CREDENTIALS_INVALID');
      expect(alert?.severity).toBe('CRITICAL');
      expect(alert?.action).toBe('Rotate your broker credentials');
    });

    it('CREDENTIALS_EXPIRED — WARNING with rotation action', async () => {
      connectionRepo.find.mockResolvedValue([
        connection({ credentialStatus: BrokerCredentialStatus.EXPIRED }),
      ]);
      accountRepo.find.mockResolvedValue([account()]);

      const overview = await service.getOverview(USER_ID, NOW);

      const alert = overview.alerts.find((a) => a.kind === 'CREDENTIALS_EXPIRED');
      expect(alert?.severity).toBe('WARNING');
      expect(alert?.action).toBe('Rotate your broker credentials');
    });

    it('CONNECTION_ERROR — CRITICAL, message exposes broker name only', async () => {
      connectionRepo.find.mockResolvedValue([
        connection({
          status: BrokerConnectionStatus.ERROR,
          lastErrorMessage: 'MetaAPI handshake failed with token abcdefghijklmnop1234',
        }),
      ]);

      const overview = await service.getOverview(USER_ID, NOW);

      const alert = overview.alerts.find((a) => a.kind === 'CONNECTION_ERROR');
      expect(alert?.severity).toBe('CRITICAL');
      expect(alert?.action).toBe('Reconnect or verify credentials');
      expect(alert?.message).toBe('MetaTrader 5 connection reported an error.');
      expect(alert?.message).not.toContain('MetaAPI');
      expect(alert?.message).not.toContain('abcdefghijklmnop');
    });

    it('CONNECTION_ERROR also fires for a non-error connection with an error message', async () => {
      connectionRepo.find.mockResolvedValue([connection({ lastErrorMessage: 'timeout' })]);
      accountRepo.find.mockResolvedValue([account()]);

      const overview = await service.getOverview(USER_ID, NOW);

      expect(overview.alerts.find((a) => a.kind === 'CONNECTION_ERROR')).toBeDefined();
    });

    it('KILL_SWITCH_ACTIVE — CRITICAL including the reason', async () => {
      riskProfileRepo.findOne.mockResolvedValue(
        riskProfile({ killSwitchActive: true, killSwitchReason: 'Max daily loss breached' }),
      );

      const overview = await service.getOverview(USER_ID, NOW);

      const alert = overview.alerts.find((a) => a.kind === 'KILL_SWITCH_ACTIVE');
      expect(alert?.severity).toBe('CRITICAL');
      expect(alert?.key).toBe('KILL_SWITCH_ACTIVE:account');
      expect(alert?.connectionId).toBeNull();
      expect(alert?.message).toContain('Max daily loss breached');
      expect(alert?.action).toBe('Review risk limits before re-enabling automation');
    });

    it('AUTOMATION_SUSPENDED — WARNING for risk-limit and broker suspensions', async () => {
      sessionRepo.findOne.mockResolvedValueOnce(
        session({ status: TradingSessionStatus.SUSPENDED_RISK_LIMIT }),
      );

      const overview = await service.getOverview(USER_ID, NOW);

      const alert = overview.alerts.find((a) => a.kind === 'AUTOMATION_SUSPENDED');
      expect(alert?.severity).toBe('WARNING');
      expect(alert?.key).toBe('AUTOMATION_SUSPENDED:account');
      expect(alert?.message).toContain('risk limit');
    });

    it('RECONCILIATION_DISCREPANCIES — CRITICAL when critical discrepancies are open', async () => {
      connectionRepo.find.mockResolvedValue([connection()]);
      discrepancyRepo.find.mockResolvedValue([
        openDiscrepancy('conn-1', ReconciliationDiscrepancySeverity.CRITICAL),
        openDiscrepancy('conn-1', ReconciliationDiscrepancySeverity.CRITICAL),
        openDiscrepancy('conn-1', ReconciliationDiscrepancySeverity.WARNING),
      ]);

      const overview = await service.getOverview(USER_ID, NOW);

      const alert = overview.alerts.find((a) => a.kind === 'RECONCILIATION_DISCREPANCIES');
      expect(alert?.severity).toBe('CRITICAL');
      expect(alert?.message).toContain('3 open reconciliation discrepancies');
      expect(alert?.message).toContain('2 critical');
      expect(alert?.action).toBe('Review reconciliation state');
    });

    it('RECONCILIATION_DISCREPANCIES — WARNING when only warning-level rows remain', async () => {
      connectionRepo.find.mockResolvedValue([connection()]);
      discrepancyRepo.find.mockResolvedValue([
        openDiscrepancy('conn-1', ReconciliationDiscrepancySeverity.WARNING),
        openDiscrepancy('conn-1', ReconciliationDiscrepancySeverity.INFO),
      ]);

      const overview = await service.getOverview(USER_ID, NOW);

      const alert = overview.alerts.find((a) => a.kind === 'RECONCILIATION_DISCREPANCIES');
      expect(alert?.severity).toBe('WARNING');
    });

    it('ACCOUNT_SYNC_STALE — WARNING when CONNECTED with no financial snapshot', async () => {
      connectionRepo.find.mockResolvedValue([connection()]);
      accountRepo.find.mockResolvedValue([]);

      const overview = await service.getOverview(USER_ID, NOW);

      const alert = overview.alerts.find((a) => a.kind === 'ACCOUNT_SYNC_STALE');
      expect(alert?.severity).toBe('WARNING');
      expect(alert?.action).toBe('Wait for the next account sync or reconnect');
    });

    it('ACCOUNT_SYNC_STALE — WARNING when the snapshot is older than one hour', async () => {
      connectionRepo.find.mockResolvedValue([connection()]);
      accountRepo.find.mockResolvedValue([
        account({ syncedAt: new Date(NOW.getTime() - 2 * 60 * 60 * 1000) }),
      ]);

      const overview = await service.getOverview(USER_ID, NOW);

      expect(overview.alerts.find((a) => a.kind === 'ACCOUNT_SYNC_STALE')).toBeDefined();
    });

    it('orders alerts CRITICAL first, then WARNING, with stable keys', async () => {
      connectionRepo.find.mockResolvedValue([
        connection({ id: 'conn-a', status: BrokerConnectionStatus.ERROR }),
        connection({
          id: 'conn-b',
          authorizationStatus: BrokerAuthorizationStatus.AUTHORIZATION_REQUIRED,
        }),
      ]);
      accountRepo.find.mockResolvedValue([account({ brokerConnectionId: 'conn-b' })]);
      riskProfileRepo.findOne.mockResolvedValue(riskProfile({ killSwitchActive: true }));

      const overview = await service.getOverview(USER_ID, NOW);

      const severities = overview.alerts.map((a) => a.severity);
      const firstWarning = severities.indexOf(LiveAccountAlertSeverity.WARNING);
      for (const [index, severity] of severities.entries()) {
        if (index < firstWarning) expect(severity).toBe('CRITICAL');
      }
      expect(overview.alerts.map((a) => a.key)).toEqual([
        'CONNECTION_ERROR:conn-a',
        'KILL_SWITCH_ACTIVE:account',
        'AUTHORIZATION_REQUIRED:conn-b',
      ]);
    });
  });

  // ─── Account identifier masking ───────────────────────────────────────────

  describe('maskedAccountId', () => {
    it('masks to the last four characters', () => {
      expect(maskAccountId('1234567890123')).toBe('•••0123');
      expect(maskAccountId('4123')).toBe('•••4123');
    });

    it('is null when the identifier is absent or shorter than four characters', () => {
      expect(maskAccountId(null)).toBeNull();
      expect(maskAccountId(undefined)).toBeNull();
      expect(maskAccountId('')).toBeNull();
      expect(maskAccountId('abc')).toBeNull();
    });

    it('masks through the connection view', async () => {
      connectionRepo.find.mockResolvedValue([connection({ accountId: '987654321' })]);

      const overview = await service.getOverview(USER_ID, NOW);

      expect(overview.connections[0].maskedAccountId).toBe('•••4321');
      expect(overview.connections[0].maskedAccountId).not.toContain('98765');
    });

    it('serializes NO full accountId — masked identifier only (Phase F minimization)', async () => {
      connectionRepo.find.mockResolvedValue([connection({ accountId: '987654321' })]);

      const overview = await service.getOverview(USER_ID, NOW);
      const view = overview.connections[0];

      expect(view.maskedAccountId).toBe('•••4321');
      expect(view).not.toHaveProperty('accountId');
      expect(JSON.stringify(view)).not.toContain('987654321');
      expect(JSON.stringify(overview)).not.toContain('987654321');
    });
  });

  // ─── Financial summary ────────────────────────────────────────────────────

  describe('financial summary', () => {
    it('is null when no BrokerAccount row exists for the connection', async () => {
      connectionRepo.find.mockResolvedValue([connection()]);

      const overview = await service.getOverview(USER_ID, NOW);

      expect(overview.connections[0].financial).toBeNull();
    });

    it('maps the persisted snapshot with decimal strings preserved', async () => {
      connectionRepo.find.mockResolvedValue([connection()]);
      accountRepo.find.mockResolvedValue([account()]);

      const financial = (await service.getOverview(USER_ID, NOW)).connections[0].financial;

      expect(financial).not.toBeNull();
      expect(financial?.currency).toBe('USD');
      expect(financial?.balance).toBe('10000.00000000');
      expect(financial?.equity).toBe('10050.50000000');
      expect(financial?.margin).toBe('500.00000000');
      expect(financial?.freeMargin).toBe('9550.50000000');
      expect(financial?.marginLevel).toBe('2010.1000');
      expect(financial?.openPositionsCount).toBe(2);
      expect(financial?.syncedAt).toBe('2026-01-15T11:30:00.000Z');
      expect(typeof financial?.balance).toBe('string');
    });
  });

  // ─── Reconciliation summary ───────────────────────────────────────────────

  describe('reconciliation summary', () => {
    it('maps the latest run and severity counts, inSync false when critical/warning open', async () => {
      connectionRepo.find.mockResolvedValue([connection()]);
      runRepo.findOne.mockResolvedValue(run());
      discrepancyRepo.find.mockResolvedValue([
        openDiscrepancy('conn-1', ReconciliationDiscrepancySeverity.CRITICAL),
        openDiscrepancy('conn-1', ReconciliationDiscrepancySeverity.WARNING),
      ]);

      const recon = (await service.getOverview(USER_ID, NOW)).connections[0].reconciliation;

      expect(recon.lastRunAt).toBe('2026-01-15T10:30:00.000Z');
      expect(recon.lastRunStatus).toBe(ReconciliationRunStatus.COMPLETED_WITH_WARNINGS);
      expect(recon.openDiscrepancies).toBe(2);
      expect(recon.openCritical).toBe(1);
      expect(recon.openWarning).toBe(1);
      expect(recon.inSync).toBe(false);
    });

    it('INFO-only discrepancies count as inSync', async () => {
      connectionRepo.find.mockResolvedValue([connection()]);
      discrepancyRepo.find.mockResolvedValue([
        openDiscrepancy('conn-1', ReconciliationDiscrepancySeverity.INFO),
      ]);

      const recon = (await service.getOverview(USER_ID, NOW)).connections[0].reconciliation;

      expect(recon.openDiscrepancies).toBe(1);
      expect(recon.openCritical).toBe(0);
      expect(recon.openWarning).toBe(0);
      expect(recon.inSync).toBe(true);
    });

    it('null last run fields when no run has ever executed', async () => {
      connectionRepo.find.mockResolvedValue([connection()]);

      const recon = (await service.getOverview(USER_ID, NOW)).connections[0].reconciliation;

      expect(recon.lastRunAt).toBeNull();
      expect(recon.lastRunStatus).toBeNull();
      expect(recon.openDiscrepancies).toBe(0);
      expect(recon.inSync).toBe(true);
    });
  });

  // ─── reconciliationLoaded tri-state (Phase F partial-failure) ────────────

  describe('reconciliationLoaded tri-state', () => {
    it('is true when the reconciliation state was read (even with no runs/rows)', async () => {
      connectionRepo.find.mockResolvedValue([connection()]);

      const overview = await service.getOverview(USER_ID, NOW);

      expect(overview.reconciliationLoaded).toBe(true);
    });

    it('is true for an empty account (definitive no-data read)', async () => {
      const overview = await service.getOverview(USER_ID, NOW);

      expect(overview.reconciliationLoaded).toBe(true);
    });

    it('is false when the latest-run lookup fails (never rendered as zero discrepancies)', async () => {
      connectionRepo.find.mockResolvedValue([connection()]);
      runRepo.findOne.mockRejectedValue(new Error('run store unavailable'));

      const overview = await service.getOverview(USER_ID, NOW);

      expect(overview.reconciliationLoaded).toBe(false);
    });

    it('is false when the open-discrepancy lookup fails', async () => {
      connectionRepo.find.mockResolvedValue([connection()]);
      discrepancyRepo.find.mockRejectedValue(new Error('discrepancy store unavailable'));

      const overview = await service.getOverview(USER_ID, NOW);

      expect(overview.reconciliationLoaded).toBe(false);
    });

    it('is false when only ONE of several per-connection run lookups fails', async () => {
      connectionRepo.find.mockResolvedValue([
        connection({ id: 'conn-1' }),
        connection({ id: 'conn-2' }),
      ]);
      runRepo.findOne
        .mockResolvedValueOnce(run())
        .mockRejectedValueOnce(new Error('run store flaked'));

      const overview = await service.getOverview(USER_ID, NOW);

      expect(overview.reconciliationLoaded).toBe(false);
    });
  });

  // ─── Execution health ─────────────────────────────────────────────────────

  describe('execution health', () => {
    it('counts scoped open positions, working orders, and pending reconciliation', async () => {
      tradeRepo.count.mockImplementation(async (opts: { where: { status: string } }) =>
        opts.where.status === TradeStatus.OPEN ? 2 : 1,
      );
      orderRepo.count.mockImplementation(async (opts: { where: { status: unknown } }) => {
        if (opts.where.status === OrderStatus.REJECTED) return 4;
        if (opts.where.status === OrderStatus.FILLED) return 5;
        if (opts.where.status === OrderStatus.RECONCILIATION_PENDING) return 1;
        return 3;
      });

      const health = (await service.getOverview(USER_ID, NOW)).executionHealth;

      expect(health.openPositions).toBe(2);
      expect(health.workingOrders).toBe(3);
      expect(health.reconciliationPending).toBe(2);
      expect(health.rejectedLast24h).toBe(4);
      expect(health.filledLast24h).toBe(5);
    });

    it('windows terminal order counts at the last 24 hours from now', async () => {
      await service.getOverview(USER_ID, NOW);

      const cutoff = new Date(NOW.getTime() - LIVE_ACCOUNT_TERMINAL_WINDOW_MS);
      const rejectedCall = orderRepo.count.mock.calls.find(
        (args) => args[0].where.status === OrderStatus.REJECTED,
      );
      const filledCall = orderRepo.count.mock.calls.find(
        (args) => args[0].where.status === OrderStatus.FILLED,
      );
      expect(rejectedCall).toBeDefined();
      expect(filledCall).toBeDefined();
      expectMoreThanOrEqualDate(rejectedCall?.[0].where.createdAt, cutoff);
      expectMoreThanOrEqualDate(filledCall?.[0].where.createdAt, cutoff);
    });
  });

  // ─── Output redaction ─────────────────────────────────────────────────────

  describe('output redaction', () => {
    it('serializes without credential material, provider secrets, or audit metadata', async () => {
      connectionRepo.find.mockResolvedValue([
        connection({
          lastErrorMessage: 'Auth failed for token abcdefghijklmnop1234 after 3 attempts',
        }),
      ]);
      accountRepo.find.mockResolvedValue([account()]);
      runRepo.findOne.mockResolvedValue(run());

      const overview = await service.getOverview(USER_ID, NOW);
      const serialized = JSON.stringify(overview);

      expect(serialized).not.toContain('apiSecret');
      expect(serialized).not.toContain('apiKey');
      expect(serialized).not.toContain('metadata');
      expect(serialized).not.toContain('encryptedCredentials');
      expect(serialized).not.toContain('credentialIv');
      expect(serialized).not.toContain('encryptionKeyId');
      expect(serialized).not.toContain('aGVsbG8gd29ybGQ');
      expect(overview.connections[0].lastErrorMessage).not.toContain('abcdefghijklmnop');
    });

    it('truncates and sanitizes error messages (max 200 chars, no key-like runs)', () => {
      expect(sanitizeErrorMessage('short failure')).toBe('short failure');
      expect(sanitizeErrorMessage('token abcdefghijklmnop1234 rejected')).toBe('token … rejected');
      expect(sanitizeErrorMessage(null)).toBeNull();
      const long = `${'x'.repeat(300)} token abcdefghijklmnop1234`;
      expect(sanitizeErrorMessage(long)?.length).toBeLessThanOrEqual(200);
    });

    it('activity rows never include audit metadata, ip, or user agent', async () => {
      auditRepo.find.mockResolvedValue([auditLog()]);

      const activity = await service.getActivity(USER_ID, 50, 0);
      const serialized = JSON.stringify(activity);

      expect(serialized).not.toContain('metadata');
      expect(serialized).not.toContain('ipAddress');
      expect(serialized).not.toContain('userAgent');
      expect(serialized).not.toContain('203.0.113.10');
      expect(serialized).not.toContain('secret-never-expose');
    });
  });

  // ─── Orders page ──────────────────────────────────────────────────────────

  describe('getOrders', () => {
    it('WORKING maps to the working status set with pagination', async () => {
      await service.getOrders(USER_ID, 'WORKING', 25, 10);

      const findArgs = orderRepo.find.mock.calls[0][0];
      expect(findArgs.where.userId).toBe(USER_ID);
      expectInOperator(findArgs.where.status, ORDER_WORKING_STATUSES);
      expect(findArgs.order).toEqual({ createdAt: 'DESC' });
      expect(findArgs.take).toBe(25);
      expect(findArgs.skip).toBe(10);
      expectInOperator(orderRepo.count.mock.calls[0][0].where.status, ORDER_WORKING_STATUSES);
    });

    it('HISTORY maps to the terminal status set', async () => {
      await service.getOrders(USER_ID, 'HISTORY', 50, 0);

      expectInOperator(orderRepo.find.mock.calls[0][0].where.status, ORDER_HISTORY_STATUSES);
      expectInOperator(orderRepo.count.mock.calls[0][0].where.status, ORDER_HISTORY_STATUSES);
    });

    it('ALL (and invalid values) apply no status filter', async () => {
      await service.getOrders(USER_ID, 'ALL', 50, 0);
      expect(orderRepo.find.mock.calls[0][0].where).toEqual({ userId: USER_ID });

      await service.getOrders(USER_ID, 'BOGUS', 50, 0);
      expect(orderRepo.find.mock.calls[1][0].where).toEqual({ userId: USER_ID });

      await service.getOrders(USER_ID, undefined, 50, 0);
      expect(orderRepo.find.mock.calls[2][0].where).toEqual({ userId: USER_ID });
    });

    it('clamps limit to 1..100 and offset to >= 0 (fail-closed)', async () => {
      await service.getOrders(USER_ID, 'ALL', 999, -5);
      expect(orderRepo.find.mock.calls[0][0].take).toBe(100);
      expect(orderRepo.find.mock.calls[0][0].skip).toBe(0);

      await service.getOrders(USER_ID, 'ALL', 0, 0);
      expect(orderRepo.find.mock.calls[1][0].take).toBe(1);
    });

    it('echoes the clamped pagination and total in the page DTO', async () => {
      orderRepo.count.mockResolvedValue(137);
      orderRepo.find.mockResolvedValue([]);

      const page = await service.getOrders(USER_ID, 'ALL', 999, -5);

      expect(page).toEqual({ orders: [], total: 137, limit: 100, offset: 0 });
    });

    it('enriches broker names from the user-owned connections only', async () => {
      connectionRepo.find.mockResolvedValue([connection()]);
      orderRepo.find.mockResolvedValue([
        order({ id: 'order-1', brokerConnectionId: 'conn-1' }),
        order({ id: 'order-2', brokerConnectionId: 'conn-unknown' }),
      ]);

      const page = await service.getOrders(USER_ID, 'ALL', 50, 0);

      expect(page.orders[0].brokerName).toBe('MetaTrader 5');
      expect(page.orders[1].brokerName).toBeNull();
    });

    it('maps order rows to the frontend-safe view (decimal strings, ISO dates)', async () => {
      connectionRepo.find.mockResolvedValue([connection()]);
      orderRepo.find.mockResolvedValue([order()]);

      const row = (await service.getOrders(USER_ID, 'ALL', 50, 0)).orders[0];

      expect(row.id).toBe('order-1');
      expect(row.clientOrderId).toBe('client-1');
      expect(row.providerOrderId).toBe('ticket-1');
      expect(row.tradeId).toBe('trade-1');
      expect(row.orderKind).toBe('LIMIT');
      expect(row.timeInForce).toBe('GTC');
      expect(row.status).toBe('PARTIALLY_FILLED');
      expect(row.requestedQuantity).toBe('1.0000');
      expect(row.filledQuantity).toBe('0.5000');
      expect(row.avgFillPrice).toBe('1.10005000');
      expect(typeof row.requestedQuantity).toBe('string');
      expect(row.submittedAt).toBe('2026-01-15T10:00:00.000Z');
      expect(row.createdAt).toBe('2026-01-15T09:59:00.000Z');
      expect(row.finalizedAt).toBeNull();
      expect(JSON.stringify(row)).not.toContain('idempotencyKey');
      expect(JSON.stringify(row)).not.toContain('signalId');
    });
  });

  // ─── Positions ────────────────────────────────────────────────────────────

  describe('getPositions', () => {
    it('returns only OPEN and RECONCILIATION_PENDING trades, newest first', async () => {
      await service.getPositions(USER_ID);

      const findArgs = tradeRepo.find.mock.calls[0][0];
      expect(findArgs.where.userId).toBe(USER_ID);
      expectInOperator(findArgs.where.status, [
        TradeStatus.OPEN,
        TradeStatus.RECONCILIATION_PENDING,
      ]);
      expect(findArgs.order).toEqual({ openedAt: 'DESC', createdAt: 'DESC' });
      expect(tradeRepo.count).toHaveBeenCalledWith({ where: findArgs.where });
    });

    it('enriches environment and broker name from the owning connection', async () => {
      connectionRepo.find.mockResolvedValue([
        connection({ id: 'conn-live', accountType: BrokerMode.LIVE }),
        connection({ id: 'conn-demo', accountType: BrokerMode.DEMO }),
      ]);
      tradeRepo.find.mockResolvedValue([
        trade({ id: 't-live', brokerConnectionId: 'conn-live' }),
        trade({ id: 't-demo', brokerConnectionId: 'conn-demo' }),
        trade({ id: 't-orphan', brokerConnectionId: 'conn-gone' }),
      ]);

      const view = await service.getPositions(USER_ID);

      expect(view.total).toBe(0); // count mock default
      expect(view.positions[0].environment).toBe('LIVE');
      expect(view.positions[0].brokerName).toBe('MetaTrader 5');
      expect(view.positions[1].environment).toBe('DEMO');
      // Orphan (owning connection gone) has no environment truth — UNKNOWN,
      // never a silent PAPER downgrade.
      expect(view.positions[2].environment).toBe('UNKNOWN');
      expect(view.positions[2].brokerName).toBeNull();
    });

    it('maps trade rows to the position view with status passthrough', async () => {
      connectionRepo.find.mockResolvedValue([connection()]);
      tradeRepo.find.mockResolvedValue([trade()]);
      tradeRepo.count.mockResolvedValue(1);

      const view = await service.getPositions(USER_ID);
      const position = view.positions[0];

      expect(view.total).toBe(1);
      expect(position.id).toBe('trade-1');
      expect(position.instrument).toBe('EURUSD');
      expect(position.direction).toBe('BUY');
      expect(position.lotSize).toBe('1.0000');
      expect(position.stopLoss).toBe('1.09500000');
      expect(position.takeProfit).toBe('1.11000000');
      expect(position.fillPrice).toBe('1.10005000');
      expect(position.status).toBe('OPEN');
      expect(position.openedAt).toBe('2026-01-15T10:00:00.000Z');
      expect(typeof position.lotSize).toBe('string');
    });

    it('flags RECONCILIATION_PENDING positions as such', async () => {
      connectionRepo.find.mockResolvedValue([connection()]);
      tradeRepo.find.mockResolvedValue([trade({ status: TradeStatus.RECONCILIATION_PENDING })]);

      const view = await service.getPositions(USER_ID);

      expect(view.positions[0].status).toBe('RECONCILIATION_PENDING');
    });
  });

  // ─── Activity timeline ────────────────────────────────────────────────────

  describe('getActivity', () => {
    it('maps the persisted audit severity when present', async () => {
      auditRepo.find.mockResolvedValue([
        auditLog({ severity: AuditSeverity.CRITICAL }),
        auditLog({ severity: AuditSeverity.WARNING }),
        auditLog({ severity: AuditSeverity.INFO }),
      ]);

      const page = await service.getActivity(USER_ID, 50, 0);

      expect(page.activity.map((row) => row.severity)).toEqual(['CRITICAL', 'WARNING', 'INFO']);
    });

    it('derives severity from the action when the column is missing', async () => {
      auditRepo.find.mockResolvedValue([
        auditLog({ severity: undefined, action: 'RISK_KILL_SWITCH_ACTIVATED' }),
        auditLog({ severity: undefined, action: 'ORDER_REJECTED' }),
        auditLog({ severity: undefined, action: 'ORDER_SUBMITTED' }),
        auditLog({ severity: undefined, action: 'EXECUTION_CONTROL_ACTIVATED' }),
        auditLog({ severity: undefined, action: 'BROKER_CONNECTION_REVOKED' }),
      ]);

      const page = await service.getActivity(USER_ID, 50, 0);

      expect(page.activity.map((row) => row.severity)).toEqual([
        'CRITICAL',
        'WARNING',
        'INFO',
        'CRITICAL',
        'WARNING',
      ]);
    });

    it('paginates and echoes totals', async () => {
      auditRepo.count.mockResolvedValue(250);

      const page = await service.getActivity(USER_ID, 999, -1);

      expect(auditRepo.find.mock.calls[0][0].take).toBe(100);
      expect(auditRepo.find.mock.calls[0][0].skip).toBe(0);
      expect(page.total).toBe(250);
      expect(page.limit).toBe(100);
      expect(page.offset).toBe(0);
    });

    it('maps rows to the activity view', async () => {
      auditRepo.find.mockResolvedValue([auditLog()]);

      const row = (await service.getActivity(USER_ID, 50, 0)).activity[0];

      expect(row.id).toBe('audit-1');
      expect(row.action).toBe('ORDER_SUBMITTED');
      expect(row.resourceType).toBe('Order');
      expect(row.resourceId).toBe('order-1');
      expect(row.severity).toBe('INFO');
      expect(row.createdAt).toBe('2026-01-15T11:00:00.000Z');
    });
  });

  // ─── Automation summary ───────────────────────────────────────────────────

  describe('automation summary', () => {
    it('IDLE with null session fields when no session exists', async () => {
      const automation = (await service.getOverview(USER_ID, NOW)).automation;

      expect(automation.status).toBe('IDLE');
      expect(automation.sessionId).toBeNull();
      expect(automation.sessionConnectionId).toBeNull();
      expect(automation.startedAt).toBeNull();
      expect(automation.endedAt).toBeNull();
      expect(automation.killSwitchActive).toBe(false);
      expect(automation.killSwitchReason).toBeNull();
    });

    it('prefers a non-ENDED session over an older ended one', async () => {
      sessionRepo.findOne
        .mockResolvedValueOnce(session({ status: TradingSessionStatus.PAUSED }))
        .mockResolvedValueOnce(session({ id: 'session-old', status: TradingSessionStatus.ENDED }));

      const automation = (await service.getOverview(USER_ID, NOW)).automation;

      expect(automation.status).toBe('PAUSED');
      expect(automation.sessionId).toBe('session-1');
      expect(automation.sessionConnectionId).toBe('conn-1');
      expect(automation.startedAt).toBe('2026-01-14T08:00:00.000Z');
    });

    it('falls back to the latest ENDED session when nothing is active', async () => {
      sessionRepo.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(
        session({
          id: 'session-old',
          status: TradingSessionStatus.ENDED,
          endedAt: new Date('2026-01-13T09:00:00Z'),
        }),
      );

      const automation = (await service.getOverview(USER_ID, NOW)).automation;

      expect(automation.status).toBe('ENDED');
      expect(automation.sessionId).toBe('session-old');
      expect(automation.endedAt).toBe('2026-01-13T09:00:00.000Z');
    });

    it('kill switch defaults to false without a risk profile', async () => {
      const automation = (await service.getOverview(USER_ID, NOW)).automation;

      expect(automation.killSwitchActive).toBe(false);
      expect(automation.killSwitchReason).toBeNull();
    });
  });

  // ─── Pure helper functions ────────────────────────────────────────────────

  describe('pagination + filter helpers', () => {
    it('clamps limits to 1..100 and offsets to >= 0', () => {
      expect(clampPaginationLimit(50)).toBe(50);
      expect(clampPaginationLimit(999)).toBe(100);
      expect(clampPaginationLimit(0)).toBe(1);
      expect(clampPaginationLimit(-7)).toBe(1);
      expect(clampPaginationOffset(0)).toBe(0);
      expect(clampPaginationOffset(-5)).toBe(0);
      expect(clampPaginationOffset(120)).toBe(120);
    });

    it('normalizes the order status filter with a safe ALL fallback', () => {
      expect(normalizeOrderStatusFilter('WORKING')).toBe('WORKING');
      expect(normalizeOrderStatusFilter('HISTORY')).toBe('HISTORY');
      expect(normalizeOrderStatusFilter('ALL')).toBe('ALL');
      expect(normalizeOrderStatusFilter('BOGUS')).toBe('ALL');
      expect(normalizeOrderStatusFilter(undefined)).toBe('ALL');
      expect(normalizeOrderStatusFilter(null)).toBe('ALL');
    });
  });

  // ─── Contract shape guard ─────────────────────────────────────────────────

  describe('generatedAt + connection view passthrough fields', () => {
    it('stamps generatedAt with the server clock and maps connection metadata', async () => {
      connectionRepo.find.mockResolvedValue([connection()]);

      const overview = await service.getOverview(USER_ID, NOW);
      const view = overview.connections[0];

      expect(overview.generatedAt).toBe('2026-01-15T12:00:00.000Z');
      expect(view.brokerName).toBe('MetaTrader 5');
      expect(view.displayName).toBe('Primary account');
      expect(view.accountType).toBe('DEMO');
      expect(view.accountCurrency).toBe('USD');
      expect(view.accountLeverage).toBe(100);
      expect(view.connectionStatus).toBe('CONNECTED');
      expect(view.authorizationStatus).toBe('ACTIVE');
      expect(view.credentialStatus).toBe('VERIFIED');
      expect(view.liveTradingEnabled).toBe(true);
      expect(view.lastSyncAt).toBe('2026-01-15T11:55:00.000Z');
      expect(view.lastHealthCheckAt).toBe('2026-01-15T11:55:00.000Z');
      expect(view.lastErrorMessage).toBeNull();
      expect(view.createdAt).toBe('2026-01-01T00:00:00.000Z');
      expect(view.updatedAt).toBe('2026-01-15T11:55:00.000Z');
    });
  });
});
