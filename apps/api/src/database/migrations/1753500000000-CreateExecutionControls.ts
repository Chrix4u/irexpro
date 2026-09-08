import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Sprint 50 — Emergency control plane (Directive §28).
 *
 * Creates platform.execution_controls: presence of a row = execution
 * disabled at that scope (GLOBAL / PROVIDER / USER / BROKER_CONNECTION).
 * Fail-closed semantics live in ExecutionControlService, not here.
 */
export class CreateExecutionControls1753500000000 implements MigrationInterface {
  name = 'CreateExecutionControls1753500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "platform"."execution_controls" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "scope" varchar(20) NOT NULL,
        "scope_key" varchar(100) NULL,
        "reason" varchar(500) NOT NULL,
        "activated_by_user_id" uuid NOT NULL,
        "activated_at" timestamptz NOT NULL DEFAULT now(),
        "expires_at" timestamptz NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_execution_controls" PRIMARY KEY ("id"),
        CONSTRAINT "chk_execution_controls_scope"
          CHECK ("scope" IN ('GLOBAL', 'PROVIDER', 'USER', 'BROKER_CONNECTION')),
        CONSTRAINT "chk_execution_controls_scope_key_global"
          CHECK ("scope" != 'GLOBAL' OR "scope_key" IS NULL),
        CONSTRAINT "chk_execution_controls_scope_key_required"
          CHECK ("scope" = 'GLOBAL' OR ("scope_key" IS NOT NULL AND "scope_key" != ''))
      )
    `);

    // NULLS-DISTINCT semantics would allow duplicate GLOBAL rows (scope_key NULL);
    // COALESCE collapses NULL to '' so exactly one active control per scope key.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_exec_controls_active_scope"
      ON "platform"."execution_controls" ("scope", COALESCE("scope_key", ''))
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_exec_controls_scope_key"
      ON "platform"."execution_controls" ("scope", "scope_key")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_exec_controls_expires_at"
      ON "platform"."execution_controls" ("expires_at")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "platform"."idx_exec_controls_expires_at"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "platform"."idx_exec_controls_scope_key"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "platform"."uq_exec_controls_active_scope"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "platform"."execution_controls"`);
  }
}
