import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { QueryRunner } from 'typeorm';
import { Repository } from 'typeorm';
import { Order } from '../src/modules/execution/orders/order.entity';
import { OrderService } from '../src/modules/execution/orders/order.service';
import { CreateNormalizedOrderDomain1753600000000 } from '../src/database/migrations/1753600000000-CreateNormalizedOrderDomain';
import { AddOrderProviderNativeIdentifiers1795220000000 } from '../src/database/migrations/1795220000000-AddOrderProviderNativeIdentifiers';
import { CreateOrderFillEvidenceLedger1795564800000 } from '../src/database/migrations/1795564800000-CreateOrderFillEvidenceLedger';

/**
 * Isolated rehearsal of migration 1795564800000 (CreateOrderFillEvidenceLedger).
 *
 * NOT run against any production database: the rehearsal target is a
 * disposable local PostgreSQL cluster (REHEARSAL_PG_HOST, default the
 * pgserver socket directory /home/z/pgdata-ledger). Verifies:
 *   1. Existing trading.orders rows (incl. the pre-ledger provider_deal_id
 *      pointer population) survive up() byte-identically.
 *   2. The partial unique index refuses crediting one native deal twice,
 *      while NULL deal ids remain unbounded.
 *   3. The evidence-class parity CHECK fails closed both directions.
 *   4. The append-only trigger refuses UPDATE and DELETE.
 *   5. ON DELETE RESTRICT keeps order history while evidence exists.
 *   6. The REAL OrderService closes the confirmed partial-fill replay
 *      defect on real PostgreSQL (A + B + replayed A stays 0.2000).
 *   7. Concurrent duplicate delivery books exactly once; concurrent
 *      cross-order attribution yields exactly one winner.
 *   8. down() drops the ledger cleanly with orders intact, and up() is
 *      idempotent on re-run.
 */

const SOCKET_DIR = process.env.REHEARSAL_PG_HOST ?? '/home/z/pgdata-ledger';
const PORT = Number(process.env.REHEARSAL_PG_PORT ?? 5432);
const USER = process.env.REHEARSAL_PG_USER ?? 'postgres';
const DATABASE = process.env.REHEARSAL_PG_DATABASE ?? 'postgres';

