import {
  BrokerMode,
  BrokerOrderRequest,
  BrokerOrderResult,
} from '../interfaces/broker-adapter.interface';
import { PaperBrokerAdapter } from '../adapters/paper-broker.adapter';
import { DEMO_VALIDATION_STEPS, runVerificationChecklist } from './provider-verification-harness';

class AcceptedThenFilledPaperAdapter extends PaperBrokerAdapter {
  async placeOrder(order: BrokerOrderRequest): Promise<BrokerOrderResult> {
    const filled = await super.placeOrder(order);
    if ((order.orderKind ?? 'MARKET') !== 'MARKET') return filled;
    return {
      ...filled,
      status: 'PENDING',
      filledPrice: undefined,
      filledQuantity: undefined,
      brokerMessage: 'Order accepted (working)',
    };
  }
}

describe('DEMO validation — asynchronous market-order acceptance', () => {
  it('waits for an accepted PENDING market order to become FILLED before passing the step', async () => {
    const accountId = 'paper-accepted-then-filled';
    const adapter = new AcceptedThenFilledPaperAdapter();
    adapter.setMode(BrokerMode.DEMO);
    await adapter.connect({ accountId });

    const evidence = await runVerificationChecklist(adapter, {
      brokerId: 'paper-broker',
      mode: 'DEMO',
      steps: DEMO_VALIDATION_STEPS,
      connectStep: {
        name: 'connect',
        status: 'PASS',
        detail: 'already connected',
      },
      credentials: { accountId },
    });

    const marketOrder = evidence.steps.find((step) => step.name === 'market-order');
    expect(marketOrder?.status).toBe('PASS');
    expect(marketOrder?.detail).toContain('filled');
    expect(evidence.overall).toBe('PASS');
  });
});
