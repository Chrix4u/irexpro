import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, ForbiddenException, Logger } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ExecutionService } from './execution.service';
import { ExecutionOrchestrator } from './orchestration/execution-orchestrator.service';
import { Trade, TradeCloseReason, TradeStatus } from './entities/trade.entity';
import { TradingSession, TradingSessionStatus } from './entities/trading-session.entity';
import { Order } from './orders/order.entity';
import { BrokerService } from '../broker/broker.service';
import { AuditService } from '../audit/audit.service';
import { AuditSeverity } from '../audit/entities/audit-log.entity';
import { RiskDecision, RiskRejectionCode } from '../risk/interfaces/risk.interface';
import { BrokerConnectionStatus, BrokerMode } from '../broker/interfaces/broker-adapter.interface';
import { DomainEventBus } from '../events/event-bus.service';
import { ProviderDispatchOutcome } from './orchestration/execution-intent.interface';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const approvedDecision: RiskDecision = {
  decision: 'APPROVED',
  signalId: 'sig-001',
  validatedOrder: {
    instrument: 'EURUSD',
    direction: 'BUY',
    lotSize: '0.05',
    entryPrice: '1.08500',
    stopLoss: '1.07500',
    takeProfit: '1.09500',
    idempotencyKey: 'idem-abc',
  },
  appliedRules: ['KILL_SWITCH:OK'],
  riskScore: 30,
  evaluatedAt: new Date(),
  // Sprint 32 Gate 2: required for the advisory-lock daily-trade-slot reservation
  maxDailyTrades: 10,
};

const rejectedDecision: RiskDecision = {
  decision: 'REJECTED',
  signalId: 'sig-002',
  rejectionCode: RiskRejectionCode.KILL_SWITCH_ACTIVE,
  rejectionReason: 'Kill switch is active',
  evaluatedAt: new Date(),
};

const mockBrokerConnection = {
  id: 'conn-1',
  userId: 'user-1',
  brokerId: 'metatrader',
  accountType: BrokerMode.DEMO,
  status: BrokerConnectionStatus.CONNECTED,
  encryptedCredentials: 'enc',
  credentialIv: 'iv',
  credentialTag: 'tag',
  encryptionKeyId: 'key-1',
};

const mockOrder = { id: 'order-1', clientOrderId: 'sig-sig-001', status: 'FILLED' } as Order;

