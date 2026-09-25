import { Order } from '../orders/order.entity';
import { OrderKind, OrderTimeInForce } from '../orders/order.enums';
import { ProviderDispatchCertainty } from '../../broker/interfaces/provider-dispatch-certainty';

/**
 * ExecutionIntent — Directive PHASE D "execution intent".
 *
 * A validated, broker-ready description of ONE order the platform intends to
 * dispatch to a provider. This is the single input contract of
 * ExecutionOrchestrator.dispatchOrder(): everything downstream (order
 * reservation, provider dispatch, response handling, state transitions)
 * derives from this object.
 *
 * INVARIANTS:
 * - The intent has ALREADY passed the Risk Engine (APPROVED) — the risk gate
 *   lives upstream in ExecutionService.executeTrade() and is never bypassed.
 * - Quantities and prices are decimal STRINGS (never floats).
 * - clientOrderId is the idempotency surface: the same clientOrderId always
 *   maps to the same persisted order (SHA-256(userId:clientOrderId)) and is
 *   NEVER dispatched twice.
 */
export interface ExecutionIntent {
  userId: string;
  brokerConnectionId: string;

  /** Stable caller-supplied identifier (the idempotency surface). */
  clientOrderId: string;

  /** Position aggregate this order belongs to (entry or close), if known. */
  tradeId?: string | null;
  /** AI signal that produced this intent, if any. */
  signalId?: string | null;

  orderKind: OrderKind;
  timeInForce: OrderTimeInForce;

  instrument: string;
  direction: 'BUY' | 'SELL';
  /** Requested quantity in lots (decimal string, > 0). */
  requestedQuantity: string;
  /** Required for LIMIT / STOP_LIMIT (decimal string). */
  requestedPrice?: string | null;
  /** Required for STOP / STOP_LIMIT (decimal string). */
  stopPrice?: string | null;

  /**
   * Round 6 live-execution completion (§5/§18): the risk-validated reference
   * price (the geometry quote the risk evaluation used). The final
   * market-safety gate verifies the CURRENT price has not deviated
   * materially from this reference before the provider commitment. Null for
   * intents without a provable reference (the deviation check is skipped —
   * freshness + spread still apply).
   */
  referencePrice?: string | null;

  stopLoss: string;
  takeProfit: string;

  /** Free-form provider comment (never contains credentials). */
  comment?: string;

  /**
   * Provider primitive to use for this intent:
   * - PLACE — open a new position (adapter.placeOrder)
   * - CLOSE_POSITION — close an existing position (adapter.closeOrder)
   */
  providerAction: 'PLACE' | 'CLOSE_POSITION';

  /**
   * For CLOSE_POSITION intents: the provider-side position identifier of the
   * position being closed (Trade.externalOrderId).
   */
  providerReferenceId?: string;
}

/**
 * ProviderDispatchOutcome — Directive PHASE D "response handling".
 *
 * The normalized result of one orchestrated dispatch. ExecutionService maps
 * these outcomes onto the Trade (position) aggregate; the Order lifecycle is
 * already fully recorded by the orchestrator before this value is returned.
 *
 * `orderId` is an EXPLICIT field on every variant (never dig it out of the
 * order entity) — audit logs and events consume it directly.
 *
 * - FILLED      — provider executed the order (fill quantity + VWAP price known)
 * - WORKING     — provider accepted the order; fill arrives asynchronously
 *                 (e.g. LIMIT/STOP orders resting at the provider)
 * - REJECTED    — provider definitively refused (no execution happened)
 * - UNKNOWN     — dispatch errored/timed out; the provider-side outcome is
 *                 UNKNOWN and both order + trade are RECONCILIATION_PENDING
 *                 (fail-closed — never silently dropped)
 * - DUPLICATE   — an order with this clientOrderId already existed; NOTHING
 *                 was dispatched (exactly-once dispatch guarantee)
 */
export type ProviderDispatchOutcome =
  | {
      outcome: 'FILLED';
      order: Order;
      orderId: string;
      providerOrderId: string;
      filledQuantity: string;
      avgFillPrice: string;
      realisedPnl?: string;
      commission?: string;
      swap?: string;
    }
  | {
      outcome: 'WORKING';
      order: Order;
      orderId: string;
      providerOrderId: string;
    }
  | {
      outcome: 'REJECTED';
      order: Order;
      orderId: string;
      reason: string;
    }
  | {
      outcome: 'UNKNOWN';
      order: Order;
      orderId: string;
      reason: string;
      /**
       * Round 5 (#314): the round-4 WRITE-CERTAINTY classification of the
       * uncertain dispatch — persisted on the Trade when it transitions to
       * RECONCILIATION_PENDING so uncertain-exposure accounting knows whether
       * the capacity reservation must be RETAINED
       * (MAY_HAVE_REACHED_PROVIDER) or released once (DEFINITELY_NOT_SENT).
       */
      certainty: ProviderDispatchCertainty;
    }
  | {
      outcome: 'DUPLICATE';
      order: Order;
      orderId: string;
    };