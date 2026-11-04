// Read-only, manually invoked research runner. Neither the test nor the audit
// may call broker order endpoints or modify trading state.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const runner = require('../../../scripts/audit-profit-protection-short-horizon.cjs') as {
  HORIZONS: number[];
  SCOPE_SQL: string;
  TRADES_SQL: string;
  CANDLES_SQL: string;
  classifyAfterExit: (input: Record<string, unknown>) => {
    outcome: string;
    eventAt: string | null;
    observedBars: number;
  };
  runProfitProtectionShortHorizonAudit: (input: Record<string, unknown>) => Promise<{
    executionAuthority: string;
    modifiesExecution: boolean;
    promotionEligible: boolean;
    trades: number;
    items: Array<{ horizonMinutes: number; outcome: string; netAfterRecordedCosts: number }>;
    byHorizon: Record<string, { tpFirst: number; pending: number; dataGap: number }>;
  }>;
};

const connectionId = '22222222-2222-4222-8222-222222222222';
const userId = '11111111-1111-4111-8111-111111111111';
const closeAt = '2026-11-04T08:57:30.000Z';
const now = '2026-11-04T09:30:00.000Z';

function trade(overrides: Record<string, unknown> = {}) {
  return {
    instrument: 'USDJPY',
    direction: 'BUY',
    strategyRoute: 'TREND_CONTINUATION',
    closedAt: closeAt,
    currency: 'EUR',
    originalTakeProfit: '158.2625',
    originalStopLoss: '158.1325',
    recordedTradeTakeProfit: '158.2625',
    recordedTradeStopLoss: '158.1325',
    entryPrice: '158.1750',
    realisedPnl: '2.14',
    commission: '-1.60',
    swap: '0',
    ...overrides,
  };
}

function m1Quotes(n: number, targetAt: number | null = null, stopAt: number | null = null) {
  return Array.from({ length: n }, (_, i) => ({
    instrument: 'USDJPY',
    timestamp: new Date(Date.parse('2026-11-04T08:58:00.000Z') + i * 60_000).toISOString(),
    high: targetAt === i ? 158.27 : 158.22,
    low: stopAt === i ? 158.12 : 158.19,
    positiveQuotes: 5,
  }));
}

class FakeClient {
  readonly calls: Array<{ sql: string; params?: unknown[] }> = [];
  constructor(
    private readonly trades: Array<Record<string, unknown>>,
    private readonly quotes: Array<Record<string, unknown>>,
    private readonly allowDemo = true,
  ) {}
  async query(sql: string, params?: unknown[]) {
    this.calls.push({ sql, params });
    if (sql.includes('CURRENT_TIMESTAMP AS "snapshotAt"')) {
      return { rows: this.allowDemo ? [{ snapshotAt: now }] : [] };
    }
    if (sql.includes('FROM trading.trades')) return { rows: this.trades };
    if (sql.includes('FROM market_data.provider_quote_candles')) return { rows: this.quotes };
    return { rows: [] };
  }
}

