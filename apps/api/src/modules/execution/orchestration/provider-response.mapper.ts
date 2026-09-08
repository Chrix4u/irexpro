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
      providerOrderId?: string;
      fillQuantity?: string;
      fillPrice: string;
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
      providerOrderId: result.externalOrderId,
      fillQuantity: result.filledQuantity,
      fillPrice: result.filledPrice,
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
      providerOrderId: result.externalOrderId,
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
