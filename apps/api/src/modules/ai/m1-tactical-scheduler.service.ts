import {
  DEMO_FOCUSED_ENTRY_INSTRUMENTS_V1,
  DEMO_SIX_PAIR_ENTRY_INSTRUMENTS_V2,
} from './demo-focused-instruments';
export {
  DEMO_FOCUSED_ENTRY_INSTRUMENTS_V1,
  DEMO_SIX_PAIR_ENTRY_INSTRUMENTS_V2,
} from './demo-focused-instruments';

import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v5 as uuidv5 } from 'uuid';
import { ExecutionService } from '../execution/execution.service';
import { TradeIntentService } from '../execution/services/trade-intent.service';
import { AllocationService } from '../execution/services/allocation.service';
import { PAPER_BROKER_AWARE_EXPOSURE_SEARCH_FLOOR } from '../execution/services/position-sizing.service';
import { ExecutionMode } from '../execution/interfaces/execution-authority';
import { TradingSessionStatus } from '../execution/entities/trading-session.entity';
import { TradeCloseReason } from '../execution/entities/trade.entity';
import { AiSignalService } from './ai-signal.service';
import { MacroEventRiskService } from './macro-event-risk.service';
import {
  M1_SHADOW_OUTCOME_15M_ARTIFACT,
  M1TacticalEvidenceService,
  type M1ShadowOutcome15mV1,
} from './m1-tactical-evidence.service';
import {
  M1TacticalMarketDataService,
  type M1TacticalMarketReadiness,
} from './m1-tactical-market-data.service';
import {
  buildM1TacticalCandidates,
  M1_TACTICAL_POLICY_V2,
  type M1TacticalCandidate,
} from './m1-tactical-candidate';
import { buildM1TacticalFeatures, type M1TacticalFeatureSnapshot } from './m1-tactical-features';
import {
  classifyM1TacticalRoute,
  type M1TacticalRoute,
  type M1TacticalRouteDecision,
} from './m1-tactical-route';
import { evaluateM1TacticalGovernance } from './m1-tactical-governance';
import {
  evaluateM5EarlyTransitionHandoff,
  type M5EarlyTransitionEvidence,
  type M5EarlyTransitionHandoffDecision,
} from './m5-early-transition-handoff';
import { scoreExtensionExhaustionShadow } from './extension-exhaustion-shadow';
import {
  evaluateExtensionExhaustionDemoScout,
  type ExtensionExhaustionDemoScoutDecision,
} from './extension-exhaustion-demo-scout';
import { evaluateEnsembleGovernance, type EnsembleGovernanceDecision } from './ensemble-governance';
import {
  scorePlanBMultimodelShadow,
  type PlanBEnsembleScore,
  type PlanBPortfolioPosition,
} from './plan-b-multimodel-shadow';
import { HighConvictionBrokerExpertService } from './high-conviction-broker-expert.service';
import type { HighConvictionOverlay } from './high-conviction-overlay';
import { evaluateProductionQualificationShadow } from './production-qualification-shadow';
import { observeSecondaryPredictedCostFloor } from './secondary-predicted-cost-shadow';
import { evaluateLowVolRangeShadow, LOW_VOL_RANGE_STOP_ATR } from './low-vol-range-shadow';
import { evaluateLowVolRangeShadowOutcome } from './low-vol-range-shadow-outcome';
import {
  evaluateMultimodelDemoAuthority,
  multimodelDemoExecutionVolumeCap,
  m1CandidateToPlanBInput,
  multimodelDemoSignalConfidence,
  MULTIMODEL_DEMO_ENGINE_CODE,
  type MultimodelDemoAuthorityDecision,
} from './multimodel-demo-authority';
import { evaluateM1TacticalExpectancy } from './m1-tactical-expectancy';
import { attributeZaiDemoBlockers, diagnoseZaiDemoCostGeometry } from './zai-demo-diagnostics';
import { evaluateM1CausalCommissionShadow } from './m1-causal-commission-shadow';
import { evaluateDemoBrokerCommissionEntryGate } from './demo-broker-commission-entry-gate';
import {
  M1_PORTFOLIO_NET_LOSS_BRAKE_ARTIFACT,
  M1_PORTFOLIO_NET_LOSS_BRAKE_COOLDOWN_MINUTES,
  type M1PortfolioNetLossBrakeDecision,
} from './m1-portfolio-net-loss-brake';
import { evaluateDemoProfitabilityReliabilityGate } from './demo-profitability-reliability-gate';
import { evaluateDemoPrimaryOnlyProbation } from './demo-primary-only-route-probation';
import {
  evaluateM1RoutePairSideReliability,
  type M1ReliabilityRoute,
} from './m1-tactical-reliability';
import { isFxWeeklySessionOpen } from '../market-data/utils/fx-weekly-session';
import { evaluateM1DriftCounterfactual15m } from './m1-drift-counterfactual';
import { evaluateM1CausalOutcome15m } from './m1-causal-outcome';
import {
  evaluateM1FailedMoveRescue,
  type M1FailedMoveRescueInput,
  type M1FailedMoveRescueDecision,
} from './m1-failed-move-rescue';
import {
  evaluateM1ShadowPairSideReliability,
  M1_SHADOW_MICRO_RELIABILITY_ARTIFACT,
  type M1ShadowPairSideReliabilityDecision,
} from './m1-shadow-pair-side-reliability';
import {
  evaluateM1MeaningfulScoutReliability,
  M1_MEANINGFUL_SCOUT_MIN_SAMPLES,
  M1_MEANINGFUL_SCOUT_RELIABILITY_ARTIFACT,
  type M1MeaningfulScoutReliabilityDecision,
} from './m1-meaningful-scout-reliability';
import {
  evaluateM1ProvisionalScoutReliability,
  M1_PROVISIONAL_SCOUT_MIN_SAMPLES,
  M1_PROVISIONAL_SCOUT_RELIABILITY_ARTIFACT,
  type M1ProvisionalScoutReliabilityDecision,
} from './m1-provisional-scout-reliability';
import {
  evaluateM1TacticalCurrencyExposure,
  findLargestClearM1Volume,
  type M1CurrencyExposureDecision,
} from './m1-tactical-currency-exposure';

type M1ScoutPairSideReliabilityDecision = (
  | M1ShadowPairSideReliabilityDecision
  | M1MeaningfulScoutReliabilityDecision
  | M1ProvisionalScoutReliabilityDecision
) & {
  brokerNativeSampleCount?: number;
  bootstrapSampleCount?: number;
  evidenceConnectionIds?: string[];
};

interface MultimodelDemoEvaluation {
  ensemble: PlanBEnsembleScore;
  governance: EnsembleGovernanceDecision;
  trainedExpert: HighConvictionOverlay;
  authority: MultimodelDemoAuthorityDecision;
  portfolioSnapshotAvailable: boolean;
}

type M1ProfessionalFallbackTier =
  | 'QUALIFIED'
  | 'QUALIFIED_CONTINUATION'
  | 'BOOTSTRAP_CONTINUATION'
  | 'RECOVERY_PROBE';

interface M1ProfessionalFallbackDecision {
  eligible: boolean;
  tier: M1ProfessionalFallbackTier | null;
  reason: string;
  lotCap: number;
}

const M1_PROFESSIONAL_FALLBACK_LOT_CAP = 0.2;
const M1_PROFESSIONAL_CONTINUATION_LOT_CAP = 0.2;
const M1_PROFESSIONAL_CONTINUATION_MIN_EXPECTED_R = 0.2;
// Structural broker spread/stop geometry, NOT a modelled profit floor.
// A grossly wide observed spread relative to the executable stop is unsafe
// regardless of AI confidence or predicted profitability.
const M1_BROKER_OBSERVED_SPREAD_STOP_MAX_R = 0.5;
const M1_PROFESSIONAL_CONTINUATION_MIN_SAMPLES = 5;
const M1_PROFESSIONAL_BOOTSTRAP_MIN_CONFIDENCE = 0.72;
const M1_PROFESSIONAL_BOOTSTRAP_MIN_DIRECTION_QUALITY = 0.72;
const M1_PROFESSIONAL_BOOTSTRAP_MIN_M5_ALIGNMENT = -0.15;
const M1_PROFESSIONAL_BOOTSTRAP_MIN_M5_BODY_PRESSURE = 0.05;
const M1_PROFESSIONAL_BOOTSTRAP_MIN_M5_MOMENTUM_1_ATR = 0.15;
const M1_PROFESSIONAL_BOOTSTRAP_MIN_M5_MOMENTUM_3_ATR = 0.25;
const M1_PROFESSIONAL_BOOTSTRAP_MAX_EXTENSION_ATR = 1.4;
const M1_PROFESSIONAL_RECOVERY_PROBE_LOT_CAP = 0.2;
// Realized early-transition fallback cohorts are currently negative, so QUALIFIED
// and RECOVERY_PROBE remain observational. A QUALIFIED_CONTINUATION may execute
// only after its exact pair/side continuation sleeve has earned positive realised
// reliability and the current governance checks in evaluateM1ProfessionalFallback pass.
function professionalM1FallbackExecutionEnabled(
  fallback: M1ProfessionalFallbackDecision | null,
): boolean {
  return (
    fallback?.eligible === true &&
    (fallback.tier === 'QUALIFIED_CONTINUATION' || fallback.tier === 'BOOTSTRAP_CONTINUATION')
  );
}
// Recovery probes need a 0.05R cushion above the normal 0.20 early-transition route floor.
const M1_PROFESSIONAL_RECOVERY_MIN_EXPECTED_R = 0.25;
const M1_PROFESSIONAL_RECOVERY_SHADOW_REASONS = new Set([
  'WEAK_MEANINGFUL_EXPECTANCY',
  'WEAK_PROVISIONAL_EXPECTANCY',
]);

function evaluateM1ProfessionalFallback(input: {
  candidate: M1TacticalCandidate;
  routeDecision: M1TacticalRouteDecision;
  governance: ReturnType<typeof evaluateM1TacticalGovernance>;
  reliability: ReturnType<typeof evaluateM1RoutePairSideReliability> | null;
  shadowPairSideReliability: M1ScoutPairSideReliabilityDecision | null;
  multimodelDemo: MultimodelDemoEvaluation | null;
  routePayoffEligible: boolean;
  features: M1TacticalFeatureSnapshot;
}): M1ProfessionalFallbackDecision {
  const reject = (reason: string): M1ProfessionalFallbackDecision => ({
    eligible: false,
    tier: null,
    reason,
    lotCap: 0,
  });

  if (!input.routeDecision.eligible) return reject('M1_ROUTE_NOT_ELIGIBLE');
  if (!input.multimodelDemo) return reject('MULTIMODEL_EVIDENCE_UNAVAILABLE');
  if (input.multimodelDemo.ensemble.strategyRoute !== 'TREND_CONTINUATION') {
    return reject('PLAN_B_ROUTE_NOT_CONTINUATION');
  }
  if (input.multimodelDemo.authority.executable) {
    return reject('MULTIMODEL_ALREADY_EXECUTABLE');
  }
  if (!input.routePayoffEligible) return reject('M1_ROUTE_PAYOFF_TOO_LOW');
  if (!input.reliability?.eligible) {
    return reject(`M1_ACTUAL_RELIABILITY_${input.reliability?.reason ?? 'UNAVAILABLE'}`);
  }

  if (input.routeDecision.route === 'M1_TREND_CONTINUATION') {
    const reliability = input.reliability;
    if (reliability.reason === 'INSUFFICIENT_EVIDENCE') {
      const recentRealizedR = reliability.recentRealizedR;
      if (recentRealizedR !== null && recentRealizedR < 0) {
        return reject('M1_BOOTSTRAP_RECENT_REALIZED_R_NEGATIVE');
      }
      if (input.candidate.confidence < M1_PROFESSIONAL_BOOTSTRAP_MIN_CONFIDENCE) {
        return reject('M1_BOOTSTRAP_CONFIDENCE_TOO_LOW');
      }
      if (input.candidate.directionQuality < M1_PROFESSIONAL_BOOTSTRAP_MIN_DIRECTION_QUALITY) {
        return reject('M1_BOOTSTRAP_DIRECTION_QUALITY_TOO_LOW');
      }
      if (
        input.routeDecision.reason !== 'TREND_STRUCTURE_ALIGNED' &&
        input.routeDecision.reason !== 'FRESH_M5_CONTINUATION'
      ) {
        return reject('M1_BOOTSTRAP_CONTINUATION_STRUCTURE_NOT_READY');
      }
      if (
        input.candidate.alignedM5 < M1_PROFESSIONAL_BOOTSTRAP_MIN_M5_ALIGNMENT ||
        input.candidate.alignedM5BodyPressure3 < M1_PROFESSIONAL_BOOTSTRAP_MIN_M5_BODY_PRESSURE ||
        input.candidate.alignedM5Momentum1Atr < M1_PROFESSIONAL_BOOTSTRAP_MIN_M5_MOMENTUM_1_ATR ||
        input.candidate.alignedM5Momentum3Atr < M1_PROFESSIONAL_BOOTSTRAP_MIN_M5_MOMENTUM_3_ATR
      ) {
        return reject('M1_BOOTSTRAP_M5_CONTINUATION_TOO_WEAK');
      }
      if (input.features.extensionAtr > M1_PROFESSIONAL_BOOTSTRAP_MAX_EXTENSION_ATR) {
        return reject('M1_BOOTSTRAP_MOVE_TOO_EXTENDED');
      }
      if (
        !input.governance.genericGovernance.paperExecutionCostUsable ||
        !Number.isFinite(input.governance.netExpectedR)
      ) {
        // Missing/invalid market-price evidence remains a hard veto. Only
        // the unvalidated *predicted net-return threshold* is shadow-only.
        return reject('M1_BOOTSTRAP_EXECUTION_EVIDENCE_UNAVAILABLE');
      }
      if (
        !input.governance.genericGovernance.executionSpreadEvidenceValid ||
        input.governance.genericGovernance.estimatedExecutionCostR >
          M1_BROKER_OBSERVED_SPREAD_STOP_MAX_R
      ) {
        return reject('M1_BOOTSTRAP_BROKER_SPREAD_STOP_GEOMETRY_UNSAFE');
      }
      if (input.governance.genericGovernance.eventRisk !== 'CLEAR') {
        return reject('M1_BOOTSTRAP_EVENT_RISK_BLOCKED');
      }
      const softDriftBlockers = new Set(['DRIFT_STRESSED', 'DRIFT_OUT_OF_DISTRIBUTION']);
      if (
        input.governance.genericGovernance.paperExecutionBlockers.some(
          (blocker) => !softDriftBlockers.has(blocker),
        ) ||
        input.governance.blockers.some((blocker) => !softDriftBlockers.has(blocker))
      ) {
        return reject('M1_BOOTSTRAP_HARD_GOVERNANCE_BLOCKER');
      }
      return {
        eligible: true,
        tier: 'BOOTSTRAP_CONTINUATION',
        reason: 'M1_COLD_START_CONTINUATION_BOOTSTRAP',
        lotCap: M1_PROFESSIONAL_CONTINUATION_LOT_CAP,
      };
    }
    if (reliability.reason !== 'POSITIVE_EXPECTANCY') {
      return reject(`M1_CONTINUATION_RELIABILITY_${reliability.reason}`);
    }
    if (reliability.samples < M1_PROFESSIONAL_CONTINUATION_MIN_SAMPLES) {
      return reject('M1_CONTINUATION_EVIDENCE_TOO_THIN');
    }
    if ((reliability.averageRealizedR ?? 0) <= 0 || (reliability.recentRealizedR ?? 0) <= 0) {
      return reject('M1_CONTINUATION_REALIZED_R_NOT_POSITIVE');
    }
    if (
      !input.governance.genericGovernance.paperExecutionCostUsable ||
      !Number.isFinite(input.governance.netExpectedR)
    ) {
      return reject('M1_CONTINUATION_EXECUTION_EVIDENCE_UNAVAILABLE');
    }
    if (
      !input.governance.genericGovernance.executionSpreadEvidenceValid ||
      input.governance.genericGovernance.estimatedExecutionCostR >
        M1_BROKER_OBSERVED_SPREAD_STOP_MAX_R
    ) {
      return reject('M1_CONTINUATION_BROKER_SPREAD_STOP_GEOMETRY_UNSAFE');
    }
    // The previous 0.20R forecast hurdle is recorded in shadow below.
    // Positive observed pair-side R and independent M1 governance stay hard.
    if (input.governance.genericGovernance.eventRisk !== 'CLEAR') {
      return reject('M1_CONTINUATION_EVENT_RISK_BLOCKED');
    }
    const continuationPaperBlockers = input.governance.genericGovernance.paperExecutionBlockers;
    if (continuationPaperBlockers.some((blocker) => blocker !== 'DRIFT_STRESSED')) {
      return reject('M1_CONTINUATION_HARD_GOVERNANCE_BLOCKER');
    }
    const continuationRouteBlockers = input.governance.blockers;
    if (continuationRouteBlockers.some((blocker) => blocker !== 'DRIFT_STRESSED')) {
      return reject('M1_CONTINUATION_ROUTE_GOVERNANCE_BLOCKED');
    }
    return {
      eligible: true,
      tier: 'QUALIFIED_CONTINUATION',
      reason: 'M1_MATURE_POSITIVE_CONTINUATION',
      lotCap: M1_PROFESSIONAL_CONTINUATION_LOT_CAP,
    };
  }

  if (input.routeDecision.route !== 'M1_EARLY_TRANSITION') {
    return reject('M1_ROUTE_NOT_EARLY_TRANSITION');
  }
  if (input.routeDecision.reason !== 'EARLY_TRANSITION_IMPULSE') {
    return reject('M1_TRANSITION_NOT_IMPULSE');
  }
  if (
    !input.multimodelDemo.authority.blockers.includes('MULTIMODEL_CONTINUATION_TIMING_NOT_READY')
  ) {
    return reject('NO_ROUTE_TIMING_DISAGREEMENT');
  }

  const genericBlockers = input.governance.genericGovernance.paperExecutionBlockers;
  const onlyDriftBlockers = genericBlockers.every(
    (blocker) => blocker === 'DRIFT_OUT_OF_DISTRIBUTION',
  );
  if (!onlyDriftBlockers) return reject('M1_HARD_GOVERNANCE_BLOCKER');
  const m1SpecificHardBlockers = input.governance.blockers.filter(
    (blocker) => blocker !== 'DRIFT_OUT_OF_DISTRIBUTION',
  );
  if (m1SpecificHardBlockers.length > 0) return reject('M1_ROUTE_GOVERNANCE_BLOCKED');

  if (input.shadowPairSideReliability?.eligible === true) {
    return {
      eligible: true,
      tier: 'QUALIFIED',
      reason: 'M1_QUALIFIED_ROUTE_DISAGREEMENT',
      lotCap: M1_PROFESSIONAL_FALLBACK_LOT_CAP,
    };
  }

  if (input.reliability.reason !== 'INSUFFICIENT_EVIDENCE') {
    return reject(`M1_RECOVERY_ACTUAL_RELIABILITY_${input.reliability.reason}`);
  }
  if ((input.reliability.recentRealizedR ?? 0) < 0) {
    return reject('M1_RECOVERY_RECENT_ACTUAL_R_NEGATIVE');
  }
  if (
    !Number.isFinite(input.governance.expectancy.statisticalExpectedR) ||
    input.governance.expectancy.statisticalExpectedR < M1_PROFESSIONAL_RECOVERY_MIN_EXPECTED_R
  ) {
    return reject('M1_RECOVERY_EXPECTED_R_TOO_LOW');
  }
  if (
    !input.shadowPairSideReliability ||
    !M1_PROFESSIONAL_RECOVERY_SHADOW_REASONS.has(input.shadowPairSideReliability.reason)
  ) {
    return reject('M1_RECOVERY_SHADOW_STATE_NOT_ELIGIBLE');
  }
  const recentShadowNetR =
    'recentNetR' in input.shadowPairSideReliability
      ? input.shadowPairSideReliability.recentNetR
      : null;
  if (!Number.isFinite(recentShadowNetR) || recentShadowNetR! <= 0) {
    return reject('M1_RECOVERY_RECENT_SHADOW_R_NOT_POSITIVE');
  }

  return {
    eligible: true,
    tier: 'RECOVERY_PROBE',
    reason: 'M1_STRONG_IMPULSE_RECOVERY_PROBE',
    lotCap: M1_PROFESSIONAL_RECOVERY_PROBE_LOT_CAP,
  };
}

