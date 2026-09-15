import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BrokerConnection } from '../../broker/entities/broker-connection.entity';
import { BrokerAccount } from '../../broker/entities/broker-account.entity';
import { BrokerService } from '../../broker/broker.service';
import { BrokerAdapterRegistry } from '../../broker/adapters/broker-adapter.registry';
import { CredentialEncryptionService } from '../../broker/services/credential-encryption.service';
import { AuditService } from '../../audit/audit.service';
import { DomainEventBus } from '../../events/event-bus.service';
import { Trade, TradeStatus } from '../entities/trade.entity';
import { Order } from '../orders/order.entity';
import { OrderStatus } from '../orders/order.enums';
import { OrderService } from '../orders/order.service';
import { StateReconciliationService } from './state-reconciliation.service';
import { ReconciliationPersistenceService } from './reconciliation-persistence.service';
import { ReconciliationResolutionService } from './reconciliation-resolution.service';
import { ReconciliationRunStatus } from './reconciliation.enums';
import { ProviderDispatchCertainty } from '../../broker/interfaces/provider-dispatch-certainty';

/**
 * Round 6 live-execution completion (§12/§19/§13) — CRASH-WINDOW CONVERGENCE
 * adversarial matrix.
 *
 * The crash window: a hard process death BETWEEN the provider-dispatch
 * commitment (order DISPATCH_COMMITTED, grant consumed) and the outcome
 * write. Before Round 6 the sweep's candidate sets EXCLUDED both
 * DISPATCH_COMMITTED orders and PENDING trades — the window was invisible
 * to reconciliation forever.
 *
 * Matrix (the REAL StateReconciliationService; collaborators mocked at the
 * seam):
 *   - a DISPATCH_COMMITTED order the provider echoes by clientOrderId →
 *     resolved from the provider state (the dispatch PROVABLY arrived)
 *   - a DISPATCH_COMMITTED order absent at the provider + its PENDING trade
 *     → both converged to RECONCILIATION_PENDING, trade stamped
 *     MAY_HAVE_REACHED_PROVIDER (uncertain exposure retained — NEVER
 *     auto-closed)
 *   - the trade guarded update loses the race (affected=0) → no resolution
 *     ref, no error (exactly-once: the concurrent winner owns the trade)
 *   - the order convergence throws (concurrent writer won) → guard held,
 *     cycle continues, no crash
 *   - orders WITH providerOrderId never enter the 7c path (7b owns them)
 *   - non-DISPATCH_COMMITTED orders never enter 7c
 *   - every cycle re-attempts the clientOrderId match (sync lag heals)
 */

const TRADE_REPO = getRepositoryToken(Trade);
const ORDER_REPO = getRepositoryToken(Order);
const ACCOUNT_REPO = getRepositoryToken(BrokerAccount);

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

/** The crash-window trade: reserved (PENDING), never outcome-written. */
const pendingTrade = (_overrides: Partial<Trade> = {}): Trade =>
  ({
    id: 'trade-1',
    userId: 'user-1',
    brokerConnectionId: 'conn-1',
    instrument: 'EURUSD',
    direction: 'BUY',
    lotSize: '0.1000',
    status: TradeStatus.PENDING,
    externalOrderId: null,
    externalPositionId: null,
    stopLoss: '1.07500',
    takeProfit: '1.09500',
    createdAt: new Date('2025-01-01T00:00:00Z'),
  }) as unknown as Trade;

/** The crash-window order: committed, provider outcome never written. */
const committedOrder = (overrides: Partial<Order> = {}): Order =>
  ({
    id: 'order-1',
    userId: 'user-1',
    brokerConnectionId: 'conn-1',
    clientOrderId: 'sig-sig-1',
    providerOrderId: null,
    status: OrderStatus.DISPATCH_COMMITTED,
    submittedAt: new Date('2025-01-01T00:00:00Z'),
    instrument: 'EURUSD',
    orderKind: 'MARKET',
    requestedQuantity: '0.1000',
    filledQuantity: '0.0000',
    requestedPrice: null,
    tradeId: 'trade-1',
    ...overrides,
  }) as unknown as Order;

