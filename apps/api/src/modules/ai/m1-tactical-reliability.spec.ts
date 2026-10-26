import {
  evaluateM1RoutePairSideReliability,
  type M1RoutePairSideEvidenceRow,
} from './m1-tactical-reliability';

const NOW = new Date('2026-10-18T12:00:00.000Z');

type Route = M1RoutePairSideEvidenceRow['route'];

function row(
  realisedPnl: number,
  changes: Partial<M1RoutePairSideEvidenceRow> = {},
): M1RoutePairSideEvidenceRow {
  return {
    route: 'M1_TREND_CONTINUATION',
    instrument: 'EURUSD',
    direction: 'BUY',
    policyVersion: 'm1-tactical-v1',
    realisedPnl,
    closedAt: new Date(NOW.getTime() - 60_000),
    ...changes,
  };
}

function evaluate(
  evidenceRows: M1RoutePairSideEvidenceRow[],
  changes: Partial<{
    route: Route;
    instrument: string;
    direction: 'BUY' | 'SELL';
    currentPolicyVersion: string;
    evaluatedAt: Date;
  }> = {},
) {
  return evaluateM1RoutePairSideReliability({
    route: 'M1_TREND_CONTINUATION',
    instrument: 'EURUSD',
    direction: 'BUY',
    currentPolicyVersion: 'm1-tactical-v1',
    evaluatedAt: NOW,
    evidenceRows,
    ...changes,
  });
}

