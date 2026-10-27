import {
  BrokerOrderRequest,
  BrokerOrderResult,
  BrokerOrderState,
} from '../interfaces/broker-adapter.interface';
import { BrokerAdapterError, BrokerErrorCode } from '../interfaces/broker-adapter.errors';
import { PaperBrokerAdapter } from '../adapters/paper-broker.adapter';
import { runVerificationChecklist } from './provider-verification-harness';

const MARKET_LIFECYCLE_STEPS = [
  'connect',
  'market-data',
  'positions-snapshot',
  'market-order',
  'position-verify',
  'partial-close',
  'full-close',
  'trade-history',
] as const;

function filledOrderState(
  providerOrderId: string,
  instrument: string,
  quantity: string,
): BrokerOrderState {
  return {
    providerOrderId,
    clientOrderId: null,
    status: 'FILLED',
    instrument,
    direction: 'BUY',
    requestedQuantity: quantity,
    filledQuantity: quantity,
    avgFillPrice: '1.10000',
    orderKind: 'MARKET',
    limitPrice: null,
    stopPrice: null,
    timeInForce: 'GTC',
    placedAt: new Date('2026-10-27T12:00:00.000Z'),
    updatedAt: new Date('2026-10-27T12:00:00.100Z'),
    raw: null,
  };
}

class AcceptedOrderIdDiffersFromPositionIdAdapter extends PaperBrokerAdapter {
  readonly acceptedOrderId = 'provider-order-777';
  actualPositionId: string | null = null;
  private instrument = 'EURUSD';
  private quantity = '0.02';
  readonly closeIds: string[] = [];

  async placeOrder(order: BrokerOrderRequest): Promise<BrokerOrderResult> {
    const filled = await super.placeOrder(order);
    this.actualPositionId = filled.externalOrderId ?? null;
    this.instrument = order.instrument;
    this.quantity = order.lotSize;
    return {
      ...filled,
      externalOrderId: this.acceptedOrderId,
      status: 'PENDING',
      filledPrice: undefined,
      filledQuantity: undefined,
      filledAt: undefined,
      brokerMessage: 'Order accepted (working)',
    };
  }

  async getOrderById(providerOrderId: string): Promise<BrokerOrderState | null> {
    if (providerOrderId !== this.acceptedOrderId) return null;
    return filledOrderState(providerOrderId, this.instrument, this.quantity);
  }

  async closeOrder(externalOrderId: string, lotSize?: string): Promise<BrokerOrderResult> {
    this.closeIds.push(externalOrderId);
    return super.closeOrder(externalOrderId, lotSize);
  }
}

class DispatchUncertainAfterProviderFillAdapter extends PaperBrokerAdapter {
  actualPositionId: string | null = null;
  readonly closeIds: string[] = [];

  async placeOrder(order: BrokerOrderRequest): Promise<BrokerOrderResult> {
    const filled = await super.placeOrder(order);
    this.actualPositionId = filled.externalOrderId ?? null;
    throw new BrokerAdapterError(
      BrokerErrorCode.CONNECTION_TIMEOUT,
      'Transport outcome uncertain after provider accepted the market order',
    );
  }

  async closeOrder(externalOrderId: string, lotSize?: string): Promise<BrokerOrderResult> {
    this.closeIds.push(externalOrderId);
    return super.closeOrder(externalOrderId, lotSize);
  }
}

class ReconciliationErrorAfterProviderFillAdapter extends PaperBrokerAdapter {
  readonly acceptedOrderId = 'provider-order-uncertain';
  actualPositionId: string | null = null;
  readonly closeIds: string[] = [];

  async placeOrder(order: BrokerOrderRequest): Promise<BrokerOrderResult> {
    const filled = await super.placeOrder(order);
    this.actualPositionId = filled.externalOrderId ?? null;
    return {
      ...filled,
      externalOrderId: this.acceptedOrderId,
      status: 'PENDING',
      filledPrice: undefined,
      filledQuantity: undefined,
      filledAt: undefined,
      brokerMessage: 'Order accepted (working)',
    };
  }

