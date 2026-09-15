import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Round 6 live-execution completion (§2) — the durable TradeIntent layer.
 *
 * Forward-only, additive, NULL-preserving (migration discipline §29).
 *
 * A. trading.trade_intents — the normalized, durable form of ONE AI/model
 *    decision, recorded at signal intake BEFORE risk evaluation. UNIQUE
 *    (user_id, intent_key) is the database-level exactly-once guard: the
 *    same AI decision can never produce duplicate equivalent trade intents
 *    after retries, reconnects, worker restarts or queue redelivery.
 *
 * B. trading.trades.trade_intent_id — the provenance link from the executed
 *    trade back to its originating intent (§20 reconstruction chain).
 */
export class TradeIntentRound6LiveCompletion1754400000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── A. trade_intents ────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS trading.trade_intents (
        id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id                     uuid NOT NULL,
        intent_key                  varchar(255) NOT NULL,
        signal_id                   varchar(100) NOT NULL,
        signal_generated_at         timestamptz NOT NULL,
        broker_connection_id        uuid NOT NULL,
        logical_account_key         varchar(255) NULL,
        trading_session_id          uuid NULL,
        strategy_code               varchar(100) NULL,
        model_version               varchar(100) NULL,
        timeframe                   varchar(20) NULL,
        instrument                  varchar(30) NOT NULL,
        direction                   varchar(4) NOT NULL,
        entry_type                  varchar(20) NOT NULL DEFAULT 'MARKET',
        requested_lot_size          numeric(10, 4) NOT NULL,
        requested_entry_price       numeric(18, 8) NULL,
        stop_loss                   numeric(18, 8) NULL,
        take_profit                 numeric(18, 8) NULL,
        trailing_stop_pips          numeric(10, 2) NULL,
        expires_at                  timestamptz NOT NULL,
        market_data_ref             jsonb NULL,
        rationale                   text NULL,
        metadata                    jsonb NULL,
        authority_generation        integer NOT NULL,
        trading_policy_revision     integer NULL,
        provider_verification_revision integer NULL,
        execution_control_revision  integer NULL,
        status                      varchar(20) NOT NULL DEFAULT 'CREATED',
        trade_id                    uuid NULL,
        created_at                  timestamptz NOT NULL DEFAULT now(),
        updated_at                  timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_trade_intents_user_intent_key UNIQUE (user_id, intent_key),
        CONSTRAINT ck_trade_intents_direction CHECK (direction IN ('BUY', 'SELL')),
        CONSTRAINT ck_trade_intents_entry_type
          CHECK (entry_type IN ('MARKET', 'LIMIT', 'STOP', 'STOP_LIMIT')),
        CONSTRAINT ck_trade_intents_status
          CHECK (status IN ('CREATED', 'EXECUTED', 'REJECTED', 'EXPIRED', 'SUPERSEDED')),
        CONSTRAINT ck_trade_intents_authority_generation_nonneg
          CHECK (authority_generation >= 1)
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS ix_trade_intents_user_status ON trading.trade_intents (user_id, status)`,
    );

    // ── B. trades.trade_intent_id provenance link ──────────────────────────
    // Legacy rows stay NULL (never guessed — the intent is only known for
    // trades executed through the §2 pipeline).
    await queryRunner.query(`
      ALTER TABLE trading.trades
        ADD COLUMN IF NOT EXISTS trade_intent_id uuid NULL
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS ix_trades_trade_intent_id ON trading.trades (trade_intent_id)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS trading.ix_trades_trade_intent_id`);
    await queryRunner.query(`ALTER TABLE trading.trades DROP COLUMN IF EXISTS trade_intent_id`);
    await queryRunner.query(`DROP INDEX IF EXISTS trading.ix_trade_intents_user_status`);
    await queryRunner.query(`DROP TABLE IF EXISTS trading.trade_intents`);
  }
}
