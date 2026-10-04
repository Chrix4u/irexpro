export type EnsembleExpertKind =
  | 'TRAINED_MODEL'
  | 'HEURISTIC_POLICY'
  | 'RISK_GUARD'
  | 'FROZEN_BASELINE';

export type EnsembleExpertLifecycle =
  | 'SHADOW'
  | 'READY_ARTIFACT'
  | 'WAITING_FOR_DATA'
  | 'COLLECTING'
  | 'ACTIVE_GUARD'
  | 'FROZEN'
  | 'REJECTED';

export interface EnsembleExpertDescriptor {
  code: string;
  label: string;
  kind: EnsembleExpertKind;
  lifecycle: EnsembleExpertLifecycle;
  trained: boolean;
  artifact: string | null;
  dataAuthority: string;
  executionAuthority: 'NONE';
  modifiesExecution: false;
  prospectiveEvidenceRequired: boolean;
  description: string;
}

export interface EnsembleExpertRegistryInput {
  highConvictionArtifact: string | null;
  highConvictionLoaded: boolean;
  highConvictionBrokerDataReady: boolean;
  postEntryArtifactReady: boolean;
  postEntryBrokerDataReady: boolean;
  postEntryShadowObservations: number;
  macroEventConfigured: boolean;
  sleeveResolvedOutcomes: number;
  legacyBaselineFrozen: boolean;
}

export interface EnsembleExpertRegistry {
  policy: 'EXPLICIT_PROVENANCE_V1';
  trainedModelCount: number;
  heuristicPolicyCount: number;
  riskGuardCount: number;
  frozenBaselineCount: number;
  entries: EnsembleExpertDescriptor[];
}

