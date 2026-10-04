import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateEnsemblePostEntryShadowObservationStore1755700000000 implements MigrationInterface {
  name = 'CreateEnsemblePostEntryShadowObservationStore1755700000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS trading.ensemble_post_entry_shadow_observations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL,
        ensemble_shadow_decision_id uuid NOT NULL,
        market_data_connection_id uuid NULL,
        artifact varchar(160) NOT NULL,
        checkpoint_minutes integer NOT NULL,
        checkpoint_at timestamptz NOT NULL,
        evaluated_at timestamptz NOT NULL DEFAULT now(),
        state varchar(40) NOT NULL,
        reason text NULL,
        probability numeric(10,8) NULL,
        threshold numeric(10,8) NULL,
        current_r numeric(16,8) NULL,
        eligible_profit_state boolean NULL,
        action varchar(30) NULL,
        market_data_sources jsonb NULL,
        response jsonb NOT NULL DEFAULT '{}'::jsonb,
        execution_authority varchar(20) NOT NULL DEFAULT 'NONE',
        modifies_execution boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT fk_ensemble_post_entry_shadow_decision
          FOREIGN KEY (ensemble_shadow_decision_id)
          REFERENCES trading.ensemble_shadow_decisions(id)
          ON DELETE CASCADE,
        CONSTRAINT chk_ensemble_post_entry_shadow_checkpoint CHECK (
          checkpoint_minutes IN (5, 10, 15, 30, 60, 120, 240)
        ),
        CONSTRAINT chk_ensemble_post_entry_shadow_authority
          CHECK (execution_authority = 'NONE'),
        CONSTRAINT chk_ensemble_post_entry_shadow_no_execution
          CHECK (modifies_execution = false),
        CONSTRAINT uq_ensemble_post_entry_shadow_checkpoint UNIQUE (
          ensemble_shadow_decision_id,
          artifact,
          checkpoint_minutes
        )
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS ix_ensemble_post_entry_shadow_user_time
      ON trading.ensemble_post_entry_shadow_observations (user_id, evaluated_at DESC)
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS ix_ensemble_post_entry_shadow_decision_time
      ON trading.ensemble_post_entry_shadow_observations (
        ensemble_shadow_decision_id,
        checkpoint_minutes
      )
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TABLE IF EXISTS trading.ensemble_post_entry_shadow_observations
    `);
  }
}
