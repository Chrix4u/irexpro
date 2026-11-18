import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Audit-only append ledger for a user's explicit DEMO account risk-pause
 * decision. Never stores broker credentials; never affects LIVE accounts.
 */
export class CreateDemoPortfolioBrakeConsents1795010000000 implements MigrationInterface {
  name = 'CreateDemoPortfolioBrakeConsents1795010000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS trading.demo_portfolio_brake_consents (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL,
        broker_connection_id uuid NOT NULL,
        trading_session_id uuid NOT NULL,
        incident_closed_at timestamptz NOT NULL,
        decision varchar(20) NOT NULL,
        risk_acknowledged boolean NOT NULL DEFAULT false,
        consecutive_net_losses integer NOT NULL,
        losses_net_usd numeric(20,2) NOT NULL,
        expires_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT chk_demo_portfolio_consent_decision
          CHECK (decision IN ('RESUME', 'KEEP_PAUSED')),
        CONSTRAINT chk_demo_portfolio_consent_risk_ack
          CHECK (decision <> 'RESUME' OR risk_acknowledged = true),
        CONSTRAINT chk_demo_portfolio_consent_expires
          CHECK (expires_at > incident_closed_at),
        CONSTRAINT chk_demo_portfolio_consent_losses
          CHECK (consecutive_net_losses >= 3 AND losses_net_usd < 0)
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_demo_brake_consents_incident
      ON trading.demo_portfolio_brake_consents
        (user_id,broker_connection_id,trading_session_id,incident_closed_at,created_at DESC,id DESC)
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS trading.demo_portfolio_brake_consents');
  }
}
