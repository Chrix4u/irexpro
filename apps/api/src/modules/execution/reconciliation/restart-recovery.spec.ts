import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Logger } from '@nestjs/common';
import { BrokerConnection } from '../../broker/entities/broker-connection.entity';
import { BrokerAccount } from '../../broker/entities/broker-account.entity';
import { BrokerService } from '../../broker/broker.service';
import { BrokerAdapterRegistry } from '../../broker/adapters/broker-adapter.registry';
import { CredentialEncryptionService } from '../../broker/services/credential-encryption.service';
import { AuditService } from '../../audit/audit.service';
import { DomainEventBus } from '../../events/event-bus.service';
import { Trade, TradeStatus } from '../entities/trade.entity';
import { TradeIntent } from '../entities/trade-intent.entity';
import { RiskGrant } from '../entities/risk-grant.entity';
import { RiskGrantStatus } from '../interfaces/execution-authority';
import { Order } from '../orders/order.entity';
import { OrderStatus } from '../orders/order.enums';
import { OrderService } from '../orders/order.service';
import { AllocationService } from '../services/allocation.service';
import { StateReconciliationService } from './state-reconciliation.service';
import { ReconciliationPersistenceService } from './reconciliation-persistence.service';
import { ReconciliationResolutionService } from './reconciliation-resolution.service';
import { ReconciliationRunStatus } from './reconciliation.enums';
import { AuditAction } from '../../../common/enums/audit-action.enum';
import { AuditSeverity } from '../../audit/entities/audit-log.entity';

/**
 * Round 7.1 (P0-5) — CRASH / RESTART RECOVERY integration proof.
 *
 * Process failure at every important boundary of the dispatch pipeline, then
 * a FRESH service instance (the restarted process) over the SAME persisted
 * store must recover WITHOUT:
 *   - duplicate exposure,
 *   - resurrecting stale authority,
 *   - reusing consumed grants,
 *   - repeating SEMI_AUTO confirmation,
 *   - losing audit provenance.
 *
 * Boundary map (labels per the Round 7.1 brief):
 *   A. crash before grant consumption — intent CREATED + grant ACTIVE (the
 *      execution-expiry sweeper owns it; here we pin that the reconciliation
 *      sweep does NOT touch it — no order/trade exists to converge).
 *   B. crash after trade/order reservation, before markSubmitted — order
 *      CREATED + trade PENDING + grant ACTIVE (previously an INVISIBLE
 *      wedge: not in the sweep's candidate sets, capital allocation leaked
 *      forever).
 *   C. crash after markSubmitted, before/during the commitment transaction —
 *      order SUBMITTED + trade PENDING + grant ACTIVE (same wedge).
 *   D. crash INSIDE the commitment transaction — impossible to observe (the
 *      grant consume + order DISPATCH_COMMITTED CAS are ONE atomic
 *      transaction; proven by construction, pinned by the PG integration
 *      suites).
 *   E. crash after commitment, before/during the provider call — order
 *      DISPATCH_COMMITTED (owned by crash-window-convergence.spec.ts; the
 *      restart framing below re-uses its store shape).
 *   F. provider accepted, crash before the local outcome write — the same
 *      durable shape as E; convergence via clientOrderId echo at the
 *      provider (OANDA) or surfaced for manual convergence (cTrader/MT5 —
 *      "alert the operator when automatic convergence is impossible").
 *   G. crash after the outcome write — ordinary reconciliation.
 *
 * This suite proves the NEW convergence machinery (step 7d — pre-commitment
 * recovery; the extended step 7a — WORKING-outcome PENDING trades) plus the
 * boot-time immediate sweep wiring. Deterministic: a scripted in-memory
 * store + fake adapter; NO real broker, NO timing dependence.
 */

const TRADE_REPO = getRepositoryToken(Trade);
const ORDER_REPO = getRepositoryToken(Order);
const ACCOUNT_REPO = getRepositoryToken(BrokerAccount);
const INTENT_REPO = getRepositoryToken(TradeIntent);
const GRANT_REPO = getRepositoryToken(RiskGrant);