const results: Array<{ check: string; pass: boolean; detail: string }> = [];
function record(check: string, pass: boolean, detail = ''): void {
  results.push({ check, pass, detail });
  // eslint-disable-next-line no-console
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${check}${detail ? ' — ' + detail : ''}`);
}

async function main(): Promise<void> {
  const dataSource = new DataSource({
    type: 'postgres',
    host: SOCKET_DIR,
    port: PORT,
    username: USER,
    database: DATABASE,
    entities: [Order],
    synchronize: false,
    logging: false,
  });
  await dataSource.initialize();
  const qr = {
    query: (sql: string, params?: unknown[]) => dataSource.query(sql, params),
  } as QueryRunner;

  // ── Fresh isolated schema with the REAL migration chain ──────────────────
  await dataSource.query('CREATE SCHEMA IF NOT EXISTS trading');
  await dataSource.query('DROP TABLE IF EXISTS trading.order_fill_evidence');
  await dataSource.query('DROP TABLE IF EXISTS trading.orders');
  await dataSource.query('DROP TABLE IF EXISTS trading.trades');
  await dataSource.query(
    'CREATE TABLE IF NOT EXISTS trading.trades (id uuid PRIMARY KEY DEFAULT gen_random_uuid())',
  );

  // ── 1. Existing order rows survive up() ───────────────────────────────────
  await new CreateNormalizedOrderDomain1753600000000().up(qr);
  await new AddOrderProviderNativeIdentifiers1795220000000().up(qr);
  await dataSource.query(
    `INSERT INTO trading.orders
       (user_id, broker_connection_id, client_order_id, idempotency_key,
        order_kind, time_in_force, instrument, direction,
        requested_quantity, status, filled_quantity, avg_fill_price,
        provider_deal_id, submitted_at)
     VALUES ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
             'rehearsal-legacy-1', gen_random_uuid()::text,
             'MARKET', 'IOC', 'EURUSD', 'BUY',
             '0.5000', 'PARTIALLY_FILLED', '0.2500', '1.10000000',
             'deal-legacy-1', NOW())`,
  );
  const before = await dataSource.query(
    `SELECT id::text, filled_quantity::text, avg_fill_price::text, provider_deal_id,
            status, client_order_id FROM trading.orders`,
  );

  await new CreateOrderFillEvidenceLedger1795564800000().up(qr);
  const after = await dataSource.query(
    `SELECT id::text, filled_quantity::text, avg_fill_price::text, provider_deal_id,
            status, client_order_id FROM trading.orders`,
  );
  record(
    'existing orders rows survive up() byte-identically',
    JSON.stringify(before) === JSON.stringify(after),
  );

  // ── 2. Partial unique index: one deal, one fill; NULLs unbounded ─────────
  const orderId = (before[0] as { id: string }).id;
  const connectionId = '22222222-2222-2222-2222-222222222222';
  await dataSource.query(
    `INSERT INTO trading.order_fill_evidence
       (order_id, broker_connection_id, provider_deal_id, quantity, price, evidence_class)
     VALUES ($1, $2, 'deal-uniq-1', 0.1, 1.1, 'PROVIDER_DEAL')`,
    [orderId, connectionId],
  );
  let dupRefused = false;
  try {
    await dataSource.query(
      `INSERT INTO trading.order_fill_evidence
         (order_id, broker_connection_id, provider_deal_id, quantity, price, evidence_class)
       VALUES ($1, $2, 'deal-uniq-1', 0.1, 1.1, 'PROVIDER_DEAL')`,
      [orderId, connectionId],
    );
  } catch (err) {
    dupRefused = (err as Error).message.includes('duplicate key value');
  }
  record('duplicate native deal INSERT is refused (23505)', dupRefused);

  await dataSource.query(
    `INSERT INTO trading.order_fill_evidence
       (order_id, broker_connection_id, provider_deal_id, quantity, price, evidence_class)
     VALUES ($1, $2, NULL, 0.1, 1.1, 'POSITION_FACTS'),
            ($1, $2, NULL, 0.1, 1.1, 'PROVIDER_ORDER_STATE')`,
    [orderId, connectionId],
  );
  const nullCount = await dataSource.query(
    `SELECT COUNT(*)::int AS c FROM trading.order_fill_evidence WHERE provider_deal_id IS NULL`,
  );
  record(
    'multiple NULL-deal rows allowed (incomplete evidence recorded, not deduped)',
    (nullCount[0] as { c: number }).c === 2,
  );

  // ── 3. Evidence-class parity CHECK fails closed both directions ──────────
  let parityNullRefused = false;
  try {
    await dataSource.query(
      `INSERT INTO trading.order_fill_evidence
         (order_id, broker_connection_id, provider_deal_id, quantity, price, evidence_class)
       VALUES ($1, $2, NULL, 0.1, 1.1, 'PROVIDER_DEAL')`,
      [orderId, connectionId],
    );
  } catch (err) {
    parityNullRefused = (err as Error).message.includes('ck_order_fill_evidence_class_consistent');
  }
  record('PROVIDER_DEAL with a NULL deal id is refused', parityNullRefused);

  let parityDealRefused = false;
  try {
    await dataSource.query(
      `INSERT INTO trading.order_fill_evidence
         (order_id, broker_connection_id, provider_deal_id, quantity, price, evidence_class)
       VALUES ($1, $2, 'deal-parity-1', 0.1, 1.1, 'POSITION_FACTS')`,
      [orderId, connectionId],
    );
  } catch (err) {
    parityDealRefused = (err as Error).message.includes('ck_order_fill_evidence_class_consistent');
  }
  record('a non-PROVIDER_DEAL class carrying a deal id is refused', parityDealRefused);

  // ── 4. Append-only trigger refuses UPDATE and DELETE ─────────────────────
  let updateRefused = false;
  try {
    await dataSource.query(`UPDATE trading.order_fill_evidence SET quantity = 999`);
  } catch (err) {
    updateRefused = /append-only/i.test((err as Error).message);
  }
  record('ledger UPDATE is refused by the trigger', updateRefused);

  let deleteRefused = false;
  try {
    await dataSource.query(`DELETE FROM trading.order_fill_evidence`);
  } catch (err) {
    deleteRefused = /append-only/i.test((err as Error).message);
  }
  record('ledger DELETE is refused by the trigger', deleteRefused);

  // ── 5. ON DELETE RESTRICT ─────────────────────────────────────────────────
  let orderDeleteRefused = false;
  try {
    await dataSource.query(`DELETE FROM trading.orders WHERE id = $1`, [orderId]);
  } catch (err) {
    orderDeleteRefused = (err as Error).message.includes('order_fill_evidence');
  }
  record('order deletion is refused while fill evidence exists', orderDeleteRefused);

  // ── 6. Real OrderService — the confirmed defect, closed on real PG ───────
  await dataSource.query('TRUNCATE trading.order_fill_evidence, trading.orders');
  const orderRepo: Repository<Order> = dataSource.getRepository(Order);
  const service = new OrderService(orderRepo, dataSource);

  const seedOrder = async (requested: string): Promise<string> => {
    const rows = await dataSource.query(
      `INSERT INTO trading.orders
         (user_id, broker_connection_id, client_order_id, idempotency_key,
          order_kind, time_in_force, instrument, direction,
          requested_quantity, status, filled_quantity, submitted_at)
       VALUES ($1, $2, gen_random_uuid()::text, gen_random_uuid()::text,
               'MARKET', 'IOC', 'EURUSD', 'BUY', $3, 'ACKNOWLEDGED', 0, NOW())
       RETURNING id::text`,
      ['11111111-1111-1111-1111-111111111111', connectionId, requested],
    );
    return (rows[0] as { id: string }).id;
  };

  const defectOrder = await seedOrder('0.5000');
  await service.applyFill(defectOrder, {
    quantity: '0.1000',
    price: '1.10000000',
    providerDealId: 'fill-A',
  });
  await service.applyFill(defectOrder, {
    quantity: '0.1000',
    price: '1.20000000',
    providerDealId: 'fill-B',
  });
  const replayed = await service.applyFill(defectOrder, {
    quantity: '0.1000',
    price: '1.10000000',
    providerDealId: 'fill-A',
  });
  const defectRow = await dataSource.query(
    `SELECT filled_quantity::text AS filled, avg_fill_price::text AS avg FROM trading.orders WHERE id = $1`,
    [defectOrder],
  );
  const defectLedger = await dataSource.query(
    `SELECT COUNT(*)::int AS c FROM trading.order_fill_evidence WHERE order_id = $1`,
    [defectOrder],
  );
  record(
    'confirmed defect closed: A + B + replayed A = 0.2000 (VWAP 1.15000000), 2 evidence rows',
    (defectRow[0] as { filled: string }).filled === '0.2000' &&
      (defectRow[0] as { avg: string }).avg === '1.15000000' &&
      (defectLedger[0] as { c: number }).c === 2 &&
      replayed.filledQuantity === '0.2000',
  );

  // ── 7. Concurrency: same-order duplicate and cross-order race ────────────
  const dupOrder = await seedOrder('0.5000');
  const dupResults = await Promise.allSettled([
    service.applyFill(dupOrder, {
      quantity: '0.1000',
      price: '1.10000000',
      providerDealId: 'dup-1',
    }),
    service.applyFill(dupOrder, {
      quantity: '0.1000',
      price: '1.10000000',
      providerDealId: 'dup-1',
    }),
  ]);
  const dupRow = await dataSource.query(
    `SELECT filled_quantity::text AS filled FROM trading.orders WHERE id = $1`,
    [dupOrder],
  );
  record(
    'concurrent duplicate delivery books exactly once (0.1000, 1 row, no rejected promise)',
    (dupRow[0] as { filled: string }).filled === '0.1000' &&
      dupResults.every((r) => r.status === 'fulfilled'),
  );

  const raceA = await seedOrder('0.5000');
  const raceB = await seedOrder('0.5000');
  const raceResults = await Promise.allSettled([
    service.applyFill(raceA, { quantity: '0.1000', price: '1.10000000', providerDealId: 'race-1' }),
    service.applyFill(raceB, { quantity: '0.1000', price: '1.10000000', providerDealId: 'race-1' }),
  ]);
  const raceTotals = await dataSource.query(
    `SELECT (SELECT filled_quantity FROM trading.orders WHERE id = $1)
          + (SELECT filled_quantity FROM trading.orders WHERE id = $2) AS total`,
    [raceA, raceB],
  );
  record(
    'concurrent cross-order attribution yields exactly one winner (total 0.1000, one rejected)',
    Number((raceTotals[0] as { total: string }).total) === 0.1 &&
      raceResults.filter((r) => r.status === 'rejected').length === 1,
  );

  // ── 8. down()/up() rollback rehearsal with orders intact ────────────────
  const migration = new CreateOrderFillEvidenceLedger1795564800000();
  const ordersBeforeDown = await dataSource.query(`SELECT COUNT(*)::int AS c FROM trading.orders`);
  await migration.down(qr);
  const tableGone = await dataSource.query(
    `SELECT EXISTS (SELECT 1 FROM information_schema.tables
                    WHERE table_schema = 'trading' AND table_name = 'order_fill_evidence') AS present`,
  );
  const ordersAfterDown = await dataSource.query(`SELECT COUNT(*)::int AS c FROM trading.orders`);
  record(
    'down() drops the ledger cleanly and leaves orders untouched',
    (tableGone[0] as { present: boolean }).present === false &&
      (ordersBeforeDown[0] as { c: number }).c === (ordersAfterDown[0] as { c: number }).c,
  );

  await migration.up(qr); // idempotent re-run
  const back = await dataSource.query(
    `SELECT EXISTS (SELECT 1 FROM information_schema.tables
                    WHERE table_schema = 'trading' AND table_name = 'order_fill_evidence') AS present`,
  );
  const postUp = await service.applyFill(defectOrder, {
    quantity: '0.1000',
    price: '1.30000000',
    providerDealId: 'fill-C',
  });
  record(
    'up() re-runs idempotently and the service books on the re-created ledger',
    (back[0] as { present: boolean }).present === true && postUp.filledQuantity === '0.3000',
  );

  const failures = results.filter((r) => !r.pass);
  // eslint-disable-next-line no-console
  console.log(`\n${results.length - failures.length}/${results.length} checks passed`);
  await dataSource.destroy();
  if (failures.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('REHEARSAL ERROR:', err);
  process.exitCode = 1;
});
