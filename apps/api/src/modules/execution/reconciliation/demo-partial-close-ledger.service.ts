import { ConflictException, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { exactHalfLotSplit } from './zai-p1-reversal-demo-canary';

/**
 * Durable, tenant-scoped reservation for the first cTrader DEMO P1 partial leg.
 *
 * NOT CONNECTED TO EXECUTION. No broker adapter or ExecutionOrchestrator
 * dependency, and no caller receives dispatch authority. All existing
 * protective closes remain unchanged.
 */
export interface DemoPartialReserveResult {
  ledgerId: string;
  clientOrderId: string;
  state: 'RESERVED' | 'DISPATCHING' | 'RECONCILIATION_PENDING' | 'REJECTED' | 'CONFIRMED';
  originalLots: string;
  requestedCloseLots: string;
  idempotent: boolean;
  /** Immutable guard. A reservation must never itself authorize an order. */
  canDispatchOrder: false;
}

interface TradeReservationRow {
  id: string;
  broker_connection_id: string;
  external_position_id: string | null;
  lot_size: string;
  account_currency: string | null;
  status: string;
  strategy_route: string | null;
  logical_account_key: string | null;
  broker_id: string;
  account_type: string;
  connection_currency: string | null;
  connection_logical_account_key: string | null;
  session_status: string;
  execution_mode: string;
  session_currency: string | null;
}

interface LegReservationRow {
  id: string;
  client_order_id: string;
  state: DemoPartialReserveResult['state'];
  original_lots: string;
  requested_close_lots: string;
  broker_position_id: string;
  broker_connection_id: string;
  account_currency: string;
}

const STRATEGY_ARTIFACT = 'zai-p1-reversal-demo-partial-leg-v1';

@Injectable()
export class DemoPartialCloseLedgerService {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * Reserve an isolated 0.02-lot DEMO candidate once under a trade row lock.
   * This does not assert fresh trend evidence or issue/permit a broker command;
   * those gates must be verified again at the future dispatch boundary.
   */
  async reservePilot(userId: string, tradeId: string): Promise<DemoPartialReserveResult> {
    return this.dataSource.transaction(async (manager) => {
      const trades: TradeReservationRow[] = await manager.query(
        `SELECT t.id, t.broker_connection_id, t.external_position_id,
                t.lot_size::text AS lot_size, t.account_currency,
                t.status, t.logical_account_key,
                COALESCE(
                  NULLIF(ti.metadata->>'multimodel_plan_b_route', ''),
                  CASE NULLIF(ti.metadata->>'m1_tactical_route', '')
                    WHEN 'M1_CONFIRMED_REVERSAL' THEN 'CONFIRMED_REVERSAL'
                    ELSE NULLIF(ti.metadata->>'m1_tactical_route', '')
                  END
                ) AS strategy_route,
                b.broker_id, b.account_type, b.account_currency AS connection_currency,
                b.logical_account_key AS connection_logical_account_key,
                s.status AS session_status, s.execution_mode,
                s.account_currency AS session_currency
           FROM trading.trades t
           JOIN broker.broker_connections b
             ON b.id = t.broker_connection_id AND b.user_id = t.user_id
           JOIN trading.trade_intents ti
             ON ti.id = t.trade_intent_id AND ti.user_id = t.user_id
           JOIN trading.trading_sessions s
             ON s.id = t.trading_session_id AND s.user_id = t.user_id
            AND s.broker_connection_id = t.broker_connection_id
          WHERE t.user_id = $1 AND t.id = $2 AND b.deleted_at IS NULL
          FOR UPDATE OF t`,
        [userId, tradeId],
      );
      const trade = trades[0];
      if (
        !trade ||
        trade.status !== 'OPEN' ||
        trade.broker_id !== 'ctrader' ||
        trade.account_type !== 'DEMO' ||
        trade.session_status !== 'ACTIVE' ||
        trade.execution_mode !== 'FULL_AUTO' ||
        trade.session_currency !== trade.account_currency ||
        trade.strategy_route !== 'CONFIRMED_REVERSAL' ||
        !trade.external_position_id ||
        !trade.account_currency ||
        !/^[A-Z]{3}$/.test(trade.account_currency) ||
        trade.account_currency !== trade.connection_currency ||
        !trade.logical_account_key ||
        trade.logical_account_key !== trade.connection_logical_account_key
      ) {
        throw new ConflictException(
          'Partial-close pilot is not eligible for this exact open cTrader DEMO trade.',
        );
      }
      const split = exactHalfLotSplit(trade.lot_size);
      // Enforce minimum-volume canary, not an open-ended position-size increase.
      if (!split || trade.lot_size !== '0.0200' || split.half !== '0.0100') {
        throw new ConflictException(
          'Partial-close pilot is restricted to exact 0.02-lot positions.',
        );
      }
      const clientOrderId = `zai-p1-partial-${trade.id}`;

      // A DB row lock serializes same-trade reservations across API replicas.
      // Return an existing matching reservation idempotently, never an order.
      const prior: LegReservationRow[] = await manager.query(
        `SELECT id, client_order_id, state, original_lots::text AS original_lots,
                requested_close_lots::text AS requested_close_lots,
                broker_position_id, broker_connection_id, account_currency
           FROM trading.demo_partial_close_legs
          WHERE user_id = $1 AND trade_id = $2 AND strategy_artifact = $3
          ORDER BY created_at DESC
          LIMIT 1`,
        [userId, trade.id, STRATEGY_ARTIFACT],
      );
      const existing = prior[0];
      if (existing) {
        if (
          existing.client_order_id !== clientOrderId ||
          existing.broker_connection_id !== trade.broker_connection_id ||
          existing.broker_position_id !== trade.external_position_id ||
          existing.account_currency !== trade.account_currency ||
          existing.original_lots !== trade.lot_size ||
          existing.requested_close_lots !== split.half
        ) {
          throw new ConflictException(
            'Partial-close reservation conflicts with persisted broker or volume evidence.',
          );
        }
        return this.asResult(existing, true);
      }

      const inserted: LegReservationRow[] = await manager.query(
        `INSERT INTO trading.demo_partial_close_legs (
            user_id, trade_id, broker_connection_id, broker_position_id,
            client_order_id, account_currency, original_lots, requested_close_lots
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          ON CONFLICT DO NOTHING
          RETURNING id, client_order_id, state, original_lots::text AS original_lots,
                    requested_close_lots::text AS requested_close_lots,
                    broker_position_id, broker_connection_id, account_currency`,
        [
          userId,
          trade.id,
          trade.broker_connection_id,
          trade.external_position_id,
          clientOrderId,
          trade.account_currency,
          trade.lot_size,
          split.half,
        ],
      );
      if (!inserted[0]) {
        throw new ConflictException(
          'Partial-close candidate has a conflicting reservation; no action taken.',
        );
      }
      return this.asResult(inserted[0], false);
    });
  }

  private asResult(row: LegReservationRow, idempotent: boolean): DemoPartialReserveResult {
    return {
      ledgerId: row.id,
      clientOrderId: row.client_order_id,
      state: row.state,
      originalLots: row.original_lots,
      requestedCloseLots: row.requested_close_lots,
      idempotent,
      canDispatchOrder: false,
    };
  }
}
