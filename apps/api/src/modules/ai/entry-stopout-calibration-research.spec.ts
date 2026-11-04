export {};
// Research-only. Does not import any production trading service.
type Cohort = {
  total: number;
  matched: number;
  invalid: number;
  stopouts: number;
  stopoutRate: number | null;
  meanNetR: number | null;
  meanGrossR: number | null;
  meanCommissionR: number | null;
};
type Segments = {
  byRoute: Record<string, Cohort>;
  byPairSide: Record<string, Cohort>;
  byRouteConfidence: Record<string, Cohort>;
  byRouteExtension: Record<string, Cohort>;
  byRouteRegime: Record<string, Cohort>;
  byRouteExitReason: Record<string, Cohort>;
};
type Audit = {
  artifact: string;
  executionAuthority: string;
  modifiesExecution: boolean;
  entireCohort: Cohort;
  chronologicalSplit: {
    trainSamples: number;
    holdoutSamples: number;
    excludedForPurgeOrOverlap: number;
  };
  train: Segments;
  holdout: Segments;
  heldOutRouteConfidenceComparisons: Array<{ eligibleForExecution: boolean }>;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const research = require('../../../scripts/research-entry-stopout-calibration.cjs') as {
  wilson: (wins: number, n: number) => { lower: number; upper: number } | null;
  confidenceBin: (n: number | null) => string;
  extensionBin: (n: number | null) => string;
  analyze: (rows: Array<Record<string, unknown>>, options?: Record<string, unknown>) => Audit;
};
function trade(index: number, overrides: Record<string, unknown> = {}) {
  const opened = new Date(Date.parse('2026-11-02T00:00:00Z') + index * 3600_000).toISOString();
  const closed = new Date(Date.parse(opened) + 15 * 60_000).toISOString();
  return {
    openedAt: opened,
    closedAt: closed,
    instrument: 'USDJPY',
    direction: 'BUY',
    accountCurrency: 'EUR',
    engine: 'external-irexpro-multimodel-ensemble',
    route: 'TREND_CONTINUATION',
    marketRegime: 'TREND_HEALTHY',
    closeReason: index % 3 === 0 ? 'STOP_LOSS_HIT' : 'PROFIT_PROTECTION',
    realisedPnl: index % 3 === 0 ? '-10' : '5',
    commission: '-1.6',
    swap: '0',
    finalRiskAtStop: '10',
    confidenceScore: '0.75',
    extensionAtr: '1.1',
    preEntryExpectedR: '0.25',
    ...overrides,
  };
}
describe('research-only entry-stopout calibration', () => {
  it('uses Wilson intervals and handles empty counts', () => {
    expect(research.wilson(1, 10)).toMatchObject({
      lower: expect.any(Number),
      upper: expect.any(Number),
    });
    expect(research.wilson(0, 0)).toBeNull();
    expect(research.wilson(11, 10)).toBeNull();
  });
  it('uses fixed, pre-registered confidence and extension bins', () => {
    expect(research.confidenceBin(null)).toBe('UNKNOWN');
    expect(research.confidenceBin(0.59)).toBe('<0.60');
    expect(research.confidenceBin(0.65)).toBe('0.60-0.69');
    expect(research.confidenceBin(0.75)).toBe('>=0.70');
    expect(research.extensionBin(0.5)).toBe('<0.75_ATR');
    expect(research.extensionBin(0.9)).toBe('0.75-1.25_ATR');
    expect(research.extensionBin(1.4)).toBe('>1.25_ATR');
  });
  it('reconciles after-commission R and true stopout percentage', () => {
    const x = research.analyze([trade(0), trade(1), trade(2)]);
    expect(x.entireCohort).toMatchObject({
      matched: 3,
      stopouts: 1,
      stopoutRate: 0.3333,
      meanNetR: expect.closeTo((-1.16 + 0.34 + 0.34) / 3, 4),
    });
    expect(x.executionAuthority).toBe('NONE');
    expect(x.modifiesExecution).toBe(false);
  });
  it('keeps broker account currencies and pair/side cohorts distinct', () => {
    const x = research.analyze([
      trade(0),
      trade(1, { accountCurrency: 'USD' }),
      trade(2, { direction: 'SELL' }),
    ]);
    expect(Object.keys(x.train.byRoute)).not.toContain('USD | TREND_CONTINUATION');
    expect(Object.keys(x.holdout.byPairSide).every((k) => k.includes(' | '))).toBe(true);
  });
  it('excludes missing fee and invalid risk from performance estimates', () => {
    const x = research.analyze([
      trade(0, { commission: null }),
      trade(1, { finalRiskAtStop: 0 }),
      trade(2),
    ]);
    expect(x.entireCohort).toMatchObject({ total: 3, matched: 1, invalid: 2 });
  });
  it('applies a chronological 60-minute purge and prevents ongoing-trade leakage', () => {
    const seq = Array.from({ length: 30 }, (_, i) => trade(i));
    seq[20] = trade(20, { closedAt: '2026-11-03T08:00:00Z' });
    const x = research.analyze(seq);
    expect(x.chronologicalSplit.trainSamples).toBeLessThan(21);
    expect(x.chronologicalSplit.holdoutSamples).toBeGreaterThan(0);
    expect(x.chronologicalSplit.excludedForPurgeOrOverlap).toBeGreaterThan(0);
    expect(
      x.chronologicalSplit.trainSamples +
        x.chronologicalSplit.holdoutSamples +
        x.chronologicalSplit.excludedForPurgeOrOverlap,
    ).toBe(30);
  });
  it('requires at least ten independent examples in train before presenting holdout comparison', () => {
    const seq = Array.from({ length: 12 }, (_, i) => trade(i));
    const x = research.analyze(seq);
    expect(x.heldOutRouteConfidenceComparisons).toEqual([]);
    expect(() => research.analyze(seq, { minGroup: 3 })).toThrow('INVALID_MIN_GROUP');
  });
  it('uses stratified labels without creating vetoes or admission policies', () => {
    const seq = Array.from({ length: 40 }, (_, i) =>
      trade(i, {
        confidenceScore: i % 2 ? '0.55' : '0.75',
        extensionAtr: i % 3 ? '1.4' : '0.5',
      }),
    );
    const x = research.analyze(seq);
    expect(x.holdout.byRouteConfidence).toBeDefined();
    expect(x.train.byRouteExtension).toBeDefined();
    expect(x.train.byRouteRegime).toBeDefined();
    expect(x.holdout.byRouteExitReason).toBeDefined();
    expect(x.heldOutRouteConfidenceComparisons.every((y) => y.eligibleForExecution === false)).toBe(
      true,
    );
  });
  it('bounds research input and never mutates input trades', () => {
    const seq = Array.from({ length: 20 }, (_, i) => trade(i));
    const original = JSON.stringify(seq);
    research.analyze(seq);
    expect(JSON.stringify(seq)).toBe(original);
    expect(() => research.analyze(Array.from({ length: 2001 }, () => trade(0)))).toThrow(
      'INVALID_RESEARCH_ROW_LIMIT',
    );
  });
});
