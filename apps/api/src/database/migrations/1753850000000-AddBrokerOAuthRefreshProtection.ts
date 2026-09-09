import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Sprint 56 correction round 2 — architect finding 3: concurrent OAuth
 * refresh protection on broker.broker_connections.
 *
 * Two concurrent requests observing the same connection near expiry both
 * call refresh; Spotware rotates BOTH token pairs and invalidates the
 * previous refresh token — the credential dies. These two columns give the
 * BrokerOAuthTokenLifecycleService a DB-atomic serialization mechanism that
 * works ACROSS API replicas (not merely an in-memory mutex):
 *
 *   credential_generation                  — monotonic rotation generation
 *     (CAS token: a refresh that observed a stale generation can never
 *     overwrite a newer persisted pair — conditional UPDATE with an
 *     affected-rows check);
 *   credential_refresh_lease_expires_at    — timestamptz refresh lease
 *     (NULL = free). The claim is a single conditional
 *     UPDATE ... WHERE lease IS NULL OR lease <= now(), so exactly ONE
 *     replica can hold the lease at a time; concurrent callers wait for the
 *     winner's persisted generation or re-claim an expired lease.
 *
 * Backfill is trivial and safe: existing rows start at generation 0 with a
 * free lease (NULL) — the first refresh observed for a row simply CASes
 * 0 → 1.
 */
export class AddBrokerOAuthRefreshProtection1753850000000 implements MigrationInterface {
  name = 'AddBrokerOAuthRefreshProtection1753850000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "broker"."broker_connections"
      ADD COLUMN IF NOT EXISTS "credential_generation" integer
        NOT NULL DEFAULT 0
    `);

    await queryRunner.query(`
      ALTER TABLE "broker"."broker_connections"
      ADD COLUMN IF NOT EXISTS "credential_refresh_lease_expires_at" timestamptz NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "broker"."broker_connections"
      DROP COLUMN IF EXISTS "credential_refresh_lease_expires_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "broker"."broker_connections"
      DROP COLUMN IF EXISTS "credential_generation"`,
    );
  }
}
