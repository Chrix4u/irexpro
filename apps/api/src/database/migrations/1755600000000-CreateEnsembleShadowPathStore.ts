import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateEnsembleShadowPathStore1755600000000 implements MigrationInterface {
  name = 'CreateEnsembleShadowPathStore1755600000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS trading.ensemble_shadow_path_observations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        decision_id uuid NOT NULL REFERENCES trading.ensemble_shadow_decisions(id) ON DELETE CASCADE,
        user_id uuid NOT NULL,
        broker_connection_id uuid NOT NULL,
        engine_code varchar(100) NOT NULL,
        model_version varchar(160) NOT NULL,
        instrument varchar(30) NOT NULL,
        direction varchar(4) NOT NULL,
        market_bar_time timestamptz NOT NULL,
        observed_bar_time timestamptz NOT NULL,
        bar_index integer NOT NULL,
        path_version varchar(100) NOT NULL,
        close_price numeric(18,8) NOT NULL,
        close_r numeric(16,8) NOT NULL,
        favorable_r numeric(16,8) NOT NULL,
        adverse_r numeric(16,8) NOT NULL,
        running_mfe_r numeric(16,8) NOT NULL,
        running_mae_r numeric(16,8) NOT NULL,
        peak_close_r numeric(16,8) NOT NULL,
        close_giveback_r numeric(16,8) NOT NULL,
        max_close_giveback_r numeric(16,8) NOT NULL,
        stop_cushion_r numeric(16,8) NOT NULL,
        target_distance_r numeric(16,8) NOT NULL,
        bar_range_r numeric(16,8) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT chk_ensemble_shadow_path_direction CHECK (direction IN ('BUY', 'SELL')),
        CONSTRAINT chk_ensemble_shadow_path_bar_index CHECK (bar_index > 0),
        CONSTRAINT uq_ensemble_shadow_path_bar UNIQUE (decision_id, observed_bar_time)
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS ix_ensemble_shadow_path_decision_time
      ON trading.ensemble_shadow_path_observations (decision_id, observed_bar_time ASC)
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS ix_ensemble_shadow_path_user_engine_time
      ON trading.ensemble_shadow_path_observations (
        user_id,
        engine_code,
        observed_bar_time DESC
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS ix_ensemble_shadow_path_sleeve_time
      ON trading.ensemble_shadow_path_observations (
        user_id,
        engine_code,
        instrument,
        direction,
        observed_bar_time DESC
      )
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TABLE IF EXISTS trading.ensemble_shadow_path_observations
    `);
  }
}
