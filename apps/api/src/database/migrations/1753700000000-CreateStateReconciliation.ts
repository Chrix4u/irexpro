import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Sprint 50 PR-4 — State reconciliation persistence (Directive PHASE G:
 * "order/account/position synchronization and mismatch detection" + §25
 * "persist or surface discrepancies appropriately").
 *
 * 1. Creates the "reconciliation" schema with:
 *    - reconciliation.runs — one persisted record per reconciliation pass
 *      over one broker connection (counters + error summary, §29 visibility).
 *    - reconciliation.discrepancies — every detected mismatch, with an
 *      OPEN-status dedup index so repeated runs refresh the same finding
 *      instead of stacking duplicates (§30 "duplicate provider event").
 *
 * 2. CHECK constraints reject out-of-enum values even if application logic
 *    is bypassed. The discrepancy type CHECK enumerates EXACTLY the
 *    directive §25 detection categories.
 *
 * The partial unique index uses COALESCE expressions so NULL internal or
 * provider references still dedupe (raw NULLs are distinct in PG unique
 * indexes — COALESCE collapses them for matching).
 */
export class CreateStateReconciliation1753700000000 implements MigrationInterface {
  name = 'CreateStateReconciliation1753700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS "reconciliation"`);

    // ── 1. reconciliation.runs ─────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "reconciliation"."runs" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "user_id" uuid NOT NULL,
        "broker_connection_id" uuid NOT NULL,
        "broker_id" varchar(50) NOT NULL,
        "status" varchar(30) NOT NULL DEFAULT 'PENDING',
        "started_at" timestamptz NULL,
        "completed_at" timestamptz NULL,
        "provider_orders_seen" integer NOT NULL DEFAULT 0,
        "internal_orders_compared" integer NOT NULL DEFAULT 0,
        "provider_positions_seen" integer NOT NULL DEFAULT 0,
        "internal_positions_compared" integer NOT NULL DEFAULT 0,
        "account_snapshot_compared" integer NOT NULL DEFAULT 0,
        "discrepancies_detected" integer NOT NULL DEFAULT 0,
        "discrepancies_new" integer NOT NULL DEFAULT 0,
        "discrepancies_auto_resolved" integer NOT NULL DEFAULT 0,
        "discrepancies_open" integer NOT NULL DEFAULT 0,
        "errors" integer NOT NULL DEFAULT 0,
        "error_summary" text NULL,
        "metadata" jsonb NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_reconciliation_runs" PRIMARY KEY ("id"),
        CONSTRAINT "chk_reconciliation_runs_status" CHECK ("status" IN (
          'PENDING','RUNNING','COMPLETED','COMPLETED_WITH_WARNINGS','FAILED'
        )),
        CONSTRAINT "chk_reconciliation_runs_counts" CHECK (
          "provider_orders_seen" >= 0 AND "internal_orders_compared" >= 0 AND
          "provider_positions_seen" >= 0 AND "internal_positions_compared" >= 0 AND
          "account_snapshot_compared" >= 0 AND "discrepancies_detected" >= 0 AND
          "discrepancies_new" >= 0 AND "discrepancies_auto_resolved" >= 0 AND
          "discrepancies_open" >= 0 AND "errors" >= 0
        )
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_reconciliation_runs_user"
      ON "reconciliation"."runs" ("user_id")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_reconciliation_runs_connection_created"
      ON "reconciliation"."runs" ("broker_connection_id", "created_at" DESC)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_reconciliation_runs_status"
      ON "reconciliation"."runs" ("status")
    `);

    // ── 2. reconciliation.discrepancies ────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "reconciliation"."discrepancies" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "user_id" uuid NOT NULL,
        "broker_connection_id" uuid NOT NULL,
        "run_id" uuid NULL,
        "discrepancy_type" varchar(40) NOT NULL,
        "severity" varchar(10) NOT NULL,
        "status" varchar(10) NOT NULL DEFAULT 'OPEN',
        "internal_ref_type" varchar(10) NULL,
        "internal_ref_id" varchar(255) NULL,
        "client_order_id" varchar(100) NULL,
        "provider_ref" varchar(255) NULL,
        "details" jsonb NULL,
        "first_detected_at" timestamptz NOT NULL,
        "last_seen_at" timestamptz NOT NULL,
        "resolved_at" timestamptz NULL,
        "resolution" varchar(500) NULL,
        "resolved_by" varchar(20) NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_reconciliation_discrepancies" PRIMARY KEY ("id"),
        CONSTRAINT "chk_reconciliation_discrepancy_type" CHECK ("discrepancy_type" IN (
          'MISSING_INTERNAL_ORDER','UNKNOWN_PROVIDER_ORDER','MISSING_PROVIDER_ORDER',
          'UNKNOWN_PROVIDER_POSITION','STALE_ORDER_STATE','POSITION_CLOSED_EXTERNALLY',
          'DUPLICATE_PROVIDER_ID','UNRESOLVED_EXECUTION_RESULT','ACCOUNT_STATE_MISMATCH'
        )),
        CONSTRAINT "chk_reconciliation_discrepancy_severity" CHECK ("severity" IN (
          'INFO','WARNING','CRITICAL'
        )),
        CONSTRAINT "chk_reconciliation_discrepancy_status" CHECK ("status" IN (
          'OPEN','RESOLVED'
        )),
        CONSTRAINT "chk_reconciliation_discrepancy_ref_type" CHECK (
          "internal_ref_type" IS NULL OR "internal_ref_type" IN ('ORDER','TRADE','ACCOUNT')
        ),
        CONSTRAINT "chk_reconciliation_discrepancy_resolved_by" CHECK (
          "resolved_by" IS NULL OR "resolved_by" IN ('AUTO','MANUAL')
        ),
        CONSTRAINT "chk_reconciliation_discrepancy_resolved_shape" CHECK (
          ("status" = 'OPEN' AND "resolved_at" IS NULL AND "resolution" IS NULL)
          OR
          ("status" = 'RESOLVED' AND "resolved_at" IS NOT NULL AND "resolution" IS NOT NULL)
        )
      )
    `);

    // OPEN-row dedup: same connection + type + refs → one OPEN row, refreshed
    // (last_seen_at/details) by re-detection instead of duplicated.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_reconciliation_discrepancy_open"
      ON "reconciliation"."discrepancies" (
        "broker_connection_id",
        "discrepancy_type",
        COALESCE("internal_ref_id", ''),
        COALESCE("provider_ref", '')
      )
      WHERE "status" = 'OPEN'
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_reconciliation_discrepancies_user_status"
      ON "reconciliation"."discrepancies" ("user_id", "status")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_reconciliation_discrepancies_connection_status"
      ON "reconciliation"."discrepancies" ("broker_connection_id", "status")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_reconciliation_discrepancies_type_status"
      ON "reconciliation"."discrepancies" ("discrepancy_type", "status")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_reconciliation_discrepancies_run"
      ON "reconciliation"."discrepancies" ("run_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "reconciliation"."idx_reconciliation_discrepancies_run"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "reconciliation"."idx_reconciliation_discrepancies_type_status"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "reconciliation"."idx_reconciliation_discrepancies_connection_status"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "reconciliation"."idx_reconciliation_discrepancies_user_status"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "reconciliation"."uq_reconciliation_discrepancy_open"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "reconciliation"."discrepancies"`);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "reconciliation"."idx_reconciliation_runs_status"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "reconciliation"."idx_reconciliation_runs_connection_created"`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "reconciliation"."idx_reconciliation_runs_user"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "reconciliation"."runs"`);
    // The schema is shared with nothing else in PR-4 — drop it on down.
    await queryRunner.query(`DROP SCHEMA IF EXISTS "reconciliation"`);
  }
}
