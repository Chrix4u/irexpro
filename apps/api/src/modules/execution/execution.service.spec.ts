import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, ForbiddenException, Logger } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ExecutionService } from './execution.service';
import { ExecutionOrchestrator } from './orchestration/execution-orchestrator.service';
import { FinalDispatchBoundary } from './orchestration/final-dispatch-boundary';
import { TradeLifecycleCasService } from './orders/trade-lifecycle-cas.service';
import { Trade, TradeCloseReason, TradeStatus } from './entities/trade.entity';
import { TradingSession, TradingSessionStatus } from './entities/trading-session.entity';
import { RiskGrant } from './entities/risk-grant.entity';
import { ExecutionConfirmation } from './entities/execution-confirmation.entity';
import { ExecutionMode } from './interfaces/execution-authority';
import {
  ActiveSessionConflictException,
  BrokerConnectionNotConnectedException,
  BrokerConnectionNotExecutableException,
  BrokerConnectionOwnershipException,
  ExecutionSessionResolutionService,
} from './execution-session.resolution';
import { Order } from './orders/order.entity';
import { BrokerService } from '../broker/broker.service';
import { AuditService } from '../audit/audit.service';
import { AuditSeverity } from '../audit/entities/audit-log.entity';
import { RiskDecision, RiskRejectionCode } from '../risk/interfaces/risk.interface';
import { BrokerConnectionStatus, BrokerMode } from '../broker/interfaces/broker-adapter.interface';
import { DomainEventBus } from '../events/event-bus.service';
import { ProviderDispatchOutcome } from './orchestration/execution-intent.interface';
import { RiskGrantStatus } from './interfaces/execution-authority';

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
  // Round 5 (task 50-c): the durable authority handle — the final dispatch
  // boundary requires + atomically consumes the server-issued grant.
  grantId: 'grant-1',
  sessionId: 'session-1',
  sessionGeneration: 1,
  executionMode: 'PAPER_ONLY',
  brokerConnectionId: 'conn-1',
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
  authorizationStatus: 'ACTIVE',
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
    // Round 5 (task 50-c): uncertain-exposure accounting (#314) runs counts
    // through the repository query builder.
    createQueryBuilder: jest.Mock;
  }>;
  let sessionRepo: jest.Mocked<{
    findOne: jest.Mock;
    create: jest.Mock;
    insert: jest.Mock;
    save: jest.Mock;
    update: jest.Mock;
    createQueryBuilder: jest.Mock;
  }>;
  /** Row "persisted" by the insert mock — read back by the post-insert findOne. */
  let insertedSession: Record<string, unknown> | null;
  let authorityRepoStubs: { createQueryBuilder: jest.Mock; update: jest.Mock; findOne: jest.Mock };
  let auditService: { log: jest.Mock };
  let dataSource: { query: jest.Mock; transaction: jest.Mock };
  let finalDispatchBoundary: { authorizeNewExposureDispatch: jest.Mock };
  let tradeCas: { applyCasTransition: jest.Mock };

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
      // Round 5 (task 50-c): countOpenTrades/countTodayTrades run through the
      // repository query builder (uncertain-exposure accounting, #314).
      createQueryBuilder: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orWhere: jest.fn().mockReturnThis(),
        getCount: jest.fn().mockResolvedValue(0),
      }),
    };

    // Round 5 (task 50-c): the final dispatch boundary is exercised at the
    // SEAM in this unit suite (its full check matrix lives in
    // final-dispatch-boundary.spec.ts): a valid grant authorization resolves
    // the boundary-verified connection — executeTrade NEVER re-discovers it.
    finalDispatchBoundary = {
      authorizeNewExposureDispatch: jest.fn().mockImplementation(async () => ({
        context: {
          userId: 'user-1',
          signalId: 'sig-001',
          operationType: 'NEW_EXPOSURE',
          sessionId: 'session-1',
          sessionGeneration: 1,
          executionMode: 'PAPER_ONLY',
          brokerConnectionId: 'conn-1',
          brokerAccountId: null,
          providerTechnology: 'paper-broker',
          providerBrokerIdentity: null,
          providerVerificationFingerprint: null,
          financialSnapshotGeneration: null,
          riskProfileId: null,
          riskProfileVersion: null,
          riskGrantId: 'grant-1',
          authorityGeneration: 1,
          validatedOrderDigest: 'digest-1',
        },
        connection: mockBrokerConnection,
        confirmationId: null,
        operationClass: 'NEW_EXPOSURE',
      })),
    };
    // The trade-lifecycle CAS is exercised at the seam with a WRITE-THROUGH
    // stub (the real CAS matrix lives in trade-cas.spec.ts): every transition
    // still lands on tradeRepo.update so the existing persistence assertions
    // keep proving the outcome mappings.
    tradeCas = {
      applyCasTransition: jest
        .fn()
        .mockImplementation(
          async (params: {
            tradeId: string;
            target: TradeStatus;
            patch: Record<string, unknown>;
          }) => {
            await tradeRepo.update(params.tradeId, params.patch as never);
            return {
              outcome: 'APPLIED',
              trade: { id: params.tradeId, status: params.target, ...params.patch },
            };
          },
        ),
    };

    insertedSession = null;
    sessionRepo = {
      findOne: jest.fn().mockImplementation(async (opts?: { where?: Record<string, unknown> }) => {
        // Post-insert re-read returns the row the insert mock persisted;
        // active-session lookups (no id filter) default to null — per-test
        // overrides replace this implementation wholesale.
        if (opts?.where?.id) return insertedSession;
        return null;
      }),
      create: jest.fn().mockImplementation((obj) => obj),
      insert: jest.fn().mockImplementation(async (entity) => {
        insertedSession = entity;
        return { generatedMaps: [entity] };
      }),
      save: jest.fn().mockImplementation(async (obj) => obj),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      // Round 5: endSession / changeExecutionMode CAS via createQueryBuilder.
      createQueryBuilder: jest.fn().mockReturnValue({
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 1 }),
      }),
    };
    // Round 5: RiskGrant / ExecutionConfirmation repositories are exercised
    // for authority invalidation only via createQueryBuilder — a chainable
    // stub keeps these unit tests independent of the store (the real-store
    // matrix lives in execution-session.authority.spec.ts).
    // Round 6 (#365): executeTrade's PRE-COMMITMENT grant preflight reads
    // findOne({ id, userId }) — the canonical ACTIVE 'grant-1' fixture serves
    // that read; per-test overrides still replace this wholesale (the
    // unusable-grant / not-found matrices below drive their own fixtures).
    const activeGrantFixture = {
      id: 'grant-1',
      userId: 'user-1',
      signalId: 'sig-001',
      sessionId: 'session-1',
      sessionGeneration: 1,
      executionMode: ExecutionMode.PAPER_ONLY,
      brokerConnectionId: 'conn-1',
      status: RiskGrantStatus.ACTIVE,
      issuedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    };
    authorityRepoStubs = {
      createQueryBuilder: jest.fn().mockReturnValue({
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 0 }),
      }),
      update: jest.fn().mockResolvedValue({ affected: 0 }),
      findOne: jest.fn().mockImplementation(
        async (opts?: { where?: Record<string, unknown> }) => {
          if (opts?.where?.id === 'grant-1') return activeGrantFixture;
          return null;
        },
      ),
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
        { provide: getRepositoryToken(RiskGrant), useValue: authorityRepoStubs },
        { provide: getRepositoryToken(ExecutionConfirmation), useValue: authorityRepoStubs },
        {
          provide: BrokerService,
          useValue: {
            // Round 5 (#295): discovery is a NEVER-CALLED sentinel — executeTrade
            // resolves the session authority seam + exact connection by id.
            findActiveConnectionForUser: jest.fn(),
            findConnectionsByIds: jest.fn().mockResolvedValue([mockBrokerConnection]),
            findConnectionById: jest.fn().mockResolvedValue(mockBrokerConnection),
            isConnectionExecutable: jest.fn().mockReturnValue(true),
          },
        },
        // Sprint 50 PR-3: the provider dispatch pipeline is mocked at the
        // orchestrator seam — adapter-level behavior is covered by the
        // dedicated execution-orchestrator.spec.ts suite.
        { provide: ExecutionOrchestrator, useValue: orchestrator },
        { provide: FinalDispatchBoundary, useValue: finalDispatchBoundary },
        { provide: TradeLifecycleCasService, useValue: tradeCas },
        { provide: AuditService, useValue: auditService },
        { provide: DataSource, useValue: dataSource },
        {
          provide: DomainEventBus,
          useValue: { publish: jest.fn(), subscribe: jest.fn().mockReturnValue(() => {}) },
        },
        {
          provide: ExecutionSessionResolutionService,
          useValue: {
            resolveActiveSessionAuthority: jest.fn().mockResolvedValue({
              sessionId: 'session-1',
              sessionGeneration: 1,
              executionMode: ExecutionMode.PAPER_ONLY,
              brokerConnectionId: 'conn-1',
            }),
          },
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
      expect(orchestrator.assertDispatchable).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          connection: expect.objectContaining({ id: 'conn-1' }),
          operationClass: 'NEW_EXPOSURE',
        }),
      );
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
        // Round 6 (#365): the provider-dispatch COMMITMENT payload — the
        // grant is consumed AT the commitment inside dispatchOrder. No
        // SEMI_AUTO confirmation drives this pipeline dispatch ⇒ undefined.
        expect.objectContaining({
          grantId: 'grant-1',
          confirmationId: undefined,
          origin: 'PIPELINE',
        }),
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
    it('returns count from the exposure query builder (RECONCILIATION_PENDING counted, #314)', async () => {
      // Round 5 (task 50-c): counts run through createQueryBuilder so
      // uncertain exposure (RECONCILIATION_PENDING) is conservatively
      // included — the repository count() is no longer the source.
      const qb = tradeRepo.createQueryBuilder();
      qb.getCount.mockResolvedValueOnce(3);
      expect(await service.countOpenTrades('user-1')).toBe(3);
      expect(tradeRepo.createQueryBuilder).toHaveBeenCalled();
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

  // ─── Session management (Round 5 — session is the authoritative target) ───

  describe('startSession()', () => {
    it('creates new session with executionMode + authorityGeneration 1 when none exists', async () => {
      const created = await service.startSession('user-1', 'conn-1', '10000.00');
      expect(sessionRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          status: TradingSessionStatus.ACTIVE,
          openingBalance: '10000.00',
          executionMode: ExecutionMode.PAPER_ONLY,
          authorityGeneration: 1,
        }),
      );
      expect(created.executionMode).toBe(ExecutionMode.PAPER_ONLY);
      expect(created.authorityGeneration).toBe(1);
    });

    it('persists the requested executionMode (SEMI_AUTO)', async () => {
      const created = await service.startSession(
        'user-1',
        'conn-1',
        '10000.00',
        null,
        ExecutionMode.SEMI_AUTO,
      );
      expect(sessionRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({ executionMode: ExecutionMode.SEMI_AUTO, authorityGeneration: 1 }),
      );
      expect(created.executionMode).toBe(ExecutionMode.SEMI_AUTO);
    });

    it('returns existing session (idempotent) for same connection + same mode', async () => {
      const existing = {
        id: 'sess-1',
        userId: 'user-1',
        brokerConnectionId: 'conn-1',
        executionMode: ExecutionMode.PAPER_ONLY,
        authorityGeneration: 1,
        status: TradingSessionStatus.ACTIVE,
      };
      sessionRepo.findOne.mockResolvedValue(existing);

      const result = await service.startSession('user-1', 'conn-1', '10000.00');
      expect(result).toEqual(existing);
      expect(sessionRepo.insert).not.toHaveBeenCalled();
    });

    it('throws typed ownership rejection when the connection belongs to another user', async () => {
      const brokerServiceMock = (service as unknown as { brokerService: BrokerService })
        .brokerService;
      (brokerServiceMock as unknown as { findConnectionsByIds: jest.Mock }).findConnectionsByIds =
        jest.fn().mockResolvedValue([{ ...mockBrokerConnection, userId: 'someone-else' }]);
      await expect(service.startSession('user-1', 'conn-1', '10000.00')).rejects.toThrow(
        BrokerConnectionOwnershipException,
      );
      expect(sessionRepo.insert).not.toHaveBeenCalled();
    });

    it('throws typed rejection when the connection is not CONNECTED', async () => {
      const brokerServiceMock = (service as unknown as { brokerService: BrokerService })
        .brokerService;
      (brokerServiceMock as unknown as { findConnectionsByIds: jest.Mock }).findConnectionsByIds =
        jest
          .fn()
          .mockResolvedValue([
            { ...mockBrokerConnection, status: BrokerConnectionStatus.DISCONNECTED },
          ]);
      await expect(service.startSession('user-1', 'conn-1', '10000.00')).rejects.toThrow(
        BrokerConnectionNotConnectedException,
      );
      expect(sessionRepo.insert).not.toHaveBeenCalled();
    });

    it('throws typed rejection when the connection is not LIVE-authorization executable', async () => {
      const brokerServiceMock = (service as unknown as { brokerService: BrokerService })
        .brokerService;
      (brokerServiceMock as unknown as { findConnectionsByIds: jest.Mock }).findConnectionsByIds =
        jest.fn().mockResolvedValue([mockBrokerConnection]);
      (
        brokerServiceMock as unknown as { isConnectionExecutable: jest.Mock }
      ).isConnectionExecutable = jest.fn().mockReturnValue(false);
      await expect(service.startSession('user-1', 'conn-1', '10000.00')).rejects.toThrow(
        BrokerConnectionNotExecutableException,
      );
      expect(sessionRepo.insert).not.toHaveBeenCalled();
    });

    it('throws typed ACTIVE_SESSION_CONFLICT when an ACTIVE session exists on ANOTHER connection', async () => {
      const existing = {
        id: 'sess-1',
        userId: 'user-1',
        brokerConnectionId: 'conn-OTHER',
        executionMode: ExecutionMode.PAPER_ONLY,
        authorityGeneration: 1,
        status: TradingSessionStatus.ACTIVE,
      };
      sessionRepo.findOne.mockResolvedValue(existing);

      await expect(service.startSession('user-1', 'conn-1', '10000.00')).rejects.toThrow(
        ActiveSessionConflictException,
      );
      expect(sessionRepo.insert).not.toHaveBeenCalled();
    });

    it('throws typed ACTIVE_SESSION_CONFLICT when an ACTIVE session exists with a DIFFERENT mode (mode changes are explicit + audited)', async () => {
      const existing = {
        id: 'sess-1',
        userId: 'user-1',
        brokerConnectionId: 'conn-1',
        executionMode: ExecutionMode.SEMI_AUTO,
        authorityGeneration: 4,
        status: TradingSessionStatus.ACTIVE,
      };
      sessionRepo.findOne.mockResolvedValue(existing);

      await expect(
        service.startSession('user-1', 'conn-1', '10000.00', null, ExecutionMode.PAPER_ONLY),
      ).rejects.toThrow(ActiveSessionConflictException);
      expect(sessionRepo.insert).not.toHaveBeenCalled();
    });
  });

  // ─── executeTrade session-authority seam (#295) ───────────────────────────

  describe('executeTrade — session authority seam', () => {
    it('authorizes through the FINAL DISPATCH BOUNDARY with the grant (never re-discovers the connection)', async () => {
      await service.executeTrade('user-1', approvedDecision);
      const brokerServiceMock = (service as unknown as { brokerService: BrokerService })
        .brokerService;
      // NEVER the implicit "latest active connection" discovery
      expect(
        (brokerServiceMock as unknown as { findActiveConnectionForUser: jest.Mock })
          .findActiveConnectionForUser,
      ).not.toHaveBeenCalled();
      // The EXACT connection comes from the boundary's grant-bound
      // authorization — conn-1 is the id the grant binds (see fixture).
      expect(finalDispatchBoundary.authorizeNewExposureDispatch).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-1', grantId: 'grant-1' }),
      );
      expect(orchestrator.assertDispatchable).toHaveBeenCalledWith(
        expect.objectContaining({
          connection: expect.objectContaining({ id: 'conn-1' }),
        }),
      );
    });
  });
});

