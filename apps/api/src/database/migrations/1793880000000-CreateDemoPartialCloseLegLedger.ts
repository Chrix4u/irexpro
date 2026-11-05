import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Durable accounting foundation for a future cTrader DEMO partial close.
 * SCHEMA ONLY: no service dispatches or writes this table in this release.
 *
 * No partial fills may be counted as authoritative until the provider's
 * before/after volume, deal identity and economics have been reconciled.
 */
export class CreateDemoPartialCloseLegLedger1793880000000 implements MigrationInterface {
  name = 'CreateDemoPartialCloseLegLedger1793880000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS trading.demo_partial_close_legs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL,
        trade_id uuid NOT NULL REFERENCES trading.trades(id) ON DELETE RESTRICT,
        broker_connection_id uuid NOT NULL,
        broker_id varchar(30) NOT NULL DEFAULT 'ctrader',
        account_type varchar(8) NOT NULL DEFAULT 'DEMO',
        broker_position_id varchar(255) NOT NULL,
        client_order_id varchar(255) NOT NULL,
        strategy_artifact varchar(100) NOT NULL DEFAULT 'zai-p1-reversal-demo-partial-leg-v1',
        provider_order_id varchar(255) NULL,
        provider_deal_id varchar(255) NULL,
        account_currency varchar(3) NOT NULL,
        original_lots numeric(10,4) NOT NULL,
        requested_close_lots numeric(10,4) NOT NULL,
        broker_lots_before numeric(10,4) NULL,
        broker_filled_lots numeric(10,4) NULL,
        broker_lots_after numeric(10,4) NULL,
        gross_realised_pnl numeric(18,8) NULL,
        commission numeric(18,8) NULL,
        swap numeric(18,8) NULL,
        economics_complete boolean NOT NULL DEFAULT false,
        state varchar(32) NOT NULL DEFAULT 'RESERVED',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        confirmed_at timestamptz NULL,
        CONSTRAINT uq_demo_partial_close_client_order UNIQUE (client_order_id),
        CONSTRAINT ck_demo_partial_close_broker CHECK (broker_id = 'ctrader'),
        CONSTRAINT ck_demo_partial_close_demo_only CHECK (account_type = 'DEMO'),
        CONSTRAINT ck_demo_partial_close_artifact CHECK (
          strategy_artifact = 'zai-p1-reversal-demo-partial-leg-v1'
        ),
        CONSTRAINT ck_demo_partial_close_currency CHECK (account_currency ~ '^[A-Z]{3}$'),
        CONSTRAINT ck_demo_partial_close_state CHECK (
          state IN ('RESERVED', 'DISPATCHING', 'RECONCILIATION_PENDING', 'REJECTED', 'CONFIRMED')
        ),
        CONSTRAINT ck_demo_partial_close_positive_lots CHECK (
          original_lots > 0 AND requested_close_lots > 0
          AND requested_close_lots < original_lots
        ),
        CONSTRAINT ck_demo_partial_close_valid_provider_lots CHECK (
          (broker_lots_before IS NULL OR broker_lots_before > 0)
          AND (broker_filled_lots IS NULL OR broker_filled_lots > 0)
          AND (broker_lots_after IS NULL OR broker_lots_after >= 0)
        ),
        CONSTRAINT ck_demo_partial_close_economics_complete CHECK (
          NOT economics_complete OR (
            state = 'CONFIRMED'
            AND gross_realised_pnl IS NOT NULL
            AND commission IS NOT NULL
            AND swap IS NOT NULL
          )
        ),
        CONSTRAINT ck_demo_partial_close_confirmed_proof CHECK (
          state <> 'CONFIRMED' OR (
            provider_deal_id IS NOT NULL AND provider_deal_id <> ''
            AND broker_lots_before IS NOT NULL
            AND broker_filled_lots IS NOT NULL
            AND broker_lots_after IS NOT NULL
            AND broker_lots_before = broker_filled_lots + broker_lots_after
            AND broker_filled_lots = requested_close_lots
            AND broker_lots_before = original_lots
            AND original_lots = 2 * requested_close_lots
            AND broker_lots_after = requested_close_lots
            AND confirmed_at IS NOT NULL
          )
        )
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_demo_partial_close_inflight_trade
      ON trading.demo_partial_close_legs(trade_id)
      WHERE state IN ('RESERVED', 'DISPATCHING', 'RECONCILIATION_PENDING')
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_demo_partial_close_one_p1_per_trade
      ON trading.demo_partial_close_legs(trade_id, strategy_artifact)
      WHERE state <> 'REJECTED'
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_demo_partial_close_provider_deal
      ON trading.demo_partial_close_legs(broker_connection_id, provider_deal_id)
      WHERE provider_deal_id IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS ix_demo_partial_close_owner_trade
      ON trading.demo_partial_close_legs(user_id, trade_id, created_at DESC)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS ix_demo_partial_close_unresolved
      ON trading.demo_partial_close_legs(state, updated_at)
      WHERE state IN ('DISPATCHING', 'RECONCILIATION_PENDING')
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    // Explicit rollback only, never automatic during a trade or reconciliation.
    await queryRunner.query('DROP TABLE IF EXISTS trading.demo_partial_close_legs');
  }
}
