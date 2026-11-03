import type { M1TacticalCandidate } from './m1-tactical-candidate';
import type { M1TacticalFeatureSnapshot } from './m1-tactical-features';
import type { M1TacticalRoute } from './m1-tactical-route';
import type { EnsembleGovernanceDecision } from './ensemble-governance';

export const ZAI_DEMO_DIAGNOSTICS_VERSION = 'zai-demo-diagnostics-v1';

export type ZaiBlockerGroup =
  | 'MARKET_DATA'
  | 'RISK_OR_ACCOUNT'
  | 'MODEL_EXPECTANCY'
  | 'MODEL_DRIFT'
  | 'MODEL_ADMISSION'
  | 'ENTRY_TIMING'
  | 'RELIABILITY'
  | 'TRADE_ROUTE'
  | 'MODEL_WRAPPER'
  | 'OTHER';

const order: readonly ZaiBlockerGroup[] = [
  'MARKET_DATA',
  'RISK_OR_ACCOUNT',
  'MODEL_EXPECTANCY',
  'MODEL_DRIFT',
  'MODEL_ADMISSION',
  'ENTRY_TIMING',
  'RELIABILITY',
  'TRADE_ROUTE',
  'MODEL_WRAPPER',
  'OTHER',
];

export function classifyZaiBlocker(code: string): ZaiBlockerGroup {
  if (
    /BROKER_.*(STALE|UNAVAILABLE)|SPREAD_UNAVAILABLE|MARKET_DATA|QUOTE|FEATURE_CONTEXT|CANDLE/.test(
      code,
    )
  )
    return 'MARKET_DATA';
  if (
    /RISK_|EXPOSURE|KILL_SWITCH|SESSION_INACTIVE|LOSS_STREAK|POSITION|ACTIVE_SAME_SIDE/.test(code)
  )
    return 'RISK_OR_ACCOUNT';
  if (/NET_EXPECTED_R|EXPECTED_R|PAYOFF|COST_EXCEEDS/.test(code)) return 'MODEL_EXPECTANCY';
  if (/DRIFT_|OUT_OF_DISTRIBUTION/.test(code)) return 'MODEL_DRIFT';
  if (
    /CONFIDENCE_FLOOR|META_EXPECTED_VALUE|DIRECTION_QUALITY|TRADE_QUALITY|EXIT_FEASIBILITY/.test(
      code,
    )
  )
    return 'MODEL_ADMISSION';
  if (/TIMING|NOT_M1_CONFIRMED|EARLY_TRANSITION_.*READY/.test(code)) return 'ENTRY_TIMING';
  if (/RELIABILITY|DEGRADED|SCOUT|PROBATION/.test(code)) return 'RELIABILITY';
  if (/M1_ROUTE_|HTF_CONFLICT|HIGHER_TIMEFRAME|NO_VALID_ROUTE/.test(code)) return 'TRADE_ROUTE';
  if (
    /NOT_ADMITTED|NOT_PAPER_ADMITTED|NOT_PROMOTABLE|GOVERNANCE_BLOCKED|PLAN_B_NOT_ADMITTED/.test(
      code,
    )
  )
    return 'MODEL_WRAPPER';
  return 'OTHER';
}

export interface ZaiBlockerAttribution {
  version: typeof ZAI_DEMO_DIAGNOSTICS_VERSION;
  primaryGroup: ZaiBlockerGroup | null;
  primaryCode: string | null;
  groups: Array<{ group: ZaiBlockerGroup; count: number; examples: string[] }>;
  rawBlockerCount: number;
  wrapperCount: number;
  /** Never replaces the immutable, authoritative broker/risk vetoes. */
  modifiesExecution: false;
}

