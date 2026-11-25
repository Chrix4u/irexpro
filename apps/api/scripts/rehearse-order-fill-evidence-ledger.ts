import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { QueryRunner } from 'typeorm';
import { Repository } from 'typeorm';
import { Order } from '../src/modules/execution/orders/order.entity';
import { OrderService } from '../src/modules/execution/orders/order.service';
import { CreateNormalizedOrderDomain1753600000000 } from '../src/database/migrations/1753600000000-CreateNormalizedOrderDomain';
import { AddOrderProviderNativeIdentifiers1795220000000 } from '../src/database/migrations/1795220000000-AddOrderProviderNativeIdentifiers';
import { CreateOrderFillEvidenceLedger1795564800000 } from '../src/database/migrations/1795564800000-CreateOrderFillEvidenceLedger';
import { HardenOrderFillEvidenceLedger1795628400000 } from '../src/database/migrations/1795628400000-HardenOrderFillEvidenceLedger';

/**
 * Isolated rehearsal of migrations 1795564800000 (CreateOrderFillEvidenceLedger)
 * and 1795628400000 (HardenOrderFillEvidenceLedger — independent-review
 * findings 1/3/5/6 of PR #805).
 *
 * NOT run against any production database: the rehearsal target is a
 * disposable local PostgreSQL cluster (REHEARSAL_PG_HOST, default the
 * pgserver socket directory /home/z/pgdata-ledger). Verifies:
 *   1. Existing trading.orders rows (incl. the pre-ledger provider_deal_id
 *      pointer population) survive up() byte-identically.
 *   2. The partial unique index refuses crediting one native deal twice,
 *      while NULL deal ids remain unbounded.
 *   3. The evidence-class parity CHECK fails closed both directions
 *      (hardened: LEGACY_BASELINE may carry the retained legacy pointer).
 *   4. The append-only row trigger refuses UPDATE and DELETE; the
 *      statement trigger refuses TRUNCATE with the operator escape GUC.
 *   5. ON DELETE RESTRICT keeps order history while evidence exists; the
 *      pair FK binds each row to the order's exact broker connection.
 *   6. The REAL OrderService closes the confirmed partial-fill replay
 *      defect on real PostgreSQL (A + B + replayed A stays 0.2000).
 *   7. Concurrent duplicate delivery books exactly once; concurrent
 *      cross-order attribution yields exactly one winner.
 *   8. Mixed-era accounting (finding 1): the legacy baseline is transcribed
 *      once and the retained pointer stays replay-protected AFTER newer
 *      fills move the order-row pointer.
 *   9. Contradictory evidence (finding 3): a redelivery with different
 *      quantity/price is refused; the identical redelivery is a no-op.
 *  10. findDealOwner (finding 2): ledger evidence, legacy pointers, and
 *      explicit ambiguity reporting.
 *  11. Rollback (finding 6): down() refuses while the ledger is populated;
 *      export-first preserves the accounting facts; the forced downgrade
 *      drops newest-first with orders intact; up() re-runs idempotently.
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

/** The disposable-fixture TRUNCATE escape (SET LOCAL inside a transaction). */
async function truncateFixtureTables(db: DataSource): Promise<void> {
  await db.transaction(async (manager) => {
    await manager.query("SELECT set_config('irexpro.allow_ledger_truncate', '1', true)");
    await manager.query('TRUNCATE TABLE trading.order_fill_evidence, trading.orders');
  });
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
  await dataSource.query('CREATE SCHEMA IF NOT EXISTS broker');
  await dataSource.query('DROP TABLE IF EXISTS trading.order_fill_evidence');
  await dataSource.query('DROP TABLE IF EXISTS trading.orders');
  await dataSource.query('DROP TABLE IF EXISTS trading.trades');
  await dataSource.query('DROP TABLE IF EXISTS broker.broker_connections');
  await dataSource.query(
    'CREATE TABLE IF NOT EXISTS trading.trades (id uuid PRIMARY KEY DEFAULT gen_random_uuid())',
  );
  // Minimal FK target for the hardened broker-connection FK (finding 6).
  await dataSource.query(
    'CREATE TABLE IF NOT EXISTS broker.broker_connections (id uuid PRIMARY KEY DEFAULT gen_random_uuid())',
  );

  // ── 1. Existing order rows survive up() ───────────────────────────────────
  await new CreateNormalizedOrderDomain1753600000000().up(qr);
  await new AddOrderProviderNativeIdentifiers1795220000000().up(qr);
  const connectionId = '22222222-2222-2222-2222-222222222222';
  await dataSource.query(
    `INSERT INTO broker.broker_connections (id) VALUES ($1) ON CONFLICT DO NOTHING`,
    [connectionId],
  );
  await dataSource.query(
    `INSERT INTO trading.orders
       (user_id, broker_connection_id, client_order_id, idempotency_key,
        order_kind, time_in_force, instrument, direction,
        requested_quantity, status, filled_quantity, avg_fill_price,
        provider_deal_id, submitted_at)
     VALUES ('11111111-1111-1111-1111-111111111111', $1,
             'rehearsal-legacy-1', gen_random_uuid()::text,
             'MARKET', 'IOC', 'EURUSD', 'BUY',
             '0.5000', 'PARTIALLY_FILLED', '0.2500', '1.10000000',
             'deal-legacy-1', NOW())`,
    [connectionId],
  );
  const before = await dataSource.query(
    `SELECT id::text, filled_quantity::text, avg_fill_price::text, provider_deal_id,
            status, client_order_id FROM trading.orders`,
  );

  await new CreateOrderFillEvidenceLedger1795564800000().up(qr);
  await new HardenOrderFillEvidenceLedger1795628400000().up(qr);
  const after = await dataSource.query(
    `SELECT id::text, filled_quantity::text, avg_fill_price::text, provider_deal_id,
            status, client_order_id FROM trading.orders`,
  );
  record(
    'existing orders rows survive up() byte-identically (both migrations)',
    JSON.stringify(before) === JSON.stringify(after),
  );

  // ── 2. Partial unique index: one deal, one fill; NULLs unbounded ─────────
  const orderId = (before[0] as { id: string }).id;
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
  record(
    'a non-PROVIDER_DEAL/non-LEGACY_BASELINE class carrying a deal id is refused',
    parityDealRefused,
  );

  // LEGACY_BASELINE may carry the retained legacy pointer (hardened parity).
  await dataSource.query(
    `INSERT INTO trading.order_fill_evidence
       (order_id, broker_connection_id, provider_deal_id, quantity, price, evidence_class)
     VALUES ($1, $2, 'deal-baseline-pointer', 0.25, 1.1, 'LEGACY_BASELINE')`,
    [orderId, connectionId],
  );
  const baselinePtr = await dataSource.query(
    `SELECT COUNT(*)::int AS c FROM trading.order_fill_evidence
      WHERE evidence_class = 'LEGACY_BASELINE' AND provider_deal_id = 'deal-baseline-pointer'`,
  );
  record(
    'LEGACY_BASELINE may carry the retained legacy pointer (transcription, not fabrication)',
    (baselinePtr[0] as { c: number }).c === 1,
  );

  // ── 4. Append-only: UPDATE/DELETE rows, TRUNCATE statements ──────────────
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

  let truncateRefused = false;
  try {
    await dataSource.query(`TRUNCATE TABLE trading.order_fill_evidence`);
  } catch (err) {
    truncateRefused = /TRUNCATE is forbidden/i.test((err as Error).message);
  }
  record('ledger TRUNCATE is refused by the statement trigger (finding 6)', truncateRefused);

  // ── 5. Referential integrity: pair FK + RESTRICT ─────────────────────────
  let pairFkRefused = false;
  try {
    await dataSource.query(
      `INSERT INTO trading.order_fill_evidence
         (order_id, broker_connection_id, quantity, price, evidence_class)
       VALUES ($1, $2, 0.1, 1.1, 'POSITION_FACTS')`,
      [orderId, '33333333-3333-3333-3333-333333333333'],
    );
  } catch (err) {
    pairFkRefused = (err as Error).message.includes('fk_order_fill_evidence_order_connection');
  }
  record(
    'a ledger row cannot carry another broker connection than its order (pair FK, finding 6)',
    pairFkRefused,
  );

  let orderDeleteRefused = false;
  try {
    await dataSource.query(`DELETE FROM trading.orders WHERE id = $1`, [orderId]);
  } catch (err) {
    orderDeleteRefused = (err as Error).message.includes('order_fill_evidence');
  }
  record('order deletion is refused while fill evidence exists', orderDeleteRefused);

  // ── 6. Real OrderService — the confirmed defect, closed on real PG ───────
  await truncateFixtureTables(dataSource);
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

  // ── 8. Mixed-era accounting (finding 1) ──────────────────────────────────
  await truncateFixtureTables(dataSource);
  const legacyRows = await dataSource.query(
    `INSERT INTO trading.orders
       (user_id, broker_connection_id, client_order_id, idempotency_key,
        order_kind, time_in_force, instrument, direction,
        requested_quantity, status, filled_quantity, avg_fill_price,
        provider_deal_id, submitted_at)
     VALUES ($1, $2, 'rehearsal-mixed-1', gen_random_uuid()::text,
             'MARKET', 'IOC', 'EURUSD', 'BUY',
             '0.5000', 'PARTIALLY_FILLED', '0.2500', '1.10000000',
             'deal-legacy-M', NOW())
     RETURNING id::text`,
    ['11111111-1111-1111-1111-111111111111', connectionId],
  );
  const mixedOrder = (legacyRows[0] as { id: string }).id;
  const mixedAfter = await service.applyFill(mixedOrder, {
    quantity: '0.1000',
    price: '1.20000000',
    providerDealId: 'fill-MN',
  });
  const mixedLedger = await dataSource.query(
    `SELECT evidence_class, provider_deal_id, quantity::text AS q, price::text AS p
      FROM trading.order_fill_evidence WHERE order_id = $1 ORDER BY recorded_at, id`,
    [mixedOrder],
  );
  const mixedReplay = await service.applyFill(mixedOrder, {
    quantity: '0.2500',
    price: '1.10000000',
    providerDealId: 'deal-legacy-M',
  });
  record(
    'mixed-era: baseline transcribed once; replay of the RETAINED legacy deal AFTER the pointer moved is a no-op (finding 1)',
    mixedAfter.filledQuantity === '0.3500' &&
      mixedReplay.filledQuantity === '0.3500' &&
      mixedLedger.length === 2 &&
      (mixedLedger[0] as { evidence_class: string }).evidence_class === 'LEGACY_BASELINE' &&
      (mixedLedger[0] as { provider_deal_id: string | null }).provider_deal_id ===
        'deal-legacy-M' &&
      (mixedLedger[0] as { q: string }).q === '0.2500',
  );
  const mixedInvariant = await dataSource.query(
    `SELECT (SELECT filled_quantity FROM trading.orders WHERE id = $1)::text AS filled,
            (SELECT SUM(quantity) FROM trading.order_fill_evidence WHERE order_id = $1)::text AS s`,
    [mixedOrder],
  );
  record(
    'mixed-era invariant: filled_quantity == SUM(ledger) (baseline + fills, finding 5)',
    (mixedInvariant[0] as { filled: string; s: string }).filled ===
      (mixedInvariant[0] as { filled: string; s: string }).s,
  );

  // ── 9. Contradictory duplicate evidence (finding 3) ─────────────────────
  const contradictionOrder = await seedOrder('0.5000');
  await service.applyFill(contradictionOrder, {
    quantity: '0.1000',
    price: '1.10000000',
    providerDealId: 'fill-K',
  });
  let contradictionRefused = false;
  try {
    await service.applyFill(contradictionOrder, {
      quantity: '0.2000',
      price: '1.10000000',
      providerDealId: 'fill-K',
    });
  } catch (err) {
    contradictionRefused = (err as Error).message.includes('Contradictory accounting evidence');
  }
  const identicalReplay = await service.applyFill(contradictionOrder, {
    quantity: '0.1000',
    price: '1.10000000',
    providerDealId: 'fill-K',
  });
  record(
    'contradictory redelivery refused (different quantity); identical redelivery is a no-op (finding 3)',
    contradictionRefused && identicalReplay.filledQuantity === '0.1000',
  );

  // ── 10. findDealOwner (finding 2) ───────────────────────────────────────
  const owner = await seedOrder('0.5000');
  await service.applyFill(owner, {
    quantity: '0.1000',
    price: '1.10000000',
    providerDealId: 'fill-W',
  });
  const lookupLedger = await service.findDealOwner(connectionId, 'fill-W');
  const lookupUnknown = await service.findDealOwner(connectionId, 'deal-nonexistent');
  // Ambiguity constructed by direct SQL (unreachable through applyFill: the
  // orders pointer unique index refuses the duplicate current pointer).
  const ambOrder = await seedOrder('0.5000');
  await dataSource.query(
    `INSERT INTO trading.order_fill_evidence
       (order_id, broker_connection_id, provider_deal_id, quantity, price, evidence_class)
     VALUES ($1, $2, 'fill-V', 0.1, 1.1, 'PROVIDER_DEAL')`,
    [ambOrder, connectionId],
  );
  const ambLegacy = await dataSource.query(
    `INSERT INTO trading.orders
       (user_id, broker_connection_id, client_order_id, idempotency_key,
        order_kind, time_in_force, instrument, direction,
        requested_quantity, status, filled_quantity, avg_fill_price,
        provider_deal_id, submitted_at)
     VALUES ($1, $2, 'rehearsal-amb-1', gen_random_uuid()::text,
             'MARKET', 'IOC', 'EURUSD', 'BUY',
             '0.5000', 'PARTIALLY_FILLED', '0.1000', '1.10000000',
             'fill-V', NOW())
     RETURNING id::text`,
    ['11111111-1111-1111-1111-111111111111', connectionId],
  );
  const lookupAmbiguous = await service.findDealOwner(connectionId, 'fill-V');
  record(
    'findDealOwner: ledger evidence resolves; unknown is empty; disagreement is AMBIGUOUS (finding 2)',
    lookupLedger.orderId === owner &&
      lookupLedger.ambiguous === false &&
      lookupUnknown.orderId === null &&
      lookupUnknown.ambiguous === false &&
      lookupAmbiguous.ambiguous === true &&
      lookupAmbiguous.orderId === null &&
      lookupAmbiguous.candidateOrderIds.includes(ambOrder) &&
      lookupAmbiguous.candidateOrderIds.includes((ambLegacy[0] as { id: string }).id),
  );

  // ── 11. Rollback (finding 6): refusal, export-first, forced downgrade ────
  const hardening = new HardenOrderFillEvidenceLedger1795628400000();
  const base = new CreateOrderFillEvidenceLedger1795564800000();
  let populatedRefusal = false;
  try {
    await hardening.down(qr);
  } catch (err) {
    populatedRefusal = (err as Error).message.includes('booked accounting-evidence');
  }
  record(
    'down() refuses while the ledger is populated (protective refusal, finding 6)',
    populatedRefusal,
  );

  // The operator procedure: EXPORT the booked evidence (the runbook's
  // change-record attachment), then the conscious override.
  const exportRows = await dataSource.query(
    `SELECT provider_deal_id, quantity::text AS q, price::text AS p, evidence_class
       FROM trading.order_fill_evidence ORDER BY recorded_at`,
  );
  const previous = process.env.IREXPRO_DESTROY_LEDGER_EVIDENCE;
  process.env.IREXPRO_DESTROY_LEDGER_EVIDENCE = '1';
  try {
    await hardening.down(qr);
    await base.down(qr);
  } finally {
    if (previous === undefined) delete process.env.IREXPRO_DESTROY_LEDGER_EVIDENCE;
    else process.env.IREXPRO_DESTROY_LEDGER_EVIDENCE = previous;
  }
  const ordersBeforeDown = await dataSource.query(`SELECT COUNT(*)::int AS c FROM trading.orders`);
  const tableGone = await dataSource.query(
    `SELECT EXISTS (SELECT 1 FROM information_schema.tables
                    WHERE table_schema = 'trading' AND table_name = 'order_fill_evidence') AS present`,
  );
  record(
    'forced downgrade drops newest-first and leaves orders untouched (export retained ' +
      `${exportRows.length} evidence rows in the change record)`,
    (tableGone[0] as { present: boolean }).present === false &&
      (ordersBeforeDown[0] as { c: number }).c > 0,
  );

  await base.up(qr); // idempotent re-runs
  await hardening.up(qr);
  const back = await dataSource.query(
    `SELECT EXISTS (SELECT 1 FROM information_schema.tables
                    WHERE table_schema = 'trading' AND table_name = 'order_fill_evidence') AS present`,
  );
  // mixedOrder survived the downgrade on the order row (filled 0.3500)
  // while the ledger was dropped and re-created EMPTY — a mixed-era state
  // by construction: the first new fill transcribes a fresh baseline row
  // of the surviving order-row state (the honest post-rollback behavior).
  const postUp = await service.applyFill(mixedOrder, {
    quantity: '0.0500',
    price: '1.30000000',
    providerDealId: 'fill-C',
  });
  const postUpLedger = await dataSource.query(
    `SELECT evidence_class, quantity::text AS q FROM trading.order_fill_evidence
      WHERE order_id = $1 ORDER BY recorded_at, id`,
    [mixedOrder],
  );
  record(
    'up() re-runs idempotently; the service books on the re-created ledger and re-transcribes the surviving baseline',
    (back[0] as { present: boolean }).present === true &&
      postUp.filledQuantity === '0.4000' &&
      postUpLedger.length === 2 &&
      (postUpLedger[0] as { evidence_class: string }).evidence_class === 'LEGACY_BASELINE' &&
      (postUpLedger[0] as { q: string }).q === '0.3500',
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
