import { PaperBrokerAdapter } from './paper-broker.adapter';
import { PaperBrokerStateService } from '../services/paper-broker-state.service';

class InMemoryPaperStateStore {
  private readonly states = new Map<string, Record<string, unknown>>();

  async load(connectionId: string): Promise<Record<string, unknown> | null> {
    return this.states.get(connectionId) ?? null;
  }

  async save(connectionId: string, state: Record<string, unknown>): Promise<void> {
    this.states.set(connectionId, JSON.parse(JSON.stringify(state)));
  }
}

const CONNECTION_ID = '11111111-1111-4111-8111-111111111111';
const CREDENTIALS = { accountId: 'paper-account-001' };

describe('PaperBrokerAdapter durable restart state', () => {
  it('rehydrates open exposure and preserves dedupe/order sequencing across restart', async () => {
    const store = new InMemoryPaperStateStore();

    const first = new PaperBrokerAdapter(
      undefined,
      undefined,
      store as unknown as PaperBrokerStateService,
      CONNECTION_ID,
    );
    await first.connect(CREDENTIALS);
    const original = await first.placeOrder({
      idempotencyKey: 'persist-me',
      instrument: 'EURUSD',
      direction: 'BUY',
      lotSize: '0.10',
      stopLoss: '1.00000',
      takeProfit: '2.00000',
    });
    expect(original.externalOrderId).toBe('paper-order-000001');

    await first.getCurrentPrice('EURUSD');
    const beforeRestart = await first.getOpenPositions();
    expect(beforeRestart).toHaveLength(1);

    const second = new PaperBrokerAdapter(
      undefined,
      undefined,
      store as unknown as PaperBrokerStateService,
      CONNECTION_ID,
    );
    await second.connect(CREDENTIALS);

    expect(await second.getOpenPositions()).toEqual(beforeRestart);
    const replay = await second.placeOrder({
      idempotencyKey: 'persist-me',
      instrument: 'EURUSD',
      direction: 'BUY',
      lotSize: '0.10',
      stopLoss: '1.00000',
      takeProfit: '2.00000',
    });
    expect(replay.externalOrderId).toBe('paper-order-000001');
    expect(await second.getOpenPositions()).toHaveLength(1);

    const next = await second.placeOrder({
      idempotencyKey: 'next-order',
      instrument: 'EURUSD',
      direction: 'SELL',
      lotSize: '0.10',
      stopLoss: '2.00000',
      takeProfit: '1.00000',
    });
    expect(next.externalOrderId).toBe('paper-order-000002');

    const closed = await second.closeOrder('paper-order-000001');
    expect(closed.success).toBe(true);
    const third = new PaperBrokerAdapter(
      undefined,
      undefined,
      store as unknown as PaperBrokerStateService,
      CONNECTION_ID,
    );
    await third.connect(CREDENTIALS);

    const openAfterSecondRestart = await third.getOpenPositions();
    expect(openAfterSecondRestart.map((position) => position.externalOrderId)).toEqual([
      'paper-order-000002',
    ]);

    const history = await third.getClosedTrades(new Date(0), new Date('2100-01-01T00:00:00Z'));
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      externalOrderId: 'paper-order-000001',
      closeReason: 'MANUAL',
    });

    const account = await third.getAccountInfo();
    expect(account.balance).toBeDefined();
  });
});