describe('evaluateM1RoutePairSideReliability', () => {
  it('permits a clean cold start while marking evidence insufficient', () => {
    const result = evaluate([]);
    expect(result).toMatchObject({
      eligible: true,
      samples: 0,
      currentPolicySamples: 0,
      carriedSamples: 0,
      reason: 'INSUFFICIENT_EVIDENCE',
    });
  });

  it('applies the early brake after three losses and no wins', () => {
    const result = evaluate([row(-1), row(-2), row(-0.5)]);
    expect(result.eligible).toBe(false);
    expect(result.samples).toBe(3);
    expect(result.wins).toBe(0);
    expect(result.losses).toBe(3);
    expect(result.reason).toBe('EARLY_LOSS_STREAK');
  });

  it('brakes a fresh three-loss streak even when older wins still dominate the sample', () => {
    const recentLosses = [-1, -1, -1].map((pnl, index) =>
      row(pnl, { closedAt: new Date(NOW.getTime() - (index + 1) * 60_000) }),
    );
    const olderWins = Array.from({ length: 7 }, (_, index) =>
      row(1, { closedAt: new Date(NOW.getTime() - (index + 10) * 60_000) }),
    );
    const result = evaluate([...olderWins, ...recentLosses]);
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('EARLY_LOSS_STREAK');
  });

  it('brakes recent payoff decay before a mixed sequence becomes a three-loss streak', () => {
    const recent = [-1, -1, 0.5, 0.4, 0.4].map((realisedR, index) =>
      row(realisedR, { riskAtStop: 1, closedAt: new Date(NOW.getTime() - (index + 1) * 60_000) }),
    );
    const olderWins = Array.from({ length: 5 }, (_, index) =>
      row(1, { riskAtStop: 1, closedAt: new Date(NOW.getTime() - (index + 10) * 60_000) }),
    );
    const result = evaluate([...olderWins, ...recent]);
    expect(result.averageRealizedR).toBeGreaterThan(0);
    expect(result).toMatchObject({
      eligible: false,
      reason: 'RECENT_NEGATIVE_PAYOFF',
      recentPayoffRSamples: 5,
      recentPayoffAverageR: -0.14,
    });
  });

  it('does not brake mild recent noise above the payoff-decay floor', () => {
    const recent = [-0.5, -0.2, 0.1, 0.1, 0.1].map((realisedR, index) =>
      row(realisedR, { riskAtStop: 1, closedAt: new Date(NOW.getTime() - (index + 1) * 60_000) }),
    );
    const olderWins = Array.from({ length: 5 }, (_, index) =>
      row(1, { riskAtStop: 1, closedAt: new Date(NOW.getTime() - (index + 10) * 60_000) }),
    );
    expect(evaluate([...olderWins, ...recent])).toMatchObject({
      eligible: true,
      reason: 'POSITIVE_EXPECTANCY',
      recentPayoffRSamples: 5,
      recentPayoffAverageR: -0.08,
    });
  });

  it('does not brake at exactly the -0.10R payoff-decay floor', () => {
    const recent = [-0.2, 0.1, -0.2, 0.1, -0.3].map((realisedR, index) =>
      row(realisedR, { riskAtStop: 1, closedAt: new Date(NOW.getTime() - (index + 1) * 60_000) }),
    );
    const olderWins = Array.from({ length: 5 }, (_, index) =>
      row(1, { riskAtStop: 1, closedAt: new Date(NOW.getTime() - (index + 10) * 60_000) }),
    );
    expect(evaluate([...olderWins, ...recent])).toMatchObject({
      eligible: true,
      reason: 'POSITIVE_EXPECTANCY',
      recentPayoffRSamples: 5,
    });
    expect(evaluate([...olderWins, ...recent]).recentPayoffAverageR).toBeCloseTo(-0.1, 10);
  });

  it('does not substitute older risk-normalized trades when the latest five contain missing stop-risk evidence', () => {
    const recent = [
      row(-0.4, { riskAtStop: null, closedAt: new Date(NOW.getTime() - 60_000) }),
      row(0.05, { riskAtStop: 1, closedAt: new Date(NOW.getTime() - 2 * 60_000) }),
      row(-0.2, { riskAtStop: 1, closedAt: new Date(NOW.getTime() - 3 * 60_000) }),
      row(0.05, { riskAtStop: 1, closedAt: new Date(NOW.getTime() - 4 * 60_000) }),
      row(-0.3, { riskAtStop: 1, closedAt: new Date(NOW.getTime() - 5 * 60_000) }),
    ];
    const olderWins = Array.from({ length: 5 }, (_, index) =>
      row(1, { riskAtStop: 1, closedAt: new Date(NOW.getTime() - (index + 10) * 60_000) }),
    );
    const result = evaluate([...olderWins, ...recent]);
    expect(result.recentPayoffRSamples).toBe(4);
    expect(result.recentPayoffAverageR).toBeNull();
    expect(result.reason).not.toBe('RECENT_NEGATIVE_PAYOFF');
  });

  it('uses actual risk-normalized payoff so small protected wins cannot mask full-stop losses', () => {
    const payouts = [-3.18, 1.5, -3.18, 1.5, -3.18, 1.5, -3.18, 1.5, 1.5, 1.5];
    const result = evaluate(
      payouts.map((pnl, index) =>
        row(pnl, {
          closedAt: new Date(NOW.getTime() - (index + 1) * 60_000),
          riskAtStop: 3.18,
        } as Partial<M1RoutePairSideEvidenceRow>),
      ),
    );
    expect(result.wins).toBe(6);
    expect(result.losses).toBe(4);
    expect(result.averageRealizedR).toBeLessThan(0);
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('NEGATIVE_EXPECTANCY');
  });

  it.each([
    [[1, 1, 1, 1, -1], true, 'POSITIVE_EXPECTANCY'],
    [[1, -1, -1, -1, -1], false, 'NEGATIVE_EXPECTANCY'],
  ] as const)('uses smoothed expectancy once five samples exist: %j', (pnls, eligible, reason) => {
    const result = evaluate(pnls.map((pnl) => row(pnl)));
    expect(result.samples).toBe(5);
    expect(result.eligible).toBe(eligible);
    expect(result.reason).toBe(reason);
    expect(Number.isFinite(result.smoothedExpectedR)).toBe(true);
  });

  it('carries only the missing compatible predecessor samples across an explicit policy successor', () => {
    const evidence = [
      row(1, { policyVersion: 'm1-tactical-v1-cal1' }),
      row(1, {
        policyVersion: 'm1-tactical-v1-cal1',
        closedAt: new Date(NOW.getTime() - 2 * 60_000),
      }),
      row(1, { policyVersion: 'm1-tactical-v1', closedAt: new Date(NOW.getTime() - 3 * 60_000) }),
      row(-1, { policyVersion: 'm1-tactical-v1', closedAt: new Date(NOW.getTime() - 4 * 60_000) }),
      row(1, { policyVersion: 'm1-tactical-v1', closedAt: new Date(NOW.getTime() - 5 * 60_000) }),
      row(-1, { policyVersion: 'm1-tactical-v1', closedAt: new Date(NOW.getTime() - 6 * 60_000) }),
    ];
    const result = evaluate(evidence, { currentPolicyVersion: 'm1-tactical-v1-cal1' });
    expect(result.samples).toBe(5);
    expect(result.currentPolicySamples).toBe(2);
    expect(result.carriedSamples).toBe(3);
    expect(result.consideredPolicyVersions).toEqual(['m1-tactical-v1-cal1', 'm1-tactical-v1']);
  });

  it('caps self-policy evidence at the 20 most recent samples', () => {
    const evidence = Array.from({ length: 30 }, (_, index) =>
      row(index % 2 === 0 ? 1 : -1, {
        closedAt: new Date(NOW.getTime() - (index + 1) * 60_000),
      }),
    );
    const result = evaluate(evidence);
    expect(result.samples).toBe(20);
    expect(result.currentPolicySamples).toBe(20);
    expect(result.carriedSamples).toBe(0);
  });

  it('expires predecessor evidence older than seven days', () => {
    const evidence = [
      row(1, { policyVersion: 'm1-tactical-v1-cal1' }),
      row(-1, {
        policyVersion: 'm1-tactical-v1-cal1',
        closedAt: new Date(NOW.getTime() - 2 * 60_000),
      }),
      ...Array.from({ length: 5 }, (_, index) =>
        row(1, {
          policyVersion: 'm1-tactical-v1',
          closedAt: new Date(NOW.getTime() - (8 * 24 * 60 + index) * 60_000),
        }),
      ),
    ];
    const result = evaluate(evidence, { currentPolicyVersion: 'm1-tactical-v1-cal1' });
    expect(result.samples).toBe(2);
    expect(result.currentPolicySamples).toBe(2);
    expect(result.carriedSamples).toBe(0);
    expect(result.reason).toBe('INSUFFICIENT_EVIDENCE');
  });

  it('stops using predecessor evidence once the current policy has five samples', () => {
    const current = [1, 1, -1, 1, -1].map((pnl, index) =>
      row(pnl, {
        policyVersion: 'm1-tactical-v1-cal1',
        closedAt: new Date(NOW.getTime() - (index + 1) * 60_000),
      }),
    );
    const predecessor = Array.from({ length: 10 }, (_, index) =>
      row(-1, {
        policyVersion: 'm1-tactical-v1',
        closedAt: new Date(NOW.getTime() - (index + 10) * 60_000),
      }),
    );
    const result = evaluate([...current, ...predecessor], {
      currentPolicyVersion: 'm1-tactical-v1-cal1',
    });
    expect(result.samples).toBe(5);
    expect(result.currentPolicySamples).toBe(5);
    expect(result.carriedSamples).toBe(0);
    expect(result.wins).toBe(3);
    expect(result.losses).toBe(2);
  });

  it('keeps route evidence isolated so reversal wins cannot rehabilitate continuation', () => {
    const continuation = [1, -1, -1, -1, -1].map((pnl, index) =>
      row(pnl, { closedAt: new Date(NOW.getTime() - (index + 1) * 60_000) }),
    );
    const reversal = Array.from({ length: 10 }, (_, index) =>
      row(1, {
        route: 'M1_CONFIRMED_REVERSAL',
        closedAt: new Date(NOW.getTime() - (index + 20) * 60_000),
      }),
    );
    const result = evaluate([...continuation, ...reversal]);
    expect(result.samples).toBe(5);
    expect(result.wins).toBe(1);
    expect(result.losses).toBe(4);
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('NEGATIVE_EXPECTANCY');
  });

  it('does not carry predecessor rows into an unlisted policy version', () => {
    const evidence = Array.from({ length: 5 }, (_, index) =>
      row(1, {
        policyVersion: 'm1-tactical-v1',
        closedAt: new Date(NOW.getTime() - (index + 1) * 60_000),
      }),
    );
    const result = evaluate(evidence, { currentPolicyVersion: 'm1-tactical-v2-unlisted' });
    expect(result.samples).toBe(0);
    expect(result.carriedSamples).toBe(0);
    expect(result.reason).toBe('INSUFFICIENT_EVIDENCE');
  });

  it('ignores break-even, future, other-pair and other-direction rows', () => {
    const result = evaluate([
      row(1),
      row(0),
      row(1, { closedAt: new Date(NOW.getTime() + 60_000) }),
      row(1, { instrument: 'GBPUSD' }),
      row(1, { direction: 'SELL' }),
    ]);
    expect(result.samples).toBe(1);
    expect(result.wins).toBe(1);
  });
});
