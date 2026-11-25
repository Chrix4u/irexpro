import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Immutable per-fill accounting evidence ledger (accounting-integrity
 * correction 2026-11-25).
 *
 * trading.orders.provider_deal_id is a LATEST-DEAL POINTER that every fill
 * overwrites; after fills A then B the row remembers only B, so a replayed
 * delivery of fill A escapes duplicate detection and is double-counted
 * (0.10 + 0.10 + replayed A 0.10 = 0.30). This migration creates the
 * append-only table that retains EVERY fill's identifier and economics.
 *
 * ADDITIVE, schema-only CREATE TABLE — no data rewrite, no backfill:
 * - Historical fills are NOT reconstructed into rows (only the latest
 *   deal pointer survived on the order row; fabricating per-fill rows
 *   would invent evidence). Legacy replays remain protected by the
 *   order-row pointer check in OrderService.applyFill.
 * - The partial unique index uq_order_fill_evidence_deal
 *   (broker_connection_id, provider_deal_id WHERE provider_deal_id IS NOT
 *   NULL AND <> '') makes every deal-grade fill replay-detectable FOREVER
 *   and blocks crediting one native deal to two internal orders, under
 *   concurrency, at the database level.
 * - The append-only trigger trg_order_fill_evidence_append_only raises on
 *   any UPDATE or DELETE of a ledger row — accounting history is
 *   immutable even to privileged application paths; corrections are new
 *   rows, never edits.
 * - ON DELETE RESTRICT on order_id: an order with booked fills cannot be
 *   deleted (history preservation).
 *
 * Rollback (down): drops trigger, function and the table. Safe on any
 * schema that has it: no other pre-existing object depends on the table.
 */
export class CreateOrderFillEvidenceLedger1795564800000 implements MigrationInterface {
  name = 'CreateOrderFillEvidenceLedger1795564800000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS trading.order_fill_evidence (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        order_id uuid NOT NULL REFERENCES trading.orders(id) ON DELETE RESTRICT,
        broker_connection_id uuid NOT NULL,
        provider_deal_id varchar(255) NULL,
        provider_order_id varchar(255) NULL,
        provider_position_id varchar(255) NULL,
        quantity numeric(10,4) NOT NULL,
        price numeric(18,8) NOT NULL,
        evidence_class varchar(32) NOT NULL,
        recorded_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT ck_order_fill_evidence_identifier_shape CHECK (
          (provider_deal_id IS NULL OR provider_deal_id <> '')
          AND (provider_order_id IS NULL OR provider_order_id <> '')
          AND (provider_position_id IS NULL OR provider_position_id <> '')
        ),
        CONSTRAINT ck_order_fill_evidence_quantity CHECK (quantity > 0),
        CONSTRAINT ck_order_fill_evidence_price CHECK (price > 0),
        CONSTRAINT ck_order_fill_evidence_class CHECK (
          evidence_class IN ('PROVIDER_DEAL','POSITION_FACTS','PROVIDER_RESPONSE','PROVIDER_ORDER_STATE')
        ),
        CONSTRAINT ck_order_fill_evidence_class_consistent CHECK (
          (evidence_class = 'PROVIDER_DEAL') = (provider_deal_id IS NOT NULL)
        )
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_order_fill_evidence_deal
        ON trading.order_fill_evidence (broker_connection_id, provider_deal_id)
        WHERE provider_deal_id IS NOT NULL AND provider_deal_id <> ''
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS ix_order_fill_evidence_order
        ON trading.order_fill_evidence (order_id, recorded_at)
    `);
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION trading.fn_order_fill_evidence_append_only()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RAISE EXCEPTION
          'trading.order_fill_evidence is an append-only accounting ledger — %s of a row is forbidden (corrections are new rows, never edits)',
          TG_OP
          USING ERRCODE = 'P0001';
      END;
      $$
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_order_fill_evidence_append_only
        BEFORE UPDATE OR DELETE ON trading.order_fill_evidence
        FOR EACH ROW
        EXECUTE FUNCTION trading.fn_order_fill_evidence_append_only()
    `);
    await queryRunner.query(`
      COMMENT ON TABLE trading.order_fill_evidence IS
      'Immutable per-fill accounting evidence ledger — one INSERT-only row per booked fill; retains every historical provider deal identifier (duplicate/replay detection) and the exact decimal fill economics; never updated or deleted (trigger-enforced).'
    `);
    await queryRunner.query(`
      COMMENT ON INDEX trading.uq_order_fill_evidence_deal IS
      'One native broker deal may prove at most ONE internal fill per broker connection — replay-detectable forever and never creditable to two orders.'
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    // Explicit rollback only, never automatic during a trade or reconciliation.
    // Table drop removes the indexes; the trigger and its function go first.
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS trg_order_fill_evidence_append_only ON trading.order_fill_evidence`,
    );
    await queryRunner.query(`DROP FUNCTION IF EXISTS trading.fn_order_fill_evidence_append_only()`);
    await queryRunner.query(`DROP TABLE IF EXISTS trading.order_fill_evidence`);
  }
}