describe('StateReconciliationService — §12/§19 crash-window convergence (Round 6)', () => {
  let service: StateReconciliationService;
  let tradeRepo: {
    find: jest.Mock;
    update: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let orderRepo: { find: jest.Mock; createQueryBuilder: jest.Mock };
  let accountRepo: { findOne: jest.Mock; createQueryBuilder: jest.Mock };
  let brokerService: { applyProviderAccountSnapshot: jest.Mock; findConnectionsByIds: jest.Mock };
  let adapterRegistry: { getAdapterForConnection: jest.Mock };
  let persistence: {
    createRun: jest.Mock;
    completeRun: jest.Mock;
    failRun: jest.Mock;
    persistDiscrepancies: jest.Mock;
    resolveDiscrepanciesByRef: jest.Mock;
    countOpenDiscrepancies: jest.Mock;
  };
  let resolution: {
    closeTradeFromProvider: jest.Mock;
    recoverTradeToOpen: jest.Mock;
    resolveOrderFromProviderState: jest.Mock;
  };
  let orderService: { resolveReconciliation: jest.Mock };
  let adapter: {
    setMode: jest.Mock;
    connect: jest.Mock;
    listOrders: jest.Mock;
    getOpenPositions: jest.Mock;
    getAccountInfo: jest.Mock;
    getPositionById: jest.Mock;
    getClosedTrades: jest.Mock;
    getOrderById: jest.Mock;
  };

  beforeEach(async () => {
    adapter = {
      setMode: jest.fn(),
      connect: jest.fn().mockResolvedValue({ success: true }),
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

    tradeRepo = {
      find: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      createQueryBuilder: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([]),
      }),
    };
    orderRepo = {
      find: jest.fn().mockResolvedValue([]),
      createQueryBuilder: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([]),
      }),
    };
    accountRepo = {
      findOne: jest.fn().mockResolvedValue(null),
      createQueryBuilder: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([]),
      }),
    };
    brokerService = {
      applyProviderAccountSnapshot: jest.fn().mockResolvedValue(undefined),
      findConnectionsByIds: jest.fn().mockResolvedValue([]),
    };
    adapterRegistry = { getAdapterForConnection: jest.fn().mockReturnValue(adapter) };
    persistence = {
      createRun: jest
        .fn()
        .mockResolvedValue({ id: 'run-1', status: ReconciliationRunStatus.RUNNING }),
      completeRun: jest.fn().mockResolvedValue(undefined),
      failRun: jest.fn().mockResolvedValue(undefined),
      persistDiscrepancies: jest.fn().mockResolvedValue({ inserted: 0, refreshed: 0, newRows: [] }),
      resolveDiscrepanciesByRef: jest.fn().mockResolvedValue([]),
      countOpenDiscrepancies: jest.fn().mockResolvedValue(0),
    };
    resolution = {
      closeTradeFromProvider: jest.fn().mockResolvedValue(false),
      recoverTradeToOpen: jest.fn().mockResolvedValue(false),
      resolveOrderFromProviderState: jest.fn().mockResolvedValue(false),
    };
    orderService = { resolveReconciliation: jest.fn().mockResolvedValue({}) };

    const module = await Test.createTestingModule({
      providers: [
        StateReconciliationService,
        { provide: TRADE_REPO, useValue: tradeRepo },
        { provide: ORDER_REPO, useValue: orderRepo },
        { provide: ACCOUNT_REPO, useValue: accountRepo },
        { provide: BrokerService, useValue: brokerService },
        { provide: BrokerAdapterRegistry, useValue: adapterRegistry },
        { provide: CredentialEncryptionService, useValue: { decrypt: jest.fn() } },
        { provide: ReconciliationPersistenceService, useValue: persistence },
        { provide: ReconciliationResolutionService, useValue: resolution },
        { provide: OrderService, useValue: orderService },
        { provide: AuditService, useValue: { log: jest.fn().mockResolvedValue(undefined) } },
        { provide: DomainEventBus, useValue: { publish: jest.fn() } },
      ],
    }).compile();

    service = module.get(StateReconciliationService);
  });

  it('a DISPATCH_COMMITTED order echoed by clientOrderId resolves from the provider state', async () => {
    orderRepo.find.mockResolvedValue([committedOrder()]);
    tradeRepo.find.mockResolvedValue([pendingTrade()]);
    adapter.listOrders.mockResolvedValue([
      {
        providerOrderId: 'ticket-9',
        clientOrderId: 'sig-sig-1',
        status: 'FILLED',
        instrument: 'EURUSD',
        direction: 'BUY',
        requestedQuantity: '0.1000',
        filledQuantity: '0.1000',
        avgFillPrice: '1.08500',
        createdAt: new Date(),
      },
    ]);

    await service.runForConnection(connection());

    // The dispatch PROVABLY reached the provider — its state is the truth.
    expect(resolution.resolveOrderFromProviderState).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'order-1', status: OrderStatus.DISPATCH_COMMITTED }),
      expect.objectContaining({ providerOrderId: 'ticket-9', status: 'FILLED' }),
    );
    // The uncertain path was NOT taken (no RECONCILIATION_PENDING convergence).
    expect(orderService.resolveReconciliation).not.toHaveBeenCalled();
    expect(tradeRepo.update).not.toHaveBeenCalledWith();
  });

  it('an absent-at-provider committed order + PENDING trade converge to RECONCILIATION_PENDING (uncertain, never auto-closed)', async () => {
    orderRepo.find.mockResolvedValue([committedOrder()]);
    tradeRepo.find.mockResolvedValue([pendingTrade()]);
    // Provider sees nothing for this clientOrderId.

    await service.runForConnection(connection());

    // Order: DISPATCH_COMMITTED → RECONCILIATION_PENDING (state-machine legal).
    expect(orderService.resolveReconciliation).toHaveBeenCalledWith(
      'order-1',
      OrderStatus.RECONCILIATION_PENDING,
      expect.objectContaining({
        rejectReason: expect.stringContaining('Crash-window convergence'),
      }),
    );
    // Trade: guarded PENDING → RECONCILIATION_PENDING with uncertain certainty
    // (the daily-capacity reservation is RETAINED — never auto-closed).
    expect(tradeRepo.update).toHaveBeenCalledWith(
      { id: 'trade-1', status: TradeStatus.PENDING },
      {
        status: TradeStatus.RECONCILIATION_PENDING,
        brokerRejectionReason: expect.stringContaining('MAY_HAVE_REACHED_PROVIDER'),
        dispatchCertainty: ProviderDispatchCertainty.MAY_HAVE_REACHED_PROVIDER,
      },
    );
  });

  it('the guarded trade update losing the race (affected=0) records nothing (exactly-once)', async () => {
    orderRepo.find.mockResolvedValue([committedOrder()]);
    tradeRepo.find.mockResolvedValue([pendingTrade()]);
    tradeRepo.update.mockResolvedValue({ affected: 0 }); // concurrent winner exists

    const outcome = await service.runForConnection(connection());

    expect(tradeRepo.update).toHaveBeenCalled(); // attempted
    expect(outcome.status).toBe(ReconciliationRunStatus.COMPLETED); // no crash
    // No UNRESOLVED_EXECUTION_RESULT ref was pushed for the lost race: the
    // persisted discrepancy rows resolved by this run exclude the trade.
    const resolvedRefs = persistence.resolveDiscrepanciesByRef.mock.calls[0]?.[1] ?? [];
    expect(resolvedRefs.some((r: { internalRefId: string }) => r.internalRefId === 'trade-1')).toBe(
      false,
    );
  });

  it('a concurrent order-writer throwing never breaks the cycle (guard held)', async () => {
    orderRepo.find.mockResolvedValue([committedOrder()]);
    tradeRepo.find.mockResolvedValue([pendingTrade()]);
    orderService.resolveReconciliation.mockRejectedValue(new Error('transition conflict'));

    const outcome = await service.runForConnection(connection());

    expect(outcome.status).toBe(ReconciliationRunStatus.COMPLETED);
    // The trade convergence still attempted after the order loss.
    expect(tradeRepo.update).toHaveBeenCalled();
  });

  it('orders WITH a providerOrderId never enter the 7c crash-window path (7b owns them)', async () => {
    orderRepo.find.mockResolvedValue([
      committedOrder({ providerOrderId: 'ticket-1', status: OrderStatus.RECONCILIATION_PENDING }),
    ]);
    adapter.listOrders.mockResolvedValue([]);

    await service.runForConnection(connection());

    expect(orderService.resolveReconciliation).not.toHaveBeenCalled();
    expect(resolution.resolveOrderFromProviderState).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: 'order-1' }),
      expect.anything(),
    );
  });

  it('non-DISPATCH_COMMITTED orders never enter the crash-window path', async () => {
    orderRepo.find.mockResolvedValue([
      committedOrder({ status: OrderStatus.SUBMITTED }),
      committedOrder({ id: 'order-2', status: OrderStatus.RECONCILIATION_PENDING }),
    ]);

    await service.runForConnection(connection());

    expect(orderService.resolveReconciliation).not.toHaveBeenCalled();
    expect(tradeRepo.update).not.toHaveBeenCalled();
  });

  it('every cycle re-attempts the clientOrderId match (provider sync lag heals)', async () => {
    orderRepo.find.mockResolvedValue([committedOrder()]);
    tradeRepo.find.mockResolvedValue([pendingTrade()]);

    // Cycle 1: provider list misses the order (sync lag) → uncertain path.
    adapter.listOrders.mockResolvedValueOnce([]);
    await service.runForConnection(connection());
    expect(orderService.resolveReconciliation).toHaveBeenCalledTimes(1);
    expect(tradeRepo.update).toHaveBeenCalledTimes(1);

    // Cycle 2: the provider now echoes it (lag healed) → provider truth wins.
    orderService.resolveReconciliation.mockClear();
    tradeRepo.update.mockClear();
    adapter.listOrders.mockResolvedValueOnce([
      {
        providerOrderId: 'ticket-9',
        clientOrderId: 'sig-sig-1',
        status: 'FILLED',
        instrument: 'EURUSD',
        direction: 'BUY',
        requestedQuantity: '0.1000',
        filledQuantity: '0.1000',
        avgFillPrice: '1.08500',
        createdAt: new Date(),
      },
    ]);
    await service.runForConnection(connection());
    expect(resolution.resolveOrderFromProviderState).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'order-1' }),
      expect.objectContaining({ providerOrderId: 'ticket-9' }),
    );
  });

  it('a crash-window order WITHOUT a linked trade converges the order only', async () => {
    orderRepo.find.mockResolvedValue([committedOrder({ tradeId: null })]);
    tradeRepo.find.mockResolvedValue([]);

    await service.runForConnection(connection());

    expect(orderService.resolveReconciliation).toHaveBeenCalledTimes(1);
    expect(tradeRepo.update).not.toHaveBeenCalled();
  });
});
