import * as crypto from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { ExactDecimal } from '../../../common/utils/exact-decimal';
import { CapitalAllocation, CapitalAllocationStatus } from '../entities/capital-allocation.entity';
import { CapitalBudget } from '../entities/capital-budget.entity';
import { BrokerService } from '../../broker/broker.service';
import { isUniqueViolation } from '../../broker/utils/db-unique-violation';
import type { SizedPosition } from './position-sizing.service';
import type { TradeIntent } from '../entities/trade-intent.entity';

/**
 * Round 6 live-execution completion (§3) — typed failure codes for the
 * portfolio allocation engine.
 */
export type AllocationFailureCode =
  /** The account's explicit capital budget is missing AND cannot be seeded
   *  from the authoritative account state (§1c — never defaulted). */
  | 'ALLOCATION_BUDGET_UNPROVABLE'
  /** The sized broker-required margin commitment exceeds the account's remaining allocatable capital. */
  | 'ALLOCATION_INSUFFICIENT_CAPITAL'
  /** The per-instrument aggregate exposure would exceed the account's
   *  instrument concentration cap. */
  | 'ALLOCATION_INSTRUMENT_CONCENTRATION'
  /** The per-strategy aggregate exposure would exceed the account's
   *  strategy concentration cap. */
  | 'ALLOCATION_STRATEGY_CONCENTRATION'
  /** The budget and the sized position are denominated in different
   *  currencies — cross-currency sums are never attempted. */
  | 'ALLOCATION_CURRENCY_MISMATCH'
  /** The intent's allocation was terminally released — a replay of the same
   *  decision may not re-allocate capital. */
  | 'ALLOCATION_ALREADY_RELEASED';

/** Typed fail-closed allocation rejection — carries the stable machine code. */
export class AllocationError extends Error {
  constructor(
    readonly code: AllocationFailureCode,
    message: string,
  ) {
    super(`Capital allocation failed closed [${code}]: ${message}`);
    this.name = 'AllocationError';
  }
}

/** The §3 aggregate account view (all values decimal strings). */
export interface AllocationAccountState {
  accountCurrency: string;
  totalCapital: string;
  committedCapital: string;
  pendingOrderCommitments: string;
  openPositionExposure: string;
  inFlightCommitments: string;
  availableCapital: string;
  byInstrument: Array<{
    instrument: string;
    committedCapital: string;
    allocatedLots: string;
  }>;
  byStrategy: Array<{
    strategyCode: string;
    committedCapital: string;
  }>;
  byDirection: Array<{ direction: 'BUY' | 'SELL'; committedCapital: string }>;
}

/** User-facing allocation authority for one exact broker account. */
export interface UserCapitalAllocationState {
  brokerConnectionId: string;
  logicalAccountKey: string;
  accountCurrency: string;
  brokerEquity: string;
  hasAllocation: boolean;
  /** User-authorized shared AI capital pool for this exact broker account. */
  allocatedCapital: string | null;
  /** Total broker-margin commitment across in-flight, pending and open AI trades. */
  committedCapital: string;
  /** Margin reserved by AI decisions that have not reached an order yet. */
  inFlightCommitments: string;
  /** Margin reserved by submitted orders that are not open positions yet. */
  pendingOrderCommitments: string;
  /** Margin committed by currently open/reconciling AI positions. */
  openPositionCommitments: string;
  /** Remaining pool capacity available for additional AI trades. */
  availableCapital: string | null;
}

/** Aggregate buckets of one account's ACTIVE allocations. */
interface AggregateBuckets {
  inFlight: string;
  pendingOrders: string;
  openPositions: string;
  byInstrument: Map<string, { capital: string; lots: string }>;
  byStrategy: Map<string, string>;
  byDirection: Map<string, string>;
}

const EMPTY_BUCKET: { capital: string; lots: string } = { capital: '0', lots: '0' };
const ZERO = '0';

function addTo(map: Map<string, string>, key: string, value: string): void {
  const current = map.get(key) ?? ZERO;
  map.set(key, ExactDecimal.parse(current).add(ExactDecimal.parse(value)).toString());
}

