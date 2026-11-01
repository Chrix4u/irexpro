import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * cTrader can report a closed position without a specific provider close
 * reason. Older reconciliation therefore persisted BROKER_CLOSE even when the
 * authoritative provider exit price proves the original SL or TP barrier.
 *
 * This migration corrects only rows with valid entry/SL/TP geometry and an
 * exit at/crossed or within one pip of the relevant barrier. Ambiguous rows
 * remain BROKER_CLOSE. No economic fields are changed.
 */
export class BackfillBrokerCloseBarrierReasons1793495100000 implements MigrationInterface {
  name = 'BackfillBrokerCloseBarrierReasons1793495100000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE trading.trades AS t
      SET close_reason = 'STOP_LOSS_HIT',
          updated_at = NOW()
      FROM broker.broker_connections AS c
      WHERE c.id = t.broker_connection_id
        AND c.broker_id IN ('ctrader', 'pepperstone-ctrader', 'icmarkets-ctrader')
        AND t.status = 'CLOSED'
        AND close_reason = 'BROKER_CLOSE'
        AND exit_price IS NOT NULL
        AND exit_price > 0
        AND COALESCE(fill_price, requested_entry_price) IS NOT NULL
        AND COALESCE(fill_price, requested_entry_price) > 0
        AND stop_loss IS NOT NULL
        AND stop_loss > 0
        AND take_profit IS NOT NULL
        AND take_profit > 0
        AND (
          (
            direction = 'BUY'
            AND stop_loss < COALESCE(fill_price, requested_entry_price)
            AND take_profit > COALESCE(fill_price, requested_entry_price)
            AND exit_price - stop_loss <= CASE
              WHEN UPPER(instrument) LIKE '%JPY' THEN 0.01::numeric
              ELSE 0.0001::numeric
            END
          )
          OR
          (
            direction = 'SELL'
            AND stop_loss > COALESCE(fill_price, requested_entry_price)
            AND take_profit < COALESCE(fill_price, requested_entry_price)
            AND stop_loss - exit_price <= CASE
              WHEN UPPER(instrument) LIKE '%JPY' THEN 0.01::numeric
              ELSE 0.0001::numeric
            END
          )
        )
    `);

    await queryRunner.query(`
      UPDATE trading.trades AS t
      SET close_reason = 'TAKE_PROFIT_HIT',
          updated_at = NOW()
      FROM broker.broker_connections AS c
      WHERE c.id = t.broker_connection_id
        AND c.broker_id IN ('ctrader', 'pepperstone-ctrader', 'icmarkets-ctrader')
        AND t.status = 'CLOSED'
        AND close_reason = 'BROKER_CLOSE'
        AND exit_price IS NOT NULL
        AND exit_price > 0
        AND COALESCE(fill_price, requested_entry_price) IS NOT NULL
        AND COALESCE(fill_price, requested_entry_price) > 0
        AND stop_loss IS NOT NULL
        AND stop_loss > 0
        AND take_profit IS NOT NULL
        AND take_profit > 0
        AND (
          (
            direction = 'BUY'
            AND stop_loss < COALESCE(fill_price, requested_entry_price)
            AND take_profit > COALESCE(fill_price, requested_entry_price)
            AND take_profit - exit_price <= CASE
              WHEN UPPER(instrument) LIKE '%JPY' THEN 0.01::numeric
              ELSE 0.0001::numeric
            END
          )
          OR
          (
            direction = 'SELL'
            AND stop_loss > COALESCE(fill_price, requested_entry_price)
            AND take_profit < COALESCE(fill_price, requested_entry_price)
            AND exit_price - take_profit <= CASE
              WHEN UPPER(instrument) LIKE '%JPY' THEN 0.01::numeric
              ELSE 0.0001::numeric
            END
          )
        )
    `);
  }

  async down(_queryRunner: QueryRunner): Promise<void> {
    // Intentionally irreversible: once barrier provenance is corrected there
    // is no safe way to distinguish these rows from natively reported SL/TP.
  }
}
