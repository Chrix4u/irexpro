import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Durable provider-state authority for the built-in PAPER_ONLY broker.
 *
 * The paper adapter used to retain provider state only in process memory.
 * A deploy/restart therefore recreated a pristine 10,000 USD provider while
 * durable trading.trades could still contain OPEN positions. Reconciliation
 * correctly refused to overwrite durable truth, but the position then became
 * impossible for the simulator to manage/close.
 *
 * This table makes the simulated provider restart-safe. The backfill is
 * deliberately conservative: it restores currently OPEN durable trades,
 * the provider order sequence, the latest account balance, and an inferred
 * deterministic-feed tick counter. Historic CLOSED rows without provider
 * economics are not fabricated.
 */
export class CreateDurablePaperBrokerState1754900000000 implements MigrationInterface {
  name = 'CreateDurablePaperBrokerState1754900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS broker.paper_broker_states (
        connection_id uuid PRIMARY KEY
          REFERENCES broker.broker_connections(id) ON DELETE CASCADE,
        state_version integer NOT NULL DEFAULT 1,
        state jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT ck_paper_broker_states_version CHECK (state_version = 1),
        CONSTRAINT ck_paper_broker_states_json_object
          CHECK (jsonb_typeof(state) = 'object')
      )
    `);

    await queryRunner.query(`
      WITH paper_connections AS (
        SELECT id
        FROM broker.broker_connections
        WHERE broker_id = 'paper-broker'
      ),
      current_open_bounds AS (
        SELECT
          t.broker_connection_id,
          MIN(t.opened_at) AS first_opened_at
        FROM trading.trades t
        JOIN paper_connections pc ON pc.id = t.broker_connection_id
        WHERE t.status = 'OPEN'
          AND t.opened_at IS NOT NULL
        GROUP BY t.broker_connection_id
      ),
      last_open_snapshot AS (
        SELECT DISTINCT ON (s.connection_id)
          s.connection_id,
          s.balance
        FROM broker.broker_account_snapshots s
        JOIN current_open_bounds ob ON ob.broker_connection_id = s.connection_id
        WHERE COALESCE(s.open_positions_count, 0) > 0
          AND s.accepted_at >= ob.first_opened_at
        ORDER BY s.connection_id, s.accepted_at DESC
      ),
      counters AS (
        SELECT
          t.broker_connection_id,
          COALESCE(
            MAX(
              CASE
                WHEN t.external_order_id ~ '^paper-order-[0-9]+$'
                THEN substring(t.external_order_id from 'paper-order-([0-9]+)')::integer
              END
            ),
            0
          ) AS order_counter
        FROM trading.trades t
        JOIN paper_connections pc ON pc.id = t.broker_connection_id
        GROUP BY t.broker_connection_id
      ),
      latest_fill AS (
        SELECT DISTINCT ON (t.broker_connection_id)
          t.broker_connection_id,
          t.fill_price
        FROM trading.trades t
        JOIN paper_connections pc ON pc.id = t.broker_connection_id
        WHERE t.fill_price IS NOT NULL
          AND t.external_order_id ~ '^paper-order-[0-9]+$'
        ORDER BY t.broker_connection_id, t.opened_at DESC NULLS LAST, t.created_at DESC
      ),
      open_state AS (
        SELECT
          t.broker_connection_id,
          COALESCE(
            jsonb_agg(
              jsonb_build_object(
                'positionId', t.external_order_id,
                'dedupeKey', t.idempotency_key,
                'comment', 'recovered-from-durable-trade',
                'instrument', t.instrument,
                'direction', t.direction,
                'units', (round(t.lot_size * 100000)::bigint)::text,
                'lotSize', t.lot_size::text,
                'entryPrice', COALESCE(t.fill_price, t.requested_entry_price)::text,
                'stopLoss', t.stop_loss::text,
                'takeProfit', t.take_profit::text,
                'openedAt', t.opened_at
              )
              ORDER BY t.opened_at, t.id
            ) FILTER (
              WHERE t.status = 'OPEN'
                AND t.external_order_id IS NOT NULL
                AND t.opened_at IS NOT NULL
            ),
            '[]'::jsonb
          ) AS positions,
          COALESCE(
            jsonb_agg(
              jsonb_build_array(
                t.external_order_id,
                jsonb_build_object(
                  'providerOrderId', t.external_order_id,
                  'clientOrderId', t.idempotency_key,
                  'status', 'FILLED',
                  'instrument', t.instrument,
                  'direction', t.direction,
                  'requestedQuantity', t.lot_size::text,
                  'filledQuantity', t.lot_size::text,
                  'avgFillPrice', COALESCE(t.fill_price, t.requested_entry_price)::text,
                  'orderKind', 'MARKET',
                  'limitPrice', NULL,
                  'stopPrice', NULL,
                  'timeInForce', 'GTC',
                  'placedAt', t.opened_at,
                  'updatedAt', t.updated_at
                )
              )
              ORDER BY t.opened_at, t.id
            ) FILTER (
              WHERE t.status = 'OPEN'
                AND t.external_order_id IS NOT NULL
                AND t.opened_at IS NOT NULL
            ),
            '[]'::jsonb
          ) AS order_states,
          COALESCE(
            jsonb_agg(
              jsonb_build_array(
                t.idempotency_key,
                jsonb_build_object(
                  'success', true,
                  'externalOrderId', t.external_order_id,
                  'filledPrice', COALESCE(t.fill_price, t.requested_entry_price)::text,
                  'filledQuantity', t.lot_size::text,
                  'filledAt', t.opened_at,
                  'status', 'FILLED',
                  'brokerMessage', 'PAPER_ONLY recovered durable fill'
                )
              )
              ORDER BY t.opened_at, t.id
            ) FILTER (
              WHERE t.status = 'OPEN'
                AND t.external_order_id IS NOT NULL
                AND t.idempotency_key IS NOT NULL
                AND t.opened_at IS NOT NULL
            ),
            '[]'::jsonb
          ) AS dedupe_results
        FROM trading.trades t
        JOIN paper_connections pc ON pc.id = t.broker_connection_id
        GROUP BY t.broker_connection_id
      )
      INSERT INTO broker.paper_broker_states
        (connection_id, state_version, state, created_at, updated_at)
      SELECT
        pc.id,
        1,
        jsonb_build_object(
          'version', 1,
          'orderCounter', COALESCE(c.order_counter, 0),
          'marketTickCounter',
            CASE
              WHEN lf.fill_price IS NULL THEN 0
              ELSE GREATEST(
                0,
                2 * (
                  (
                    round(lf.fill_price * 100000)::bigint
                    - 110005
                  ) / 10
                )
              )
            END,
          'balance', COALESCE(los.balance::text, ba.balance::text, '10000.00'),
          'working', '[]'::jsonb,
          'positions', COALESCE(os.positions, '[]'::jsonb),
          'closedTrades', '[]'::jsonb,
          'orderStates', COALESCE(os.order_states, '[]'::jsonb),
          'resultsByDedupeKey', COALESCE(os.dedupe_results, '[]'::jsonb)
        ),
        now(),
        now()
      FROM paper_connections pc
      LEFT JOIN counters c ON c.broker_connection_id = pc.id
      LEFT JOIN latest_fill lf ON lf.broker_connection_id = pc.id
      LEFT JOIN open_state os ON os.broker_connection_id = pc.id
      LEFT JOIN last_open_snapshot los ON los.connection_id = pc.id
      LEFT JOIN broker.broker_accounts ba ON ba.broker_connection_id = pc.id
      ON CONFLICT (connection_id) DO NOTHING
    `);

    const invalid = await queryRunner.query(`
      SELECT connection_id
      FROM broker.paper_broker_states
      WHERE state_version <> 1
         OR jsonb_typeof(state) <> 'object'
         OR NOT (state ? 'orderCounter')
         OR NOT (state ? 'marketTickCounter')
         OR NOT (state ? 'balance')
         OR NOT (state ? 'positions')
      LIMIT 10
    `);
    if (Array.isArray(invalid) && invalid.length > 0) {
      throw new Error('Durable paper broker state backfill verification failed.');
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS broker.paper_broker_states');
  }
}
