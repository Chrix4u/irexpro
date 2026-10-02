import { LivePaperMarketDataService } from './live-paper-market-data.service';

function candles(base: number, digits: number) {
  const end = Math.floor(Date.now() / 300000) * 300000 - 300000;
  return Array.from({ length: 70 }, (_, i) => {
    const close = base + i * (base > 10 ? 0.001 : 0.00001);
    return {
      timestamp: new Date(end - (69 - i) * 300000),
      open: close.toFixed(digits),
      high: (close + (base > 10 ? 0.005 : 0.00005)).toFixed(digits),
      low: (close - (base > 10 ? 0.005 : 0.00005)).toFixed(digits),
      close: close.toFixed(digits),
    };
  });
}

describe('LivePaperMarketDataService', () => {
  it('keeps the six-pair live mode scoped to explicitly registered connections', () => {
    const service = new LivePaperMarketDataService();
    expect(service.isLiveConnection('conn-live')).toBe(false);
    service.registerLiveConnection('conn-live');
    expect(service.isLiveConnection('conn-live')).toBe(true);
    expect(service.isLiveConnection('conn-replay')).toBe(false);
    service.unregisterLiveConnection('conn-live');
    expect(service.isLiveConnection('conn-live')).toBe(false);
  });

  it('builds conservative bid/ask paper quotes from the latest fully closed candle', () => {
    const service = new LivePaperMarketDataService();
    service.updateClosedCandles('EURUSD', candles(1.1, 5));
    service.updateClosedCandles('USDJPY', candles(157, 3));

    const eur = service.getQuote('EURUSD');
    const jpy = service.getQuote('USDJPY');
    expect(Number(eur.ask) - Number(eur.bid)).toBeCloseTo(0.0001, 5);
    expect(Number(jpy.ask) - Number(jpy.bid)).toBeCloseTo(0.01, 3);
    expect(service.getOHLCV('EURUSD', 'M5', 20)).toHaveLength(20);
    expect(service.getOHLCV('EURUSD', 'M15', 20).length).toBeGreaterThan(0);
    expect(service.getOHLCV('EURUSD', 'H1', 20).length).toBeGreaterThan(0);
    expect(service.instruments).toEqual([
      'EURUSD',
      'GBPUSD',
      'USDJPY',
      'AUDUSD',
      'USDCAD',
      'USDCHF',
    ]);
  });

  it('prefers a fresh streaming mark without changing the M5 execution quote or candle evidence', () => {
    const service = new LivePaperMarketDataService();
    service.updateClosedCandles('EURUSD', candles(1.1, 5));
    const before = service.getOHLCV('EURUSD', 'M5', 2);
    const executionBefore = service.getQuote('EURUSD');
    service.updateStreamingMidQuote('EURUSD', 1.23456, new Date());

    const executionAfter = service.getQuote('EURUSD');
    const mark = service.getMarkQuote('EURUSD');
    expect(executionBefore.source).toBe('REST_M5');
    expect(executionAfter).toEqual(executionBefore);
    expect(mark.source).toBe('STREAM');
    expect(Number(mark.ask) - Number(mark.bid)).toBeCloseTo(0.0001, 5);
    expect(service.status().streamingInstruments).toEqual(['EURUSD']);
    expect(service.getOHLCV('EURUSD', 'M5', 2)).toEqual(before);
  });

  it('falls back to the closed-candle quote when no fresh streaming mark exists', () => {
    const service = new LivePaperMarketDataService();
    service.updateClosedCandles('USDJPY', candles(157, 3));
    expect(service.getQuote('USDJPY').source).toBe('REST_M5');
    expect(service.getMarkQuote('USDJPY').source).toBe('REST_M5');
    expect(service.getPositionMarkQuote('USDJPY').isStale).toBe(false);
  });

  it('keeps stale last-known marks available for read-only position valuation while execution fails closed', () => {
    const service = new LivePaperMarketDataService();
    service.updateClosedCandles('USDJPY', candles(157, 3));
    const observedAt = service.getQuote('USDJPY').timestamp.getTime();
    const now = jest.spyOn(Date, 'now').mockReturnValue(observedAt + 21 * 60_000);
    try {
      expect(() => service.getQuote('USDJPY')).toThrow(/stale/);
      expect(() => service.getMarkQuote('USDJPY')).toThrow(/stale/);
      const mark = service.getPositionMarkQuote('USDJPY');
      expect(mark.source).toBe('REST_M5');
      expect(mark.isStale).toBe(true);
      expect(mark.timestamp.getTime()).toBe(observedAt);
    } finally {
      now.mockRestore();
    }
  });

  it('isolates market caches by PAPER connection so research and broker-parity feeds cannot mix', () => {
    const service = new LivePaperMarketDataService();
    service.updateClosedCandles('EURUSD', candles(1.1, 5), 'research-paper');
    service.updateClosedCandles('EURUSD', candles(1.2, 5), 'broker-parity-paper');

    const research = service.getQuote('EURUSD', 20 * 60_000, 'research-paper');
    const parity = service.getQuote('EURUSD', 20 * 60_000, 'broker-parity-paper');
    expect(research.bid).not.toBe(parity.bid);
    expect(service.status('research-paper').cachedInstrumentCount).toBe(1);
    expect(service.status('broker-parity-paper').cachedInstrumentCount).toBe(1);
    expect(() => service.getQuote('GBPUSD', 20 * 60_000, 'research-paper')).toThrow(
      /No live PAPER execution quote/,
    );
  });

  it('fails closed on unsupported timeframes and missing quotes', () => {
    const service = new LivePaperMarketDataService();
    expect(() => service.getQuote('EURUSD')).toThrow(/No live PAPER execution quote/);
    service.updateClosedCandles('EURUSD', candles(1.1, 5));
    expect(() => service.getOHLCV('EURUSD', 'M1', 10)).toThrow(/supports M5\/M15\/M30\/H1\/H4\/D1/);
  });
});
