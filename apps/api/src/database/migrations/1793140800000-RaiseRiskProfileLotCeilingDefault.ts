import { MigrationInterface, QueryRunner } from 'typeorm';

export class RaiseRiskProfileLotCeilingDefault1793140800000 implements MigrationInterface {
  name = 'RaiseRiskProfileLotCeilingDefault1793140800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE trading.risk_profiles ALTER COLUMN max_position_size_lot SET DEFAULT '4.0000'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE trading.risk_profiles ALTER COLUMN max_position_size_lot SET DEFAULT '0.1000'`,
    );
  }
}
