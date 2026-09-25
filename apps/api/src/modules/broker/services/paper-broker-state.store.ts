import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

/**
 * Durable provider-state backing store for the built-in PAPER broker.
 *
 * The paper adapter is connection-scoped and process-local by design, but the
 * simulated provider account must survive API restarts/deploys just like an
 * external DEMO broker would. The adapter owns/validates the JSON schema; this
 * store intentionally treats the payload as opaque versioned JSON.
 */
@Injectable()
export class PaperBrokerStateStore {
  constructor(private readonly dataSource: DataSource) {}

  async load(connectionId: string): Promise<unknown | null> {
    const rows: Array<{ state: unknown }> = await this.dataSource.query(
      `SELECT state
         FROM broker.paper_broker_states
        WHERE connection_id = $1`,
      [connectionId],
    );
    if (!rows[0]) return null;

    const raw = rows[0].state;
    if (typeof raw === 'string') {
      return JSON.parse(raw) as unknown;
    }
    return raw ?? null;
  }

  async loadBootstrap(connectionId: string): Promise<{
    balance: string;
    activeTradeCount: number;
    maxPaperOrderCounter: number;
  } | null> {
    const rows: Array<{
      balance: string;
      active_trade_count: string | number;
      max_paper_order_counter: string | number;
    }> = await this.dataSource.query(
      `SELECT a.balance,
              (
                SELECT COUNT(*)
                  FROM trading.trades t
                 WHERE t.broker_connection_id = a.broker_connection_id
                   AND t.status IN ('OPEN', 'PENDING', 'RECONCILIATION_PENDING')
              ) AS active_trade_count,
              (
                SELECT COALESCE(
                  MAX(
                    CASE
                      WHEN t.external_order_id ~ '^paper-order-[0-9]+$'
                      THEN substring(t.external_order_id from '[0-9]+$')::integer
                      ELSE NULL
                    END
                  ),
                  0
                )
                  FROM trading.trades t
                 WHERE t.broker_connection_id = a.broker_connection_id
              ) AS max_paper_order_counter
         FROM broker.broker_accounts a
        WHERE a.broker_connection_id = $1`,
      [connectionId],
    );

    if (!rows[0]) return null;
    return {
      balance: String(rows[0].balance),
      activeTradeCount: Number(rows[0].active_trade_count),
      maxPaperOrderCounter: Number(rows[0].max_paper_order_counter),
    };
  }

  async save(connectionId: string, state: unknown): Promise<void> {
    const encoded = JSON.stringify(state);
    await this.dataSource.query(
      `INSERT INTO broker.paper_broker_states
         (connection_id, state, revision, updated_at)
       VALUES ($1, $2::jsonb, 1, NOW())
       ON CONFLICT (connection_id) DO UPDATE
         SET state = EXCLUDED.state,
             revision = broker.paper_broker_states.revision + 1,
             updated_at = NOW()`,
      [connectionId, encoded],
    );
  }

  async remove(connectionId: string): Promise<void> {
    await this.dataSource.query(
      'DELETE FROM broker.paper_broker_states WHERE connection_id = $1',
      [connectionId],
    );
  }
}