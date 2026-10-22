export const UNIFIED_FROZEN_CANDIDATE_CODE = 'irexpro-unified-frozen-v1-20261022';
export const UNIFIED_FROZEN_POLICY_VERSION = 'irexpro-unified-frozen-v1-policy-20261022.1';

export type FrozenEntryTimeframe = 'M1' | 'M5';
export type FrozenContextTimeframe = 'M15' | 'H1' | 'H4';

export interface FrozenCandidateSemanticPolicy {
  candidateCode: typeof UNIFIED_FROZEN_CANDIDATE_CODE;
  policyVersion: typeof UNIFIED_FROZEN_POLICY_VERSION;
  instruments: readonly string[];
  entryTimeframes: readonly FrozenEntryTimeframe[];
  contextTimeframes: readonly FrozenContextTimeframe[];
  directionalMarginR: number;
  bootstrapRiskMultiplier: number;
  bootstrapCompletedEpisodes: number;
  collectingCompletedEpisodes: number;
  eligibleProfitFactorFloor: number;
  eligibleAverageRFloor: number;
  selectionLiftFloorR: number;
  qualificationCheckpointTrades: number;
  qualificationPreferredTrades: number;
  researchExecutionQuarantined: true;
  demoLiveAuthority: false;
  expertArtifacts: {
    planB: string;
    m1: string;
    extensionExhaustion: string;
    donchian: string;
  };
  sizingPolicy: string;
  stopTargetPolicy: string;
  postEntryPolicy: string;
  costPolicy: string;
  eventRiskPolicy: string;
  driftPolicy: string;
  episodePolicy: string;
  selectionGovernorPolicy: string;
}

export const UNIFIED_FROZEN_SEMANTIC_POLICY: FrozenCandidateSemanticPolicy = Object.freeze({
  candidateCode: UNIFIED_FROZEN_CANDIDATE_CODE,
  policyVersion: UNIFIED_FROZEN_POLICY_VERSION,
  instruments: Object.freeze(['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCAD', 'USDCHF']),
  entryTimeframes: Object.freeze(['M1', 'M5']),
  contextTimeframes: Object.freeze(['M15', 'H1', 'H4']),
  directionalMarginR: 0.02,
  bootstrapRiskMultiplier: 0.5,
  bootstrapCompletedEpisodes: 10,
  collectingCompletedEpisodes: 20,
  eligibleProfitFactorFloor: 1.15,
  eligibleAverageRFloor: 0,
  selectionLiftFloorR: 0,
  qualificationCheckpointTrades: 50,
  qualificationPreferredTrades: 100,
  researchExecutionQuarantined: true,
  demoLiveAuthority: false,
  expertArtifacts: Object.freeze({
    planB: 'plan-b-multimodel-shadow-v4',
    m1: 'm1-tactical-v1',
    extensionExhaustion: 'extension-exhaustion-shadow-v1',
    donchian: 'donchian-breakout-expert-v1',
  }),
  sizingPolicy: 'adaptive-risk-multiplier-v1',
  stopTargetPolicy: 'unified-stop-target-v1',
  postEntryPolicy: 'unified-post-entry-v1',
  costPolicy: 'paper-cost-aware-entry-v1',
  eventRiskPolicy: 'macro-event-risk-v1',
  driftPolicy: 'ensemble-drift-v1',
  episodePolicy: 'selection-episode-v1',
  selectionGovernorPolicy: 'selection-governor-v1',
});
