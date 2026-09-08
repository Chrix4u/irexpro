import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BrokerConnection } from '../../broker/entities/broker-connection.entity';
import { BrokerAccount } from '../../broker/entities/broker-account.entity';
import { BrokerService } from '../../broker/broker.service';
import { BrokerAdapterRegistry } from '../../broker/adapters/broker-adapter.registry';
import { CredentialEncryptionService } from '../../broker/services/credential-encryption.service';
import { AuditService } from '../../audit/audit.service';
import { DomainEventBus } from '../../events/event-bus.service';
import { DomainEventType } from '../../events/enums/domain-event-type.enum';
import { Trade, TradeStatus } from '../entities/trade.entity';
import { Order } from '../orders/order.entity';
import { OrderStatus } from '../orders/order.enums';
import { OrderService } from '../orders/order.service';
import { StateReconciliationService } from './state-reconciliation.service';
import { ReconciliationPersistenceService } from './reconciliation-persistence.service';
import { ReconciliationResolutionService } from './reconciliation-resolution.service';
import { ReconciliationDiscrepancyType, ReconciliationRunStatus } from './reconciliation.enums';
import { AuditAction } from '../../../common/enums/audit-action.enum';

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
    // A3: usable credential lifecycle (tests override for the guard cases)
    credentialStatus: 'VERIFIED',
    encryptedCredentials: null,
    credentialIv: null,
    credentialTag: null,
    encryptionKeyId: null,
  }) as unknown as BrokerConnection;

const openTrade = (): Trade =>
  ({
    id: 'trade-1',
    userId: 'user-1',
    brokerConnectionId: 'conn-1',
    instrument: 'EURUSD',
    direction: 'BUY',
    lotSize: '1.0000',
    status: TradeStatus.OPEN,
    externalOrderId: 'pos-1',
    externalPositionId: null,
    openedAt: new Date('2025-01-01T00:00:00Z'),
  }) as unknown as Trade;

const pendingOrder = (): Order =>
  ({
    id: 'order-1',
    userId: 'user-1',
    brokerConnectionId: 'conn-1',
    clientOrderId: 'client-1',
    providerOrderId: 'ticket-1',
    status: OrderStatus.RECONCILIATION_PENDING,
    submittedAt: new Date('2025-01-01T00:00:00Z'),
    instrument: 'EURUSD',
    orderKind: 'LIMIT',
    requestedQuantity: '1.0000',
    filledQuantity: '0.0000',
    requestedPrice: '1.10000',
    tradeId: null,
  }) as unknown as Order;

describe('StateReconciliationService — Phase E: credential lifecycle + security model (architect corrections)', () => {
  let service: StateReconciliationService;
  let persistence: {
    createRun: jest.Mock;
    completeRun: jest.Mock;
    failRun: jest.Mock;
    persistDiscrepancies: jest.Mock;
    resolveDiscrepanciesByRef: jest.Mock;
    countOpenDiscrepancies: jest.Mock;
  };
  let adapter: { setMode: jest.Mock; connect: jest.Mock; listOrders: jest.Mock };
  let encryptionService: { decrypt: jest.Mock };
  let auditService: { log: jest.Mock };

  beforeEach(async () => {
    adapter = {
      setMode: jest.fn(),
      connect: jest.fn().mockResolvedValue({ success: true }),
      listOrders: jest.fn().mockResolvedValue([]),
    };
    encryptionService = { decrypt: jest.fn().mockReturnValue({ accountId: 'acc' }) };
    persistence = {
      createRun: jest.fn().mockResolvedValue({ id: 'run-1', status: 'RUNNING' }),
      completeRun: jest.fn().mockResolvedValue(undefined),
      failRun: jest.fn().mockResolvedValue(undefined),
      persistDiscrepancies: jest.fn().mockResolvedValue({ inserted: 0, refreshed: 0, newRows: [] }),
      resolveDiscrepanciesByRef: jest.fn().mockResolvedValue([]),
      countOpenDiscrepancies: jest.fn().mockResolvedValue(0),
    };
    auditService = { log: jest.fn().mockResolvedValue(undefined) };

    const module = await Test.createTestingModule({
      providers: [
        StateReconciliationService,
        {
          provide: TRADE_REPO,
          useValue: { find: jest.fn().mockResolvedValue([]), createQueryBuilder: jest.fn() },
        },
        {
          provide: ORDER_REPO,
          useValue: { find: jest.fn().mockResolvedValue([]), createQueryBuilder: jest.fn() },
        },
        {
          provide: ACCOUNT_REPO,
          useValue: { findOne: jest.fn().mockResolvedValue(null), createQueryBuilder: jest.fn() },
        },
        {
          provide: BrokerService,
          useValue: {
            applyProviderAccountSnapshot: jest.fn(),
            findConnectionsByIds: jest.fn().mockResolvedValue([]),
          },
        },
        {
          provide: BrokerAdapterRegistry,
          useValue: { getAdapter: jest.fn().mockReturnValue(adapter) },
        },
        { provide: CredentialEncryptionService, useValue: encryptionService },
        { provide: ReconciliationPersistenceService, useValue: persistence },
        {
          provide: ReconciliationResolutionService,
          useValue: {
            closeTradeFromProvider: jest.fn(),
            recoverTradeToOpen: jest.fn(),
            resolveOrderFromProviderState: jest.fn(),
          },
        },
        { provide: OrderService, useValue: {} },
        { provide: AuditService, useValue: auditService },
        { provide: DomainEventBus, useValue: { publish: jest.fn() } },
      ],
    }).compile();
    service = module.get(StateReconciliationService);
  });

  it.each(['INVALID', 'EXPIRED', 'REVOKED', undefined])(
    'A3: unusable credential lifecycle (%s) fails the run closed — adapter NEVER contacted',
    async (credentialStatus) => {
      const conn = { ...connection(), credentialStatus } as unknown as BrokerConnection;

      await service.runForConnection(conn);

      expect(adapter.connect).not.toHaveBeenCalled();
      expect(adapter.listOrders).not.toHaveBeenCalled();
      expect(encryptionService.decrypt).not.toHaveBeenCalled();
      // The run is recorded FAILED with the honest reason (never fabricated)
      expect(persistence.failRun).toHaveBeenCalledWith(
        'run-1',
        expect.stringContaining('credential lifecycle state'),
      );
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'RECONCILIATION_RUN_FAILED' }),
      );
    },
  );

  it('usable credential lifecycle proceeds to the provider read', async () => {
    await service.runForConnection(connection());
    expect(adapter.connect).toHaveBeenCalled();
  });
});

