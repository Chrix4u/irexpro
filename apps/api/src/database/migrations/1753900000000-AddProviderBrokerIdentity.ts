import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Sprint 56 correction round 4 — architect finding 9: persist the
 * SERVER-DERIVED provider identity on broker.broker_connections.
 *
 * `provider_broker_identity` (varchar(100), NULL) stores the sanitized
 * NORMALIZED identity of the actual broker behind a cTrader connection, as
 * discovered by the SERVER through ProtoOAGetAccountListByAccessTokenRes
 * (payload 2149, `brokerTitleShort`) during OAuth account linking — e.g.
 * 'pepperstone', 'icmarkets', 'spotware' for a generic cTrader account.
 *
 * Invariants:
 * - SERVER-DERIVED ONLY: the value is computed from provider discovery by
 *   the linking/connect path; clients can never submit or overwrite it (the
 *   public ConnectBrokerDto carries no such field and the manual connect
 *   path persists nothing here — only OAuth linking sets it today, and the
 *   adapter discovery path may refine it later).
 * - SANITIZED: a lowercase alphanumeric normalization of the discovered
 *   title — never credentials, never token material, never raw free text.
 * - NULL = unknown identity (no discovery evidence). Identity-scoped
 *   production-LIVE verification treats NULL as fail-closed (finding 10).
 *
 * Backfill is trivial and safe: existing rows keep NULL (unknown identity)
 * — identity verification for them stays fail-closed until re-linked.
 */
export class AddProviderBrokerIdentity1753900000000 implements MigrationInterface {
  name = 'AddProviderBrokerIdentity1753900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "broker"."broker_connections"
      ADD COLUMN IF NOT EXISTS "provider_broker_identity" varchar(100) NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "broker"."broker_connections"
      DROP COLUMN IF EXISTS "provider_broker_identity"`,
    );
  }
}
