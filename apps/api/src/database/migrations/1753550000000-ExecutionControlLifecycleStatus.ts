import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Sprint 50 correction (architect review A2) — execution-control lifecycle.
 *
 * The original CreateExecutionControls1753500000000 unique index
 * (uq_exec_controls_active_scope) is NOT partial: an expired row still
 * occupies the unique slot for (scope, COALESCE(scope_key,'')) and prevents
 * a replacement emergency control from being activated at the same scope
 * after the previous one expires.
 *
 * This migration introduces an explicit lifecycle status column
 * (ACTIVE | EXPIRED) and replaces the unique index with a PARTIAL one that
 * enforces uniqueness over ACTIVE rows only:
 *   - at most one ACTIVE control per (scope, scope_key) — concurrent
 *     activations resolve to a single winner (23505 → ConflictException);
 *   - expired rows are retained as records (status = EXPIRED) and never
 *     block a future activation;
 *   - reactivation flips the prior row to EXPIRED and inserts a NEW row.
 *
 * Fail-closed permission semantics live in ExecutionControlService.
 */
export class ExecutionControlLifecycleStatus1753550000000 implements MigrationInterface {
  name = 'ExecutionControlLifecycleStatus1753550000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "platform"."execution_controls"
      ADD COLUMN IF NOT EXISTS "status" varchar(20) NOT NULL DEFAULT 'ACTIVE'
    `);

    // Rows already expired at upgrade time are marked EXPIRED so the new
    // partial unique index does not count them as occupying a slot.
    await queryRunner.query(`
      UPDATE "platform"."execution_controls"
      SET "status" = 'EXPIRED'
      WHERE "expires_at" IS NOT NULL AND "expires_at" <= now()
    `);

    await queryRunner.query(`
      ALTER TABLE "platform"."execution_controls"
      DROP CONSTRAINT IF EXISTS "chk_execution_controls_status"
    `);
    await queryRunner.query(`
      ALTER TABLE "platform"."execution_controls"
      ADD CONSTRAINT "chk_execution_controls_status"
        CHECK ("status" IN ('ACTIVE', 'EXPIRED'))
    `);

    // Replace the non-partial unique index with a partial one: uniqueness
    // applies to ACTIVE rows only. COALESCE keeps the NULL-scope-key
    // (GLOBAL) collapse semantics of the original index.
    await queryRunner.query(`
      DROP INDEX IF EXISTS "platform"."uq_exec_controls_active_scope"
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_exec_controls_active_scope"
      ON "platform"."execution_controls" ("scope", COALESCE("scope_key", ''))
      WHERE "status" = 'ACTIVE'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Restore the original (non-partial) unique index semantics.
    await queryRunner.query(`
      DROP INDEX IF EXISTS "platform"."uq_exec_controls_active_scope"
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_exec_controls_active_scope"
      ON "platform"."execution_controls" ("scope", COALESCE("scope_key", ''))
    `);

    await queryRunner.query(`
      ALTER TABLE "platform"."execution_controls"
      DROP CONSTRAINT IF EXISTS "chk_execution_controls_status"
    `);
    await queryRunner.query(`
      ALTER TABLE "platform"."execution_controls"
      DROP COLUMN IF EXISTS "status"
    `);
  }
}
