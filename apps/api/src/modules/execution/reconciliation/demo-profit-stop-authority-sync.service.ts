import { ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { BrokerService } from '../../broker/broker.service';
import type { BrokerPosition } from '../../broker/interfaces/broker-adapter.interface';

/**
 * Internal-only authority reconciliation for a stop ALREADY installed by
 * Pepperstone DEMO. Does not send broker commands, create orders, start holds,
 * or grant permission to delay an existing profit-protection close.
 *
 * No production caller or controller is attached. Explicitly gated so it
 * cannot be invoked accidentally by a future job or other account.
 */
export interface DemoStopAuthorityCommit {
  ledgerId: string;
  tradeId: string;
  state: 'AUTHORITY_COMMITTED';
  brokerStop: string;
  committedStop: string;
  idempotent: boolean;
  brokerOrderActions: 0;
  canDelayProfitClose: false;
}

interface StopIntentRow {
  id: string;
  user_id: string;
  trade_id: string;
  broker_connection_id: string;
  broker_position_id: string;
  broker_id: string;
  account_type: string;
  account_currency: string;
  strategy_route: string;
  instrument: string;
  direction: string;
  trade_lots: string;
  entry_price: string;
  original_stop: string;
  original_take_profit: string;
  proposed_positive_stop: string;
  estimated_exit_cost_reserve: string;
  estimated_net_floor_after_reserve: string;
  broker_ack_at: Date | string | null;
  expires_at: Date | string;
  state: string;
  trade_status?: string;
  trade_currency?: string;
  trade_direction?: string;
  trade_instrument?: string;
  trade_lots_current?: string;
  trade_fill?: string | null;
  trade_stop?: string;
  trade_tp?: string;
  trade_provider_position?: string | null;
  trade_logical_key?: string | null;
  broker_logical_key?: string | null;
  connection_currency?: string;
  connection_type?: string;
  connection_broker?: string;
  route_provenance?: string | null;
}

function numeric(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
  const x = Number(v);
  return Number.isFinite(x) && x > 0 ? x : null;
}

function equalPrice(a: string | number | null | undefined, b: string | number | null | undefined): boolean {
  const x = numeric(a); const y = numeric(b);
  return x !== null && y !== null && Math.abs(x - y) <= 0.00000001;
}

function validBrokerStop(position: BrokerPosition, intent: StopIntentRow): boolean {
  const entry = numeric(position.openPrice);
  const mark = numeric(position.currentPrice);
  const brokerStop = numeric(position.stopLoss);
  const tp = numeric(position.takeProfit);
  const proposed = numeric(intent.proposed_positive_stop);
  const lot = numeric(position.lotSize);
  const requestLot = numeric(intent.trade_lots);
  if (!entry || !mark || !brokerStop || !tp || !proposed ||
    !lot || !requestLot ||
    Math.abs(lot - requestLot) > 0.00005 ||
    !equalPrice(entry, intent.entry_price) ||
    !equalPrice(brokerStop, proposed) ||
    !equalPrice(tp, intent.original_take_profit) ||
    position.instrument !== intent.instrument ||
    position.direction !== intent.direction ||
    position.externalOrderId !== intent.broker_position_id) return false;
  const tick = intent.instrument.endsWith('JPY') ? 0.001 : 0.00001;
  return intent.direction === 'BUY'
    ? proposed > entry + tick && proposed < mark - 2 * tick &&
      proposed < tp - tick
    : proposed < entry - tick && proposed > mark + 2 * tick &&
      proposed > tp + tick;
}

@Injectable()
export class DemoProfitStopAuthoritySyncService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly brokerService: BrokerService,
  ) {}

  /**
   * Read the broker position BEFORE starting the short database transaction.
   * In the transaction, lock ledger + trade, verify all provenance again,
   * and update both the trade stop and the ledger in one DB commit.
   */
  async commitVerifiedStop(
    userId: string,
    ledgerId: string,
  ): Promise<DemoStopAuthorityCommit> {
    if (
      process.env.IREXPRO_PEPPERSTONE_DEMO_STOP_AUTHORITY_SYNC !== 'enabled' ||
      !process.env.VPS_FOREX_SCANNER_USER_ID ||
      process.env.VPS_FOREX_SCANNER_USER_ID !== userId
    ) {
      throw new ForbiddenException('Owner Pepperstone DEMO stop authority synchronization is disabled.');
    }
    const prelim: StopIntentRow[] = await this.dataSource.query(
      `SELECT id, user_id, trade_id, broker_connection_id,
              broker_position_id, state, expires_at, broker_ack_at,
              proposed_positive_stop, instrument, direction, trade_lots,
              entry_price, original_take_profit
         FROM trading.demo_profit_stop_amendment_intents
        WHERE id=$1 AND user_id=$2`,
      [ledgerId, userId],
    );
    const intent = prelim[0];
    if (!intent || !['ACKNOWLEDGED', 'AUTHORITY_COMMITTED'].includes(intent.state)) {
      throw new ConflictException('No broker-acknowledged amendment intent for this owner.');
    }
    const { connection, positions } =
      await this.brokerService.getOpenPositionsForConnection(intent.broker_connection_id, userId);
    if (
      connection.userId !== userId ||
      connection.brokerId !== 'pepperstone-ctrader' ||
      connection.accountType !== 'DEMO' ||
      connection.accountCurrency !== 'USD'
    ) {
      throw new ForbiddenException('Broker readback is not from the owner Pepperstone USD DEMO account.');
    }
    const matching = positions.filter(p => p.externalOrderId === intent.broker_position_id);
    if (matching.length !== 1 || !validBrokerStop(matching[0], intent)) {
      throw new ConflictException('Fresh broker readback does not prove the proposed positive stop.');
    }
    const observationAt = new Date();
    return this.dataSource.transaction(async manager => {
      if (Date.now() - observationAt.getTime() > 5000) {
        throw new ConflictException('Broker readback expired before durable authority synchronization.');
      }
      const rows: StopIntentRow[] = await manager.query(
        `SELECT l.id, l.user_id, l.trade_id, l.broker_connection_id,
                l.broker_position_id, l.broker_id, l.account_type,
                l.account_currency, l.strategy_route,
                l.instrument, l.direction, l.trade_lots::text,
                l.entry_price::text, l.original_stop::text,
                l.original_take_profit::text,
                l.proposed_positive_stop::text,
                l.estimated_exit_cost_reserve::text,
                l.estimated_net_floor_after_reserve::text,
                l.broker_ack_at, l.expires_at, l.state,
                t.status AS trade_status,
                t.account_currency AS trade_currency,
                t.direction AS trade_direction,
                t.instrument AS trade_instrument,
                t.lot_size::text AS trade_lots_current,
                t.fill_price::text AS trade_fill,
                t.stop_loss::text AS trade_stop,
                t.take_profit::text AS trade_tp,
                t.external_position_id AS trade_provider_position,
                t.logical_account_key AS trade_logical_key,
                b.logical_account_key AS broker_logical_key,
                b.account_currency AS connection_currency,
                b.account_type AS connection_type,
                b.broker_id AS connection_broker,
                ti.metadata->>'multimodel_plan_b_route' AS route_provenance
           FROM trading.demo_profit_stop_amendment_intents l
           JOIN trading.trades t
             ON t.id=l.trade_id AND t.user_id=l.user_id
           JOIN broker.broker_connections b
             ON b.id=l.broker_connection_id AND b.user_id=l.user_id
           LEFT JOIN trading.trade_intents ti
             ON ti.id=t.trade_intent_id AND ti.user_id=t.user_id
          WHERE l.id=$1 AND l.user_id=$2
            AND t.broker_connection_id=l.broker_connection_id
            AND b.deleted_at IS NULL
          FOR UPDATE OF t, l`,
        [ledgerId, userId],
      );
      const row = rows[0];
      if (
        !row ||
        row.id !== intent.id ||
        row.trade_id !== intent.trade_id ||
        row.broker_position_id !== intent.broker_position_id ||
        row.broker_connection_id !== intent.broker_connection_id ||
        !row.broker_ack_at ||
        !Number.isFinite(new Date(row.broker_ack_at).getTime()) ||
        new Date(row.broker_ack_at) > observationAt ||
        !Number.isFinite(new Date(row.expires_at).getTime()) ||
        new Date(row.expires_at) <= observationAt ||
        row.broker_id !== 'pepperstone-ctrader' ||
        row.account_type !== 'DEMO' ||
        row.account_currency !== 'USD' ||
        row.connection_broker !== row.broker_id ||
        row.connection_type !== row.account_type ||
        row.connection_currency !== row.account_currency ||
        row.trade_currency !== row.account_currency ||
        !row.trade_logical_key ||
        row.trade_logical_key !== row.broker_logical_key ||
        row.trade_status !== 'OPEN' ||
        row.trade_direction !== row.direction ||
        row.trade_instrument !== row.instrument ||
        row.trade_provider_position !== row.broker_position_id ||
        row.route_provenance !== row.strategy_route ||
        !['EARLY_TRANSITION','CONFIRMED_REVERSAL'].includes(row.strategy_route) ||
        !equalPrice(row.trade_lots_current, row.trade_lots) ||
        !equalPrice(row.trade_fill, row.entry_price) ||
        !equalPrice(row.trade_tp, row.original_take_profit) ||
        !equalPrice(row.proposed_positive_stop, intent.proposed_positive_stop) ||
        numeric(row.estimated_exit_cost_reserve) === null ||
        numeric(row.estimated_net_floor_after_reserve) === null ||
        !validBrokerStop(matching[0], row)
      ) {
        throw new ConflictException('Owner, trade, broker, stop or risk provenance changed before commit.');
      }
      if (row.state === 'AUTHORITY_COMMITTED' &&
          equalPrice(row.trade_stop, row.proposed_positive_stop)) {
        return {
          ledgerId, tradeId: row.trade_id,
          state: 'AUTHORITY_COMMITTED' as const,
          brokerStop: row.proposed_positive_stop,
          committedStop: row.trade_stop!,
          idempotent: true,
          brokerOrderActions: 0 as const,
          canDelayProfitClose: false as const,
        };
      }
      if (row.state !== 'ACKNOWLEDGED' ||
          !equalPrice(row.trade_stop, row.original_stop)) {
        throw new ConflictException('Stop authority is not in a committed broker ACK state.');
      }
      const updates: Array<{stop_loss:string}> = await manager.query(
        `UPDATE trading.trades
            SET stop_loss=$3
          WHERE id=$1 AND user_id=$2 AND status='OPEN'
            AND broker_connection_id=$4
            AND external_position_id=$5
            AND stop_loss=$6 AND take_profit=$7
          RETURNING stop_loss::text AS stop_loss`,
        [row.trade_id,userId,row.proposed_positive_stop,row.broker_connection_id,
          row.broker_position_id,row.original_stop,row.original_take_profit],
      );
      if (updates.length !== 1) throw new ConflictException(
        'Trade stop authority CAS failed; broker amendment requires reconciliation.',
      );
      const ledgerUpdated: Array<{id:string}> = await manager.query(
        `UPDATE trading.demo_profit_stop_amendment_intents
            SET state='AUTHORITY_COMMITTED',
                broker_readback_stop=$3,
                broker_verified_at=$4::timestamptz,
                authority_committed_at=clock_timestamp(),
                updated_at=clock_timestamp()
          WHERE id=$1 AND user_id=$2 AND state='ACKNOWLEDGED'
            AND broker_ack_at IS NOT NULL AND expires_at>$4::timestamptz
          RETURNING id`,
        [ledgerId,userId,row.proposed_positive_stop,observationAt.toISOString()],
      );
      if (ledgerUpdated.length !== 1) throw new ConflictException(
        'Ledger authority commit failed; the trade stop update must roll back.',
      );
      return {
        ledgerId,
        tradeId: row.trade_id,
        state: 'AUTHORITY_COMMITTED' as const,
        brokerStop: row.proposed_positive_stop,
        committedStop: updates[0].stop_loss,
        idempotent: false,
        brokerOrderActions: 0 as const,
        canDelayProfitClose: false as const,
      };
    });
  }
}
