/**
 * Exact-owner Pepperstone USD DEMO: restore the pre-existing standard
 * 4-lot requested ceiling on a *weakly-supported* 7-lot reversal.
 * No entry veto, no minimum lot, no price/stops changes, no LIVE impact.
 *
 * The existing 7-lot permission remains for adequately supported entries.
 * Original after-fee and recent-loss warnings are frozen BEFORE order
 * dispatch; missing evidence never fabricates a verified warning.
 */
export const OWNER_DEMO_WEAK_REVERSAL_EXPOSURE_CEILING_ARTIFACT =
  'owner-pepperstone-demo-weak-reversal-seven-lot-ceiling-v1' as const;
export const OWNER_DEMO_STANDARD_EXPOSURE_CEILING_LOTS = 4;

export type OwnerDemoWeakReversalCapInput = {
  enabled: boolean;
  exactOwnerVerified: boolean;
  ongoingSevenLotEligible: boolean;
  continuousDemoAlternate: boolean;
  route: string | null;
  requestedLotCap: number;
  independentQualityRiskFraction: number | null;
  feeShadowReason: string | null;
  feeShadowPriorSamples: number | null;
  modelLossStreakActive: boolean;
  modelLossStreakReason: string | null;
};

export function evaluateOwnerDemoWeakReversalCap(input: OwnerDemoWeakReversalCapInput) {
  const original = input.requestedLotCap;
  const output = (cap: number, reason: string) => ({
    artifact: OWNER_DEMO_WEAK_REVERSAL_EXPOSURE_CEILING_ARTIFACT,
    originalRequestedLots: original,
    requestedLotCap: cap,
    applied: Number.isFinite(original) && Number.isFinite(cap) && cap < original,
    reason,
    riskFractionAtDecision: input.independentQualityRiskFraction,
    feeWarningAccepted:
      input.feeShadowReason === 'AFTER_BROKER_FEES_BELOW_FLOOR' &&
      Number.isInteger(input.feeShadowPriorSamples) &&
      input.feeShadowPriorSamples! >= 12,
    lossWarningAccepted:
      input.modelLossStreakActive &&
      input.modelLossStreakReason === 'RECENT_NEGATIVE_PAYOFF',
    altersBrokerStops: false as const,
    changesDirection: false as const,
    blocksTrade: false as const,
    increasesLot: false as const,
    liveAccountEligible: false as const,
  });
  if (!(Number.isFinite(original) && original > 0))
    return output(original, 'INVALID_OR_ABSENT_LOT_CAP_UNCHANGED');
  if (!input.enabled || !input.exactOwnerVerified ||
      !input.ongoingSevenLotEligible || !input.continuousDemoAlternate ||
      input.route !== 'CONFIRMED_REVERSAL')
    return output(original, 'NOT_EXACT_OWNER_DEMO_CONTINUOUS_REVERSAL_UNCHANGED');
  if (original <= OWNER_DEMO_STANDARD_EXPOSURE_CEILING_LOTS)
    return output(original, 'ALREADY_AT_OR_BELOW_STANDARD_CAP_UNCHANGED');
  const fraction = input.independentQualityRiskFraction;
  if (fraction === null || !Number.isFinite(fraction) ||
      fraction < 0.2 || fraction > 0.5)
    return output(original, 'QUALITY_EVIDENCE_NOT_STRONG_ENOUGH_FOR_CAP');
  const feeRisk =
    input.feeShadowReason === 'AFTER_BROKER_FEES_BELOW_FLOOR' &&
    Number.isInteger(input.feeShadowPriorSamples) &&
    input.feeShadowPriorSamples! >= 12;
  const lossRisk =
    input.modelLossStreakActive &&
    input.modelLossStreakReason === 'RECENT_NEGATIVE_PAYOFF';
  if (!feeRisk && !lossRisk)
    return output(original, 'NO_INDEPENDENT_COST_OR_LOSS_WARNING');
  return output(
    Math.min(original, OWNER_DEMO_STANDARD_EXPOSURE_CEILING_LOTS),
    'WEAK_CONFIRMATION_PLUS_INDEPENDENT_COST_OR_LOSS_WARNING',
  );
}
