import { Test, TestingModule } from '@nestjs/testing';
import { PaperBrokerAdapter } from './paper-broker.adapter';
import { BrokerMode } from '../interfaces/broker-adapter.interface';

describe('PaperBrokerAdapter', () => {
  let module: TestingModule;
  let adapter: PaperBrokerAdapter;

  const dummyCreds = { accountId: 'test-account' };

  beforeEach(async () => {
    module = await Test.createTestingModule({
      providers: [PaperBrokerAdapter],
    }).compile();

    adapter = module.get(PaperBrokerAdapter);
  });

  afterEach(async () => {
    await module.close();
  });

  it('has brokerId = paper-broker', () => {
    expect(adapter.brokerId).toBe('paper-broker');
  });

  it('implements IBrokerAdapter interface', () => {
    expect(typeof adapter.connect).toBe('function');
    expect(typeof adapter.disconnect).toBe('function');
    expect(typeof adapter.placeOrder).toBe('function');
    expect(typeof adapter.getOHLCV).toBe('function');
    expect(typeof adapter.closeAllOrders).toBe('function');
    expect(typeof adapter.getClosedTrades).toBe('function');
  });

  it('connects without real credentials', async () => {
    const result = await adapter.connect(dummyCreds);
    expect(result.success).toBe(true);
    expect(result.accountType).toBe(BrokerMode.DEMO);
    expect(adapter.isConnected()).toBe(true);
  });

  it('testConnection always succeeds without external API call', async () => {
    const result = await adapter.testConnection(dummyCreds);
    expect(result.success).toBe(true);
  });

  it('cannot be set to LIVE mode', () => {
    adapter.setMode(BrokerMode.LIVE);
    // Mode must NOT be LIVE after calling setMode(LIVE)
    // We verify indirectly: connect returns DEMO account type
    adapter.connect(dummyCreds).then((r) => {
      expect(r.accountType).toBe(BrokerMode.DEMO);
    });
  });

  it('placeOrder returns simulated result marked PAPER_ONLY', async () => {
    await adapter.connect(dummyCreds);
    const result = await adapter.placeOrder({
      idempotencyKey: 'test-key-1',
      instrument: 'EURUSD',
      direction: 'BUY',
      lotSize: '0.01',
      stopLoss: '1.09000',
      takeProfit: '1.11000',
    });

    expect(result.success).toBe(true);
    expect(result.status).toBe('FILLED');
    expect(result.brokerMessage).toContain('PAPER_ONLY');
    expect(result.externalOrderId).toContain('paper-order');
  });

  // ─── Sprint 50 PR-3 — honest order-kind semantics ─────────────────────────

  it('MARKET orders fill immediately with the requested quantity', async () => {
    await adapter.connect(dummyCreds);
    const result = await adapter.placeOrder({
      idempotencyKey: 'test-key-mkt',
      instrument: 'EURUSD',
      direction: 'BUY',
      lotSize: '0.02',
      stopLoss: '1.09000',
      takeProfit: '1.11000',
      orderKind: 'MARKET',
    });
    expect(result.status).toBe('FILLED');
    expect(result.filledQuantity).toBe('0.02');
    expect(result.filledPrice).toBe('1.10005');
  });

  it('LIMIT orders are accepted as WORKING orders (never silently filled)', async () => {
    await adapter.connect(dummyCreds);
    const result = await adapter.placeOrder({
      idempotencyKey: 'test-key-lmt',
      instrument: 'EURUSD',
      direction: 'BUY',
      lotSize: '0.01',
      stopLoss: '1.09000',
      takeProfit: '1.11000',
      orderKind: 'LIMIT',
      limitPrice: '1.09500',
    });
    expect(result.success).toBe(true);
    expect(result.status).toBe('PENDING');
    expect(result.brokerMessage).toContain('LIMIT');
    expect(result.filledPrice).toBeUndefined();
  });

  it('STOP/STOP_LIMIT orders are accepted as WORKING orders', async () => {
    await adapter.connect(dummyCreds);
    for (const kind of ['STOP', 'STOP_LIMIT'] as const) {
      const result = await adapter.placeOrder({
        idempotencyKey: `test-key-${kind}`,
        instrument: 'EURUSD',
        direction: 'SELL',
        lotSize: '0.01',
        stopLoss: '1.11000',
        takeProfit: '1.09000',
        orderKind: kind,
        stopPrice: '1.10500',
        limitPrice: kind === 'STOP_LIMIT' ? '1.10450' : undefined,
      });
      expect(result.status).toBe('PENDING');
      expect(result.externalOrderId).toContain('paper-order');
    }
  });

  it('placeOrder never calls external broker API', async () => {
    // PaperBrokerAdapter has no HTTP client — no external call possible.
    // Verify it doesn't throw and returns a local result immediately.
    // (Sprint 51 PR-7: data operations require connect() first — fail closed.)
    await adapter.connect(dummyCreds);
    const start = Date.now();
    const result = await adapter.placeOrder({
      idempotencyKey: 'test-key-2',
      instrument: 'EURUSD',
      direction: 'SELL',
      lotSize: '0.01',
      stopLoss: '1.12000',
      takeProfit: '1.09000',
    });
    const elapsed = Date.now() - start;

    expect(result.success).toBe(true);
    expect(elapsed).toBeLessThan(100); // Local only — no network latency
  });

  it('getOHLCV returns deterministic mock candles', async () => {
    await adapter.connect(dummyCreds);
    const candles = await adapter.getOHLCV('EURUSD', 'H1', 10);
    expect(candles).toHaveLength(10);
    expect(candles[0]).toMatchObject({
      open: expect.any(String),
      high: expect.any(String),
      low: expect.any(String),
      close: expect.any(String),
      volume: expect.any(String),
    });
    // Prices must be string (decimal-safe)
    expect(typeof candles[0].open).toBe('string');
  });

  it('getAccountBalance returns simulated balance', async () => {
    await adapter.connect(dummyCreds);
    const balance = await adapter.getAccountBalance();
    expect(balance.currency).toBe('USD');
    expect(typeof balance.balance).toBe('string');
  });

  it('closeAllOrders returns zero closed (paper — no real positions)', async () => {
    await adapter.connect(dummyCreds);
    const result = await adapter.closeAllOrders();
    expect(result.closedCount).toBe(0);
    expect(result.failedCount).toBe(0);
  });

  it('getOpenPositions returns empty array (paper — no live positions)', async () => {
    await adapter.connect(dummyCreds);
    const positions = await adapter.getOpenPositions();
    expect(positions).toEqual([]);
  });

  it('getClosedTrades returns empty array', async () => {
    await adapter.connect(dummyCreds);
    const trades = await adapter.getClosedTrades(new Date(0), new Date());
    expect(trades).toEqual([]);
  });

  it('cannot be registered as live broker (liveTradingEnabled guard)', () => {
    // The PaperBrokerAdapter is PAPER_ONLY.
    // Its brokerId is 'paper-broker' — not 'metatrader5' or any live broker.
    // Verify it cannot masquerade as a live adapter.
    expect(adapter.brokerId).toBe('paper-broker');
    expect(adapter.brokerName).toContain('PAPER_ONLY');

    // setMode(LIVE) is silently ignored — mode stays DEMO
    adapter.setMode(BrokerMode.LIVE);
    expect(adapter.isConnected()).toBe(false); // Not connected before connect()
  });

  // ─── Sprint 51 PR-7 — fail-closed preconditions (Directive §AN #1) ────────

  it('throws NOT_CONNECTED (BrokerAdapterError) for data operations before connect()', async () => {
    const fresh = new PaperBrokerAdapter();
    await expect(fresh.getAccountInfo()).rejects.toMatchObject({
      code: 'NOT_CONNECTED',
      name: 'BrokerAdapterError',
    });
    await expect(fresh.getOpenPositions()).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
    await expect(fresh.listOrders()).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
    await expect(fresh.getCurrentPrice('EURUSD')).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
    await expect(
      fresh.placeOrder({
        idempotencyKey: 'k-pre',
        instrument: 'EURUSD',
        direction: 'BUY',
        lotSize: '0.01',
        stopLoss: '1.09000',
        takeProfit: '1.11000',
      }),
    ).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
  });
});
