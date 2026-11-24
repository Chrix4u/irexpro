import { BrokerOrderResult } from '../../broker/interfaces/broker-adapter.interface';

/**
 * ProviderResponseAction — Directive PHASE D "response handling".
 *
 * The single source of truth that maps a provider's BrokerOrderResult onto
 * the normalized order-domain action. Pure function — no I/O, no side
 * effects, fully unit-testable.
 *
 * MAPPING RULES (fail-closed on malformed provider data):
 *
 * | result                          | action                  | rationale
 * |---------------------------------|-------------------------|--------------
 * | success + FILLED + price        | ACKNOWLEDGE_AND_FILL    | provider executed
 * | success + FILLED, no price      | RECONCILIATION_PENDING  | malformed — outcome unknown
 * | success + PENDING + provider id | ACKNOWLEDGE             | working order at provider
 * | success + PENDING, no id        | RECONCILIATION_PENDING  | malformed — outcome unknown
 * | REJECTED                        | REJECT                  | definitive refusal
 * | FAILED                          | REJECT                  | provider answered: not executed
 * | success=false                   | REJECT                  | provider answered: not executed
 *
 * Thrown exceptions never reach this mapper — the orchestrator catches them
 * and moves the order to RECONCILIATION_PENDING (outcome UNKNOWN).
 */
export type ProviderResponseAction =
  | {
      action: 'ACKNOWLEDGE_AND_FILL';
      /** Native ORDER id when the provider surfaced one (cTrader brokerNativeOrderId); legacy adapters fall back to externalOrderId. */
      providerOrderId?: string;
      /** Native POSITION id a filled MARKET order executed against (cTrader externalOrderId when a native order id exists). */
      providerPositionId?: string;
      fillQuantity?: string;
      fillPrice: string;
      realisedPnl?: string;
      commission?: string;
      swap?: string;
    }
  | {
      action: 'ACKNOWLEDGE';
      providerOrderId: string;
    }
  | {
      action: 'REJECT';
      reason: string;
    }
  | {
      action: 'RECONCILIATION_PENDING';
      reason: string;
    };

/**
 * Map a provider order result to the normalized order-domain action.
 *
 * NOTE — deliberate improvement over the legacy trade-only mapping: a
 * "success + FILLED" response with a MISSING fill price is treated as
 * RECONCILIATION_PENDING (outcome unknown) rather than a rejection. The
 * order may have executed; marking it rejected would silently orphan a real
 * provider-side position. Reconciliation resolves the true state.
 */
export function mapProviderOrderResponse(result: BrokerOrderResult): ProviderResponseAction {
  if (result.status === 'FILLED') {
    if (!result.success) {
      return {
        action: 'REJECT',
        reason: result.brokerMessage ?? 'Provider reported FILLED with success=false',
      };
    }
    if (!result.filledPrice) {
      return {
        action: 'RECONCILIATION_PENDING',
        reason: 'Provider reported FILLED without a fill price — outcome cannot be recorded',
      };
    }
    return {
      action: 'ACKNOWLEDGE_AND_FILL',
      // Identity separation (migration 1795220000000): for a FILLED MARKET
      // order, externalOrderId is the cTrader POSITION id and
      // brokerNativeOrderId is the ORDER id. Persist the native order id in
      // provider_order_id (stable-identifier reconciliation queries it) and
      // the position id separately. Legacy adapters without a native id keep
      // the historic single-identifier behaviour.
      providerOrderId: result.brokerNativeOrderId ?? result.externalOrderId,
      ...(result.brokerNativeOrderId ? { providerPositionId: result.externalOrderId } : {}),
      fillQuantity: result.filledQuantity,
      fillPrice: result.filledPrice,
      ...(result.realisedPnl !== undefined ? { realisedPnl: result.realisedPnl } : {}),
      ...(result.commission !== undefined ? { commission: result.commission } : {}),
      ...(result.swap !== undefined ? { swap: result.swap } : {}),
    };
  }

  if (result.status === 'PENDING') {
    if (!result.success) {
      return {
        action: 'REJECT',
        reason: result.brokerMessage ?? 'Provider reported PENDING with success=false',
      };
    }
    if (!result.externalOrderId) {
      return {
        action: 'RECONCILIATION_PENDING',
        reason: 'Provider reported PENDING without a provider order id — outcome cannot be tracked',
      };
    }
    return {
      action: 'ACKNOWLEDGE',
      providerOrderId: result.brokerNativeOrderId ?? result.externalOrderId,
    };
  }

  if (result.status === 'REJECTED') {
    return {
      action: 'REJECT',
      reason: result.brokerMessage ?? 'Order rejected by provider',
    };
  }

  // status === 'FAILED': the provider RESPONDED with a definitive non-execution
  // retcode. Only THROWN errors (handled by the orchestrator) carry an unknown
  // outcome and require reconciliation.
  return {
    action: 'REJECT',
    reason: result.brokerMessage ?? 'Order failed at provider',
  };
}
