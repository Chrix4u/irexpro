jest.mock('./api', () => ({
  api: { request: jest.fn() },
}));

import { api } from './api';
import { loadProfitProtectionExitQuality } from './profit-protection-exit-quality';

const request = api.request as jest.MockedFunction<typeof api.request>;

describe('loadProfitProtectionExitQuality', () => {
  beforeEach(() => request.mockReset());

  it('serializes only defined filters and uses the authenticated shared API client', async () => {
    request.mockResolvedValueOnce({
      page: 2,
      pageSize: 50,
      total: 0,
      totalPages: 0,
      summary: {
        total: 0,
        resolvedCount: 0,
        tpFirstCount: 0,
        slFirstCount: 0,
        tpFirstRate: null,
        slFirstRate: null,
        ambiguousCount: 0,
        neitherCount: 0,
        dataGapCount: 0,
        smallProfitCount: 0,
        smallProfitTpFirstCount: 0,
        smallProfitTpFirstRate: null,
        accountCurrency: null,
        actualRealisedPnl: null,
        averageActualExitR: null,
        averageCounterfactualR: null,
        averageRDelta: null,
        currencyBreakdown: [],
      },
      routes: [],
      items: [],
    });

    await loadProfitProtectionExitQuality({
      brokerConnectionId: '22222222-2222-4222-8222-222222222222',
      from: '2026-10-28T00:00:00.000Z',
      to: '2026-10-31T23:59:59.999Z',
      instrument: 'EURUSD',
      direction: 'SELL',
      strategyRoute: 'CONFIRMED_REVERSAL',
      outcome: 'TP_FIRST',
      smallProfitOnly: true,
      page: 2,
      pageSize: 50,
    });

    expect(request).toHaveBeenCalledTimes(1);
    const [path, init] = request.mock.calls[0]!;
    const url = new URL(String(path), 'https://example.test');
    expect(url.pathname).toBe('/trading/reports/profit-protection-exit-quality');
    expect(Object.fromEntries(url.searchParams.entries())).toEqual({
      brokerConnectionId: '22222222-2222-4222-8222-222222222222',
      from: '2026-10-28T00:00:00.000Z',
      to: '2026-10-31T23:59:59.999Z',
      instrument: 'EURUSD',
      direction: 'SELL',
      strategyRoute: 'CONFIRMED_REVERSAL',
      outcome: 'TP_FIRST',
      smallProfitOnly: 'true',
      page: '2',
      pageSize: '50',
    });
    expect(init).toEqual({ method: 'GET' });
  });

  it('does not emit false/blank filters', async () => {
    request.mockResolvedValueOnce({
      page: 1,
      pageSize: 25,
      total: 0,
      totalPages: 0,
      summary: {
        total: 0, resolvedCount: 0, tpFirstCount: 0, slFirstCount: 0,
        tpFirstRate: null, slFirstRate: null, ambiguousCount: 0, neitherCount: 0,
        dataGapCount: 0, smallProfitCount: 0, smallProfitTpFirstCount: 0,
        smallProfitTpFirstRate: null, accountCurrency: null, actualRealisedPnl: null,
        averageActualExitR: null, averageCounterfactualR: null, averageRDelta: null,
        currencyBreakdown: [],
      },
      routes: [],
      items: [],
    });

    await loadProfitProtectionExitQuality({ instrument: '', smallProfitOnly: false });
    expect(request).toHaveBeenCalledWith(
      '/trading/reports/profit-protection-exit-quality',
      { method: 'GET' },
    );
  });
});
