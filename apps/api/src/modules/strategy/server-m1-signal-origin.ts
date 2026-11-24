import type { AiSignalCandidate } from './interfaces/strategy.interface';

/**
 * Unserializable in-process source proof. A Python relay, external
 * HTTP caller, or client-supplied metadata cannot forge this Symbol over
 * JSON. Only the local M1TacticalSchedulerService may brand a candidate,
 * immediately before handing it to the normal AiSignalService pipeline.
 *
 * Branding is NOT execution permission. The orchestrator additionally
 * checks account identity, real LIVE enablement, provider verification,
 * full-auto session and a restrictive primary Plan-B / M1 route tuple.
 */
const SERVER_M1_ORIGIN = Symbol('irexpro.server.m1-scheduler-origin');

export function brandServerM1Signal<T extends AiSignalCandidate>(candidate: T): T {
  Object.defineProperty(candidate, SERVER_M1_ORIGIN, {
    value: true,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return candidate;
}

export function hasServerM1Origin(candidate: AiSignalCandidate): boolean {
  return (
    (candidate as AiSignalCandidate & { [SERVER_M1_ORIGIN]?: boolean })[SERVER_M1_ORIGIN] === true
  );
}

/** Only exact primary routes qualify, not similarly named demo pilot paths. */
export function isStrictLiveM1PrimarySignal(candidate: AiSignalCandidate): boolean {
  const m = candidate.metadata;
  if (
    !hasServerM1Origin(candidate) ||
    candidate.strategyCode !== 'external-irexpro-multimodel-ensemble' ||
    candidate.modelVersion !== 'external-provider/irexpro-multimodel-ensemble-v1/demo-v1' ||
    candidate.timeframe !== 'M1' ||
    m?.signal_source !== 'EXTERNAL_PROVIDER' ||
    m?.external_provider_paper_only !== true ||
    m?.multimodel_execution_authority_path !== 'PRIMARY_PLAN_B' ||
    m?.multimodel_plan_b_paper_admitted !== true ||
    m?.m1_professional_fallback !== false ||
    m?.m5_early_transition_handoff !== false ||
    m?.m1_pepperstone_demo_alternative_trial !== false ||
    m?.extension_exhaustion_demo_scout !== false
  ) {
    return false;
  }

  const strictRoutes: Record<string, string> = {
    TREND_CONTINUATION: 'M1_TREND_CONTINUATION',
    CONFIRMED_REVERSAL: 'M1_CONFIRMED_REVERSAL',
    EARLY_TRANSITION: 'M1_EARLY_TRANSITION',
  };
  const modelRoute = String(m.multimodel_plan_b_route ?? '');
  return strictRoutes[modelRoute] !== undefined && strictRoutes[modelRoute] === m.m1_tactical_route;
}
