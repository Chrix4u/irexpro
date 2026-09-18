import { DataSource } from 'typeorm';
import { AllocationError, AllocationService } from './allocation.service';
import { CapitalAllocationStatus } from '../entities/capital-allocation.entity';
import { BrokerService } from '../../broker/broker.service';
import type { PositionSizingInputs, SizedPosition } from './position-sizing.service';

/**
 * AllocationService (Round 6 live-execution completion §3) — the
 * server-side authoritative portfolio allocation engine.
 *
 * The serialized critical section runs inside ONE transaction guarded by
 * pg_advisory_xact_lock — the same seam order.service.spec.ts mocks: the
 * DataSource's transaction() invokes the callback with a fake manager that
 * implements the exact SQL contract against in-memory rows (the raw-SQL
 * semantics are re-proven by the CI-gated pg-integration suites). The
 * ALLOCATION LOGIC under test — ExactDecimal aggregate math, idempotency,
 * sufficiency, concentration caps, explicit budgets, currency honesty, CAS
 * release — is the REAL production code.
 *
 * Matrix (§3/§13):
 *   - reserve within available capital; typed INSUFFICIENT when exceeded
 *   - idempotent per intent (existing ACTIVE returned as-is — never a
 *     second allocation for the same decision)
 *   - RELEASED allocation → typed terminal rejection (no resurrection)
 *   - budget: explicit user allocation is required; a missing row fails
 *     closed even when authoritative broker equity exists (§1c — never a
 *     silent full-equity default)
 *   - currency honesty: budget currency must equal the sized currency
 *   - concentration caps: per-instrument + per-strategy (explicit policy)
 *   - aggregate buckets self-heal from durable truth: in-flight (intent
 *     CREATED, no trade) / pending (trade PENDING) / open (trade OPEN)
 *     count; CLOSED / REJECTED / CANCELLED / expired-intent stop counting
 *   - the account-state view exposes total/committed/available + per-
 *     instrument/strategy/direction breakdowns
 *   - releaseAllocationForIntent is a guarded CAS (ACTIVE → RELEASED only)
 */

const USER = '11111111-1111-4111-8111-111111111111';
const CONN = '22222222-2222-4222-8222-222222222222';
const KEY = 'paper-broker::DEMO::acct-1';

const intent = (id: string, overrides: Partial<Record<string, unknown>> = {}) => ({
  id,
  userId: USER,
  brokerConnectionId: CONN,
  instrument: 'EURUSD',
  direction: 'BUY' as const,
  strategyCode: 'TREND_V1',
  // Round 7 (P0 allocation-scope fix): the durable intent carries the
  // connection's real logical account key.
  logicalAccountKey: KEY,
  ...overrides,
});

const sizingInputsFixture = (): PositionSizingInputs => ({
  accountCurrency: 'USD',
  equity: '10000.00',
  freeMargin: '9500.00',
  riskPercent: '2.00',
  riskAmount: '200',
  entryPrice: '1.085',
  entryPriceSource: 'MARKET_QUOTE',
  stopLoss: '1.075',
  stopLossDistance: '0.01',
  contractSize: '100000',
  minLot: '0.01',
  maxLot: '10.00',
  lotStep: '0.01',
  profileMaxPositionSizeLot: '1.0',
  lotsByRiskBudget: '0.2',
  lotsBeforeStepNormalization: '0.2',
  computedAt: new Date(0).toISOString(),
});

const sized = (overrides: Partial<SizedPosition> = {}): SizedPosition => ({
  lots: '0.20',
  allocatedCapital: '21700',
  accountCurrency: 'USD',
  entryPrice: '1.085',
  inputs: sizingInputsFixture(),
  ...overrides,
});

/** One joined aggregate row (allocation × intent × trade truth). */
const joinRow = (alloc: Partial<Record<string, unknown>> = {}) => ({
  allocated_capital: '21700',
  allocated_lots: '0.20',
  instrument: 'EURUSD',
  direction: 'BUY',
  strategy_code: 'TREND_V1',
  intent_status: 'CREATED',
  trade_status: null,
  ...alloc,
});

