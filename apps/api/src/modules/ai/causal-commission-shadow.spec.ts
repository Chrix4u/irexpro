export {};
// Pure research code; no execution or broker imports.
type Estimate = {
  state: string;
  historicalCount: number;
  predictedCommissionR: number | null;
  predictedAfterCommissionR?: number | null;
  p90CommissionPerLot?: number;
  costSource?: string;
};
type Report = {
  artifact: string;
  researchOnly: boolean;
  executionAuthority: string;
  modifiesExecution: boolean;
  evaluated: number;
  byPair: Record<
    string,
    {
      historicalSamples: number;
      meanForecastCommissionR: number;
      meanObservedCommissionR: number;
      meanAbsoluteErrorR: number;
      shadowBelow008R: number;
    }
  >;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const shadow = require('../../../scripts/research-causal-commission-estimator.cjs') as {
  percentile: (a: number[], p: number) => number | null;
  commissionShadowAtEntry: (
    candidate: Record<string, unknown>,
    history: Array<Record<string, unknown>>,
    opts?: Record<string, unknown>,
  ) => Estimate;
  backtestCommissionShadow: (
    rows: Array<Record<string, unknown>>,
    opts?: Record<string, unknown>,
  ) => Report;
};
const broker = 'demo-broker-account';
function trade(n: number, overrides: Record<string, unknown> = {}) {
  return {
    brokerConnectionId: broker,
    instrument: 'USDJPY',
    accountCurrency: 'EUR',
    lots: 0.2,
    initialCashRisk: 10,
    openedAt: new Date(Date.parse('2026-11-04T09:00:00Z') + n * 60_000).toISOString(),
    closedAt: new Date(Date.parse('2026-11-04T09:00:30Z') + n * 60_000).toISOString(),
    commission: 1.6,
    preExistingExpectedNetR: 0.32,
    ...overrides,
  };
}
function history() {
  return [0, 1, 2, 3, 4].map((n) => trade(n));
}

describe('causal commission research estimator', () => {
  it('estimates only from five strictly earlier closes in same broker and pair', () => {
    const r = shadow.commissionShadowAtEntry(trade(10), history());
    expect(r.state).toBe('SHADOW_ESTIMATE');
    expect(r.historicalCount).toBe(5);
    expect(r.predictedCommissionR).toBeCloseTo(0.16);
    expect(r.predictedAfterCommissionR).toBeCloseTo(0.16);
    expect(r.costSource).toBe('STRICTLY_PRIOR_CLOSED_TRADES_P90_PER_LOT');
  });

  it('computes a conservative P90 with deterministic interpolation', () => {
    expect(shadow.percentile([8, 8, 8, 8, 10], 0.9)).toBeCloseTo(9.2);
    const hist = history().map((x, i) => ({ ...x, commission: i === 4 ? 2 : 1.6 }));
    const r = shadow.commissionShadowAtEntry(trade(10), hist);
    expect(r.p90CommissionPerLot).toBeCloseTo(9.2);
    expect(r.predictedCommissionR).toBeCloseTo(0.184);
  });

  it('never leaks commission of a position still open when candidate enters', () => {
    const h = [
      ...history(),
      trade(1, {
        commission: 200,
        openedAt: '2026-11-04T09:01:00Z',
        closedAt: '2026-11-04T09:11:00Z',
      }),
    ];
    const r = shadow.commissionShadowAtEntry(trade(10), h);
    expect(r.historicalCount).toBe(5);
    expect(r.predictedCommissionR).toBeCloseTo(0.16);
  });

  it('excludes a prior trade closed exactly at candidate entry time', () => {
    const h = [
      ...history(),
      trade(9, {
        commission: 200,
        closedAt: '2026-11-04T09:10:00Z',
      }),
    ];
    expect(shadow.commissionShadowAtEntry(trade(10), h).historicalCount).toBe(5);
  });

  it('blocks using another broker, currency, pair or insufficient samples', () => {
    const h = history().slice(0, 4);
    h.push(trade(4, { brokerConnectionId: 'other-account' }));
    h.push(trade(5, { accountCurrency: 'USD' }));
    h.push(trade(6, { instrument: 'EURUSD' }));
    const r = shadow.commissionShadowAtEntry(trade(10), h);
    expect(r.state).toBe('INSUFFICIENT_HISTORY');
    expect(r.historicalCount).toBe(4);
    expect(r.predictedCommissionR).toBeNull();
  });

  it('fails closed for candidate lot/risk/connection problems', () => {
    expect(
      shadow.commissionShadowAtEntry(trade(10, { initialCashRisk: null }), history()).state,
    ).toBe('INVALID_CANDIDATE');
    expect(shadow.commissionShadowAtEntry(trade(10, { lots: 0 }), history()).state).toBe(
      'INVALID_CANDIDATE',
    );
    expect(
      shadow.commissionShadowAtEntry(trade(10, { brokerConnectionId: null }), history()).state,
    ).toBe('INVALID_CANDIDATE');
  });

  it('does not reuse stale commissions beyond the seven-day history window', () => {
    const aged = history().map((x) => ({
      ...x,
      closedAt: '2026-10-01T09:00:00Z',
    }));
    expect(shadow.commissionShadowAtEntry(trade(10), aged).state).toBe('INSUFFICIENT_HISTORY');
  });

  it('tracks predicted vs actual R and hypothetical selection without changing execution', () => {
    const report = shadow.backtestCommissionShadow([
      ...history(),
      trade(10, { commission: 1.8, preExistingExpectedNetR: 0.2 }),
      trade(15, { commission: 1.6, preExistingExpectedNetR: 0.3 }),
    ]);
    expect(report).toMatchObject({
      artifact: 'causal-commission-per-lot-shadow-v1',
      researchOnly: true,
      modifiesExecution: false,
      executionAuthority: 'NONE',
      evaluated: 2,
    });
    expect(report.byPair['EUR | USDJPY']).toMatchObject({
      historicalSamples: 2,
      shadowBelow008R: 1,
    });
  });

  it('rejects mixing broker accounts and oversized unbounded histories', () => {
    expect(() =>
      shadow.backtestCommissionShadow([
        trade(1),
        trade(2, { brokerConnectionId: 'other-account' }),
      ]),
    ).toThrow('MIXED_OR_UNSCOPED_ACCOUNTS');
    expect(() =>
      shadow.backtestCommissionShadow(Array.from({ length: 2001 }, (_, i) => trade(i))),
    ).toThrow('INVALID_HISTORY_LENGTH');
  });

  it('does not mutate history or silently accept weakened research guards', () => {
    const h = history();
    const saved = JSON.stringify(h);
    expect(() => shadow.commissionShadowAtEntry(trade(10), h, { minPrior: 1 })).toThrow(
      'INVALID_RESEARCH_CONFIG',
    );
    expect(JSON.stringify(h)).toBe(saved);
  });
});
