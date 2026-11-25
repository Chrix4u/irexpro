import { ConflictException } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import type { QueryRunner } from 'typeorm';
import { Order } from './order.entity';
import { OrderService } from './order.service';
import { OrderStatus } from './order.enums';
import { CreateNormalizedOrderDomain1753600000000 } from '../../../database/migrations/1753600000000-CreateNormalizedOrderDomain';
import { AddOrderProviderNativeIdentifiers1795220000000 } from '../../../database/migrations/1795220000000-AddOrderProviderNativeIdentifiers';
import { CreateOrderFillEvidenceLedger1795564800000 } from '../../../database/migrations/1795564800000-CreateOrderFillEvidenceLedger';
import { HardenOrderFillEvidenceLedger1795628400000 } from '../../../database/migrations/1795628400000-HardenOrderFillEvidenceLedger';

/**
 * Accounting-integrity correction 2026-11-25 + independent-review hardening
 * round (PR #805 findings 1-6) — real-PostgreSQL proof for the immutable
 * per-fill accounting evidence ledger.
 *
 * Isolated database ONLY (never production): the spec boots its own
 * DataSource, applies the REAL migration chain (1753600000000 →
 * 1795220000000 → 1795564800000 → 1795628400000 hardening) to an empty
 * trading schema, and runs the REAL OrderService against it.
 *
 * Proves on a real database:
 *   1. The confirmed partial-fill replay defect is closed (A + B + replayed
 *      A stays 0.20, exact numeric arithmetic and VWAP included).
 *   2. Concurrent duplicate delivery of the same deal is idempotent.
 *   3. Cross-order and concurrent cross-order deal attribution fail closed.
 *   4. A refused (overfill) fill leaves NO evidence row — transactional
 *      all-or-nothing.
 *   5. Unidentified (NULL deal) fills are recorded honestly with their
 *      evidence class; orders.filled_quantity == SUM(ledger.quantity) for
 *      ledger-managed orders.
 *   6. The ledger is append-only at the DATABASE level (row trigger
 *      UPDATE/DELETE + statement trigger TRUNCATE) and order deletion is
 *      refused while evidence exists (ON DELETE RESTRICT).
 *   7. Mixed-era accounting (finding 1): the pre-ledger cumulative state is
 *      transcribed ONCE as a LEGACY_BASELINE row at the first ledger-era
 *      fill, and a replay of the RETAINED legacy deal AFTER the pointer
 *      moved to newer fills stays an idempotent no-op.
 *   8. Contradictory evidence (finding 3): the same native deal redelivered
 *      with different quantity/price is refused with both facts stated;
 *      the identical redelivery stays an idempotent no-op.
 *   9. Historical deal ownership (finding 2): findDealOwner resolves from
 *      ledger evidence / legacy pointers and reports ambiguity.
 *  10. Referential consistency (finding 6): the pair FK binds each ledger
 *      row to the order AND its exact broker connection; deleting the
 *      broker connection is refused while evidence references it.
 *  11. Populated downgrade refusal (finding 6): migration 1795628400000's
 *      down() refuses while booked evidence exists, and the export-first
 *      rollback procedure preserves the accounting facts.
 *  12. Migration down()/up() rollback rehearsal for BOTH ledger migrations
 *      on the live isolated DB.
 */
