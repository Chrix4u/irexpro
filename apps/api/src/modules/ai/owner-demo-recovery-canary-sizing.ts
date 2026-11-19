/**
 * Narrow owner-only DEMO exception to the historical-loss recovery canary's
 * artificial 0.01 lot and four-hour spacing. This does NOT waive Plan-B
 * admission, model routing, other specialized canaries, broker margin or
 * the account's existing 0.25% per-position stop-risk sizing.
 */
export function resolveOwnerDemoRecoveryCanarySizing(input: {
  recoveryCanary: boolean;
  crossSleeveReversalCanary: boolean;
  ownerDemoVerified: boolean;
  featureEnabled: boolean;
  normalVolumeCap: number;
  recoveryCanaryLotCap: number;
}): {
  historicalLossRecoveryAdvisory: boolean;
  volumeCap: number;
  enforceHistoricalCanarySpacing: boolean;
} {
  const normalVolumeCap = Number.isFinite(input.normalVolumeCap)
    ? Math.max(0, input.normalVolumeCap) : 0;
  const historicalLossRecoveryAdvisory =
    input.recoveryCanary && !input.crossSleeveReversalCanary &&
    input.ownerDemoVerified && input.featureEnabled;
  return {
    historicalLossRecoveryAdvisory,
    volumeCap: input.recoveryCanary && !historicalLossRecoveryAdvisory
      ? Math.min(normalVolumeCap, input.recoveryCanaryLotCap)
      : normalVolumeCap,
    enforceHistoricalCanarySpacing:
      input.recoveryCanary && !historicalLossRecoveryAdvisory,
  };
}