export type M1TacticalExecutionPhase =
  | 'SHADOW'
  | 'PAPER_CONTINUATION'
  | 'PAPER_ALL_ROUTES'
  | 'PAPER_EARLY_TRANSITION_MICRO'
  | 'PAPER_EARLY_TRANSITION_SCOUT_010'
  | 'PAPER_EARLY_TRANSITION_SCOUT_TIERED'
  | 'DEMO_EARLY_TRANSITION_PROFESSIONAL';

export interface M1TacticalRolloutPolicy {
  version: string;
  phase: M1TacticalExecutionPhase;
  cadenceMs: number;
  instruments: readonly string[];
  paperVolumeCap: number;
  /** DEMO-only narrowing of execution; never modifies LIVE or PAPER. */
  demoPrimaryOnlyProbation?: boolean;
  /** Broker-native DEMO primary entry requires observed after-fee expectancy. */
  demoBrokerCommissionFloor?: boolean;
  /** DEMO-only: measure the historical fee veto but never use it to authorize/deny an order. */
  demoBrokerCommissionShadow?: boolean;
  /** Explicit DEMO-only new-entry allowlist; all other instruments remain research-only. */
  demoEntryInstruments?: readonly string[];
  routeNetExpectedRFloors: Readonly<Record<Exclude<M1TacticalRoute, 'ABSTAIN'>, number>>;
}

export interface M1OpenPositionRescueShadowInput {
  decisionId: string;
  userId: string;
  brokerConnectionId: string;
  instrument: string;
  originalDirection: 'BUY' | 'SELL';
  oppositeDirection: 'BUY' | 'SELL';
  originalInvalidated: boolean;
  originalNetExpectedR: number;
  oppositeNetExpectedR: number;
  oppositeGovernanceEligible: boolean;
  oppositeBlockers: readonly string[];
  observedAt?: Date;
}

export const M1_TACTICAL_ROLLOUT_POLICY_TOKEN = 'M1_TACTICAL_ROLLOUT_POLICY';
export const M1_TACTICAL_ROLLOUT_POLICY_V1: Readonly<M1TacticalRolloutPolicy> = Object.freeze({
  version: 'm1-tactical-rollout-v1',
  phase: 'SHADOW',
  cadenceMs: 15_000,
  instruments: Object.freeze(['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCAD', 'USDCHF']),
  paperVolumeCap: 0.05,
  routeNetExpectedRFloors: Object.freeze({
    M1_TREND_CONTINUATION: 0.08,
    M1_CONFIRMED_REVERSAL: 0.12,
    M1_EARLY_TRANSITION: 0.2,
  }),
});

export const M1_TACTICAL_ROLLOUT_POLICY_V2: Readonly<M1TacticalRolloutPolicy> = Object.freeze({
  ...M1_TACTICAL_ROLLOUT_POLICY_V1,
  version: 'm1-tactical-rollout-v2',
  phase: 'PAPER_CONTINUATION',
});

export const M1_TACTICAL_ROLLOUT_POLICY_V3: Readonly<M1TacticalRolloutPolicy> = Object.freeze({
  ...M1_TACTICAL_ROLLOUT_POLICY_V2,
  version: 'm1-tactical-rollout-v3',
  phase: 'PAPER_ALL_ROUTES',
});

export const M1_TACTICAL_ROLLOUT_POLICY_V4: Readonly<M1TacticalRolloutPolicy> = Object.freeze({
  ...M1_TACTICAL_ROLLOUT_POLICY_V1,
  version: 'm1-tactical-rollout-v4-early-transition-micro',
  phase: 'PAPER_EARLY_TRANSITION_MICRO',
  paperVolumeCap: 0.01,
});

export const M1_TACTICAL_ROLLOUT_POLICY_V5: Readonly<M1TacticalRolloutPolicy> = Object.freeze({
  ...M1_TACTICAL_ROLLOUT_POLICY_V1,
  version: 'm1-tactical-rollout-v5-meaningful-size-shadow',
  phase: 'SHADOW',
  paperVolumeCap: 0.2,
});

export const M1_TACTICAL_ROLLOUT_POLICY_V6: Readonly<M1TacticalRolloutPolicy> = Object.freeze({
  ...M1_TACTICAL_ROLLOUT_POLICY_V1,
  version: 'm1-tactical-rollout-v6-early-transition-scout-010',
  phase: 'PAPER_EARLY_TRANSITION_SCOUT_010',
  paperVolumeCap: 0.1,
});

export const M1_TACTICAL_ROLLOUT_POLICY_V7: Readonly<M1TacticalRolloutPolicy> = Object.freeze({
  ...M1_TACTICAL_ROLLOUT_POLICY_V1,
  version: 'm1-tactical-rollout-v7-early-transition-tiered-scout',
  phase: 'PAPER_EARLY_TRANSITION_SCOUT_TIERED',
  paperVolumeCap: 0.1,
});

/**
 * V8 is the first real-provider DEMO rollout. It preserves the V7 validated
 * early-transition route/evidence gates but removes the scout micro-lot cap.
 * 4.00 is only an upper ceiling: PositionSizingService still derives the
 * actual volume from allocation, stop distance, durable risk %, broker
 * min/max/step and margin evidence, with a preferred 0.20 size and a dynamic broker-supported lower bound.
 */
export const M1_TACTICAL_ROLLOUT_POLICY_V8: Readonly<M1TacticalRolloutPolicy> = Object.freeze({
  ...M1_TACTICAL_ROLLOUT_POLICY_V1,
  version: 'm1-tactical-rollout-v8-demo-professional',
  phase: 'DEMO_EARLY_TRANSITION_PROFESSIONAL',
  paperVolumeCap: 4,
});

/** TEMPORARY DEMO research probation — primary ensemble is the only
 * executable path; fallbacks continue shadow scoring. Revert this specific
 * module policy binding when independently verified after-cost evidence
 * supports promoting a fallback. This creates NO additional trade authority.
 */
export const M1_TACTICAL_ROLLOUT_POLICY_V8_PRIMARY_ONLY_PROBATION: Readonly<M1TacticalRolloutPolicy> =
  Object.freeze({
    ...M1_TACTICAL_ROLLOUT_POLICY_V8,
    version: 'm1-tactical-v8-demo-primary-only-probation',
    demoPrimaryOnlyProbation: true,
  });

/**
 * Reversible DEMO focus from independently queried broker-native FULL_AUTO
 * closed trades, 2026-11-05. All six sleeves have negative AFTER-FEE net P&L.
 * AUDUSD (60 closures), GBPUSD (13), EURUSD (32, one incomplete fee) are a
 * controlled research shortlist, NOT historically profitable winners.
 * The original V1 shortlist remains for historical decision replay and
 * rollback. A separate V2 policy restores all six to DEMO eligibility.
 * No changes to LIVE, PAPER, existing broker positions or risk suspensions.
 */

/** A missing allowlist preserves older V8 policy semantics; an empty list blocks all DEMO entries. */
export function demoInstrumentEntryAllowed(
  policy: Readonly<M1TacticalRolloutPolicy>,
  instrument: string,
): boolean {
  return (
    policy.phase !== 'DEMO_EARLY_TRANSITION_PROFESSIONAL' ||
    policy.demoEntryInstruments === undefined ||
    (policy.demoEntryInstruments.includes(instrument) && policy.instruments.includes(instrument))
  );
}

/** Reversible commission-aware DEMO policy; historical rollout policies remain immutable. */
export const M1_TACTICAL_ROLLOUT_POLICY_V8_PRIMARY_ONLY_COMMISSION: Readonly<M1TacticalRolloutPolicy> =
  Object.freeze({
    ...M1_TACTICAL_ROLLOUT_POLICY_V8_PRIMARY_ONLY_PROBATION,
    version: 'm1-tactical-v8-demo-primary-only-commission-focused3-v1',
    demoBrokerCommissionFloor: true,
    demoEntryInstruments: DEMO_FOCUSED_ENTRY_INSTRUMENTS_V1,
  });

/**
 * Reversible and DEMO-only operator-requested fee shadow trial.
 *
 * Primary ensemble, OOD, session, macro news, spread, position, lot,
 * stop-loss and account-risk controls remain untouched. A counterfactual
 * fee veto is persisted on the very same decision linked to the broker trade.
 * Rebind AiModule to the immutable _COMMISSION policy to restore the veto.
 */
export const M1_TACTICAL_ROLLOUT_POLICY_V8_PRIMARY_ONLY_FEE_SHADOW: Readonly<M1TacticalRolloutPolicy> =
  Object.freeze({
    ...M1_TACTICAL_ROLLOUT_POLICY_V8_PRIMARY_ONLY_COMMISSION,
    version: 'm1-tactical-v8-demo-primary-fee-shadow-focused3-v1',
    demoBrokerCommissionFloor: false,
    demoBrokerCommissionShadow: true,
  });

/**
 * Operator-requested DEMO six-pair reactivation. Explicitly version the
 * policy so historical focused-three decisions can still be attributed to
 * their original restrictions. No additional execution/risk authority.
 */
export const M1_TACTICAL_ROLLOUT_POLICY_V8_SIX_PAIR_FEE_SHADOW: Readonly<M1TacticalRolloutPolicy> =
  Object.freeze({
    ...M1_TACTICAL_ROLLOUT_POLICY_V8_PRIMARY_ONLY_FEE_SHADOW,
    version: 'm1-tactical-v8-demo-primary-fee-shadow-six-pair-v2',
    demoEntryInstruments: DEMO_SIX_PAIR_ENTRY_INSTRUMENTS_V2,
  });

export function m1RiskMarketRegime(
  route: M1TacticalRoute,
): 'TREND_HEALTHY' | 'REVERSAL' | 'TRANSITION' | undefined {
  switch (route) {
    case 'M1_TREND_CONTINUATION':
      return 'TREND_HEALTHY';
    case 'M1_CONFIRMED_REVERSAL':
      return 'REVERSAL';
    case 'M1_EARLY_TRANSITION':
      return 'TRANSITION';
    case 'ABSTAIN':
    default:
      return undefined;
  }
}

export function m1RouteExecutableInPhase(
  phase: M1TacticalExecutionPhase,
  route: M1TacticalRoute,
): boolean {
  if (phase === 'SHADOW' || route === 'ABSTAIN') return false;
  if (phase === 'PAPER_CONTINUATION') return route === 'M1_TREND_CONTINUATION';
  if (
    phase === 'PAPER_EARLY_TRANSITION_MICRO' ||
    phase === 'PAPER_EARLY_TRANSITION_SCOUT_010' ||
    phase === 'PAPER_EARLY_TRANSITION_SCOUT_TIERED' ||
    phase === 'DEMO_EARLY_TRANSITION_PROFESSIONAL'
  )
    return route === 'M1_EARLY_TRANSITION';
  return (
    route === 'M1_TREND_CONTINUATION' ||
    route === 'M1_CONFIRMED_REVERSAL' ||
    route === 'M1_EARLY_TRANSITION'
  );
}

export function m1ProfessionalSizingTier(
  confidence: number,
): 'BASE' | 'STRONG' | 'VERY_STRONG' | 'ELITE' {
  if (confidence >= 0.88) return 'ELITE';
  if (confidence >= 0.8) return 'VERY_STRONG';
  if (confidence >= 0.72) return 'STRONG';
  return 'BASE';
}