const connection = (): BrokerConnection =>
  ({
    id: 'conn-1',
    userId: 'user-1',
    brokerId: 'paper-broker',
    accountId: 'paper-account-001',
    accountType: 'DEMO',
    status: 'CONNECTED',
    credentialStatus: 'VERIFIED',
    encryptedCredentials: null,
    credentialIv: null,
    credentialTag: null,
    encryptionKeyId: null,
  }) as unknown as BrokerConnection;

const STALE = new Date('2025-01-01T00:00:00Z'); // far past the 5-min grace

const pendingTrade = (_overrides: Partial<Record<string, unknown>> = {}) =>
  ({
    id: 'trade-1',
    userId: 'user-1',
    brokerConnectionId: 'conn-1',
    instrument: 'EURUSD',
    direction: 'BUY',
    lotSize: '0.1000',
    status: TradeStatus.PENDING,
    riskGrantId: 'grant-1',
    externalOrderId: null,
    externalPositionId: null,
    createdAt: STALE,
  }) as unknown as Trade;

const openTrade = () =>
  ({
    ...pendingTrade(),
    id: 'trade-open-1',
    status: TradeStatus.OPEN,
    externalOrderId: 'pos-1',
  }) as unknown as Trade;

const entryOrder = (overrides: Partial<Record<string, unknown>> = {}) =>
  ({
    id: 'order-1',
    userId: 'user-1',
    brokerConnectionId: 'conn-1',
    clientOrderId: 'sig-sig-1',
    providerOrderId: null,
    status: OrderStatus.CREATED,
    submittedAt: STALE,
    createdAt: STALE,
    updatedAt: STALE,
    instrument: 'EURUSD',
    orderKind: 'MARKET',
    requestedQuantity: '0.1000',
    filledQuantity: '0.0000',
    requestedPrice: null,
    tradeId: 'trade-1',
    ...overrides,
  }) as unknown as Order;

const closeOrder = () =>
  ({
    ...entryOrder(),
    id: 'order-close-1',
    clientOrderId: 'close-trade-open-1',
    status: OrderStatus.SUBMITTED,
    tradeId: 'trade-open-1',
  }) as unknown as Order;

const activeGrant = () =>
  ({ id: 'grant-1', status: RiskGrantStatus.ACTIVE, userId: 'user-1' }) as RiskGrant;

const consumedGrant = () =>
  ({ id: 'grant-1', status: RiskGrantStatus.CONSUMED, userId: 'user-1' }) as RiskGrant;

