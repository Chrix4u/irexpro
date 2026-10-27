import type {
  BrokerOrderRequest,
  BrokerOrderResult,
  BrokerOrderState,
  IBrokerAdapter,
} from '../interfaces/broker-adapter.interface';

export interface DemoValidationOrderReconciliationOptions {
  attempts?: number;
  intervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_ATTEMPTS = 12;
const DEFAULT_INTERVAL_MS = 250;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function terminalFailure(
  initial: BrokerOrderResult,
  state: BrokerOrderState,
): BrokerOrderResult {
  const providerOrderId = initial.externalOrderId ?? state.providerOrderId;
  const providerStatus = state.status;
  return {
    success: false,
    externalOrderId: providerOrderId,
    status: providerStatus === 'REJECTED' ? 'REJECTED' : 'FAILED',
    brokerMessage: `DEMO market order reached terminal provider state ${providerStatus}`,
  };
}

/**
 * DEMO validation only: a real provider may acknowledge a market order as
 * PENDING before its asynchronous execution event reaches the adapter.
 *
 * PENDING is never treated as a successful fill. The function follows the
 * provider's authoritative getOrderById reconciliation surface for a bounded
 * period and returns FILLED only when the provider proves the fill. Any
 * terminal non-fill state or timeout remains fail-closed.
 */
export async function reconcilePendingDemoMarketOrder(
  adapter: Pick<IBrokerAdapter, 'getOrderById'>,
  initial: BrokerOrderResult,
  options: DemoValidationOrderReconciliationOptions = {},
): Promise<BrokerOrderResult> {
  if (initial.status !== 'PENDING') return initial;

  const providerOrderId = initial.externalOrderId;
  if (!providerOrderId) {
    return {
      success: false,
      status: 'FAILED',
      brokerMessage:
        'DEMO market order returned PENDING without a provider order id; fill cannot be reconciled safely',
    };
  }

  const attempts = Math.max(1, options.attempts ?? DEFAULT_ATTEMPTS);
  const intervalMs = Math.max(0, options.intervalMs ?? DEFAULT_INTERVAL_MS);
  const sleep = options.sleep ?? delay;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0 && intervalMs > 0) {
      await sleep(intervalMs);
    }

    const state = await adapter.getOrderById(providerOrderId);
    if (!state) continue;

    if (state.status === 'FILLED') {
      return {
        success: true,
        externalOrderId: providerOrderId,
        filledPrice: state.avgFillPrice ?? undefined,
        filledQuantity: state.filledQuantity,
        filledAt: state.updatedAt ?? new Date(),
        status: 'FILLED',
        brokerMessage: 'DEMO market order fill confirmed by provider reconciliation',
      };
    }

    if (
      state.status === 'REJECTED' ||
      state.status === 'CANCELLED' ||
      state.status === 'EXPIRED' ||
      state.status === 'UNKNOWN'
    ) {
      return terminalFailure(initial, state);
    }

    // WORKING / PARTIALLY_FILLED are non-terminal. Keep reconciling until a
    // complete fill or a bounded timeout; validation must not promote partial
    // evidence into demoValidated=true.
  }

  return {
    success: false,
    externalOrderId: providerOrderId,
    status: 'FAILED',
    brokerMessage: `DEMO market order remained PENDING after ${attempts} reconciliation attempt(s)`,
  };
}

/**
 * Wrap a connected adapter for the DEMO evidence checklist. Only MARKET
 * placement is reconciled; pending LIMIT/STOP validation orders keep their
 * normal PENDING lifecycle so modify/cancel checks remain meaningful.
 */
export function withDemoValidationOrderReconciliation(
  adapter: IBrokerAdapter,
  options: DemoValidationOrderReconciliationOptions = {},
): IBrokerAdapter {
  return new Proxy(adapter, {
    get(target, property, receiver) {
      if (property === 'placeOrder') {
        return async (order: BrokerOrderRequest): Promise<BrokerOrderResult> => {
          const initial = await target.placeOrder(order);
          const orderKind = order.orderKind ?? 'MARKET';
          if (orderKind !== 'MARKET' || initial.status !== 'PENDING') {
            return initial;
          }
          return reconcilePendingDemoMarketOrder(target, initial, options);
        };
      }

      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