/**
 * AllocationService (Round 6 live-execution completion §3) — the
 * server-side authoritative portfolio allocation engine between the
 * TradeIntent layer and position sizing.
 *
 * DESIGN CONTRACT
 * ───────────────
 *  - EXACTLY-ONCE per decision: UNIQUE (trade_intent_id) + idempotent
 *    re-read — retries, worker restarts, queue redelivery and CONCURRENT
 *    racing workers can never double-allocate the same AI decision (§13).
 *  - SERIALIZED per account: the compute-check-INSERT critical section runs
 *    inside ONE short transaction guarded by pg_advisory_xact_lock on
 *    (userId, logicalAccountKey) — competing strategies/workers for the
 *    same account are serialized, so two allocations can never both consume
 *    the last available capital (§3 multi-worker/strategy-conflict guard).
 *    NO provider network call ever happens inside the transaction (§14).
 *  - AGGREGATE FROM DURABLE TRUTH: committed capital is recomputed by
 *    JOINing capital_allocations × trade_intents × trades — in-flight
 *    (intent CREATED, no trade), pending (trade PENDING) and open (trade
 *    OPEN/RECONCILIATION_PENDING) commitments count; closed/rejected/
 *    cancelled trades and expired/rejected intents stop counting
 *    automatically (§9 — the aggregate self-heals from authoritative state).
 *  - EXPLICIT BUDGET: one durable capital_budgets row per (user, logical
 *    account), created only by an explicit user allocation bounded by current
 *    authoritative broker equity. Missing budget fails closed; the engine
 *    never assumes the user's full account equity. Round 7: the scope MUST be a real
 *    logical account key — a null key fails closed up front (a synthetic
 *    `conn:` scope is never fabricated; it could never be seeded).
 *  - EXACT MATH: every capital figure is ExactDecimal — JavaScript
 *    floating-point is never used (§3).
 *  - CURRENCY HONESTY: the budget and allocation must share ONE currency —
 *    cross-currency sums are never attempted (typed mismatch instead).
 */
@Injectable()
export class AllocationService {
  private readonly logger = new Logger(AllocationService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly brokerService: BrokerService,
    @InjectRepository(CapitalAllocation)
    private readonly allocationRepo: Repository<CapitalAllocation>,
    @InjectRepository(CapitalBudget)
    private readonly budgetRepo: Repository<CapitalBudget>,
  ) {}

