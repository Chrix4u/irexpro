import { PaperBrokerAdapter } from './paper-broker.adapter';
import { LivePaperMarketDataService } from '../services/live-paper-market-data.service';

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

describe('PaperBrokerAdapter — scoped VPS live market mode', () => {
  it('supports six live instruments without changing a non-live paper connection', async () => {
    const live = new LivePaperMarketDataService();
    live.registerLiveConnection('conn-live');
    live.updateClosedCandles('EURUSD', series(1.1, 5));
    live.updateClosedCandles('USDJPY', series(157.3, 3));

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
    live.updateClosedCandles('EURUSD', series(1.1, 5));
    live.updateClosedCandles('USDJPY', series(157.3, 3));
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
  });
});
