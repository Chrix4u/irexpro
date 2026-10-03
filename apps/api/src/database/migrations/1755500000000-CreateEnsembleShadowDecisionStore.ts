import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateEnsembleShadowDecisionStore1755500000000 implements MigrationInterface {
  name = 'CreateEnsembleShadowDecisionStore1755500000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS trading.ensemble_shadow_decisions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL,
        trading_session_id uuid NULL,
        broker_connection_id uuid NOT NULL,
        engine_code varchar(100) NOT NULL,
        model_version varchar(160) NOT NULL,
        opportunity_key varchar(255) NOT NULL,
        instrument varchar(30) NOT NULL,
        direction varchar(4) NOT NULL,
        market_bar_time timestamptz NOT NULL,
        evaluated_at timestamptz NOT NULL,
        confidence numeric(10,8) NOT NULL,
        entry_price numeric(18,8) NOT NULL,
        atr numeric(18,8) NOT NULL,
        regime varchar(50) NOT NULL,
        regime_allowed boolean NOT NULL,
        ensemble_score numeric(10,8) NOT NULL,
        meta_probability numeric(10,8) NOT NULL,
        expected_r numeric(16,8) NOT NULL,
        consensus_passed integer NOT NULL,
        consensus_required integer NOT NULL,
        admitted boolean NOT NULL,
        execution_authority varchar(20) NOT NULL DEFAULT 'SHADOW_ONLY',
        reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
        components jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT chk_ensemble_shadow_direction CHECK (direction IN ('BUY', 'SELL')),
        CONSTRAINT chk_ensemble_shadow_authority CHECK (
          execution_authority IN ('SHADOW_ONLY', 'PAPER_ONLY')
        ),
        CONSTRAINT uq_ensemble_shadow_opportunity UNIQUE (
          user_id,
          engine_code,
          opportunity_key
        )
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS ix_ensemble_shadow_user_engine_time
      ON trading.ensemble_shadow_decisions (user_id, engine_code, evaluated_at DESC)
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS ix_ensemble_shadow_instrument_time
      ON trading.ensemble_shadow_decisions (
        user_id,
        engine_code,
        instrument,
        evaluated_at DESC
      )
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TABLE IF EXISTS trading.ensemble_shadow_decisions
    `);
  }
}