describe('AllocationService — server-side authoritative capital layer (Round 6 §3)', () => {
  let service: AllocationService;
  let brokerService: {
    getBrokerAccountState: jest.Mock;
    findConnectionById: jest.Mock;
  };
  /** In-memory store behind the fake manager. */
  let store: {
    allocations: Array<Record<string, unknown>>;
    budgets: Array<Record<string, unknown>>;
    aggregateRows: Array<Record<string, unknown>>;
    connections: Array<Record<string, unknown>>;
    seedAccountState: { equity: string; currency: string } | null;
    nextUniqueViolation: boolean;
  };
  let txRan: boolean;

  const fakeManager = () => ({
    query: jest.fn().mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('pg_advisory_xact_lock')) return [];
      // Idempotency re-check by intent id.
      if (sql.includes('SELECT * FROM trading.capital_allocations WHERE trade_intent_id')) {
        const found = store.allocations.filter((a) => a.trade_intent_id === params?.[0]);
        return found;
      }
      // Budget lookups.
      if (sql.includes('SELECT * FROM trading.capital_budgets')) {
        return store.budgets.filter(
          (b) => b.user_id === params?.[0] && b.logical_account_key === params?.[1],
        );
      }
      // Budget seed: resolve the connection owning the account scope.
      if (sql.includes('SELECT id FROM broker.broker_connections')) {
        return store.connections.filter(
          (c) => c.user_id === params?.[0] && c.logical_account_key === params?.[1],
        );
      }
      if (sql.includes('INSERT INTO trading.capital_budgets')) {
        const existing = store.budgets.some(
          (b) => b.user_id === params?.[0] && b.logical_account_key === params?.[1],
        );
        if (!existing) {
          store.budgets.push({
            user_id: params?.[0],
            logical_account_key: params?.[1],
            account_currency: params?.[2],
            total_capital: params?.[3],
            max_instrument_concentration: '50.00',
            max_strategy_concentration: '60.00',
          });
        }
        return [];
      }
      // The aggregate join — the durable-truth rows.
      if (sql.includes('FROM trading.capital_allocations a')) {
        return store.aggregateRows;
      }
      // The reservation INSERT.
      if (sql.includes('INSERT INTO trading.capital_allocations')) {
        if (store.nextUniqueViolation) {
          store.nextUniqueViolation = false;
          throw Object.assign(new Error('duplicate key value violates unique constraint'), {
            code: '23505',
          });
        }
        const row = {
          id: `alloc-${store.allocations.length + 1}`,
          user_id: params?.[0],
          trade_intent_id: params?.[1],
          broker_connection_id: params?.[2],
          logical_account_key: params?.[3],
          account_currency: params?.[4],
          instrument: params?.[5],
          direction: params?.[6],
          strategy_code: params?.[7],
          allocated_lots: params?.[8],
          allocated_capital: params?.[9],
          status: 'ACTIVE',
          sizing_inputs: params?.[10],
          released_reason: null,
        };
        store.allocations.push(row);
        return [row];
      }
      return [];
    }),
  });

  const dataSource = {
    transaction: jest
      .fn()
      .mockImplementation(async (cb: (manager: unknown) => Promise<unknown>) => {
        txRan = true;
        return cb(fakeManager());
      }),
  } as unknown as DataSource;

  const allocationRepo = () => ({
    findOne: jest.fn().mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
      const found = store.allocations.find((a) => a.trade_intent_id === where.tradeIntentId);
      return found ? { ...found } : null;
    }),
    createQueryBuilder: () => {
      const applyCas = (params: Record<string, unknown>) => {
        // CAS release: only ACTIVE rows transition.
        const row = store.allocations.find((a) => a.trade_intent_id === params.tradeIntentId);
        if (row && row.status === 'ACTIVE' && params.status === 'ACTIVE') {
          row.status = 'RELEASED';
        }
      };
      const chain: Record<string, jest.Mock> = {};
      chain.update = jest.fn().mockReturnValue(chain);
      chain.set = jest.fn().mockReturnValue(chain);
      chain.where = jest
        .fn()
        .mockImplementation((_sql: string, params: Record<string, unknown>) => {
          applyCas(params);
          return chain;
        });
      chain.execute = jest.fn().mockResolvedValue({ affected: 1 });
      return chain;
    },
  });

  const budgetRepo = () => ({
    findOne: jest.fn().mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
      const found = store.budgets.find(
        (b) => b.user_id === where.userId && b.logical_account_key === where.logicalAccountKey,
      );
      // Entity-shaped (camelCase) row — the repo API surface.
      return found
        ? {
            id: 'budget-1',
            userId: found.user_id,
            logicalAccountKey: found.logical_account_key,
            accountCurrency: found.account_currency,
            totalCapital: String(found.total_capital),
            maxInstrumentConcentration:
              found.max_instrument_concentration === null
                ? null
                : String(found.max_instrument_concentration),
            maxStrategyConcentration:
              found.max_strategy_concentration === null
                ? null
                : String(found.max_strategy_concentration),
          }
        : null;
    }),
  });

  beforeEach(() => {
    store = {
      allocations: [],
      budgets: [
        {
          user_id: USER,
          logical_account_key: KEY,
          account_currency: 'USD',
          total_capital: '50000',
          max_instrument_concentration: null,
          max_strategy_concentration: null,
        },
      ],
      aggregateRows: [],
      connections: [{ id: CONN, user_id: USER, logical_account_key: KEY }],
      seedAccountState: { equity: '10000.00', currency: 'USD' },
      nextUniqueViolation: false,
    };
    txRan = false;
    brokerService = {
      findConnectionById: jest.fn().mockResolvedValue({
        id: CONN,
        userId: USER,
        logicalAccountKey: KEY,
      }),
      getBrokerAccountState: jest.fn().mockImplementation(async () =>
        store.seedAccountState
          ? {
              balance: store.seedAccountState.equity,
              equity: store.seedAccountState.equity,
              freeMargin: store.seedAccountState.equity,
              currency: store.seedAccountState.currency,
            }
          : null,
      ),
    };
    service = new AllocationService(
      dataSource,
      brokerService as unknown as BrokerService,
      allocationRepo() as never,
      budgetRepo() as never,
    );
  });

  // ─── Reservation ────────────────────────────────────────────────────────

  describe('resolveOrAllocate', () => {
    it('reserves within the available capital (50k budget, 21.7k request)', async () => {
      const alloc = await service.resolveOrAllocate({
        intent: intent('intent-1'),
        logicalAccountKey: KEY,
        sized: sized(),
      });

      expect(alloc.status).toBe(CapitalAllocationStatus.ACTIVE);
      expect(alloc.allocatedCapital).toBe('21700');
      expect(alloc.allocatedLots).toBe('0.20');
      expect(alloc.tradeIntentId).toBe('intent-1');
      expect(txRan).toBe(true);
    });

    it('is IDEMPOTENT per intent — an existing ACTIVE allocation is returned without a second reservation', async () => {
      const first = await service.resolveOrAllocate({
        intent: intent('intent-1'),
        logicalAccountKey: KEY,
        sized: sized(),
      });
      const second = await service.resolveOrAllocate({
        intent: intent('intent-1'),
        logicalAccountKey: KEY,
        sized: sized(),
      });

      expect(second.id).toBe(first.id);
      expect(store.allocations).toHaveLength(1);
    });

    it('rejects a RELEASED allocation — the same decision may not re-allocate (no resurrection)', async () => {
      store.allocations.push({
        id: 'alloc-dead',
        trade_intent_id: 'intent-1',
        status: 'RELEASED',
        released_reason: 'RISK_REJECTED',
      });
      await expect(
        service.resolveOrAllocate({
          intent: intent('intent-1'),
          logicalAccountKey: KEY,
          sized: sized(),
        }),
      ).rejects.toMatchObject({ code: 'ALLOCATION_ALREADY_RELEASED' });
    });

    it('rejects when the request exceeds the remaining allocatable capital (typed INSUFFICIENT)', async () => {
      // Committed: 30k open + 10k pending → available = 50k − 40k = 10k.
      store.aggregateRows = [
        joinRow({ allocated_capital: '30000', trade_status: 'OPEN' }),
        joinRow({ allocated_capital: '10000', trade_status: 'PENDING' }),
      ];
      await expect(
        service.resolveOrAllocate({
          intent: intent('intent-1'),
          logicalAccountKey: KEY,
          sized: sized({ allocatedCapital: '21700' }),
        }),
      ).rejects.toMatchObject({ code: 'ALLOCATION_INSUFFICIENT_CAPITAL' });
    });

    it('a racing UNIQUE violation resolves to the winner row (exactly-once under concurrency)', async () => {
      store.nextUniqueViolation = true;
      store.allocations.push({
        id: 'alloc-winner',
        trade_intent_id: 'intent-1',
        status: 'ACTIVE',
        allocated_capital: '21700',
      });
      const alloc = await service.resolveOrAllocate({
        intent: intent('intent-1'),
        logicalAccountKey: KEY,
        sized: sized(),
      });
      expect(alloc.id).toBe('alloc-winner');
    });

    it('rejects a currency mismatch between the budget and the sized position (never cross-summed)', async () => {
      await expect(
        service.resolveOrAllocate({
          intent: intent('intent-1'),
          logicalAccountKey: KEY,
          sized: sized({ accountCurrency: 'EUR' }),
        }),
      ).rejects.toMatchObject({ code: 'ALLOCATION_CURRENCY_MISMATCH' });
    });

    // ─── Concentration caps (explicit account policy) ───────────────────

    it('enforces the per-instrument concentration cap', async () => {
      store.budgets[0].max_instrument_concentration = '50.00'; // 25k of 50k
      store.aggregateRows = [
        joinRow({ allocated_capital: '10000', instrument: 'EURUSD', trade_status: 'OPEN' }),
      ];
      // 10000 + 21700 = 31700 > 25000 → typed rejection.
      await expect(
        service.resolveOrAllocate({
          intent: intent('intent-1'),
          logicalAccountKey: KEY,
          sized: sized(),
        }),
      ).rejects.toMatchObject({ code: 'ALLOCATION_INSTRUMENT_CONCENTRATION' });
    });

    it('enforces the per-strategy concentration cap', async () => {
      store.budgets[0].max_strategy_concentration = '40.00'; // 20k of 50k
      store.aggregateRows = [
        joinRow({ allocated_capital: '5000', strategy_code: 'TREND_V1', trade_status: 'OPEN' }),
      ];
      // 5000 + 21700 = 26700 > 20000 → typed rejection.
      await expect(
        service.resolveOrAllocate({
          intent: intent('intent-1'),
          logicalAccountKey: KEY,
          sized: sized(),
        }),
      ).rejects.toMatchObject({ code: 'ALLOCATION_STRATEGY_CONCENTRATION' });
    });

    it('a different instrument/strategy does not trip the caps', async () => {
      store.budgets[0].max_instrument_concentration = '50.00';
      store.budgets[0].max_strategy_concentration = '50.00';
      store.aggregateRows = [
        joinRow({
          allocated_capital: '20000',
          instrument: 'USDJPY',
          strategy_code: 'MEAN_REVERT',
          trade_status: 'OPEN',
        }),
      ];
      const alloc = await service.resolveOrAllocate({
        intent: intent('intent-1', { instrument: 'EURUSD', strategyCode: 'TREND_V1' }),
        logicalAccountKey: KEY,
        sized: sized(),
      });
      expect(alloc.status).toBe(CapitalAllocationStatus.ACTIVE);
    });

    // ─── Explicit user budget (no silent full-equity seeding) ───────────

    it('fail-closes when no explicit user allocation exists even if broker equity is available', async () => {
      store.budgets = [];
      await expect(
        service.resolveOrAllocate({
          intent: intent('intent-1'),
          logicalAccountKey: KEY,
          sized: sized({ allocatedCapital: '100' }),
        }),
      ).rejects.toMatchObject({ code: 'ALLOCATION_BUDGET_UNPROVABLE' });

      expect(brokerService.getBrokerAccountState).not.toHaveBeenCalled();
      expect(store.budgets).toHaveLength(0);
      expect(store.allocations).toHaveLength(0);
    });

    // ─── Round 7 (P0 allocation-scope fix) ─────────────────────────────

    it('P0 fix: a null logical account key fails closed UP FRONT — no synthetic conn: scope is ever fabricated', async () => {
      await expect(
        service.resolveOrAllocate({
          intent: intent('intent-1', { logicalAccountKey: null }),
          logicalAccountKey: null,
          sized: sized(),
        }),
      ).rejects.toMatchObject({
        code: 'ALLOCATION_BUDGET_UNPROVABLE',
        message: expect.stringContaining('no logical account key'),
      });
      // Nothing was reserved and no budget row was fabricated.
      expect(store.allocations).toHaveLength(0);
      expect(store.budgets).toHaveLength(1); // the pre-seeded fixture row only
    });

    it("P0 fix: the intent's durable logical account key is the fallback when the caller passes none", async () => {
      const alloc = await service.resolveOrAllocate({
        intent: intent('intent-1'), // carries logicalAccountKey: KEY
        logicalAccountKey: null,
        sized: sized(),
      });
      expect(alloc.status).toBe(CapitalAllocationStatus.ACTIVE);
      // Reserved against the REAL account scope, never conn:<connectionId>.
      expect(store.allocations[0].logical_account_key).toBe(KEY);
    });

    it("P0 fix: the caller's explicit key wins over the intent's captured key", async () => {
      await service.resolveOrAllocate({
        intent: intent('intent-1', { logicalAccountKey: 'other::DEMO::acct-9' }),
        logicalAccountKey: KEY,
        sized: sized(),
      });
      expect(store.allocations[0].logical_account_key).toBe(KEY);
    });
  });

  // ─── User-facing explicit allocation authority ─────────────────────────

  describe('user capital allocation state', () => {
    it('returns hasAllocation=false without silently seeding full broker equity', async () => {
      store.budgets = [];
      store.seedAccountState = { equity: '12500.00', currency: 'USD' };

      const state = await service.getUserCapitalAllocationState(USER, CONN);

      expect(state).toEqual({
        brokerConnectionId: CONN,
        logicalAccountKey: KEY,
        accountCurrency: 'USD',
        brokerEquity: '12500',
        hasAllocation: false,
        allocatedCapital: null,
        committedCapital: '0',
        availableCapital: null,
      });
      expect(store.budgets).toHaveLength(0);
    });

    it('rejects setting an allocation above current authoritative broker equity', async () => {
      store.seedAccountState = { equity: '10000.00', currency: 'USD' };

      await expect(service.setUserCapitalBudget(USER, CONN, '10000.01')).rejects.toMatchObject({
        code: 'ALLOCATION_INSUFFICIENT_CAPITAL',
      });
    });

    it('rejects reducing the allocation below currently committed exposure', async () => {
      store.seedAccountState = { equity: '100000.00', currency: 'USD' };
      store.aggregateRows = [joinRow({ allocated_capital: '20000', trade_status: 'OPEN' })];

      await expect(service.setUserCapitalBudget(USER, CONN, '19999.99')).rejects.toMatchObject({
        code: 'ALLOCATION_INSUFFICIENT_CAPITAL',
      });
    });

    it('persists an explicit allocation and returns committed/available capital', async () => {
      store.budgets = [];
      store.seedAccountState = { equity: '10000.00', currency: 'USD' };
      store.aggregateRows = [joinRow({ allocated_capital: '1250', trade_status: 'OPEN' })];

      const state = await service.setUserCapitalBudget(USER, CONN, '5000.00');

      expect(state.hasAllocation).toBe(true);
      expect(state.allocatedCapital).toBe('5000');
      expect(state.committedCapital).toBe('1250');
      expect(state.availableCapital).toBe('3750');
      expect(store.budgets).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            user_id: USER,
            logical_account_key: KEY,
            account_currency: 'USD',
            total_capital: '5000',
          }),
        ]),
      );
    });

    it('fails closed when a persisted allocation currency differs from current broker currency', async () => {
      store.seedAccountState = { equity: '50000.00', currency: 'EUR' };

      await expect(service.getUserCapitalAllocationState(USER, CONN)).rejects.toMatchObject({
        code: 'ALLOCATION_CURRENCY_MISMATCH',
      });
    });

    it('fails closed when the exact broker account has no durable logical account identity', async () => {
      brokerService.findConnectionById.mockResolvedValue({
        id: CONN,
        userId: USER,
        logicalAccountKey: null,
      });

      await expect(service.getUserCapitalAllocationState(USER, CONN)).rejects.toMatchObject({
        code: 'ALLOCATION_BUDGET_UNPROVABLE',
      });
    });
  });

  // ─── The aggregate account view (§3) ────────────────────────────────────

  describe('getAllocationAccountState', () => {
    it('aggregates the §3 buckets from durable truth', async () => {
      store.aggregateRows = [
        // in-flight: intent CREATED, no trade
        joinRow({ allocated_capital: '5000', intent_status: 'CREATED', trade_status: null }),
        // pending order
        joinRow({ allocated_capital: '10000', intent_status: 'EXECUTED', trade_status: 'PENDING' }),
        // open position
        joinRow({
          allocated_capital: '20000',
          instrument: 'USDJPY',
          strategy_code: 'MEAN_REVERT',
          direction: 'SELL',
          trade_status: 'OPEN',
        }),
        // CLOSED trade — stops counting
        joinRow({ allocated_capital: '99999', trade_status: 'CLOSED' }),
        // REJECTED trade — stops counting
        joinRow({ allocated_capital: '88888', trade_status: 'REJECTED' }),
        // expired intent without trade — stops counting
        joinRow({ allocated_capital: '77777', intent_status: 'EXPIRED', trade_status: null }),
      ];

      const state = await service.getAllocationAccountState(USER, KEY);

      expect(state.totalCapital).toBe('50000');
      expect(state.inFlightCommitments).toBe('5000');
      expect(state.pendingOrderCommitments).toBe('10000');
      expect(state.openPositionExposure).toBe('20000');
      expect(state.committedCapital).toBe('35000');
      expect(state.availableCapital).toBe('15000');
      expect(state.byInstrument).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ instrument: 'EURUSD', committedCapital: '15000' }),
          expect.objectContaining({ instrument: 'USDJPY', committedCapital: '20000' }),
        ]),
      );
      expect(state.byStrategy).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ strategyCode: 'TREND_V1', committedCapital: '15000' }),
          expect.objectContaining({ strategyCode: 'MEAN_REVERT', committedCapital: '20000' }),
        ]),
      );
      expect(state.byDirection).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ direction: 'BUY', committedCapital: '15000' }),
          expect.objectContaining({ direction: 'SELL', committedCapital: '20000' }),
        ]),
      );
    });

    it('fail-closes when no budget row exists for the account', async () => {
      store.budgets = [];
      await expect(service.getAllocationAccountState(USER, KEY)).rejects.toMatchObject({
        code: 'ALLOCATION_BUDGET_UNPROVABLE',
      });
    });
  });

  // ─── Release CAS ────────────────────────────────────────────────────────

  describe('releaseAllocationForIntent', () => {
    it('releases an ACTIVE allocation and never resurrects a RELEASED one', async () => {
      store.allocations.push({
        id: 'alloc-1',
        trade_intent_id: 'intent-1',
        status: 'ACTIVE',
      });
      await service.releaseAllocationForIntent('intent-1', 'RISK_REJECTED');
      expect(store.allocations[0].status).toBe('RELEASED');

      // A second release is a no-op; the row stays RELEASED.
      await service.releaseAllocationForIntent('intent-1', 'RISK_REJECTED');
      expect(store.allocations[0].status).toBe('RELEASED');
    });
  });

  // ─── Typed error shape ──────────────────────────────────────────────────

  it('AllocationError carries the stable machine code', async () => {
    store.aggregateRows = [joinRow({ allocated_capital: '50000', trade_status: 'OPEN' })];
    try {
      await service.resolveOrAllocate({
        intent: intent('intent-1'),
        logicalAccountKey: KEY,
        sized: sized(),
      });
      throw new Error('expected rejection');
    } catch (err) {
      expect(err).toBeInstanceOf(AllocationError);
      expect((err as AllocationError).code).toBe('ALLOCATION_INSUFFICIENT_CAPITAL');
      expect((err as Error).message).toContain('ALLOCATION_INSUFFICIENT_CAPITAL');
    }
  });
});
