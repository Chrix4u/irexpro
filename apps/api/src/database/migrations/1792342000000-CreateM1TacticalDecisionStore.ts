import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateM1TacticalDecisionStore1792342000000 implements MigrationInterface {
  name = 'CreateM1TacticalDecisionStore1792342000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS trading.m1_tactical_decisions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL,
        broker_connection_id uuid NOT NULL,
        instrument varchar(30) NOT NULL,
        direction varchar(10) NOT NULL,
        route varchar(40) NOT NULL,
        bar_time timestamptz NOT NULL,
        evaluated_at timestamptz NOT NULL DEFAULT now(),
        policy_version varchar(100) NOT NULL,
        execution_authority varchar(30) NOT NULL DEFAULT 'NONE',
        candidate jsonb NOT NULL DEFAULT '{}'::jsonb,
        governance jsonb NOT NULL DEFAULT '{}'::jsonb,
        blockers jsonb NOT NULL DEFAULT '[]'::jsonb,
        signal_id varchar(100) NULL,
        trade_intent_id uuid NULL,
        outcome_state varchar(40) NULL,
        outcome_observed_at timestamptz NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT chk_m1_tactical_direction CHECK (direction IN ('BUY', 'SELL')),
        CONSTRAINT chk_m1_tactical_authority CHECK (execution_authority IN ('NONE', 'PAPER_ONLY_RESEARCH')),
        CONSTRAINT uq_m1_tactical_decision UNIQUE (
          user_id,
          broker_connection_id,
          instrument,
          direction,
          route,
          bar_time,
          policy_version
        )
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS ix_m1_tactical_route_pair_side_time
      ON trading.m1_tactical_decisions (route, instrument, direction, bar_time DESC)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS ix_m1_tactical_policy_time
      ON trading.m1_tactical_decisions (policy_version, bar_time DESC)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS ix_m1_tactical_execution_link
      ON trading.m1_tactical_decisions (signal_id, trade_intent_id)
      WHERE signal_id IS NOT NULL OR trade_intent_id IS NOT NULL
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS trading.m1_tactical_decisions`);
  }
}
