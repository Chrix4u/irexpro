export interface AdaptiveRankableScanWinner {
  adaptiveScore: number;
  netExpectedR: number;
}

export type AdaptiveRankedScanWinner<T extends AdaptiveRankableScanWinner> = T & {
  adaptiveScanRank: number;
};

export function adaptiveCandidateRiskAtStop(
  allocatedCapital: string | number | null,
  requestedRiskPercent: number,
): number | null {
  const capital = typeof allocatedCapital === 'number' ? allocatedCapital : Number(allocatedCapital);
  if (
    !Number.isFinite(capital) ||
    capital <= 0 ||
    !Number.isFinite(requestedRiskPercent) ||
    requestedRiskPercent <= 0 ||
    requestedRiskPercent > 100
  ) {
    return null;
  }
  const risk = (capital * requestedRiskPercent) / 100;
  return Number.isFinite(risk) && risk > 0 ? risk : null;
}

export function adaptiveMarketDataFreshness(
  latestClosedBarAt: Date,
  evaluatedAt: Date,
): 'FRESH' | 'STALE' | 'UNKNOWN' {
  const latest = latestClosedBarAt.getTime();
  const evaluated = evaluatedAt.getTime();
  if (!Number.isFinite(latest) || !Number.isFinite(evaluated) || evaluated < latest) return 'UNKNOWN';
  return evaluated - latest <= 15 * 60_000 ? 'FRESH' : 'STALE';
}

export function rankAdaptivePaperScanWinners<T extends AdaptiveRankableScanWinner>(
  winners: T[],
): Array<AdaptiveRankedScanWinner<T>> {
  return [...winners]
    .filter((winner) => Number.isFinite(winner.adaptiveScore) && Number.isFinite(winner.netExpectedR))
    .sort((a, b) => b.adaptiveScore - a.adaptiveScore || b.netExpectedR - a.netExpectedR)
    .map((winner, index) => ({ ...winner, adaptiveScanRank: index + 1 }));
}
