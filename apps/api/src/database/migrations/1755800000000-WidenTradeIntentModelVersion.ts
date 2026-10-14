import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Research/model provenance identifiers are durable execution evidence and may
 * legitimately exceed the original 100-character bound. Keep the full value;
 * never truncate provenance that is used for reconstruction and audit.
 */
export class WidenTradeIntentModelVersion1755800000000 implements MigrationInterface {
  name = 'WidenTradeIntentModelVersion1755800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE trading.trade_intents
      ALTER COLUMN model_version TYPE varchar(255)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const rows: Array<{ max_length: number | string | null }> = await queryRunner.query(`
      SELECT MAX(char_length(model_version)) AS max_length
      FROM trading.trade_intents
    `);
    const maxLength = Number(rows[0]?.max_length ?? 0);
    if (maxLength > 100) {
      throw new Error(
        `Cannot revert trading.trade_intents.model_version to varchar(100): existing value length ${maxLength} exceeds 100`,
      );
    }

    await queryRunner.query(`
      ALTER TABLE trading.trade_intents
      ALTER COLUMN model_version TYPE varchar(100)
    `);
  }
}