describe('Round 7.1 (P0-5): crash/restart recovery — pre-commitment convergence (step 7d)', () => {
  let service: StateReconciliationService;
  let trades: Trade[];
  let orders: Order[];
  let grant: RiskGrant | null;
  let intent: (TradeIntent & { tradeId: string | null }) | null;
  let tradeUpdates: Array<{ where: unknown; set: unknown }>;
  let orderService: { resolveReconciliation: jest.Mock };
  let allocationService: { releaseAllocationForIntent: jest.Mock };
  let auditService: { log: jest.Mock };
  let adapter: Record<string, jest.Mock>;

  const buildService = async (): Promise<StateReconciliationService> => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        StateReconciliationService,
        {
          provide: TRADE_REPO,
          useValue: {
            find: jest.fn(async () => trades),
            findOne: jest.fn(
              async ({ where }: { where: { id: string } }) =>
                trades.find((t) => t.id === where.id) ?? null,
            ),
            update: jest.fn(async (where: unknown, set: unknown) => {
              tradeUpdates.push({ where, set });
              return { affected: 1 };
            }),
            createQueryBuilder: jest.fn().mockReturnValue({
              select: jest.fn().mockReturnThis(),
              where: jest.fn().mockReturnThis(),
              getRawMany: jest.fn().mockResolvedValue([]),
            }),
          },
        },
        {
          provide: ORDER_REPO,
          useValue: {
            find: jest.fn(async () => orders),
            createQueryBuilder: jest.fn().mockReturnValue({
              select: jest.fn().mockReturnThis(),
              where: jest.fn().mockReturnThis(),
              getRawMany: jest.fn().mockResolvedValue([]),
            }),
          },
        },
        {
          provide: ACCOUNT_REPO,
          useValue: {
            findOne: jest.fn().mockResolvedValue(null),
            createQueryBuilder: jest.fn().mockReturnValue({
              select: jest.fn().mockReturnThis(),
              getRawMany: jest.fn().mockResolvedValue([]),
            }),
          },
        },
        {
          provide: BrokerService,
          useValue: {
            applyProviderAccountSnapshot: jest.fn().mockResolvedValue(undefined),
            findConnectionsByIds: jest.fn().mockResolvedValue([]),
            assertConnectionEnvironment: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: BrokerAdapterRegistry,
          useValue: { getAdapterForConnection: jest.fn().mockReturnValue(adapter) },
        },
        { provide: CredentialEncryptionService, useValue: { decrypt: jest.fn() } },
        {
          provide: ReconciliationPersistenceService,
          useValue: {
            createRun: jest
              .fn()
              .mockResolvedValue({ id: 'run-1', status: ReconciliationRunStatus.RUNNING }),
            completeRun: jest.fn().mockResolvedValue(undefined),
            failRun: jest.fn().mockResolvedValue(undefined),
            persistDiscrepancies: jest
              .fn()
              .mockResolvedValue({ inserted: 0, refreshed: 0, newRows: [] }),
            resolveDiscrepanciesByRef: jest.fn().mockResolvedValue([]),
            countOpenDiscrepancies: jest.fn().mockResolvedValue(0),
          },
        },
        {
          provide: ReconciliationResolutionService,
          useValue: {
            closeTradeFromProvider: jest.fn().mockResolvedValue(false),
            recoverTradeToOpen: jest.fn().mockResolvedValue(false),
            resolveOrderFromProviderState: jest.fn().mockResolvedValue(false),
          },
        },
        { provide: OrderService, useValue: orderService },
        {
          provide: INTENT_REPO,
          useValue: {
            findOne: jest.fn(async () => intent),
          },
        },
        {
          provide: GRANT_REPO,
          useValue: {
            findOne: jest.fn(async () => grant),
          },
        },
        { provide: AllocationService, useValue: allocationService },
        { provide: AuditService, useValue: auditService },
        { provide: DomainEventBus, useValue: { publish: jest.fn() } },
      ],
    }).compile();
    return moduleRef.get(StateReconciliationService);
  };

  beforeEach(async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});

    trades = [];
    orders = [];
    grant = activeGrant();
    intent = { id: 'intent-1', tradeId: 'trade-1' } as TradeIntent & { tradeId: string };
    tradeUpdates = [];
    orderService = { resolveReconciliation: jest.fn().mockResolvedValue({}) };
    allocationService = { releaseAllocationForIntent: jest.fn().mockResolvedValue(undefined) };
    auditService = { log: jest.fn().mockResolvedValue(undefined) };
    adapter = {
      setMode: jest.fn(),
      connect: jest.fn().mockResolvedValue({ success: true, accountType: 'DEMO' }),
      listOrders: jest.fn().mockResolvedValue([]),
      getOpenPositions: jest.fn().mockResolvedValue([]),
      getAccountInfo: jest.fn().mockResolvedValue({
        accountId: 'a',
        currency: 'USD',
        leverage: 100,
        balance: '10000.00',
        equity: '10000.00',
        margin: '0.00',
        freeMargin: '10000.00',
        marginLevel: '0.00',
      }),
      getPositionById: jest.fn().mockResolvedValue(null),
      getClosedTrades: jest.fn().mockResolvedValue([]),
      getOrderById: jest.fn().mockResolvedValue(null),
    };

    // "The crashed process" is simulated by the seeded store; the service
    // under test is ALWAYS a fresh instance (the restarted process) built
    // over the same persisted state.
    service = await buildService();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('boundary A (crash before trade/order reservation — grant ACTIVE, intent CREATED): the sweep creates NOTHING (the expiry sweeper owns this state)', async () => {
    trades = [];
    orders = [];
    grant = activeGrant();
    intent = null;

    const outcome = await service.runForConnection(connection());

    expect(outcome.status).toBe(ReconciliationRunStatus.COMPLETED);
    expect(orderService.resolveReconciliation).not.toHaveBeenCalled();
    expect(tradeUpdates).toHaveLength(0);
    expect(allocationService.releaseAllocationForIntent).not.toHaveBeenCalled();
  });

  it('boundary B (crash after trade/order reservation, before submission — order CREATED + trade PENDING + grant ACTIVE): provable DEFINITELY_NOT_SENT — order+trade REJECTED, allocation RELEASED, audited', async () => {
    trades = [pendingTrade()];
    orders = [entryOrder({ status: OrderStatus.CREATED })];
    grant = activeGrant();
    intent = { id: 'intent-1', tradeId: 'trade-1' } as TradeIntent & { tradeId: string };

    const outcome = await service.runForConnection(connection());

    expect(outcome.status).toBe(ReconciliationRunStatus.COMPLETED);
    // The order is TERMINALLY rejected — provably never dispatched (the
    // grant was never consumed; the commitment never ran).
    expect(orderService.resolveReconciliation).toHaveBeenCalledWith(
      'order-1',
      OrderStatus.REJECTED,
      expect.objectContaining({
        rejectReason: expect.stringContaining('DEFINITELY_NOT_SENT'),
      }),
    );
    // The reserved trade is released with the typed certainty.
    expect(tradeUpdates).toContainEqual({
      where: { id: 'trade-1', status: TradeStatus.PENDING },
      set: expect.objectContaining({
        status: TradeStatus.REJECTED,
        dispatchCertainty: 'DEFINITELY_NOT_SENT',
      }),
    });
    // The leaked capital allocation is terminally released.
    expect(allocationService.releaseAllocationForIntent).toHaveBeenCalledWith(
      'intent-1',
      'PRE_COMMITMENT_RECOVERY',
    );
    // Auditable remediation (§29 visibility).
    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.RECONCILIATION_DISCREPANCY_DETECTED,
        severity: AuditSeverity.WARNING,
        metadata: expect.objectContaining({ finding: 'PRE_COMMITMENT_CRASH_RECOVERED' }),
      }),
    );
  });

  it('boundary C (crash after submission, before the commitment — order SUBMITTED + trade PENDING + grant ACTIVE): the same provable convergence', async () => {
    trades = [pendingTrade()];
    orders = [entryOrder({ status: OrderStatus.SUBMITTED })];
    grant = activeGrant();

    await service.runForConnection(connection());

    expect(orderService.resolveReconciliation).toHaveBeenCalledWith(
      'order-1',
      OrderStatus.REJECTED,
      expect.objectContaining({
        rejectReason: expect.stringContaining('DEFINITELY_NOT_SENT'),
      }),
    );
    expect(tradeUpdates).toContainEqual({
      where: { id: 'trade-1', status: TradeStatus.PENDING },
      set: expect.objectContaining({ status: TradeStatus.REJECTED }),
    });
    expect(allocationService.releaseAllocationForIntent).toHaveBeenCalledWith(
      'intent-1',
      'PRE_COMMITMENT_RECOVERY',
    );
  });

  it('boundary C-corrupt (grant CONSUMED while the order never committed — an atomic-transaction impossibility): surfaced CRITICAL, converged UNCERTAIN, never auto-rejected', async () => {
    trades = [pendingTrade()];
    orders = [entryOrder({ status: OrderStatus.SUBMITTED })];
    grant = consumedGrant();

    await service.runForConnection(connection());

    // Uncertain convergence — NOT a terminal rejection (a consumed grant
    // means the provider call may have started).
    expect(orderService.resolveReconciliation).toHaveBeenCalledWith(
      'order-1',
      OrderStatus.RECONCILIATION_PENDING,
      expect.objectContaining({
        rejectReason: expect.stringContaining('corrupt state'),
      }),
    );
    // The trade is NOT rejected (no provable non-exposure).
    expect(tradeUpdates).toHaveLength(0);
    expect(allocationService.releaseAllocationForIntent).not.toHaveBeenCalled();
    // Loud CRITICAL surfacing for manual resolution.
    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.RECONCILIATION_DISCREPANCY_DETECTED,
        severity: AuditSeverity.CRITICAL,
        metadata: expect.objectContaining({ finding: 'CONSUMED_GRANT_WITHOUT_COMMITMENT' }),
      }),
    );
  });

  it('close-order crash (SUBMITTED close with NO grant — no commitment anchor exists for closes): converged UNCERTAIN, never auto-rejected; the OPEN trade is left to the position loop', async () => {
    trades = [openTrade()];
    orders = [closeOrder()];
    grant = null; // close orders carry no grant
    intent = null;

    await service.runForConnection(connection());

    expect(orderService.resolveReconciliation).toHaveBeenCalledWith(
      'order-close-1',
      OrderStatus.RECONCILIATION_PENDING,
      expect.objectContaining({
        rejectReason: expect.stringContaining('unprovable'),
      }),
    );
    // The OPEN trade is NOT touched by 7d (a possibly-executed close is the
    // position loop's truth: 7a converges it from provider state).
    expect(tradeUpdates).toHaveLength(0);
    expect(allocationService.releaseAllocationForIntent).not.toHaveBeenCalled();
    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ finding: 'UNPROVABLE_PRE_COMMITMENT_CLOSE' }),
      }),
    );
  });

  it('grace window: a LIVE in-flight dispatch (order minutes old) is NEVER touched by the recovery', async () => {
    const fresh = new Date(Date.now() - 10_000); // 10s ago — in flight
    trades = [pendingTrade()];
    orders = [
      entryOrder({
        status: OrderStatus.SUBMITTED,
        updatedAt: fresh,
        createdAt: fresh,
        submittedAt: fresh,
      }),
    ];
    grant = activeGrant();

    await service.runForConnection(connection());

    expect(orderService.resolveReconciliation).not.toHaveBeenCalled();
    expect(tradeUpdates).toHaveLength(0);
    expect(allocationService.releaseAllocationForIntent).not.toHaveBeenCalled();
  });

  it('WORKING-outcome restart edge: a PENDING trade with a LIVE provider position is recovered to OPEN (previously NO convergence branch existed)', async () => {
    const working = {
      ...pendingTrade(),
      id: 'trade-working-1',
      externalOrderId: 'pos-9',
    } as Trade;
    trades = [working];
    orders = []; // the WORKING case: the order already converged to ACKNOWLEDGED
    adapter.getPositionById.mockResolvedValue({
      externalOrderId: 'pos-9',
      instrument: 'EURUSD',
      direction: 'BUY',
      volume: '0.1000',
      openPrice: '1.08500',
      openTime: STALE,
      unrealizedPnl: '0',
    });

    const resolutionRecover = jest.fn().mockResolvedValue(true);
    // Rebuild the service with a recovering resolution seam (the real
    // recoverTradeToOpen matrix — including PENDING→OPEN — is pinned in
    // reconciliation-resolution.service.spec.ts).
    const moduleRef = await Test.createTestingModule({
      providers: [
        StateReconciliationService,
        {
          provide: TRADE_REPO,
          useValue: {
            find: jest.fn(async () => trades),
            findOne: jest.fn(async () => working),
            update: jest.fn().mockResolvedValue({ affected: 1 }),
            createQueryBuilder: jest.fn().mockReturnValue({
              select: jest.fn().mockReturnThis(),
              where: jest.fn().mockReturnThis(),
              getRawMany: jest.fn().mockResolvedValue([]),
            }),
          },
        },
        {
          provide: ORDER_REPO,
          useValue: {
            find: jest.fn(async () => orders),
            createQueryBuilder: jest.fn().mockReturnValue({
              select: jest.fn().mockReturnThis(),
              where: jest.fn().mockReturnThis(),
              getRawMany: jest.fn().mockResolvedValue([]),
            }),
          },
        },
        {
          provide: ACCOUNT_REPO,
          useValue: {
            findOne: jest.fn().mockResolvedValue(null),
            createQueryBuilder: jest.fn().mockReturnValue({
              select: jest.fn().mockReturnThis(),
              getRawMany: jest.fn().mockResolvedValue([]),
            }),
          },
        },
        {
          provide: BrokerService,
          useValue: {
            applyProviderAccountSnapshot: jest.fn().mockResolvedValue(undefined),
            findConnectionsByIds: jest.fn().mockResolvedValue([]),
            assertConnectionEnvironment: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: BrokerAdapterRegistry,
          useValue: { getAdapterForConnection: jest.fn().mockReturnValue(adapter) },
        },
        { provide: CredentialEncryptionService, useValue: { decrypt: jest.fn() } },
        {
          provide: ReconciliationPersistenceService,
          useValue: {
            createRun: jest
              .fn()
              .mockResolvedValue({ id: 'run-1', status: ReconciliationRunStatus.RUNNING }),
            completeRun: jest.fn().mockResolvedValue(undefined),
            failRun: jest.fn().mockResolvedValue(undefined),
            persistDiscrepancies: jest
              .fn()
              .mockResolvedValue({ inserted: 0, refreshed: 0, newRows: [] }),
            resolveDiscrepanciesByRef: jest.fn().mockResolvedValue([]),
            countOpenDiscrepancies: jest.fn().mockResolvedValue(0),
          },
        },
        {
          provide: ReconciliationResolutionService,
          useValue: {
            closeTradeFromProvider: jest.fn().mockResolvedValue(false),
            recoverTradeToOpen: resolutionRecover,
            resolveOrderFromProviderState: jest.fn().mockResolvedValue(false),
          },
        },
        { provide: OrderService, useValue: orderService },
        {
          provide: INTENT_REPO,
          useValue: { findOne: jest.fn().mockResolvedValue(null) },
        },
        {
          provide: GRANT_REPO,
          useValue: { findOne: jest.fn().mockResolvedValue(null) },
        },
        { provide: AllocationService, useValue: allocationService },
        { provide: AuditService, useValue: auditService },
        { provide: DomainEventBus, useValue: { publish: jest.fn() } },
      ],
    }).compile();
    const freshService = moduleRef.get(StateReconciliationService);

    await freshService.runForConnection(connection());

    // The provider-observed live position recovers the PENDING (WORKING)
    // trade through the same recovery seam as RECONCILIATION_PENDING.
    expect(resolutionRecover).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'trade-working-1', status: TradeStatus.PENDING }),
    );
  });

  it('no duplicate exposure: the recovered REJECTED trade keeps its reservation RELEASED — a second sweep over the same store is idempotent (nothing re-converges)', async () => {
    trades = [pendingTrade()];
    orders = [entryOrder({ status: OrderStatus.CREATED })];

    await service.runForConnection(connection());
    const firstPassCalls = orderService.resolveReconciliation.mock.calls.length;

    // Simulate the post-convergence store: both rows terminal.
    trades = [{ ...pendingTrade(), status: TradeStatus.REJECTED } as Trade];
    orders = [{ ...entryOrder(), status: OrderStatus.REJECTED } as Order];

    // A FRESH process (second restart) over the converged store.
    const secondService = await buildService();
    await secondService.runForConnection(connection());

    expect(orderService.resolveReconciliation.mock.calls.length).toBe(firstPassCalls);
    expect(
      tradeUpdates.filter((u) => (u.set as { status?: string }).status === TradeStatus.REJECTED),
    ).toHaveLength(1);
  });
});

