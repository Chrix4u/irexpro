import { ConflictException, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { evaluatePartialCloseProof, PartialCloseProofReason } from './zai-p1-partial-leg-proof';

/**
 * Internal-only evidence writer. This never calls a broker, sends an order,
 * changes Trade.lotSize, or alters trading P&L projections.
 *
 * A future adapter reconciliation service must supply evidence obtained
 * independently from cTrader's position AND deal history, not its optimistic
 * ORDER_ACCEPTED event. There is no API/controller entry point.
 */
export interface CtraderPartialLegObservation {
  brokerPositionId: string;
  accountCurrency: string;
  providerOrderId: string | null;
  providerDealId: string | null;
  brokerLotsBefore: string | null;
  brokerFilledLots: string | null;
  brokerLotsAfter: string | null;
  grossRealisedPnl: string | null;
  commission: string | null;
  swap: string | null;
}

export interface CtraderPartialLegReconciliation {
  ledgerId: string;
  state: 'RECONCILIATION_PENDING' | 'CONFIRMED';
  reason: PartialCloseProofReason;
  idempotent: boolean;
  economicsComplete: boolean;
  remainingLots: string | null;
  canDispatchOrder: false;
}

type LedgerState = 'RESERVED' | 'DISPATCHING' | 'RECONCILIATION_PENDING' | 'REJECTED' | 'CONFIRMED';

interface StoredLeg {
  id: string;
  state: LedgerState;
  broker_connection_id: string;
  broker_position_id: string;
  account_currency: string;
  original_lots: string;
  requested_close_lots: string;
  provider_order_id: string | null;
  provider_deal_id: string | null;
  broker_lots_before: string | null;
  broker_filled_lots: string | null;
  broker_lots_after: string | null;
  gross_realised_pnl: string | null;
  commission: string | null;
  swap: string | null;
  economics_complete: boolean;
  trade_status: string;
  trade_account_currency: string | null;
  trade_logical_account_key: string | null;
  connection_logical_account_key: string | null;
  connection_currency: string | null;
  broker_id: string;
  account_type: string;
  current_position_id: string | null;
}

@Injectable()
export class DemoPartialCloseReconciliationService {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * Provider evidence must be independently verified and account scoped by
   * the future caller. Re-validation here ensures even a faulty caller cannot
   * confirm wrong-account, wrong-currency, stale-volume or incomplete legs.
   * No caller currently invokes this internal method.
   */
  async recordBrokerObservation(
    userId: string,
    ledgerId: string,
    evidence: CtraderPartialLegObservation,
  ): Promise<CtraderPartialLegReconciliation> {
    return this.dataSource.transaction(async (manager) => {
      const rows: StoredLeg[] = await manager.query(
        `SELECT l.id, l.state, l.broker_connection_id, l.broker_position_id,
                l.account_currency, l.original_lots::text, l.requested_close_lots::text,
                l.provider_order_id, l.provider_deal_id,
                l.broker_lots_before::text, l.broker_filled_lots::text,
                l.broker_lots_after::text, l.gross_realised_pnl::text,
                l.commission::text, l.swap::text, l.economics_complete,
                t.status AS trade_status, t.account_currency AS trade_account_currency,
                t.logical_account_key AS trade_logical_account_key,
                t.external_position_id AS current_position_id,
                b.logical_account_key AS connection_logical_account_key,
                b.account_currency AS connection_currency, b.broker_id, b.account_type
           FROM trading.trades t
           JOIN trading.demo_partial_close_legs l
             ON l.trade_id = t.id AND l.user_id = t.user_id
           JOIN broker.broker_connections b
             ON b.id = l.broker_connection_id AND b.user_id = t.user_id
          WHERE l.user_id = $1 AND l.id = $2
            AND t.broker_connection_id = l.broker_connection_id
            AND b.deleted_at IS NULL
          FOR UPDATE OF t, l`,
        [userId, ledgerId],
      );
      const leg = rows[0];
      if (
        !leg ||
        leg.broker_id !== 'ctrader' ||
        leg.account_type !== 'DEMO' ||
        !leg.trade_logical_account_key ||
        leg.trade_logical_account_key !== leg.connection_logical_account_key ||
        leg.trade_account_currency !== leg.account_currency ||
        leg.connection_currency !== leg.account_currency ||
        !leg.account_currency ||
        leg.account_currency !== evidence.accountCurrency ||
        leg.current_position_id !== leg.broker_position_id ||
        evidence.brokerPositionId !== leg.broker_position_id
      ) {
        throw new ConflictException(
          'Partial-close broker observation account, ownership or position does not match.',
        );
      }
      if (leg.state === 'REJECTED' || leg.state === 'RESERVED') {
        throw new ConflictException(
          'Partial-close broker observation cannot be applied before dispatch commitment.',
        );
      }
      const proof = evaluatePartialCloseProof({
        brokerId: leg.broker_id,
        accountType: leg.account_type,
        accountCurrency: leg.account_currency,
        providerDealId: evidence.providerDealId,
        originalLots: leg.original_lots,
        requestedCloseLots: leg.requested_close_lots,
        brokerLotsBefore: evidence.brokerLotsBefore,
        brokerFilledLots: evidence.brokerFilledLots,
        brokerLotsAfter: evidence.brokerLotsAfter,
        grossRealisedPnl: evidence.grossRealisedPnl,
        commission: evidence.commission,
        swap: evidence.swap,
      });

      if (leg.state === 'CONFIRMED') {
        const identical =
          proof.providerConfirmed &&
          leg.provider_order_id === evidence.providerOrderId &&
          leg.provider_deal_id === evidence.providerDealId &&
          leg.broker_lots_before === evidence.brokerLotsBefore &&
          leg.broker_filled_lots === evidence.brokerFilledLots &&
          leg.broker_lots_after === evidence.brokerLotsAfter &&
          leg.gross_realised_pnl === evidence.grossRealisedPnl &&
          leg.commission === evidence.commission &&
          leg.swap === evidence.swap &&
          leg.economics_complete === true;
        if (!identical) {
          throw new ConflictException(
            'Conflicting broker evidence for a previously confirmed leg.',
          );
        }
        return this.result(leg.id, 'CONFIRMED', 'CONFIRMED', true, true, proof.remainingLots);
      }

      // Reconciliation is allowed after a user ends a session; returning to
      // correct provider truth must never require restarting AI trading.
      if (leg.trade_status !== 'OPEN' && leg.trade_status !== 'RECONCILIATION_PENDING') {
        throw new ConflictException('Underlying trade changed to an incompatible lifecycle state.');
      }

      if (!proof.providerConfirmed) {
        // A provider acceptance, partial fill, timeout, or missing fee is NOT
        // a completed partial close. Persist ambiguity for restart-safe review.
        const pending: Array<{ id: string }> = await manager.query(
          `UPDATE trading.demo_partial_close_legs
              SET state = 'RECONCILIATION_PENDING',
                  reconciliation_reason = $3, last_reconciled_at = NOW(), updated_at = NOW()
            WHERE id = $1 AND user_id = $2
              AND state IN ('DISPATCHING', 'RECONCILIATION_PENDING')
            RETURNING id`,
          [leg.id, userId, proof.reason],
        );
        if (!pending[0]) throw new ConflictException('Partial-close ledger state changed.');
        return this.result(leg.id, 'RECONCILIATION_PENDING', proof.reason, false, false, null);
      }

      const confirmed: Array<{ id: string }> = await manager.query(
        `UPDATE trading.demo_partial_close_legs
            SET state = 'CONFIRMED', provider_order_id = $3,
                provider_deal_id = $4, broker_lots_before = $5::numeric,
                broker_filled_lots = $6::numeric, broker_lots_after = $7::numeric,
                gross_realised_pnl = $8::numeric, commission = $9::numeric,
                swap = $10::numeric, economics_complete = TRUE,
                reconciliation_reason = NULL, last_reconciled_at = NOW(),
                confirmed_at = NOW(), updated_at = NOW()
          WHERE id = $1 AND user_id = $2
            AND state IN ('DISPATCHING', 'RECONCILIATION_PENDING')
          RETURNING id`,
        [
          leg.id,
          userId,
          evidence.providerOrderId,
          evidence.providerDealId,
          evidence.brokerLotsBefore,
          evidence.brokerFilledLots,
          evidence.brokerLotsAfter,
          evidence.grossRealisedPnl,
          evidence.commission,
          evidence.swap,
        ],
      );
      if (!confirmed[0]) throw new ConflictException('Partial-close ledger state changed.');
      // Even confirmed provider economics are NOT copied into the trade/cost
      // cards: accounting/remaining-exposure integration is a separate gate.
      return this.result(leg.id, 'CONFIRMED', 'CONFIRMED', false, true, proof.remainingLots);
    });
  }

  private result(
    ledgerId: string,
    state: CtraderPartialLegReconciliation['state'],
    reason: PartialCloseProofReason,
    idempotent: boolean,
    economicsComplete: boolean,
    remainingLots: string | null,
  ): CtraderPartialLegReconciliation {
    return {
      ledgerId,
      state,
      reason,
      idempotent,
      economicsComplete,
      remainingLots,
      canDispatchOrder: false,
    };
  }
}
