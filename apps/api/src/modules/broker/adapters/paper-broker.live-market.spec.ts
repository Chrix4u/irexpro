import { PaperBrokerAdapter } from './paper-broker.adapter';
import { LivePaperMarketDataService } from '../services/live-paper-market-data.service';
import { PaperBrokerStateService } from '../services/paper-broker-state.service';

class InMemoryLivePaperStateStore {
  private state: Record<string, unknown> | null = null;

  async load(): Promise<Record<string, unknown> | null> {
    return this.state ? JSON.parse(JSON.stringify(this.state)) : null;
  }

  async save(_connectionId: string, state: Record<string, unknown>): Promise<void> {
    this.state = JSON.parse(JSON.stringify(state));
  }
}

function series(base: number, digits: number) {
  const end = Math.floor(Date.now() / 300000) * 300000 - 300000;
  return Array.from({ length: 70 }, (_, i) => {
    const close = base + Math.sin(i / 8) * (base > 10 ? 0.02 : 0.0002);
    return {
      timestamp: new Date(end - (69 - i) * 300000),
      open: close.toFixed(digits),
      high: (close + (base > 10 ? 0.01 : 0.0001)).toFixed(digits),
      low: (close - (base > 10 ? 0.01 : 0.0001)).toFixed(digits),
      close: close.toFixed(digits),
    };
  });
}

function protectionBars(options?: { high?: number; low?: number; close?: number }) {
  const floor = Math.floor(Date.now() / 300000) * 300000;
  const firstOpen = floor - 15 * 60_000;
  const secondOpen = floor - 10 * 60_000;
  const thirdOpen = floor - 5 * 60_000;
  const row = (timestamp: number, open: number, high: number, low: number, close: number) => ({
    timestamp: new Date(timestamp),
    open: open.toFixed(5),
    high: high.toFixed(5),
    low: low.toFixed(5),
    close: close.toFixed(5),
  });
  return {
    initial: [row(firstOpen, 1.1, 1.1002, 1.0998, 1.1), row(secondOpen, 1.1, 1.1002, 1.0998, 1.1)],
    advanced: [
      row(secondOpen, 1.1, 1.1002, 1.0998, 1.1),
      row(thirdOpen, 1.1, options?.high ?? 1.1003, options?.low ?? 1.0997, options?.close ?? 1.1),
    ],
  };
}

async function openProtectedBuy(live: LivePaperMarketDataService) {
  live.registerLiveConnection('conn-protection');
  const bars = protectionBars();
  live.updateClosedCandles('EURUSD', bars.initial, 'conn-protection');
  const adapter = new PaperBrokerAdapter(undefined, undefined, undefined, 'conn-protection', live);
  await adapter.connect({} as any);
  await adapter.placeOrder({
    idempotencyKey: 'protected-buy',
    instrument: 'EURUSD',
    direction: 'BUY',
    lotSize: '0.01',
    stopLoss: '1.09900',
    takeProfit: '1.10100',
    orderKind: 'MARKET',
  });
  return adapter;
}