describe('Round 7.1 (P0-5): boot-time immediate recovery sweep (producer wiring)', () => {
  it('the producer enqueues the repeatable schedule AND one immediate recovery job on boot', async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    const { TradeReconciliationProducer } = await import('../jobs/trade-reconciliation.producer');
    const { TRADE_RECONCILIATION_QUEUE } = await import('../jobs/trade-reconciliation.job');

    const queue = {
      getRepeatableJobs: jest.fn().mockResolvedValue([{ key: 'stale' }]),
      removeRepeatableByKey: jest.fn().mockResolvedValue(undefined),
      add: jest.fn().mockResolvedValue({}),
    };
    const producer = new TradeReconciliationProducer(queue as never);

    await producer.onModuleInit();

    // Stale repeatables stripped, the repeatable re-registered…
    expect(queue.removeRepeatableByKey).toHaveBeenCalledWith('stale');
    expect(queue.add).toHaveBeenCalledWith(
      expect.any(String),
      {},
      expect.objectContaining({ repeat: expect.anything() }),
    );
    // …AND the immediate boot-time recovery sweep (a restart must not wait a
    // full 60s interval before converging crash-left states).
    expect(queue.add).toHaveBeenCalledWith(expect.any(String), { immediateRecovery: true });
    expect(queue.add).toHaveBeenCalledTimes(2);
    // Queue identity sanity.
    expect(TRADE_RECONCILIATION_QUEUE).toBe('trade-reconciliation');
  });
});
