import { MigrationInterface, QueryRunner } from 'typeorm';

export class RaiseRiskProfileLotCeilingDefault1793140800000 implements MigrationInterface {
  name = 'RaiseRiskProfileLotCeilingDefault1793140800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE trading.risk_profiles ALTER COLUMN max_position_size_lot SET DEFAULT '4.0000'`,
    );
    // Migrate the legacy system-default rows so existing users are not still
    // silently capped at 0.10 after the product ceiling moves to 4.00.
    // Values other than the exact historical default are treated as explicit
    // user/admin choices and are left unchanged.
    await queryRunner.query(
      `UPDATE trading.risk_profiles
       SET max_position_size_lot = '4.0000', updated_at = now()
       WHERE max_position_size_lot = '0.1000'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE trading.risk_profiles ALTER COLUMN max_position_size_lot SET DEFAULT '0.1000'`,
    );
  }
}