  /**
   * Resolve (or reserve) the capital allocation for ONE AI decision.
   *
   * Idempotent per intent: an existing ACTIVE allocation is returned as-is;
   * a RELEASED allocation is a typed terminal rejection. The reservation
   * path runs the serialized aggregate-check-INSERT critical section.
   */
  async resolveOrAllocate(params: {
    intent: Pick<
      TradeIntent,
      | 'id'
      | 'userId'
      | 'brokerConnectionId'
      | 'instrument'
      | 'direction'
      | 'strategyCode'
      | 'logicalAccountKey'
    >;
    logicalAccountKey: string | null;
    sized: SizedPosition;
  }): Promise<CapitalAllocation> {
    const { intent, sized } = params;
    // Round 7 (P0 allocation-scope fix): the REAL per-account scope only.
    // Callers pass the intent's durable logical account key; when absent the
    // intent's own captured key is the fallback. A null key is a TYPED
    // fail-closed rejection — the previous synthetic `conn:<connectionId>`
    // scope was structurally unseedable (budget seeding resolves connections
    // by their REAL logical_account_key), so it could only ever surface as
    // ALLOCATION_BUDGET_UNPROVABLE downstream while masquerading as a scope.
    const logicalAccountKey = params.logicalAccountKey ?? intent.logicalAccountKey;
    if (!logicalAccountKey) {
      throw new AllocationError(
        'ALLOCATION_BUDGET_UNPROVABLE',
        `intent ${intent.id} carries no logical account key for connection ` +
          `${intent.brokerConnectionId} — the account's capital budget scope is unprovable ` +
          '(fail-closed; never a synthetic connection scope)',
      );
    }

    // Fast path (no lock): an existing allocation is the durable truth.
    const existing = await this.allocationRepo.findOne({
      where: { tradeIntentId: intent.id },
    });
    if (existing) {
      if (existing.status === CapitalAllocationStatus.RELEASED) {
        throw new AllocationError(
          'ALLOCATION_ALREADY_RELEASED',
          `intent ${intent.id} allocation was released (${existing.releasedReason}) — ` +
            'the same decision may not re-allocate capital',
        );
      }
      return existing;
    }

    const lockKey = this.computeAccountLockKey(intent.userId, logicalAccountKey);

    try {
      return await this.dataSource.transaction(async (manager) => {
        // 1. Serialize per (user, logical account) — strategy-conflict and
        //    multi-worker races are impossible inside this section (§3/§14).
        await manager.query('SELECT pg_advisory_xact_lock($1)', [lockKey]);

        // 2. Idempotency re-check inside the lock (a racing worker may have
        //    inserted between the fast path and the lock).
        const raced = await manager.query(
          `SELECT * FROM trading.capital_allocations WHERE trade_intent_id = $1 LIMIT 1`,
          [intent.id],
        );
        if (raced.length > 0) {
          const row = raced[0] as Record<string, unknown>;
          if (row.status === CapitalAllocationStatus.RELEASED) {
            throw new AllocationError(
              'ALLOCATION_ALREADY_RELEASED',
              `intent ${intent.id} allocation was released — no re-allocation`,
            );
          }
          return this.hydrateAllocation(row);
        }

        // 3. The EXPLICIT budget (seed once from authoritative state).
        const budget = await this.resolveBudget(manager, intent.userId, logicalAccountKey);
        if (budget.accountCurrency !== sized.accountCurrency) {
          throw new AllocationError(
            'ALLOCATION_CURRENCY_MISMATCH',
            `budget currency ${budget.accountCurrency} != sized currency ${sized.accountCurrency}` +
              ' — cross-currency allocation is never attempted',
          );
        }

        // 4. Aggregate the account's CURRENT commitments from durable truth.
        const aggregate = await this.aggregateActiveAllocations(
          manager,
          intent.userId,
          logicalAccountKey,
        );
        const committed = ExactDecimal.parse(aggregate.committed);
        const total = ExactDecimal.parse(budget.totalCapital);
        const requested = ExactDecimal.parse(sized.allocatedCapital);

        // 5. Sufficiency — the remaining allocatable capital (§3).
        const available = total.sub(committed);
        if (requested.gt(available)) {
          throw new AllocationError(
            'ALLOCATION_INSUFFICIENT_CAPITAL',
            `requested ${requested.toString()} ${budget.accountCurrency} but only ` +
              `${available.toString()} of ${total.toString()} remains allocatable ` +
              `(committed ${committed.toString()})`,
          );
        }

        // 6. Concentration caps (explicit account policy; NULL = unenforced).
        if (budget.maxInstrumentConcentration !== null) {
          const cap = total
            .mul(ExactDecimal.parse(budget.maxInstrumentConcentration))
            .divByPowerOfTen(2);
          const sameInstrument = ExactDecimal.parse(
            aggregate.byInstrument.get(intent.instrument)?.capital ?? ZERO,
          );
          if (sameInstrument.add(requested).gt(cap)) {
            throw new AllocationError(
              'ALLOCATION_INSTRUMENT_CONCENTRATION',
              `${intent.instrument} exposure ${sameInstrument.add(requested).toString()} would ` +
                `exceed the ${budget.maxInstrumentConcentration}% cap ${cap.toString()}`,
            );
          }
        }
        if (budget.maxStrategyConcentration !== null && intent.strategyCode) {
          const cap = total
            .mul(ExactDecimal.parse(budget.maxStrategyConcentration))
            .divByPowerOfTen(2);
          const sameStrategy = ExactDecimal.parse(
            aggregate.byStrategy.get(intent.strategyCode) ?? ZERO,
          );
          if (sameStrategy.add(requested).gt(cap)) {
            throw new AllocationError(
              'ALLOCATION_STRATEGY_CONCENTRATION',
              `strategy ${intent.strategyCode} exposure ${sameStrategy.add(requested).toString()} ` +
                `would exceed the ${budget.maxStrategyConcentration}% cap ${cap.toString()}`,
            );
          }
        }

        // 7. INSERT the reservation — UNIQUE (trade_intent_id) is the final
        //    double-allocation backstop.
        const inserted = await manager.query(
          `INSERT INTO trading.capital_allocations
             (id, user_id, trade_intent_id, broker_connection_id, logical_account_key,
              account_currency, instrument, direction, strategy_code,
              allocated_lots, allocated_capital, status, sizing_inputs)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'ACTIVE', $11)
           RETURNING *`,
          [
            intent.userId,
            intent.id,
            intent.brokerConnectionId,
            logicalAccountKey,
            sized.accountCurrency,
            intent.instrument,
            intent.direction,
            intent.strategyCode ?? null,
            sized.lots,
            sized.allocatedCapital,
            JSON.stringify(sized.inputs),
          ],
        );
        return this.hydrateAllocation(inserted[0]);
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        // A racing worker won the UNIQUE (trade_intent_id) — the winner's
        // row is the truth (exactly-once).
        const winner = await this.allocationRepo.findOne({
          where: { tradeIntentId: intent.id },
        });
        if (winner) {
          if (winner.status === CapitalAllocationStatus.RELEASED) {
            throw new AllocationError(
              'ALLOCATION_ALREADY_RELEASED',
              `intent ${intent.id} allocation was released — no re-allocation`,
            );
          }
          this.logger.log(
            `Allocation reused for intent ${intent.id} (racing winner) — exactly-once`,
          );
          return winner;
        }
      }
      throw err;
    }
  }

  /**
   * Beginner-facing allocation view. Broker equity is read authoritatively;
   * the durable capital_budgets row is the user's explicit AI allocation.
   * Missing allocation is returned as hasAllocation=false rather than being
   * silently seeded from full account equity.
   */
  async getUserCapitalAllocationState(
    userId: string,
    brokerConnectionId: string,
  ): Promise<UserCapitalAllocationState> {
    const connection = await this.brokerService.findConnectionById(brokerConnectionId, userId);
    if (!connection.logicalAccountKey) {
      throw new AllocationError(
        'ALLOCATION_BUDGET_UNPROVABLE',
        'The broker account identity is not yet verified for capital allocation.',
      );
    }

    const account = await this.brokerService.getBrokerAccountState(connection.id);
    const equity = account?.equity ? ExactDecimal.tryParse(account.equity) : null;
    const currency = account?.currency?.toUpperCase() ?? null;
    if (!equity?.isPositive() || !currency || !/^[A-Z]{3}$/.test(currency)) {
      throw new AllocationError(
        'ALLOCATION_BUDGET_UNPROVABLE',
        'The broker account does not currently provide authoritative equity and currency.',
      );
    }

    const budget = await this.budgetRepo.findOne({
      where: { userId, logicalAccountKey: connection.logicalAccountKey },
    });
    if (!budget) {
      return {
        brokerConnectionId: connection.id,
        logicalAccountKey: connection.logicalAccountKey,
        accountCurrency: currency,
        brokerEquity: equity.toString(),
        hasAllocation: false,
        allocatedCapital: null,
        committedCapital: ZERO,
        inFlightCommitments: ZERO,
        pendingOrderCommitments: ZERO,
        openPositionCommitments: ZERO,
        availableCapital: null,
      };
    }

    if (budget.accountCurrency !== currency) {
      throw new AllocationError(
        'ALLOCATION_CURRENCY_MISMATCH',
        `allocation currency ${budget.accountCurrency} differs from broker currency ${currency}`,
      );
    }

    const aggregate = await this.dataSource.transaction((manager) =>
      this.aggregateActiveAllocations(manager, userId, connection.logicalAccountKey!),
    );
    const allocated = ExactDecimal.parse(budget.totalCapital);
    const committed = ExactDecimal.parse(aggregate.committed);

    return {
      brokerConnectionId: connection.id,
      logicalAccountKey: connection.logicalAccountKey,
      accountCurrency: currency,
      brokerEquity: equity.toString(),
      hasAllocation: true,
      allocatedCapital: allocated.toString(),
      committedCapital: committed.toString(),
      inFlightCommitments: aggregate.inFlight,
      pendingOrderCommitments: aggregate.pendingOrders,
      openPositionCommitments: aggregate.openPositions,
      availableCapital: allocated.sub(committed).toString(),
    };
  }

  /**
   * Explicitly set the amount of broker equity the AI may allocate.
   * The amount cannot exceed current authoritative equity and cannot be
   * reduced below currently committed exposure.
   */
  async setUserCapitalBudget(
    userId: string,
    brokerConnectionId: string,
    amountInput: string,
  ): Promise<UserCapitalAllocationState> {
    const connection = await this.brokerService.findConnectionById(brokerConnectionId, userId);
    const logicalAccountKey = connection.logicalAccountKey;
    if (!logicalAccountKey) {
      throw new AllocationError(
        'ALLOCATION_BUDGET_UNPROVABLE',
        'The broker account identity is not yet verified for capital allocation.',
      );
    }

    const amount = ExactDecimal.tryParse(amountInput);
    if (!amount?.isPositive()) {
      throw new AllocationError(
        'ALLOCATION_INSUFFICIENT_CAPITAL',
        'Allocated capital must be a positive decimal amount.',
      );
    }

    const account = await this.brokerService.getBrokerAccountState(connection.id);
    const equity = account?.equity ? ExactDecimal.tryParse(account.equity) : null;
    const currency = account?.currency?.toUpperCase() ?? null;
    if (!equity?.isPositive() || !currency || !/^[A-Z]{3}$/.test(currency)) {
      throw new AllocationError(
        'ALLOCATION_BUDGET_UNPROVABLE',
        'The broker account does not currently provide authoritative equity and currency.',
      );
    }
    if (amount.gt(equity)) {
      throw new AllocationError(
        'ALLOCATION_INSUFFICIENT_CAPITAL',
        `allocated capital ${amount.toString()} exceeds current broker equity ${equity.toString()} ${currency}`,
      );
    }

    const lockKey = this.computeAccountLockKey(userId, logicalAccountKey);
    await this.dataSource.transaction(async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock($1)', [lockKey]);
      const aggregate = await this.aggregateActiveAllocations(manager, userId, logicalAccountKey);
      const committed = ExactDecimal.parse(aggregate.committed);
      if (amount.lt(committed)) {
        throw new AllocationError(
          'ALLOCATION_INSUFFICIENT_CAPITAL',
          `allocation cannot be reduced below committed capital ${committed.toString()} ${currency}`,
        );
      }

      await manager.query(
        `INSERT INTO trading.capital_budgets
           (id, user_id, logical_account_key, account_currency, total_capital,
            max_instrument_concentration, max_strategy_concentration)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, '50.00', '60.00')
         ON CONFLICT ON CONSTRAINT uq_capital_budgets_user_account
         DO UPDATE SET total_capital = EXCLUDED.total_capital,
                       account_currency = EXCLUDED.account_currency,
                       updated_at = NOW()`,
        [userId, logicalAccountKey, currency, amount.toString()],
      );
    });

    return this.getUserCapitalAllocationState(userId, brokerConnectionId);
  }

