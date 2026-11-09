import { evaluateLowVolRangeShadowOutcome } from './low-vol-range-shadow-outcome';

const t = new Date('2026-11-08T23:00:00.000Z');
const bars = Array.from({ length: 15 }, (_, index) => {
  const timestamp = new Date(t.getTime() + (index + 1) * 60_000);
  return { timestamp, open: 1.1, high: 1.10004, low: 1.09997, close: 1.1 };
});
const input = {
  decisionId: 'research-d-1',
  direction: 'BUY' as const,
  evaluatedAt: t,
  asOf: new Date('2026-11-08T23:16:00.000Z'),
  stopDistance: 0.00015,
  targetDistance: 0.0001,
  observedExecutionCostR: 0.16,
  hypothesisCohort: 'STABILIZED_ENTRY_HYPOTHESIS' as const,
  completedBrokerM1Bars: bars,
};

describe('low-vol-range 15-minute causal outcomes', () => {
  it('settles a next-M1-open hypothetical TP net of observed spread geometry', () => {
    const profitable = bars.map((b) => ({ ...b }));
    profitable[3] = { ...profitable[3]!, high: 1.10012 };
    const result = evaluateLowVolRangeShadowOutcome({
      ...input,
      completedBrokerM1Bars: profitable,
    });
    expect(result).toMatchObject({
      artifact: 'low-vol-range-shadow-outcome-15m-v1',
      mode: 'SHADOW_ONLY',
      executionAuthority: 'NONE',
      modifiesExecution: false,
      productionEligible: false,
      episodeDecisionId: input.decisionId,
      outcome: 'TP',
      entryBarOpenTime: '2026-11-08T23:01:00.000Z',
      grossRMultiple: expect.closeTo(2 / 3, 6),
      afterSpreadProxyRMultiple: expect.closeTo(2 / 3 - 0.16, 6),
      netRMultiple: null,
      commissionIncluded: false,
      costBasis: 'OBSERVED_SPREAD_P90_PLUS_BUFFER_NO_COMMISSION',
    });
  });

  it('settles adverse movement as an actual SL, not an estimated profitable prediction', () => {
    const adverse = bars.map((b) => ({ ...b }));
    adverse[3] = { ...adverse[3]!, low: 1.09984 };
    expect(
      evaluateLowVolRangeShadowOutcome({
        ...input,
        completedBrokerM1Bars: adverse,
      }),
    ).toMatchObject({
      outcome: 'SL',
      grossRMultiple: -1,
      afterSpreadProxyRMultiple: -1.16,
      netRMultiple: null,
    });
  });

  it('treats a same-bar stop-and-target touch as ambiguous, never assuming a win', () => {
    const contradictory = bars.map((b) => ({ ...b }));
    contradictory[3] = { ...contradictory[3]!, high: 1.10014, low: 1.09983 };
    expect(
      evaluateLowVolRangeShadowOutcome({
        ...input,
        completedBrokerM1Bars: contradictory,
      }),
    ).toMatchObject({ outcome: 'AMBIGUOUS', grossRMultiple: null, netRMultiple: null });
  });

  it('does not settle with future candles or missing M1 bars', () => {
    expect(
      evaluateLowVolRangeShadowOutcome({
        ...input,
        asOf: new Date(t.getTime() + 15 * 60_000),
      }),
    ).toBeNull();
    expect(
      evaluateLowVolRangeShadowOutcome({
        ...input,
        completedBrokerM1Bars: bars.slice(1),
      }),
    ).toBeNull();
  });

  it('labels absent provider bars unobservable only after an hour, not as losses or wins', () => {
    expect(
      evaluateLowVolRangeShadowOutcome({
        ...input,
        asOf: new Date(t.getTime() + 60 * 60_000),
        completedBrokerM1Bars: [],
      }),
    ).toMatchObject({
      outcome: 'UNOBSERVABLE_DATA_GAP',
      source: 'UNOBSERVABLE_DATA_GAP',
      netRMultiple: null,
      modifiesExecution: false,
    });
  });
});
