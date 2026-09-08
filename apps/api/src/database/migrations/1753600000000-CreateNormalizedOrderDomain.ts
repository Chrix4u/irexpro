import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Sprint 50 PR-2 — Normalized order domain (Directive PHASE C:
 * "normalized order model, normalized position model, state transitions,
 * provider identifiers, persistence").
 *
 * 1. Creates trading.orders — the normalized ORDER lifecycle record
 *    (intent → routing → fills), separated from the POSITION lifecycle
 *    (trading.trades). State machine semantics live in OrderStateMachine;
 *    CHECK constraints below reject out-of-enum values and inconsistent
 *    fill/price state even if application logic is bypassed.
 *
 * 2. Extends trading.trades with normalized POSITION fields:
 *    external_position_id (provider identifier, distinct from
 *    external_order_id) + commission/swap (position economics components).
 *    Backfill is CONSERVATIVE: new columns are NULL (unknown), never
 *    fabricated.
 */
export class CreateNormalizedOrderDomain1753600000000 implements MigrationInterface {
  name = 'CreateNormalizedOrderDomain1753600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── 1. trading.orders ──────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "trading"."orders" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "user_id" uuid NOT NULL,
        "broker_connection_id" uuid NOT NULL,
        "trade_id" uuid NULL,
        "signal_id" uuid NULL,
        "client_order_id" varchar(100) NOT NULL,
        "provider_order_id" varchar(255) NULL,
        "idempotency_key" varchar(255) NOT NULL,
        "order_kind" varchar(20) NOT NULL,
        "time_in_force" varchar(10) NOT NULL,
        "instrument" varchar(50) NOT NULL,
        "direction" varchar(10) NOT NULL,
        "requested_quantity" numeric(10,4) NOT NULL,
        "requested_price" numeric(18,8) NULL,
        "stop_price" numeric(18,8) NULL,
        "filled_quantity" numeric(10,4) NOT NULL DEFAULT 0,
        "avg_fill_price" numeric(18,8) NULL,
        "status" varchar(30) NOT NULL DEFAULT 'CREATED',
        "reject_reason" varchar(500) NULL,
        "submitted_at" timestamptz NULL,
        "finalized_at" timestamptz NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_orders" PRIMARY KEY ("id"),
        CONSTRAINT "chk_orders_kind" CHECK ("order_kind" IN ('MARKET','LIMIT','STOP','STOP_LIMIT')),
        CONSTRAINT "chk_orders_tif" CHECK ("time_in_force" IN ('GTC','DAY','IOC','FOK')),
        CONSTRAINT "chk_orders_direction" CHECK ("direction" IN ('BUY','SELL')),
        CONSTRAINT "chk_orders_status" CHECK ("status" IN (
          'CREATED','SUBMITTED','ACKNOWLEDGED','PARTIALLY_FILLED','FILLED',
          'REJECTED','CANCELLED','EXPIRED','RECONCILIATION_PENDING'
        )),
        CONSTRAINT "chk_orders_quantity_positive" CHECK ("requested_quantity" > 0),
        CONSTRAINT "chk_orders_filled_range"
          CHECK ("filled_quantity" >= 0 AND "filled_quantity" <= "requested_quantity"),
        CONSTRAINT "chk_orders_fill_price_consistency"
          CHECK (
            ("filled_quantity" = 0 AND "avg_fill_price" IS NULL)
            OR ("filled_quantity" > 0 AND "avg_fill_price" IS NOT NULL)
          ),
        CONSTRAINT "chk_orders_status_fill_consistency"
          CHECK (
            ("status" = 'FILLED' AND "filled_quantity" = "requested_quantity")
            OR (
              "status" = 'PARTIALLY_FILLED'
              AND "filled_quantity" > 0
              AND "filled_quantity" < "requested_quantity"
            )
            OR (
              "status" NOT IN ('FILLED', 'PARTIALLY_FILLED')
              AND "filled_quantity" < "requested_quantity"
            )
          ),
        CONSTRAINT "chk_orders_price_kind" CHECK (
          ("order_kind" = 'MARKET' AND "requested_price" IS NULL AND "stop_price" IS NULL)
          OR ("order_kind" = 'LIMIT' AND "requested_price" IS NOT NULL AND "stop_price" IS NULL)
          OR ("order_kind" = 'STOP' AND "requested_price" IS NULL AND "stop_price" IS NOT NULL)
          OR ("order_kind" = 'STOP_LIMIT' AND "requested_price" IS NOT NULL AND "stop_price" IS NOT NULL)
        ),
        CONSTRAINT "chk_orders_filled_implies_submitted"
          CHECK ("filled_quantity" = 0 OR "submitted_at" IS NOT NULL)
      )
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_orders_idempotency_key"
      ON "trading"."orders" ("idempotency_key")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_orders_user_created"
      ON "trading"."orders" ("user_id", "created_at" DESC)
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_orders_connection"
      ON "trading"."orders" ("broker_connection_id")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_orders_trade"
      ON "trading"."orders" ("trade_id")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_orders_status"
      ON "trading"."orders" ("status")
    `);

    // ── 2. trading.trades — normalized position fields ────────────────────
    // Conservative backfill: NULL (unknown), never fabricated.
    await queryRunner.query(`
      ALTER TABLE "trading"."trades"
      ADD COLUMN IF NOT EXISTS "external_position_id" varchar(255) NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "trading"."trades"
      ADD COLUMN IF NOT EXISTS "commission" numeric(18,8) NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "trading"."trades"
      ADD COLUMN IF NOT EXISTS "swap" numeric(18,8) NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "trading"."trades" DROP COLUMN IF EXISTS "swap"`);
    await queryRunner.query(`ALTER TABLE "trading"."trades" DROP COLUMN IF EXISTS "commission"`);
    await queryRunner.query(
      `ALTER TABLE "trading"."trades" DROP COLUMN IF EXISTS "external_position_id"`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "trading"."idx_orders_status"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "trading"."idx_orders_trade"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "trading"."idx_orders_connection"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "trading"."idx_orders_user_created"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "trading"."uq_orders_idempotency_key"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "trading"."orders"`);
  }
}
