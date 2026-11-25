import { ConflictException } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import type { QueryRunner } from 'typeorm';
import { Order } from './order.entity';
import { OrderService } from './order.service';
import { OrderStatus } from './order.enums';
import { CreateNormalizedOrderDomain1753600000000 } from '../../../database/migrations/1753600000000-CreateNormalizedOrderDomain';
import { AddOrderProviderNativeIdentifiers1795220000000 } from '../../../database/migrations/1795220000000-AddOrderProviderNativeIdentifiers';
import { CreateOrderFillEvidenceLedger1795564800000 } from '../../../database/migrations/1795564800000-CreateOrderFillEvidenceLedger';

/**
 * Accounting-integrity correction 2026-11-25 — real-PostgreSQL proof for the
 * immutable per-fill accounting evidence ledger.
 *
 * Isolated database ONLY (never production): the spec boots its own
 * DataSource, applies the REAL migration chain
 * (1753600000000 → 1795220000000 → 1795564800000) to an empty trading
 * schema, and runs the REAL OrderService against it.
 *
 * Proves on a real database:
 *   1. The confirmed partial-fill replay defect is closed (A + B + replayed
 *      A stays 0.20, exact numeric arithmetic and VWAP included).
 *   2. Concurrent duplicate delivery of the same deal is idempotent.
 *   3. Cross-order and concurrent cross-order deal attribution fail closed.
 *   4. A refused (overfill) fill leaves NO evidence row — transactional
 *      all-or-nothing.
 *   5. Unidentified (NULL deal) fills are recorded honestly with their
 *      evidence class; orders.filled_quantity == SUM(ledger.quantity).
 *   6. The ledger is append-only at the DATABASE level (trigger) and
 *      order deletion is refused while evidence exists (ON DELETE RESTRICT).
 *   7. Migration down()/up() rollback rehearsal on the live isolated DB.
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
    // compatibility rehearsal for 1795564800000 on top of 1795220000000.
    // (1753600000000 also ALTERs trading.trades — a minimal trades table
    // stands in for the legacy create; no production data is involved.)
    await dataSource.query('CREATE SCHEMA IF NOT EXISTS trading');
    await dataSource.query('DROP TABLE IF EXISTS trading.order_fill_evidence');
    await dataSource.query('DROP TABLE IF EXISTS trading.orders');
    await dataSource.query('DROP TABLE IF EXISTS trading.trades');
    await dataSource.query(
      'CREATE TABLE IF NOT EXISTS trading.trades (id uuid PRIMARY KEY DEFAULT gen_random_uuid())',
    );
    await new CreateNormalizedOrderDomain1753600000000().up(qr());
    await new AddOrderProviderNativeIdentifiers1795220000000().up(qr());
    await new CreateOrderFillEvidenceLedger1795564800000().up(qr());

    orderRepo = dataSource.getRepository(Order);
    service = new OrderService(orderRepo, dataSource);
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.query('TRUNCATE trading.order_fill_evidence, trading.orders');
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
    const ledgerRows: Array<Record<string, unknown>> = await dataSource.query(
      `SELECT provider_deal_id, quantity, price, evidence_class
       FROM trading.order_fill_evidence WHERE order_id = $1 ORDER BY recorded_at, id`,
      [orderId],
    );
    expect(ledgerRows.map((r) => r.provider_deal_id)).toEqual(['deal-A', 'deal-B']);
    expect(ledgerRows.every((r) => r.evidence_class === 'PROVIDER_DEAL')).toBe(true);
    expect(String(ledgerRows[0]!.quantity)).toBe('0.1000');
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

    const ledgerRows: Array<Record<string, unknown>> = await dataSource.query(
      `SELECT provider_deal_id, quantity, evidence_class
       FROM trading.order_fill_evidence WHERE order_id = $1 ORDER BY recorded_at, id`,
      [orderId],
    );
    expect(ledgerRows.map((r) => r.evidence_class)).toEqual([
      'POSITION_FACTS',
      'PROVIDER_ORDER_STATE',
    ]);
    expect(ledgerRows.every((r) => r.provider_deal_id === null)).toBe(true);

    // Accounting invariant: orders.filled_quantity == SUM(ledger.quantity).
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
    seedSeq += 1;
    const legacy: Array<{ id: string }> = await dataSource.query(
      `INSERT INTO trading.orders
         (user_id, broker_connection_id, client_order_id, idempotency_key,
          order_kind, time_in_force, instrument, direction,
          requested_quantity, status, filled_quantity, avg_fill_price,
          provider_deal_id, submitted_at)
       VALUES ($1, $2, $3, gen_random_uuid()::text,
               'MARKET', 'IOC', 'EURUSD', 'BUY',
               '0.5000', 'PARTIALLY_FILLED', '0.2500', '1.10000000',
               'deal-legacy', NOW())
       RETURNING id`,
      [userId, connectionId, `pg-spec-${seedSeq}-legacy`],
    );
    const orderId = legacy[0]!.id;

    const replayed = await service.applyFill(orderId, {
      quantity: '0.2500',
      price: '1.10000000',
      providerDealId: 'deal-legacy',
    });
    expect(replayed.filledQuantity).toBe('0.2500');
    expect(await ledgerCount(orderId)).toBe(0); // no new event — no double count
  });

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

  it('migration rollback rehearsal: down() drops the ledger cleanly, up() recreates it', async () => {
    const orderId = await seedOrder({ requested_quantity: '0.5000' });
    await service.applyFill(orderId, {
      quantity: '0.1000',
      price: '1.10000000',
      providerDealId: 'deal-M',
    });

    // down(): trigger → function → table; orders rows untouched.
    const migration = new CreateOrderFillEvidenceLedger1795564800000();
    await migration.down(qr());

    const ledgerGone = await dataSource.query(
      `SELECT EXISTS (SELECT 1 FROM information_schema.tables
                      WHERE table_schema = 'trading' AND table_name = 'order_fill_evidence') AS present`,
    );
    expect(ledgerGone[0]!.present).toBe(false);
    const row = await orderRow(orderId);
    expect(String(row.filled_quantity)).toBe('0.1000'); // order state preserved

    // up() again — re-runnable (IF NOT EXISTS), the schema is whole.
    await migration.up(qr());
    expect(await ledgerCount(orderId)).toBe(0); // history honestly absent after rollback
    // And the service keeps booking on the re-created ledger.
    const after = await service.applyFill(orderId, {
      quantity: '0.1000',
      price: '1.20000000',
      providerDealId: 'deal-M2',
    });
    expect(after.filledQuantity).toBe('0.2000');
    expect(await ledgerCount(orderId)).toBe(1);
  });
});