describe('OrderService.applyFill — real PostgreSQL ledger proof', () => {
  let dataSource: DataSource;
  let service: OrderService;
  let orderRepo: Repository<Order>;

  const userId = '11111111-1111-1111-1111-111111111111';
  const connectionId = '22222222-2222-2222-2222-222222222222';
  let seedSeq = 0;

  const qr = (): QueryRunner =>
    ({ query: (sql: string) => dataSource.query(sql) }) as unknown as QueryRunner;

  async function seedOrder(overrides: Record<string, unknown> = {}): Promise<string> {
    seedSeq += 1;
    const rows: Array<{ id: string }> = await dataSource.query(
      `INSERT INTO trading.orders
         (user_id, broker_connection_id, client_order_id, idempotency_key,
          order_kind, time_in_force, instrument, direction,
          requested_quantity, status, filled_quantity, submitted_at)
       VALUES ($1, $2, $3, gen_random_uuid()::text,
               'MARKET', 'IOC', 'EURUSD', 'BUY',
               $4, 'ACKNOWLEDGED', 0, NOW())
       RETURNING id`,
      [
        userId,
        connectionId,
        `pg-spec-${seedSeq}-${overrides['client_order_id'] ?? 'order'}`,
        overrides['requested_quantity'] ?? '0.5000',
      ],
    );
    return rows[0]!.id;
  }

  /** A pre-ledger (mixed-era) order row: quantity booked BEFORE the ledger. */
  async function seedLegacyOrder(options: {
    filledQuantity?: string;
    avgFillPrice?: string | null;
    providerDealId?: string | null;
    requestedQuantity?: string;
  }): Promise<string> {
    seedSeq += 1;
    const rows: Array<{ id: string }> = await dataSource.query(
      `INSERT INTO trading.orders
         (user_id, broker_connection_id, client_order_id, idempotency_key,
          order_kind, time_in_force, instrument, direction,
          requested_quantity, status, filled_quantity, avg_fill_price,
          provider_deal_id, submitted_at)
       VALUES ($1, $2, $3, gen_random_uuid()::text,
               'MARKET', 'IOC', 'EURUSD', 'BUY',
               $4, 'PARTIALLY_FILLED', $5, $6, $7, NOW())
       RETURNING id`,
      [
        userId,
        connectionId,
        `pg-spec-${seedSeq}-legacy`,
        options.requestedQuantity ?? '0.5000',
        options.filledQuantity ?? '0.2500',
        options.avgFillPrice === undefined ? '1.10000000' : options.avgFillPrice,
        options.providerDealId ?? 'deal-legacy',
      ],
    );
    return rows[0]!.id;
  }

  const ledgerCount = async (orderId: string): Promise<number> => {
    const rows: Array<{ count: string }> = await dataSource.query(
      `SELECT COUNT(*)::int AS count FROM trading.order_fill_evidence WHERE order_id = $1`,
      [orderId],
    );
    return Number(rows[0]!.count);
  };

  const orderRow = async (orderId: string) => {
    const rows: Array<Record<string, unknown>> = await dataSource.query(
      `SELECT filled_quantity, avg_fill_price, status, provider_deal_id
       FROM trading.orders WHERE id = $1`,
      [orderId],
    );
    return rows[0]!;
  };

  const ledgerRows = async (orderId: string) =>
    (await dataSource.query(
      `SELECT provider_deal_id, quantity::text AS quantity, price::text AS price, evidence_class
       FROM trading.order_fill_evidence WHERE order_id = $1 ORDER BY recorded_at, id`,
      [orderId],
    )) as Array<Record<string, unknown>>;

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST ?? '127.0.0.1',
      port: Number(process.env.DB_PORT ?? 5432),
      username: process.env.DB_USER ?? 'irexpro',
      password: process.env.DB_PASSWORD ?? 'test_password',
      database: process.env.DB_NAME ?? 'irexpro_test',
      entities: [Order],
      synchronize: false,
      logging: false,
    });
    await dataSource.initialize();

    // Apply the REAL migration chain to the empty schema — a live
    // compatibility rehearsal for 1795628400000 on top of 1795564800000 on
    // top of 1795220000000. (1753600000000 also ALTERs trading.trades — a
    // minimal trades table stands in for the legacy create; no production
    // data is involved.) The hardened FK target broker.broker_connections
    // is stood up minimally with the seeded connection row.
    await dataSource.query('CREATE SCHEMA IF NOT EXISTS trading');
    await dataSource.query('CREATE SCHEMA IF NOT EXISTS broker');
    await dataSource.query('DROP TABLE IF EXISTS trading.order_fill_evidence');
    await dataSource.query('DROP TABLE IF EXISTS trading.orders');
    await dataSource.query('DROP TABLE IF EXISTS trading.trades');
    await dataSource.query(
      'CREATE TABLE IF NOT EXISTS trading.trades (id uuid PRIMARY KEY DEFAULT gen_random_uuid())',
    );
    await dataSource.query(
      `CREATE TABLE IF NOT EXISTS broker.broker_connections (
         id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
         user_id uuid NOT NULL,
         broker_id varchar(50) NOT NULL,
         broker_name varchar(100) NOT NULL
       )`,
    );
    await dataSource.query(
      `INSERT INTO broker.broker_connections (id, user_id, broker_id, broker_name)
       VALUES ($1, $2, 'ctrader', 'pg-fixture-connection') ON CONFLICT DO NOTHING`,
      [connectionId, userId],
    );
    await new CreateNormalizedOrderDomain1753600000000().up(qr());
    await new AddOrderProviderNativeIdentifiers1795220000000().up(qr());
    await new CreateOrderFillEvidenceLedger1795564800000().up(qr());
    await new HardenOrderFillEvidenceLedger1795628400000().up(qr());

    orderRepo = dataSource.getRepository(Order);
    service = new OrderService(orderRepo, dataSource);
  });

  afterAll(async () => {
    // Leave the shared disposable database clean for the other pg suites:
    // the ledger table carries the hardening FKs (to broker.broker_connections
    // and to trading.orders) — dropping IT removes the dependency that would
    // block another suite's fixture drop (e.g. broker.broker_connections).
    if (dataSource?.isInitialized) {
      await dataSource.query('DROP TABLE IF EXISTS trading.order_fill_evidence');
      await dataSource.destroy();
    }
  });

  beforeEach(async () => {
    // The append-only ledger refuses TRUNCATE by default (statement trigger
    // of 1795628400000) — the disposable-fixture escape is the session GUC
    // set INSIDE this transaction (set_config(..., true) = SET LOCAL).
    await dataSource.transaction(async (manager) => {
      await manager.query("SELECT set_config('irexpro.allow_ledger_truncate', '1', true)");
      await manager.query('TRUNCATE TABLE trading.order_fill_evidence, trading.orders');
    });
  });

  it('closes the confirmed partial-fill replay defect (A 0.10, B 0.10, replayed A stays 0.20)', async () => {
    const orderId = await seedOrder({ requested_quantity: '0.5000' });

    const afterA = await service.applyFill(orderId, {
      quantity: '0.1000',
      price: '1.10000000',
      providerDealId: 'deal-A',
    });
    expect(afterA.filledQuantity).toBe('0.1000');
    expect(afterA.status).toBe(OrderStatus.PARTIALLY_FILLED);

    const afterB = await service.applyFill(orderId, {
      quantity: '0.1000',
      price: '1.20000000',
      providerDealId: 'deal-B',
    });
    expect(afterB.filledQuantity).toBe('0.2000');
    // The order-row pointer remembers only deal-B — the defect precondition.
    expect(afterB.providerDealId).toBe('deal-B');

    // Replay of fill A: detected via the immutable ledger, NOT the pointer.
    const replayed = await service.applyFill(orderId, {
      quantity: '0.1000',
      price: '1.10000000',
      providerDealId: 'deal-A',
    });
    expect(replayed.filledQuantity).toBe('0.2000');
    expect(replayed.status).toBe(OrderStatus.PARTIALLY_FILLED);

    // Real numeric arithmetic: VWAP of 0.10@1.10 + 0.10@1.20 = 1.15 exactly.
    const row = await orderRow(orderId);
    expect(String(row.filled_quantity)).toBe('0.2000');
    expect(String(row.avg_fill_price)).toBe('1.15000000');

    // The ledger retained BOTH historical identifiers — never three rows.
    const rows = await ledgerRows(orderId);
    expect(rows.map((r) => r.provider_deal_id)).toEqual(['deal-A', 'deal-B']);
    expect(rows.every((r) => r.evidence_class === 'PROVIDER_DEAL')).toBe(true);
    expect(String(rows[0]!.quantity)).toBe('0.1000');
  });

  it('concurrent duplicate delivery of the SAME deal books exactly once (row-lock serialization)', async () => {
    const orderId = await seedOrder({ requested_quantity: '0.5000' });

    const results = await Promise.allSettled([
      service.applyFill(orderId, {
        quantity: '0.1000',
        price: '1.10000000',
        providerDealId: 'deal-X',
      }),
      service.applyFill(orderId, {
        quantity: '0.1000',
        price: '1.10000000',
        providerDealId: 'deal-X',
      }),
    ]);

    // Both deliveries resolve (one books, one is an idempotent no-op) —
    // the total is booked exactly once.
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    const row = await orderRow(orderId);
    expect(String(row.filled_quantity)).toBe('0.1000');
    expect(await ledgerCount(orderId)).toBe(1);
  });

  it('refuses to credit one native deal to a second order row (fail-closed, no partial state)', async () => {
    const order1 = await seedOrder({ requested_quantity: '0.5000' });
    const order2 = await seedOrder({ requested_quantity: '0.5000' });

    await service.applyFill(order1, {
      quantity: '0.1000',
      price: '1.10000000',
      providerDealId: 'deal-Z',
    });
    await expect(
      service.applyFill(order2, {
        quantity: '0.1000',
        price: '1.10000000',
        providerDealId: 'deal-Z',
      }),
    ).rejects.toThrow(ConflictException);

    const row2 = await orderRow(order2);
    expect(String(row2.filled_quantity)).toBe('0.0000');
    expect(await ledgerCount(order2)).toBe(0);
    expect(await ledgerCount(order1)).toBe(1);
  });

  it('concurrent cross-order attribution of one deal yields exactly ONE winner', async () => {
    const order1 = await seedOrder({ requested_quantity: '0.5000' });
    const order2 = await seedOrder({ requested_quantity: '0.5000' });

    const results = await Promise.allSettled([
      service.applyFill(order1, {
        quantity: '0.1000',
        price: '1.10000000',
        providerDealId: 'deal-R',
      }),
      service.applyFill(order2, {
        quantity: '0.1000',
        price: '1.10000000',
        providerDealId: 'deal-R',
      }),
    ]);

    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual(['fulfilled', 'rejected']);
    const rejected = results.find((r) => r.status === 'rejected')!;
    expect(rejected.reason).toBeInstanceOf(ConflictException);

    const rows: Array<{ count: string }> = await dataSource.query(
      `SELECT COUNT(*)::int AS count FROM trading.order_fill_evidence WHERE provider_deal_id = 'deal-R'`,
    );
    expect(Number(rows[0]!.count)).toBe(1);

    const totals = await Promise.all([orderRow(order1), orderRow(order2)]);
    const sum = totals.reduce((acc, r) => acc + Number(r.filled_quantity), 0);
    expect(sum).toBe(0.1); // booked exactly once across both orders
  });

  it('a refused overfill leaves NO evidence row (transactional all-or-nothing)', async () => {
    const orderId = await seedOrder({ requested_quantity: '0.2000' });

    await service.applyFill(orderId, {
      quantity: '0.1500',
      price: '1.10000000',
      providerDealId: 'deal-1',
    });
    await expect(
      service.applyFill(orderId, {
        quantity: '0.1000',
        price: '1.20000000',
        providerDealId: 'deal-2',
      }),
    ).rejects.toThrow(/exceeds remaining quantity/);

    // The rolled-back transaction left no accounting event for deal-2.
    expect(await ledgerCount(orderId)).toBe(1);
    const row = await orderRow(orderId);
    expect(String(row.filled_quantity)).toBe('0.1500');
    expect(String(row.provider_deal_id)).toBe('deal-1');
  });

  it('records unidentified fills honestly (NULL deal, evidence class) and keeps the sum invariant', async () => {
    const orderId = await seedOrder({ requested_quantity: '0.5000' });

    await service.applyFill(orderId, {
      quantity: '0.1000',
      price: '1.10000000',
      providerPositionId: 'pos-77',
    });
    await service.applyFill(orderId, { quantity: '0.1234', price: '1.15000000' });

    const rows = await ledgerRows(orderId);
    expect(rows.map((r) => r.evidence_class)).toEqual(['POSITION_FACTS', 'PROVIDER_ORDER_STATE']);
    expect(rows.every((r) => r.provider_deal_id === null)).toBe(true);

    // Accounting invariant for a LEDGER-MANAGED (new) order:
    // orders.filled_quantity == SUM(ledger.quantity).
    const invariant: Array<{ filled: string; ledger_sum: string }> = await dataSource.query(
      `SELECT (SELECT filled_quantity FROM trading.orders WHERE id = $1)::text AS filled,
              (SELECT SUM(quantity) FROM trading.order_fill_evidence WHERE order_id = $1)::text AS ledger_sum`,
      [orderId],
    );
    expect(invariant[0]!.ledger_sum).toEqual(invariant[0]!.filled);
    // Exact decimal addition on real numeric columns: 0.1000 + 0.1234.
    expect(invariant[0]!.filled).toBe('0.2234');
  });

  it('keeps the pre-ledger (legacy pointer) population replay-protected', async () => {
    // A fill booked BEFORE the ledger existed: the order row carries the
    // latest-deal pointer but the ledger has no row for it.
    const orderId = await seedLegacyOrder({});

    const replayed = await service.applyFill(orderId, {
      quantity: '0.2500',
      price: '1.10000000',
      providerDealId: 'deal-legacy',
    });
    expect(replayed.filledQuantity).toBe('0.2500');
    expect(await ledgerCount(orderId)).toBe(0); // no new event — no double count
  });

  // ─── mixed-era accounting (review finding 1 + 5) ──────────────────────────

  it('mixed-era (finding 1): the legacy baseline is transcribed once and the retained pointer stays replay-protected AFTER the pointer moves to newer fills', async () => {
    const orderId = await seedLegacyOrder({
      filledQuantity: '0.2500',
      avgFillPrice: '1.10000000',
      providerDealId: 'deal-legacy',
      requestedQuantity: '0.5000',
    });

    // The FIRST ledger-era fill: the pre-ledger cumulative state is
    // transcribed into ONE LEGACY_BASELINE row in the same transaction.
    const after = await service.applyFill(orderId, {
      quantity: '0.1000',
      price: '1.20000000',
      providerDealId: 'deal-N',
    });
    expect(after.filledQuantity).toBe('0.3500');
    expect(after.providerDealId).toBe('deal-N'); // the pointer MOVED — the exact hole the review identified

    const rows = await ledgerRows(orderId);
    expect(rows.map((r) => [r.evidence_class, r.provider_deal_id, r.quantity, r.price])).toEqual([
      ['LEGACY_BASELINE', 'deal-legacy', '0.2500', '1.10000000'],
      ['PROVIDER_DEAL', 'deal-N', '0.1000', '1.20000000'],
    ]);

    // REPLAY of the pre-ledger latest deal AFTER the pointer moved: the
    // retained identifier lives on in the ledger (baseline row) →
    // identity-level no-op — closed on real PostgreSQL.
    const replayed = await service.applyFill(orderId, {
      quantity: '0.2500',
      price: '1.10000000',
      providerDealId: 'deal-legacy',
    });
    expect(replayed.filledQuantity).toBe('0.3500');
    expect(replayed.status).toBe(OrderStatus.PARTIALLY_FILLED);
    expect(await ledgerCount(orderId)).toBe(2); // baseline + one fill, never three rows

    // Invariant (finding 5) for a mixed-era order: the ledger sum equals
    // the order row exactly (baseline + ledger-era fills).
    const invariant: Array<{ filled: string; ledger_sum: string }> = await dataSource.query(
      `SELECT (SELECT filled_quantity FROM trading.orders WHERE id = $1)::text AS filled,
              (SELECT SUM(quantity) FROM trading.order_fill_evidence WHERE order_id = $1)::text AS ledger_sum`,
      [orderId],
    );
    expect(invariant[0]!.ledger_sum).toEqual(invariant[0]!.filled);
    expect(invariant[0]!.filled).toBe('0.3500');
  });

  it('untouched legacy order (finding 5): the ledger stays empty — it does NOT claim to establish the historical total', async () => {
    const orderId = await seedLegacyOrder({ filledQuantity: '0.2500' });
    // No replay, no new fill: the ledger is never back-filled for it.
    expect(await ledgerCount(orderId)).toBe(0);
    const row = await orderRow(orderId);
    expect(String(row.filled_quantity)).toBe('0.2500'); // history lives on the order row only
  });

  it('mixed-era pathological row (finding 1): the DB itself refuses quantity without avg price — the no-baseline case cannot arise', async () => {
    // The invariant "avg_fill_price present iff filled_quantity > 0" is
    // ENFORCED at the database level (chk_orders_fill_price_consistency):
    // the pathological row that would force a no-baseline transcription
    // (quantity without an average price) cannot exist on a real database.
    // The applyFill defensive branch (log + skip baseline) therefore guards
    // only a hypothetical future schema regression — never reachable here.
    await expect(
      seedLegacyOrder({
        filledQuantity: '0.2500',
        avgFillPrice: null,
        providerDealId: 'deal-legacy',
      }),
    ).rejects.toThrow(/chk_orders_fill_price_consistency/i);

    // Sanity: the complementary shape (avg price without quantity) is
    // equally refused — the DB keeps the invariant airtight from BOTH sides.
    await expect(
      seedOrder({ requested_quantity: '0.5000' }).then((id) =>
        dataSource.query(`UPDATE trading.orders SET avg_fill_price = 1.10000000 WHERE id = $1`, [
          id,
        ]),
      ),
    ).rejects.toThrow(/chk_orders_fill_price_consistency/i);
  });

  // ─── contradictory duplicate evidence (review finding 3) ─────────────────

  it('contradictory redelivery (finding 3): same deal id with a DIFFERENT quantity is refused with both facts stated', async () => {
    const orderId = await seedOrder({ requested_quantity: '0.5000' });
    await service.applyFill(orderId, {
      quantity: '0.1000',
      price: '1.10000000',
      providerDealId: 'deal-C',
    });

    await expect(
      service.applyFill(orderId, {
        quantity: '0.2000',
        price: '1.10000000',
        providerDealId: 'deal-C',
      }),
    ).rejects.toThrow(/Contradictory accounting evidence for provider deal deal-C/);

    // The booked evidence row stands immutable; nothing changed.
    expect(await ledgerCount(orderId)).toBe(1);
    const row = await orderRow(orderId);
    expect(String(row.filled_quantity)).toBe('0.1000');
  });

  it('contradictory redelivery (finding 3): a DIFFERENT price is refused; an EXACT redelivery stays idempotent', async () => {
    const orderId = await seedOrder({ requested_quantity: '0.5000' });
    await service.applyFill(orderId, {
      quantity: '0.1000',
      price: '1.10000000',
      providerDealId: 'deal-C',
    });

    await expect(
      service.applyFill(orderId, {
        quantity: '0.1000',
        price: '1.20000000',
        providerDealId: 'deal-C',
      }),
    ).rejects.toThrow(ConflictException);

    // Numerically identical (scale-insensitive) redelivery → no-op.
    const unchanged = await service.applyFill(orderId, {
      quantity: '0.1000',
      price: '1.10000000',
      providerDealId: 'deal-C',
    });
    expect(unchanged.filledQuantity).toBe('0.1000');
    expect(await ledgerCount(orderId)).toBe(1);
  });

  // ─── historical deal ownership (review finding 2) ─────────────────────────

  it('findDealOwner (finding 2): resolves from ledger evidence, legacy pointers, and reports ambiguity', async () => {
    const ledgerOwner = await seedOrder({ requested_quantity: '0.5000' });
    await service.applyFill(ledgerOwner, {
      quantity: '0.1000',
      price: '1.10000000',
      providerDealId: 'deal-O',
    });
    // A legacy order whose CURRENT pointer still carries another deal.
    await seedLegacyOrder({ providerDealId: 'deal-P' });

    // 1. Ledger evidence — after applyFill the order's OWN latest-deal
    //    pointer also carries the deal (the pointer agrees with the
    //    ledger), so BOTH sources legitimately report it, unambiguous.
    const fromLedger = await service.findDealOwner(connectionId, 'deal-O');
    expect(fromLedger.orderId).toBe(ledgerOwner);
    expect(fromLedger.ambiguous).toBe(false);
    expect(fromLedger.sources).toEqual(['LEDGER_EVIDENCE', 'ORDER_ROW_POINTER']);

    // 2. Legacy pointer only.
    const fromPointer = await service.findDealOwner(connectionId, 'deal-P');
    expect(fromPointer.ambiguous).toBe(false);
    expect(fromPointer.sources).toEqual(['ORDER_ROW_POINTER']);
    expect(fromPointer.orderId).not.toBeNull();

    // 3. Unknown deal.
    const unknown = await service.findDealOwner(connectionId, 'deal-unknown');
    expect(unknown.orderId).toBeNull();
    expect(unknown.ambiguous).toBe(false);
    expect(unknown.sources).toEqual([]);

    // 4. Ambiguity: the ledger attributes deal-Q to order A while a legacy
    //    order-row pointer carries deal-Q too — the assessment must expose
    //    both candidates instead of silently picking one. Constructed by
    //    DIRECT SQL (the legal append-only INSERT + a legacy pointer row):
    //    through applyFill the state is unreachable, because the orders
    //    pointer unique index uq_orders_provider_deal_id refuses a second
    //    order row carrying the same current deal pointer — the ambiguity
    //    branch guards residual/pre-hardening data states, which is exactly
    //    why it must report rather than guess.
    const ledgerOwnerQ = await seedOrder({ requested_quantity: '0.5000' });
    await dataSource.query(
      `INSERT INTO trading.order_fill_evidence
         (order_id, broker_connection_id, provider_deal_id, quantity, price, evidence_class)
       VALUES ($1, $2, 'deal-Q', 0.1000, 1.10000000, 'PROVIDER_DEAL')`,
      [ledgerOwnerQ, connectionId],
    );
    seedSeq += 1;
    const legacyQ: Array<{ id: string }> = await dataSource.query(
      `INSERT INTO trading.orders
         (user_id, broker_connection_id, client_order_id, idempotency_key,
          order_kind, time_in_force, instrument, direction,
          requested_quantity, status, filled_quantity, avg_fill_price,
          provider_deal_id, submitted_at)
       VALUES ($1, $2, $3, gen_random_uuid()::text,
               'MARKET', 'IOC', 'EURUSD', 'BUY',
               '0.5000', 'PARTIALLY_FILLED', '0.1000', '1.10000000',
               'deal-Q', NOW())
       RETURNING id`,
      [userId, connectionId, `pg-spec-${seedSeq}-legacyQ`],
    );
    const ambiguous = await service.findDealOwner(connectionId, 'deal-Q');
    expect(ambiguous.ambiguous).toBe(true);
    expect(ambiguous.orderId).toBeNull();
    expect(ambiguous.sources).toEqual(['LEDGER_EVIDENCE', 'ORDER_ROW_POINTER']);
    expect(ambiguous.candidateOrderIds.sort()).toEqual([ledgerOwnerQ, legacyQ[0]!.id].sort());
  });

  // ─── ledger integrity & evidence preservation (review finding 6) ──────────

  it('enforces append-only at the DATABASE level (trigger refuses UPDATE and DELETE)', async () => {
    const orderId = await seedOrder({ requested_quantity: '0.5000' });
    await service.applyFill(orderId, {
      quantity: '0.1000',
      price: '1.10000000',
      providerDealId: 'deal-U',
    });

    await expect(
      dataSource.query(
        `UPDATE trading.order_fill_evidence SET quantity = 999 WHERE order_id = $1`,
        [orderId],
      ),
    ).rejects.toThrow(/append-only/i);
    await expect(
      dataSource.query(`DELETE FROM trading.order_fill_evidence WHERE order_id = $1`, [orderId]),
    ).rejects.toThrow(/append-only/i);

    // The row survived both attempts.
    expect(await ledgerCount(orderId)).toBe(1);
  });

  it('refuses TRUNCATE by default; the operator/maintenance escape GUC is the only way through (finding 6)', async () => {
    const orderId = await seedOrder({ requested_quantity: '0.5000' });
    await service.applyFill(orderId, {
      quantity: '0.1000',
      price: '1.10000000',
      providerDealId: 'deal-T',
    });

    // Default: TRUNCATE is refused even though this session owns the table —
    // bulk discard of booked accounting history is never an accident.
    await expect(dataSource.query('TRUNCATE TABLE trading.order_fill_evidence')).rejects.toThrow(
      /TRUNCATE is forbidden/i,
    );
    expect(await ledgerCount(orderId)).toBe(1);

    // The escape is transaction-scoped (SET LOCAL semantics) and used by
    // disposable fixtures only — the beforeEach cleanup already proved it
    // works; here the refusal itself is the assertion of record.
  });

  it('refuses to delete an order that has booked fills (history preservation)', async () => {
    const orderId = await seedOrder({ requested_quantity: '0.5000' });
    await service.applyFill(orderId, {
      quantity: '0.1000',
      price: '1.10000000',
      providerDealId: 'deal-D',
    });

    await expect(
      dataSource.query(`DELETE FROM trading.orders WHERE id = $1`, [orderId]),
    ).rejects.toThrow(/order_fill_evidence/);
  });

  it('referential consistency (finding 6): a ledger row cannot reference another connection than its order, and booked evidence blocks deleting the broker connection', async () => {
    const orderId = await seedOrder({ requested_quantity: '0.5000' });
    await service.applyFill(orderId, {
      quantity: '0.1000',
      price: '1.10000000',
      providerDealId: 'deal-F',
    });

    // Direct attempts to write a mismatched (order_id, broker_connection_id)
    // pair are refused by the pair FK — the ledger can never attribute a
    // fill to a different connection than the order it books.
    const otherConnection = '33333333-3333-3333-3333-333333333333';
    await expect(
      dataSource.query(
        `INSERT INTO trading.order_fill_evidence
           (order_id, broker_connection_id, quantity, price, evidence_class)
         VALUES ($1, $2, 0.1000, 1.10000000, 'POSITION_FACTS')`,
        [orderId, otherConnection],
      ),
    ).rejects.toThrow(/fk_order_fill_evidence_order_connection|violates foreign key/i);

    // The connection itself cannot be deleted while booked evidence
    // references it (ON DELETE RESTRICT).
    await expect(
      dataSource.query(`DELETE FROM broker.broker_connections WHERE id = $1`, [connectionId]),
    ).rejects.toThrow(/order_fill_evidence|broker_connections/i);
  });

  it('populated downgrade refusal (finding 6): down() refuses while evidence exists; export-first preserves the accounting facts', async () => {
    const orderId = await seedOrder({ requested_quantity: '0.5000' });
    await service.applyFill(orderId, {
      quantity: '0.1000',
      price: '1.10000000',
      providerDealId: 'deal-E',
    });

    const hardening = new HardenOrderFillEvidenceLedger1795628400000();
    // The protective refusal: a populated ledger is booked accounting
    // history — a successful empty-schema downgrade proves nothing about it.
    await expect(hardening.down(qr())).rejects.toThrow(
      /still holds 1 booked accounting-evidence row/,
    );
    await expect(hardening.down(qr())).rejects.toThrow(/IREXPRO_DESTROY_LEDGER_EVIDENCE=1/);

    // The operator procedure from the runbook: EXPORT the evidence first
    // (attached to the change record) — then the conscious override.
    const exportRows = await ledgerRows(orderId);
    expect(exportRows.map((r) => [r.provider_deal_id, r.quantity])).toEqual([['deal-E', '0.1000']]);

    const previous = process.env.IREXPRO_DESTROY_LEDGER_EVIDENCE;
    process.env.IREXPRO_DESTROY_LEDGER_EVIDENCE = '1';
    try {
      await hardening.down(qr());
    } finally {
      if (previous === undefined) delete process.env.IREXPRO_DESTROY_LEDGER_EVIDENCE;
      else process.env.IREXPRO_DESTROY_LEDGER_EVIDENCE = previous;
    }

    // The table still exists (only the hardening was reverted); the export
    // retains the accounting facts even after the later full drop.
    expect(await ledgerCount(orderId)).toBe(1);
    const base = new CreateOrderFillEvidenceLedger1795564800000();
    await base.down(qr());
    const ledgerGone = await dataSource.query(
      `SELECT EXISTS (SELECT 1 FROM information_schema.tables
                      WHERE table_schema = 'trading' AND table_name = 'order_fill_evidence') AS present`,
    );
    expect(ledgerGone[0]!.present).toBe(false);
    // The order row survives either way; the EXPORT preserves the booked
    // economics that the drop destroys in-database.
    const row = await orderRow(orderId);
    expect(String(row.filled_quantity)).toBe('0.1000');

    // Re-up the full chain and keep booking. NOTE: the order row still
    // says filled 0.1000 while the recreated ledger is empty — a MIXED-ERA
    // state by construction — so the first new fill transcribes a fresh
    // LEGACY_BASELINE row (honest capture of the surviving order-row state).
    await base.up(qr());
    await hardening.up(qr());
    const after = await service.applyFill(orderId, {
      quantity: '0.1000',
      price: '1.20000000',
      providerDealId: 'deal-E2',
    });
    expect(after.filledQuantity).toBe('0.2000');
    const rowsAfter = await ledgerRows(orderId);
    expect(rowsAfter.map((r) => r.evidence_class)).toEqual(['LEGACY_BASELINE', 'PROVIDER_DEAL']);
    expect(rowsAfter.map((r) => r.quantity)).toEqual(['0.1000', '0.1000']);
    // The export (above) still preserves the ORIGINAL booked fact that the
    // drop destroyed in-database: deal-E @ 0.1000/1.10000000.
  });

  it('migration rollback rehearsal (empty ledger): down() drops cleanly newest-first, up() recreates idempotently', async () => {
    const orderId = await seedOrder({ requested_quantity: '0.5000' });

    // EMPTY ledger: the hardening down() proceeds (protective refusal is
    // scoped to POPULATED history) — newest-first revert order.
    const hardening = new HardenOrderFillEvidenceLedger1795628400000();
    await hardening.down(qr());
    const base = new CreateOrderFillEvidenceLedger1795564800000();
    await base.down(qr());

    const ledgerGone = await dataSource.query(
      `SELECT EXISTS (SELECT 1 FROM information_schema.tables
                      WHERE table_schema = 'trading' AND table_name = 'order_fill_evidence') AS present`,
    );
    expect(ledgerGone[0]!.present).toBe(false);
    const row = await orderRow(orderId);
    expect(String(row.filled_quantity)).toBe('0.0000'); // order state preserved

    // up() again — re-runnable (IF NOT EXISTS), the schema is whole, and
    // the service keeps booking on the re-created ledger.
    await base.up(qr());
    await hardening.up(qr());
    expect(await ledgerCount(orderId)).toBe(0); // history honestly absent after rollback
    const after = await service.applyFill(orderId, {
      quantity: '0.1000',
      price: '1.20000000',
      providerDealId: 'deal-M2',
    });
    expect(after.filledQuantity).toBe('0.1000');
    expect(await ledgerCount(orderId)).toBe(1);
  });
});
