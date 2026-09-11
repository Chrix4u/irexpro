import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Sprint 56 correction round 5 — architect issue #332 (P0): durable logical
 * broker-account identity for OAuth connection linking idempotency.
 *
 * Adds broker.broker_connections.logical_account_key — a SERVER-COMPUTED
 * canonical key:
 *
 *   `<providerTechnology>|<normalizedProviderIdentity|brokerId>|<accountId>`
 *
 * where providerTechnology is the canonical adapter technology (all cTrader
 * aliases — ctrader / pepperstone-ctrader / icmarkets-ctrader — normalize to
 * 'ctrader') so the same provider account cannot become duplicable merely by
 * selecting an alias.
 *
 * Partial unique index per user over non-deleted rows: retrying an OAuth
 * link after an ambiguous post-commit failure must return/adopt the existing
 * connection, never create another one.
 *
 * Preflight: after backfill, duplicate keys per user FAIL the migration with
 * actionable diagnostics — no silent deletion or de-duplication.
 *
 * Soft-delete semantics: deleted rows are excluded from the uniqueness scope,
 * which documents intentional relinking (a soft-deleted connection frees the
 * logical account for a fresh link).
 */
export class AddBrokerLogicalAccountIdentity1754050000000 implements MigrationInterface {
  name = 'AddBrokerLogicalAccountIdentity1754050000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE broker.broker_connections
      ADD COLUMN IF NOT EXISTS logical_account_key varchar(255) NULL
    `);

    // Backfill — SERVER-DERIVED only, for rows with sufficient evidence:
    //   technology = canonical adapter technology for the broker_id
    //   identity   = provider_broker_identity when discovered (cTrader),
    //                otherwise the broker_id itself
    //   account    = account_id (provider-side account reference)
    // Rows lacking account evidence stay NULL (excluded from uniqueness).
    await queryRunner.query(`
      UPDATE broker.broker_connections
      SET logical_account_key =
        (CASE
           WHEN broker_id IN ('ctrader', 'pepperstone-ctrader', 'icmarkets-ctrader') THEN 'ctrader'
           WHEN broker_id IN ('metatrader5') THEN 'metatrader5'
           WHEN broker_id IN ('oanda') THEN 'oanda'
           WHEN broker_id IN ('paper-broker') THEN 'paper-broker'
           ELSE broker_id
         END)
        || '|'
        || COALESCE(NULLIF(lower(provider_broker_identity), ''), broker_id)
        || '|'
        || account_id
      WHERE account_id IS NOT NULL
        AND account_id <> ''
        AND logical_account_key IS NULL
    `);

    // Preflight: duplicate logical keys per non-deleted connection owner
    const duplicates = await queryRunner.query(`
      SELECT user_id, logical_account_key, COUNT(*) AS conn_count
      FROM broker.broker_connections
      WHERE deleted_at IS NULL AND logical_account_key IS NOT NULL
      GROUP BY user_id, logical_account_key
      HAVING COUNT(*) > 1
    `);
    if (Array.isArray(duplicates) && duplicates.length > 0) {
      const sample = duplicates
        .slice(0, 10)
        .map(
          (r: { user_id: string; logical_account_key: string; conn_count: string }) =>
            `user ${r.user_id} has ${r.conn_count} connections for logical account ${r.logical_account_key}`,
        )
        .join('; ');
      throw new Error(
        `BrokerLogicalAccountIdentity migration preflight FAILED: duplicate durable BrokerConnection rows for the same logical broker account (${duplicates.length} keys). ` +
          `Deterministic remediation required BEFORE this migration: soft-delete or explicitly reconcile the duplicate connections. ` +
          `Offending keys: ${sample}`,
      );
    }

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_broker_connections_logical_account
      ON broker.broker_connections (user_id, logical_account_key)
      WHERE deleted_at IS NULL AND logical_account_key IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS broker.uq_broker_connections_logical_account`);
    await queryRunner.query(`
      ALTER TABLE broker.broker_connections
      DROP COLUMN IF EXISTS logical_account_key
    `);
  }
}
