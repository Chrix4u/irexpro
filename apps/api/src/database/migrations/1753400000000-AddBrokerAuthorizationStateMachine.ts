import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Sprint 50 — Live Account foundation.
 *
 * Adds the explicit server-side broker authorization state machine
 * (Directive §15) and credential lifecycle status (Directive §14) to
 * broker.broker_connections.
 *
 * Backfill is CONSERVATIVE and fail-closed:
 *   live_trading_enabled AND status='CONNECTED'      → ACTIVE
 *   live_trading_enabled                             → AUTHORIZED
 *   demo_validated AND status='CONNECTED'            → AUTHORIZED
 *   status='CONNECTED'                               → CONNECTED
 *   status='ERROR'                                   → ERROR
 *   status='SUSPENDED'                               → SUSPENDED
 *   status='DISCONNECTED'                            → DISCONNECTED
 *   otherwise                                        → NOT_CONNECTED
 *
 * Legacy booleans are retained (dual-write) so existing consumers keep
 * working; the state machine is the authoritative gate going forward.
 */
export class AddBrokerAuthorizationStateMachine1753400000000 implements MigrationInterface {
  name = 'AddBrokerAuthorizationStateMachine1753400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "broker"."broker_connections"
      ADD COLUMN IF NOT EXISTS authorization_status varchar(30)
        NOT NULL DEFAULT 'NOT_CONNECTED'
    `);

    await queryRunner.query(`
      ALTER TABLE "broker"."broker_connections"
      ADD COLUMN IF NOT EXISTS credential_status varchar(20)
        NOT NULL DEFAULT 'CREATED'
    `);

    await queryRunner.query(`
      ALTER TABLE "broker"."broker_connections"
      ADD COLUMN IF NOT EXISTS authorized_at timestamptz NULL
    `);

    await queryRunner.query(`
      ALTER TABLE "broker"."broker_connections"
      ADD COLUMN IF NOT EXISTS authorization_revoked_at timestamptz NULL
    `);

    // Conservative backfill (order matters — most privileged first)
    await queryRunner.query(`
      UPDATE "broker"."broker_connections" SET "authorization_status" = 'ACTIVE'
      WHERE "live_trading_enabled" = true AND "status" = 'CONNECTED'
    `);
    await queryRunner.query(`
      UPDATE "broker"."broker_connections" SET "authorization_status" = 'AUTHORIZED'
      WHERE "live_trading_enabled" = true AND "authorization_status" = 'NOT_CONNECTED'
    `);
    await queryRunner.query(`
      UPDATE "broker"."broker_connections" SET "authorization_status" = 'AUTHORIZED'
      WHERE "demo_validated" = true AND "status" = 'CONNECTED'
    `);
    await queryRunner.query(`
      UPDATE "broker"."broker_connections" SET "authorization_status" = 'CONNECTED'
      WHERE "status" = 'CONNECTED' AND "authorization_status" = 'NOT_CONNECTED'
    `);
    await queryRunner.query(`
      UPDATE "broker"."broker_connections" SET "authorization_status" = 'ERROR'
      WHERE "status" = 'ERROR'
    `);
    await queryRunner.query(`
      UPDATE "broker"."broker_connections" SET "authorization_status" = 'SUSPENDED'
      WHERE "status" = 'SUSPENDED'
    `);
    await queryRunner.query(`
      UPDATE "broker"."broker_connections" SET "authorization_status" = 'DISCONNECTED'
      WHERE "status" = 'DISCONNECTED'
    `);

    // Credential backfill: verified when a successful handshake was recorded
    await queryRunner.query(`
      UPDATE "broker"."broker_connections" SET "credential_status" = 'VERIFIED'
      WHERE "encrypted_credentials" IS NOT NULL AND "status" IN ('CONNECTED')
    `);

    // CHECK constraints — the DB itself rejects out-of-enum values
    await queryRunner.query(`
      ALTER TABLE "broker"."broker_connections"
      ADD CONSTRAINT "chk_broker_connections_authorization_status"
      CHECK ("authorization_status" IN (
        'NOT_CONNECTED','CONNECTING','CONNECTED','VERIFYING','AUTHORIZATION_REQUIRED',
        'AUTHORIZED','READY','ACTIVE','SUSPENDED','REVOKED','ERROR','DISCONNECTED'
      ))
    `);
    await queryRunner.query(`
      ALTER TABLE "broker"."broker_connections"
      ADD CONSTRAINT "chk_broker_connections_credential_status"
      CHECK ("credential_status" IN (
        'CREATED','VERIFIED','ROTATED','REVOKED','EXPIRED','INVALID'
      ))
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_bc_authorization_status"
      ON "broker"."broker_connections" ("authorization_status")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "broker"."idx_bc_authorization_status"`);
    await queryRunner.query(
      `ALTER TABLE "broker"."broker_connections" DROP CONSTRAINT IF EXISTS "chk_broker_connections_credential_status"`,
    );
    await queryRunner.query(
      `ALTER TABLE "broker"."broker_connections" DROP CONSTRAINT IF EXISTS "chk_broker_connections_authorization_status"`,
    );
    await queryRunner.query(
      `ALTER TABLE "broker"."broker_connections" DROP COLUMN IF EXISTS "authorization_revoked_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "broker"."broker_connections" DROP COLUMN IF EXISTS "authorized_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "broker"."broker_connections" DROP COLUMN IF EXISTS "credential_status"`,
    );
    await queryRunner.query(
      `ALTER TABLE "broker"."broker_connections" DROP COLUMN IF EXISTS "authorization_status"`,
    );
  }
}