  async getOrderById(): Promise<BrokerOrderState | null> {
    throw new BrokerAdapterError(
      BrokerErrorCode.CONNECTION_TIMEOUT,
      'Provider order-details stream unavailable after acceptance',
    );
  }

  async closeOrder(externalOrderId: string, lotSize?: string): Promise<BrokerOrderResult> {
    this.closeIds.push(externalOrderId);
    return super.closeOrder(externalOrderId, lotSize);
  }
}

describe('DEMO validation — validation position identity and cleanup', () => {
  it('resolves the actual position id after an accepted order id and closes that position', async () => {
    const adapter = new AcceptedOrderIdDiffersFromPositionIdAdapter();

    const evidence = await runVerificationChecklist(adapter, {
      brokerId: 'paper-broker',
      mode: 'DEMO',
      steps: MARKET_LIFECYCLE_STEPS,
      credentials: { accountId: 'paper-order-position-id-split' },
    });

    expect(evidence.overall).toBe('PASS');
    expect(adapter.actualPositionId).toBeTruthy();
    expect(adapter.actualPositionId).not.toBe(adapter.acceptedOrderId);
    expect(adapter.closeIds).toContain(adapter.actualPositionId!);
    expect(adapter.closeIds).not.toContain(adapter.acceptedOrderId);
    await expect(adapter.getOpenPositions()).resolves.toHaveLength(0);
  });

  it('cleans a newly-created validation position when dispatch becomes uncertain before any order id is returned', async () => {
    const adapter = new DispatchUncertainAfterProviderFillAdapter();

    const evidence = await runVerificationChecklist(adapter, {
      brokerId: 'paper-broker',
      mode: 'DEMO',
      steps: MARKET_LIFECYCLE_STEPS,
      credentials: { accountId: 'paper-dispatch-uncertain' },
    });

    expect(evidence.overall).toBe('FAIL');
    expect(adapter.actualPositionId).toBeTruthy();
    expect(adapter.closeIds).toContain(adapter.actualPositionId!);
    await expect(adapter.getOpenPositions()).resolves.toHaveLength(0);
  });

  it('cleans a newly-created validation position even when accepted-order reconciliation fails', async () => {
    const adapter = new ReconciliationErrorAfterProviderFillAdapter();

    const evidence = await runVerificationChecklist(adapter, {
      brokerId: 'paper-broker',
      mode: 'DEMO',
      steps: MARKET_LIFECYCLE_STEPS,
      credentials: { accountId: 'paper-uncertain-accepted-order' },
    });

    expect(evidence.overall).toBe('FAIL');
    expect(adapter.actualPositionId).toBeTruthy();
    expect(adapter.closeIds).toContain(adapter.actualPositionId!);
    expect(adapter.closeIds).not.toContain(adapter.acceptedOrderId);
    await expect(adapter.getOpenPositions()).resolves.toHaveLength(0);
  });

  it('does not place a validation order when a DEMO cleanup preflight fails', async () => {
    const adapter = new PaperBrokerAdapter();
    const placeOrder = jest.spyOn(adapter, 'placeOrder');

    const evidence = await runVerificationChecklist(adapter, {
      brokerId: 'paper-broker',
      mode: 'DEMO',
      steps: MARKET_LIFECYCLE_STEPS,
      credentials: { accountId: 'paper-preflight-fail' },
      preflightSteps: [
        {
          name: 'legacy-validation-cleanup',
          status: 'FAIL',
          detail: 'tagged DEMO validation exposure could not be proven flat',
        },
      ],
    });

    expect(evidence.overall).toBe('FAIL');
    expect(evidence.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'legacy-validation-cleanup', status: 'FAIL' }),
        expect.objectContaining({ name: 'market-order', status: 'SKIPPED' }),
      ]),
    );
    expect(placeOrder).not.toHaveBeenCalled();
  });
});