export function m1ShadowOutcomeEligible(input: {
  routeEligible: boolean;
  route: M1TacticalRoute;
  routeReason: string;
  routePayoffEligible: boolean;
  blockers: readonly string[];
  eventRisk: 'CLEAR' | 'HIGH_IMPACT_BLOCK' | 'UNVERIFIED';
  paperExecutionCostUsable: boolean;
}): boolean {
  if (!input.routeEligible || input.route === 'ABSTAIN' || !input.routePayoffEligible) return false;
  if (input.eventRisk !== 'CLEAR' || !input.paperExecutionCostUsable) return false;

  const hardBlockers = input.blockers.filter(
    (blocker) => !/^M1_(?:SHADOW_|MEANINGFUL_SCOUT_|TIERED_SCOUT_)?RELIABILITY_/.test(blocker),
  );
  if (hardBlockers.length === 0) return true;

  return (
    input.route === 'M1_EARLY_TRANSITION' &&
    input.routeReason === 'LOCAL_IMPULSE_AGAINST_HTF' &&
    hardBlockers.length === 1 &&
    hardBlockers[0] === 'DRIFT_OUT_OF_DISTRIBUTION'
  );
}

const M1_SIGNAL_NAMESPACE = 'df913329-57f7-4c08-8f19-8272540b7efd';

