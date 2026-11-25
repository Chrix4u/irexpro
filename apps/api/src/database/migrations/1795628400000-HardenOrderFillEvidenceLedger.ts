import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * HARDENING of the immutable per-fill accounting evidence ledger
 * (independent-review correction round, 2026-11-25 — PR #805 review findings
 * 1, 3, 5, 6). Additive ALTERs on trading.order_fill_evidence created by
 * migration 1795564800000 — NO data rewrite, NO backfill.
 *
 * 1. LEGACY_BASELINE evidence class (finding 1 + 5):
 *    Mixed-era orders (quantity booked BEFORE the ledger existed) had their
 *    pre-ledger accounting represented only by the order row (cumulative
 *    filled_quantity + the latest-deal pointer). The legacy replay test only
 *    covered an IMMEDIATE replay of that pointer; once a subsequent
 *    ledger-era fill overwrote the pointer, the retained legacy deal
 *    identifier existed NOWHERE — a replay of it would double-book.
 *    applyFill now transcribes the pre-ledger cumulative accounting state
 *    into ONE baseline row (evidence_class LEGACY_BASELINE) at the moment
 *    the order books its FIRST ledger-era fill — INSIDE the same
 *    transaction. The row is an honest BASELINE SUMMARY of the order row's
 *    already-booked state (the retained legacy pointer when any, the
 *    cumulative quantity, the cumulative average price) — it is NOT a
 *    reconstructed per-fill deal (history is never invented: only the
 *    latest pointer survived, and it is recorded AS the pointer, not as a
 *    fabricated fill).
 *
 * 2. Contradictory-evidence defence (finding 3):
 *    Same native deal id delivered twice with DIFFERENT quantity/price is
 *    NOT an identical replay — applyFill compares the delivered economics
 *    against the booked PROVIDER_DEAL evidence row and refuses with a typed
 *    Conflict stating both facts. (Enforced in OrderService; the schema
 *    keeps exact numerics so the comparison is exact.)
 *
 * 3. TRUNCATE protection (finding 6):
 *    The row-level append-only trigger covers UPDATE/DELETE, NOT TRUNCATE —
 *    a single TRUNCATE statement would discard booked accounting history.
 *    This migration adds a BEFORE TRUNCATE statement trigger that raises
 *    unless the session-maintenance escape
 *    `SET irexpro.allow_ledger_truncate = '1'` is set. The escape exists for
 *    the OPERATOR/maintenance role under the runbook's export-first
 *    procedure (and for disposable test fixtures); ordinary application
 *    roles never set it. Privilege note: the escape does not grant anything
 *    — a session still needs TRUNCATE privilege on the table; the GUC only
 *    acknowledges the operator decision to discard exported history.
 *
 * 4. Referential consistency (finding 6):
 *    a) FK (order_id, broker_connection_id) → trading.orders(id,
 *       broker_connection_id) via the superkey unique index
 *       uq_orders_id_broker_connection: a ledger row's connection is now
 *       guaranteed to MATCH the connection of the order it references (the
 *       order FK alone did not guarantee this).
 *    b) FK broker_connection_id → broker.broker_connections(id) ON DELETE
 *       RESTRICT: the connection identifier must reference a real broker
 *       connection, and booked evidence blocks deleting the connection.
 *
 * 5. Protective down() (finding 6):
 *    A successful empty-schema downgrade is NOT proof that populated
 *    accounting history can be safely discarded. down() REFUSES to run
 *    while any ledger row exists, unless the operator explicitly sets
 *    IREXPRO_DESTROY_LEDGER_EVIDENCE=1 in the migration process
 *    environment — after exporting the evidence per the runbook. The
 *    refusal aborts the revert chain BEFORE migration 1795564800000's
 *    destructive table drop can run.
 */
export class HardenOrderFillEvidenceLedger1795628400000 implements MigrationInterface {
  name = 'HardenOrderFillEvidenceLedger1795628400000';

