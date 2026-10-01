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

  it('fails closed on unsupported timeframes and missing quotes', () => {
    const service = new LivePaperMarketDataService();
    expect(() => service.getQuote('EURUSD')).toThrow(/No live PAPER quote/);
    service.updateClosedCandles('EURUSD', candles(1.1, 5));
    expect(() => service.getOHLCV('EURUSD', 'M1', 10)).toThrow(/supports M5\/M15\/M30\/H1\/H4\/D1/);
  });
});
