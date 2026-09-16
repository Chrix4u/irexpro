import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Round 6 live-execution completion (§3) — the portfolio allocation engine.
 *
 * Forward-only, additive, NULL-preserving (migration discipline §29).
 *
 * A. trading.capital_budgets — the EXPLICIT per-account capital allocation
 *    baseline. UNIQUE (user_id, logical_account_key): one budget per user
 *    per logical broker account. Seeded ONCE from the authoritative broker
 *    account snapshot (§1a routing) at first allocation and explicit
 *    thereafter — never re-derived from drifting equity, never defaulted.
 *    Optional concentration caps (percent of total capital, NULL = the cap
 *    is not enforced for this account).
 *
 * B. trading.capital_allocations — the durable allocation LEDGER. One row
 *    per TradeIntent (UNIQUE trade_intent_id — the database-level
 *    exactly-once guard against double allocation for the same AI decision,
 *    §3/§13). The aggregate accounting JOINs trade_intents + trades so the
 *    counted commitment always reflects the CURRENT durable truth:
 *      - in-flight   = intent CREATED, no trade yet
 *      - pending     = trade PENDING (order submitted/awaiting provider)
 *      - open        = trade OPEN / RECONCILIATION_PENDING (live exposure)
 *    Trades that closed/rejected/cancelled and intents that expired or were
 *    rejected stop counting automatically — the aggregate self-heals from
 *    authoritative state (§9: broker/durable truth wins over local intent).
 *
 *    allocated_lots/allocated_capital are ExactDecimal-computed decimal
 *    strings — NO JavaScript floating-point capital math anywhere (§3).
 *    sizing_inputs persists the FULL §4 reconstruction record (equity, risk
 *    percent, stop-loss distance, contract size, instrument constraints,
 *    computed intermediates).
 */
export class PortfolioAllocationRound6LiveCompletion1754500000000 implements MigrationInterface {
  name = 'PortfolioAllocationRound6LiveCompletion1754500000000';
  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── A. capital_budgets ──────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS trading.capital_budgets (
        id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id                     uuid NOT NULL,
        logical_account_key         varchar(255) NOT NULL,
        account_currency            varchar(3) NOT NULL,
        total_capital               numeric(18,8) NOT NULL,
        max_instrument_concentration numeric(5,2) NULL,
        max_strategy_concentration  numeric(5,2) NULL,
        created_at                  timestamptz NOT NULL DEFAULT now(),
        updated_at                  timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_capital_budgets_user_account UNIQUE (user_id, logical_account_key),
        CONSTRAINT ck_capital_budgets_total_positive CHECK (total_capital > 0),
        CONSTRAINT ck_capital_budgets_currency CHECK (account_currency ~ '^[A-Z]{3}$')
      )
    `);

    // ── B. capital_allocations ──────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS trading.capital_allocations (
        id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id                     uuid NOT NULL,
        trade_intent_id             uuid NOT NULL,
        broker_connection_id        uuid NOT NULL,
        logical_account_key         varchar(255) NOT NULL,
        account_currency            varchar(3) NOT NULL,
        instrument                  varchar(30) NOT NULL,
        direction                   varchar(4) NOT NULL,
        strategy_code               varchar(100) NULL,
        allocated_lots              numeric(10,4) NOT NULL,
        allocated_capital           numeric(18,8) NOT NULL,
        status                      varchar(20) NOT NULL DEFAULT 'ACTIVE',
        sizing_inputs               jsonb NOT NULL,
        released_reason             varchar(60) NULL,
        created_at                  timestamptz NOT NULL DEFAULT now(),
        updated_at                  timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_capital_allocations_intent UNIQUE (trade_intent_id),
        CONSTRAINT ck_capital_allocations_direction CHECK (direction IN ('BUY', 'SELL')),
        CONSTRAINT ck_capital_allocations_status CHECK (status IN ('ACTIVE', 'RELEASED')),
        CONSTRAINT ck_capital_allocations_lots_positive CHECK (allocated_lots > 0),
        CONSTRAINT ck_capital_allocations_capital_positive CHECK (allocated_capital > 0)
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS ix_capital_allocations_user_account
         ON trading.capital_allocations (user_id, logical_account_key, status)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS ix_capital_allocations_instrument
         ON trading.capital_allocations (user_id, logical_account_key, instrument, status)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS trading.ix_capital_allocations_instrument`);
    await queryRunner.query(`DROP INDEX IF EXISTS trading.ix_capital_allocations_user_account`);
    await queryRunner.query(`DROP TABLE IF EXISTS trading.capital_allocations`);
    await queryRunner.query(`DROP TABLE IF EXISTS trading.capital_budgets`);
  }
}
