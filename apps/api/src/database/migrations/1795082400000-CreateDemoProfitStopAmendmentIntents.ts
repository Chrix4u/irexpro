import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * An additive, DEMO-only *intent* ledger for eventually authorizing a
 * broker-side positive stop. Schema alone does not amend or hold positions.
 * Never grant trading authority from a request, acknowledgement, or quote.
 * The final state requires readback of the broker stop AND authoritative
 * internal stop persistence; separate orchestration is not yet active.
 */
export class CreateDemoProfitStopAmendmentIntents1795082400000 implements MigrationInterface {
  name = 'CreateDemoProfitStopAmendmentIntents1795082400000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS trading.demo_profit_stop_amendment_intents (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL,
        trade_id uuid NOT NULL REFERENCES trading.trades(id) ON DELETE RESTRICT,
        broker_connection_id uuid NOT NULL,
        broker_id varchar(40) NOT NULL DEFAULT 'pepperstone-ctrader',
        account_type varchar(8) NOT NULL DEFAULT 'DEMO',
        account_currency varchar(3) NOT NULL DEFAULT 'USD',
        strategy_route varchar(40) NOT NULL,
        broker_position_id varchar(255) NOT NULL,
        client_request_id varchar(255) NOT NULL UNIQUE,
        instrument varchar(12) NOT NULL,
        direction varchar(6) NOT NULL,
        trade_lots numeric(10,4) NOT NULL,
        entry_price numeric(18,8) NOT NULL,
        original_stop numeric(18,8) NOT NULL,
        original_take_profit numeric(18,8) NOT NULL,
        proposed_positive_stop numeric(18,8) NOT NULL,
        broker_quote_bid numeric(18,8) NOT NULL,
        broker_quote_ask numeric(18,8) NOT NULL,
        broker_quote_at timestamptz NOT NULL,
        estimated_exit_cost_reserve numeric(18,8) NOT NULL,
        estimated_net_floor_after_reserve numeric(18,8) NOT NULL,
        state varchar(40) NOT NULL DEFAULT 'PREPARED',
        broker_ack_at timestamptz NULL,
        broker_readback_stop numeric(18,8) NULL,
        broker_verified_at timestamptz NULL,
        authority_committed_at timestamptz NULL,
        last_error_code varchar(100) NULL,
        expires_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT ck_demo_profit_stop_broker CHECK (broker_id = 'pepperstone-ctrader'),
        CONSTRAINT ck_demo_profit_stop_demo CHECK (account_type = 'DEMO'),
        CONSTRAINT ck_demo_profit_stop_currency CHECK (account_currency = 'USD'),
        CONSTRAINT ck_demo_profit_stop_route CHECK (
          strategy_route IN ('EARLY_TRANSITION','CONFIRMED_REVERSAL')
        ),
        CONSTRAINT ck_demo_profit_stop_direction CHECK (direction IN ('BUY','SELL')),
        CONSTRAINT ck_demo_profit_stop_instrument CHECK (
          instrument IN ('EURUSD','GBPUSD','AUDUSD','USDJPY','USDCAD','USDCHF')
        ),
        CONSTRAINT ck_demo_profit_stop_states CHECK (
          state IN ('PREPARED','DISPATCHING','ACKNOWLEDGED',
                    'BROKER_VERIFIED','AUTHORITY_COMMITTED',
                    'FAILED','EXPIRED','NEEDS_MANUAL_RECONCILIATION')
        ),
        CONSTRAINT ck_demo_profit_stop_prices_positive CHECK (
          trade_lots > 0 AND entry_price > 0 AND original_stop > 0
          AND original_take_profit > 0 AND proposed_positive_stop > 0
          AND broker_quote_bid > 0 AND broker_quote_ask > broker_quote_bid
          AND estimated_exit_cost_reserve > 0
          AND estimated_net_floor_after_reserve > 0
        ),
        CONSTRAINT ck_demo_profit_stop_risk_reducing CHECK (
          (direction='BUY'
            AND original_stop < entry_price
            AND entry_price < proposed_positive_stop
            AND proposed_positive_stop < original_take_profit)
          OR
          (direction='SELL'
            AND original_take_profit < proposed_positive_stop
            AND proposed_positive_stop < entry_price
            AND entry_price < original_stop)
        ),
        CONSTRAINT ck_demo_profit_stop_time_window CHECK (
          expires_at > broker_quote_at
        ),
        CONSTRAINT ck_demo_profit_stop_ack_proof CHECK (
          state NOT IN ('ACKNOWLEDGED','BROKER_VERIFIED','AUTHORITY_COMMITTED')
          OR broker_ack_at IS NOT NULL
        ),
        CONSTRAINT ck_demo_profit_stop_provider_proof CHECK (
          state NOT IN ('BROKER_VERIFIED','AUTHORITY_COMMITTED')
          OR (
            broker_verified_at IS NOT NULL
            AND broker_readback_stop IS NOT NULL
            AND broker_readback_stop = proposed_positive_stop
          )
        ),
        CONSTRAINT ck_demo_profit_stop_authority_proof CHECK (
          state <> 'AUTHORITY_COMMITTED' OR (
            authority_committed_at IS NOT NULL
            AND broker_ack_at IS NOT NULL
            AND broker_verified_at IS NOT NULL
            AND broker_readback_stop = proposed_positive_stop
          )
        )
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_demo_profit_stop_unresolved_trade
      ON trading.demo_profit_stop_amendment_intents(trade_id)
      WHERE state IN ('PREPARED','DISPATCHING','ACKNOWLEDGED',
                      'BROKER_VERIFIED','NEEDS_MANUAL_RECONCILIATION')
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS ix_demo_profit_stop_owner
      ON trading.demo_profit_stop_amendment_intents(
        user_id, broker_connection_id, trade_id, created_at DESC
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS ix_demo_profit_stop_unresolved
      ON trading.demo_profit_stop_amendment_intents(state, updated_at)
      WHERE state IN ('DISPATCHING','ACKNOWLEDGED',
                      'BROKER_VERIFIED','NEEDS_MANUAL_RECONCILIATION')
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    // Explicit schema rollback only. Never run while amendments are in flight.
    await queryRunner.query('DROP TABLE IF EXISTS trading.demo_profit_stop_amendment_intents');
  }
}