export function buildEnsembleExpertRegistry(
  input: EnsembleExpertRegistryInput,
): EnsembleExpertRegistry {
  const highConvictionLifecycle: EnsembleExpertLifecycle = !input.highConvictionLoaded
    ? 'WAITING_FOR_DATA'
    : input.highConvictionBrokerDataReady
      ? 'READY_ARTIFACT'
      : 'WAITING_FOR_DATA';
  const postEntryLifecycle: EnsembleExpertLifecycle = !input.postEntryArtifactReady
    ? 'WAITING_FOR_DATA'
    : !input.postEntryBrokerDataReady
      ? 'WAITING_FOR_DATA'
      : input.postEntryShadowObservations > 0
        ? 'COLLECTING'
        : 'READY_ARTIFACT';

  const entries: EnsembleExpertDescriptor[] = [
    {
      code: 'plan-b-v4-high-conviction',
      label: 'High-conviction three-expert challenger',
      kind: 'TRAINED_MODEL',
      lifecycle: highConvictionLifecycle,
      trained: true,
      artifact: input.highConvictionArtifact,
      dataAuthority: 'BROKER_NATIVE_M1_M5_M15_H1_H4',
      executionAuthority: 'NONE',
      modifiesExecution: false,
      prospectiveEvidenceRequired: true,
      description:
        'Frozen XGBoost challenger with a verified 128-feature broker-native multi-timeframe contract.',
    },
    {
      code: 'plan-b-v85-post-entry',
      label: 'v8.5 trained profit-protection challenger',
      kind: 'TRAINED_MODEL',
      lifecycle: postEntryLifecycle,
      trained: true,
      artifact: 'plan-b-v85-profitable-state-giveback-classifier-v1',
      dataAuthority: 'BROKER_NATIVE_M1_M5_M15_H1_H4_AT_FIXED_CHECKPOINTS',
      executionAuthority: 'NONE',
      modifiesExecution: false,
      prospectiveEvidenceRequired: true,
      description:
        'Frozen 41-feature trained give-back classifier scored on virtual ensemble positions at causal broker-native checkpoints.',
    },
    {
      code: 'plan-b-multimodel-shadow-v3',
      label: 'Multi-model decision policy',
      kind: 'HEURISTIC_POLICY',
      lifecycle: 'SHADOW',
      trained: false,
      artifact: 'plan-b-multimodel-shadow-v3',
      dataAuthority: 'TWELVE_DATA_CLOSED_M5_PLUS_CAUSAL_FEATURES',
      executionAuthority: 'NONE',
      modifiesExecution: false,
      prospectiveEvidenceRequired: true,
      description:
        'Deterministic research policy combining regime, direction, quality, exit, session, EV and portfolio checks.',
    },
    {
      code: 'v8-fixed-meta-policy',
      label: 'Frozen v8 meta policy',
      kind: 'HEURISTIC_POLICY',
      lifecycle: 'SHADOW',
      trained: false,
      artifact: 'v8-shadow-online-meta-v1',
      dataAuthority: 'CAUSAL_M5_FEATURE_VECTOR',
      executionAuthority: 'NONE',
      modifiesExecution: false,
      prospectiveEvidenceRequired: true,
      description:
        'Fixed development-derived logistic scoring policy retained as a prospective comparison baseline.',
    },
    {
      code: 'net-ev-cost-guard',
      label: 'Net execution economics guard',
      kind: 'RISK_GUARD',
      lifecycle: 'ACTIVE_GUARD',
      trained: false,
      artifact: 'paper-spread-plus-25pct-slippage-v1',
      dataAuthority: 'ENTRY_SL_SPREAD_COST_MODEL',
      executionAuthority: 'NONE',
      modifiesExecution: false,
      prospectiveEvidenceRequired: false,
      description:
        'Requires positive net expected R after conservative spread and slippage friction.',
    },
    {
      code: 'drift-sleeve-health-guard',
      label: 'Drift and sleeve-health guard',
      kind: 'RISK_GUARD',
      lifecycle: input.sleeveResolvedOutcomes >= 100 ? 'ACTIVE_GUARD' : 'COLLECTING',
      trained: false,
      artifact: 'development-envelope-4599-v1',
      dataAuthority: 'PROSPECTIVE_SHADOW_OUTCOMES',
      executionAuthority: 'NONE',
      modifiesExecution: false,
      prospectiveEvidenceRequired: true,
      description:
        'Keeps pair/side authority in prospective governance and blocks unstable or out-of-distribution sleeves.',
    },
    {
      code: 'macro-event-risk-guard',
      label: 'Macro-event risk guard',
      kind: 'RISK_GUARD',
      lifecycle: input.macroEventConfigured ? 'ACTIVE_GUARD' : 'WAITING_FOR_DATA',
      trained: false,
      artifact: null,
      dataAuthority: 'TRADING_ECONOMICS_HIGH_IMPACT_CALENDAR',
      executionAuthority: 'NONE',
      modifiesExecution: false,
      prospectiveEvidenceRequired: false,
      description:
        'Fails PAPER promotion closed around high-impact events or whenever authoritative calendar data is unavailable.',
    },
    {
      code: 'post-entry-path-telemetry',
      label: 'M5 post-entry counterfactual telemetry',
      kind: 'RISK_GUARD',
      lifecycle: 'COLLECTING',
      trained: false,
      artifact: null,
      dataAuthority: 'PROSPECTIVE_M5_POSITION_PATH',
      executionAuthority: 'NONE',
      modifiesExecution: false,
      prospectiveEvidenceRequired: true,
      description:
        'Measures MFE, MAE and fixed protection counterfactuals on completed M5 bars as a non-trained comparison baseline.',
    },
    {
      code: 'legacy-v7-baseline',
      label: 'Legacy v7 baseline',
      kind: 'FROZEN_BASELINE',
      lifecycle: input.legacyBaselineFrozen ? 'FROZEN' : 'SHADOW',
      trained: false,
      artifact: 'external-provider/vps-twelvedata-six-pair-v7/paper-only-v1',
      dataAuthority: 'PRESERVED_HISTORICAL_PAPER_EVIDENCE',
      executionAuthority: 'NONE',
      modifiesExecution: false,
      prospectiveEvidenceRequired: false,
      description: 'Preserved historical comparison only; no new execution authority.',
    },
  ];

  return {
    policy: 'EXPLICIT_PROVENANCE_V1',
    trainedModelCount: entries.filter((entry) => entry.kind === 'TRAINED_MODEL').length,
    heuristicPolicyCount: entries.filter((entry) => entry.kind === 'HEURISTIC_POLICY').length,
    riskGuardCount: entries.filter((entry) => entry.kind === 'RISK_GUARD').length,
    frozenBaselineCount: entries.filter((entry) => entry.kind === 'FROZEN_BASELINE').length,
    entries,
  };
}
