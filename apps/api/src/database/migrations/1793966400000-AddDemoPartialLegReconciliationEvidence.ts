import { MigrationInterface, QueryRunner } from 'typeorm';

/** Additive audit facts for provider partial-close reconciliation only. */
export class AddDemoPartialLegReconciliationEvidence1793966400000 implements MigrationInterface {
  name = 'AddDemoPartialLegReconciliationEvidence1793966400000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE trading.demo_partial_close_legs
        ADD COLUMN IF NOT EXISTS reconciliation_reason varchar(80) NULL,
        ADD COLUMN IF NOT EXISTS last_reconciled_at timestamptz NULL
    `);
    // A confirmed leg must have ALL broker economics, never just a volume
    // assertion. Existing releases never dispatch a P1 partial close, so
    // this tightens the unused table without changing any live trade.
    await queryRunner.query(`
      ALTER TABLE trading.demo_partial_close_legs
        ADD CONSTRAINT ck_demo_partial_close_confirmed_economics_v2
        CHECK (state <> 'CONFIRMED' OR economics_complete = TRUE)
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE trading.demo_partial_close_legs
      DROP CONSTRAINT IF EXISTS ck_demo_partial_close_confirmed_economics_v2
    `);
    await queryRunner.query(`
      ALTER TABLE trading.demo_partial_close_legs
        DROP COLUMN IF EXISTS reconciliation_reason,
        DROP COLUMN IF EXISTS last_reconciled_at
    `);
  }
}