describe('StateReconciliationService', () => {
  let service: StateReconciliationService;
  let tradeRepo: { find: jest.Mock; createQueryBuilder: jest.Mock };
  let orderRepo: { find: jest.Mock; createQueryBuilder: jest.Mock };
  let accountRepo: { findOne: jest.Mock; createQueryBuilder: jest.Mock };
  let brokerService: { applyProviderAccountSnapshot: jest.Mock; findConnectionsByIds: jest.Mock };
  let adapterRegistry: { getAdapter: jest.Mock };
  let encryptionService: { decrypt: jest.Mock };
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
  let auditService: { log: jest.Mock };
  let eventBus: { publish: jest.Mock };
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
    adapterRegistry = { getAdapter: jest.fn().mockReturnValue(adapter) };
    encryptionService = { decrypt: jest.fn() };
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
      closeTradeFromProvider: jest.fn().mockResolvedValue(true),
      recoverTradeToOpen: jest.fn().mockResolvedValue(true),
      resolveOrderFromProviderState: jest.fn().mockResolvedValue(false),
    };
    auditService = { log: jest.fn().mockResolvedValue(undefined) };
    eventBus = { publish: jest.fn() };

    const module = await Test.createTestingModule({
      providers: [
        StateReconciliationService,
        { provide: TRADE_REPO, useValue: tradeRepo },
        { provide: ORDER_REPO, useValue: orderRepo },
        { provide: ACCOUNT_REPO, useValue: accountRepo },
        { provide: BrokerService, useValue: brokerService },
        { provide: BrokerAdapterRegistry, useValue: adapterRegistry },
        { provide: CredentialEncryptionService, useValue: encryptionService },
        { provide: ReconciliationPersistenceService, useValue: persistence },
        { provide: ReconciliationResolutionService, useValue: resolution },
        { provide: OrderService, useValue: {} },
        { provide: AuditService, useValue: auditService },
        { provide: DomainEventBus, useValue: eventBus },
      ],
    }).compile();

    service = module.get(StateReconciliationService);
  });

  describe('runForConnection — clean state', () => {
    it('completes with COMPLETED status and zero discrepancies', async () => {
      // Provider and internal agree: one position each.
      tradeRepo.find.mockResolvedValue([openTrade()]);
      adapter.getOpenPositions.mockResolvedValue([
        {
          externalOrderId: 'pos-1',
          instrument: 'EURUSD',
          direction: 'BUY',
          lotSize: '1.0000',
          openPrice: '1.10000',
          currentPrice: '1.10500',
          stopLoss: '0',
          takeProfit: '0',
          unrealisedPnl: '0.00',
          openedAt: new Date(),
          commission: '0.00',
          swap: '0.00',
        },
      ]);
      adapter.getPositionById.mockResolvedValue({
        externalOrderId: 'pos-1',
      });

      const outcome = await service.runForConnection(connection());

      expect(outcome.status).toBe(ReconciliationRunStatus.COMPLETED);
      expect(outcome.discrepanciesDetected).toBe(0);
      expect(persistence.completeRun).toHaveBeenCalledWith(
        'run-1',
        expect.objectContaining({ status: ReconciliationRunStatus.COMPLETED }),
      );
      expect(eventBus.publish).toHaveBeenCalledWith(
        DomainEventType.RECONCILIATION_RUN_COMPLETED,
        'user-1',
        expect.objectContaining({ runId: 'run-1', status: 'COMPLETED' }),
      );
    });

    it('never decrypts when no stored credential blob (paper path)', async () => {
      let receivedAtCall: Record<string, unknown> | null = null;
      adapter.connect.mockImplementation(async (c: Record<string, unknown>) => {
        receivedAtCall = { ...c }; // snapshot at call time (zeroing mutates after)
        return { success: true };
      });

      await service.runForConnection(connection());

      expect(encryptionService.decrypt).not.toHaveBeenCalled();
      expect(receivedAtCall).toMatchObject({ accountId: 'paper-account-001' });
    });

    it('connects with decrypted credentials and zeroes them after use', async () => {
      const conn = connection();
      (conn as unknown as Record<string, unknown>).encryptedCredentials = 'ct';
      (conn as unknown as Record<string, unknown>).credentialIv = 'iv';
      (conn as unknown as Record<string, unknown>).credentialTag = 'tag';
      (conn as unknown as Record<string, unknown>).encryptionKeyId = 'key';
      encryptionService.decrypt.mockReturnValue({ accountId: 'meta-uuid', apiKey: 'SECRET' });

      let receivedAtCall: Record<string, unknown> | null = null;
      const receivedRef: Record<string, unknown>[] = [];
      adapter.connect.mockImplementation(async (c: Record<string, unknown>) => {
        receivedAtCall = { ...c }; // snapshot at call time
        receivedRef.push(c); // same reference the service zeroed afterwards
        return { success: true };
      });

      await service.runForConnection(conn);

      expect(encryptionService.decrypt).toHaveBeenCalled();
      expect(receivedAtCall).toMatchObject({ accountId: 'meta-uuid' });
      // The SAME object the adapter received is zeroed after use — secrets
      // never linger in memory.
      expect(receivedRef[0].apiKey).toBeNull();
      expect(receivedRef[0].accountId).toBeNull();
    });

    it('syncs the account snapshot from provider truth (full field set)', async () => {
      await service.runForConnection(connection());
      expect(brokerService.applyProviderAccountSnapshot).toHaveBeenCalledWith(
        'conn-1',
        expect.objectContaining({ balance: '10000.00', marginLevel: '0.00' }),
        0,
      );
    });
  });

  describe('runForConnection — mismatches', () => {
    it('persists detected discrepancies and surfaces NEW ones (events + audits)', async () => {
      tradeRepo.find.mockResolvedValue([openTrade()]);
      adapter.getPositionById.mockResolvedValue(null); // position gone

      persistence.persistDiscrepancies.mockResolvedValue({
        inserted: 1,
        refreshed: 0,
        newRows: [
          {
            id: 'disc-1',
            type: ReconciliationDiscrepancyType.POSITION_CLOSED_EXTERNALLY,
            severity: 'WARNING',
            internalRefId: 'trade-1',
            providerRef: 'pos-1',
            clientOrderId: null,
          },
        ],
      });
      persistence.countOpenDiscrepancies.mockResolvedValue(0); // auto-resolved

      const outcome = await service.runForConnection(connection());

      expect(persistence.persistDiscrepancies).toHaveBeenCalled();
      expect(outcome.discrepanciesDetected).toBe(1);
      expect(outcome.discrepanciesNew).toBe(1);

      // Detected event + audit for the NEW row.
      expect(eventBus.publish).toHaveBeenCalledWith(
        DomainEventType.RECONCILIATION_DISCREPANCY_DETECTED,
        'user-1',
        expect.objectContaining({ discrepancyId: 'disc-1', type: 'POSITION_CLOSED_EXTERNALLY' }),
      );
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.RECONCILIATION_DISCREPANCY_DETECTED,
          severity: 'WARNING',
        }),
      );
    });

    it('auto-resolves externally-closed positions and resolves the row', async () => {
      tradeRepo.find.mockResolvedValue([openTrade()]);
      adapter.getPositionById.mockResolvedValue(null);
      adapter.getClosedTrades.mockResolvedValue([
        {
          externalOrderId: 'pos-1',
          closePrice: '1.12000',
          realisedPnl: '20.00',
        },
      ]);
      persistence.resolveDiscrepanciesByRef.mockResolvedValue([
        {
          id: 'disc-1',
          type: 'POSITION_CLOSED_EXTERNALLY',
          internalRefId: 'trade-1',
          providerRef: 'pos-1',
        },
      ]);

      const outcome = await service.runForConnection(connection());

      expect(resolution.closeTradeFromProvider).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'trade-1' }),
        expect.objectContaining({ closePrice: '1.12000' }),
      );
      expect(outcome.discrepanciesAutoResolved).toBe(1);
      expect(eventBus.publish).toHaveBeenCalledWith(
        DomainEventType.RECONCILIATION_DISCREPANCY_RESOLVED,
        'user-1',
        expect.objectContaining({ discrepancyId: 'disc-1' }),
      );
    });

    it('classifies runs with remaining OPEN discrepancies as COMPLETED_WITH_WARNINGS', async () => {
      persistence.countOpenDiscrepancies.mockResolvedValue(3);
      const outcome = await service.runForConnection(connection());
      expect(outcome.status).toBe(ReconciliationRunStatus.COMPLETED_WITH_WARNINGS);
      expect(persistence.completeRun).toHaveBeenCalledWith(
        'run-1',
        expect.objectContaining({
          status: ReconciliationRunStatus.COMPLETED_WITH_WARNINGS,
          counters: expect.objectContaining({ discrepanciesOpen: 3 }),
        }),
      );
    });

    it('resolves RECONCILIATION_PENDING trades whose provider position exists', async () => {
      tradeRepo.find.mockResolvedValue([
        { ...openTrade(), status: TradeStatus.RECONCILIATION_PENDING },
      ]);
      adapter.getPositionById.mockResolvedValue({ externalOrderId: 'pos-1' });
      persistence.resolveDiscrepanciesByRef.mockResolvedValue([]);

      await service.runForConnection(connection());

      expect(resolution.recoverTradeToOpen).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'trade-1', status: TradeStatus.RECONCILIATION_PENDING }),
      );
    });

    it('resolves orders by stable identifier via getOrderById (Directive §26)', async () => {
      orderRepo.find.mockResolvedValue([pendingOrder()]);
      adapter.getOrderById.mockResolvedValue({
        providerOrderId: 'ticket-1',
        status: 'FILLED',
        filledQuantity: '1.0000',
      });
      resolution.resolveOrderFromProviderState.mockResolvedValue(true);

      await service.runForConnection(connection());

      expect(adapter.getOrderById).toHaveBeenCalledWith('ticket-1');
      expect(resolution.resolveOrderFromProviderState).toHaveBeenCalled();
    });
  });

  describe('runForConnection — failure modes', () => {
    it('fails the run (never fabricates provider state) when the provider read fails', async () => {
      adapter.listOrders.mockRejectedValue(new Error('provider down'));

      const outcome = await service.runForConnection(connection());

      expect(outcome.status).toBe(ReconciliationRunStatus.FAILED);
      expect(persistence.failRun).toHaveBeenCalledWith('run-1', 'provider down');
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.RECONCILIATION_RUN_FAILED,
          severity: 'CRITICAL',
        }),
      );
      expect(brokerService.applyProviderAccountSnapshot).not.toHaveBeenCalled();
    });

    it('counts per-item resolution errors but completes the run (retried next cycle)', async () => {
      tradeRepo.find.mockResolvedValue([openTrade()]);
      adapter.getPositionById.mockRejectedValue(new Error('position lookup flaky'));

      const outcome = await service.runForConnection(connection());

      expect(outcome.status).toBe(ReconciliationRunStatus.COMPLETED_WITH_WARNINGS);
      expect(outcome.errors).toBe(1);
      expect(persistence.completeRun).toHaveBeenCalledWith(
        'run-1',
        expect.objectContaining({
          errorSummary: expect.stringContaining('1 resolution errors'),
        }),
      );
    });
  });

  describe('findReconcilableConnections', () => {
    it('unions candidate ids from orders, trades, and stored account snapshots', async () => {
      orderRepo.createQueryBuilder.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([{ id: 'conn-a' }]),
      });
      tradeRepo.createQueryBuilder.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([{ id: 'conn-b' }]),
      });
      accountRepo.createQueryBuilder.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([{ id: 'conn-c' }]),
      });

      await service.findReconcilableConnections();

      expect(brokerService.findConnectionsByIds).toHaveBeenCalledWith(
        expect.arrayContaining(['conn-a', 'conn-b', 'conn-c']),
      );
    });

    it('returns empty when nothing to reconcile', async () => {
      const result = await service.findReconcilableConnections();
      expect(result).toEqual([]);
      expect(brokerService.findConnectionsByIds).not.toHaveBeenCalled();
    });
  });
});
