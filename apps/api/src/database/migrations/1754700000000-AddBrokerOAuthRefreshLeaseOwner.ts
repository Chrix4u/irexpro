import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Restore schema parity for the OAuth refresh lease owner token.
 *
 * BrokerConnection has required this nullable column since the cross-replica
 * OAuth refresh fencing work, but the original refresh-protection migration
 * only added the generation and lease-expiry columns. A full entity SELECT
 * therefore fails on databases that were migrated through that older chain,
 * while narrow onboarding queries can still succeed. This additive migration
 * repairs the drift without rewriting existing rows.
 */
export class AddBrokerOAuthRefreshLeaseOwner1754700000000 implements MigrationInterface {
  name = 'AddBrokerOAuthRefreshLeaseOwner1754700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "broker"."broker_connections"
      ADD COLUMN IF NOT EXISTS "credential_refresh_lease_owner" varchar(64) NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "broker"."broker_connections"
      DROP COLUMN IF EXISTS "credential_refresh_lease_owner"
    `);
  }
}