describe('short-horizon profit-protection after-exit counterfactual', () => {
  it('classifies closed trade target touched after early exit without assuming a broker fill', () => {
    const result = runner.classifyAfterExit({
      trade: trade(),
      snapshotAt: now,
      quoteCandles: m1Quotes(15, 9),
      horizonMinutes: 15,
    });
    expect(result).toMatchObject({
      outcome: 'TP_FIRST',
      eventAt: '2026-11-04T09:07:00.000Z',
      observedBars: 10,
    });
  });

  it('rejects invalid closed-trade stop/target geometry', () => {
    expect(
      runner.classifyAfterExit({
        trade: trade({ recordedTradeTakeProfit: '158.10' }),
        snapshotAt: now,
        quoteCandles: m1Quotes(15, 1),
        horizonMinutes: 15,
      }).outcome,
    ).toBe('DATA_GAP');
  });

  it('does not falsely credit an intent target if the closed trade target was not touched', () => {
    const record = trade({ originalTakeProfit: '158.20' });
    const result = runner.classifyAfterExit({
      trade: record,
      snapshotAt: now,
      quoteCandles: m1Quotes(15),
      horizonMinutes: 15,
    });
    expect(result.outcome).toBe('NEITHER');
  });

  it('reports recorded versus requested prices separately and scores the closed-trade price', async () => {
    const client = new FakeClient([trade({ originalTakeProfit: '158.20' })], m1Quotes(15));
    const report = await runner.runProfitProtectionShortHorizonAudit({
      client,
      userId,
      connectionId,
      since: '2026-11-04T08:00:00.000Z',
    });
    expect(report.items.find((x) => x.horizonMinutes === 15)).toMatchObject({
      outcome: 'NEITHER',
      barrierGeometrySource: 'CLOSED_TRADE_SNAPSHOT',
      recordedTradeTakeProfit: 158.2625,
      requestedIntentTakeProfit: 158.2,
      differsFromRequestedIntent: true,
    });
  });

  it('preserves SL first and same-candle ambiguity', () => {
    expect(
      runner.classifyAfterExit({
        trade: trade(),
        snapshotAt: now,
        quoteCandles: m1Quotes(15, 2, 1),
        horizonMinutes: 15,
      }).outcome,
    ).toBe('SL_FIRST');
    expect(
      runner.classifyAfterExit({
        trade: trade(),
        snapshotAt: now,
        quoteCandles: m1Quotes(15, 1, 1),
        horizonMinutes: 15,
      }).outcome,
    ).toBe('AMBIGUOUS_SAME_M1');
  });

  it('distinguishes incomplete recent candles, historical gaps and valid no-touch horizons', () => {
    expect(
      runner.classifyAfterExit({
        trade: trade(),
        quoteCandles: m1Quotes(6),
        snapshotAt: '2026-11-04T09:04:30.000Z',
        horizonMinutes: 15,
      }).outcome,
    ).toBe('PENDING');
    const quotes = m1Quotes(15).filter((_, index) => index !== 7);
    expect(
      runner.classifyAfterExit({
        trade: trade(),
        snapshotAt: now,
        quoteCandles: quotes,
        horizonMinutes: 15,
      }).outcome,
    ).toBe('DATA_GAP');
    expect(
      runner.classifyAfterExit({
        trade: trade(),
        snapshotAt: now,
        quoteCandles: m1Quotes(15),
        horizonMinutes: 15,
      }).outcome,
    ).toBe('NEITHER');
  });

  it('runs only scoped SELECTs in read-only transaction and reports fees separately', async () => {
    const client = new FakeClient([trade()], m1Quotes(15, 9));
    const report = await runner.runProfitProtectionShortHorizonAudit({
      client,
      userId,
      connectionId,
      since: '2026-11-04T08:00:00.000Z',
    });
    expect(report).toMatchObject({
      executionAuthority: 'NONE',
      modifiesExecution: false,
      promotionEligible: false,
      trades: 1,
      byHorizon: { '15': { tpFirst: 1, pending: 0 } },
    });
    expect(report.items.find((x) => x.horizonMinutes === 15)).toMatchObject({
      outcome: 'TP_FIRST',
      netAfterRecordedCosts: 0.54,
      barrierGeometrySource: 'CLOSED_TRADE_SNAPSHOT',
      differsFromRequestedIntent: false,
      recordedTradeTakeProfit: 158.2625,
      requestedIntentTakeProfit: 158.2625,
    });
    expect(report.items.find((x) => x.horizonMinutes === 30)).toMatchObject({
      outcome: 'TP_FIRST',
    });
    expect(report.items.find((x) => x.horizonMinutes === 60)).toMatchObject({
      outcome: 'TP_FIRST',
    });
    expect(client.calls[0]?.sql).toContain('READ ONLY');
    expect(client.calls.map((x) => x.sql).join(' ')).not.toMatch(
      /\b(?:INSERT|UPDATE|DELETE|ALTER|DROP)\b/i,
    );
    expect(client.calls.at(-1)?.sql).toBe('COMMIT');
    expect(runner.TRADES_SQL).toContain("t.close_reason = 'PROFIT_PROTECTION'");
    expect(runner.TRADES_SQL).toContain('t.take_profit AS "recordedTradeTakeProfit"');
    expect(runner.TRADES_SQL).toContain('ti.take_profit AS "originalTakeProfit"');
    expect(runner.CANDLES_SQL).toContain('positive_quote_sample_count > 0');
    expect(runner.CANDLES_SQL).toContain("source = 'ctrader-broker-native'");
  });

  it('fails closed for non-DEMO scope and invalid user without reading trades', async () => {
    const client = new FakeClient([], [], false);
    await expect(
      runner.runProfitProtectionShortHorizonAudit({
        client,
        userId,
        connectionId,
        since: '2026-11-04T08:00:00.000Z',
      }),
    ).rejects.toThrow('CTRADER_DEMO_SCOPE_UNAVAILABLE');
    expect(client.calls.some((x) => x.sql.includes('FROM trading.trades'))).toBe(false);
    expect(client.calls.at(-1)?.sql).toBe('ROLLBACK');
    await expect(
      runner.runProfitProtectionShortHorizonAudit({
        client,
        userId: 'bad-id',
        connectionId,
        since: '2026-11-04T08:00:00.000Z',
      }),
    ).rejects.toThrow('INVALID_AUDIT_SCOPE');
  });
});