  /**
   * The §3 aggregate account view: explicit allocation, committed capital
   * (pending-order + open-position + in-flight), remaining allocatable and
   * the per-instrument/strategy/direction breakdown.
   */
  async getAllocationAccountState(
    userId: string,
    logicalAccountKey: string | null,
  ): Promise<AllocationAccountState> {
    const key = logicalAccountKey ?? 'unscoped';
    return this.dataSource.transaction(async (manager) => {
      const budget = await this.budgetRepo.findOne({
        where: { userId, logicalAccountKey: key },
      });
      if (!budget) {
        throw new AllocationError(
          'ALLOCATION_BUDGET_UNPROVABLE',
          `no explicit capital budget for user ${userId} account ${key} — ` +
            'allocate capital explicitly before enabling AI trading',
        );
      }
      const aggregate = await this.aggregateActiveAllocations(manager, userId, key);
      const total = ExactDecimal.parse(budget.totalCapital);
      const committed = ExactDecimal.parse(aggregate.committed);
      return {
        accountCurrency: budget.accountCurrency,
        totalCapital: budget.totalCapital,
        committedCapital: aggregate.committed,
        pendingOrderCommitments: aggregate.pendingOrders,
        openPositionExposure: aggregate.openPositions,
        inFlightCommitments: aggregate.inFlight,
        availableCapital: total.sub(committed).toString(),
        byInstrument: [...aggregate.byInstrument.entries()].map(([instrument, v]) => ({
          instrument,
          committedCapital: v.capital,
          allocatedLots: v.lots,
        })),
        byStrategy: [...aggregate.byStrategy.entries()].map(([strategyCode, capital]) => ({
          strategyCode,
          committedCapital: capital,
        })),
        byDirection: [...aggregate.byDirection.entries()].map(([direction, capital]) => ({
          direction: direction as 'BUY' | 'SELL',
          committedCapital: capital,
        })),
      };
    });
  }

