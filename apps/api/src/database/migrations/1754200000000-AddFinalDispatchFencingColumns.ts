import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Sprint 56 correction round 5 (task 50-c) — final-dispatch fencing columns.
 *
 * Adds:
 *   - trading.risk_grants.credential_generation (nullable integer)
 *       The BrokerConnection.credentialGeneration observed when the grant was
 *       issued. The FINAL DISPATCH BOUNDARY (issue #361) re-reads the CURRENT
 *       exact connection and fails NEW exposure closed whenever the generation
 *       drifted between risk approval and dispatch (credential rotation /
 *       OAuth token-pair rotation). NULL = the issuer did not observe it
 *       (legacy rows / early issuers) — the boundary reads the current value
 *       into the authority context but cannot fence on it.
 *   - trading.trades.dispatch_certainty (nullable varchar(30))
 *       The round-4 ProviderDispatchCertainty classification of the
 *       state-changing dispatch that left the trade RECONCILIATION_PENDING.
 *       Drives UNCERTAIN-EXPOSURE ACCOUNTING (issue #314): RECONCILIATION_PENDING
 *       trades whose dispatch MAY have reached the provider (or NULL —
 *       conservatively uncertain) keep their NEW-exposure capacity reservation;
 *       DEFINITELY_NOT_SENT releases it once; ambiguous CLOSE keeps the
 *       reservation until closure is proven.
 *
 * No data is mutated — both columns are additive and NULL-preserving.
 */
export class AddFinalDispatchFencingColumns1754200000000 implements MigrationInterface {
  name = 'AddFinalDispatchFencingColumns1754200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE trading.risk_grants
      ADD COLUMN IF NOT EXISTS credential_generation integer
    `);
    await queryRunner.query(`
      ALTER TABLE trading.trades
      ADD COLUMN IF NOT EXISTS dispatch_certainty varchar(30)
    `);
    await queryRunner.query(`
      ALTER TABLE trading.trades
      ADD CONSTRAINT ck_trades_dispatch_certainty
      CHECK (
        dispatch_certainty IS NULL
        OR dispatch_certainty IN ('DEFINITELY_NOT_SENT', 'SENT_RESPONSE_RECEIVED', 'MAY_HAVE_REACHED_PROVIDER')
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE trading.trades DROP CONSTRAINT IF EXISTS ck_trades_dispatch_certainty`,
    );
    await queryRunner.query(`ALTER TABLE trading.trades DROP COLUMN IF EXISTS dispatch_certainty`);
    await queryRunner.query(
      `ALTER TABLE trading.risk_grants DROP COLUMN IF EXISTS credential_generation`,
    );
  }
}