/** A canonical FILLED dispatch outcome (provider executed the order). */
const filledOutcome: ProviderDispatchOutcome = {
  outcome: 'FILLED',
  order: mockOrder,
  orderId: mockOrder.id,
  providerOrderId: 'ext-order-1',
  filledQuantity: '0.05',
  avgFillPrice: '1.08502',
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ExecutionService', () => {
  let module: TestingModule;
  let service: ExecutionService;
  let orchestrator: {
    assertDispatchable: jest.Mock;
    dispatchOrder: jest.Mock;
  };
  let tradeRepo: jest.Mocked<{
    findOne: jest.Mock;
    find: jest.Mock;
    count: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    update: jest.Mock;
  }>;
  let sessionRepo: jest.Mocked<{
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    update: jest.Mock;
  }>;
  let auditService: { log: jest.Mock };
  let dataSource: { query: jest.Mock; transaction: jest.Mock };

  beforeEach(async () => {
    jest.clearAllMocks();

    orchestrator = {
      assertDispatchable: jest.fn().mockResolvedValue(undefined),
      dispatchOrder: jest.fn().mockResolvedValue(filledOutcome),
    };

    tradeRepo = {
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockImplementation((obj) => ({ id: 'trade-1', ...obj })),
      save: jest.fn().mockImplementation(async (obj) => ({ id: 'trade-1', ...obj })),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };

    sessionRepo = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation((obj) => obj),
      save: jest.fn().mockImplementation(async (obj) => obj),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };

    auditService = { log: jest.fn().mockResolvedValue(undefined) };
    // Sprint 32 Gate 3: mock dataSource.transaction for atomicallyReserveTradeSlot.
    // The mock manager supports: advisory lock, idempotency SELECT, count SELECT,
    // and INSERT ... RETURNING.
    const mockTradeRow = {
      id: 'trade-1',
      user_id: 'user-1',
      broker_connection_id: 'conn-1',
      signal_id: 'sig-001',
      idempotency_key: 'idem-abc',
      instrument: 'EURUSD',
      direction: 'BUY',
      lot_size: '0.05',
      requested_entry_price: '1.08500',
      stop_loss: '1.07500',
      take_profit: '1.09500',
      trailing_stop_pips: null,
      status: 'PENDING',
      opened_at: null,
      closed_at: null,
      created_at: new Date(),
      updated_at: new Date(),
    };
    const mockManager = {
      query: jest.fn().mockImplementation((sql: string) => {
        if (sql.includes('pg_advisory_xact_lock')) return Promise.resolve([]);
        if (sql.includes('SELECT * FROM trading.trades WHERE idempotency_key'))
          return Promise.resolve([]);
        if (sql.includes('COUNT(*)')) return Promise.resolve([{ count: '0' }]);
        if (sql.includes('INSERT INTO trading.trades')) return Promise.resolve([mockTradeRow]);
        return Promise.resolve([]);
      }),
    };
    dataSource = {
      query: jest.fn().mockResolvedValue([{ total: '0' }]),
      transaction: jest
        .fn()
        .mockImplementation((cb: (manager: typeof mockManager) => Promise<unknown>) =>
          cb(mockManager),
        ),
    };

    module = await Test.createTestingModule({
      providers: [
        ExecutionService,
        { provide: getRepositoryToken(Trade), useValue: tradeRepo },
        { provide: getRepositoryToken(TradingSession), useValue: sessionRepo },
        {
          provide: BrokerService,
          useValue: {
            findActiveConnectionForUser: jest.fn().mockResolvedValue(mockBrokerConnection),
            findConnectionById: jest.fn().mockResolvedValue(mockBrokerConnection),
          },
        },
        // Sprint 50 PR-3: the provider dispatch pipeline is mocked at the
        // orchestrator seam — adapter-level behavior is covered by the
        // dedicated execution-orchestrator.spec.ts suite.
        { provide: ExecutionOrchestrator, useValue: orchestrator },
        { provide: AuditService, useValue: auditService },
        { provide: DataSource, useValue: dataSource },
        {
          provide: DomainEventBus,
          useValue: { publish: jest.fn(), subscribe: jest.fn().mockReturnValue(() => {}) },
        },
      ],
    }).compile();

    service = module.get<ExecutionService>(ExecutionService);
  });

  afterEach(async () => {
    await module.close();
  });

  // ─── Risk Engine gate — non-bypassable ────────────────────────────────────

  describe('Risk Engine gate', () => {
    it('throws ForbiddenException for REJECTED decision — gate cannot be bypassed', async () => {
      await expect(service.executeTrade('user-1', rejectedDecision)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('throws ForbiddenException for SUSPENDED decision', async () => {
      const suspended: RiskDecision = {
        decision: 'SUSPENDED',
        signalId: 'x',
        rejectionCode: RiskRejectionCode.DAILY_LOSS_LIMIT_REACHED,
        rejectionReason: 'Daily loss',
        evaluatedAt: new Date(),
      };
      await expect(service.executeTrade('user-1', suspended)).rejects.toThrow(ForbiddenException);
    });

    it('includes rejection code in ForbiddenException message', async () => {
      await expect(service.executeTrade('user-1', rejectedDecision)).rejects.toThrow(
        /KILL_SWITCH_ACTIVE/,
      );
    });

    it('never dispatches when decision is not APPROVED', async () => {
      await expect(service.executeTrade('user-1', rejectedDecision)).rejects.toThrow();
      expect(orchestrator.dispatchOrder).not.toHaveBeenCalled();
    });

    it('APPROVED decision passes the gate and proceeds to dispatch', async () => {
      await service.executeTrade('user-1', approvedDecision);
      expect(orchestrator.dispatchOrder).toHaveBeenCalledTimes(1);
    });
  });

  // ─── Pre-dispatch gates (orchestrator validation pipeline) ────────────────

  describe('Pre-dispatch gates', () => {
    it('runs assertDispatchable before reserving the trade slot', async () => {
      await service.executeTrade('user-1', approvedDecision);
      expect(orchestrator.assertDispatchable).toHaveBeenCalledWith({
        userId: 'user-1',
        connection: expect.objectContaining({ id: 'conn-1' }),
      });
    });

    it('blocked dispatch (control plane / authorization) rejects before any reservation', async () => {
      orchestrator.assertDispatchable.mockRejectedValueOnce(
        new ForbiddenException('Execution blocked by platform control plane'),
      );
      await expect(service.executeTrade('user-1', approvedDecision)).rejects.toThrow(
        ForbiddenException,
      );
      expect(orchestrator.dispatchOrder).not.toHaveBeenCalled();
      // No PENDING trade was reserved (dataSource.transaction never ran).
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });
  });

  // ─── Idempotency ──────────────────────────────────────────────────────────

  describe('Idempotency', () => {
    it('returns existing trade when idempotency_key already exists (duplicate signal)', async () => {
      const existingTrade = {
        id: 'trade-existing',
        status: 'OPEN',
        instrument: 'EURUSD',
        direction: 'BUY',
      };

      // Re-setup the transaction mock to return existing trade
      (dataSource as { transaction: jest.Mock }).transaction.mockImplementationOnce(
        async (cb: (manager: { query: jest.Mock }) => Promise<unknown>) => {
          const mgr = {
            query: jest.fn().mockImplementation((sql: string) => {
              if (sql.includes('pg_advisory_xact_lock')) return Promise.resolve([]);
              if (sql.includes('SELECT * FROM trading.trades WHERE idempotency_key'))
                return Promise.resolve([existingTrade]);
              return Promise.resolve([]);
            }),
          };
          return cb(mgr);
        },
      );

      const result = await service.executeTrade('user-1', approvedDecision);

      expect(result).toEqual(existingTrade);
      expect(orchestrator.dispatchOrder).not.toHaveBeenCalled();
      // Audit the suppression
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'TRADE_DUPLICATE_SUPPRESSED',
          severity: AuditSeverity.WARNING,
          metadata: expect.objectContaining({ existingTradeId: 'trade-existing' }),
        }),
      );
    });
  });

  // ─── Successful execution ─────────────────────────────────────────────────

  describe('Successful APPROVED execution', () => {
    it('reserves the trade slot, then dispatches through the order domain', async () => {
      await service.executeTrade('user-1', approvedDecision);
      expect(orchestrator.dispatchOrder).toHaveBeenCalledTimes(1);
    });

    it('builds the execution intent from the Risk Engine-validated order', async () => {
      await service.executeTrade('user-1', approvedDecision);
      expect(orchestrator.dispatchOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          clientOrderId: 'sig-sig-001',
          tradeId: 'trade-1',
          signalId: 'sig-001',
          orderKind: 'MARKET',
          timeInForce: 'GTC',
          instrument: 'EURUSD',
          direction: 'BUY',
          requestedQuantity: '0.05',
          stopLoss: '1.07500',
          takeProfit: '1.09500',
          providerAction: 'PLACE',
        }),
        expect.objectContaining({ id: 'conn-1' }),
      );
    });

    it('updates trade to OPEN with externalOrderId on FILLED dispatch', async () => {
      await service.executeTrade('user-1', approvedDecision);
      expect(tradeRepo.update).toHaveBeenCalledWith(
        'trade-1',
        expect.objectContaining({
          status: TradeStatus.OPEN,
          externalOrderId: 'ext-order-1',
          fillPrice: '1.08502',
        }),
      );
    });

    it('records TRADE_PREPARED and TRADE_OPENED audit events', async () => {
      await service.executeTrade('user-1', approvedDecision);
      expect(auditService.log).toHaveBeenCalledTimes(2);
    });

    it('WORKING dispatch keeps the trade PENDING with the provider id recorded', async () => {
      orchestrator.dispatchOrder.mockResolvedValueOnce({
        outcome: 'WORKING',
        order: mockOrder,
        orderId: mockOrder.id,
        providerOrderId: 'ext-working-1',
      });
      const trade = await service.executeTrade('user-1', approvedDecision);
      expect(tradeRepo.update).toHaveBeenCalledWith('trade-1', {
        externalOrderId: 'ext-working-1',
      });
      // No status transition — the position is not yet open.
      expect(tradeRepo.update).not.toHaveBeenCalledWith(
        'trade-1',
        expect.objectContaining({ status: expect.any(String) }),
      );
      expect(trade.status).toBe('PENDING');
    });
  });

  // ─── Broker rejects order ─────────────────────────────────────────────────

  describe('Broker rejection', () => {
    beforeEach(() => {
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    });
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('sets trade to REJECTED when the dispatch outcome is REJECTED', async () => {
      orchestrator.dispatchOrder.mockResolvedValueOnce({
        outcome: 'REJECTED',
        order: mockOrder,
        orderId: mockOrder.id,
        reason: 'Insufficient margin',
      });

      await service.executeTrade('user-1', approvedDecision);

      expect(tradeRepo.update).toHaveBeenCalledWith(
        'trade-1',
        expect.objectContaining({ status: TradeStatus.REJECTED }),
      );
    });
  });

  // ─── Broker error → RECONCILIATION_PENDING ───────────────────────────────

  describe('Broker error handling', () => {
    beforeEach(() => {
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    });
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('sets trade to RECONCILIATION_PENDING when the dispatch outcome is UNKNOWN', async () => {
      orchestrator.dispatchOrder.mockResolvedValueOnce({
        outcome: 'UNKNOWN',
        order: mockOrder,
        orderId: mockOrder.id,
        reason: 'MetaAPI network error',
      });

      await service.executeTrade('user-1', approvedDecision);

      expect(tradeRepo.update).toHaveBeenCalledWith(
        'trade-1',
        expect.objectContaining({ status: TradeStatus.RECONCILIATION_PENDING }),
      );
    });

    it('sets trade to RECONCILIATION_PENDING when the orchestrator itself throws', async () => {
      orchestrator.dispatchOrder.mockRejectedValueOnce(new Error('order store unavailable'));

      await service.executeTrade('user-1', approvedDecision);

      expect(tradeRepo.update).toHaveBeenCalledWith(
        'trade-1',
        expect.objectContaining({ status: TradeStatus.RECONCILIATION_PENDING }),
      );
    });
  });

  // ─── closeTrade ───────────────────────────────────────────────────────────

  describe('closeTrade()', () => {
    // Factory: each test gets a FRESH object — closeTrade mutates the
    // returned trade entity in place, and a shared fixture would leak state
    // across tests.
    const openTrade = () => ({
      id: 'trade-1',
      userId: 'user-1',
      status: TradeStatus.OPEN,
      externalOrderId: 'ext-1',
      brokerConnectionId: 'conn-1',
      instrument: 'EURUSD',
      direction: 'BUY',
      lotSize: '0.05',
      signalId: null,
      openedAt: new Date(),
    });

    it('throws ForbiddenException when trade not found', async () => {
      tradeRepo.findOne.mockResolvedValue(null);
      await expect(
        service.closeTrade('missing', 'user-1', TradeCloseReason.MANUAL_CLOSE),
      ).rejects.toThrow(ForbiddenException);
    });

    it('throws ForbiddenException when trade is not OPEN', async () => {
      tradeRepo.findOne.mockResolvedValue({
        id: 'trade-1',
        userId: 'user-1',
        status: TradeStatus.CLOSED,
      });
      await expect(
        service.closeTrade('trade-1', 'user-1', TradeCloseReason.MANUAL_CLOSE),
      ).rejects.toThrow(ForbiddenException);
    });

    it('dispatches a CLOSE_POSITION order and updates trade to CLOSED on fill', async () => {
      tradeRepo.findOne.mockResolvedValue(openTrade());
      orchestrator.dispatchOrder.mockResolvedValueOnce({
        outcome: 'FILLED',
        order: mockOrder,
        orderId: mockOrder.id,
        providerOrderId: 'close-ext-1',
        filledQuantity: '0.05',
        avgFillPrice: '1.09000',
      });

      await service.closeTrade('trade-1', 'user-1', TradeCloseReason.MANUAL_CLOSE);

      expect(orchestrator.dispatchOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          providerAction: 'CLOSE_POSITION',
          providerReferenceId: 'ext-1',
          // Closing a BUY position sells.
          direction: 'SELL',
          requestedQuantity: '0.05',
          clientOrderId: 'close-trade-1',
          tradeId: 'trade-1',
        }),
        expect.anything(),
      );
      expect(tradeRepo.update).toHaveBeenCalledWith(
        'trade-1',
        expect.objectContaining({
          status: TradeStatus.CLOSED,
          closeReason: TradeCloseReason.MANUAL_CLOSE,
          exitPrice: '1.09000',
        }),
      );
    });

    it('FAIL-CLOSED: provider-refused close throws ConflictException and trade stays OPEN', async () => {
      tradeRepo.findOne.mockResolvedValue(openTrade());
      orchestrator.dispatchOrder.mockResolvedValueOnce({
        outcome: 'REJECTED',
        order: mockOrder,
        orderId: mockOrder.id,
        reason: 'Market closed',
      });

      await expect(
        service.closeTrade('trade-1', 'user-1', TradeCloseReason.MANUAL_CLOSE),
      ).rejects.toThrow(ConflictException);
      expect(tradeRepo.update).not.toHaveBeenCalledWith(
        'trade-1',
        expect.objectContaining({ status: TradeStatus.CLOSED }),
      );
    });

    it('unresolved close outcome (UNKNOWN) flags the trade for reconciliation', async () => {
      tradeRepo.findOne.mockResolvedValue(openTrade());
      orchestrator.dispatchOrder.mockResolvedValueOnce({
        outcome: 'UNKNOWN',
        order: mockOrder,
        orderId: mockOrder.id,
        reason: 'close request timeout',
      });

      await service.closeTrade('trade-1', 'user-1', TradeCloseReason.MANUAL_CLOSE);

      expect(tradeRepo.update).toHaveBeenCalledWith(
        'trade-1',
        expect.objectContaining({ status: TradeStatus.RECONCILIATION_PENDING }),
      );
    });

    it('idempotent: a concurrent duplicate close (DUPLICATE outcome) returns the trade unchanged', async () => {
      tradeRepo.findOne.mockResolvedValue(openTrade());
      orchestrator.dispatchOrder.mockResolvedValueOnce({
        outcome: 'DUPLICATE',
        order: mockOrder,
        orderId: mockOrder.id,
      });

      const result = await service.closeTrade('trade-1', 'user-1', TradeCloseReason.MANUAL_CLOSE);
      expect(result.status).toBe(TradeStatus.OPEN);
      expect(tradeRepo.update).not.toHaveBeenCalledWith(
        'trade-1',
        expect.objectContaining({ status: expect.any(String) }),
      );
    });

    it('close retry after a definitive failure mints the next attempt sequence', async () => {
      tradeRepo.findOne.mockResolvedValue(openTrade());
      // One prior close attempt exists (e.g. a REJECTED close order).
      dataSource.query.mockResolvedValueOnce([{ count: '1' }]);

      await service.closeTrade('trade-1', 'user-1', TradeCloseReason.MANUAL_CLOSE);

      expect(orchestrator.dispatchOrder).toHaveBeenCalledWith(
        expect.objectContaining({ clientOrderId: 'close-trade-1-2' }),
        expect.anything(),
      );
    });
  });

  // ─── Query helpers ─────────────────────────────────────────────────────────

  describe('countOpenTrades()', () => {
    it('returns count from repository', async () => {
      tradeRepo.count.mockResolvedValue(3);
      expect(await service.countOpenTrades('user-1')).toBe(3);
    });
  });

  describe('getTodayRealisedLoss()', () => {
    it('returns 0 when no losses today', async () => {
      dataSource.query.mockResolvedValue([{ total: '0' }]);
      expect(await service.getTodayRealisedLoss('user-1')).toBe(0);
    });

    it('returns negative number representing loss', async () => {
      dataSource.query.mockResolvedValue([{ total: '-250.75' }]);
      expect(await service.getTodayRealisedLoss('user-1')).toBe(-250.75);
    });
  });

  // ─── Session management ───────────────────────────────────────────────────

  describe('startSession()', () => {
    it('creates new session when none exists', async () => {
      await service.startSession('user-1', 'conn-1', '10000.00');
      expect(sessionRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          status: TradingSessionStatus.ACTIVE,
          openingBalance: '10000.00',
        }),
      );
    });

    it('returns existing session without creating duplicate', async () => {
      const existing = { id: 'sess-1', status: TradingSessionStatus.ACTIVE };
      sessionRepo.findOne.mockResolvedValue(existing);

      const result = await service.startSession('user-1', 'conn-1', '10000.00');
      expect(result).toEqual(existing);
      expect(sessionRepo.save).not.toHaveBeenCalled();
    });
  });
});