export function attributeZaiDemoBlockers(blockers: readonly string[]): ZaiBlockerAttribution {
  const unique = [...new Set(blockers)];
  const groups = order.flatMap((group) => {
    const codes = unique.filter((code) => classifyZaiBlocker(code) === group);
    return codes.length ? [{ group, count: codes.length, examples: codes.slice(0, 3) }] : [];
  });
  const primary = groups.find((group) => group.group !== 'MODEL_WRAPPER') ?? groups[0];
  return {
    version: ZAI_DEMO_DIAGNOSTICS_VERSION,
    primaryGroup: primary?.group ?? null,
    primaryCode: primary?.examples[0] ?? null,
    groups,
    rawBlockerCount: unique.length,
    wrapperCount: unique.filter((code) => classifyZaiBlocker(code) === 'MODEL_WRAPPER').length,
    modifiesExecution: false,
  };
}

export interface ZaiDemoCostGeometryDiagnostic {
  version: typeof ZAI_DEMO_DIAGNOSTICS_VERSION;
  route: M1TacticalRoute;
  instrument: string;
  currentStopPrice: number;
  currentTargetR: number;
  currentEstimatedCostR: number | null;
  source: EnsembleGovernanceDecision['executionCostSource'];
  evidenceValid: boolean;
  p90SpreadPrice: number | null;
  costBreakEvenStopPriceAt010R: number | null;
  hypotheticalStopPrice: number | null;
  hypotheticalCostR: number | null;
  hypotheticalTargetPrice: number | null;
  strongHigherTimeframeContinuation: boolean;
  canPromote: false;
  modifiesExecution: false;
}

export function diagnoseZaiDemoCostGeometry(input: {
  candidate: M1TacticalCandidate;
  features: M1TacticalFeatureSnapshot;
  route: M1TacticalRoute;
  governance: EnsembleGovernanceDecision;
}): ZaiDemoCostGeometryDiagnostic {
  const { candidate, features, route, governance } = input;
  const spread = governance.effectiveSpreadPrice;
  const observed =
    governance.executionSpreadEvidenceValid &&
    governance.executionCostSource === 'BROKER_OBSERVED_P90';
  const validSpread =
    observed && typeof spread === 'number' && Number.isFinite(spread) && spread > 0;
  const strongHtf =
    route === 'M1_TREND_CONTINUATION' &&
    candidate.alignedM5 >= 0.12 &&
    candidate.alignedM15 >= 0.12 &&
    candidate.alignedH1 >= 0.12 &&
    candidate.alignedH4 >= 0.12;
  // Both are hypothetical only. A real M5 ATR must be calculated from
  // completed broker-native M5 bars; never synthesize it from an M1 ATR.
  const m5Atr = features.m5Atr14;
  const validM5 = typeof m5Atr === 'number' && Number.isFinite(m5Atr) && m5Atr > 0;
  const breakEvenStop = validSpread ? (1.25 * spread) / 0.1 : null;
  const hypotheticalStop =
    validSpread && strongHtf && validM5
      ? Math.max(candidate.stopDistance, breakEvenStop!, 1.5 * m5Atr)
      : null;
  const sign = candidate.direction === 'BUY' ? 1 : -1;
  return {
    version: ZAI_DEMO_DIAGNOSTICS_VERSION,
    route,
    instrument: candidate.instrument,
    currentStopPrice: candidate.stopDistance,
    currentTargetR: candidate.grossExpectedR,
    currentEstimatedCostR: Number.isFinite(governance.estimatedExecutionCostR)
      ? governance.estimatedExecutionCostR
      : null,
    source: governance.executionCostSource,
    evidenceValid: observed,
    p90SpreadPrice: validSpread ? spread : null,
    costBreakEvenStopPriceAt010R: breakEvenStop,
    hypotheticalStopPrice: hypotheticalStop,
    hypotheticalCostR: hypotheticalStop != null ? (1.25 * spread!) / hypotheticalStop : null,
    hypotheticalTargetPrice:
      hypotheticalStop != null
        ? candidate.entry + sign * hypotheticalStop * candidate.grossExpectedR
        : null,
    strongHigherTimeframeContinuation: strongHtf,
    canPromote: false,
    modifiesExecution: false,
  };
}
