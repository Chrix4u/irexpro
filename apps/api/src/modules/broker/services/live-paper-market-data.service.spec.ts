import { LivePaperMarketDataService } from './live-paper-market-data.service';

function candles(base: number, digits: number, count = 70) {
  const end = Math.floor(Date.now() / 300000) * 300000 - 300000;
  return Array.from({ length: count }, (_, i) => {
    const close = base + i * (base > 10 ? 0.001 : 0.00001);
    return {
      timestamp: new Date(end - (count - 1 - i) * 300000),
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

  it('applies a connection-scoped calibrated fallback spread to the PAPER closed-candle execution quote', () => {
    const service = new LivePaperMarketDataService();
    service.updateClosedCandles('EURUSD', candles(1.1, 5), 'conn-a');
    service.updateClosedCandles('EURUSD', candles(1.1, 5), 'conn-b');

    service.setPaperFallbackSpread('EURUSD', 0.00004, 'conn-a');

    const calibrated = service.getQuote('EURUSD', 20 * 60_000, 'conn-a');
    const unchanged = service.getQuote('EURUSD', 20 * 60_000, 'conn-b');
    expect(Number(calibrated.ask) - Number(calibrated.bid)).toBeCloseTo(0.00004, 5);
    expect(Number(unchanged.ask) - Number(unchanged.bid)).toBeCloseTo(0.0001, 5);
    expect(service.getPaperFallbackSpread('EURUSD', 'conn-a')).toBe(0.00004);
    expect(service.getPaperFallbackSpread('EURUSD', 'conn-b')).toBe(0.0001);
  });

  it('keeps fresh provider bid/ask authoritative over the calibrated PAPER fallback spread', () => {
    const service = new LivePaperMarketDataService();
    service.updateClosedCandles('USDCAD', candles(1.42, 5), 'conn-a');
    service.setPaperFallbackSpread('USDCAD', 0.00003, 'conn-a');
    service.updateProviderQuote('USDCAD', '1.42480', '1.42481', new Date(), 'conn-a');

    const execution = service.getQuote('USDCAD', 20 * 60_000, 'conn-a');
    expect(execution.source).toBe('PROVIDER');
    expect(execution.bid).toBe('1.42480');
    expect(execution.ask).toBe('1.42481');
    expect(service.getPaperFallbackSpread('USDCAD', 'conn-a')).toBe(0.00003);
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

  it('uses a fresh positive provider bid/ask as the PAPER execution quote without changing candle evidence', () => {
    const service = new LivePaperMarketDataService();
    service.updateClosedCandles('USDCAD', candles(1.42, 5));
    const candlesBefore = service.getOHLCV('USDCAD', 'M5', 2);
    const observedAt = new Date();

    service.updateProviderQuote('USDCAD', '1.42480', '1.42481', observedAt);

    const execution = service.getQuote('USDCAD');
    expect(execution.source).toBe('PROVIDER');
    expect(execution.bid).toBe('1.42480');
    expect(execution.ask).toBe('1.42481');
    expect(execution.timestamp).toEqual(observedAt);
    expect(service.getOHLCV('USDCAD', 'M5', 2)).toEqual(candlesBefore);
  });

  it('uses exact broker-native provider bid/ask for both execution and position marks when fresh', () => {
    const service = new LivePaperMarketDataService();
    service.updateClosedCandles('USDCAD', candles(1.42, 5));
    const executionBefore = service.getQuote('USDCAD');
    const observedAt = new Date();

    service.updateProviderQuote('USDCAD', '1.42480', '1.42492', observedAt);

    const executionAfter = service.getQuote('USDCAD');
    const mark = service.getPositionMarkQuote('USDCAD');
    expect(executionBefore.source).toBe('REST_M5');
    expect(executionAfter.source).toBe('PROVIDER');
    expect(executionAfter.bid).toBe('1.42480');
    expect(executionAfter.ask).toBe('1.42492');
    expect(mark.source).toBe('PROVIDER');
    expect(mark.bid).toBe('1.42480');
    expect(mark.ask).toBe('1.42492');
    expect(mark.timestamp).toEqual(observedAt);
    expect(mark.isStale).toBe(false);
  });

  it('never uses a zero-spread provider snapshot as an execution fill', () => {
    const service = new LivePaperMarketDataService();
    service.updateClosedCandles('EURUSD', candles(1.1, 5));
    service.updateProviderQuote('EURUSD', '1.11867', '1.11867', new Date());

    expect(service.getQuote('EURUSD').source).toBe('REST_M5');
    expect(service.getPositionMarkQuote('EURUSD').source).toBe('PROVIDER');
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

  it('retains 1200 M5 bars so PAPER M1 can build at least 22 completed H4 context bars', () => {
    const service = new LivePaperMarketDataService();
    service.updateClosedCandles('EURUSD', candles(1.1, 5, 1300), 'paper-deep-history');

    expect(service.getOHLCV('EURUSD', 'M5', 2000, 'paper-deep-history')).toHaveLength(1200);
    expect(
      service.getOHLCV('EURUSD', 'H4', 30, 'paper-deep-history').length,
    ).toBeGreaterThanOrEqual(22);
  });

  it('merges REST M1 bootstrap history without overwriting a newer live streamed bucket', () => {
    const service = new LivePaperMarketDataService();
    const connectionId = 'paper-m1-race';

    service.updateStreamingMidQuote(
      'EURUSD',
      1.10025,
      new Date('2026-10-19T08:02:10.000Z'),
      connectionId,
    );
    service.updateStreamingMidQuote(
      'EURUSD',
      1.1004,
      new Date('2026-10-19T08:02:35.000Z'),
      connectionId,
    );

    service.updateClosedM1Candles(
      'EURUSD',
      [
        {
          timestamp: new Date('2026-10-19T08:00:00.000Z'),
          open: '1.10000',
          high: '1.10020',
          low: '1.09990',
          close: '1.10010',
        },
        {
          timestamp: new Date('2026-10-19T08:01:00.000Z'),
          open: '1.10010',
          high: '1.10030',
          low: '1.10000',
          close: '1.10020',
        },
      ],
      connectionId,
    );
    service.updateStreamingMidQuote(
      'EURUSD',
      1.1003,
      new Date('2026-10-19T08:03:05.000Z'),
      connectionId,
    );

    const closed = service.getOHLCV('EURUSD', 'M1', 10, connectionId);
    expect(closed.at(-1)).toMatchObject({
      timestamp: new Date('2026-10-19T08:02:00.000Z'),
      open: '1.10025',
      high: '1.10040',
      low: '1.10025',
      close: '1.10040',
    });
  });

  it('reports M1 continuity only when the exact expected closed minute is covered without gaps', () => {
    const service = new LivePaperMarketDataService();
    const connectionId = 'paper-m1-continuity';
    service.updateClosedM1Candles(
      'EURUSD',
      [
        {
          timestamp: new Date('2026-10-19T11:56:00.000Z'),
          open: '1.10000',
          high: '1.10020',
          low: '1.09990',
          close: '1.10010',
        },
        {
          timestamp: new Date('2026-10-19T11:57:00.000Z'),
          open: '1.10010',
          high: '1.10030',
          low: '1.10000',
          close: '1.10020',
        },
        {
          timestamp: new Date('2026-10-19T11:59:00.000Z'),
          open: '1.10020',
          high: '1.10040',
          low: '1.10010',
          close: '1.10030',
        },
      ],
      connectionId,
    );

    expect(
      service.hasContiguousM1History(
        'EURUSD',
        3,
        new Date('2026-10-19T11:59:00.000Z'),
        connectionId,
      ),
    ).toBe(false);

    service.updateClosedM1Candles(
      'EURUSD',
      [
        {
          timestamp: new Date('2026-10-19T11:58:00.000Z'),
          open: '1.10020',
          high: '1.10035',
          low: '1.10010',
          close: '1.10025',
        },
        {
          timestamp: new Date('2026-10-19T11:59:00.000Z'),
          open: '1.10025',
          high: '1.10040',
          low: '1.10015',
          close: '1.10030',
        },
      ],
      connectionId,
    );

    expect(
      service.hasContiguousM1History(
        'EURUSD',
        3,
        new Date('2026-10-19T11:59:00.000Z'),
        connectionId,
      ),
    ).toBe(true);
    expect(
      service.hasContiguousM1History(
        'EURUSD',
        3,
        new Date('2026-10-19T12:00:00.000Z'),
        connectionId,
      ),
    ).toBe(false);
  });

  it('stores completed M1 bootstrap candles and closes streamed M1 buckets causally per connection', () => {
    const service = new LivePaperMarketDataService();
    const connectionId = 'paper-m1';
    service.updateClosedM1Candles(
      'EURUSD',
      [
        {
          timestamp: new Date('2026-10-19T08:00:00.000Z'),
          open: '1.10000',
          high: '1.10020',
          low: '1.09990',
          close: '1.10010',
        },
        {
          timestamp: new Date('2026-10-19T08:01:00.000Z'),
          open: '1.10010',
          high: '1.10030',
          low: '1.10000',
          close: '1.10020',
        },
      ],
      connectionId,
    );

    expect(service.getOHLCV('EURUSD', 'M1', 10, connectionId)).toHaveLength(2);
    expect(() => service.getOHLCV('EURUSD', 'M1', 10, 'other-paper')).toThrow(
      /No live PAPER M1 candles/,
    );

    service.updateStreamingMidQuote(
      'EURUSD',
      1.10025,
      new Date('2026-10-19T08:02:10.000Z'),
      connectionId,
    );
    service.updateStreamingMidQuote(
      'EURUSD',
      1.1004,
      new Date('2026-10-19T08:02:35.000Z'),
      connectionId,
    );
    service.updateStreamingMidQuote(
      'EURUSD',
      1.10015,
      new Date('2026-10-19T08:02:50.000Z'),
      connectionId,
    );

    expect(service.getOHLCV('EURUSD', 'M1', 10, connectionId)).toHaveLength(2);

    service.updateStreamingMidQuote(
      'EURUSD',
      1.1003,
      new Date('2026-10-19T08:03:05.000Z'),
      connectionId,
    );
    const closed = service.getOHLCV('EURUSD', 'M1', 10, connectionId);
    expect(closed).toHaveLength(3);
    expect(closed.at(-1)).toMatchObject({
      timestamp: new Date('2026-10-19T08:02:00.000Z'),
      open: '1.10025',
      high: '1.10040',
      low: '1.10015',
      close: '1.10015',
    });
  });

  it('fails closed on unsupported timeframes and missing quotes', () => {
    const service = new LivePaperMarketDataService();
    expect(() => service.getQuote('EURUSD')).toThrow(/No live PAPER execution quote/);
    service.updateClosedCandles('EURUSD', candles(1.1, 5));
    expect(() => service.getOHLCV('EURUSD', 'M2', 10)).toThrow(
      /supports M1\/M5\/M15\/M30\/H1\/H4\/D1/,
    );
  });
});