  async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Evidence-class CHECK — add LEGACY_BASELINE to the admitted classes.
    await queryRunner.query(`
      ALTER TABLE trading.order_fill_evidence
        DROP CONSTRAINT IF EXISTS ck_order_fill_evidence_class
    `);
    await queryRunner.query(`
      ALTER TABLE trading.order_fill_evidence
        ADD CONSTRAINT ck_order_fill_evidence_class CHECK (
          evidence_class IN (
            'PROVIDER_DEAL','POSITION_FACTS','PROVIDER_RESPONSE',
            'PROVIDER_ORDER_STATE','LEGACY_BASELINE'
          )
        )
    `);

    // 2. Class/deal-id parity. PROVIDER_DEAL ⇔ a deal id; every class other
    //    than PROVIDER_DEAL/LEGACY_BASELINE ⇔ NULL; LEGACY_BASELINE MAY carry
    //    the retained legacy latest-deal pointer (NULL when the legacy order
    //    had none) — carrying the pointer is transcribing a fact the order
    //    row already asserted, never a fabricated deal record.
    await queryRunner.query(`
      ALTER TABLE trading.order_fill_evidence
        DROP CONSTRAINT IF EXISTS ck_order_fill_evidence_class_consistent
    `);
    await queryRunner.query(`
      ALTER TABLE trading.order_fill_evidence
        ADD CONSTRAINT ck_order_fill_evidence_class_consistent CHECK (
          (evidence_class = 'PROVIDER_DEAL' AND provider_deal_id IS NOT NULL)
          OR (evidence_class = 'LEGACY_BASELINE')
          OR (evidence_class IN ('POSITION_FACTS','PROVIDER_RESPONSE','PROVIDER_ORDER_STATE')
              AND provider_deal_id IS NULL)
        )
    `);

