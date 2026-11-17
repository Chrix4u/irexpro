/**
 * DEMO-only, non-veto advisory entry-quality overlay.
 * Signal continuation does not have a trade quota; weak independent approval
 * reduces requested exposure but cannot increase it. Original broker SL/TP
 * and portfolio drawdown/exposure gates still control executable orders.
 */
export const PEPPERSTONE_ADVISORY_QUALITY_ARTIFACT =
  'pepperstone-demo-continuous-advisory-quality-risk-v1' as const;

type NativeBar = {
  timestamp: Date | string;
  close: string | number;
};

export interface ClosedRouteSideEvidence {
  samples: number;
  losing: number;
  winning: number;
  averageNetR: number | null;
  /** Always only historical broker-confirmed and fully fee-settled closes. */
}

function brokerCompletedMomentum(
  bars: readonly NativeBar[] | undefined,
  timeframeMinutes: number,
  now: Date,
  stopDistance: number,
  direction: 'BUY' | 'SELL',
): 'WITH' | 'AGAINST' | 'NEUTRAL' | 'UNAVAILABLE' {
  if (!bars || bars.length < 3 || !Number.isFinite(stopDistance) || stopDistance <= 0)
    return 'UNAVAILABLE';
  const end = now.getTime();
  const complete = bars
    .map((bar) => ({ at: new Date(bar.timestamp).getTime(), close: Number(bar.close) }))
    .filter((bar) => Number.isFinite(bar.at) && Number.isFinite(bar.close) &&
      bar.close > 0 && bar.at + timeframeMinutes * 60_000 <= end)
    .sort((a, b) => a.at - b.at);
  if (complete.length < 3) return 'UNAVAILABLE';
  const latest = complete.at(-1)!;
  // Broker-native M5 or H1 must be as-of the decision, not future or stale.
  if (end - (latest.at + timeframeMinutes * 60_000) >
    (timeframeMinutes === 5 ? 10 : 120) * 60_000)
    return 'UNAVAILABLE';
  const first = complete.at(-3)!;
  const signed = (latest.close - first.close) * (direction === 'BUY' ? 1 : -1);
  if (signed <= -stopDistance * 0.35) return 'AGAINST';
  if (signed >= stopDistance * 0.35) return 'WITH';
  return 'NEUTRAL';
}

export function evaluatePepperstoneDemoAdvisoryQuality(input: {
  route: string | null;
  m1Route: string;
  expertState: string | null;
  expertDirection: string | null;
  signalDirection: 'BUY' | 'SELL';
  expertProbability: number | null;
  decisionTime: Date;
  stopDistance: number;
  m5?: readonly NativeBar[];
  h1?: readonly NativeBar[];
  recent?: ClosedRouteSideEvidence | null;
}): {
  artifact: typeof PEPPERSTONE_ADVISORY_QUALITY_ARTIFACT;
  riskFraction: number;
  m1Abstained: boolean;
  expertAbstained: boolean;
  m5Direction: string;
  h1Direction: string;
  recentLossEvidenceUsed: boolean;
  recentSamples: number;
  recentAverageNetR: number | null;
  rationale: string[];
} {
  const m1Abstained = input.m1Route === 'ABSTAIN';
  const expertAbstained = input.expertState === 'ABSTAIN';
  const m5Direction = brokerCompletedMomentum(
    input.m5, 5, input.decisionTime, input.stopDistance, input.signalDirection,
  );
  const h1Direction = brokerCompletedMomentum(
    input.h1, 60, input.decisionTime, input.stopDistance, input.signalDirection,
  );
  const rationale: string[] = [];
  let riskFraction = 1;
  if (!['CONFIRMED_REVERSAL','EARLY_TRANSITION'].includes(input.route ?? '')) {
    return {
      artifact: PEPPERSTONE_ADVISORY_QUALITY_ARTIFACT,
      riskFraction: 1, m1Abstained, expertAbstained, m5Direction, h1Direction,
      recentLossEvidenceUsed: false, recentSamples: 0, recentAverageNetR: null,
      rationale: ['NOT_ALTERNATE_ROUTE'],
    };
  }
  // A same-side vote is not independent trade confirmation.
  if (m1Abstained && expertAbstained) {
    riskFraction *= 0.5;
    rationale.push('DOUBLE_ABSTAIN_HALF_RISK');
  } else if (m1Abstained || expertAbstained) {
    riskFraction *= 0.75;
    rationale.push('SINGLE_ABSTAIN_REDUCED_RISK');
  }
  // Four recent alternate entries with an opposing M1 continuation label
  // lost in the morning trial; soften risk, do not impose a trade quota.
  if (input.m1Route === 'M1_TREND_CONTINUATION') {
    riskFraction *= 0.65;
    rationale.push('M1_CONTINUATION_VS_PLAN_B_ALTERNATE_MISMATCH');
  }
  // A fresh opposing M5/H1 close sequence is evidence of ongoing contrary
  // momentum, but not proof an early reversal will fail. Soft-risk only.
  if (m5Direction === 'AGAINST' && h1Direction === 'AGAINST') {
    riskFraction *= 0.7;
    rationale.push('M5_H1_AGAINST_SIDE');
  } else if (m5Direction === 'AGAINST') {
    riskFraction *= 0.85;
    rationale.push('M5_AGAINST_SIDE');
  }
  const recent = input.recent;
  const completeRecent = !!recent &&
    Number.isInteger(recent.samples) && recent.samples >= 3 &&
    Number.isInteger(recent.losing) && Number.isInteger(recent.winning) &&
    recent.losing + recent.winning <= recent.samples &&
    Number.isFinite(recent.averageNetR);
  const recentLossEvidenceUsed = !!(
    completeRecent && recent!.losing >= Math.ceil(recent!.samples * 0.6) &&
    (recent!.averageNetR ?? 0) < 0
  );
  if (recentLossEvidenceUsed) {
    riskFraction *= 0.7;
    rationale.push('RECENT_SAME_PAIR_ROUTE_SIDE_NET_LOSING');
  }
  if (!rationale.length) rationale.push('NORMAL_APPROVAL');
  return {
    artifact: PEPPERSTONE_ADVISORY_QUALITY_ARTIFACT,
    riskFraction: Math.max(0.2, Math.min(1, Number(riskFraction.toFixed(4)))),
    m1Abstained, expertAbstained, m5Direction, h1Direction,
    recentLossEvidenceUsed,
    recentSamples: completeRecent ? recent!.samples : 0,
    recentAverageNetR: completeRecent ? recent!.averageNetR : null,
    rationale,
  };
}
