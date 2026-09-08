import { Test, TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ExecutionService } from './execution.service';
import { ExecutionOrchestrator } from './orchestration/execution-orchestrator.service';
import { Trade, TradeStatus } from './entities/trade.entity';
import { TradingSession } from './entities/trading-session.entity';
import { BrokerService } from '../broker/broker.service';
import { AuditService } from '../audit/audit.service';
import { AuditSeverity } from '../audit/entities/audit-log.entity';
import { RiskDecision } from '../risk/interfaces/risk.interface';
import { BrokerMode } from '../broker/interfaces/broker-adapter.interface';
import { DomainEventBus } from '../events/event-bus.service';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const approvedDecision = (): RiskDecision => ({
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
  maxDailyTrades: 10,
});

// Sprint 50 PR-3: dispatch is mocked at the orchestrator seam — adapter-level
// behavior is covered by the dedicated execution-orchestrator.spec.ts suite.
const mockOrchestrator = () => ({
  assertDispatchable: jest.fn().mockResolvedValue(undefined),
  dispatchOrder: jest.fn().mockResolvedValue({
    outcome: 'FILLED',
    order: { id: 'order-1', status: 'FILLED' },
    providerOrderId: 'ext-001',
    filledQuantity: '0.05',
    avgFillPrice: '1.08500',
  }),
});

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('ExecutionService — Sprint 32 Idempotency', () => {
  let service: ExecutionService;
  let tradeRepo: Record<string, jest.Mock>;
  let sessionRepo: Record<string, jest.Mock>;
  let mockOrchestratorInstance: ReturnType<typeof mockOrchestrator>;
  let auditService: { log: jest.Mock };

  beforeEach(async () => {
    mockOrchestratorInstance = mockOrchestrator();
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

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ExecutionService,
        { provide: getRepositoryToken(Trade), useValue: tradeRepo },
        { provide: getRepositoryToken(TradingSession), useValue: sessionRepo },
        { provide: BrokerService, useValue: {} },
        { provide: ExecutionOrchestrator, useValue: mockOrchestratorInstance },
        { provide: AuditService, useValue: auditService },
        {
          provide: DataSource,
          useValue: {
            query: jest.fn().mockResolvedValue([{ total: '0' }]),
            // Sprint 32 Gate 3: mock transaction for atomicallyReserveTradeSlot.
            // The mock manager handles: advisory lock, idempotency SELECT,
            // count SELECT, and INSERT ... RETURNING.
            transaction: jest
              .fn()
              .mockImplementation(
                async (cb: (manager: { query: jest.Mock }) => Promise<unknown>) => {
                  const mockTradeRow = {
                    id: 'trade-1',
                    // A freshly reserved trade slot is PENDING (the INSERT
                    // writes 'PENDING'); the dispatch outcome then opens it.
                    status: 'PENDING',
                    instrument: 'EURUSD',
                    direction: 'BUY',
                    lot_size: '0.05',
                    signal_id: 'sig-001',
                    idempotency_key: 'idem-abc',
                    user_id: 'user-1',
                    broker_connection_id: 'conn-1',
                  };
                  const mockManager = {
                    query: jest.fn().mockImplementation((sql: string) => {
                      if (sql.includes('pg_advisory_xact_lock')) return Promise.resolve([]);
                      if (sql.includes('SELECT * FROM trading.trades WHERE idempotency_key'))
                        return Promise.resolve([]);
                      if (sql.includes('COUNT(*)')) return Promise.resolve([{ count: '0' }]);
                      if (sql.includes('INSERT INTO trading.trades'))
                        return Promise.resolve([mockTradeRow]);
                      return Promise.resolve([]);
                    }),
                  };
                  return cb(mockManager);
                },
              ),
          },
        },
        { provide: DomainEventBus, useValue: { publish: jest.fn() } },
        { provide: Logger, useValue: { log: jest.fn(), warn: jest.fn(), error: jest.fn() } },
      ],
    }).compile();

    service = module.get(ExecutionService);

    // Mock brokerService.findActiveConnectionForUser
    (service as unknown as { brokerService: Record<string, jest.Mock> }).brokerService = {
      findActiveConnectionForUser: jest.fn().mockResolvedValue({
        id: 'conn-1',
        brokerId: 'paper-broker',
        accountType: BrokerMode.DEMO,
        encryptedCredentials: 'enc',
        credentialIv: 'iv',
        credentialTag: 'tag',
        encryptionKeyId: 'key-1',
      }),
    };
  });

  // ── Duplicate sequential intent ─────────────────────────────────────────────

  it('returns existing trade when the same signal is submitted twice (sequential)', async () => {
    // Sprint 32 Gate 3: the idempotency check is now inside the advisory-lock
    // transaction. The SELECT finds the existing trade and returns DUPLICATE_EXISTING.
    const existingTrade = { id: 'trade-existing', status: TradeStatus.OPEN };

    // Override the transaction mock to return existing trade on idempotency SELECT
    const ds = (service as unknown as { dataSource: { transaction: jest.Mock } }).dataSource;
    ds.transaction.mockImplementationOnce(
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

    const result = await service.executeTrade('user-1', approvedDecision());

    expect(result).toEqual(existingTrade);
    expect(mockOrchestratorInstance.dispatchOrder).not.toHaveBeenCalled();
    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'TRADE_DUPLICATE_SUPPRESSED',
        severity: AuditSeverity.WARNING,
      }),
    );
  });

  // ── Non-unique-constraint error surfaces ───────────────────────────────────

  it('re-throws non-unique-constraint DB errors (does not mask as duplicate)', async () => {
    // Sprint 32 Gate 3: if the transaction itself throws (e.g. DB connection
    // lost), the error surfaces — it is NOT masked as a duplicate.
    const ds = (service as unknown as { dataSource: { transaction: jest.Mock } }).dataSource;
    ds.transaction.mockRejectedValueOnce(new Error('connection refused'));

    await expect(service.executeTrade('user-1', approvedDecision())).rejects.toThrow(
      'connection refused',
    );
    expect(mockOrchestratorInstance.dispatchOrder).not.toHaveBeenCalled();
  });

  // ── Successful execution cannot duplicate ──────────────────────────────────

  it('does not call broker placeOrder twice for the same signalId', async () => {
    // First call succeeds (default mock returns RESERVED_NEW with PENDING trade)
    await service.executeTrade('user-1', approvedDecision());
    expect(mockOrchestratorInstance.dispatchOrder).toHaveBeenCalledTimes(1);

    // Second call with same signal → idempotency SELECT finds existing trade
    // → DUPLICATE_EXISTING → no broker submission
    const ds = (service as unknown as { dataSource: { transaction: jest.Mock } }).dataSource;
    ds.transaction.mockImplementationOnce(
      async (cb: (manager: { query: jest.Mock }) => Promise<unknown>) => {
        const mgr = {
          query: jest.fn().mockImplementation((sql: string) => {
            if (sql.includes('pg_advisory_xact_lock')) return Promise.resolve([]);
            if (sql.includes('SELECT * FROM trading.trades WHERE idempotency_key'))
              return Promise.resolve([{ id: 'trade-1', status: TradeStatus.OPEN }]);
            return Promise.resolve([]);
          }),
        };
        return cb(mgr);
      },
    );

    await service.executeTrade('user-1', approvedDecision());
    // placeOrder still only called once (the second call returned the existing trade)
    expect(mockOrchestratorInstance.dispatchOrder).toHaveBeenCalledTimes(1);
  });

  // ── findTradeBySignalId (Risk-layer idempotency helper) ────────────────────

  it('findTradeBySignalId queries by signalId + userId', async () => {
    tradeRepo.findOne.mockResolvedValue({ id: 'trade-1', signalId: 'sig-001' });
    const result = await service.findTradeBySignalId('sig-001', 'user-1');
    expect(result).toEqual({ id: 'trade-1', signalId: 'sig-001' });
    expect(tradeRepo.findOne).toHaveBeenCalledWith({
      where: { signalId: 'sig-001', userId: 'user-1' },
    });
  });

  it('findTradeBySignalId returns null when no trade exists', async () => {
    tradeRepo.findOne.mockResolvedValue(null);
    const result = await service.findTradeBySignalId('sig-999', 'user-1');
    expect(result).toBeNull();
  });

  // ── countTodayTrades (daily-limit helper) ──────────────────────────────────

  it('countTodayTrades returns the count of OPEN+CLOSED trades opened today', async () => {
    const dataSource = (service as unknown as { dataSource: { query: jest.Mock } }).dataSource;
    dataSource.query.mockResolvedValue([{ count: '5' }]);
    const result = await service.countTodayTrades('user-1');
    expect(result).toBe(5);
  });

  it('countTodayTrades returns 0 when no trades today', async () => {
    const dataSource = (service as unknown as { dataSource: { query: jest.Mock } }).dataSource;
    dataSource.query.mockResolvedValue([{ count: '0' }]);
    const result = await service.countTodayTrades('user-1');
    expect(result).toBe(0);
  });

  // ── Concurrent DIFFERENT-signal daily-limit race ──────────────────────────

  it('concurrent DIFFERENT signals: only one gets the final daily slot', async () => {
    // Sprint 32 Gate 3: the advisory lock serializes concurrent requests.
    // Two different signalIds racing for the last daily slot must result in
    // exactly ONE execution + ONE rejection.
    //
    // This test uses a mock that serializes via a mutex to prove the advisory
    // lock semantics: the second request waits for the first to commit, then
    // sees the PENDING reservation and is rejected.
    //
    // We simulate maxDailyTrades=1 with 0 existing trades. Signal A gets the
    // slot (count=0 < 1 → INSERT PENDING). Signal B blocks until A commits,
    // then sees count=1 >= 1 → DAILY_LIMIT_REJECTED.

    const baseDecision = approvedDecision() as RiskDecision & { decision: 'APPROVED' };
    const decisionA = {
      ...baseDecision,
      signalId: 'sig-diff-A',
      validatedOrder: { ...baseDecision.validatedOrder, idempotencyKey: 'idem-A' },
    } as RiskDecision;

    const decisionB = {
      ...baseDecision,
      signalId: 'sig-diff-B',
      validatedOrder: { ...baseDecision.validatedOrder, idempotencyKey: 'idem-B' },
    } as RiskDecision;

    // Set maxDailyTrades=1 on both decisions
    (decisionA as { maxDailyTrades: number }).maxDailyTrades = 1;
    (decisionB as { maxDailyTrades: number }).maxDailyTrades = 1;

    // Simulate advisory-lock serialization using a promise-based mutex.
    // The first call acquires the lock, runs its callback, then releases.
    // The second call waits for the first to release before running.
    let lockPromise: Promise<void> = Promise.resolve();
    let firstTransactionDone = false;
    const ds = (service as unknown as { dataSource: { transaction: jest.Mock } }).dataSource;

    ds.transaction.mockImplementation(
      async (cb: (manager: { query: jest.Mock }) => Promise<unknown>) => {
        // Wait for the previous transaction to finish (advisory lock simulation)
        const prevLock = lockPromise;
        let releaseLock!: () => void;
        lockPromise = new Promise<void>((resolve) => {
          releaseLock = resolve;
        });
        await prevLock;

        const count = firstTransactionDone ? 1 : 0;
        const mockTrade = {
          id: firstTransactionDone ? 'trade-rejected' : 'trade-A',
          status: 'PENDING',
          signal_id: firstTransactionDone ? 'sig-diff-B' : 'sig-diff-A',
        };
        const mgr = {
          query: jest.fn().mockImplementation((sql: string) => {
            if (sql.includes('pg_advisory_xact_lock')) return Promise.resolve([]);
            if (sql.includes('SELECT * FROM trading.trades WHERE idempotency_key'))
              return Promise.resolve([]);
            if (sql.includes('COUNT(*)')) return Promise.resolve([{ count: String(count) }]);
            if (sql.includes('INSERT INTO trading.trades')) return Promise.resolve([mockTrade]);
            return Promise.resolve([]);
          }),
        };
        const result = await cb(mgr);
        firstTransactionDone = true;
        releaseLock();
        return result;
      },
    );

    // Launch both concurrently
    const results = await Promise.allSettled([
      service.executeTrade('user-1', decisionA),
      service.executeTrade('user-1', decisionB),
    ]);

    // Exactly one should succeed, one should fail with ForbiddenException
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);

    // The rejected one should be a ForbiddenException (daily limit)
    const rejectedError = (rejected[0] as PromiseRejectedResult).reason;
    expect(rejectedError).toBeInstanceOf(Error);
    expect(rejectedError.message).toContain('Daily trade limit reached');

    // Broker should have been called exactly once (for the fulfilled request)
    expect(mockOrchestratorInstance.dispatchOrder).toHaveBeenCalledTimes(1);
  });

  // ── Concurrent SAME-signal idempotency ────────────────────────────────────

  it('concurrent SAME signal: only one execution, duplicate suppressed', async () => {
    // Two concurrent requests with the SAME signalId → idempotency SELECT
    // finds the existing trade → DUPLICATE_EXISTING → no broker submission.
    const decision: RiskDecision = {
      ...approvedDecision(),
    } as RiskDecision;

    const existingTrade = { id: 'trade-existing', status: TradeStatus.OPEN };
    let firstCall = true;

    const ds = (service as unknown as { dataSource: { transaction: jest.Mock } }).dataSource;
    ds.transaction.mockImplementation(
      async (cb: (manager: { query: jest.Mock }) => Promise<unknown>) => {
        const isFirst = firstCall;
        firstCall = false;
        const mockTrade = {
          id: 'trade-1',
          status: 'PENDING',
          signal_id: 'sig-001',
          instrument: 'EURUSD',
          direction: 'BUY',
          lot_size: '0.05',
        };
        const mgr = {
          query: jest.fn().mockImplementation((sql: string) => {
            if (sql.includes('pg_advisory_xact_lock')) return Promise.resolve([]);
            if (sql.includes('SELECT * FROM trading.trades WHERE idempotency_key'))
              return Promise.resolve(isFirst ? [] : [existingTrade]);
            if (sql.includes('COUNT(*)')) return Promise.resolve([{ count: '0' }]);
            if (sql.includes('INSERT INTO trading.trades')) return Promise.resolve([mockTrade]);
            return Promise.resolve([]);
          }),
        };
        return cb(mgr);
      },
    );

    const results = await Promise.allSettled([
      service.executeTrade('user-1', decision),
      service.executeTrade('user-1', decision),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled.length).toBe(2); // both return a trade (one new, one existing)

    // Broker should have been called exactly once (the first request)
    expect(mockOrchestratorInstance.dispatchOrder).toHaveBeenCalledTimes(1);
  });
});