    // 3. TRUNCATE refusal with the operator escape (role/privilege notes in
    //    the migration header). DROP first so up() is idempotent on re-run.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION trading.fn_order_fill_evidence_no_truncate()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF COALESCE(current_setting('irexpro.allow_ledger_truncate', true), '') <> '1' THEN
          RAISE EXCEPTION
            'trading.order_fill_evidence is an append-only accounting ledger — TRUNCATE is forbidden. Maintenance escape: export the evidence per the runbook, then SET irexpro.allow_ledger_truncate = ''1'' from the operator/maintenance session (requires TRUNCATE privilege on the table).'
            USING ERRCODE = 'P0001';
        END IF;
        RETURN NULL;
      END;
      $$
    `);
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS trg_order_fill_evidence_no_truncate ON trading.order_fill_evidence`,
    );
    await queryRunner.query(`
      CREATE TRIGGER trg_order_fill_evidence_no_truncate
        BEFORE TRUNCATE ON trading.order_fill_evidence
        FOR EACH STATEMENT
        EXECUTE FUNCTION trading.fn_order_fill_evidence_no_truncate()
    `);

    // 4a. Superkey unique index on trading.orders — (id is the PK, so
    //     (id, broker_connection_id) is trivially unique; the index exists
    //     only to be the FK target for the pair-consistency constraint).
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_orders_id_broker_connection
        ON trading.orders (id, broker_connection_id)
    `);
    await queryRunner.query(`
      ALTER TABLE trading.order_fill_evidence
        DROP CONSTRAINT IF EXISTS fk_order_fill_evidence_order_connection
    `);
    await queryRunner.query(`
      ALTER TABLE trading.order_fill_evidence
        ADD CONSTRAINT fk_order_fill_evidence_order_connection
        FOREIGN KEY (order_id, broker_connection_id)
        REFERENCES trading.orders (id, broker_connection_id)
        ON DELETE RESTRICT
    `);

    // 4b. The connection itself must exist — and booked evidence blocks
    //     deleting the connection (ON DELETE RESTRICT).
    await queryRunner.query(`
      ALTER TABLE trading.order_fill_evidence
        DROP CONSTRAINT IF EXISTS fk_order_fill_evidence_broker_connection
    `);
    await queryRunner.query(`
      ALTER TABLE trading.order_fill_evidence
        ADD CONSTRAINT fk_order_fill_evidence_broker_connection
        FOREIGN KEY (broker_connection_id)
        REFERENCES broker.broker_connections (id)
        ON DELETE RESTRICT
    `);

    await queryRunner.query(`
      COMMENT ON CONSTRAINT ck_order_fill_evidence_class ON trading.order_fill_evidence IS
        'Evidence grades incl. LEGACY_BASELINE: pre-ledger cumulative accounting state transcribed from the order row at the first ledger-era fill — a baseline summary, never a reconstructed per-fill deal.'
    `);
    await queryRunner.query(`
      COMMENT ON CONSTRAINT fk_order_fill_evidence_order_connection ON trading.order_fill_evidence IS
        'A ledger row references the order AND the exact broker connection of that order — the ledger can never attribute a fill to a different connection than the order it books.'
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    // PROTECTIVE REFUSAL (finding 6): a populated ledger is booked
    // accounting history. Refuse to dismantle the protections while rows
    // exist, unless the operator has exported the evidence and set
    // IREXPRO_DESTROY_LEDGER_EVIDENCE=1 in the migration environment. The
    // refusal aborts the revert chain BEFORE 1795564800000.down() can drop
    // the table, so populated history cannot be silently discarded.
    const populated: Array<{ n: number }> = await queryRunner.query(
      `SELECT COUNT(*)::int AS n FROM trading.order_fill_evidence`,
    );
    const rowCount = Number(populated[0]?.n ?? 0);
    if (rowCount > 0 && process.env.IREXPRO_DESTROY_LEDGER_EVIDENCE !== '1') {
      throw new Error(
        `trading.order_fill_evidence still holds ${rowCount} booked accounting-evidence row(s). ` +
          'Refusing to revert migration 1795628400000 — a successful downgrade must not discard ' +
          'booked accounting history. Export the evidence first (see the runbook: ' +
          'SELECT * FROM trading.order_fill_evidence ORDER BY recorded_at — attach the export to ' +
          'the change record), then re-run with IREXPRO_DESTROY_LEDGER_EVIDENCE=1 in the ' +
          'migration process environment.',
      );
    }

    // Drop the protective objects this migration added (both paths).
    await queryRunner.query(`
      ALTER TABLE trading.order_fill_evidence
        DROP CONSTRAINT IF EXISTS fk_order_fill_evidence_broker_connection
    `);
    await queryRunner.query(`
      ALTER TABLE trading.order_fill_evidence
        DROP CONSTRAINT IF EXISTS fk_order_fill_evidence_order_connection
    `);
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS trg_order_fill_evidence_no_truncate ON trading.order_fill_evidence
    `);
    await queryRunner.query(`
      DROP FUNCTION IF EXISTS trading.fn_order_fill_evidence_no_truncate()
    `);

    if (rowCount === 0) {
      // EMPTY ledger: restore the ORIGINAL (4-class) CHECK constraints of
      // 1795564800000 byte-identically — safe because no row (including no
      // LEGACY_BASELINE row) exists.
      await queryRunner.query(`
        ALTER TABLE trading.order_fill_evidence
          DROP CONSTRAINT IF EXISTS ck_order_fill_evidence_class
      `);
      await queryRunner.query(`
        ALTER TABLE trading.order_fill_evidence
          ADD CONSTRAINT ck_order_fill_evidence_class CHECK (
            evidence_class IN ('PROVIDER_DEAL','POSITION_FACTS','PROVIDER_RESPONSE','PROVIDER_ORDER_STATE')
          )
      `);
      await queryRunner.query(`
        ALTER TABLE trading.order_fill_evidence
          DROP CONSTRAINT IF EXISTS ck_order_fill_evidence_class_consistent
      `);
      await queryRunner.query(`
        ALTER TABLE trading.order_fill_evidence
          ADD CONSTRAINT ck_order_fill_evidence_class_consistent CHECK (
            (evidence_class = 'PROVIDER_DEAL') = (provider_deal_id IS NOT NULL)
          )
      `);
    }
    // POPULATED + operator override: the 4-class CHECK restoration is
    // IMPOSSIBLE (the LEGACY_BASELINE rows this series legitimately books
    // would violate it) and pointless — the revert chain's very next step
    // (1795564800000.down) drops the table the operator consciously chose
    // to destroy after exporting. The CHECK amendments are left in place
    // and die with the table; the refusal above is what protected the
    // history until the conscious decision was made.
    // The superkey index on trading.orders is harmless either way; drop it
    // to leave the pre-1795628400000 state byte-identical.
    await queryRunner.query(`DROP INDEX IF EXISTS trading.uq_orders_id_broker_connection`);
  }
}