function minuteBoundary(now: Date): Date {
  const value = now.getTime();
  return new Date(Math.floor(value / 60_000) * 60_000);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * Observability only: bounded latest-scan metrics per pair.
 * Never affects execution authority, admission or price calculations.
 */
export interface M1TacticalScanTiming {
  slotTime: string;
  startedAfterSlotMs: number;
  /** End of entry-critical evaluation, not deferred research completion. */
  finishedAfterSlotMs: number;
  /** Entry-critical per-pair wall time; intentionally excludes later shadow settlement. */
  totalMs: number;
  marketLoadMs: number | null;
  decisionEvaluationMs: number | null;
  /** Historical observation time, measured after all pair entries are evaluated. */
  shadowSettlementMs: number | null;
  state: 'COMPLETED' | 'MARKET_NOT_READY' | 'FEATURES_UNAVAILABLE' | 'ERROR';
}

@Injectable()
export class M1TacticalSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(M1TacticalSchedulerService.name);
  private readonly rolloutPolicy: Readonly<M1TacticalRolloutPolicy>;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private destroyed = false;
  private lastSlotKey: string | null = null;
  /** Observability only: one count per later minute that wakes while the prior slot is running. */
  private busyMinuteOverlapCount = 0;
  private lastBusyOverlapSlotKey: string | null = null;
  private lastRunAt: Date | null = null;
  private lastError: string | null = null;
  private readonly marketReadiness = new Map<string, M1TacticalMarketReadiness>();
  private readonly lastScanTimings = new Map<string, M1TacticalScanTiming>();

  constructor(
    private readonly config: ConfigService,
    private readonly marketData: M1TacticalMarketDataService,
    private readonly macroEventRisk: MacroEventRiskService,
    private readonly evidence: M1TacticalEvidenceService,
    private readonly aiSignalService: AiSignalService,
    @Optional()
    @Inject(M1_TACTICAL_ROLLOUT_POLICY_TOKEN)
    rolloutPolicy?: M1TacticalRolloutPolicy,
    @Optional() private readonly executionService?: ExecutionService,
    @Optional() private readonly tradeIntentService?: TradeIntentService,
    @Optional() private readonly allocationService?: AllocationService,
    @Optional() private readonly highConvictionBrokerExpert?: HighConvictionBrokerExpertService,
  ) {
    this.rolloutPolicy = rolloutPolicy ?? M1_TACTICAL_ROLLOUT_POLICY_V1;
  }

  onModuleInit(): void {
    this.destroyed = false;
    if (!this.enabled()) {
      this.logger.log(
        'M1 tactical scheduler disabled because the VPS PAPER scanner binding is unavailable',
      );
      return;
    }
    const startupAuthority =
      this.rolloutPolicy.phase === 'SHADOW'
        ? 'NONE'
        : this.rolloutPolicy.phase === 'DEMO_EARLY_TRANSITION_PROFESSIONAL'
          ? 'DEMO_FULL_AUTO_PROMOTED'
          : 'PAPER_ONLY_RESEARCH';
    this.logger.log(
      `M1 tactical scheduler enabled phase=${this.rolloutPolicy.phase} cadence=${this.rolloutPolicy.cadenceMs / 1000}s authority=${startupAuthority} primaryEngine=${this.rolloutPolicy.phase === 'DEMO_EARLY_TRANSITION_PROFESSIONAL' ? MULTIMODEL_DEMO_ENGINE_CODE : 'irexpro-m1-tactical'} m1Role=${this.rolloutPolicy.phase === 'DEMO_EARLY_TRANSITION_PROFESSIONAL' ? 'TIMING_SPECIALIST' : 'PRIMARY_RESEARCH_ROUTE'}`,
    );
    this.timer = setInterval(() => void this.runOnce(), this.rolloutPolicy.cadenceMs);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    this.destroyed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  getStatus() {
    const professionalDemoPhase = this.rolloutPolicy.phase === 'DEMO_EARLY_TRANSITION_PROFESSIONAL';
    return {
      enabled: this.enabled(),
      primaryEngineCode: professionalDemoPhase
        ? MULTIMODEL_DEMO_ENGINE_CODE
        : 'irexpro-m1-tactical',
      primaryEngineDisplayName: professionalDemoPhase
        ? 'iRexPro Multi-Model Ensemble'
        : 'iRexPro M1 Tactical',
      authorityMode: professionalDemoPhase
        ? 'DEMO_FULL_AUTO'
        : this.rolloutPolicy.phase === 'SHADOW'
          ? 'SHADOW'
          : 'PAPER_RESEARCH',
      m1TacticalRole: professionalDemoPhase ? 'TIMING_SPECIALIST' : 'PRIMARY_RESEARCH_ROUTE',
      policyVersion: this.rolloutPolicy.version,
      modelPolicyVersion: M1_TACTICAL_POLICY_V2.version,
      phase: this.rolloutPolicy.phase,
      cadenceSeconds: this.rolloutPolicy.cadenceMs / 1000,
      instruments: [...this.rolloutPolicy.instruments],
      ...(professionalDemoPhase && this.rolloutPolicy.demoEntryInstruments
        ? {
            demoEntryInstruments: [...this.rolloutPolicy.demoEntryInstruments],
            researchOnlyInstruments: this.rolloutPolicy.instruments.filter(
              (instrument) => !this.rolloutPolicy.demoEntryInstruments!.includes(instrument),
            ),
          }
        : {}),
      running: this.running,
      lastSlotKey: this.lastSlotKey,
      // These are in-process busy wake-up observations, NOT a count of missed
      // eligible fills. A later wake-up can still process the same minute.
      busyMinuteOverlapCount: this.busyMinuteOverlapCount,
      lastBusyOverlapSlotKey: this.lastBusyOverlapSlotKey,
      lastRunAt: this.lastRunAt?.toISOString() ?? null,
      lastError: this.lastError,
      marketReadiness: Object.fromEntries(
        [...this.marketReadiness.entries()].map(([instrument, readiness]) => [
          instrument,
          { ...readiness },
        ]),
      ),
      m5Independent: true as const,
      // Snapshot only; no account identifiers or trading inputs.
      scanTimings: Object.fromEntries(
        [...this.lastScanTimings.entries()].map(([instrument, timing]) => [
          instrument,
          { ...timing },
        ]),
      ),
    };
  }

  async runOnce(now = new Date()): Promise<void> {
    if (this.destroyed || !this.enabled()) return;
    if (!Number.isFinite(now.getTime()) || !isFxWeeklySessionOpen(now)) return;
    const decisionTime = minuteBoundary(now);
    const slotKey = decisionTime.toISOString();
    if (this.lastSlotKey === slotKey) return;

    // Observe, but never change, the pre-existing single-flight guard. Log
    // once per distinct later minute, not once per 15-second timer wake-up.
    // The same minute may still be evaluated after the previous run returns;
    // this is NOT evidence that an actual order was missed.
    if (this.running) {
      if (this.lastBusyOverlapSlotKey !== slotKey) {
        this.lastBusyOverlapSlotKey = slotKey;
        this.busyMinuteOverlapCount++;
        this.logger.warn(
          'M1 tactical busy-minute overlap slot=' +
            slotKey +
            ' previousSlot=' +
            (this.lastSlotKey ?? 'UNKNOWN') +
            ' authority=OBSERVATION_ONLY',
        );
      }
      return;
    }

    // Claim this completed-minute slot before I/O. A provider failure must not
    // create a tight retry loop inside the same minute; the next slot is a new
    // causal decision boundary.
    this.lastSlotKey = slotKey;
    this.running = true;
    try {
      const userId = this.userId();
      let brokerConnectionId = this.connectionId();
      let requireExecutionBrokerSource = false;
      if (
        this.rolloutPolicy.phase === 'DEMO_EARLY_TRANSITION_PROFESSIONAL' &&
        this.executionService
      ) {
        const active = await this.executionService.getActiveSession(userId);
        if (active?.executionMode === ExecutionMode.FULL_AUTO) {
          brokerConnectionId = active.brokerConnectionId;
          requireExecutionBrokerSource = true;
        }
      }
      if (!brokerConnectionId) return;
      // Evaluate every approved DEMO entry pair before running historical
      // research settlements. The V2 list contains all six majors, and this
      // order does not grant additional broker execution authority.
      const focused = this.rolloutPolicy.demoEntryInstruments;
      const scanOrder = focused
        ? [
            ...focused.filter((instrument) => this.rolloutPolicy.instruments.includes(instrument)),
            ...this.rolloutPolicy.instruments.filter((instrument) => !focused.includes(instrument)),
          ]
        : this.rolloutPolicy.instruments;
      // Historical outcomes are observational: they must never make a later
      // pair wait to receive its current-minute broker eligibility decision.
      // Maintain serial entry/risk evaluations; only the read-only observation
      // phase moves behind all six pairs.
      const deferredShadow: Array<{
        instrument: string;
        trace: M1TacticalScanTiming;
        settle: () => Promise<void>;
      }> = [];
      for (const instrument of scanOrder) {
        const startedAt = Date.now();
        const trace: M1TacticalScanTiming = {
          slotTime: slotKey,
          startedAfterSlotMs: Math.max(0, startedAt - decisionTime.getTime()),
          finishedAfterSlotMs: 0,
          totalMs: 0,
          marketLoadMs: null,
          decisionEvaluationMs: null,
          shadowSettlementMs: null,
          state: 'ERROR',
        };
        try {
          const settle = await this.processInstrument(
            userId,
            brokerConnectionId,
            instrument,
            decisionTime,
            trace,
            requireExecutionBrokerSource,
          );
          if (settle) deferredShadow.push({ instrument, trace, settle });
          if (trace.state === 'ERROR') trace.state = 'COMPLETED';
        } catch (error) {
          this.logger.warn(
            'M1 tactical ' +
              instrument +
              ' slot=' +
              slotKey +
              ' failed closed: ' +
              (error as Error).message,
          );
        } finally {
          const finishedAt = Date.now();
          trace.totalMs = Math.max(0, finishedAt - startedAt);
          trace.finishedAfterSlotMs = Math.max(0, finishedAt - decisionTime.getTime());
          this.lastScanTimings.set(instrument, { ...trace });
          // Avoid per-minute logs for healthy fast pairs; log timing anomalies.
          // A historical/test-injected slot should not produce false live-latency alarms.
          if (
            trace.startedAfterSlotMs <= 5 * 60_000 &&
            (trace.totalMs >= 15_000 || trace.startedAfterSlotMs >= 35_000)
          ) {
            this.logger.warn(
              'M1 tactical latency instrument=' +
                instrument +
                ' slot=' +
                slotKey +
                ' startLagMs=' +
                trace.startedAfterSlotMs +
                ' totalMs=' +
                trace.totalMs +
                ' marketMs=' +
                (trace.marketLoadMs ?? 'UNKNOWN') +
                ' decisionMs=' +
                (trace.decisionEvaluationMs ?? 'UNKNOWN') +
                ' shadowMs=' +
                (trace.shadowSettlementMs ?? 'UNKNOWN') +
                ' state=' +
                trace.state,
            );
          }
        }
      }
      // The previous interleaved research work made later USD pairs start
      // 50-90 seconds after a minute boundary on the deployed six-pair V2.
      // Research still settles against each original snapshot/decisionTime,
      // but no longer obstructs this minute's later entry evaluations.
      for (const task of deferredShadow) {
        try {
          await task.settle();
        } catch (error) {
          this.logger.warn(
            'M1 shadow settlement deferred instrument=' +
              task.instrument +
              ' slot=' +
              slotKey +
              ': ' +
              (error as Error).message,
          );
        } finally {
          this.lastScanTimings.set(task.instrument, { ...task.trace });
        }
      }
      this.lastRunAt = new Date(now);
      this.lastError = null;
    } catch (error) {
      this.lastError = (error as Error).message;
      this.logger.warn(`M1 tactical slot=${slotKey} failed closed: ${this.lastError}`);
    } finally {
      this.running = false;
    }
  }

  private async processInstrument(
    userId: string,
    brokerConnectionId: string,
    instrument: string,
    decisionTime: Date,
    timing?: M1TacticalScanTiming,
    requireExecutionBrokerSource = false,
  ): Promise<(() => Promise<void>) | null> {
    const marketStartedAt = Date.now();
    const market = await this.marketData.loadSnapshot(
      brokerConnectionId,
      instrument,
      decisionTime,
      { requireExecutionBrokerSource },
    );
    if (timing) timing.marketLoadMs = Math.max(0, Date.now() - marketStartedAt);
    const readiness = this.marketData.getLastReadiness?.(brokerConnectionId, instrument) ?? null;
    if (readiness) {
      const previous = this.marketReadiness.get(instrument);
      this.marketReadiness.set(instrument, { ...readiness });
      if (previous?.reason !== readiness.reason || previous?.ready !== readiness.ready) {
        this.logger.log(
          `M1 tactical readiness instrument=${instrument} ready=${readiness.ready} ` +
            `reason=${readiness.reason} authority=${readiness.authority ?? 'NONE'}` +
            (readiness.detail ? ` detail=${readiness.detail}` : ''),
        );
      }
    }
    if (!market) {
      if (timing) timing.state = 'MARKET_NOT_READY';
      return null;
    }

    const features = buildM1TacticalFeatures({
      instrument: market.instrument,
      decisionTime: market.decisionTime,
      m1: market.m1,
      m5: market.m5,
      m15: market.m15,
      h1: market.h1,
      h4: market.h4,
    });
    if (!features) {
      if (timing) timing.state = 'FEATURES_UNAVAILABLE';
      return null;
    }

    const decisionStartedAt = Date.now();
    const eventRisk = await this.macroEventRisk.assess(instrument, decisionTime);
    const candidates = buildM1TacticalCandidates(features, M1_TACTICAL_POLICY_V2);
    for (const [candidate, opposite] of [
      [candidates[0], candidates[1]],
      [candidates[1], candidates[0]],
    ] as const) {
      await this.persistCandidate(
        userId,
        brokerConnectionId,
        candidate,
        opposite,
        features,
        eventRisk.state,
        market.spreadEvidence,
        decisionTime,
        market.paperSimulationSpreadPrice,
      );
    }

    if (timing) timing.decisionEvaluationMs = Math.max(0, Date.now() - decisionStartedAt);
    // Capture the original completed-minute bars. No model/risk/dispatch path
    // depends on settling these historical research results in the same pair turn.
    return async () => {
      const settlementStartedAt = Date.now();
      try {
        await this.settleMatureDriftCounterfactuals(
          userId,
          brokerConnectionId,
          instrument,
          decisionTime,
          market.m1,
        );
        await this.settleMatureShadowEpisodes(
          userId,
          brokerConnectionId,
          instrument,
          decisionTime,
          market.m1,
        );
        await this.settleMatureLowVolRangeShadowEpisodes(
          userId,
          brokerConnectionId,
          instrument,
          decisionTime,
          market.m1,
        );
      } finally {
        if (timing) timing.shadowSettlementMs = Math.max(0, Date.now() - settlementStartedAt);
      }
    };
  }

  private async settleMatureLowVolRangeShadowEpisodes(
    userId: string,
    brokerConnectionId: string,
    instrument: string,
    decisionTime: Date,
    m1Bars: Parameters<typeof evaluateM1CausalOutcome15m>[0]['bars'],
  ): Promise<void> {
    let leaders: Awaited<ReturnType<M1TacticalEvidenceService['loadMatureLowVolRangeLeaders']>>;
    try {
      leaders = await this.evidence.loadMatureLowVolRangeLeaders({
        userId,
        brokerConnectionId,
        instrument,
        policyVersion: M1_TACTICAL_POLICY_V2.version,
        asOf: decisionTime,
      });
    } catch (error) {
      this.logger.warn(
        `Low-vol range research load deferred instrument=${instrument}: ${(error as Error).message}`,
      );
      return;
    }
    for (const leader of leaders) {
      const result = evaluateLowVolRangeShadowOutcome({
        decisionId: leader.id,
        direction: leader.direction,
        evaluatedAt: leader.evaluatedAt,
        asOf: decisionTime,
        stopDistance: leader.stopDistance,
        targetDistance: leader.targetDistance,
        observedExecutionCostR: leader.observedExecutionCostR,
        hypothesisCohort: leader.hypothesisCohort,
        completedBrokerM1Bars: m1Bars,
      });
      if (!result) continue;
      try {
        await this.evidence.markLowVolRangeShadowOutcome(leader.id, result);
      } catch (error) {
        this.logger.warn(
          `Low-vol range research settlement deferred decision=${leader.id}: ${(error as Error).message}`,
        );
      }
    }
  }

  private async settleMatureDriftCounterfactuals(
    userId: string,
    brokerConnectionId: string,
    instrument: string,
    decisionTime: Date,
    m1Bars: Parameters<typeof evaluateM1DriftCounterfactual15m>[0]['bars'],
  ): Promise<void> {
    let pending: Awaited<ReturnType<M1TacticalEvidenceService['loadPendingDriftCounterfactuals']>>;
    try {
      pending = await this.evidence.loadPendingDriftCounterfactuals({
        userId,
        brokerConnectionId,
        instrument,
        asOf: decisionTime,
        policyVersion: M1_TACTICAL_POLICY_V2.version,
      });
    } catch (error) {
      this.logger.warn(
        `M1 drift counterfactual load deferred ${instrument}: ${(error as Error).message}`,
      );
      return;
    }

    for (const decision of pending) {
      const observation = evaluateM1DriftCounterfactual15m({
        direction: decision.direction,
        evaluatedAt: decision.evaluatedAt,
        stopDistance: decision.stopDistance,
        targetDistance: decision.targetDistance,
        executionCostR: decision.estimatedExecutionCostR,
        bars: m1Bars,
      });
      if (!observation) continue;
      try {
        // Preserve other vetoes: a later positive price move cannot prove
        // this entry was eligible for trading at decision time.
        await this.evidence.markDriftCounterfactual15m(decision.id, {
          ...observation,
          selectionPolicy: 'FIXED_UTC_16M_EPISODE_RESEARCH',
          driftEvidenceSource: decision.driftEvidenceSource,
          driftStateAtDecision: decision.driftState,
          driftDiagnosticsAtDecision: decision.driftDiagnostics,
          nonDriftBlockersAtDecision: decision.nonDriftBlockers,
          driftWasOnlySubstantiveBlocker: decision.nonDriftBlockers.length === 0,
        });
      } catch (error) {
        this.logger.warn(
          `M1 drift counterfactual settlement deferred decision=${decision.id}: ${(error as Error).message}`,
        );
      }
    }
  }

  private async settleMatureShadowEpisodes(
    userId: string,
    brokerConnectionId: string,
    instrument: string,
    decisionTime: Date,
    m1Bars: Parameters<typeof evaluateM1CausalOutcome15m>[0]['bars'],
  ): Promise<void> {
    let leaders: Awaited<ReturnType<M1TacticalEvidenceService['loadMatureShadowEpisodeLeaders']>>;
    try {
      leaders = await this.evidence.loadMatureShadowEpisodeLeaders({
        userId,
        brokerConnectionId,
        instrument,
        policyVersion: M1_TACTICAL_POLICY_V2.version,
        asOf: decisionTime,
      });
    } catch (error) {
      this.logger.warn(
        `M1 shadow outcome load deferred ${instrument}: ${(error as Error).message}`,
      );
      return;
    }

    for (const leader of leaders) {
      const observation = evaluateM1CausalOutcome15m({
        direction: leader.direction,
        evaluatedAt: leader.evaluatedAt,
        stopDistance: leader.stopDistance,
        targetDistance: leader.targetDistance,
        executionCostR: leader.estimatedExecutionCostR,
        bars: m1Bars,
      });

      let outcome: M1ShadowOutcome15mV1 | null = null;
      if (observation) {
        outcome = {
          artifact: M1_SHADOW_OUTCOME_15M_ARTIFACT,
          modifiesExecution: false,
          episodeLeaderDecisionId: leader.id,
          episodeStartBarTime: leader.barTime.toISOString(),
          route: leader.route,
          instrument: leader.instrument,
          direction: leader.direction,
          policyVersion: leader.policyVersion,
          source: observation.source,
          executionCostSource: leader.executionCostSource,
          rolloutPhase: leader.rolloutPhase,
          outcome: observation.outcome,
          entryBarOpenTime: observation.entryBarOpenTime,
          observedAt: observation.observedAt,
          terminalBarOpenTime: observation.terminalBarOpenTime,
          entryPrice: observation.entryPrice,
          stopLoss: observation.stopLoss,
          takeProfit: observation.takeProfit,
          terminalPrice: observation.terminalPrice,
          estimatedExecutionCostR: observation.estimatedExecutionCostR,
          grossRMultiple: observation.grossRMultiple,
          netRMultiple: observation.netRMultiple,
        };
      } else if (decisionTime.getTime() - leader.evaluatedAt.getTime() > 60 * 60_000) {
        outcome = {
          artifact: M1_SHADOW_OUTCOME_15M_ARTIFACT,
          modifiesExecution: false,
          episodeLeaderDecisionId: leader.id,
          episodeStartBarTime: leader.barTime.toISOString(),
          route: leader.route,
          instrument: leader.instrument,
          direction: leader.direction,
          policyVersion: leader.policyVersion,
          source: 'UNOBSERVABLE_DATA_GAP',
          executionCostSource: leader.executionCostSource,
          rolloutPhase: leader.rolloutPhase,
          outcome: 'UNOBSERVABLE_DATA_GAP',
          entryBarOpenTime: null,
          observedAt: decisionTime.toISOString(),
          terminalBarOpenTime: null,
          entryPrice: null,
          stopLoss: null,
          takeProfit: null,
          terminalPrice: null,
          estimatedExecutionCostR: leader.estimatedExecutionCostR,
          grossRMultiple: null,
          netRMultiple: null,
        };
      }

      if (!outcome) continue;
      try {
        await this.evidence.markShadowOutcome15mV1(leader.id, outcome);
      } catch (error) {
        this.logger.warn(
          `M1 shadow outcome settlement deferred decision=${leader.id}: ${(error as Error).message}`,
        );
      }
    }
  }

  private async evaluateDemoMultimodel(
    userId: string,
    brokerConnectionId: string,
    candidate: M1TacticalCandidate,
    features: NonNullable<ReturnType<typeof buildM1TacticalFeatures>>,
    eventRisk: 'CLEAR' | 'HIGH_IMPACT_BLOCK' | 'UNVERIFIED',
    spreadEvidence: Parameters<typeof evaluateM1TacticalGovernance>[0]['executionSpreadEvidence'],
    decisionTime: Date,
    paperSimulationSpreadPrice?: number,
  ): Promise<MultimodelDemoEvaluation> {
    const planBInput = m1CandidateToPlanBInput(candidate, features, decisionTime);
    const portfolioPositions: PlanBPortfolioPosition[] = [];
    let portfolioSnapshotAvailable = false;
    try {
      const snapshot = await this.evidence.loadOpenPaperRiskPositions({
        userId,
        brokerConnectionId,
      });
      portfolioPositions.push(
        ...snapshot.map((position) => ({
          instrument: position.instrument,
          direction: position.direction,
          lotSize: position.lotSize,
        })),
      );
      portfolioSnapshotAvailable = true;
    } catch (error) {
      this.logger.warn(
        `Multi-model portfolio snapshot unavailable connection=${brokerConnectionId}: ${(error as Error).message}`,
      );
    }

    const ensemble = scorePlanBMultimodelShadow(planBInput, portfolioPositions);
    const governance = evaluateEnsembleGovernance({
      ensemble,
      instrument: candidate.instrument,
      direction: candidate.direction,
      entryPrice: candidate.entry,
      stopLoss: candidate.stopLoss,
      takeProfit: candidate.takeProfit,
      confidence: candidate.confidence,
      extensionAtr: planBInput.extensionAtr,
      volatilityScore: planBInput.volatilityScore,
      emaSeparation: planBInput.emaSeparation,
      mtfStrength: planBInput.mtfStrength,
      rsi14: planBInput.rsi14,
      shortHorizonMomentumAtr: planBInput.shortHorizonMomentumAtr,
      eventRisk,
      evaluatedAt: decisionTime,
      executionSpreadEvidence: spreadEvidence ?? null,
      paperSimulationSpreadPrice,
    });

    const trainedExpert: HighConvictionOverlay = this.highConvictionBrokerExpert
      ? await this.highConvictionBrokerExpert.evaluate({
          userId,
          brokerConnectionId,
          instrument: candidate.instrument,
          candidateDirection: candidate.direction,
          candidateCloseTime: decisionTime,
        })
      : {
          state: 'UNAVAILABLE',
          reason: 'TRAINED_EXPERT_SERVICE_UNAVAILABLE',
          decisionTime: null,
          freshnessSeconds: null,
          allBrokerNative: false,
          direction: null,
          admitted: null,
          ensembleConfidence: null,
          meanOpportunityProbability: null,
          longVotes: null,
          shortVotes: null,
          regime: null,
          modifiesExecution: false,
        };

    const baseAuthority = evaluateMultimodelDemoAuthority({
      ensemble,
      governance,
      trainedExpert,
      candidateDirection: candidate.direction,
      m1ReversalEvidence: candidate,
      m1TimingRoute: classifyM1TacticalRoute(
        candidate,
        buildM1TacticalCandidates(features, M1_TACTICAL_POLICY_V2).find(
          (item) => item.direction !== candidate.direction,
        )!,
        features,
        M1_TACTICAL_POLICY_V2,
      ).route,
    });
    const portfolioBlocker = portfolioSnapshotAvailable
      ? []
      : ['MULTIMODEL_PORTFOLIO_SNAPSHOT_UNAVAILABLE'];
    const authority: MultimodelDemoAuthorityDecision = {
      ...baseAuthority,
      executable: baseAuthority.executable && portfolioSnapshotAvailable,
      blockers: unique([...baseAuthority.blockers, ...portfolioBlocker]),
    };
    return { ensemble, governance, trainedExpert, authority, portfolioSnapshotAvailable };
  }

  private async persistCandidate(
    userId: string,
    brokerConnectionId: string,
    candidate: M1TacticalCandidate,
    opposite: M1TacticalCandidate,
    features: ReturnType<typeof buildM1TacticalFeatures> & {},
    eventRisk: 'CLEAR' | 'HIGH_IMPACT_BLOCK' | 'UNVERIFIED',
    spreadEvidence: Parameters<typeof evaluateM1TacticalGovernance>[0]['executionSpreadEvidence'],
    decisionTime: Date,
    paperSimulationSpreadPrice?: number,
  ): Promise<void> {
    if (!features) return;
    // Observational timings only; never consulted by risk or entry authority.
    const startedCandidateAt = Date.now();
    const timings = {
      reliabilityMs: 0,
      scoutMs: 0,
      multimodelMs: 0,
      executableFeeMs: 0,
      blockedFeeShadowMs: 0,
      persistMs: 0,
    };
    const routeDecision = classifyM1TacticalRoute(
      candidate,
      opposite,
      features,
      M1_TACTICAL_POLICY_V2,
    );
    const reliabilityStartedAt = Date.now();
    const reliability = await this.reliabilityFor(
      userId,
      brokerConnectionId,
      candidate,
      routeDecision,
      decisionTime,
    );
    timings.reliabilityMs = Date.now() - reliabilityStartedAt;
    const expectancy = evaluateM1TacticalExpectancy({
      targetR: candidate.grossExpectedR,
      confidence: candidate.confidence,
      directionQuality: candidate.directionQuality,
      reliability,
    });
    const governance = evaluateM1TacticalGovernance({
      candidate,
      routeDecision,
      features,
      eventRisk,
      evaluatedAt: decisionTime,
      executionSpreadEvidence: spreadEvidence,
      paperSimulationSpreadPrice,
      reliability,
      expectancy,
    });
    const scoutStartedAt = Date.now();
    const shadowPairSideReliability = await this.shadowPairSideReliabilityFor(
      userId,
      brokerConnectionId,
      candidate,
      routeDecision,
      decisionTime,
    );
    timings.scoutMs = Date.now() - scoutStartedAt;
    const professionalDemoPhase = this.rolloutPolicy.phase === 'DEMO_EARLY_TRANSITION_PROFESSIONAL';
    const multimodelStartedAt = Date.now();
    const multimodelDemo = professionalDemoPhase
      ? await this.evaluateDemoMultimodel(
          userId,
          brokerConnectionId,
          candidate,
          features,
          eventRisk,
          spreadEvidence,
          decisionTime,
          paperSimulationSpreadPrice,
        )
      : null;
    timings.multimodelMs = Date.now() - multimodelStartedAt;
    const demoProfitabilityReliabilityGate = professionalDemoPhase
      ? evaluateDemoProfitabilityReliabilityGate({
          m1Route: routeDecision.route,
          m1ReliabilityReason: reliability?.reason ?? null,
          pairSideReliability: shadowPairSideReliability
            ? {
                eligible: shadowPairSideReliability.eligible,
                reason: shadowPairSideReliability.reason,
              }
            : null,
        })
      : null;
    const demoProfitabilityExecutionAllowed =
      demoProfitabilityReliabilityGate?.executable !== false;

    const shadowOnly = this.rolloutPolicy.phase === 'SHADOW';
    const routeExecutable = m1RouteExecutableInPhase(this.rolloutPolicy.phase, routeDecision.route);
    const routeNetExpectedRFloor =
      routeDecision.route === 'ABSTAIN'
        ? Number.POSITIVE_INFINITY
        : this.rolloutPolicy.routeNetExpectedRFloors[routeDecision.route];
    const routePayoffEligible =
      routeDecision.route !== 'ABSTAIN' &&
      governance.expectancy.statisticalExpectedR >= routeNetExpectedRFloor;
    const shadowOutcomeEligible = m1ShadowOutcomeEligible({
      routeEligible: routeDecision.eligible,
      route: routeDecision.route,
      routeReason: routeDecision.reason,
      routePayoffEligible,
      blockers: governance.blockers,
      eventRisk,
      paperExecutionCostUsable: governance.genericGovernance.paperExecutionCostUsable === true,
    });
    const earlyTransitionMicro =
      this.rolloutPolicy.phase === 'PAPER_EARLY_TRANSITION_MICRO' &&
      routeDecision.route === 'M1_EARLY_TRANSITION';
    const earlyTransitionMeaningfulScout =
      this.rolloutPolicy.phase === 'PAPER_EARLY_TRANSITION_SCOUT_010' &&
      routeDecision.route === 'M1_EARLY_TRANSITION';
    const earlyTransitionTieredScout =
      (this.rolloutPolicy.phase === 'PAPER_EARLY_TRANSITION_SCOUT_TIERED' ||
        this.rolloutPolicy.phase === 'DEMO_EARLY_TRANSITION_PROFESSIONAL') &&
      routeDecision.route === 'M1_EARLY_TRANSITION';
    const evidenceQualifiedScout = earlyTransitionMeaningfulScout || earlyTransitionTieredScout;
    const scoutReliabilityArtifact = shadowPairSideReliability
      ? 'artifact' in shadowPairSideReliability
        ? shadowPairSideReliability.artifact
        : M1_SHADOW_MICRO_RELIABILITY_ARTIFACT
      : null;
    const meaningfulScoutReliability =
      shadowPairSideReliability &&
      'artifact' in shadowPairSideReliability &&
      shadowPairSideReliability.artifact === M1_MEANINGFUL_SCOUT_RELIABILITY_ARTIFACT
        ? shadowPairSideReliability
        : null;
    const provisionalScoutReliability =
      shadowPairSideReliability &&
      'artifact' in shadowPairSideReliability &&
      shadowPairSideReliability.artifact === M1_PROVISIONAL_SCOUT_RELIABILITY_ARTIFACT
        ? shadowPairSideReliability
        : null;
    const scoutReliabilityTier = earlyTransitionTieredScout
      ? provisionalScoutReliability
        ? 'PROVISIONAL'
        : meaningfulScoutReliability
          ? 'MATURE'
          : 'NONE'
      : earlyTransitionMeaningfulScout
        ? 'MATURE'
        : earlyTransitionMicro
          ? 'MICRO'
          : 'NONE';
    const professionalM1Fallback = professionalDemoPhase
      ? evaluateM1ProfessionalFallback({
          candidate,
          routeDecision,
          governance,
          reliability,
          shadowPairSideReliability,
          multimodelDemo,
          routePayoffEligible,
          features,
        })
      : null;
    const professionalM1FallbackExecutable =
      professionalM1FallbackExecutionEnabled(professionalM1Fallback);
    const professionalM1BootstrapExecutable =
      professionalM1FallbackExecutable && professionalM1Fallback?.tier === 'BOOTSTRAP_CONTINUATION';
    const multimodelPrimaryExecutable =
      professionalDemoPhase &&
      demoProfitabilityExecutionAllowed &&
      multimodelDemo?.authority.executable === true;
    const multimodelDirectionConflict =
      professionalDemoPhase &&
      multimodelDemo?.authority.blockers.includes(
        'MULTIMODEL_TRAINED_EXPERT_DIRECTION_CONFLICT',
      ) === true;
    let m5EarlyTransitionEvidence: M5EarlyTransitionEvidence | null = null;
    let m5EarlyTransitionHandoff: M5EarlyTransitionHandoffDecision | null = null;
    if (
      professionalDemoPhase &&
      !multimodelPrimaryExecutable &&
      (!professionalM1FallbackExecutable || professionalM1BootstrapExecutable)
    ) {
      try {
        m5EarlyTransitionEvidence = await this.evidence.loadLatestM5EarlyTransitionEvidence({
          userId,
          instrument: candidate.instrument,
          direction: candidate.direction,
          asOf: decisionTime,
        });
        if (m5EarlyTransitionEvidence) {
          m5EarlyTransitionHandoff = evaluateM5EarlyTransitionHandoff({
            decisionTime,
            m5Evidence: m5EarlyTransitionEvidence,
            m1Route: routeDecision.route,
            m1Reason: routeDecision.reason,
            m1Confidence: candidate.confidence,
            m1DirectionQuality: candidate.directionQuality,
            m1ExecutionCostUsable: governance.genericGovernance.paperExecutionCostUsable === true,
            m1EventRisk: eventRisk,
          });
        }
      } catch (error) {
        this.logger.warn(
          `M5 early-transition handoff evidence unavailable ${candidate.instrument} ${candidate.direction}: ${(error as Error).message}`,
        );
      }
    }
    const m5EarlyTransitionHandoffEligible = m5EarlyTransitionHandoff?.eligible === true;
    let extensionExhaustionDemoScout: ExtensionExhaustionDemoScoutDecision | null = null;
    if (
      professionalDemoPhase &&
      !multimodelPrimaryExecutable &&
      !m5EarlyTransitionHandoffEligible &&
      !professionalM1FallbackExecutable &&
      multimodelDemo
    ) {
      const extensionExhaustionShadow = scoreExtensionExhaustionShadow({
        regime: multimodelDemo.ensemble.regime,
        driftState: multimodelDemo.governance.driftState,
        confidence: candidate.confidence,
        netExpectedR: multimodelDemo.governance.netExpectedR,
        directionQuality: multimodelDemo.ensemble.directionQuality,
        tradeQuality: multimodelDemo.ensemble.tradeQuality,
        exitQuality: multimodelDemo.ensemble.exitQuality,
        extensionAtr: features.extensionAtr,
        executionSpreadEvidenceValid: multimodelDemo.governance.executionSpreadEvidenceValid,
      });
      const reliability = extensionExhaustionShadow.candidate
        ? await this.evidence.loadExtensionExhaustionShadowReliability({
            userId,
            instrument: candidate.instrument,
            direction: candidate.direction,
            asOf: decisionTime,
          })
        : null;
      extensionExhaustionDemoScout = evaluateExtensionExhaustionDemoScout({
        specialist: {
          candidate: extensionExhaustionShadow.candidate,
          reason: extensionExhaustionShadow.reason,
          regime: multimodelDemo.ensemble.regime,
          driftState: multimodelDemo.governance.driftState,
          confidence: extensionExhaustionShadow.confidence,
          netExpectedR: extensionExhaustionShadow.netExpectedR,
          directionQuality: extensionExhaustionShadow.directionQuality,
          executionSpreadEvidenceValid: multimodelDemo.governance.executionSpreadEvidenceValid,
        },
        eventRisk,
        m1Route: routeDecision.route,
        m1Confidence: candidate.confidence,
        m1DirectionQuality: candidate.directionQuality,
        trainedExpertOpposed: multimodelDemo.authority.trainedExpertOpposed,
        portfolioSnapshotAvailable: multimodelDemo.portfolioSnapshotAvailable,
        reliability,
      });
    }
    const extensionExhaustionDemoScoutExecutable = extensionExhaustionDemoScout?.eligible === true;
    const executionVolumeCap = m5EarlyTransitionHandoffEligible
      ? m5EarlyTransitionHandoff!.lotCap
      : professionalM1FallbackExecutable
        ? professionalM1Fallback!.lotCap
        : extensionExhaustionDemoScoutExecutable
          ? extensionExhaustionDemoScout!.lotCap
          : this.rolloutPolicy.phase === 'DEMO_EARLY_TRANSITION_PROFESSIONAL'
            ? multimodelDemo
              ? multimodelDemoExecutionVolumeCap(
                  this.rolloutPolicy.paperVolumeCap,
                  multimodelDemo.authority,
                )
              : this.rolloutPolicy.paperVolumeCap
            : provisionalScoutReliability
              ? Math.min(this.rolloutPolicy.paperVolumeCap, provisionalScoutReliability.lotCap)
              : this.rolloutPolicy.paperVolumeCap;
    const microDriftOnlyRescue =
      earlyTransitionMicro &&
      shadowPairSideReliability?.eligible === true &&
      governance.blockers.length === 1 &&
      governance.blockers[0] === 'DRIFT_OUT_OF_DISTRIBUTION';
    const localImpulseDriftOnlyRescue =
      evidenceQualifiedScout &&
      routeDecision.reason === 'LOCAL_IMPULSE_AGAINST_HTF' &&
      shadowPairSideReliability?.eligible === true &&
      governance.blockers.length === 1 &&
      governance.blockers[0] === 'DRIFT_OUT_OF_DISTRIBUTION';
    const standardGovernanceExecutable =
      governance.paperEligible && governance.executionAuthority === 'PAPER_ONLY_RESEARCH';
    const governanceExecutable = earlyTransitionMicro
      ? shadowPairSideReliability?.eligible === true &&
        (standardGovernanceExecutable || microDriftOnlyRescue)
      : evidenceQualifiedScout
        ? shadowPairSideReliability?.eligible === true &&
          (standardGovernanceExecutable || localImpulseDriftOnlyRescue)
        : standardGovernanceExecutable;
    const demoPrimaryOnlyProbation = evaluateDemoPrimaryOnlyProbation({
      enabled: professionalDemoPhase && this.rolloutPolicy.demoPrimaryOnlyProbation === true,
      primaryAuthorityPath: multimodelDemo?.authority.authorityPath ?? null,
      m5HandoffEligible: m5EarlyTransitionHandoffEligible,
      executableFallbackTier: professionalM1FallbackExecutable
        ? (professionalM1Fallback?.tier ?? null)
        : null,
      extensionScoutExecutable: extensionExhaustionDemoScoutExecutable,
    });
    // Authoritative DEMO new-entry scope, after all research predictions
    // have been scored. A research-only pair MUST NOT reach a broker write,
    // including direction-flip closures triggered by a new entry candidate.
    const demoInstrumentAllowed = demoInstrumentEntryAllowed(
      this.rolloutPolicy,
      candidate.instrument,
    );
    const preliminaryCanExecute = professionalDemoPhase
      ? demoInstrumentAllowed &&
        demoProfitabilityExecutionAllowed &&
        !multimodelDirectionConflict &&
        (multimodelPrimaryExecutable ||
          m5EarlyTransitionHandoffEligible ||
          professionalM1FallbackExecutable ||
          extensionExhaustionDemoScoutExecutable)
      : routeExecutable && routePayoffEligible && governanceExecutable;
    // An isolated pair/side/route can have a clean local streak while the
    // DEMO portfolio loses repeatedly across several instruments. Require
    // same-session broker-account net economics before ANY new primary-engine
    // DEMO entry; never alter existing positions or weaken session authority.
    let portfolioNetLossBrake: M1PortfolioNetLossBrakeDecision | null = null;
    if (professionalDemoPhase && preliminaryCanExecute && this.executionService) {
      try {
        const active = await this.executionService.getActiveSession(userId);
        if (
          active?.executionMode === ExecutionMode.FULL_AUTO &&
          active.brokerConnectionId === brokerConnectionId
        ) {
          portfolioNetLossBrake = await this.evidence.loadPortfolioNetLossStreakBrake({
            userId,
            brokerConnectionId,
            tradingSessionId: active.id,
            evaluatedAt: decisionTime,
          });
        }
      } catch (error) {
        // A failed read cannot justify NEW exposure. Do not close or change
        // any already-open broker position, and retain explicit diagnostics.
        this.logger.warn(
          `M1 portfolio net-loss brake evidence unavailable: ${(error as Error).message}`,
        );
        portfolioNetLossBrake = {
          artifact: M1_PORTFOLIO_NET_LOSS_BRAKE_ARTIFACT,
          active: true,
          reason: 'EVIDENCE_UNAVAILABLE',
          recentClosedTrades: 0,
          consecutiveNetLosses: 0,
          latestClosedAt: null,
          cooldownMinutes: M1_PORTFOLIO_NET_LOSS_BRAKE_COOLDOWN_MINUTES,
          cooldownRemainingSeconds: 0,
        };
      }
    }
    let activeOppositePositions: Awaited<
      ReturnType<M1TacticalEvidenceService['loadOpenPaperPositions']>
    > = [];
    let oppositePositionStateUnavailable = false;
    if (professionalDemoPhase && preliminaryCanExecute) {
      try {
        const openPositions = await this.evidence.loadOpenPaperPositions({
          userId,
          brokerConnectionId,
          instrument: candidate.instrument,
        });
        activeOppositePositions = openPositions.filter(
          (position) => position.direction !== candidate.direction,
        );
      } catch (error) {
        oppositePositionStateUnavailable = true;
        this.logger.warn(
          `M1 direction-conflict state unavailable ${candidate.instrument} ${candidate.direction}: ${(error as Error).message}`,
        );
      }
    }
    const confirmedDirectionFlip =
      activeOppositePositions.length > 0 &&
      multimodelPrimaryExecutable &&
      multimodelDemo?.ensemble.strategyRoute === 'CONFIRMED_REVERSAL' &&
      // A local M1 continuation, even when consistently aligned with the
      // Plan-B reversal, must not force-close an opposite broker position.
      multimodelDemo?.authority.reversalTimingBridge !== true;
    if (confirmedDirectionFlip && this.executionService) {
      for (const position of activeOppositePositions) {
        try {
          await this.executionService.closeTrade(
            position.tradeId,
            userId,
            TradeCloseReason.AI_CLOSE_SIGNAL,
            { source: 'M1_CONFIRMED_DIRECTION_FLIP' },
          );
        } catch (error) {
          this.logger.warn(
            `M1 confirmed direction flip exit deferred trade=${position.tradeId} ` +
              `${candidate.instrument} ${position.direction}->${candidate.direction}: ${(error as Error).message}`,
          );
        }
      }
    }
    const activeOppositePosition = activeOppositePositions.length > 0;

    const bootstrapExecutionSelected =
      professionalM1BootstrapExecutable && !m5EarlyTransitionHandoffEligible;
    const professionalM1ActiveSameSideIntent =
      preliminaryCanExecute && professionalM1FallbackExecutable
        ? await this.evidence.hasActiveM1Intent({
            userId,
            brokerConnectionId,
            instrument: candidate.instrument,
            direction: candidate.direction,
          })
        : false;
    const extensionExhaustionActiveSameSideIntent =
      preliminaryCanExecute && extensionExhaustionDemoScoutExecutable
        ? await this.evidence.hasActiveM1Intent({
            userId,
            brokerConnectionId,
            instrument: candidate.instrument,
            direction: candidate.direction,
          })
        : false;
    const bootstrapActiveSameSideIntent =
      professionalM1ActiveSameSideIntent && bootstrapExecutionSelected;
    const qualifiedContinuationActiveSameSideIntent =
      professionalM1ActiveSameSideIntent &&
      professionalM1Fallback?.tier === 'QUALIFIED_CONTINUATION';
    const fastStopRegimeBrake = preliminaryCanExecute
      ? await this.evidence.loadFastStopRegimeBrake({
          userId,
          brokerConnectionId,
          instrument: candidate.instrument,
          direction: candidate.direction,
          evaluatedAt: decisionTime,
        })
      : null;
    const executionStrategyRoute = m5EarlyTransitionHandoffEligible
      ? ('EARLY_TRANSITION' as const)
      : extensionExhaustionDemoScoutExecutable
        ? ('TREND_CONTINUATION' as const)
        : multimodelDemo?.ensemble.strategyRoute;
    const multimodelLossStreakBrake =
      preliminaryCanExecute &&
      (multimodelPrimaryExecutable ||
        m5EarlyTransitionHandoffEligible ||
        extensionExhaustionDemoScoutExecutable) &&
      executionStrategyRoute
        ? await this.evidence.loadMultimodelLossStreakBrake({
            userId,
            brokerConnectionId,
            instrument: candidate.instrument,
            direction: candidate.direction,
            strategyRoute: executionStrategyRoute,
            evaluatedAt: decisionTime,
          })
        : null;
    const selectedPrimaryForCommission =
      professionalDemoPhase &&
      multimodelPrimaryExecutable &&
      demoPrimaryOnlyProbation.chosenAuthorityPath === 'PRIMARY_PLAN_B' &&
      !demoPrimaryOnlyProbation.blocked;
    const commissionFloorEnabled =
      professionalDemoPhase && this.rolloutPolicy.demoBrokerCommissionFloor === true;
    const commissionShadowEnabled =
      professionalDemoPhase && this.rolloutPolicy.demoBrokerCommissionShadow === true;
    let feeEvidenceForDecision: Awaited<
      ReturnType<M1TacticalEvidenceService['loadPriorClosedCommissionRiskR']>
    > | null = null;
    let brokerFeeLookupFailed = false;
    if (
      (commissionFloorEnabled || commissionShadowEnabled) &&
      preliminaryCanExecute &&
      selectedPrimaryForCommission
    ) {
      const executableFeeStartedAt = Date.now();
      try {
        feeEvidenceForDecision = await this.evidence.loadPriorClosedCommissionRiskR({
          userId,
          brokerConnectionId,
          instrument: candidate.instrument,
          asOf: decisionTime,
        });
      } catch (error) {
        brokerFeeLookupFailed = true;
        this.logger.warn(
          `M1 broker commission admission evidence unavailable instrument=${candidate.instrument}: ${(error as Error).message}`,
        );
      } finally {
        timings.executableFeeMs = Date.now() - executableFeeStartedAt;
      }
    }
    const demoBrokerCommissionGate = evaluateDemoBrokerCommissionEntryGate({
      enabled: commissionFloorEnabled && preliminaryCanExecute,
      selectedPrimary: selectedPrimaryForCommission,
      preFeeNetExpectedR: multimodelDemo?.governance.netExpectedR ?? null,
      strategyRoute: multimodelDemo?.ensemble.strategyRoute ?? null,
      evidence: feeEvidenceForDecision,
      lookupFailed: brokerFeeLookupFailed,
    });
    // Counterfactual, never a veto: same historical-fill p90 calculation,
    // evaluated with the old gate on solely for research labels. This is
    // saved on the decision and joined by trade_intent_id to actual net P&L.
    const demoBrokerCommissionShadowGate = commissionShadowEnabled
      ? evaluateDemoBrokerCommissionEntryGate({
          enabled: preliminaryCanExecute,
          selectedPrimary: selectedPrimaryForCommission,
          preFeeNetExpectedR: multimodelDemo?.governance.netExpectedR ?? null,
          strategyRoute: multimodelDemo?.ensemble.strategyRoute ?? null,
          evidence: feeEvidenceForDecision,
          lookupFailed: brokerFeeLookupFailed,
        })
      : null;
    const commissionGateAudit = {
      ...demoBrokerCommissionGate,
      shadowOnly: commissionShadowEnabled,
      shadowWouldHaveBlocked: demoBrokerCommissionShadowGate?.blocked ?? false,
      shadowReason: demoBrokerCommissionShadowGate?.reason ?? null,
      shadowBrokerFeeP90R: demoBrokerCommissionShadowGate?.brokerFeeP90R ?? null,
      shadowAfterFeeExpectedR: demoBrokerCommissionShadowGate?.afterFeeExpectedR ?? null,
    };
    const canExecute =
      preliminaryCanExecute &&
      !oppositePositionStateUnavailable &&
      !activeOppositePosition &&
      !professionalM1ActiveSameSideIntent &&
      !extensionExhaustionActiveSameSideIntent &&
      fastStopRegimeBrake?.active !== true &&
      multimodelLossStreakBrake?.active !== true &&
      portfolioNetLossBrake?.active !== true &&
      !demoPrimaryOnlyProbation.blocked &&
      !demoBrokerCommissionGate.blocked;
    const effectiveGovernanceBlockers =
      microDriftOnlyRescue || localImpulseDriftOnlyRescue ? [] : governance.blockers;
    const researchBlockers = unique([
      ...effectiveGovernanceBlockers,
      ...(earlyTransitionMicro && shadowPairSideReliability?.eligible !== true
        ? [`M1_SHADOW_RELIABILITY_${shadowPairSideReliability?.reason ?? 'UNAVAILABLE'}`]
        : []),
      ...(earlyTransitionMeaningfulScout && shadowPairSideReliability?.eligible !== true
        ? [`M1_MEANINGFUL_SCOUT_RELIABILITY_${shadowPairSideReliability?.reason ?? 'UNAVAILABLE'}`]
        : []),
      ...(earlyTransitionTieredScout && shadowPairSideReliability?.eligible !== true
        ? [`M1_TIERED_SCOUT_RELIABILITY_${shadowPairSideReliability?.reason ?? 'UNAVAILABLE'}`]
        : []),
      ...(routeExecutable && !routePayoffEligible ? ['M1_ROUTE_NET_EXPECTED_R_FLOOR'] : []),
      ...(shadowOnly ? ['M1_PHASE_SHADOW'] : []),
      ...(!shadowOnly && !routeExecutable && routeDecision.route !== 'ABSTAIN'
        ? ['M1_PHASE_ROUTE_SHADOW']
        : []),
    ]);
    const blockers = professionalDemoPhase
      ? unique([
          ...(!demoInstrumentAllowed ? ['M1_DEMO_INSTRUMENT_RESEARCH_ONLY'] : []),
          ...(demoProfitabilityReliabilityGate?.blockers ?? []),
          ...(multimodelDirectionConflict ? ['MULTIMODEL_TRAINED_EXPERT_DIRECTION_CONFLICT'] : []),
          ...(professionalM1FallbackExecutable ||
          m5EarlyTransitionHandoffEligible ||
          extensionExhaustionDemoScoutExecutable
            ? []
            : (multimodelDemo?.authority.blockers ?? ['MULTIMODEL_AUTHORITY_UNAVAILABLE'])),
          ...(professionalM1Fallback?.eligible === true &&
          !professionalM1FallbackExecutable &&
          !m5EarlyTransitionHandoffEligible
            ? ['M1_PROFESSIONAL_FALLBACK_OBSERVATIONAL_ONLY']
            : []),
          ...(bootstrapActiveSameSideIntent ? ['M1_BOOTSTRAP_ACTIVE_SAME_SIDE_INTENT'] : []),
          ...(qualifiedContinuationActiveSameSideIntent
            ? ['M1_PROFESSIONAL_ACTIVE_SAME_SIDE_INTENT']
            : []),
          ...(extensionExhaustionActiveSameSideIntent
            ? ['M1_EXTENSION_EXHAUSTION_ACTIVE_SAME_SIDE_INTENT']
            : []),
          ...(fastStopRegimeBrake?.active === true ? ['M1_FAST_STOP_REGIME_BRAKE'] : []),
          ...(multimodelLossStreakBrake?.active === true
            ? ['M1_MULTIMODEL_LOSS_STREAK_BRAKE']
            : []),
          ...(portfolioNetLossBrake?.active === true ? ['M1_PORTFOLIO_NET_LOSS_STREAK_BRAKE'] : []),
          ...(demoPrimaryOnlyProbation.blocked ? ['M1_DEMO_PRIMARY_ONLY_ROUTE_PROBATION'] : []),
          ...(demoBrokerCommissionGate.blocked
            ? [`M1_DEMO_BROKER_COMMISSION_${demoBrokerCommissionGate.reason}`]
            : []),
          ...(oppositePositionStateUnavailable ? ['M1_OPPOSITE_POSITION_STATE_UNAVAILABLE'] : []),
          ...(activeOppositePosition
            ? [
                confirmedDirectionFlip
                  ? 'M1_DIRECTION_FLIP_EXIT_PENDING'
                  : 'M1_ACTIVE_OPPOSITE_POSITION',
              ]
            : []),
        ])
      : unique([
          ...researchBlockers,
          ...(fastStopRegimeBrake?.active === true ? ['M1_FAST_STOP_REGIME_BRAKE'] : []),
        ]);

    // Commission research is evaluated only for already-blocked DEMO
    // candidates. It never delays a previously eligible order, changes the
    // derived canExecute flag or reopens a broker-risk veto.
    let historicalCommissionCostShadow: {
      m1: ReturnType<typeof evaluateM1CausalCommissionShadow>;
      planB: ReturnType<typeof evaluateM1CausalCommissionShadow> | null;
    } | null = null;
    if (professionalDemoPhase && !canExecute && routeDecision.route !== 'ABSTAIN') {
      const shadowFeeStartedAt = Date.now();
      let feeEvidence = feeEvidenceForDecision;
      let feeLookupFailed = brokerFeeLookupFailed;
      if (!selectedPrimaryForCommission || !commissionFloorEnabled) {
        try {
          feeEvidence = await this.evidence.loadPriorClosedCommissionRiskR({
            userId,
            brokerConnectionId,
            instrument: candidate.instrument,
            asOf: decisionTime,
          });
        } catch (error) {
          feeLookupFailed = true;
          this.logger.warn(
            `M1 commission shadow unavailable instrument=${candidate.instrument}: ${(error as Error).message}`,
          );
        }
      }
      const minimumNetR = Math.max(0.08, routeNetExpectedRFloor);
      historicalCommissionCostShadow = {
        m1: evaluateM1CausalCommissionShadow({
          observedAt: decisionTime,
          originalNetExpectedR: governance.genericGovernance.netExpectedR,
          spreadOnlyCostR: governance.genericGovernance.estimatedExecutionCostR,
          minimumRequiredNetR: minimumNetR,
          evidence: feeEvidence,
          lookupFailed: feeLookupFailed,
        }),
        planB: multimodelDemo
          ? evaluateM1CausalCommissionShadow({
              observedAt: decisionTime,
              originalNetExpectedR: multimodelDemo.governance.netExpectedR,
              spreadOnlyCostR: multimodelDemo.governance.estimatedExecutionCostR,
              minimumRequiredNetR: minimumNetR,
              evidence: feeEvidence,
              lookupFailed: feeLookupFailed,
            })
          : null,
      };
      timings.blockedFeeShadowMs = Date.now() - shadowFeeStartedAt;
    }

    // Observation on the connected DEMO engine; no admission, volume or execution modification.
    const zaiDemoDiagnostics = professionalDemoPhase
      ? {
          blockerAttribution: attributeZaiDemoBlockers(blockers),
          costGeometry: diagnoseZaiDemoCostGeometry({
            candidate,
            features,
            route: routeDecision.route,
            governance: governance.genericGovernance,
          }),
          historicalCommissionCostShadow,
          candidateConfidence: candidate.confidence,
          planBEnsembleScore: multimodelDemo?.ensemble.ensembleScore ?? null,
          trainedExpertConfidence: multimodelDemo?.trainedExpert.ensembleConfidence ?? null,
          executionAuthorityUnchanged: true as const,
        }
      : null;

    // Non-executable evidence for a common PAPER/DEMO/LIVE qualification
    // contract. Do NOT feed this research counterfactual into canExecute.
    const secondaryPredictedCostShadow = {
      artifact: 'secondary-route-cost-research-v1' as const,
      mode: 'SHADOW_ONLY' as const,
      modifiesExecution: false as const,
      m1Continuation: observeSecondaryPredictedCostFloor(
        governance.netExpectedR,
        M1_PROFESSIONAL_CONTINUATION_MIN_EXPECTED_R,
      ),
      m5Handoff: m5EarlyTransitionEvidence
        ? observeSecondaryPredictedCostFloor(m5EarlyTransitionEvidence.netExpectedR, 0.2)
        : null,
      highConvictionRescue: multimodelDemo
        ? observeSecondaryPredictedCostFloor(multimodelDemo.governance.netExpectedR, 0.2)
        : null,
    };
    // Research sidecar only. Neither candidate nor its later outcome feeds
    // canExecute, position sizing, model admission, or broker order dispatch.
    const lowVolRangeShadow = evaluateLowVolRangeShadow({
      features,
      direction: candidate.direction,
      evaluatedAt: decisionTime,
      eventRisk,
      spreadEvidenceValid: governance.genericGovernance.executionSpreadEvidenceValid,
      // Governance normalizes observed broker spread against the original
      // tactical stop. Rebase to this independent research stop geometry;
      // otherwise a short range stop would understate actual cost in R.
      observedExecutionCostR:
        Number.isFinite(governance.genericGovernance.estimatedExecutionCostR) &&
        Number.isFinite(candidate.stopDistance) &&
        candidate.stopDistance > 0 &&
        Number.isFinite(features.atr14) &&
        features.atr14 > 0
          ? (governance.genericGovernance.estimatedExecutionCostR * candidate.stopDistance) /
            (features.atr14 * LOW_VOL_RANGE_STOP_ATR)
          : null,
    });
    const productionQualificationShadow = multimodelDemo
      ? evaluateProductionQualificationShadow({
          candidateDirection: candidate.direction,
          planBAdmitted: multimodelDemo.ensemble.paperAdmitted,
          planBGovernanceEligible: multimodelDemo.governance.paperExecutionEligible,
          planBSpreadEvidenceValid: multimodelDemo.governance.executionSpreadEvidenceValid,
          m1RouteEligible: routeDecision.eligible,
          m1GovernanceEligible: governance.paperEligible,
          m1SpreadEvidenceValid: governance.genericGovernance.executionSpreadEvidenceValid,
          m1DriftState: governance.genericGovernance.driftState,
          trainedExpert: multimodelDemo.trainedExpert,
          planBForecastCostWouldReject:
            multimodelDemo.governance.predictedCostShadow?.paperWouldHaveBlocked ?? null,
          m1ForecastCostWouldReject:
            governance.genericGovernance.predictedCostShadow?.paperWouldHaveBlocked ?? null,
          commissionForecastWouldReject: commissionGateAudit.shadowWouldHaveBlocked,
        })
      : null;

    const persistStartedAt = Date.now();
    const decision = await this.evidence.recordDecision({
      userId,
      brokerConnectionId,
      instrument: candidate.instrument,
      direction: candidate.direction,
      route: routeDecision.route,
      barTime: candidate.latestM1OpenTime,
      evaluatedAt: decisionTime,
      policyVersion: candidate.policyVersion,
      executionAuthority: canExecute
        ? professionalDemoPhase
          ? 'BROKER_NATIVE'
          : 'PAPER_ONLY_RESEARCH'
        : 'NONE',
      candidate: { ...candidate },
      governance: {
        ...governance,
        // Strictly decision-time, broker-native computed features. The OOD
        // research learner must see the actual extension/RSI/volatility
        // magnitudes rather than only the binary HARD_HIGH/HARD_LOW labels.
        // Never consumed by the execution or promotion path.
        oodResearchFeatures: {
          version: 'm1-ood-asof-envelope-v1',
          extensionAtr: features.extensionAtr,
          volatilityScore: features.volatilityScore,
          emaSeparation: Math.max(0, Math.min(1, candidate.alignedEmaSeparationAtr / 2)),
          mtfStrength: Math.max(0, Math.min(1, candidate.alignedM15)),
          rsi14: features.rsi14,
          shortHorizonMomentumAtr: features.momentum1Atr,
        },
        routeDecision: { ...routeDecision },
        reliability: reliability ? { ...reliability } : null,
        shadowPairSideReliability: shadowPairSideReliability
          ? { artifact: scoutReliabilityArtifact, ...shadowPairSideReliability }
          : null,
        meaningfulScoutReliability:
          evidenceQualifiedScout && meaningfulScoutReliability
            ? { ...meaningfulScoutReliability }
            : null,
        provisionalScoutReliability:
          earlyTransitionTieredScout && provisionalScoutReliability
            ? { ...provisionalScoutReliability }
            : null,
        scoutReliabilityTier,
        executionVolumeCap,
        professionalM1Fallback,
        professionalM1FallbackExecutionEnabled: professionalM1FallbackExecutable,
        microDriftOnlyRescue,
        localImpulseDriftOnlyRescue,
        rolloutPolicyVersion: this.rolloutPolicy.version,
        rolloutPhase: this.rolloutPolicy.phase,
        routeNetExpectedRFloor,
        fastStopRegimeBrake: fastStopRegimeBrake ? { ...fastStopRegimeBrake } : null,
        portfolioNetLossBrake: portfolioNetLossBrake ? { ...portfolioNetLossBrake } : null,
        demoPrimaryOnlyProbation: { ...demoPrimaryOnlyProbation },
        demoBrokerCommissionGate: commissionGateAudit,
        productionQualificationShadow,
        secondaryPredictedCostShadow,
        lowVolRangeShadow,
        multimodelLossStreakBrake: multimodelLossStreakBrake
          ? { ...multimodelLossStreakBrake }
          : null,
        primaryEngineCode: professionalDemoPhase
          ? MULTIMODEL_DEMO_ENGINE_CODE
          : 'irexpro-m1-tactical',
        m1TacticalRole: professionalDemoPhase ? 'TIMING_SPECIALIST' : 'PRIMARY_RESEARCH_ROUTE',
        multimodelEnsemble: multimodelDemo?.ensemble ?? null,
        multimodelGovernance: multimodelDemo?.governance ?? null,
        multimodelTrainedExpert: multimodelDemo?.trainedExpert ?? null,
        multimodelAuthority: multimodelDemo?.authority ?? null,
        multimodelPortfolioSnapshotAvailable: multimodelDemo?.portfolioSnapshotAvailable ?? null,
        demoProfitabilityReliabilityGate,
        zaiDemoDiagnostics,
        directionFlipConflict: activeOppositePosition
          ? {
              candidateDirection: candidate.direction,
              oppositeTradeIds: activeOppositePositions.map((position) => position.tradeId),
              confirmedReversal: confirmedDirectionFlip,
              exitRequested: confirmedDirectionFlip && Boolean(this.executionService),
            }
          : null,
        oppositePositionStateUnavailable,
        m5EarlyTransitionEvidence: m5EarlyTransitionEvidence
          ? { ...m5EarlyTransitionEvidence }
          : null,
        m5EarlyTransitionHandoff: m5EarlyTransitionHandoff ? { ...m5EarlyTransitionHandoff } : null,
        extensionExhaustionDemoScout: extensionExhaustionDemoScout
          ? { ...extensionExhaustionDemoScout }
          : null,
        shadowOutcomeEligible,
      },
      blockers,
    });
    timings.persistMs = Date.now() - persistStartedAt;

    const executionAlreadyDurable =
      Boolean(decision.tradeIntentId) || decision.outcomeState === 'EXECUTION_SUCCEEDED';

    if (canExecute && !executionAlreadyDurable) {
      await this.submitPaperDecision(
        decision.id,
        userId,
        brokerConnectionId,
        candidate,
        routeDecision,
        governance,
        reliability,
        features,
        decisionTime,
        shadowPairSideReliability,
        microDriftOnlyRescue,
        localImpulseDriftOnlyRescue,
        evidenceQualifiedScout,
        scoutReliabilityTier,
        executionVolumeCap,
        multimodelDemo,
        professionalM1Fallback,
        m5EarlyTransitionEvidence,
        m5EarlyTransitionHandoff,
        extensionExhaustionDemoScout,
      );
    }

    const totalMs = Math.max(0, Date.now() - startedCandidateAt);
    if (totalMs >= 5_000) {
      const attributedMs = Object.values(timings).reduce((sum, ms) => sum + ms, 0);
      // No account IDs, price/feature vectors or credentials. In particular,
      // this logger never changes model decisions or broker authorization.
      this.logger.warn(
        'M1 candidate phase latency instrument=' +
          candidate.instrument +
          ' direction=' +
          candidate.direction +
          ' slot=' +
          decisionTime.toISOString() +
          ' totalMs=' +
          totalMs +
          ' reliabilityMs=' +
          timings.reliabilityMs +
          ' scoutMs=' +
          timings.scoutMs +
          ' multimodelMs=' +
          timings.multimodelMs +
          ' executableFeeMs=' +
          timings.executableFeeMs +
          ' blockedFeeShadowMs=' +
          timings.blockedFeeShadowMs +
          ' persistMs=' +
          timings.persistMs +
          ' otherMs=' +
          Math.max(0, totalMs - attributedMs) +
          ' authority=OBSERVATION_ONLY',
      );
    }
  }

  private async resolveM1CurrencyExposureGuard(
    userId: string,
    brokerConnectionId: string,
    candidate: M1TacticalCandidate,
    requestedVolumeCap: number,
  ): Promise<{
    allowed: boolean;
    volumeCap: number;
    decision: M1CurrencyExposureDecision;
    productFloorBlocked: boolean;
  }> {
    const unavailable = evaluateM1TacticalCurrencyExposure({
      allocatedCapital: 0,
      positions: [],
      candidate: {
        instrument: candidate.instrument,
        direction: candidate.direction,
        riskAtStop: 0,
      },
    });
    if (!this.allocationService) {
      return { allowed: false, volumeCap: 0, decision: unavailable, productFloorBlocked: false };
    }

    let allocatedCapital = 0;
    try {
      const allocation = await this.allocationService.getUserCapitalAllocationState(
        userId,
        brokerConnectionId,
      );
      if (allocation.hasAllocation && allocation.allocatedCapital) {
        allocatedCapital = Number(allocation.allocatedCapital);
      }
    } catch {
      return { allowed: false, volumeCap: 0, decision: unavailable, productFloorBlocked: false };
    }

    let positions;
    try {
      positions = await this.evidence.loadOpenPaperRiskPositions({ userId, brokerConnectionId });
    } catch {
      const decision = evaluateM1TacticalCurrencyExposure({
        allocatedCapital,
        positions: [
          { instrument: candidate.instrument, direction: candidate.direction, riskAtStop: null },
        ],
        candidate: {
          instrument: candidate.instrument,
          direction: candidate.direction,
          riskAtStop: 0,
        },
      });
      return { allowed: false, volumeCap: 0, decision, productFloorBlocked: false };
    }

    return findLargestClearM1Volume({
      allocatedCapital,
      positions,
      candidate: {
        instrument: candidate.instrument,
        direction: candidate.direction,
        entryPrice: candidate.entry,
        stopLoss: candidate.stopLoss,
      },
      requestedVolumeCap,
      // Screening floor only, not permission to execute a 0.001-lot trade.
      productFloor: Number(PAPER_BROKER_AWARE_EXPOSURE_SEARCH_FLOOR),
      // This is a pre-screen, NOT executable broker sizing. Broker spec,
      // leverage, margin, risk-at-stop and all model evidence remain enforced
      // later. 0.001 search precision permits genuinely supported micro lots.
      volumeStep: 0.001,
    });
  }

  private async submitPaperDecision(
    decisionId: string,
    userId: string,
    brokerConnectionId: string,
    candidate: M1TacticalCandidate,
    routeDecision: M1TacticalRouteDecision,
    governance: ReturnType<typeof evaluateM1TacticalGovernance>,
    routeReliability: ReturnType<typeof evaluateM1RoutePairSideReliability> | null,
    features: NonNullable<ReturnType<typeof buildM1TacticalFeatures>>,
    decisionTime: Date,
    shadowPairSideReliability: M1ScoutPairSideReliabilityDecision | null,
    microDriftOnlyRescue: boolean,
    localImpulseDriftOnlyRescue: boolean,
    evidenceQualifiedScout: boolean,
    scoutReliabilityTier: 'NONE' | 'MICRO' | 'PROVISIONAL' | 'MATURE',
    executionVolumeCap: number,
    multimodelDemo: MultimodelDemoEvaluation | null = null,
    professionalM1Fallback: M1ProfessionalFallbackDecision | null = null,
    m5EarlyTransitionEvidence: M5EarlyTransitionEvidence | null = null,
    m5EarlyTransitionHandoff: M5EarlyTransitionHandoffDecision | null = null,
    extensionExhaustionDemoScout: ExtensionExhaustionDemoScoutDecision | null = null,
  ): Promise<void> {
    const session = this.executionService
      ? await this.executionService.getActiveSession(userId)
      : null;
    const professionalDemoPhase = this.rolloutPolicy.phase === 'DEMO_EARLY_TRANSITION_PROFESSIONAL';
    if (!session && professionalDemoPhase && this.executionService) {
      const currentSession = await this.executionService.getActiveSessionForClient(userId);
      if (
        currentSession?.status === TradingSessionStatus.SUSPENDED_RISK_LIMIT &&
        currentSession.executionMode === ExecutionMode.FULL_AUTO &&
        currentSession.brokerConnectionId === brokerConnectionId
      ) {
        await this.evidence.markOutcomeState(
          decisionId,
          'RISK_REJECTED',
          new Date(),
          'M1 V8 execution blocked because the exact FULL_AUTO DEMO session is SUSPENDED_RISK_LIMIT',
        );
        return;
      }
    }
    const useM5EarlyTransitionHandoff =
      professionalDemoPhase &&
      m5EarlyTransitionHandoff?.eligible === true &&
      m5EarlyTransitionEvidence !== null;
    const useProfessionalM1Fallback =
      professionalDemoPhase &&
      !useM5EarlyTransitionHandoff &&
      professionalM1FallbackExecutionEnabled(professionalM1Fallback);
    const useExtensionExhaustionDemoScout =
      professionalDemoPhase &&
      !useM5EarlyTransitionHandoff &&
      !useProfessionalM1Fallback &&
      extensionExhaustionDemoScout?.eligible === true;
    const requiredExecutionMode = professionalDemoPhase
      ? ExecutionMode.FULL_AUTO
      : ExecutionMode.PAPER_ONLY;
    if (
      !session ||
      session.executionMode !== requiredExecutionMode ||
      session.brokerConnectionId !== brokerConnectionId
    ) {
      await this.evidence.markOutcomeState(
        decisionId,
        'SESSION_INACTIVE',
        new Date(),
        professionalDemoPhase
          ? 'M1 V8 requires the exact active FULL_AUTO DEMO session bound to this broker connection'
          : 'M1 requires the exact active PAPER session bound to this broker connection',
      );
      return;
    }

    const currencyExposureGuard = await this.resolveM1CurrencyExposureGuard(
      userId,
      brokerConnectionId,
      candidate,
      executionVolumeCap,
    );
    if (!currencyExposureGuard.allowed) {
      const reason = currencyExposureGuard.productFloorBlocked
        ? `M1_CURRENCY_EXPOSURE_PRODUCT_FLOOR_BLOCKED requestedCap=${executionVolumeCap} ` +
          `productFloor=${PAPER_BROKER_AWARE_EXPOSURE_SEARCH_FLOOR} capacity=${currencyExposureGuard.decision.capacity} ` +
          `alignedRiskPercent=${currencyExposureGuard.decision.projectedAlignedRiskPercent}`
        : `M1_CURRENCY_EXPOSURE_BLOCKED capacity=${currencyExposureGuard.decision.capacity} ` +
          `alignedRiskPercent=${currencyExposureGuard.decision.projectedAlignedRiskPercent}`;
      this.logger.warn(
        `M1 tactical ${candidate.instrument} ${candidate.direction} execution=BLOCKED ${reason}`,
      );
      await this.evidence.markOutcomeState(decisionId, 'RISK_REJECTED', new Date(), reason);
      return;
    }
    const finalExecutionVolumeCap = currencyExposureGuard.volumeCap;

    const scoutReliabilityArtifact = shadowPairSideReliability
      ? 'artifact' in shadowPairSideReliability
        ? shadowPairSideReliability.artifact
        : M1_SHADOW_MICRO_RELIABILITY_ARTIFACT
      : null;
    const meaningfulScoutReliability =
      shadowPairSideReliability &&
      'artifact' in shadowPairSideReliability &&
      shadowPairSideReliability.artifact === M1_MEANINGFUL_SCOUT_RELIABILITY_ARTIFACT
        ? shadowPairSideReliability
        : null;
    const provisionalScoutReliability =
      shadowPairSideReliability &&
      'artifact' in shadowPairSideReliability &&
      shadowPairSideReliability.artifact === M1_PROVISIONAL_SCOUT_RELIABILITY_ARTIFACT
        ? shadowPairSideReliability
        : null;

    const signalIdentity = [
      userId,
      brokerConnectionId,
      candidate.instrument,
      candidate.direction,
      routeDecision.route,
      candidate.latestM1OpenTime.toISOString(),
      candidate.policyVersion,
    ].join('|');
    const signalId = uuidv5(signalIdentity, M1_SIGNAL_NAMESPACE);
    await this.evidence.markExecutionLink(decisionId, signalId, undefined);

    try {
      const result = await this.aiSignalService.receiveSignal({
        signalId,
        userId,
        tradingSessionId: session.id,
        brokerConnectionId,
        instrument: candidate.instrument,
        direction: candidate.direction,
        confidenceScore: useM5EarlyTransitionHandoff
          ? m5EarlyTransitionEvidence.ensembleScore
          : professionalDemoPhase && multimodelDemo && !useProfessionalM1Fallback
            ? multimodelDemoSignalConfidence(
                {
                  ensemble: multimodelDemo.ensemble,
                  trainedExpert: multimodelDemo.trainedExpert,
                },
                multimodelDemo.authority,
              )
            : candidate.confidence,
        suggestedEntryPrice: candidate.entry,
        suggestedStopLoss: candidate.stopLoss,
        suggestedTakeProfit: candidate.takeProfit,
        suggestedVolume: finalExecutionVolumeCap,
        timeframe: 'M1',
        strategyCode:
          professionalDemoPhase && !useProfessionalM1Fallback
            ? 'external-irexpro-multimodel-ensemble'
            : 'external-irexpro-m1-tactical',
        marketRegime: useM5EarlyTransitionHandoff
          ? 'TRANSITION'
          : professionalDemoPhase && multimodelDemo && !useProfessionalM1Fallback
            ? multimodelDemo.ensemble.strategyRoute === 'TREND_CONTINUATION'
              ? 'TREND_HEALTHY'
              : multimodelDemo.ensemble.strategyRoute === 'CONFIRMED_REVERSAL'
                ? 'REVERSAL'
                : 'TRANSITION'
            : m1RiskMarketRegime(routeDecision.route),
        volatilityScore: features.volatilityScore,
        generatedAt: new Date(decisionTime),
        modelVersion:
          professionalDemoPhase && !useProfessionalM1Fallback
            ? `external-provider/${MULTIMODEL_DEMO_ENGINE_CODE}/demo-v1`
            : `external-provider/irexpro-m1-tactical/${candidate.policyVersion}`,
        metadata: {
          signal_source: 'EXTERNAL_PROVIDER',
          external_provider_code:
            professionalDemoPhase && !useProfessionalM1Fallback
              ? MULTIMODEL_DEMO_ENGINE_CODE
              : 'irexpro-m1-tactical',
          primary_engine_code:
            professionalDemoPhase && !useProfessionalM1Fallback
              ? MULTIMODEL_DEMO_ENGINE_CODE
              : 'irexpro-m1-tactical',
          m1_tactical_role: useProfessionalM1Fallback
            ? 'PRIMARY_FALLBACK'
            : professionalDemoPhase
              ? 'TIMING_SPECIALIST'
              : 'PRIMARY_RESEARCH_ROUTE',
          m1_professional_fallback: useProfessionalM1Fallback,
          m1_professional_fallback_tier: professionalM1Fallback?.tier ?? null,
          m1_professional_fallback_reason: professionalM1Fallback?.reason ?? null,
          m1_professional_fallback_lot_cap:
            professionalM1Fallback?.eligible === true ? professionalM1Fallback.lotCap : null,
          multimodel_plan_b_score: useM5EarlyTransitionHandoff
            ? m5EarlyTransitionEvidence.ensembleScore
            : (multimodelDemo?.ensemble.ensembleScore ?? null),
          multimodel_plan_b_route: useM5EarlyTransitionHandoff
            ? m5EarlyTransitionEvidence.strategyRoute
            : (multimodelDemo?.ensemble.strategyRoute ?? null),
          multimodel_plan_b_expected_r: useM5EarlyTransitionHandoff
            ? m5EarlyTransitionEvidence.netExpectedR
            : (multimodelDemo?.ensemble.expectedR ?? null),
          multimodel_plan_b_paper_admitted: useM5EarlyTransitionHandoff
            ? m5EarlyTransitionEvidence.paperAdmitted
            : (multimodelDemo?.ensemble.paperAdmitted ?? null),
          multimodel_governance_net_expected_r: multimodelDemo?.governance.netExpectedR ?? null,
          multimodel_trained_expert_state: multimodelDemo?.trainedExpert.state ?? null,
          multimodel_trained_expert_direction: multimodelDemo?.trainedExpert.direction ?? null,
          multimodel_trained_expert_confidence:
            multimodelDemo?.trainedExpert.ensembleConfidence ?? null,
          multimodel_trained_expert_opportunity_probability:
            multimodelDemo?.trainedExpert.meanOpportunityProbability ?? null,
          multimodel_trained_expert_long_votes: multimodelDemo?.trainedExpert.longVotes ?? null,
          multimodel_trained_expert_short_votes: multimodelDemo?.trainedExpert.shortVotes ?? null,
          multimodel_execution_authority: professionalDemoPhase
            ? useProfessionalM1Fallback
              ? 'M1_PROFESSIONAL_FALLBACK'
              : 'DEMO_FULL_AUTO_PROMOTED'
            : null,
          multimodel_execution_authority_path: useProfessionalM1Fallback
            ? professionalM1Fallback?.tier
            : useM5EarlyTransitionHandoff
              ? 'M5_EARLY_TRANSITION_HANDOFF'
              : useExtensionExhaustionDemoScout
                ? 'EXTENSION_EXHAUSTION_DEMO_SCOUT'
                : (multimodelDemo?.authority.authorityPath ?? null),
          m5_early_transition_handoff: useM5EarlyTransitionHandoff,
          m5_early_transition_handoff_reason: useM5EarlyTransitionHandoff
            ? m5EarlyTransitionHandoff.reason
            : null,
          m5_early_transition_lot_cap: useM5EarlyTransitionHandoff
            ? m5EarlyTransitionHandoff.lotCap
            : null,
          m5_early_transition_net_expected_r: useM5EarlyTransitionHandoff
            ? m5EarlyTransitionEvidence.netExpectedR
            : null,
          m5_early_transition_ensemble_score: useM5EarlyTransitionHandoff
            ? m5EarlyTransitionEvidence.ensembleScore
            : null,
          m5_early_transition_market_bar_time: useM5EarlyTransitionHandoff
            ? m5EarlyTransitionEvidence.marketBarTime.toISOString()
            : null,
          extension_exhaustion_demo_scout: useExtensionExhaustionDemoScout,
          extension_exhaustion_demo_scout_artifact: extensionExhaustionDemoScout?.artifact ?? null,
          extension_exhaustion_demo_scout_reason: extensionExhaustionDemoScout?.reason ?? null,
          extension_exhaustion_demo_scout_lot_cap: useExtensionExhaustionDemoScout
            ? extensionExhaustionDemoScout!.lotCap
            : null,
          extension_exhaustion_demo_scout_samples:
            extensionExhaustionDemoScout?.reliability?.samples ?? 0,
          extension_exhaustion_demo_scout_average_r:
            extensionExhaustionDemoScout?.reliability?.averageNetR ?? null,
          extension_exhaustion_demo_scout_profit_factor:
            extensionExhaustionDemoScout?.reliability?.profitFactor ?? null,
          extension_exhaustion_demo_scout_recent3_r:
            extensionExhaustionDemoScout?.reliability?.recent3R ?? null,
          multimodel_rescue_volume_cap: multimodelDemo?.authority.rescueVolumeCap ?? null,
          external_provider_paper_only: true,
          production_eligible: false,
          m1_route_reliability_reason: routeReliability?.reason ?? null,
          ...(routeReliability?.reason === 'PROFIT_GIVEBACK_CAUTION'
            ? {
                // First verified winner→loser giveback is a soft brake, not an
                // overfit hard veto. The authoritative position sizer applies
                // this 0.5x multiplier to the risk budget; a repeated recent
                // giveback is blocked earlier by PROFIT_GIVEBACK_LOSS_STREAK.
                adaptive_risk_multiplier: 0.5,
              }
            : {}),
          // Immutable entry snapshot consumed by the v8.5 post-entry learner.
          // Keep the same feature scale used by the historical Plan-B/v7
          // training stream: candidate score + direction-aligned EMA/MTF
          // strength, raw RSI, extension and volatility.
          feature_candidate_score: candidate.score,
          feature_extension_atr: features.extensionAtr,
          feature_volatility_score: features.volatilityScore,
          feature_ema_separation: Math.max(0, Math.min(1, candidate.alignedEmaSeparationAtr / 2)),
          feature_mtf_strength: Math.max(0, Math.min(1, candidate.alignedM15)),
          feature_rsi14: features.rsi14,
          position_sizing_tier:
            this.rolloutPolicy.phase === 'DEMO_EARLY_TRANSITION_PROFESSIONAL'
              ? m1ProfessionalSizingTier(candidate.confidence)
              : 'RESEARCH',
          m1_tactical_route: routeDecision.route,
          m1_policy_version: candidate.policyVersion,
          m1_rollout_policy_version: this.rolloutPolicy.version,
          m1_rollout_phase: this.rolloutPolicy.phase,
          m1_shadow_pair_side_reliability_artifact: scoutReliabilityArtifact,
          m1_shadow_pair_side_reliability_reason: shadowPairSideReliability?.reason ?? null,
          m1_shadow_pair_side_reliability_samples: shadowPairSideReliability?.samples ?? 0,
          m1_shadow_pair_side_reliability_average_r: shadowPairSideReliability?.averageNetR ?? null,
          m1_shadow_pair_side_reliability_profit_factor:
            shadowPairSideReliability?.profitFactor ?? null,
          m1_shadow_pair_side_reliability_positive_fraction:
            shadowPairSideReliability?.positiveFraction ?? null,
          m1_evidence_qualified_scout_eligible:
            evidenceQualifiedScout && shadowPairSideReliability?.eligible === true,
          m1_scout_reliability_tier: scoutReliabilityTier,
          m1_scout_broker_native_reliability_samples:
            shadowPairSideReliability?.brokerNativeSampleCount ?? 0,
          m1_scout_bootstrap_reliability_samples:
            shadowPairSideReliability?.bootstrapSampleCount ?? 0,
          m1_scout_evidence_connection_ids: shadowPairSideReliability?.evidenceConnectionIds ?? [
            brokerConnectionId,
          ],
          m1_scout_requested_volume_cap: executionVolumeCap,
          m1_scout_execution_volume_cap: finalExecutionVolumeCap,
          m1_currency_exposure_capacity: currencyExposureGuard.decision.capacity,
          m1_currency_exposure_reason: currencyExposureGuard.decision.reason,
          m1_currency_exposure_projected_aligned_risk:
            currencyExposureGuard.decision.projectedAlignedRisk,
          m1_currency_exposure_projected_aligned_risk_percent:
            currencyExposureGuard.decision.projectedAlignedRiskPercent,
          m1_currency_exposure_allocated_capital: currencyExposureGuard.decision.allocatedCapital,
          m1_meaningful_scout_reliability_artifact: meaningfulScoutReliability
            ? M1_MEANINGFUL_SCOUT_RELIABILITY_ARTIFACT
            : null,
          m1_meaningful_scout_reliability_samples: meaningfulScoutReliability?.samples ?? 0,
          m1_meaningful_scout_reliability_recent_net_r:
            meaningfulScoutReliability?.recentNetR ?? null,
          m1_provisional_scout_reliability_artifact: provisionalScoutReliability
            ? M1_PROVISIONAL_SCOUT_RELIABILITY_ARTIFACT
            : null,
          m1_provisional_scout_reliability_samples: provisionalScoutReliability?.samples ?? 0,
          m1_provisional_scout_reliability_recent_net_r:
            provisionalScoutReliability?.recentNetR ?? null,
          m1_micro_drift_only_rescue: microDriftOnlyRescue,
          m1_local_impulse_drift_only_rescue: localImpulseDriftOnlyRescue,
          m1_decision_id: decisionId,
          m1_target_r_geometry: candidate.grossExpectedR,
          m1_expectancy_artifact: governance.expectancy.artifact,
          m1_expectancy_source: governance.expectancy.source,
          m1_heuristic_prior_expected_r: governance.expectancy.heuristicPriorExpectedR,
          m1_statistical_expected_r: governance.expectancy.statisticalExpectedR,
          m1_expectancy_implied_win_probability: governance.expectancy.impliedWinProbability,
          m1_expectancy_evidence_samples: governance.expectancy.evidenceSamples,
          m1_expectancy_evidence_average_realized_r: governance.expectancy.evidenceAverageRealizedR,
          m1_expectancy_recent_payoff_average_r: governance.expectancy.recentPayoffAverageR,
          m1_gross_expected_r: candidate.grossExpectedR,
          m1_execution_cost_r: governance.genericGovernance.estimatedExecutionCostR,
          m1_execution_cost_source: governance.genericGovernance.executionCostSource,
          m1_net_expected_r: governance.netExpectedR,
          m1_route_net_expected_r_floor:
            this.rolloutPolicy.routeNetExpectedRFloors[
              routeDecision.route as Exclude<M1TacticalRoute, 'ABSTAIN'>
            ],
          m1_execution_authority: professionalDemoPhase
            ? useProfessionalM1Fallback
              ? 'DEMO_FULL_AUTO_M1_FALLBACK'
              : useExtensionExhaustionDemoScout
                ? 'DEMO_EXTENSION_EXHAUSTION_SCOUT'
                : 'DEMO_FULL_AUTO_PROMOTED'
            : 'PAPER_ONLY_RESEARCH',
        },
      });
      if (this.tradeIntentService) {
        try {
          const intent = await this.tradeIntentService.findBySignal(userId, signalId);
          if (intent?.id) {
            await this.evidence.markExecutionLink(decisionId, signalId, intent.id);
          }
        } catch (error) {
          this.logger.warn(
            `M1 decision ${decisionId} trade-intent audit linkage deferred: ${(error as Error).message}`,
          );
        }
      }
      await this.evidence.markOutcomeState(decisionId, result.outcome, new Date(), result.reason);
    } catch (error) {
      await this.evidence.markOutcomeState(
        decisionId,
        'EXECUTION_FAILED',
        new Date(),
        (error as Error).message,
      );
      throw error;
    }
  }

  async observeOpenPositionRescueShadow(
    input: M1OpenPositionRescueShadowInput,
  ): Promise<M1FailedMoveRescueDecision | null> {
    const instrument = input.instrument.trim().toUpperCase();
    const positions = await this.evidence.loadOpenPaperPositions({
      userId: input.userId,
      brokerConnectionId: input.brokerConnectionId,
      instrument,
    });
    const open = positions.find(
      (position) =>
        position.instrument === instrument && position.direction === input.originalDirection,
    );
    if (!open) return null;

    const duplicateOppositeIntent = await this.evidence.hasActiveOppositeM1Intent({
      userId: input.userId,
      brokerConnectionId: input.brokerConnectionId,
      instrument,
      direction: input.oppositeDirection,
    });
    const reversalAllowedByPolicy =
      this.rolloutPolicy.phase === 'PAPER_ALL_ROUTES' &&
      m1RouteExecutableInPhase(this.rolloutPolicy.phase, 'M1_CONFIRMED_REVERSAL');

    return this.recordFailedMoveRescueShadow(
      input.decisionId,
      {
        originalInvalidated: input.originalInvalidated,
        originalNetExpectedR: input.originalNetExpectedR,
        oppositeNetExpectedR: input.oppositeNetExpectedR,
        oppositeGovernanceEligible: input.oppositeGovernanceEligible,
        oppositeBlockers: input.oppositeBlockers,
        duplicateOppositeIntent,
        reversalAllowedByPolicy,
      },
      { openTradeId: open.tradeId, openDecisionId: open.decisionId },
      input.observedAt ?? new Date(),
    );
  }

  async recordFailedMoveRescueShadow(
    decisionId: string,
    input: M1FailedMoveRescueInput,
    linkage: { openTradeId: string; openDecisionId: string },
    observedAt = new Date(),
  ): Promise<M1FailedMoveRescueDecision> {
    const rescue = evaluateM1FailedMoveRescue(input);
    await this.evidence.markRescueObservation(decisionId, {
      openTradeId: linkage.openTradeId,
      openDecisionId: linkage.openDecisionId,
      observedAt,
      rescue,
    });
    return rescue;
  }

  private async shadowPairSideReliabilityFor(
    userId: string,
    brokerConnectionId: string,
    candidate: M1TacticalCandidate,
    routeDecision: M1TacticalRouteDecision,
    evaluatedAt: Date,
  ): Promise<M1ScoutPairSideReliabilityDecision | null> {
    const earlyTransitionScoutPhase =
      this.rolloutPolicy.phase === 'PAPER_EARLY_TRANSITION_MICRO' ||
      this.rolloutPolicy.phase === 'PAPER_EARLY_TRANSITION_SCOUT_010' ||
      this.rolloutPolicy.phase === 'PAPER_EARLY_TRANSITION_SCOUT_TIERED' ||
      this.rolloutPolicy.phase === 'DEMO_EARLY_TRANSITION_PROFESSIONAL';
    if (
      !earlyTransitionScoutPhase ||
      !routeDecision.eligible ||
      routeDecision.route !== 'M1_EARLY_TRANSITION'
    ) {
      return null;
    }

    const brokerNativeOutcomes = await this.evidence.loadShadowPairSideOutcomes({
      userId,
      brokerConnectionId,
      route: 'M1_EARLY_TRANSITION',
      instrument: candidate.instrument,
      direction: candidate.direction,
      policyVersion: candidate.policyVersion,
      evaluatedAt,
    });
    let outcomes = brokerNativeOutcomes;
    let bootstrapSampleCount = 0;
    const evidenceConnectionIds = [brokerConnectionId];

    if (
      this.rolloutPolicy.phase === 'DEMO_EARLY_TRANSITION_PROFESSIONAL' &&
      brokerNativeOutcomes.length < M1_PROVISIONAL_SCOUT_MIN_SAMPLES
    ) {
      const fallbackConnectionId = this.config
        .get<string>('vpsForexScanner.brokerConnectionId', '')
        .trim();
      if (fallbackConnectionId && fallbackConnectionId !== brokerConnectionId) {
        try {
          const fallbackOutcomes = await this.evidence.loadShadowPairSideOutcomes({
            userId,
            brokerConnectionId: fallbackConnectionId,
            route: 'M1_EARLY_TRANSITION',
            instrument: candidate.instrument,
            direction: candidate.direction,
            policyVersion: candidate.policyVersion,
            evaluatedAt,
          });
          const needed = Math.max(
            0,
            M1_PROVISIONAL_SCOUT_MIN_SAMPLES - brokerNativeOutcomes.length,
          );
          const bootstrapOutcomes = fallbackOutcomes.slice(0, needed);
          if (bootstrapOutcomes.length > 0) {
            outcomes = [...brokerNativeOutcomes, ...bootstrapOutcomes];
            bootstrapSampleCount = bootstrapOutcomes.length;
            evidenceConnectionIds.push(fallbackConnectionId);
          }
        } catch (error) {
          this.logger.warn(
            `M1 V8 reliability bootstrap deferred ${candidate.instrument} ${candidate.direction}: ${(error as Error).message}`,
          );
        }
      }
    }

    const provenance = {
      brokerNativeSampleCount: brokerNativeOutcomes.length,
      bootstrapSampleCount,
      evidenceConnectionIds,
    };
    if (this.rolloutPolicy.phase === 'PAPER_EARLY_TRANSITION_SCOUT_010') {
      return {
        ...evaluateM1MeaningfulScoutReliability({
          route: 'M1_EARLY_TRANSITION',
          evaluatedAt,
          outcomes,
        }),
        ...provenance,
      };
    }
    if (
      this.rolloutPolicy.phase === 'PAPER_EARLY_TRANSITION_SCOUT_TIERED' ||
      this.rolloutPolicy.phase === 'DEMO_EARLY_TRANSITION_PROFESSIONAL'
    ) {
      const meaningful = evaluateM1MeaningfulScoutReliability({
        route: 'M1_EARLY_TRANSITION',
        evaluatedAt,
        outcomes,
      });
      if (meaningful.samples >= M1_MEANINGFUL_SCOUT_MIN_SAMPLES) {
        return { ...meaningful, ...provenance };
      }
      return {
        ...evaluateM1ProvisionalScoutReliability({
          route: 'M1_EARLY_TRANSITION',
          evaluatedAt,
          outcomes,
        }),
        ...provenance,
      };
    }
    return {
      ...evaluateM1ShadowPairSideReliability({
        route: 'M1_EARLY_TRANSITION',
        evaluatedAt,
        outcomes,
      }),
      ...provenance,
    };
  }

  private async reliabilityFor(
    userId: string,
    brokerConnectionId: string,
    candidate: M1TacticalCandidate,
    routeDecision: M1TacticalRouteDecision,
    evaluatedAt: Date,
  ) {
    if (!routeDecision.eligible || routeDecision.route === 'ABSTAIN') return null;
    const route = routeDecision.route as M1ReliabilityRoute;
    const evidenceRows = await this.evidence.loadRoutePairSideEvidence({
      userId,
      brokerConnectionId,
      route,
      instrument: candidate.instrument,
      direction: candidate.direction,
      currentPolicyVersion: candidate.policyVersion,
      compatiblePolicyVersions: [candidate.policyVersion],
      evaluatedAt,
    });
    return evaluateM1RoutePairSideReliability({
      route,
      instrument: candidate.instrument,
      direction: candidate.direction,
      currentPolicyVersion: candidate.policyVersion,
      evaluatedAt,
      evidenceRows,
    });
  }

  private enabled(): boolean {
    return (
      this.config.get<boolean>('vpsForexScanner.enabled', false) === true &&
      Boolean(this.userId()) &&
      Boolean(this.connectionId())
    );
  }

  private userId(): string {
    return this.config.get<string>('vpsForexScanner.userId', '').trim();
  }

  private connectionId(): string {
    if (this.rolloutPolicy.phase === 'DEMO_EARLY_TRANSITION_PROFESSIONAL') {
      return this.config.get<string>('vpsForexScanner.m1MarketDataConnectionId', '').trim();
    }
    return this.config.get<string>('vpsForexScanner.brokerConnectionId', '').trim();
  }
}