  /**
   * Terminally release an intent's allocation (definite non-exposure: risk
   * rejection, definite dispatch failure). Guarded CAS — a RELEASED
   * allocation never transitions back.
   */
  async releaseAllocationForIntent(tradeIntentId: string, reason: string): Promise<void> {
    await this.allocationRepo
      .createQueryBuilder()
      .update()
      .set({
        status: CapitalAllocationStatus.RELEASED,
        releasedReason: reason.slice(0, 60),
        updatedAt: new Date(),
      })
      .where('trade_intent_id = :tradeIntentId AND status = :status', {
        tradeIntentId,
        status: CapitalAllocationStatus.ACTIVE,
      })
      .execute();
  }

  // ─── Internals ─────────────────────────────────────────────────────────

  /**
   * The explicit budget row — seeded ONCE from the AUTHORITATIVE account
   * snapshot (§1a routing; a DB-only read, safe inside the transaction)
   * when absent. Fail-closed when neither the row nor the authoritative
   * state exists (§1c — never a defaulted or guessed capital figure).
   */
  private async resolveBudget(
    manager: { query: (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]> },
    userId: string,
    logicalAccountKey: string,
  ): Promise<{
    totalCapital: string;
    accountCurrency: string;
    maxInstrumentConcentration: string | null;
    maxStrategyConcentration: string | null;
  }> {
    const rows = await manager.query(
      `SELECT * FROM trading.capital_budgets
         WHERE user_id = $1 AND logical_account_key = $2 LIMIT 1`,
      [userId, logicalAccountKey],
    );
    if (rows.length > 0) {
      const row = rows[0];
      return {
        totalCapital: String(row.total_capital),
        accountCurrency: String(row.account_currency),
        maxInstrumentConcentration:
          row.max_instrument_concentration === null
            ? null
            : String(row.max_instrument_concentration),
        maxStrategyConcentration:
          row.max_strategy_concentration === null ? null : String(row.max_strategy_concentration),
      };
    }

    throw new AllocationError(
      'ALLOCATION_BUDGET_UNPROVABLE',
      `no explicit capital budget for account ${logicalAccountKey} — ` +
        'the user must allocate capital before AI trading can create new exposure',
    );
  }

