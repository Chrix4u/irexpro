/**
 * A reversible, exact-broker DEMO experiment. The primary ensemble and M1
 * confirmation continue calculating; only new continuation authority is vetoed.
 * The remaining routes still need all original admission and risk checks.
 */
export const PEPPERSTONE_DEMO_CONTINUATION_PAUSE_BLOCKER =
  'M1_PEPPERSTONE_DEMO_TREND_CONTINUATION_PAUSED' as const;

export interface PepperstoneDemoContinuationPause {
  artifact: 'pepperstone-demo-continuation-pause-v1';
  enabled: boolean;
  scopedPepperstoneDemo: boolean | null;
  blocked: boolean;
  selectedRoute: string | null;
  reason: 'DISABLED' | 'OTHER_ROUTE' | 'OTHER_BROKER' | 'CONTINUATION_PAUSED' |
    'BROKER_SCOPE_UNAVAILABLE';
  changesOpenPositions: false;
  overridesAlternativeAdmission: false;
}
export function evaluatePepperstoneDemoContinuationPause(input: {
  enabled: boolean;
  isProfessionalDemoPhase: boolean;
  selectedRoute: string | null;
  scopedPepperstoneDemo: boolean | null;
}): PepperstoneDemoContinuationPause {
  const base = {
    artifact: 'pepperstone-demo-continuation-pause-v1' as const,
    enabled: input.enabled,
    scopedPepperstoneDemo: input.scopedPepperstoneDemo,
    selectedRoute: input.selectedRoute,
    changesOpenPositions: false as const,
    overridesAlternativeAdmission: false as const,
  };
  if (!input.enabled || !input.isProfessionalDemoPhase)
    return {...base,blocked:false,reason:'DISABLED' as const};
  if (input.selectedRoute !== 'TREND_CONTINUATION')
    return {...base,blocked:false,reason:'OTHER_ROUTE' as const};
  // An uncertain broker identity must never grant exposure while the pause
  // is requested. Only proven non-Pepperstone connections remain unchanged.
  if (input.scopedPepperstoneDemo === null)
    return {...base,blocked:true,reason:'BROKER_SCOPE_UNAVAILABLE' as const};
  if (input.scopedPepperstoneDemo === false)
    return {...base,blocked:false,reason:'OTHER_BROKER' as const};
  return {...base,blocked:true,reason:'CONTINUATION_PAUSED' as const};
}
