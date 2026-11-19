/**
 * Owner-directed DEMO strategy policy.
 *
 * Start/Stop Trading controls whether the FULL_AUTO session is running.
 * Historical loss-streak cooldowns are telemetry, not automatic pauses, only
 * for an exact, verified owner Pepperstone USD DEMO broker/session.
 *
 * Financial/account limits, missing cost evidence, broker/market/entry
 * qualification and account suspension stay outside this policy.
 */
export const OWNER_DEMO_LOSS_PAUSE_ADVISORY_ARTIFACT =
  'owner-demo-loss-pauses-advisory-v1' as const;

export interface LossPauseEvidence {
  active: boolean;
  reason: string;
}
export interface OwnerDemoLossPausePolicy {
  artifact: typeof OWNER_DEMO_LOSS_PAUSE_ADVISORY_ARTIFACT;
  advisoryOnly: boolean;
  modelLossStreakBlocks: boolean;
  portfolioLossStreakBlocks: boolean;
  fastStopCooldownBlocks: boolean;
  warningCodes: string[];
  overridesHardRiskControls: false;
  changesOrderDirection: false;
  changesPositionSizing: false;
}
export function ownerDemoLossPausePolicy(input: {
  featureEnabled: boolean;
  exactOwner: boolean;
  exactPepperstoneUsdDemo: boolean;
  fullAutoActive: boolean;
  model: LossPauseEvidence | null;
  portfolio: LossPauseEvidence | null;
  fastStop: LossPauseEvidence | null;
}): OwnerDemoLossPausePolicy {
  const advisoryOnly =
    input.featureEnabled && input.exactOwner &&
    input.exactPepperstoneUsdDemo && input.fullAutoActive;

  // Unknown costs/broker evidence never authorize fresh exposure.
  const modelLossStreakBlocks = input.model?.active === true &&
    (!advisoryOnly || input.model.reason === 'BROKER_COST_EVIDENCE_INCOMPLETE');
  const portfolioLossStreakBlocks = input.portfolio?.active === true &&
    (!advisoryOnly || input.portfolio.reason !== 'RECENT_PORTFOLIO_NET_LOSS_STREAK');
  const fastStopCooldownBlocks = input.fastStop?.active === true && !advisoryOnly;
  return {
    artifact: OWNER_DEMO_LOSS_PAUSE_ADVISORY_ARTIFACT,
    advisoryOnly,modelLossStreakBlocks,portfolioLossStreakBlocks,
    fastStopCooldownBlocks,
    warningCodes: advisoryOnly
      ? [
        ...(input.model?.active === true && !modelLossStreakBlocks
          ? ['MODEL_LOSS_STREAK_OBSERVED'] : []),
        ...(input.portfolio?.active === true && !portfolioLossStreakBlocks
          ? ['THREE_CONSECUTIVE_NET_LOSSES_OBSERVED'] : []),
        ...(input.fastStop?.active === true && !fastStopCooldownBlocks
          ? ['RAPID_STOP_LOSS_OBSERVED'] : []),
      ]:[],
    overridesHardRiskControls:false,
    changesOrderDirection:false,
    changesPositionSizing:false,
  };
}