  /**
   * Aggregate the account's ACTIVE allocation commitments from CURRENT
   * durable truth. The JOIN makes the buckets self-healing (§9):
   *   in-flight     = intent CREATED and no trade yet
   *   pending       = trade PENDING (submitted/awaiting provider)
   *   open          = trade OPEN / RECONCILIATION_PENDING
   * Anything else (closed/rejected/cancelled trade; expired/rejected/
   * superseded/executed-without-trade intent) stops counting.
   */
  private async aggregateActiveAllocations(
    manager: { query: (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]> },
    userId: string,
    logicalAccountKey: string,
  ): Promise<{ committed: string } & AggregateBuckets> {
    const rows = await manager.query(
      `SELECT
         a.allocated_capital AS allocated_capital,
         a.allocated_lots    AS allocated_lots,
         a.instrument        AS instrument,
         a.direction         AS direction,
         a.strategy_code     AS strategy_code,
         i.status            AS intent_status,
         t.status            AS trade_status
       FROM trading.capital_allocations a
       LEFT JOIN trading.trade_intents i ON i.id = a.trade_intent_id
       LEFT JOIN trading.trades t ON t.trade_intent_id = a.trade_intent_id
       WHERE a.user_id = $1
         AND a.logical_account_key = $2
         AND a.status = 'ACTIVE'`,
      [userId, logicalAccountKey],
    );

    const buckets: AggregateBuckets = {
      inFlight: ZERO,
      pendingOrders: ZERO,
      openPositions: ZERO,
      byInstrument: new Map(),
      byStrategy: new Map(),
      byDirection: new Map(),
    };

    for (const row of rows) {
      const capital = String(row.allocated_capital);
      const lots = String(row.allocated_lots);
      const tradeStatus = row.trade_status as string | null;
      const intentStatus = row.intent_status as string | null;

      let counts = false;
      if (tradeStatus === 'PENDING') {
        buckets.pendingOrders = ExactDecimal.parse(buckets.pendingOrders)
          .add(ExactDecimal.parse(capital))
          .toString();
        counts = true;
      } else if (tradeStatus === 'OPEN' || tradeStatus === 'RECONCILIATION_PENDING') {
        buckets.openPositions = ExactDecimal.parse(buckets.openPositions)
          .add(ExactDecimal.parse(capital))
          .toString();
        counts = true;
      } else if (tradeStatus === null && intentStatus === 'CREATED') {
        // In flight: the decision holds capital but no trade exists yet.
        buckets.inFlight = ExactDecimal.parse(buckets.inFlight)
          .add(ExactDecimal.parse(capital))
          .toString();
        counts = true;
      }

      if (counts) {
        const instrumentBucket = buckets.byInstrument.get(String(row.instrument)) ?? {
          ...EMPTY_BUCKET,
        };
        buckets.byInstrument.set(String(row.instrument), {
          capital: ExactDecimal.parse(instrumentBucket.capital)
            .add(ExactDecimal.parse(capital))
            .toString(),
          lots: ExactDecimal.parse(instrumentBucket.lots).add(ExactDecimal.parse(lots)).toString(),
        });
        if (row.strategy_code !== null && row.strategy_code !== undefined) {
          addTo(buckets.byStrategy, String(row.strategy_code), capital);
        }
        addTo(buckets.byDirection, String(row.direction), capital);
      }
    }

    const committed = ExactDecimal.parse(buckets.inFlight)
      .add(ExactDecimal.parse(buckets.pendingOrders))
      .add(ExactDecimal.parse(buckets.openPositions))
      .toString();

    return { committed, ...buckets };
  }

