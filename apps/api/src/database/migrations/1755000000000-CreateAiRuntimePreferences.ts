import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateAiRuntimePreferences1755000000000 implements MigrationInterface {
  name = 'CreateAiRuntimePreferences1755000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS trading.ai_runtime_preferences (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL UNIQUE,
        research_paper_confidence_floor numeric(4,3) NOT NULL DEFAULT 0.600,
        revision integer NOT NULL DEFAULT 1,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT ck_ai_runtime_preferences_confidence
          CHECK (research_paper_confidence_floor >= 0.300
             AND research_paper_confidence_floor <= 0.700)
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_ai_runtime_preferences_user
      ON trading.ai_runtime_preferences(user_id)
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'fk_ai_runtime_preferences_user'
        ) THEN
          ALTER TABLE trading.ai_runtime_preferences
          ADD CONSTRAINT fk_ai_runtime_preferences_user
          FOREIGN KEY (user_id) REFERENCES identity.users(id)
          ON DELETE CASCADE;
        END IF;
      END $$;
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS trading.ai_runtime_preferences');
  }
}
