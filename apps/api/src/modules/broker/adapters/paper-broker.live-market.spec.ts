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
  // Initial evidence ends at the current M5 boundary. The advanced fixture
  // starts at the next boundary so its OHLC is fully post-fill for live orders
  // created inside the current M5 window.
  const firstOpen = floor - 10 * 60_000;
  const secondOpen = floor - 5 * 60_000;
  const thirdOpen = floor + 5 * 60_000;
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

  it('uses streaming ticks for position marks/protection but not PAPER entry fills', async () => {
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
    // The streaming tick must never alter the entry fill price.
    expect(result.filledPrice).toBe(executionQuote.bid);
    const [position] = await adapter.getOpenPositions();
    expect(position!.markSource).toBe('STREAM');
    expect(Number(position!.currentPrice)).toBeCloseTo(1.10505, 5);
    expect(position!.currentPrice).not.toBe(result.filledPrice);
  });

  it('locks an armed live-PAPER profit on a fresh streaming give-back before M5 close', async () => {
    const live = new LivePaperMarketDataService();
    live.registerLiveConnection('conn-profit-lock');
    const bars = protectionBars();
    live.updateClosedCandles('EURUSD', bars.initial, 'conn-profit-lock');
    const adapter = new PaperBrokerAdapter(
      undefined,
      undefined,
      undefined,
      'conn-profit-lock',
      live,
    );
    await adapter.connect({} as any);
    await adapter.placeOrder({
      idempotencyKey: 'live-profit-lock',
      instrument: 'EURUSD',
      direction: 'BUY',
      lotSize: '0.01',
      stopLoss: '1.09900',
      takeProfit: '1.10500',
      orderKind: 'MARKET',
    });

    // Arm above 0.60R without touching TP. Fixed 1-pip spread => bid 1.10075.
    live.updateStreamingMidQuote('EURUSD', 1.1008, new Date(), 'conn-profit-lock');
    let positions = await adapter.getOpenPositions();
    expect(positions).toHaveLength(1);
    expect(Number(positions[0]!.pathDiagnostics?.maxFavorablePnl)).toBeGreaterThan(0.6);

    // Retreat below the 55%-of-peak retention floor. Fresh mark protection
    // must close immediately instead of waiting for TP, SL or M5 close.
    live.updateStreamingMidQuote('EURUSD', 1.1003, new Date(), 'conn-profit-lock');
    positions = await adapter.getOpenPositions();
    expect(positions).toHaveLength(0);

    const closed = await adapter.getClosedTrades(new Date(0), new Date(Date.now() + 60 * 60_000));
    expect(closed).toHaveLength(1);
    expect(closed[0]!.closeReason).toBe('PROFIT_LOCK');
    expect(Number(closed[0]!.realisedPnl)).toBeGreaterThan(0);
    expect(Number(closed[0]!.pathDiagnostics?.profitGiveback)).toBeGreaterThan(0);
  });

  it('closes a BUY at TP from a fresh streaming bid before the M5 candle closes', async () => {
    const live = new LivePaperMarketDataService();
    const adapter = await openProtectedBuy(live);

    // 1.10110 mid with the fixed 1-pip spread => bid 1.10105, beyond 1.10100 TP.
    live.updateStreamingMidQuote('EURUSD', 1.1011, new Date(), 'conn-protection');

    // Open-position polling is a protection heartbeat; the trade must already
    // be gone instead of remaining visible above its target until M5 close.
    expect(await adapter.getOpenPositions()).toHaveLength(0);
    const closed = await adapter.getClosedTrades(new Date(0), new Date(Date.now() + 60 * 60_000));
    expect(closed).toHaveLength(1);
    expect(closed[0]!.closeReason).toBe('TP');
    expect(closed[0]!.closePrice).toBe('1.10100');
    expect(Number(closed[0]!.pathDiagnostics?.maxFavorablePnl)).toBeGreaterThanOrEqual(1);
  });

  it('closes a BUY at SL from a fresh provider bid before the M5 candle closes', async () => {
    const live = new LivePaperMarketDataService();
    const adapter = await openProtectedBuy(live);

    live.updateProviderQuote('EURUSD', '1.09895', '1.09905', new Date(), 'conn-protection');

    expect(await adapter.getOpenPositions()).toHaveLength(0);
    const closed = await adapter.getClosedTrades(new Date(0), new Date(Date.now() + 60 * 60_000));
    expect(closed).toHaveLength(1);
    expect(closed[0]!.closeReason).toBe('SL');
    expect(closed[0]!.closePrice).toBe('1.09900');
  });

  it('ignores a fresh provider mark observed before the live PAPER position was actually filled', async () => {
    const live = new LivePaperMarketDataService();
    live.registerLiveConnection('conn-causal-fill');
    const bars = protectionBars();
    live.updateClosedCandles('EURUSD', bars.initial, 'conn-causal-fill');

    // This broker mark is fresh enough to be protection-authoritative, but it
    // was observed BEFORE the order below exists. Its bid is below the future
    // stop, so treating the stale M5 evidence clock as the fill time would
    // incorrectly stop the position immediately.
    const preFillObservedAt = new Date(Date.now() - 2_000);
    live.updateProviderQuote('EURUSD', '1.09890', '1.09900', preFillObservedAt, 'conn-causal-fill');

    const adapter = new PaperBrokerAdapter(
      undefined,
      undefined,
      undefined,
      'conn-causal-fill',
      live,
    );
    await adapter.connect({} as any);
    await adapter.placeOrder({
      idempotencyKey: 'causal-fill-buy',
      instrument: 'EURUSD',
      direction: 'BUY',
      lotSize: '0.01',
      stopLoss: '1.09900',
      takeProfit: '1.10100',
      orderKind: 'MARKET',
    });

    const positions = await adapter.getOpenPositions();
    expect(positions).toHaveLength(1);
    expect(positions[0]!.openedAt.getTime()).toBeGreaterThan(preFillObservedAt.getTime());
  });

  it('timestamps fast provider protection at the causal quote observation time', async () => {
    const live = new LivePaperMarketDataService();
    live.registerLiveConnection('conn-causal-close');
    const bars = protectionBars();
    live.updateClosedCandles('EURUSD', bars.initial, 'conn-causal-close');

    const adapter = new PaperBrokerAdapter(
      undefined,
      undefined,
      undefined,
      'conn-causal-close',
      live,
    );
    await adapter.connect({} as any);
    await adapter.placeOrder({
      idempotencyKey: 'causal-close-buy',
      instrument: 'EURUSD',
      direction: 'BUY',
      lotSize: '0.01',
      stopLoss: '1.09900',
      takeProfit: '1.10100',
      orderKind: 'MARKET',
    });

    const [opened] = await adapter.getOpenPositions();
    expect(opened).toBeDefined();
    // Make the protection observation deterministically later than the fill.
    // The live-mark freshness path accepts up to 5s of positive clock skew.
    const observedAt = new Date(opened!.openedAt.getTime() + 1_000);
    live.updateProviderQuote('EURUSD', '1.09890', '1.09900', observedAt, 'conn-causal-close');

    expect(await adapter.getOpenPositions()).toHaveLength(0);
    const closed = await adapter.getClosedTrades(new Date(0), new Date(Date.now() + 60 * 60_000));
    expect(closed).toHaveLength(1);
    expect(closed[0]!.closedAt.toISOString()).toBe(observedAt.toISOString());
    expect(closed[0]!.closedAt.getTime()).toBeGreaterThanOrEqual(opened!.openedAt.getTime());
  });

  it('ignores a closed M5 candle that started before the live PAPER fill', async () => {
    const live = new LivePaperMarketDataService();
    const connectionId = 'conn-straddling-candle';
    live.registerLiveConnection(connectionId);
    const floor = Math.floor(Date.now() / 300000) * 300000;
    const row = (timestamp: number, high: number, low: number, close: number) => ({
      timestamp: new Date(timestamp),
      open: '1.10000',
      high: high.toFixed(5),
      low: low.toFixed(5),
      close: close.toFixed(5),
    });

    live.updateClosedCandles(
      'EURUSD',
      [row(floor - 10 * 60_000, 1.1002, 1.0998, 1.1), row(floor - 5 * 60_000, 1.1002, 1.0998, 1.1)],
      connectionId,
    );
    const adapter = new PaperBrokerAdapter(undefined, undefined, undefined, connectionId, live);
    await adapter.connect({} as any);
    await adapter.placeOrder({
      idempotencyKey: 'straddling-candle-buy',
      instrument: 'EURUSD',
      direction: 'BUY',
      lotSize: '0.01',
      stopLoss: '1.09900',
      takeProfit: '1.10100',
      orderKind: 'MARKET',
    });
    const [opened] = await adapter.getOpenPositions();
    expect(opened).toBeDefined();
    expect(opened!.openedAt.getTime()).toBeGreaterThan(floor);

    // This newly closed bar began before the fill. Its pre/post-fill path is
    // unknowable from OHLC alone, so its target touch cannot be causal evidence.
    live.updateClosedCandles(
      'EURUSD',
      [row(floor - 5 * 60_000, 1.1002, 1.0998, 1.1), row(floor, 1.1012, 1.0996, 1.1002)],
      connectionId,
    );
    await adapter.getCurrentPrice('EURUSD');

    expect(await adapter.getOpenPositions()).toHaveLength(1);
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