  private hydrateAllocation(row: Record<string, unknown>): CapitalAllocation {
    const allocation = new CapitalAllocation();
    const target = allocation as unknown as Record<string, unknown>;
    const mappings: Array<[string, string]> = [
      ['id', 'id'],
      ['user_id', 'userId'],
      ['trade_intent_id', 'tradeIntentId'],
      ['broker_connection_id', 'brokerConnectionId'],
      ['logical_account_key', 'logicalAccountKey'],
      ['account_currency', 'accountCurrency'],
      ['instrument', 'instrument'],
      ['direction', 'direction'],
      ['strategy_code', 'strategyCode'],
      ['allocated_lots', 'allocatedLots'],
      ['allocated_capital', 'allocatedCapital'],
      ['status', 'status'],
      ['sizing_inputs', 'sizingInputs'],
      ['released_reason', 'releasedReason'],
      ['created_at', 'createdAt'],
      ['updated_at', 'updatedAt'],
    ];
    for (const [dbKey, entityKey] of mappings) {
      if (Object.prototype.hasOwnProperty.call(row, dbKey)) target[entityKey] = row[dbKey];
    }
    return allocation;
  }

  /** Stable 32-bit advisory-lock key for (userId, logicalAccountKey). */
  private computeAccountLockKey(userId: string, logicalAccountKey: string): number {
    const digest = crypto.createHash('sha256').update(`${userId}:${logicalAccountKey}`).digest();
    return digest.readUInt32BE(0) & 0x7fffffff;
  }
}
