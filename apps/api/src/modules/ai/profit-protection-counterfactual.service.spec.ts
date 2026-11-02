import { DataSource } from 'typeorm';
import {
  classifyProfitProtectionCounterfactual,
  ProfitProtectionCounterfactualService,
  PROFIT_PROTECTION_COUNTERFACTUAL_ARTIFACT,
} from './profit-protection-counterfactual.service';

const closeAt = new Date('2026-10-30T10:00:30.000Z');
const candle = (minute: number, high: number, low: number) => ({
  bucket_time: new Date(`2026-10-30T10:${String(minute).padStart(2, '0')}:00.000Z`),
  high,
  low,
  sample_count: 10,
  source: 'ctrader-broker-native',
});

describe('profit-protection counterfactual classifier', () => {
  it('classifies the first original barrier for BUY and SELL paths', () => {
    expect(classifyProfitProtectionCounterfactual({
      direction: 'BUY', closeAt, takeProfit: 1.1010, stopLoss: 1.0990,
      candles: [candle(1, 1.1005, 1.0998), candle(2, 1.1011, 1.0997)],
    })).toMatchObject({ outcome: 'TP_FIRST', eventAt: new Date('2026-10-30T10:02:00.000Z') });

    expect(classifyProfitProtectionCounterfactual({
      direction: 'SELL', closeAt, takeProfit: 1.0990, stopLoss: 1.1010,
      candles: [candle(1, 1.1004, 1.0997), candle(2, 1.1011, 1.0995)],
    })).toMatchObject({ outcome: 'SL_FIRST' });
  });

  it('marks a same-M1 TP/SL touch as ambiguous instead of inventing order', () => {
    expect(classifyProfitProtectionCounterfactual({
      direction: 'BUY', closeAt, takeProfit: 1.1010, stopLoss: 1.0990,
      candles: [candle(1, 1.1012, 1.0988)],
    })).toMatchObject({ outcome: 'AMBIGUOUS_SAME_M1' });
  });

  it('fails to DATA_GAP when continuity is broken before the first barrier', () => {
    expect(classifyProfitProtectionCounterfactual({
      direction: 'BUY', closeAt, takeProfit: 1.1010, stopLoss: 1.0990,
      candles: [candle(1, 1.1004, 1.0998), candle(5, 1.1012, 1.0997)],
    })).toMatchObject({ outcome: 'DATA_GAP' });
  });

  it('returns NEITHER_4H only when the full four-hour path is continuously observed', () => {
    const candles = Array.from({ length: 240 }, (_, i) => {
      const d = new Date(Date.UTC(2026, 9, 30, 10, 1 + i, 0));
      return { bucket_time: d, high: 1.1005, low: 1.0995, sample_count: 5, source: 'ctrader-broker-native' };
    });
    expect(classifyProfitProtectionCounterfactual({
      direction: 'BUY', closeAt, takeProfit: 1.1020, stopLoss: 1.0980, candles,
    })).toMatchObject({ outcome: 'NEITHER_4H' });
  });
});

describe('ProfitProtectionCounterfactualService', () => {
  it('loads only mature cTrader DEMO profit-protection exits and persists research-only checkpoint 240', async () => {
    const candidate = {
      trade_id: '11111111-1111-4111-8111-111111111111', user_id: '22222222-2222-4222-8222-222222222222',
      trade_intent_id: '33333333-3333-4333-8333-333333333333', broker_connection_id: '44444444-4444-4444-8444-444444444444',
      instrument: 'EURUSD', direction: 'BUY', realised_pnl: '3.50', stop_loss: '1.0990', take_profit: '1.1010',
      closed_at: closeAt, initial_risk_pnl: '10.00', strategy_route: 'EARLY_TRANSITION',
    };
    const query = jest.fn()
      .mockResolvedValueOnce([candidate])
      .mockResolvedValueOnce([candle(1, 1.1005, 1.0998), candle(2, 1.1011, 1.0997)])
      .mockResolvedValue([]);
    const service = new ProfitProtectionCounterfactualService({ query } as unknown as DataSource);

    await service.runOnce(new Date('2026-10-30T14:10:00.000Z'));

    const loadSql = String(query.mock.calls[0]![0]).replace(/\s+/g, ' ');
    expect(loadSql).toContain("t.close_reason = 'PROFIT_PROTECTION'");
    expect(loadSql).toContain("bc.account_type = 'DEMO'");
    expect(loadSql).toContain("bc.broker_id IN ('ctrader', 'pepperstone-ctrader', 'icmarkets-ctrader')");
    expect(loadSql).toContain("t.closed_at <= $1::timestamptz - interval '4 hours'");
    expect(loadSql).toContain('NOT EXISTS');

    const persist = query.mock.calls.find((call: unknown[]) => String(call[0]).includes('INSERT INTO trading.post_entry_shadow_observations'));
    expect(persist).toBeDefined();
    expect(persist?.[1]).toEqual(expect.arrayContaining([
      PROFIT_PROTECTION_COUNTERFACTUAL_ARTIFACT, 240, 'TP_FIRST', 'OBSERVE',
    ]));
    expect(String(persist?.[0])).toContain("'NONE'");
    expect(String(persist?.[0])).toContain('false');
  });
});
