import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddTradePathAmbiguityDiagnostics1755400000000 implements MigrationInterface {
  name = 'AddTradePathAmbiguityDiagnostics1755400000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE trading.trades
        ADD COLUMN IF NOT EXISTS same_bar_protection_ambiguity_count integer NULL,
        ADD COLUMN IF NOT EXISTS last_same_bar_protection_ambiguity_at timestamptz NULL
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE trading.trades
        DROP COLUMN IF EXISTS last_same_bar_protection_ambiguity_at,
        DROP COLUMN IF EXISTS same_bar_protection_ambiguity_count
    `);
  }
}
