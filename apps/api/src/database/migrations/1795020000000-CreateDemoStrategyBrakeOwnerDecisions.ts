import { MigrationInterface, QueryRunner } from 'typeorm';

/** Per-incident, per-route owner decision for Pepperstone USD DEMO only. */
export class CreateDemoStrategyBrakeOwnerDecisions1795020000000 implements MigrationInterface {
  name = 'CreateDemoStrategyBrakeOwnerDecisions1795020000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS trading.demo_strategy_brake_owner_decisions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL,
        broker_connection_id uuid NOT NULL,
        trading_session_id uuid NOT NULL,
        strategy_route varchar(24) NOT NULL,
        instrument varchar(8) NOT NULL,
        direction varchar(4) NOT NULL,
        brake_reason varchar(48) NOT NULL,
        incident_closed_at timestamptz NOT NULL,
        decision varchar(24) NOT NULL,
        risk_acknowledged boolean NOT NULL DEFAULT false,
        expires_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT chk_demo_strategy_owner_route
          CHECK (strategy_route IN ('EARLY_TRANSITION', 'CONFIRMED_REVERSAL')),
        CONSTRAINT chk_demo_strategy_owner_direction
          CHECK (direction IN ('BUY', 'SELL')),
        CONSTRAINT chk_demo_strategy_owner_decision
          CHECK (decision IN ('KEEP_PAUSED','RESUME_LIMITED')),
        CONSTRAINT chk_demo_strategy_owner_risk_ack
          CHECK (decision <> 'RESUME_LIMITED' OR risk_acknowledged = true),
        CONSTRAINT chk_demo_strategy_owner_expiry
          CHECK (expires_at > created_at AND expires_at <= created_at + interval '1 hour')
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_demo_strategy_brake_owner_latest
      ON trading.demo_strategy_brake_owner_decisions
      (user_id,broker_connection_id,trading_session_id,
       strategy_route,instrument,direction,incident_closed_at,
       created_at DESC,id DESC)
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS trading.demo_strategy_brake_owner_decisions');
  }
}