describe('PaperBrokerAdapter — scoped VPS live market mode', () => {
  it('supports six live instruments without changing a non-live paper connection', async () => {
    const live = new LivePaperMarketDataService();
    live.registerLiveConnection('conn-live');
    live.updateClosedCandles('EURUSD', series(1.1, 5), 'conn-live');
    live.updateClosedCandles('USDJPY', series(157.3, 3), 'conn-live');

    const liveAdapter = new PaperBrokerAdapter(undefined, undefined, undefined, 'conn-live', live);
    await liveAdapter.connect({} as any);
    expect(await liveAdapter.getInstrumentList()).toHaveLength(6);
    expect((await liveAdapter.getCurrentPrice('EURUSD')).instrument).toBe('EURUSD');
    expect((await liveAdapter.getCurrentPrice('USDJPY')).instrument).toBe('USDJPY');

    const replayUntouched = new PaperBrokerAdapter(
      undefined,
      undefined,
      undefined,
      'conn-other',
      live,
    );
    await replayUntouched.connect({} as any);
    await expect(replayUntouched.getCurrentPrice('USDJPY')).rejects.toThrow(/supports EURUSD only/);
  });

  it('fills and values EURUSD and USDJPY independently in one PAPER account', async () => {
    const live = new LivePaperMarketDataService();
    live.registerLiveConnection('conn-live');
    live.updateClosedCandles('EURUSD', series(1.1, 5), 'conn-live');
    live.updateClosedCandles('USDJPY', series(157.3, 3), 'conn-live');
    const adapter = new PaperBrokerAdapter(undefined, undefined, undefined, 'conn-live', live);
    await adapter.connect({} as any);

    const eur = await adapter.placeOrder({
      idempotencyKey: 'eur-live-1',
      instrument: 'EURUSD',
      direction: 'BUY',
      lotSize: '0.01',
      stopLoss: '1.09000',
      takeProfit: '1.12000',
      orderKind: 'MARKET',
    });
    const jpy = await adapter.placeOrder({
      idempotencyKey: 'jpy-live-1',
      instrument: 'USDJPY',
      direction: 'SELL',
      lotSize: '0.01',
      stopLoss: '158.500',
      takeProfit: '156.000',
      orderKind: 'MARKET',
    });

    expect(eur.status).toBe('FILLED');
    expect(jpy.status).toBe('FILLED');
    const positions = await adapter.getOpenPositions();
    expect(positions.map((p) => p.instrument).sort()).toEqual(['EURUSD', 'USDJPY']);
    expect(Number(positions.find((p) => p.instrument === 'EURUSD')!.currentPrice)).toBeLessThan(10);
    expect(Number(positions.find((p) => p.instrument === 'USDJPY')!.currentPrice)).toBeGreaterThan(
      100,
    );
    const account = await adapter.getAccountInfo();
    expect(Number(account.equity)).toBeGreaterThan(0);

    // Simulate a process-start gap where live ownership is not available yet.
    // A durable USDJPY position must fail closed instead of being valued with
    // the default EURUSD simulator quote.
    live.unregisterLiveConnection('conn-live');
    await expect(adapter.getAccountInfo()).rejects.toThrow(/supports EURUSD only/);
  });

  it('restores the last known read-only mark after restart while fresh execution remains fail-closed', async () => {
    const connectionId = 'conn-durable-mark';
    const store = new InMemoryLivePaperStateStore();

    const firstMarket = new LivePaperMarketDataService();
    firstMarket.registerLiveConnection(connectionId);
    firstMarket.updateClosedCandles('EURUSD', series(1.1, 5), connectionId);
    const first = new PaperBrokerAdapter(
      undefined,
      undefined,
      store as unknown as PaperBrokerStateService,
      connectionId,
      firstMarket,
    );
    await first.connect({} as any);
    await first.placeOrder({
      idempotencyKey: 'durable-mark-buy',
      instrument: 'EURUSD',
      direction: 'BUY',
      lotSize: '0.01',
      stopLoss: '1.09000',
      takeProfit: '1.12000',
      orderKind: 'MARKET',
    });
    const [beforeRestart] = await first.getOpenPositions();
    expect(beforeRestart?.currentPrice).toBeDefined();
    expect(beforeRestart?.markIsStale).toBe(false);
    await first.disconnect();

    // Simulate an API process restart: live ownership is restored immediately,
    // but the in-memory quote cache has not been primed yet.
    const restartedMarket = new LivePaperMarketDataService();
    restartedMarket.registerLiveConnection(connectionId);
    const restarted = new PaperBrokerAdapter(
      undefined,
      undefined,
      store as unknown as PaperBrokerStateService,
      connectionId,
      restartedMarket,
    );
    await restarted.connect({} as any);

    const [afterRestart] = await restarted.getOpenPositions();
    expect(afterRestart?.currentPrice).toBe(beforeRestart?.currentPrice);
    expect(afterRestart?.unrealisedPnl).toBe(beforeRestart?.unrealisedPnl);
    expect(afterRestart?.markObservedAt?.toISOString()).toBe(
      beforeRestart?.markObservedAt?.toISOString(),
    );
    expect(afterRestart?.markIsStale).toBe(true);

    // The fallback is informational only. Execution/evidence quotes still
    // require a fresh provider cache and therefore fail closed.
    await expect(restarted.getCurrentPrice('EURUSD')).rejects.toThrow(
      /No live PAPER execution quote is cached yet/,
    );
  });

  it('uses streaming ticks for position marks but not for v5 PAPER fills', async () => {
    const live = new LivePaperMarketDataService();
    live.registerLiveConnection('conn-mark-only');
    const bars = protectionBars();
    live.updateClosedCandles('EURUSD', bars.initial, 'conn-mark-only');
    const executionQuote = live.getQuote('EURUSD', 20 * 60_000, 'conn-mark-only');

    live.updateStreamingMidQuote('EURUSD', 1.105, new Date(), 'conn-mark-only');
    expect(live.getMarkQuote('EURUSD', 60_000, 20 * 60_000, 'conn-mark-only').source).toBe(
      'STREAM',
    );
    expect(live.getQuote('EURUSD', 20 * 60_000, 'conn-mark-only').source).toBe('REST_M5');

    const adapter = new PaperBrokerAdapter(undefined, undefined, undefined, 'conn-mark-only', live);
    await adapter.connect({} as any);
    const result = await adapter.placeOrder({
      idempotencyKey: 'mark-only-fill',
      instrument: 'EURUSD',
      direction: 'SELL',
      lotSize: '0.01',
      stopLoss: '1.11000',
      takeProfit: '1.09000',
      orderKind: 'MARKET',
    });

    // SELL execution is intentionally spread-aware and fills at the closed-M5 bid.
    // The streaming tick is valuation-only and must never alter the fill price.
    expect(result.filledPrice).toBe(executionQuote.bid);
    const [position] = await adapter.getOpenPositions();
    expect(position!.markSource).toBe('STREAM');
    expect(Number(position!.currentPrice)).toBeCloseTo(1.10505, 5);
    expect(position!.currentPrice).not.toBe(result.filledPrice);
  });

  it('allows multiple distinct positions on the same instrument in both directions', async () => {
    const live = new LivePaperMarketDataService();
    live.registerLiveConnection('conn-multi');
    const bars = protectionBars();
    live.updateClosedCandles('EURUSD', bars.initial, 'conn-multi');
    const adapter = new PaperBrokerAdapter(undefined, undefined, undefined, 'conn-multi', live);
    await adapter.connect({} as any);

    await adapter.placeOrder({
      idempotencyKey: 'same-pair-sell-1',
      instrument: 'EURUSD',
      direction: 'SELL',
      lotSize: '0.01',
      stopLoss: '1.10150',
      takeProfit: '1.09850',
      orderKind: 'MARKET',
    });
    await adapter.placeOrder({
      idempotencyKey: 'same-pair-sell-2',
      instrument: 'EURUSD',
      direction: 'SELL',
      lotSize: '0.01',
      stopLoss: '1.10150',
      takeProfit: '1.09850',
      orderKind: 'MARKET',
    });
    await adapter.placeOrder({
      idempotencyKey: 'same-pair-buy-1',
      instrument: 'EURUSD',
      direction: 'BUY',
      lotSize: '0.01',
      stopLoss: '1.09850',
      takeProfit: '1.10150',
      orderKind: 'MARKET',
    });

    const positions = await adapter.getOpenPositions();
    expect(positions).toHaveLength(3);
    expect(positions.filter((p) => p.direction === 'SELL')).toHaveLength(2);
    expect(positions.filter((p) => p.direction === 'BUY')).toHaveLength(1);
    expect(new Set(positions.map((p) => p.externalOrderId)).size).toBe(3);
  });

  it('closes at TP when a closed M5 candle touches target between polling points', async () => {
    const live = new LivePaperMarketDataService();
    const adapter = await openProtectedBuy(live);
    const bars = protectionBars({ high: 1.1012, low: 1.0996, close: 1.1002 });
    live.updateClosedCandles('EURUSD', bars.advanced, 'conn-protection');

    await adapter.getCurrentPrice('EURUSD');

    expect(await adapter.getOpenPositions()).toHaveLength(0);
    const closed = await adapter.getClosedTrades(new Date(0), new Date(Date.now() + 60 * 60_000));
    expect(closed).toHaveLength(1);
    expect(closed[0]!.closeReason).toBe('TP');
    expect(closed[0]!.closePrice).toBe('1.10100');
  });

  it('closes at SL when a closed M5 candle touches stop between polling points', async () => {
    const live = new LivePaperMarketDataService();
    const adapter = await openProtectedBuy(live);
    const bars = protectionBars({ high: 1.1004, low: 1.0988, close: 1.0994 });
    live.updateClosedCandles('EURUSD', bars.advanced, 'conn-protection');

    await adapter.getCurrentPrice('EURUSD');

    const closed = await adapter.getClosedTrades(new Date(0), new Date(Date.now() + 60 * 60_000));
    expect(closed).toHaveLength(1);
    expect(closed[0]!.closeReason).toBe('SL');
    expect(closed[0]!.closePrice).toBe('1.09900');
  });

  it('uses conservative SL-first resolution when one M5 candle touches both SL and TP', async () => {
    const live = new LivePaperMarketDataService();
    const adapter = await openProtectedBuy(live);
    const bars = protectionBars({ high: 1.1013, low: 1.0987, close: 1.1 });
    live.updateClosedCandles('EURUSD', bars.advanced, 'conn-protection');

    await adapter.getCurrentPrice('EURUSD');

    const closed = await adapter.getClosedTrades(new Date(0), new Date(Date.now() + 60 * 60_000));
    expect(closed).toHaveLength(1);
    expect(closed[0]!.closeReason).toBe('SL');
    expect(closed[0]!.closePrice).toBe('1.09900');
    expect(closed[0]!.pathDiagnostics?.sameBarProtectionAmbiguityCount).toBe(1);
    expect(closed[0]!.pathDiagnostics?.lastSameBarProtectionAmbiguityAt).toBeInstanceOf(Date);
  });
});
