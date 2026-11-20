import {
  DEMO_FOCUSED_ENTRY_INSTRUMENTS_V1,
  DEMO_SIX_PAIR_ENTRY_INSTRUMENTS_V2,
  DEMO_FOCUSED_ENTRY_INSTRUMENTS_V3,
  DEMO_FOCUSED_ENTRY_INSTRUMENTS_V4,
} from './demo-focused-instruments';
import { orderM1DemoSixPairScan } from './m1-demo-six-pair-scan-order';
export {
  DEMO_FOCUSED_ENTRY_INSTRUMENTS_V1,
  DEMO_SIX_PAIR_ENTRY_INSTRUMENTS_V2,
  DEMO_FOCUSED_ENTRY_INSTRUMENTS_V3,
  DEMO_FOCUSED_ENTRY_INSTRUMENTS_V4,
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
import { AiSignalService } from './ai-signal.service';
import { MacroEventRiskService } from './macro-event-risk.service';
import { DemoPortfolioBrakeConsentService } from './demo-portfolio-brake-consent.service';
import { DemoStrategyBrakeOwnerService } from './demo-strategy-brake-owner.service';
import {
  M1_SHADOW_OUTCOME_15M_ARTIFACT,
  M1TacticalEvidenceService,
  type M1ShadowOutcome15mV1,
} from './m1-tactical-evidence.service';
import {
  M1TacticalMarketDataService,
  type M1TacticalMarketSnapshot,
  type M1TacticalMarketReadiness,
} from './m1-tactical-market-data.service';
import {
  buildM1TacticalCandidates,
  M1_TACTICAL_POLICY_V2,
  type M1TacticalCandidate,
} from './m1-tactical-candidate';
import { buildM1TacticalFeatures, type M1TacticalFeatureSnapshot } from './m1-tactical-features';
import { evaluatePepperstoneDemoAdvisoryQuality } from './pepperstone-demo-advisory-quality-risk';
import { evaluatePepperstoneDemoM5ReversalSoftCap } from './pepperstone-demo-m5-reversal-soft-cap';
import { evaluateOwnerDemoWeakReversalCap } from './owner-demo-weak-reversal-exposure-ceiling';
import { evaluateOwnerDemoPreDispatchConfluence } from './owner-demo-predispatch-fee-confluence-shadow';
import { evaluatePepperstoneDemoHighConvictionCeiling } from './pepperstone-demo-high-conviction-lot-ceiling';
import {
  recallPepperstoneDemoPattern,
  type PatternMemoryObservation,
} from './pepperstone-demo-pattern-memory';
import {
  classifyM1TacticalRoute,
  type M1TacticalRoute,
  type M1TacticalRouteDecision,
} from './m1-tactical-route';
import { evaluateM1TacticalGovernance } from './m1-tactical-governance';
import {
  evaluateM5EarlyTransitionHandoff,
  m1MayConfirmM5EarlyTransition,
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
  evaluateConfirmedReversalCrossSleeveCanary,
  CONFIRMED_REVERSAL_CROSS_SLEEVE_CANARY_LOT_CAP,
} from './confirmed-reversal-cross-sleeve-canary';
import {
  scorePlanBMultimodelShadow,
  type PlanBEnsembleScore,
  type PlanBPortfolioPosition,
} from './plan-b-multimodel-shadow';
import { scorePlanBClockNeutralResearch } from './v8-shadow-meta-scorer';
import { scoreOwnerDemoEntryOutcome } from './owner-demo-entry-outcome-shadow';
import { evaluatePepperstonePairSideAsOfShadow } from './pepperstone-pair-side-asof-shadow';
import {
  evaluatePepperstoneDemoContinuationPause,
  PEPPERSTONE_DEMO_CONTINUATION_PAUSE_BLOCKER,
} from './pepperstone-demo-continuation-pause';
import {
  evaluateDemoAlternativeTrial,
  DEMO_ALTERNATIVE_TRIAL_ENTRY_LIMIT,
  DEMO_ALTERNATIVE_TRIAL_END,
  type DemoAlternativeTrialDecision,
} from './pepperstone-demo-alternative-trial';
import {
  evaluateCounterPilot,
  COUNTER_PILOT_ARTIFACT,
  COUNTER_PILOT_START,
  COUNTER_PILOT_END,
  COUNTER_PILOT_ENTRY_LIMIT,
  COUNTER_PILOT_LOT_CAP,
  type CounterPilotDecision,
} from './pepperstone-demo-counter-pilot';
import {
  evaluateAdvisoryAlternateTrial,
  ADVISORY_ALTERNATE_ARTIFACT,
  ADVISORY_ALTERNATE_START,
  ADVISORY_ALTERNATE_END,
  ADVISORY_ALTERNATE_ENTRY_LIMIT,
  type AdvisoryAlternateTrialDecision,
} from './pepperstone-demo-advisory-alternate-trial';
import { HighConvictionBrokerExpertService } from './high-conviction-broker-expert.service';
import {
  ownerPepperstoneDemoNoonLotTrial,
  OWNER_DEMO_NOON_LOT_TRIAL_ARTIFACT,
} from './owner-pepperstone-demo-noon-lot-trial';
import {
  ownerPepperstoneDemoOngoingSevenLot,
  OWNER_DEMO_ONGOING_SEVEN_LOT_ARTIFACT,
} from './owner-pepperstone-demo-ongoing-seven-lot';
import {
  evaluateGuardedPullback,
  type GuardedPullbackDecision,
} from './pepperstone-demo-guarded-pullback';
import type { HighConvictionOverlay } from './high-conviction-overlay';
import { evaluateProductionQualificationShadow } from './production-qualification-shadow';
import { observePlanBReversalM1ContinuationMismatch } from './planb-reversal-m1-continuation-shadow';
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
import { ownerDemoLossPausePolicy } from './owner-demo-loss-pauses-advisory';
import { resolveOwnerDemoRecoveryCanarySizing } from './owner-demo-recovery-canary-sizing';
import {
  M1_PORTFOLIO_NET_LOSS_BRAKE_ARTIFACT,
  M1_PORTFOLIO_NET_LOSS_BRAKE_COOLDOWN_MINUTES,
  type M1PortfolioNetLossBrakeDecision,
} from './m1-portfolio-net-loss-brake';
import { evaluateDemoProfitabilityReliabilityGate } from './demo-profitability-reliability-gate';
import { evaluateDemoPrimaryOnlyProbation } from './demo-primary-only-route-probation';
import { classifyForexSessionClock, isForexPreRolloverHour } from './forex-session-clock';
import { evaluateIndependentM1OpportunityShadow } from './independent-m1-opportunity-shadow';
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
  capM1DemoRequestedVolumeByRisk,
  M1_PEPPERSTONE_DEMO_ALIGNED_CURRENCY_TARGET_PERCENT,
  M1_PEPPERSTONE_DEMO_ALIGNED_CURRENCY_BLOCK_PERCENT,
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

// DEMO recovery after real consecutive losses is never a full-sized
// trade. Exactly one 0.01-lot-at-most primary Plan-B canary per 4 hours,
// and ONLY after the 180m reliability cooldown + every normal risk gate.
export const M1_DEMO_RECOVERY_CANARY_LOT_CAP = 0.01;
export const M1_DEMO_RECOVERY_CANARY_SPACING_MINUTES = 240;
/**
 * A once-per-90m, 0.01-lot, owner-confirmed DEMO only exception to the
 * duplicate primary-only probation veto for ALREADY qualified continuation.
 * It does not authorize a trade without every normal M1/broker risk gate.
 */
export const M1_DEMO_QUALIFIED_CONTINUATION_CANARY_LOT_CAP = 0.01;
export const M1_DEMO_QUALIFIED_CONTINUATION_CANARY_SPACING_MINUTES = 90;

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
 * Reversible operator-approved DEMO focused-two trading AND M1 scanning:
 * ONLY EURUSD/AUDUSD enter the high-frequency sequential evaluation loop.
 * No new model threshold or execution authorization; ordinary risk gates,
 * active-position protection and independent paper services are unchanged.
 */
export const M1_TACTICAL_ROLLOUT_POLICY_V8_FOCUSED_TWO_FEE_SHADOW: Readonly<M1TacticalRolloutPolicy> =
  Object.freeze({
    ...M1_TACTICAL_ROLLOUT_POLICY_V8_PRIMARY_ONLY_FEE_SHADOW,
    version: 'm1-tactical-v8-demo-primary-fee-shadow-focused2-v3',
    demoEntryInstruments: DEMO_FOCUSED_ENTRY_INSTRUMENTS_V3,
  });

/**
 * Operator-authorized FOUR-PAIR DEMO focus. This changes ONLY which
 * instruments the existing primary Plan B and M1 specialist evaluate.
 * It does not override loss brakes, after-commission admission,
 * primary-only fallback probation, lot sizing or LIVE safety.
 */
export const M1_TACTICAL_ROLLOUT_POLICY_V8_FOCUSED_FOUR_FEE_SHADOW: Readonly<M1TacticalRolloutPolicy> =
  Object.freeze({
    ...M1_TACTICAL_ROLLOUT_POLICY_V8_FOCUSED_TWO_FEE_SHADOW,
    version: 'm1-tactical-v8-demo-primary-fee-shadow-focused4-v4',
    demoEntryInstruments: DEMO_FOCUSED_ENTRY_INSTRUMENTS_V4,
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
  /** Full broker expert request duration including time overlapped by other reads. */
  trainedExpertFetchMs: number | null;
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
    @Optional() private readonly demoPortfolioBrakeConsent?: DemoPortfolioBrakeConsentService,
    @Optional() private readonly demoStrategyBrakeOwner?: DemoStrategyBrakeOwnerService,
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
      counterDemoPilot: {
        enabled:
          professionalDemoPhase &&
          this.config.get<string>('IREXPRO_PEPPERSTONE_DEMO_COUNTER_PILOT', '') === 'enabled',
        activeNow:
          professionalDemoPhase &&
          this.config.get<string>('IREXPRO_PEPPERSTONE_DEMO_COUNTER_PILOT', '') === 'enabled' &&
          Date.now() >= Date.parse(COUNTER_PILOT_START) &&
          Date.now() < Date.parse(COUNTER_PILOT_END),
        startsAt: COUNTER_PILOT_START,
        endsAt: COUNTER_PILOT_END,
        maxEntries: COUNTER_PILOT_ENTRY_LIMIT,
        maxLot: COUNTER_PILOT_LOT_CAP,
        exactBroker: 'Pepperstone cTrader DEMO',
      },
      advisoryAlternatePilot: {
        continuousEvidence:
          professionalDemoPhase &&
          this.config.get<string>('IREXPRO_PEPPERSTONE_DEMO_CONTINUOUS_ALTERNATES', '') ===
            'enabled' &&
          !!this.config.get<string>('VPS_FOREX_SCANNER_USER_ID', ''),
        enabled:
          professionalDemoPhase &&
          this.config.get<string>('IREXPRO_PEPPERSTONE_DEMO_ADVISORY_ALTERNATES', '') === 'enabled',
        activeNow:
          professionalDemoPhase &&
          this.config.get<string>('IREXPRO_PEPPERSTONE_DEMO_ADVISORY_ALTERNATES', '') ===
            'enabled' &&
          Date.now() >= Date.parse(ADVISORY_ALTERNATE_START) &&
          (this.config.get<string>('IREXPRO_PEPPERSTONE_DEMO_CONTINUOUS_ALTERNATES', '') ===
          'enabled'
            ? !!this.config.get<string>('VPS_FOREX_SCANNER_USER_ID', '')
            : Date.now() < Date.parse(ADVISORY_ALTERNATE_END)),
        startsAt: ADVISORY_ALTERNATE_START,
        endsAt:
          this.config.get<string>('IREXPRO_PEPPERSTONE_DEMO_CONTINUOUS_ALTERNATES', '') ===
            'enabled' && !!this.config.get<string>('VPS_FOREX_SCANNER_USER_ID', '')
            ? null
            : ADVISORY_ALTERNATE_END,
        maxEntries:
          this.config.get<string>('IREXPRO_PEPPERSTONE_DEMO_CONTINUOUS_ALTERNATES', '') ===
            'enabled' && !!this.config.get<string>('VPS_FOREX_SCANNER_USER_ID', '')
            ? null
            : ADVISORY_ALTERNATE_ENTRY_LIMIT,
        maxLot: 4,
        exactBroker: 'Pepperstone cTrader DEMO',
        allowedRoutes: ['CONFIRMED_REVERSAL', 'EARLY_TRANSITION'],
      },
      instruments: [...this.rolloutPolicy.instruments],
      ...(professionalDemoPhase && this.rolloutPolicy.demoEntryInstruments
        ? {
            demoEntryInstruments: [...this.rolloutPolicy.demoEntryInstruments],
            researchOnlyInstruments: this.rolloutPolicy.instruments.filter(
              (instrument) => !this.rolloutPolicy.demoEntryInstruments!.includes(instrument),
            ),
            m1ScannedInstruments: orderM1DemoSixPairScan({
              phase: this.rolloutPolicy.phase,
              policyInstruments: this.rolloutPolicy.instruments,
              demoEntryInstruments: this.rolloutPolicy.demoEntryInstruments,
              decisionTime: new Date(),
            }),
            m1DormantInstruments: this.rolloutPolicy.instruments.filter(
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
      const scanOrder = orderM1DemoSixPairScan({
        phase: this.rolloutPolicy.phase,
        policyInstruments: this.rolloutPolicy.instruments,
        demoEntryInstruments: this.rolloutPolicy.demoEntryInstruments,
        decisionTime,
      });
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
          trainedExpertFetchMs: null,
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
                ' trainedExpertFetchMs=' +
                (trace.trainedExpertFetchMs ?? 'UNKNOWN') +
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

    // Start ONE broker-native expert score immediately after the completed
    // market snapshot is verified, overlapping the independent event-risk,
    // reliability and scout reads. BUY and SELL still receive separate
    // direction-specific classifications of the SAME per-slot model response.
    // Scope: this instrument and minute ONLY; no cross-slot cache or fallback
    // to stale predictions. Entry/risk/portfolio/order checks stay serial.
    let expertPair: Promise<Readonly<Record<'BUY' | 'SELL', HighConvictionOverlay>>> | null = null;
    const trainedExpertForSlot =
      this.rolloutPolicy.phase === 'DEMO_EARLY_TRANSITION_PROFESSIONAL' &&
      typeof this.highConvictionBrokerExpert?.evaluatePair === 'function'
        ? async (direction: 'BUY' | 'SELL'): Promise<HighConvictionOverlay> => {
            if (!expertPair) {
              const fetchStartedAt = Date.now();
              expertPair = this.highConvictionBrokerExpert!.evaluatePair({
                userId,
                brokerConnectionId,
                instrument,
                candidateCloseTime: decisionTime,
              }).finally(() => {
                if (timing) timing.trainedExpertFetchMs = Math.max(0, Date.now() - fetchStartedAt);
              });
            }
            const scores = await expertPair;
            return scores[direction];
          }
        : undefined;

    const decisionStartedAt = Date.now();
    const candidates = buildM1TacticalCandidates(features, M1_TACTICAL_POLICY_V2);
    // The expert service returns UNAVAILABLE for a failed broker scoring call.
    // Attach a rejection handler even if subsequent event-risk work fails,
    // so a discarded prefetch never produces an unhandled rejection.
    if (trainedExpertForSlot) {
      void trainedExpertForSlot(candidates[0].direction).catch((error) => {
        this.logger.warn(
          'M1 prefetch unavailable instrument=' + instrument +
          ' slot=' + decisionTime.toISOString() + ': ' + (error as Error).message,
        );
      });
    }
    const eventRisk = await this.macroEventRisk.assess(instrument, decisionTime);
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
        trainedExpertForSlot,
        market,
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
    phaseTimings?: { portfolioMs: number; trainedExpertMs: number },
    trainedExpertForSlot?: (direction: 'BUY' | 'SELL') => Promise<HighConvictionOverlay>,
  ): Promise<MultimodelDemoEvaluation> {
    const planBInput = m1CandidateToPlanBInput(candidate, features, decisionTime);
    const portfolioPositions: PlanBPortfolioPosition[] = [];
    let portfolioSnapshotAvailable = false;
    const portfolioStartedAt = Date.now();
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
    } finally {
      if (phaseTimings) phaseTimings.portfolioMs += Math.max(0, Date.now() - portfolioStartedAt);
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

    const expertStartedAt = Date.now();
    const trainedExpert: HighConvictionOverlay = trainedExpertForSlot
      ? await trainedExpertForSlot(candidate.direction)
      : this.highConvictionBrokerExpert
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
    if (phaseTimings) phaseTimings.trainedExpertMs += Math.max(0, Date.now() - expertStartedAt);

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
    trainedExpertForSlot?: (direction: 'BUY' | 'SELL') => Promise<HighConvictionOverlay>,
    brokerMarketContext?: M1TacticalMarketSnapshot,
  ): Promise<void> {
    if (!features) return;
    // Observational timings only; never consulted by risk or entry authority.
    const startedCandidateAt = Date.now();
    const timings = {
      reliabilityMs: 0,
      scoutMs: 0,
      multimodelMs: 0,
      m5StageMs: 0,
      extensionStageMs: 0,
      downstreamRiskMs: 0,
      orderDispatchMs: 0,
      executableFeeMs: 0,
      blockedFeeShadowMs: 0,
      persistMs: 0,
    };
    const multimodelSubphases = { portfolioMs: 0, trainedExpertMs: 0 };
    const routeDecision = classifyM1TacticalRoute(
      candidate,
      opposite,
      features,
      M1_TACTICAL_POLICY_V2,
    );
    // Same immutable completed-market snapshot, scored synchronously BEFORE
    // either side can submit to the broker. The opposite database row often
    // appears after the first fill; it must not be used as pretrade evidence.
    // This independent tactical view is research only, NOT broker authority.
    const oppositeRouteAtSignal = classifyM1TacticalRoute(
      opposite,
      candidate,
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
          multimodelSubphases,
          trainedExpertForSlot,
        )
      : null;
    timings.multimodelMs = Date.now() - multimodelStartedAt;
    // Pure decision-time observation. It is never referenced by
    // preliminaryCanExecute, canExecute, sizing or broker dispatch.
    // Record the FULL cohort, including failures, to prevent later
    // cherry-picking a previously winning mismatch pattern.
    const planBReversalM1ContinuationShadow = multimodelDemo
      ? observePlanBReversalM1ContinuationMismatch({
          instrument: candidate.instrument,
          direction: candidate.direction,
          planBStrategyRoute: multimodelDemo.ensemble.strategyRoute,
          planBPaperAdmitted: multimodelDemo.ensemble.paperAdmitted,
          planBGovernanceEligible: multimodelDemo.governance.paperExecutionEligible,
          planBNetExpectedR: multimodelDemo.governance.netExpectedR,
          driftState: multimodelDemo.governance.driftState,
          eventRisk: multimodelDemo.governance.eventRisk,
          executionSpreadEvidenceValid:
            multimodelDemo.governance.executionSpreadEvidenceValid === true,
          m1Route: routeDecision.route,
          m1Direction: routeDecision.direction,
          m1Reason: routeDecision.reason,
          m1ScoreEdge: routeDecision.scoreEdge,
          directionQuality: candidate.directionQuality,
          alignedHigherTimeframeAgreement: candidate.alignedHigherTimeframeAgreement,
          alignedM5Momentum1Atr: candidate.alignedM5Momentum1Atr,
          alignedM5Momentum3Atr: candidate.alignedM5Momentum3Atr,
          alignedM5BodyPressure3: candidate.alignedM5BodyPressure3,
          alignedM5LatestBodyPressure: candidate.alignedM5LatestBodyPressure ?? null,
          failedBreakoutWithDirection: candidate.failedBreakoutWithDirection,
          trainedExpertOpposed: multimodelDemo.authority.trainedExpertOpposed,
        })
      : null;
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
    // Only a fully admitted independent Plan-B reversal may escape the
    // OTHER sleeve's M1 early-transition degradation veto. This never
    // escapes an M1 loss streak or any ordinary broker/risk veto.
    const crossSleeveReversalCandidate =
      professionalDemoPhase &&
      !!userId &&
      this.config.get<string>('VPS_FOREX_SCANNER_USER_ID', '') === userId &&
      routeDecision.route === 'M1_EARLY_TRANSITION' &&
      demoProfitabilityReliabilityGate?.degradedEarlyTransitionVeto === true &&
      multimodelDemo?.ensemble.strategyRoute === 'CONFIRMED_REVERSAL' &&
      multimodelDemo.authority.authorityPath === 'PRIMARY_PLAN_B' &&
      multimodelDemo.authority.executable === true;
    let crossSleeveBrokerVerified = false;
    if (crossSleeveReversalCandidate) {
      try {
        crossSleeveBrokerVerified = await this.evidence.isPepperstoneDemoBrokerConnection({
          userId,
          brokerConnectionId,
        });
      } catch (error) {
        this.logger.warn(
          'Confirmed-reversal DEMO canary broker verification unavailable ' +
            candidate.instrument + ': ' + (error as Error).message,
        );
      }
    }
    const crossSleeveReversalCanary = professionalDemoPhase &&
      evaluateConfirmedReversalCrossSleeveCanary({
        m1Route: routeDecision.route,
        reliabilityGate: demoProfitabilityReliabilityGate,
        strategyRoute: multimodelDemo?.ensemble.strategyRoute ?? null,
        primaryPlanBExecutable: multimodelDemo?.authority.authorityPath === 'PRIMARY_PLAN_B'
          && multimodelDemo?.authority.executable === true,
        portfolioSnapshotAvailable: multimodelDemo?.portfolioSnapshotAvailable === true,
        brokerVerifiedPepperstoneDemo: crossSleeveBrokerVerified,
        paperExecutionEligible: multimodelDemo?.governance.paperExecutionEligible === true,
        executionCostUsable: multimodelDemo?.governance.paperExecutionCostUsable === true,
        eventRisk: multimodelDemo?.governance.eventRisk ?? 'UNVERIFIED',
        driftState: multimodelDemo?.governance.driftState ?? 'UNVERIFIED',
        netExpectedR: multimodelDemo?.governance.netExpectedR ?? null,
        candidateDirection: candidate.direction,
        expertDirection: multimodelDemo?.trainedExpert.direction ?? null,
        expertAllBrokerNative: multimodelDemo?.trainedExpert.allBrokerNative === true,
        expertFreshnessSeconds: multimodelDemo?.trainedExpert.freshnessSeconds ?? null,
        expertConfidence: multimodelDemo?.trainedExpert.ensembleConfidence ?? null,
        expertLongVotes: multimodelDemo?.trainedExpert.longVotes ?? null,
        expertShortVotes: multimodelDemo?.trainedExpert.shortVotes ?? null,
      });
    const demoProfitabilityExecutionAllowed =
      demoProfitabilityReliabilityGate?.executable !== false || crossSleeveReversalCanary;

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
    // A deliberately small DEMO-only semantic timing mismatch trial.
    // Reversal/early-transition Plan-B admission, market/economic safety and
    // independent broker-native expert agreement are still mandatory. The
    // trial never replays past decisions and self-expires at 21:00 UTC.
    const alternateTrialConfigured =
      professionalDemoPhase &&
      this.config.get<string>('IREXPRO_PEPPERSTONE_DEMO_ALTERNATIVE_TRIAL', '') === 'enabled';
    const alternateTrialCandidate =
      alternateTrialConfigured &&
      multimodelDemo &&
      (multimodelDemo.ensemble.strategyRoute === 'CONFIRMED_REVERSAL' ||
        multimodelDemo.ensemble.strategyRoute === 'EARLY_TRANSITION');
    let alternateTrialBrokerVerified = false;
    if (alternateTrialCandidate && Date.now() < Date.parse(DEMO_ALTERNATIVE_TRIAL_END)) {
      try {
        alternateTrialBrokerVerified = await this.evidence.isPepperstoneDemoBrokerConnection({
          userId,
          brokerConnectionId,
        });
      } catch (error) {
        this.logger.warn(
          'DEMO alternate trial exact broker verification failed: ' + (error as Error).message,
        );
      }
    }
    const initialDemoAlternativeTrial = evaluateDemoAlternativeTrial({
      enabled: alternateTrialConfigured,
      brokerVerified: alternateTrialBrokerVerified,
      now: new Date(),
      decisionTime,
      route: multimodelDemo?.ensemble.strategyRoute ?? null,
      m1Route: routeDecision.route,
      ensembleScore: multimodelDemo?.ensemble.ensembleScore ?? null,
      planbDirectionQuality: multimodelDemo?.ensemble.directionQuality ?? null,
      paperAdmitted: multimodelDemo?.ensemble.paperAdmitted === true,
      governanceEligible: multimodelDemo?.governance.paperExecutionEligible === true,
      portfolioSnapshotAvailable: multimodelDemo?.portfolioSnapshotAvailable === true,
      executionSpreadEvidenceValid:
        multimodelDemo?.governance.executionSpreadEvidenceValid === true,
      paperExecutionCostUsable: multimodelDemo?.governance.paperExecutionCostUsable === true,
      netExpectedR: multimodelDemo?.governance.netExpectedR ?? null,
      eventRisk: multimodelDemo?.governance.eventRisk ?? 'UNVERIFIED',
      sleeveState: multimodelDemo?.governance.sleeveState ?? 'BLOCKED',
      m1Confidence: candidate.confidence,
      m1DirectionQuality: candidate.directionQuality,
      side: candidate.direction,
      expertSide: multimodelDemo?.trainedExpert.direction ?? null,
      expertNative: multimodelDemo?.trainedExpert.allBrokerNative === true,
      expertConfidence: multimodelDemo?.trainedExpert.ensembleConfidence ?? null,
      expertFreshness: multimodelDemo?.trainedExpert.freshnessSeconds ?? null,
      expertLongVotes: multimodelDemo?.trainedExpert.longVotes ?? null,
      expertShortVotes: multimodelDemo?.trainedExpert.shortVotes ?? null,
    });
    // Independent, DEMO-only, timeboxed expert COUNTER pilot. It is
    // evaluated for the CURRENT candidate side, which already has its own
    // M1 stop/target and Plan-B cost model. Never reuse the opposed side's
    // price/risk geometry, and never promote opposing votes alone.
    const counterEnabled =
      professionalDemoPhase &&
      this.config.get<string>('IREXPRO_PEPPERSTONE_DEMO_COUNTER_PILOT', '') === 'enabled' &&
      !!this.config.get<string>('VPS_FOREX_SCANNER_USER_ID', '') &&
      this.config.get<string>('VPS_FOREX_SCANNER_USER_ID', '') === userId;
    const counterWindowOpen =
      counterEnabled &&
      Date.now() >= Date.parse(COUNTER_PILOT_START) &&
      Date.now() < Date.parse(COUNTER_PILOT_END);
    let counterBrokerVerified = false;
    let counterOpposedSource: MultimodelDemoEvaluation | null = null;
    if (
      counterWindowOpen &&
      multimodelDemo &&
      // Candidate is the expert-supported opposite side. Requiring this
      // side to ALSO be a reversal made the counter pilot unreachable in
      // the shared TREND_WEAK regime; evaluate the opposing source instead.
      ['CONFIRMED_REVERSAL', 'EARLY_TRANSITION', 'TREND_CONTINUATION'].includes(
        multimodelDemo.ensemble.strategyRoute,
      ) &&
      multimodelDemo.trainedExpert.state === 'CONFIRM' &&
      multimodelDemo.trainedExpert.admitted === true
    ) {
      try {
        counterBrokerVerified = await this.evidence.isPepperstoneUsdDemoBrokerConnection({
          userId,
          brokerConnectionId,
        });
        if (counterBrokerVerified) {
          counterOpposedSource = await this.evaluateDemoMultimodel(
            userId,
            brokerConnectionId,
            opposite,
            features,
            eventRisk,
            spreadEvidence,
            decisionTime,
            paperSimulationSpreadPrice,
            undefined,
            trainedExpertForSlot,
          );
        }
      } catch (error) {
        this.logger.warn(
          'Independent DEMO counter evaluation unavailable: ' + (error as Error).message,
        );
      }
    }
    const counterPilot = evaluateCounterPilot({
      enabled: counterWindowOpen,
      brokerVerified: counterBrokerVerified,
      now: new Date(),
      decisionTime,
      side: candidate.direction,
      m1Route: routeDecision.route,
      m1Confidence: candidate.confidence,
      m1DirectionQuality: candidate.directionQuality,
      stopDistance: candidate.stopDistance,
      targetDistance: candidate.targetDistance,
      candidate: multimodelDemo,
      opposingSource: counterOpposedSource,
    });
    // Same-direction advisory expert votes may corroborate an already
    // paper-admitted reversal/early transition even if its FINAL expert
    // outcome is ABSTAIN. This limited trial bridges only duplicated
    // timing/confirmation, not spread, cost or broker-risk controls.
    const advisoryEnabled =
      professionalDemoPhase &&
      this.config.get<string>('IREXPRO_PEPPERSTONE_DEMO_ADVISORY_ALTERNATES', '') === 'enabled';
    // Deliberately remove only the *experiment's* old 4-entry/time cutoff,
    // not the broker's ongoing risk, drawdown, fill or session constraints.
    // The continued research requires exact configured owner identity.
    const continuousAdvisoryRequested =
      advisoryEnabled &&
      this.config.get<string>('IREXPRO_PEPPERSTONE_DEMO_CONTINUOUS_ALTERNATES', '') === 'enabled' &&
      !!this.config.get<string>('VPS_FOREX_SCANNER_USER_ID', '') &&
      this.config.get<string>('VPS_FOREX_SCANNER_USER_ID', '') === userId;
    const advisoryWindowOpen =
      advisoryEnabled &&
      Date.now() >= Date.parse(ADVISORY_ALTERNATE_START) &&
      (continuousAdvisoryRequested || Date.now() < Date.parse(ADVISORY_ALTERNATE_END));
    let advisoryBrokerVerified = false;
    if (
      advisoryWindowOpen &&
      multimodelDemo &&
      ['CONFIRMED_REVERSAL', 'EARLY_TRANSITION'].includes(multimodelDemo.ensemble.strategyRoute) &&
      multimodelDemo.ensemble.paperAdmitted
    ) {
      try {
        advisoryBrokerVerified = await this.evidence.isPepperstoneDemoBrokerConnection({
          userId,
          brokerConnectionId,
        });
      } catch (error) {
        this.logger.warn(
          'DEMO advisory alternate account validation unavailable: ' + (error as Error).message,
        );
      }
    }
    const advisoryAlternateTrial = evaluateAdvisoryAlternateTrial({
      enabled: advisoryWindowOpen,
      continuousEvidence: continuousAdvisoryRequested && advisoryBrokerVerified,
      relaxedConfirmation:
        advisoryWindowOpen &&
        this.config.get<string>('IREXPRO_PEPPERSTONE_DEMO_RELAXED_ALTERNATE_TRIAL', '') ===
          'enabled' &&
        !!this.config.get<string>('VPS_FOREX_SCANNER_USER_ID', '') &&
        this.config.get<string>('VPS_FOREX_SCANNER_USER_ID', '') === userId,
      brokerVerified: advisoryBrokerVerified,
      now: new Date(),
      decisionTime,
      route: multimodelDemo?.ensemble.strategyRoute ?? null,
      side: candidate.direction,
      paperAdmitted: multimodelDemo?.ensemble.paperAdmitted === true,
      governanceEligible: multimodelDemo?.governance.paperExecutionEligible === true,
      portfolioSnapshotAvailable: multimodelDemo?.portfolioSnapshotAvailable === true,
      ensembleScore: multimodelDemo?.ensemble.ensembleScore ?? null,
      planbDirectionQuality: multimodelDemo?.ensemble.directionQuality ?? null,
      netExpectedR: multimodelDemo?.governance.netExpectedR ?? null,
      executionSpreadEvidenceValid:
        multimodelDemo?.governance.executionSpreadEvidenceValid === true,
      paperExecutionCostUsable: multimodelDemo?.governance.paperExecutionCostUsable === true,
      eventRisk: multimodelDemo?.governance.eventRisk ?? 'UNKNOWN',
      driftState: multimodelDemo?.governance.driftState ?? 'UNKNOWN',
      sleeveState: multimodelDemo?.governance.sleeveState ?? 'BLOCKED',
      m1Route: routeDecision.route,
      m1Confidence: candidate.confidence,
      m1DirectionQuality: candidate.directionQuality,
      stopDistance: candidate.stopDistance,
      targetDistance: candidate.targetDistance,
      expertSide: multimodelDemo?.trainedExpert.direction ?? null,
      expertState: multimodelDemo?.trainedExpert.state ?? null,
      expertNative: multimodelDemo?.trainedExpert.allBrokerNative === true,
      expertAdmitted: multimodelDemo?.trainedExpert.admitted ?? null,
      expertFreshness: multimodelDemo?.trainedExpert.freshnessSeconds ?? null,
      expertProbability: multimodelDemo?.trainedExpert.meanOpportunityProbability ?? null,
      expertLongVotes: multimodelDemo?.trainedExpert.longVotes ?? null,
      expertShortVotes: multimodelDemo?.trainedExpert.shortVotes ?? null,
    });
    let demoAlternativeTrial:
      | DemoAlternativeTrialDecision
      | CounterPilotDecision
      | AdvisoryAlternateTrialDecision = counterPilot.eligible
      ? counterPilot
      : advisoryAlternateTrial.eligible
        ? advisoryAlternateTrial
        : initialDemoAlternativeTrial;
    // The only unmetered route is explicitly owner-and-broker-verified
    // Pepperstone DEMO advisory reversal/early-transition evidence collection.
    // The counter and other historical studies keep their finite budgets.
    if (
      demoAlternativeTrial.eligible &&
      !(
        demoAlternativeTrial.artifact === ADVISORY_ALTERNATE_ARTIFACT &&
        demoAlternativeTrial.continuousEvidence === true
      )
    ) {
      try {
        const counterSelected = demoAlternativeTrial.artifact === COUNTER_PILOT_ARTIFACT;
        const advisorySelected = demoAlternativeTrial.artifact === ADVISORY_ALTERNATE_ARTIFACT;
        const priorTrialEntries = await this.evidence.loadDemoAlternativeTrialEntryCount({
          userId,
          brokerConnectionId,
          ...(counterSelected
            ? { startsAt: COUNTER_PILOT_START, endsAt: COUNTER_PILOT_END }
            : advisorySelected
              ? { startsAt: ADVISORY_ALTERNATE_START, endsAt: ADVISORY_ALTERNATE_END }
              : {}),
        });
        const limit = counterSelected
          ? COUNTER_PILOT_ENTRY_LIMIT
          : advisorySelected
            ? ADVISORY_ALTERNATE_ENTRY_LIMIT
            : DEMO_ALTERNATIVE_TRIAL_ENTRY_LIMIT;
        if (priorTrialEntries >= limit) {
          demoAlternativeTrial = counterSelected
            ? { ...counterPilot, eligible: false, reason: 'ENTRY_LIMIT_REACHED' }
            : advisorySelected
              ? { ...advisoryAlternateTrial, eligible: false, reason: 'ENTRY_LIMIT_REACHED' }
              : { ...initialDemoAlternativeTrial, eligible: false, reason: 'ENTRY_LIMIT_REACHED' };
        }
      } catch (error) {
        demoAlternativeTrial = counterPilot.eligible
          ? { ...counterPilot, eligible: false, reason: 'LIMIT_CHECK_UNAVAILABLE' }
          : advisoryAlternateTrial.eligible
            ? { ...advisoryAlternateTrial, eligible: false, reason: 'LIMIT_CHECK_UNAVAILABLE' }
            : {
                ...initialDemoAlternativeTrial,
                eligible: false,
                reason: 'LIMIT_CHECK_UNAVAILABLE',
              };
        this.logger.warn(
          'DEMO alternate trial entry budget unavailable: ' + (error as Error).message,
        );
      }
    }
    const multimodelPrimaryExecutable =
      professionalDemoPhase &&
      // Only the final, owner-and-broker-verified trial object grants pilot
      // execution. Old finite pilots still enforce their historical budgets.
      (demoProfitabilityExecutionAllowed || demoAlternativeTrial.eligible) &&
      (multimodelDemo?.authority.executable === true || demoAlternativeTrial.eligible);
    // With two recent M1 losses, the exact pair/side/route needs a finite
    // three-hour cooldown before a tiny exploratory recovery entry. A
    // successful canary does not immediately restore 4-lot eligibility:
    // keep recovery size and spacing until five actual route samples.
    const recoveryCanary =
      crossSleeveReversalCanary ||
      (professionalDemoPhase &&
        (reliability?.reason === 'EARLY_LOSS_STREAK_RECOVERY_CANARY' ||
          (reliability?.reason === 'INSUFFICIENT_EVIDENCE' &&
            reliability.samples > 0 &&
            reliability.samples < 5 &&
            reliability.losses >= 2)));

    // The owner's Start/Stop policy also makes the legacy historical-loss
    // 0.01-lot recovery canary advisory in the *verified* Pepperstone USD
    // DEMO FULL_AUTO account. It still requires admitted model evidence and
    // the original broker/portfolio stop-risk, margin and exposure sizing.
    let ownerDemoRecoveryVerified = false;
    const ownerDemoRecoveryFeatureEnabled =
      this.config.get<string>('IREXPRO_OWNER_DEMO_LOSS_PAUSES_ADVISORY_ONLY','')==='enabled';
    if (recoveryCanary && !crossSleeveReversalCanary &&
        professionalDemoPhase && ownerDemoRecoveryFeatureEnabled &&
        !!userId &&
        this.config.get<string>('VPS_FOREX_SCANNER_USER_ID','')===userId &&
        this.executionService) {
      try {
        const active = await this.executionService.getActiveSession(userId);
        if (active?.executionMode===ExecutionMode.FULL_AUTO &&
            active.brokerConnectionId===brokerConnectionId) {
          ownerDemoRecoveryVerified =
            await this.evidence.isPepperstoneUsdDemoBrokerConnection({
              userId,brokerConnectionId,
            });
        }
      } catch (error) {
        this.logger.warn('Owner DEMO recovery sizing verification unavailable: '+
          (error as Error).message);
      }
    }
    const multimodelDirectionConflict =
      professionalDemoPhase &&
      multimodelDemo?.authority.blockers.includes(
        'MULTIMODEL_TRAINED_EXPERT_DIRECTION_CONFLICT',
      ) === true;
    const m5StageStartedAt = Date.now();
    let m5EarlyTransitionEvidence: M5EarlyTransitionEvidence | null = null;
    let m5EarlyTransitionHandoff: M5EarlyTransitionHandoffDecision | null = null;
    if (
      professionalDemoPhase &&
      !multimodelPrimaryExecutable &&
      (!professionalM1FallbackExecutable || professionalM1BootstrapExecutable) &&
      m1MayConfirmM5EarlyTransition({
        m1Route: routeDecision.route,
        m1Reason: routeDecision.reason,
        m1Confidence: candidate.confidence,
        m1DirectionQuality: candidate.directionQuality,
        m1ExecutionCostUsable: governance.genericGovernance.paperExecutionCostUsable === true,
        m1EventRisk: eventRisk,
      })
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
    timings.m5StageMs = Math.max(0, Date.now() - m5StageStartedAt);
    const m5EarlyTransitionHandoffEligible = m5EarlyTransitionHandoff?.eligible === true;
    const extensionStageStartedAt = Date.now();
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
    timings.extensionStageMs = Math.max(0, Date.now() - extensionStageStartedAt);
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
    const ownerDemoRecoveryCanarySizing=resolveOwnerDemoRecoveryCanarySizing({
      recoveryCanary,crossSleeveReversalCanary,
      ownerDemoVerified:ownerDemoRecoveryVerified,
      featureEnabled:ownerDemoRecoveryFeatureEnabled,
      normalVolumeCap:executionVolumeCap,
      recoveryCanaryLotCap:M1_DEMO_RECOVERY_CANARY_LOT_CAP,
    });
    const recoveryCanaryVolumeCap = crossSleeveReversalCanary
      ? Math.min(executionVolumeCap, CONFIRMED_REVERSAL_CROSS_SLEEVE_CANARY_LOT_CAP)
      : ownerDemoRecoveryCanarySizing.volumeCap;
    // The legacy 20-21 UTC alternative admission remains capped at 0.01.
    // Only the independent COUNTER pilot has a 4.00-lot *ceiling*; the
    // unchanged 0.25% stop-risk cap and broker margin control the actual lot.
    // The independent COUNTER cap may be 4.00, but broker equity,
    // 0.25% per-trade stop risk, active exposure and provider margin
    // still reduce or reject the actual volume below this ceiling.
    // The probation decision is computed below after owner verification;
    // defer applying this cap until then.
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
    // Never infer DEMO account type from rollout-policy naming. A favorable
    // exact pair/side M1 sleeve can be put on a tiny research canary only if
    // the broker is owner-bound, connected and has an ACTIVE DEMO session.
    let verifiedDemoForQualifiedContinuation = false;
    let qualifiedContinuationAfterFeeEvidence: Awaited<
      ReturnType<M1TacticalEvidenceService['loadQualifiedM1ContinuationAfterFeeEvidence']>
    > | null = null;
    if (
      professionalDemoPhase &&
      this.rolloutPolicy.demoPrimaryOnlyProbation === true &&
      professionalM1FallbackExecutable &&
      professionalM1Fallback?.tier === 'QUALIFIED_CONTINUATION' &&
      reliability?.reason === 'POSITIVE_EXPECTANCY'
    ) {
      try {
        verifiedDemoForQualifiedContinuation = await this.evidence.isActiveConnectedOwnerDemoBroker(
          {
            userId,
            brokerConnectionId,
          },
        );
        if (verifiedDemoForQualifiedContinuation) {
          qualifiedContinuationAfterFeeEvidence =
            await this.evidence.loadQualifiedM1ContinuationAfterFeeEvidence({
              userId,
              brokerConnectionId,
              instrument: candidate.instrument,
              direction: candidate.direction,
              evaluatedAt: decisionTime,
              policyVersion: candidate.policyVersion,
            });
        }
      } catch (error) {
        this.logger.warn(
          `Qualified continuation DEMO owner verification unavailable ${candidate.instrument}: ${(error as Error).message}`,
        );
      }
    }
    const demoPrimaryOnlyProbation = evaluateDemoPrimaryOnlyProbation({
      enabled: professionalDemoPhase && this.rolloutPolicy.demoPrimaryOnlyProbation === true,
      brokerAccountIsDemo: verifiedDemoForQualifiedContinuation,
      afterCommissionEvidence: qualifiedContinuationAfterFeeEvidence,
      genuineRollover: classifyForexSessionClock(decisionTime) === 'ROLLOVER',
      // On 12 Nov a 21:15 M1 SELL remained open through the 22:00
      // NY rollover and was exited at an observed 12.7-pip spread
      // against a 4.8-pip stop. Prevent that narrow trial timing again.
      preRolloverRiskWindow: isForexPreRolloverHour(decisionTime),
      qualifiedContinuationEvidence: reliability
        ? {
            eligible: reliability.eligible,
            reason: reliability.reason,
            samples: reliability.samples,
            wins: reliability.wins,
            averageRealizedR: reliability.averageRealizedR,
            recentRealizedR: reliability.recentRealizedR,
          }
        : null,
      primaryAuthorityPath: demoAlternativeTrial.eligible
        ? 'PRIMARY_PLAN_B'
        : (multimodelDemo?.authority.authorityPath ?? null),
      m5HandoffEligible: m5EarlyTransitionHandoffEligible && !demoAlternativeTrial.eligible,
      executableFallbackTier:
        !demoAlternativeTrial.eligible && professionalM1FallbackExecutable
          ? (professionalM1Fallback?.tier ?? null)
          : null,
      extensionScoutExecutable:
        !demoAlternativeTrial.eligible && extensionExhaustionDemoScoutExecutable,
    });
    let selectedExecutionVolumeCap = demoAlternativeTrial.eligible
      ? Math.min(recoveryCanaryVolumeCap, demoAlternativeTrial.maxLot)
      : demoPrimaryOnlyProbation.qualifiedContinuationCanary
        ? Math.min(recoveryCanaryVolumeCap, M1_DEMO_QUALIFIED_CONTINUATION_CANARY_LOT_CAP)
        : recoveryCanaryVolumeCap;
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
        (recoveryCanary
          ? multimodelPrimaryExecutable
          : multimodelPrimaryExecutable ||
            m5EarlyTransitionHandoffEligible ||
            professionalM1FallbackExecutable ||
            extensionExhaustionDemoScoutExecutable)
      : routeExecutable && routePayoffEligible && governanceExecutable;
    // An isolated pair/side/route can have a clean local streak while the
    // DEMO portfolio loses repeatedly across several instruments. Require
    // same-session broker-account net economics before ANY new primary-engine
    // DEMO entry; never alter existing positions or weaken session authority.
    const ownerDemoAdvisoryRequested =
      professionalDemoPhase &&
      this.config.get<string>('IREXPRO_OWNER_DEMO_LOSS_PAUSES_ADVISORY_ONLY','')==='enabled' &&
      !!userId &&
      this.config.get<string>('VPS_FOREX_SCANNER_USER_ID','')===userId;
    const downstreamRiskStartedAt = Date.now();
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
    // Existing incident-scoped owner overrides remain supported outside the
    // newly scoped advisory policy. No approval is needed for the owner DEMO
    // after its broker and FULL_AUTO session have been verified.
    let ownerAcceptedPortfolioBrake = false;
    if (!ownerDemoAdvisoryRequested &&
        portfolioNetLossBrake?.active === true &&
        portfolioNetLossBrake.reason === 'RECENT_PORTFOLIO_NET_LOSS_STREAK' &&
        portfolioNetLossBrake.latestClosedAt &&
        preliminaryCanExecute &&
        this.demoPortfolioBrakeConsent && this.executionService) {
      try {
        const active = await this.executionService.getActiveSession(userId);
        if (active?.executionMode === ExecutionMode.FULL_AUTO &&
            active.brokerConnectionId === brokerConnectionId) {
          ownerAcceptedPortfolioBrake = await this.demoPortfolioBrakeConsent.isOverrideActive({
            userId,brokerConnectionId,sessionId:active.id,
            latestClosedAt:portfolioNetLossBrake.latestClosedAt,
          });
        }
      } catch (error) {
        this.logger.warn('DEMO portfolio consent unavailable: ' + (error as Error).message);
      }
    }

    // The controlled qualified-M1 alternative is NOT a Plan B override
    // for unqualified candidates. It is a small exception to probation for
    // the exact already-qualified continuation route. Fail-closed when the
    // last real broker-native canary cannot be checked.
    let qualifiedContinuationCanaryRecentlyAuthorized = false;
    let qualifiedContinuationCanaryHistoryUnavailable = false;
    if (demoPrimaryOnlyProbation.qualifiedContinuationCanary && preliminaryCanExecute) {
      try {
        qualifiedContinuationCanaryRecentlyAuthorized =
          await this.evidence.hasRecentM1QualifiedContinuationCanary({
            userId,
            brokerConnectionId,
            instrument: candidate.instrument,
            direction: candidate.direction,
            evaluatedAt: decisionTime,
            cooldownMinutes: M1_DEMO_QUALIFIED_CONTINUATION_CANARY_SPACING_MINUTES,
          });
      } catch (error) {
        qualifiedContinuationCanaryHistoryUnavailable = true;
        this.logger.warn(
          `Qualified continuation canary history unavailable ${candidate.instrument}: ${(error as Error).message}`,
        );
      }
    }
    // Fail-closed on unavailable recovery history. Query ONLY for a would-
    // otherwise-authorize primary Plan-B canary so normal scans stay cheap.
    let recoveryCanaryRecentlyAuthorized = false;
    let recoveryCanaryHistoryUnavailable = false;
    if (ownerDemoRecoveryCanarySizing.enforceHistoricalCanarySpacing &&
        preliminaryCanExecute) {
      try {
        recoveryCanaryRecentlyAuthorized = await this.evidence.hasRecentM1RecoveryCanary({
          userId,
          brokerConnectionId,
          instrument: candidate.instrument,
          direction: candidate.direction,
          evaluatedAt: decisionTime,
          cooldownMinutes: M1_DEMO_RECOVERY_CANARY_SPACING_MINUTES,
        });
      } catch (error) {
        recoveryCanaryHistoryUnavailable = true;
        this.logger.warn(
          `M1 recovery canary history unavailable instrument=${candidate.instrument} ` +
            `direction=${candidate.direction}: ${(error as Error).message}`,
        );
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
    // A new entry candidate, even CONFIRMED_REVERSAL, is not an exit signal.
    // Hold it when an opposite real DEMO position already exists. Previously
    // this could force-close a valid position at a loss merely to flip sides.
    // Actual exits stay with the separate risk/profit/owner exit services.
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
    const demoAlternateTrialActiveSameSideIntent =
      preliminaryCanExecute && demoAlternativeTrial.eligible
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
    // Strictly scoped, reversible experiment. Unlike a route-priority
    // override, this veto covers primary Plan-B continuation AND executable
    // continuation fallbacks/canaries. M5 early handoffs and confirmed
    // reversals remain subject to their existing unrelaxed admission gates.
    const chosenDemoAuthorityPath = demoPrimaryOnlyProbation.chosenAuthorityPath;
    const selectedContinuationForPause =
      (chosenDemoAuthorityPath === 'PRIMARY_PLAN_B' &&
        multimodelDemo?.ensemble.strategyRoute === 'TREND_CONTINUATION') ||
      chosenDemoAuthorityPath === 'BOOTSTRAP_CONTINUATION' ||
      chosenDemoAuthorityPath === 'QUALIFIED_CONTINUATION' ||
      chosenDemoAuthorityPath === 'EXTENSION_EXHAUSTION_DEMO_SCOUT';
    const pauseEnabled =
      this.config.get<string>('IREXPRO_PEPPERSTONE_DEMO_PAUSE_TREND_CONTINUATION', '') ===
      'enabled';
    let pauseBrokerVerified: boolean | null = null;
    if (
      professionalDemoPhase &&
      pauseEnabled &&
      preliminaryCanExecute &&
      selectedContinuationForPause
    ) {
      try {
        pauseBrokerVerified = await this.evidence.isPepperstoneDemoBrokerConnection({
          userId,
          brokerConnectionId,
        });
      } catch (error) {
        // With the pause requested, missing identity cannot justify
        // continuing to open large continuation trades.
        this.logger.warn(
          'M1 DEMO continuation pause broker scope unavailable instrument=' +
            candidate.instrument +
            ': ' +
            (error as Error).message,
        );
      }
    }
    // Even with the continuation pause active, an explicitly enabled owner-
    // scoped DEMO recovery can reopen a LIMITED 0.20-lot continuation only
    // AFTER the earlier stretched trend has cooled inside normal Plan-B
    // distribution and a fresh M1/M5 continuation re-accelerates.
    const guardedPullbackEnabled =
      this.config.get<string>('IREXPRO_PEPPERSTONE_DEMO_GUARDED_PULLBACK', '') === 'enabled' &&
      this.config.get<string>('VPS_FOREX_SCANNER_USER_ID', '') === userId &&
      !!userId &&
      professionalDemoPhase &&
      pauseEnabled &&
      selectedContinuationForPause &&
      preliminaryCanExecute &&
      pauseBrokerVerified === true &&
      multimodelDemo?.ensemble.strategyRoute === 'TREND_CONTINUATION';
    let priorExtendedAt: Date | null = null;
    if (guardedPullbackEnabled) {
      try {
        priorExtendedAt = await this.evidence.loadPriorExtendedTrendForPullback({
          userId,
          brokerConnectionId,
          instrument: candidate.instrument,
          direction: candidate.direction,
          asOf: decisionTime,
        });
      } catch (error) {
        // A missing/slow causal source is NEVER permission to lift the pause.
        this.logger.warn(
          'Guarded DEMO pullback evidence unavailable ' +
            candidate.instrument +
            ': ' +
            (error as Error).message,
        );
      }
    }
    const guardedPullback: GuardedPullbackDecision = evaluateGuardedPullback({
      enabled: guardedPullbackEnabled,
      brokerVerified: pauseBrokerVerified === true,
      decisionTime,
      priorExtendedAt,
      planBRoute: multimodelDemo?.ensemble.strategyRoute ?? null,
      planBRegime: multimodelDemo?.ensemble.regime ?? null,
      paperAdmitted: multimodelDemo?.ensemble.paperAdmitted === true,
      governanceEligible: multimodelDemo?.governance.paperExecutionEligible === true,
      portfolioSnapshotAvailable: multimodelDemo?.portfolioSnapshotAvailable === true,
      driftState: multimodelDemo?.governance.driftState ?? 'UNKNOWN',
      eventRisk: multimodelDemo?.governance.eventRisk ?? 'UNKNOWN',
      spreadVerified: multimodelDemo?.governance.executionSpreadEvidenceValid === true,
      costsUsable: multimodelDemo?.governance.paperExecutionCostUsable === true,
      netExpectedR: multimodelDemo?.governance.netExpectedR ?? null,
      confidence: candidate.confidence,
      directionQuality: candidate.directionQuality,
      extensionAtr: features.extensionAtr,
      rsi14: features.rsi14,
      alignedEmaSeparationAtr: candidate.alignedEmaSeparationAtr,
      alignedM15: candidate.alignedM15,
      alignedMomentum1Atr: candidate.alignedMomentum1Atr,
      alignedMomentum3Atr: candidate.alignedMomentum3Atr,
      alignedM5LatestBodyPressure: candidate.alignedM5LatestBodyPressure ?? 0,
      m1Route: routeDecision.route,
      direction: candidate.direction,
      expertDirection: multimodelDemo?.trainedExpert.direction ?? null,
      expertNative: multimodelDemo?.trainedExpert.allBrokerNative === true,
      expertFreshnessSeconds: multimodelDemo?.trainedExpert.freshnessSeconds ?? null,
      expertLongVotes: multimodelDemo?.trainedExpert.longVotes ?? 0,
      expertShortVotes: multimodelDemo?.trainedExpert.shortVotes ?? 0,
      stopDistance: candidate.stopDistance,
      targetDistance: candidate.targetDistance,
    });
    if (guardedPullback.eligible) {
      selectedExecutionVolumeCap = Math.min(selectedExecutionVolumeCap, guardedPullback.lotCap);
    }
    const demoContinuationPause = evaluatePepperstoneDemoContinuationPause({
      guardedPullbackRecovery: guardedPullback.eligible,
      enabled:
        professionalDemoPhase &&
        pauseEnabled &&
        preliminaryCanExecute &&
        selectedContinuationForPause,
      isProfessionalDemoPhase: professionalDemoPhase,
      selectedRoute: selectedContinuationForPause
        ? 'TREND_CONTINUATION'
        : (executionStrategyRoute ?? null),
      scopedPepperstoneDemo: pauseBrokerVerified,
    });
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
    // Only this exact owner Pepperstone USD DEMO FULL_AUTO account receives
    // advisory-only historical loss cooldowns. Never extend to other users,
    // LIVE broker accounts or inactive sessions. An unavailable broker scope
    // retains all prior protections.
    let ownerApprovedStrategyContinuation = false;
    if (!ownerDemoAdvisoryRequested && professionalDemoPhase &&
        preliminaryCanExecute && multimodelLossStreakBrake?.active === true &&
        multimodelLossStreakBrake.latestClosedAt &&
        executionStrategyRoute &&
        ['EARLY_TRANSITION','CONFIRMED_REVERSAL','TREND_CONTINUATION']
          .includes(executionStrategyRoute) &&
        this.demoStrategyBrakeOwner && this.executionService) {
      try {
        const active = await this.executionService.getActiveSession(userId);
        if (active?.executionMode === ExecutionMode.FULL_AUTO &&
            active.brokerConnectionId === brokerConnectionId) {
          ownerApprovedStrategyContinuation =
            await this.demoStrategyBrakeOwner.isContinuationApproved({
              userId,brokerConnectionId,sessionId:active.id,
              route:executionStrategyRoute as
                'EARLY_TRANSITION'|'CONFIRMED_REVERSAL'|'TREND_CONTINUATION',
              instrument:candidate.instrument,direction:candidate.direction,
              reason:multimodelLossStreakBrake.reason,
              latestClosedAt:multimodelLossStreakBrake.latestClosedAt,
              at:decisionTime,
            });
        }
      } catch (error) {
        this.logger.warn('DEMO strategy consent unavailable: ' + (error as Error).message);
      }
    }
    let ownerDemoDiscretionaryPausesAdvisory = false;
    if (
      ownerDemoAdvisoryRequested && preliminaryCanExecute &&
      this.executionService &&
      (fastStopRegimeBrake?.active===true ||
        multimodelLossStreakBrake?.active===true ||
        portfolioNetLossBrake?.active===true)
    ) {
      try {
        const activeSession = await this.executionService.getActiveSession(userId);
        if (activeSession?.executionMode===ExecutionMode.FULL_AUTO &&
            activeSession.brokerConnectionId===brokerConnectionId) {
          ownerDemoDiscretionaryPausesAdvisory =
            await this.evidence.isPepperstoneUsdDemoBrokerConnection({
              userId,brokerConnectionId,
            });
        }
      } catch (error) {
        this.logger.warn('Owner DEMO loss-advisory broker verification failed: ' +
          (error as Error).message);
      }
    }
    const ownerLossPausePolicy=ownerDemoLossPausePolicy({
      featureEnabled:
        this.config.get<string>('IREXPRO_OWNER_DEMO_LOSS_PAUSES_ADVISORY_ONLY','')==='enabled',
      exactOwner:!!userId &&
        this.config.get<string>('VPS_FOREX_SCANNER_USER_ID','')===userId,
      exactPepperstoneUsdDemo:ownerDemoDiscretionaryPausesAdvisory,
      fullAutoActive:ownerDemoDiscretionaryPausesAdvisory,
      model:multimodelLossStreakBrake,
      portfolio:portfolioNetLossBrake,
      fastStop:fastStopRegimeBrake,
    });
    timings.downstreamRiskMs = Math.max(0, Date.now() - downstreamRiskStartedAt);
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
      !demoAlternateTrialActiveSameSideIntent &&
      !extensionExhaustionActiveSameSideIntent &&
      !ownerLossPausePolicy.fastStopCooldownBlocks &&
      (!ownerLossPausePolicy.modelLossStreakBlocks || ownerApprovedStrategyContinuation) &&
      (!ownerLossPausePolicy.portfolioLossStreakBlocks || ownerAcceptedPortfolioBrake) &&
      !recoveryCanaryRecentlyAuthorized &&
      !recoveryCanaryHistoryUnavailable &&
      !qualifiedContinuationCanaryRecentlyAuthorized &&
      !qualifiedContinuationCanaryHistoryUnavailable &&
      !demoPrimaryOnlyProbation.blocked &&
      !demoBrokerCommissionGate.blocked &&
      !demoContinuationPause.blocked;
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
          ...(crossSleeveReversalCanary ? [] : (demoProfitabilityReliabilityGate?.blockers ?? [])),
          ...(multimodelDirectionConflict ? ['MULTIMODEL_TRAINED_EXPERT_DIRECTION_CONFLICT'] : []),
          // An independently qualified DEMO alternate can legitimately use
          // the same Plan-B signal while its ordinary M1-timing authority is
          // blocked. Do not persist that superseded PRIMARY-path blocker as
          // the effective reason an ALTERNATE order was denied. Preserve the
          // primary evaluation itself in multimodelAuthority for forensics.
          ...(demoAlternativeTrial.eligible ||
          professionalM1FallbackExecutable ||
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
          ...(demoAlternateTrialActiveSameSideIntent
            ? ['M1_DEMO_ALTERNATIVE_TRIAL_ACTIVE_SAME_SIDE_INTENT']
            : []),
          ...(ownerLossPausePolicy.fastStopCooldownBlocks ? ['M1_FAST_STOP_REGIME_BRAKE'] : []),
          ...(ownerLossPausePolicy.modelLossStreakBlocks && !ownerApprovedStrategyContinuation
            ? ['M1_MULTIMODEL_LOSS_STREAK_BRAKE']
            : []),
          ...(ownerLossPausePolicy.portfolioLossStreakBlocks && !ownerAcceptedPortfolioBrake
            ? ['M1_PORTFOLIO_NET_LOSS_STREAK_BRAKE'] : []),
          ...(recoveryCanaryRecentlyAuthorized ? ['M1_RECOVERY_CANARY_REPEAT_COOLDOWN'] : []),
          ...(recoveryCanaryHistoryUnavailable ? ['M1_RECOVERY_CANARY_HISTORY_UNAVAILABLE'] : []),
          ...(qualifiedContinuationCanaryRecentlyAuthorized
            ? ['M1_DEMO_QUALIFIED_CONTINUATION_CANARY_REPEAT_COOLDOWN']
            : []),
          ...(qualifiedContinuationCanaryHistoryUnavailable
            ? ['M1_DEMO_QUALIFIED_CONTINUATION_CANARY_HISTORY_UNAVAILABLE']
            : []),
          ...(demoPrimaryOnlyProbation.blocked ? ['M1_DEMO_PRIMARY_ONLY_ROUTE_PROBATION'] : []),
          ...(demoContinuationPause.blocked ? [PEPPERSTONE_DEMO_CONTINUATION_PAUSE_BLOCKER] : []),
          ...(demoBrokerCommissionGate.blocked
            ? [`M1_DEMO_BROKER_COMMISSION_${demoBrokerCommissionGate.reason}`]
            : []),
          ...(oppositePositionStateUnavailable ? ['M1_OPPOSITE_POSITION_STATE_UNAVAILABLE'] : []),
          ...(activeOppositePosition ? ['M1_ACTIVE_OPPOSITE_POSITION'] : []),
        ])
      : unique([
          ...researchBlockers,
          ...(ownerLossPausePolicy.fastStopCooldownBlocks ? ['M1_FAST_STOP_REGIME_BRAKE'] : []),
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

    // Audit the M1 specialist independently of the primary Plan B veto.
    // This is a prospective hypothesis for broker-mark, profit-capture and
    // stop-first outcomes. It MUST NOT modify canExecute or broker orders.
    const independentM1OpportunityShadow = professionalDemoPhase
      ? evaluateIndependentM1OpportunityShadow({
          instrument: candidate.instrument,
          direction: candidate.direction,
          route: routeDecision.route,
          evaluatedAt: decisionTime,
          candidateEntry: candidate.entry,
          stopLoss: candidate.stopLoss,
          takeProfit: candidate.takeProfit,
          confidence: candidate.confidence,
          directionQuality: candidate.directionQuality,
          routeEligible: routeDecision.eligible,
          m1PaperEligible: governance.paperEligible,
          m1NetExpectedR: governance.netExpectedR,
          spreadEvidenceValid: governance.genericGovernance.executionSpreadEvidenceValid,
          eventRisk,
          reliability: reliability
            ? {
                eligible: reliability.eligible,
                reason: reliability.reason,
                samples: reliability.samples,
                wins: reliability.wins,
                losses: reliability.losses,
                recentRealizedR: reliability.recentRealizedR,
              }
            : null,
          planB: multimodelDemo
            ? {
                paperAdmitted: multimodelDemo.ensemble.paperAdmitted,
                netExpectedR: multimodelDemo.governance.netExpectedR,
                regime: multimodelDemo.ensemble.regime,
              }
            : null,
        })
      : null;

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

    // Strictly observational, tested against closed-at < decisionTime.
    // Runs only for a broker-native, already-authorized primary candidate.
    // No sidecar result is read by canExecute, broker sizing, or order routing.
    let pepperstonePairSideAsOfShadow: ReturnType<
      typeof evaluatePepperstonePairSideAsOfShadow
    > | null = null;
    if (
      professionalDemoPhase &&
      canExecute &&
      multimodelPrimaryExecutable &&
      demoPrimaryOnlyProbation.chosenAuthorityPath === 'PRIMARY_PLAN_B'
    ) {
      // Research gets a hard wall-clock budget, not unlimited control over
      // the entry-critical M1 path. Late database responses remain ignored.
      let shadowReadTimer: NodeJS.Timeout | null = null;
      try {
        const asOfRows = await Promise.race([
          this.evidence.loadPepperstonePairSideAsOfRows({
            userId,
            brokerConnectionId,
            instrument: candidate.instrument,
            direction: candidate.direction,
            asOf: decisionTime,
          }),
          new Promise<never>((_, reject) => {
            shadowReadTimer = setTimeout(
              () => reject(new Error('PAIR_SIDE_SHADOW_READ_TIMEOUT')),
              350,
            );
            shadowReadTimer.unref?.();
          }),
        ]);
        pepperstonePairSideAsOfShadow = evaluatePepperstonePairSideAsOfShadow(
          asOfRows,
          decisionTime,
        );
      } catch (error) {
        // Never fail or authorize an already-qualified broker order because
        // read-only research history is unavailable.
        pepperstonePairSideAsOfShadow = {
          ...evaluatePepperstonePairSideAsOfShadow([], decisionTime),
          reason: 'HISTORY_LOOKUP_FAILED',
        };
        this.logger.warn(
          'Pepperstone pair-side as-of research unavailable ' +
            candidate.instrument +
            ' ' +
            candidate.direction +
            ': ' +
            (error as Error).message,
        );
      } finally {
        if (shadowReadTimer) clearTimeout(shadowReadTimer);
      }
    }

    // Causal pattern recall reads only settled historical broker trades and
    // never overrides entry admission. Every admitted or blocked Plan-B route
    // is remembered in the tactical decision ledger with this as-of annotation.
    let patternMemory: PatternMemoryObservation | null = null;
    const patternRoute=multimodelDemo?.ensemble.strategyRoute ?? null;
    const recallEnabled=
      professionalDemoPhase &&
      this.config.get<string>('IREXPRO_PEPPERSTONE_DEMO_PATTERN_MEMORY','')==='enabled' &&
      this.config.get<string>('VPS_FOREX_SCANNER_USER_ID','')===userId &&
      !!userId && !!patternRoute &&
      ['EARLY_TRANSITION','CONFIRMED_REVERSAL','TREND_CONTINUATION'].includes(patternRoute);
    if(recallEnabled){
      try{
        const previous=await this.evidence.loadOwnerPepperstoneDemoPatternHistory({
          userId,brokerConnectionId,instrument:candidate.instrument,
          direction:candidate.direction,
          strategyRoute:patternRoute as 'EARLY_TRANSITION'|'CONFIRMED_REVERSAL'|'TREND_CONTINUATION',
          asOf:decisionTime,
        });
        patternMemory=recallPepperstoneDemoPattern({
          now:decisionTime,
          route:patternRoute as 'EARLY_TRANSITION'|'CONFIRMED_REVERSAL'|'TREND_CONTINUATION',
          current:{
            score:candidate.score,extensionAtr:features.extensionAtr,
            volatilityScore:features.volatilityScore,
            emaSeparation:Math.max(0,Math.min(1,candidate.alignedEmaSeparationAtr/2)),
            mtfStrength:Math.max(0,Math.min(1,candidate.alignedM15)),
            rsi14:features.rsi14,
          },
          previous,
        });
      }catch(error){
        // A research-memory outage cannot approve or deny a broker trade.
        this.logger.warn('DEMO pattern-memory lookup unavailable '+candidate.instrument+
          ' '+candidate.direction+': '+(error as Error).message);
      }
    }

    // Frozen pre-entry snapshot of completed broker-native M1 candles. The
    // post-entry label is NEVER available here. All features are observed
    // before any order can be submitted. Scoring is owner DEMO SHADOW-ONLY,
    // and does not participate in canExecute, lot sizing or broker dispatch.
    const observedBrokerCandles =
      brokerMarketContext?.marketDataAuthority === 'BROKER_NATIVE' &&
      brokerMarketContext.connectionId === brokerConnectionId &&
      Number.isFinite(features.latestM1OpenTime.getTime()) &&
      features.latestM1OpenTime.getTime() + 60_000 <= decisionTime.getTime();
    // The scanner's authoritative owner binding is the validated, trimmed
    // vpsForexScanner.userId config used by runOnce(), not an independent raw
    // environment-key lookup (which may be absent in a nested ConfigService).
    // A mismatched broker account still receives MODEL_SCOPE_MISMATCH from
    // the immutable model's connection fingerprint; this is research ONLY.
    const ownerDemoEntryOutcomeShadow =
      professionalDemoPhase && observedBrokerCandles &&
      this.userId() === userId &&
      multimodelDemo
        ? scoreOwnerDemoEntryOutcome({
            brokerConnectionId,
            route: multimodelDemo.ensemble.strategyRoute,
            evaluatedAt: decisionTime,
            featureValues: {
              alignedM5: candidate.alignedM5,
              m5Body: candidate.alignedM5LatestBodyPressure,
              alignedH1: candidate.alignedH1,
              alignedH4: candidate.alignedH4,
              alignedM1Momentum3: candidate.alignedMomentum3Atr,
              planBScore: multimodelDemo.ensemble.ensembleScore,
              forecastNetR: multimodelDemo.governance.netExpectedR,
            },
          })
        : null;
    const ownerDemoPreEntryCandleSnapshot = observedBrokerCandles ? {
      artifact: 'owner-demo-broker-native-completed-candle-asof-v1',
      researchOnly: true,
      modifiesExecution: false,
      grantsTradeAuthority: false,
      observedAt: decisionTime.toISOString(),
      latestCompletedM1BarOpen: features.latestM1OpenTime.toISOString(),
      source: brokerMarketContext?.candleSource ?? null,
      m1BodyRangeRatio: features.bodyRangeRatio,
      m1CloseAligned:
        candidate.direction === 'BUY'
          ? 2 * features.closeLocation - 1
          : 1 - 2 * features.closeLocation,
      m1OpposingWickRatio:
        candidate.direction === 'BUY'
          ? features.upperWickRatio
          : features.lowerWickRatio,
      m1SupportiveWickRatio:
        candidate.direction === 'BUY'
          ? features.lowerWickRatio
          : features.upperWickRatio,
      m5AlignedLatestBodyPressure: candidate.alignedM5LatestBodyPressure ?? null,
      m5AlignedBodyPressure3: candidate.alignedM5BodyPressure3,
      m1AlignedMomentum3Atr: candidate.alignedMomentum3Atr,
      alignedH1: candidate.alignedH1,
      alignedH4: candidate.alignedH4,
    } : null;

    // This is evaluated and persisted BEFORE submitPaperDecision; the
    // independent research observation NEVER changes canExecute or broker
    // behavior. Verify USD explicitly: the existing loss-advisory USD check
    // is only run when an actual loss brake is active, not on clean entries.
    const preDispatchResearchRequested = this.config.get<string>(
      'IREXPRO_OWNER_DEMO_PREDISPATCH_FEE_CONFLUENCE_SHADOW',
      '',
    ) === 'enabled';
    const preDispatchOwnerVerified = !!userId &&
      this.config.get<string>('VPS_FOREX_SCANNER_USER_ID', '') === userId;
    let preDispatchUsdAccountVerified = ownerDemoDiscretionaryPausesAdvisory;
    if (preDispatchResearchRequested && preDispatchOwnerVerified &&
        professionalDemoPhase && canExecute && advisoryBrokerVerified &&
        multimodelDemo?.ensemble.strategyRoute === 'CONFIRMED_REVERSAL' &&
        !preDispatchUsdAccountVerified) {
      try {
        // Existing DB-backed verifier; not an order endpoint. Failure
        // abstains from research and does NOT veto a qualified trade.
        preDispatchUsdAccountVerified =
          await this.evidence.isPepperstoneUsdDemoBrokerConnection({
            userId, brokerConnectionId,
          });
      } catch (error) {
        this.logger.warn('Owner DEMO pre-dispatch research scope unavailable: ' +
          (error as Error).message);
      }
    }
    const ownerDemoPreDispatchFeeConfluenceShadow =
      evaluateOwnerDemoPreDispatchConfluence({
        featureEnabled: preDispatchResearchRequested,
        exactOwner: preDispatchOwnerVerified,
        exactPepperstoneDemoBrokerVerified:
          advisoryBrokerVerified && preDispatchUsdAccountVerified,
        professionalDemoPhase,
        candidateAdmittedForDispatch: canExecute,
        decisionTime,
        strategyRoute: multimodelDemo?.ensemble.strategyRoute ?? null,
        m1Route: routeDecision.route,
        trainedExpertState: multimodelDemo?.trainedExpert.state ?? null,
        feeShadowReason: demoBrokerCommissionShadowGate?.reason ?? null,
        feeShadowSampleCount: demoBrokerCommissionShadowGate?.sampleCount ?? null,
        feeShadowAfterFeeExpectedR:
          demoBrokerCommissionShadowGate?.afterFeeExpectedR ?? null,
        feeShadowRequiredFloorR:
          demoBrokerCommissionShadowGate?.minimumAfterFeeR ?? null,
        alignedH1: candidate.alignedH1,
        alignedM5: candidate.alignedM5,
        negativePayoff: multimodelLossStreakBrake?.negativePayoff === true,
        recentPayoffClosedTrades:
          multimodelLossStreakBrake?.payoffClosedTrades ?? null,
        recentClosedTrades:
          multimodelLossStreakBrake?.recentClosedTrades ?? null,
      });
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
        patternMemory,
        ownerDemoPreDispatchFeeConfluenceShadow,
        ownerDemoEntryOutcomeShadow,
        ownerDemoPreEntryCandleSnapshot,
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
        oppositeM1AtSignal: {
          artifact: 'm1-opposite-tactical-same-snapshot-v1',
          direction: opposite.direction,
          route: oppositeRouteAtSignal.route,
          eligible: oppositeRouteAtSignal.eligible,
          reason: oppositeRouteAtSignal.reason,
          scoreEdge: oppositeRouteAtSignal.scoreEdge,
          policyVersion: oppositeRouteAtSignal.policyVersion,
          decisionTime: decisionTime.toISOString(),
          executionAuthority: 'NONE',
          modifiesExecution: false,
          grantsOppositeTrade: false,
        },
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
        executionVolumeCap: selectedExecutionVolumeCap,
        qualifiedContinuationCanaryRecentlyAuthorized,
        qualifiedContinuationCanaryHistoryUnavailable,
        recoveryCanary: recoveryCanary || false,
        ownerDemoRecoveryCanarySizing,
        crossSleeveReversalCanary,
        recoveryCanaryHistoryUnavailable,
        recoveryCanaryRecentlyAuthorized,
        professionalM1Fallback,
        professionalM1FallbackExecutionEnabled: professionalM1FallbackExecutable,
        microDriftOnlyRescue,
        localImpulseDriftOnlyRescue,
        rolloutPolicyVersion: this.rolloutPolicy.version,
        rolloutPhase: this.rolloutPolicy.phase,
        routeNetExpectedRFloor,
        fastStopRegimeBrake: fastStopRegimeBrake ? { ...fastStopRegimeBrake } : null,
        portfolioNetLossBrake: portfolioNetLossBrake ? { ...portfolioNetLossBrake } : null,
        ownerAcceptedPortfolioBrake,
        demoPrimaryOnlyProbation: { ...demoPrimaryOnlyProbation },
        demoContinuationPause,
        guardedPullback,
        demoAlternativeTrial,
        counterPilot,
        advisoryAlternateTrial,
        qualifiedContinuationAfterFeeEvidence,
        demoBrokerCommissionGate: commissionGateAudit,
        productionQualificationShadow,
        pepperstonePairSideAsOfShadow,
        secondaryPredictedCostShadow,
        independentM1OpportunityShadow,
        lowVolRangeShadow,
        ownerApprovedStrategyContinuation,
        ownerLossPausePolicy,
        multimodelLossStreakBrake: multimodelLossStreakBrake
          ? { ...multimodelLossStreakBrake }
          : null,
        primaryEngineCode: professionalDemoPhase
          ? MULTIMODEL_DEMO_ENGINE_CODE
          : 'irexpro-m1-tactical',
        m1TacticalRole: professionalDemoPhase ? 'TIMING_SPECIALIST' : 'PRIMARY_RESEARCH_ROUTE',
        multimodelEnsemble: multimodelDemo?.ensemble ?? null,
        // Clock-factor counterfactual is a persisted, prospective RESEARCH
        // SIDE-CAR. Nothing consumes it for execution, admission, SL/TP,
        // portfolio allocation, or deployment/promotion.
        planBClockNeutralResearch: multimodelDemo
          ? scorePlanBClockNeutralResearch(
              m1CandidateToPlanBInput(candidate, features, decisionTime),
            )
          : null,
        planBReversalM1ContinuationShadow,
        multimodelGovernance: multimodelDemo?.governance ?? null,
        multimodelTrainedExpert: multimodelDemo?.trainedExpert ?? null,
        multimodelAuthority: multimodelDemo?.authority ?? null,
        primaryPlanBBlockersSupersededByDemoAlternate:
          professionalDemoPhase && demoAlternativeTrial.eligible
            ? (multimodelDemo?.authority.blockers ?? [])
            : [],
        primaryPlanBBlockersSupersededResearchOnly: true,
        multimodelPortfolioSnapshotAvailable: multimodelDemo?.portfolioSnapshotAvailable ?? null,
        demoProfitabilityReliabilityGate,
        zaiDemoDiagnostics,
        directionFlipConflict: activeOppositePosition
          ? {
              candidateDirection: candidate.direction,
              oppositeTradeIds: activeOppositePositions.map((position) => position.tradeId),
              confirmedReversal: false,
              exitRequested: false,
              action: 'WAIT_EXISTING_OPPOSITE_POSITION',
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
      const dispatchStartedAt = Date.now();
      try {
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
          selectedExecutionVolumeCap,
          multimodelDemo,
          professionalM1Fallback,
          m5EarlyTransitionEvidence,
          m5EarlyTransitionHandoff,
          extensionExhaustionDemoScout,
          demoAlternativeTrial,
          guardedPullback.eligible,
          brokerMarketContext,
          patternMemory,
          ownerAcceptedPortfolioBrake ? portfolioNetLossBrake?.latestClosedAt : null,
          oppositeRouteAtSignal,
          {
            feeShadowReason: demoBrokerCommissionShadowGate?.reason ?? null,
            feeShadowPriorSamples: demoBrokerCommissionShadowGate?.sampleCount ?? null,
            modelLossStreakActive: multimodelLossStreakBrake?.active === true,
            modelLossStreakReason: multimodelLossStreakBrake?.reason ?? null,
          },
        );
      } finally {
        timings.orderDispatchMs = Math.max(0, Date.now() - dispatchStartedAt);
      }
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
          ' modelPortfolioMs=' +
          multimodelSubphases.portfolioMs +
          ' trainedExpertMs=' +
          multimodelSubphases.trainedExpertMs +
          ' m5StageMs=' +
          timings.m5StageMs +
          ' extensionStageMs=' +
          timings.extensionStageMs +
          ' downstreamRiskMs=' +
          timings.downstreamRiskMs +
          ' orderDispatchMs=' +
          timings.orderDispatchMs +
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
    pepperstoneDemoRiskPilot = false,
    demoTrialPreScreenRiskPercent?: number,
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

    const riskAdjustedVolumeCap = pepperstoneDemoRiskPilot
      ? capM1DemoRequestedVolumeByRisk({
          allocatedCapital,
          instrument: candidate.instrument,
          entryPrice: candidate.entry,
          stopLoss: candidate.stopLoss,
          requestedVolumeCap,
          ...(demoTrialPreScreenRiskPercent !== undefined
            ? { maxTradeRiskPercent: demoTrialPreScreenRiskPercent }
            : {}),
          volumeStep: 0.001,
        }).volumeCap
      : requestedVolumeCap;
    return findLargestClearM1Volume({
      allocatedCapital,
      positions,
      candidate: {
        instrument: candidate.instrument,
        direction: candidate.direction,
        entryPrice: candidate.entry,
        stopLoss: candidate.stopLoss,
      },
      requestedVolumeCap: riskAdjustedVolumeCap,
      ...(pepperstoneDemoRiskPilot
        ? {
            alignedReducePercent: M1_PEPPERSTONE_DEMO_ALIGNED_CURRENCY_TARGET_PERCENT,
            alignedBlockPercent: M1_PEPPERSTONE_DEMO_ALIGNED_CURRENCY_BLOCK_PERCENT,
          }
        : {}),
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
    demoAlternativeTrial:
      | DemoAlternativeTrialDecision
      | CounterPilotDecision
      | AdvisoryAlternateTrialDecision
      | null = null,
    guardedPullbackRecovery = false,
    brokerMarketContext?: M1TacticalMarketSnapshot,
    patternMemory?: PatternMemoryObservation | null,
    ownerPortfolioBrakeIncidentClosedAt?: Date | null,
    oppositeRouteAtSignal?: M1TacticalRouteDecision,
    weakReversalEvidence?: {
      feeShadowReason: string | null;
      feeShadowPriorSamples: number | null;
      modelLossStreakActive: boolean;
      modelLossStreakReason: string | null;
    },
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
      demoAlternativeTrial?.eligible !== true &&
      m5EarlyTransitionHandoff?.eligible === true &&
      m5EarlyTransitionEvidence !== null;
    const useProfessionalM1Fallback =
      professionalDemoPhase &&
      demoAlternativeTrial?.eligible !== true &&
      !useM5EarlyTransitionHandoff &&
      professionalM1FallbackExecutionEnabled(professionalM1Fallback);
    const useExtensionExhaustionDemoScout =
      professionalDemoPhase &&
      demoAlternativeTrial?.eligible !== true &&
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

    // Revalidate immediately before submitting an order intent. Consent to
    // an older incident never authorizes trading through new broker losses.
    if (ownerPortfolioBrakeIncidentClosedAt) {
      let approvedNow = false;
      try {
        const current = await this.evidence.loadPortfolioNetLossStreakBrake({
          userId, brokerConnectionId, tradingSessionId: session!.id,
          evaluatedAt: new Date(),
        });
        approvedNow =
          current.active === true &&
          current.reason === 'RECENT_PORTFOLIO_NET_LOSS_STREAK' &&
          current.latestClosedAt?.getTime() === ownerPortfolioBrakeIncidentClosedAt.getTime() &&
          !!this.demoPortfolioBrakeConsent &&
          await this.demoPortfolioBrakeConsent.isOverrideActive({
            userId, brokerConnectionId, sessionId: session!.id,
            latestClosedAt: ownerPortfolioBrakeIncidentClosedAt,
          });
      } catch {
        approvedNow = false;
      }
      if (!approvedNow) {
        await this.evidence.markOutcomeState(
          decisionId, 'RISK_REJECTED', new Date(),
          'M1_DEMO_PORTFOLIO_BRAKE_OWNER_CONSENT_EXPIRED_OR_REVOKED',
        );
        return;
      }
    }

    // Historical finite pilots still verify their timebox and entry budget.
    // Continuous, owner-verified Pepperstone DEMO advisory does not have an
    // experimental order-count or expiry cutoff, but MUST keep fresh signals
    // and a second fail-closed exact-broker identity check before submission.
    if (demoAlternativeTrial?.eligible) {
      const now = Date.now();
      const continuousAdvisory =
        demoAlternativeTrial.artifact === ADVISORY_ALTERNATE_ARTIFACT &&
        demoAlternativeTrial.continuousEvidence === true;
      if (
        (demoAlternativeTrial.endsAt !== null && now >= Date.parse(demoAlternativeTrial.endsAt)) ||
        now - decisionTime.getTime() > 120_000 ||
        now < decisionTime.getTime()
      ) {
        await this.evidence.markOutcomeState(
          decisionId,
          'RISK_REJECTED',
          new Date(),
          'M1_DEMO_ALTERNATIVE_TRIAL_EXPIRED_OR_STALE',
        );
        return;
      }
      if (continuousAdvisory) {
        const ownerId = this.config.get<string>('VPS_FOREX_SCANNER_USER_ID', '');
        const enabledNow =
          this.config.get<string>('IREXPRO_PEPPERSTONE_DEMO_CONTINUOUS_ALTERNATES', '') ===
          'enabled';
        let verifiedNow = false;
        if (enabledNow && !!ownerId && ownerId === userId) {
          try {
            verifiedNow = await this.evidence.isPepperstoneDemoBrokerConnection({
              userId,
              brokerConnectionId,
            });
          } catch (error) {
            this.logger.warn(
              'Continuous DEMO advisory broker revalidation unavailable: ' +
                (error as Error).message,
            );
          }
        }
        if (!verifiedNow) {
          await this.evidence.markOutcomeState(
            decisionId,
            'RISK_REJECTED',
            new Date(),
            'M1_DEMO_CONTINUOUS_ADVISORY_OWNER_OR_BROKER_NOT_VERIFIED',
          );
          return;
        }
      } else
        try {
          const counterSelected = demoAlternativeTrial.artifact === COUNTER_PILOT_ARTIFACT;
          const advisorySelected = demoAlternativeTrial.artifact === ADVISORY_ALTERNATE_ARTIFACT;
          const count = await this.evidence.loadDemoAlternativeTrialEntryCount({
            userId,
            brokerConnectionId,
            ...(counterSelected
              ? { startsAt: COUNTER_PILOT_START, endsAt: COUNTER_PILOT_END }
              : advisorySelected
                ? { startsAt: ADVISORY_ALTERNATE_START, endsAt: ADVISORY_ALTERNATE_END }
                : {}),
          });
          if (
            count >=
            (counterSelected
              ? COUNTER_PILOT_ENTRY_LIMIT
              : advisorySelected
                ? ADVISORY_ALTERNATE_ENTRY_LIMIT
                : DEMO_ALTERNATIVE_TRIAL_ENTRY_LIMIT)
          ) {
            await this.evidence.markOutcomeState(
              decisionId,
              'RISK_REJECTED',
              new Date(),
              'M1_DEMO_ALTERNATIVE_TRIAL_ENTRY_LIMIT_REACHED',
            );
            return;
          }
        } catch {
          await this.evidence.markOutcomeState(
            decisionId,
            'RISK_REJECTED',
            new Date(),
            'M1_DEMO_ALTERNATIVE_TRIAL_ENTRY_COUNT_UNAVAILABLE',
          );
          return;
        }
    }

    // This control acts ONLY on the exact owned Pepperstone cTrader DEMO
    // connection. Existing generic cTrader/IC Markets/PAPER/LIVE sizing is
    // unchanged. The same-side cooldown follows only a confirmed broker
    // PROFIT_PROTECTION close; it is NOT a scanner-wide trade-rate throttle.
    let pepperstoneDemoRiskPilot = false;
    if (professionalDemoPhase) {
      try {
        pepperstoneDemoRiskPilot = await this.evidence.isPepperstoneDemoBrokerConnection({
          userId,
          brokerConnectionId,
        });
        if (pepperstoneDemoRiskPilot) {
          const recentProtectedExit = await this.evidence.loadRecentlyProtectedSameSideReentry({
            userId,
            brokerConnectionId,
            instrument: candidate.instrument,
            direction: candidate.direction,
            evaluatedAt: decisionTime,
          });
          if (recentProtectedExit.active) {
            await this.evidence.markOutcomeState(
              decisionId,
              'RISK_REJECTED',
              new Date(),
              'M1_PEPPERSTONE_DEMO_SAME_SIDE_PROTECTED_EXIT_COOLDOWN ' +
                `remainingSeconds=${recentProtectedExit.cooldownRemainingSeconds} ` +
                'sameInstrument=true sameDirection=true otherPairsUnaffected=true',
            );
            return;
          }
        }
      } catch (error) {
        // A missing broker identity or recent-exit history must not silently
        // revert to the old unprotected 4-lot sizing path for this DEMO.
        await this.evidence.markOutcomeState(
          decisionId,
          'RISK_REJECTED',
          new Date(),
          'M1_DEMO_BROKER_SCOPE_OR_REENTRY_HISTORY_UNAVAILABLE',
        );
        this.logger.warn(
          'M1 DEMO broker risk pilot evidence unavailable instrument=' +
            candidate.instrument +
            ' reason=' +
            (error as Error).message,
        );
        return;
      }
    }
    if (demoAlternativeTrial?.eligible && !pepperstoneDemoRiskPilot) {
      await this.evidence.markOutcomeState(
        decisionId,
        'RISK_REJECTED',
        new Date(),
        'M1_DEMO_ALTERNATIVE_TRIAL_BROKER_NOT_VERIFIED',
      );
      return;
    }
    // The owner-verified, opt-in continuous DEMO advisory can continue to
    // collect independent trades with no cumulative quota while reflecting
    // weaker confirmation and as-of paid-fee losses in its requested lot cap.
    // Existing broker margin, stop, currency exposure and portfolio checks
    // remain authoritative. No negative trade history is a permanent veto.
    const qualityRiskEnabled =
      pepperstoneDemoRiskPilot &&
      demoAlternativeTrial?.eligible === true &&
      demoAlternativeTrial.artifact === ADVISORY_ALTERNATE_ARTIFACT &&
      demoAlternativeTrial.continuousEvidence === true &&
      this.config.get<string>('IREXPRO_PEPPERSTONE_DEMO_ADVISORY_QUALITY_RISK', '') === 'enabled' &&
      this.config.get<string>('VPS_FOREX_SCANNER_USER_ID', '') === userId;
    let qualityRisk: ReturnType<typeof evaluatePepperstoneDemoAdvisoryQuality> | null = null;
    if (qualityRiskEnabled && multimodelDemo) {
      let recent: Awaited<ReturnType<
        M1TacticalEvidenceService['loadOwnerPepperstoneDemoAdvisoryRecentNet']
      >> | null = null;
      try {
        recent = await this.evidence.loadOwnerPepperstoneDemoAdvisoryRecentNet({
          userId, brokerConnectionId, instrument: candidate.instrument,
          direction: candidate.direction,
          strategyRoute: multimodelDemo.ensemble.strategyRoute as
            'CONFIRMED_REVERSAL'|'EARLY_TRANSITION',
          asOf: decisionTime,
        });
      } catch (error) {
        // Missing history must not restore full-size DOUBLE_ABSTAIN entries.
        this.logger.warn(
          'DEMO advisory historical after-fee evidence unavailable: ' +
            (error as Error).message,
        );
      }
      qualityRisk = evaluatePepperstoneDemoAdvisoryQuality({
        route: multimodelDemo.ensemble.strategyRoute,
        m1Route: routeDecision.route,
        expertState: multimodelDemo.trainedExpert.state,
        expertDirection: multimodelDemo.trainedExpert.direction,
        signalDirection: candidate.direction,
        expertProbability: multimodelDemo.trainedExpert.meanOpportunityProbability,
        decisionTime, stopDistance: candidate.stopDistance,
        m5: brokerMarketContext?.m5,
        h1: brokerMarketContext?.h1,
        recent,
      });
    }
    // High-conviction is an OPTIONAL CEILING, not a lot instruction. No
    // independent expert confirmation, broad model disagreement, poor
    // after-cost expectancy, or a stop tight to ATR/spread => keep 4 lots.
    // Never modify the original broker stop/TP to fit a larger requested lot.
    const highConvictionCeiling = evaluatePepperstoneDemoHighConvictionCeiling({
      enabled:
        this.config.get<string>('IREXPRO_PEPPERSTONE_DEMO_HIGH_CONVICTION_6LOT', '') === 'enabled',
      ownerVerifiedPepperstoneUsdDemo:
        pepperstoneDemoRiskPilot &&
        !!userId &&
        this.config.get<string>('VPS_FOREX_SCANNER_USER_ID', '') === userId,
      continuousAlternate:
        demoAlternativeTrial?.eligible === true &&
        demoAlternativeTrial.artifact === ADVISORY_ALTERNATE_ARTIFACT &&
        demoAlternativeTrial.continuousEvidence === true,
      baseVolumeCap: executionVolumeCap,
      route: multimodelDemo?.ensemble.strategyRoute ?? null,
      direction: candidate.direction,
      planBAdmitted: multimodelDemo?.ensemble.paperAdmitted === true,
      governanceEligible: multimodelDemo?.governance.paperExecutionEligible === true,
      planBScore: multimodelDemo?.ensemble.ensembleScore ?? null,
      planBDirectionQuality: multimodelDemo?.ensemble.directionQuality ?? null,
      netExpectedR: multimodelDemo?.governance.netExpectedR ?? null,
      spreadEvidenceValid: multimodelDemo?.governance.executionSpreadEvidenceValid === true,
      eventRisk: multimodelDemo?.governance.eventRisk ?? 'UNKNOWN',
      driftState: multimodelDemo?.governance.driftState ?? 'UNKNOWN',
      expertState: multimodelDemo?.trainedExpert.state ?? null,
      expertDirection: multimodelDemo?.trainedExpert.direction ?? null,
      expertAdmitted: multimodelDemo?.trainedExpert.admitted ?? null,
      expertNative: multimodelDemo?.trainedExpert.allBrokerNative === true,
      expertProbability: multimodelDemo?.trainedExpert.meanOpportunityProbability ?? null,
      expertFreshnessSeconds: multimodelDemo?.trainedExpert.freshnessSeconds ?? null,
      m1Route: routeDecision.route,
      m1Confidence: candidate.confidence,
      m1DirectionQuality: candidate.directionQuality,
      m5Direction: qualityRisk?.m5Direction ?? null,
      h1Direction: qualityRisk?.h1Direction ?? null,
      qualityRiskFraction: qualityRisk?.riskFraction ?? null,
      patternHypothesis: patternMemory?.hypothesis ?? null,
      stopDistance: candidate.stopDistance,
      m1Atr14: features.atr14,
      brokerSpreadPrice: brokerMarketContext?.spreadEvidence?.spreadPrice ?? null,
      targetDistance: candidate.targetDistance,
      guardedPullback: guardedPullbackRecovery,
    });
    // Owner reaffirmed ongoing USD DEMO requests up to seven lots after the
    // previous noon trial expired. The same strict owner/connection identity
    // and full broker stop-risk, drawdown, margin and model safeguards remain.
    // This NEVER guarantees 4/4.5/6/7 actual lots or grants LIVE authority.
    const ongoingSevenLot = ownerPepperstoneDemoOngoingSevenLot({
      enabled: this.config.get<string>(
        'IREXPRO_OWNER_PEPPERSTONE_DEMO_ONGOING_7LOT_20261120',
        '',
      ) === 'enabled',
      userId,
      configuredOwnerId: this.config.get<string>('VPS_FOREX_SCANNER_USER_ID', ''),
      brokerConnectionId,
      configuredBrokerConnectionId: this.config.get<string>(
        'IREXPRO_OWNER_PEPPERSTONE_DEMO_NOON_TRIAL_BROKER_CONNECTION_ID',
        '',
      ),
      brokerId: pepperstoneDemoRiskPilot ? 'pepperstone-ctrader' : null,
      accountType: pepperstoneDemoRiskPilot ? 'DEMO' : null,
      accountCurrency: pepperstoneDemoRiskPilot ? 'USD' : null,
      now: new Date(),
    });
    const historicNoonLotTrial = ownerPepperstoneDemoNoonLotTrial({
      enabled: this.config.get<string>(
        'IREXPRO_OWNER_PEPPERSTONE_DEMO_4PLUS_UNTIL_NOON_20261120',
        '',
      ) === 'enabled',
      userId,
      configuredOwnerId: this.config.get<string>('VPS_FOREX_SCANNER_USER_ID', ''),
      brokerConnectionId,
      configuredBrokerConnectionId: this.config.get<string>(
        'IREXPRO_OWNER_PEPPERSTONE_DEMO_NOON_TRIAL_BROKER_CONNECTION_ID',
        '',
      ),
      brokerId: pepperstoneDemoRiskPilot ? 'pepperstone-ctrader' : null,
      accountType: pepperstoneDemoRiskPilot ? 'DEMO' : null,
      accountCurrency: pepperstoneDemoRiskPilot ? 'USD' : null,
      now: new Date(),
    });
    // New explicit ongoing permission wins only on the same verified DEMO;
    // preserve the historical finite-trial behavior for historical tests.
    const noonLotTrial = ongoingSevenLot.eligible
      ? ongoingSevenLot
      : historicNoonLotTrial;
    const noonLotTrialForAdmittedReversal =
      noonLotTrial.eligible &&
      qualityRiskEnabled &&
      demoAlternativeTrial?.eligible === true &&
      demoAlternativeTrial.artifact === ADVISORY_ALTERNATE_ARTIFACT &&
      demoAlternativeTrial.continuousEvidence === true &&
      ['CONFIRMED_REVERSAL', 'EARLY_TRANSITION'].includes(
        multimodelDemo?.ensemble.strategyRoute ?? '',
      ) &&
      !guardedPullbackRecovery &&
      !useProfessionalM1Fallback &&
      !useM5EarlyTransitionHandoff;
    const maxRequestedBeforeQuality = noonLotTrialForAdmittedReversal
      ? noonLotTrial.maxRequestedLots
      : highConvictionCeiling.eligible
        ? highConvictionCeiling.maxLotCeiling
        : executionVolumeCap;
    // During the owner-authorized DEMO trial, suspend the *advisory* lot
    // multiplier only. The independent M5 weak-entry soft cap, hard broker
    // risk-at-stop, drawdown, currency exposure and margin all still apply.
    const qualityAdjustedVolumeCap = noonLotTrialForAdmittedReversal
      ? maxRequestedBeforeQuality
      : qualityRisk
        ? Math.min(maxRequestedBeforeQuality,
            maxRequestedBeforeQuality * qualityRisk.riskFraction)
        : maxRequestedBeforeQuality;
    // Owner DEMO only: seven-lot trial can bypass the pre-existing advisory
    // quality multiplier. Restore the STANDARD requested four-lot CEILING
    // on weak Confirmed Reversal when independent pre-decision broker fee
    // or completed recent-loss evidence ALSO warns. No entry veto/lot floor.
    const weakReversalCap = evaluateOwnerDemoWeakReversalCap({
      enabled: this.config.get<string>(
        'IREXPRO_OWNER_DEMO_WEAK_REVERSAL_4LOT_CEILING',
        '',
      ) === 'enabled',
      exactOwnerVerified: qualityRiskEnabled && pepperstoneDemoRiskPilot &&
        !!userId &&
        this.config.get<string>('VPS_FOREX_SCANNER_USER_ID', '') === userId,
      ongoingSevenLotEligible: ongoingSevenLot.eligible && noonLotTrialForAdmittedReversal,
      continuousDemoAlternate: demoAlternativeTrial?.eligible === true &&
        demoAlternativeTrial.artifact === ADVISORY_ALTERNATE_ARTIFACT &&
        demoAlternativeTrial.continuousEvidence === true,
      route: multimodelDemo?.ensemble.strategyRoute ?? null,
      requestedLotCap: qualityAdjustedVolumeCap,
      independentQualityRiskFraction: qualityRisk?.riskFraction ?? null,
      feeShadowReason: weakReversalEvidence?.feeShadowReason ?? null,
      feeShadowPriorSamples: weakReversalEvidence?.feeShadowPriorSamples ?? null,
      modelLossStreakActive: weakReversalEvidence?.modelLossStreakActive === true,
      modelLossStreakReason: weakReversalEvidence?.modelLossStreakReason ?? null,
    });
    // Prospective owner-Pepperstone DEMO-only loss mitigation. The frozen
    // CONFIRMED_REVERSAL entry cohort with M5 opposition is net losing.
    // Apply a *soft lot ceiling*, never a new trade veto, direction flip, or
    // broker SL/TP change. Require independent completed native M5 evidence.
    const m5ReversalSoftCap = evaluatePepperstoneDemoM5ReversalSoftCap({
      enabled:
        this.config.get<string>('IREXPRO_PEPPERSTONE_DEMO_M5_REVERSAL_SOFT_CAP', '') ===
          'enabled',
      ownerVerifiedUsdDemo: qualityRiskEnabled,
      route: multimodelDemo?.ensemble.strategyRoute ?? null,
      alignedM5: Number.isFinite(candidate.alignedM5) ? candidate.alignedM5 : null,
      brokerM5Direction: qualityRisk?.m5Direction ?? null,
      requestedLotCap: weakReversalCap.requestedLotCap,
    });
    const currencyExposureGuard = await this.resolveM1CurrencyExposureGuard(
      userId,
      brokerConnectionId,
      candidate,
      guardedPullbackRecovery
        ? Math.min(m5ReversalSoftCap.requestedLotCap, 0.2)
        : m5ReversalSoftCap.requestedLotCap,
      pepperstoneDemoRiskPilot,
      noonLotTrialForAdmittedReversal
        ? noonLotTrial.maximumPrescreenRiskPercent
        : undefined,
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

    // Broker eligibility can take seconds. Refuse stale M1 predictions at
    // final dispatch regardless of pilot mode; old finite trials also keep
    // their cutoff, but owner-verified continuous DEMO studies do not expire.
    if (demoAlternativeTrial?.eligible) {
      const now = Date.now();
      if (
        (demoAlternativeTrial.endsAt !== null && now >= Date.parse(demoAlternativeTrial.endsAt)) ||
        now - decisionTime.getTime() > 120_000 ||
        now < decisionTime.getTime()
      ) {
        await this.evidence.markOutcomeState(
          decisionId,
          'RISK_REJECTED',
          new Date(),
          'M1_DEMO_ALTERNATIVE_TRIAL_PRE_DISPATCH_EXPIRED_OR_STALE',
        );
        return;
      }
    }

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

    // Retired finite trials still expire at the last application dispatch.
    // The explicitly configured ongoing DEMO permission has no expiry and
    // cannot carry a stale historical noon artifact into new trade intents.
    if (noonLotTrialForAdmittedReversal && noonLotTrial.endsAt !== null &&
        Date.now() >= Date.parse(noonLotTrial.endsAt)) {
      await this.evidence.markOutcomeState(
        decisionId, 'RISK_REJECTED', new Date(),
        'OWNER_PEPPERSTONE_DEMO_NOON_LOT_TRIAL_EXPIRED_BEFORE_DISPATCH',
      );
      return;
    }
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
          multimodel_execution_authority_path: demoAlternativeTrial?.eligible
            ? demoAlternativeTrial.artifact === COUNTER_PILOT_ARTIFACT
              ? 'DEMO_EXPERT_COUNTER_ENTRY_PILOT'
              : demoAlternativeTrial.artifact === ADVISORY_ALTERNATE_ARTIFACT
                ? demoAlternativeTrial.continuousEvidence
                  ? 'DEMO_CONTINUOUS_REVERSAL_EARLY_EVIDENCE'
                  : 'DEMO_ADVISORY_REVERSAL_EARLY_ENTRY_PILOT'
                : 'DEMO_ALTERNATIVE_TIMING_TRIAL'
            : useProfessionalM1Fallback
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
          m1_pattern_memory_artifact: patternMemory?.artifact ?? null,
          m1_pattern_memory_matching_episodes: patternMemory?.matchingEpisodes ?? null,
          m1_pattern_memory_hypothesis: patternMemory?.hypothesis ?? null,
          m1_pattern_memory_average_net_r: patternMemory?.averageNetR ?? null,
          m1_pattern_memory_positive_then_lost: patternMemory?.positiveThenLost ?? null,
          m1_pattern_memory_adverse_then_won: patternMemory?.adverseThenWon ?? null,
          m1_pattern_memory_near_stop_then_won: patternMemory?.nearStopThenWon ?? null,
          m1_pattern_memory_shadow_only: patternMemory?.shadowOnly ?? null,
          position_sizing_tier:
            this.rolloutPolicy.phase === 'DEMO_EARLY_TRANSITION_PROFESSIONAL'
              ? m1ProfessionalSizingTier(candidate.confidence)
              : 'RESEARCH',
          m1_guarded_pullback_continuation: guardedPullbackRecovery,
          m1_tactical_route: routeDecision.route,
          // This is the paired tactical snapshot BEFORE submitting an order.
          // It is not the opposite-side trained-expert vote, a broker fill
          // forecast, or independent order authority.
          m1_opposite_tactical_route_asof: oppositeRouteAtSignal?.route ?? null,
          m1_opposite_tactical_reason_asof: oppositeRouteAtSignal?.reason ?? null,
          m1_opposite_tactical_direction_asof:
            oppositeRouteAtSignal ? (candidate.direction === 'BUY' ? 'SELL' : 'BUY') : null,
          m1_opposite_tactical_eligible_asof: oppositeRouteAtSignal?.eligible ?? null,
          m1_opposite_tactical_snapshot_time: decisionTime.toISOString(),
          m1_opposite_tactical_shadow_only: true,
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
          m1_high_conviction_ceiling_artifact: highConvictionCeiling.artifact,
          m1_high_conviction_ceiling_eligible: highConvictionCeiling.eligible,
          m1_high_conviction_ceiling_reason: highConvictionCeiling.reason,
          m1_high_conviction_ceiling_lots: highConvictionCeiling.maxLotCeiling,
          m1_high_conviction_stop_unchanged: true,
          m1_advisory_quality_risk_artifact: qualityRisk?.artifact ?? null,
          m1_advisory_quality_risk_fraction: qualityRisk?.riskFraction ?? null,
          m1_advisory_quality_risk_rationale: qualityRisk?.rationale ?? null,
          m1_advisory_quality_m5_direction: qualityRisk?.m5Direction ?? null,
          m1_advisory_quality_h1_direction: qualityRisk?.h1Direction ?? null,
          m1_advisory_quality_recent_net_samples: qualityRisk?.recentSamples ?? null,
          m1_advisory_quality_recent_average_net_r: qualityRisk?.recentAverageNetR ?? null,
          m1_owner_demo_weak_reversal_ceiling_artifact: weakReversalCap.artifact,
          m1_owner_demo_weak_reversal_ceiling_applied: weakReversalCap.applied,
          m1_owner_demo_weak_reversal_ceiling_reason: weakReversalCap.reason,
          m1_owner_demo_weak_reversal_ceiling_before_lots: weakReversalCap.originalRequestedLots,
          m1_owner_demo_weak_reversal_ceiling_after_lots: weakReversalCap.requestedLotCap,
          m1_owner_demo_weak_reversal_ceiling_fee_warning: weakReversalCap.feeWarningAccepted,
          m1_owner_demo_weak_reversal_ceiling_loss_warning: weakReversalCap.lossWarningAccepted,
          m1_reversal_m5_soft_cap_artifact: m5ReversalSoftCap.artifact,
          m1_reversal_m5_soft_cap_applied: m5ReversalSoftCap.applied,
          m1_reversal_m5_soft_cap_reason: m5ReversalSoftCap.reason,
          m1_reversal_m5_soft_cap_aligned_m5: m5ReversalSoftCap.alignedM5,
          m1_reversal_m5_soft_cap_before_lots: m5ReversalSoftCap.originalLotCap,
          m1_reversal_m5_soft_cap_after_lots: m5ReversalSoftCap.requestedLotCap,
          m1_pepperstone_demo_reentry_and_risk_pilot: pepperstoneDemoRiskPilot,
          m1_pepperstone_demo_alternative_trial: demoAlternativeTrial?.eligible === true,
          m1_pepperstone_demo_advisory_alternates:
            demoAlternativeTrial?.eligible === true &&
            demoAlternativeTrial.artifact === ADVISORY_ALTERNATE_ARTIFACT,
          m1_pepperstone_demo_continuous_evidence:
            demoAlternativeTrial?.eligible === true &&
            demoAlternativeTrial.artifact === ADVISORY_ALTERNATE_ARTIFACT &&
            demoAlternativeTrial.continuousEvidence === true,
          m1_pepperstone_demo_counter_pilot:
            demoAlternativeTrial?.eligible === true &&
            demoAlternativeTrial.artifact === COUNTER_PILOT_ARTIFACT,
          m1_pepperstone_demo_counter_source_side:
            demoAlternativeTrial?.eligible &&
            demoAlternativeTrial.artifact === COUNTER_PILOT_ARTIFACT
              ? demoAlternativeTrial.sourceSide
              : null,
          m1_pepperstone_demo_counter_source_route:
            demoAlternativeTrial?.eligible &&
            demoAlternativeTrial.artifact === COUNTER_PILOT_ARTIFACT
              ? demoAlternativeTrial.sourceRoute
              : null,
          m1_pepperstone_demo_alternative_trial_artifact: demoAlternativeTrial?.eligible
            ? demoAlternativeTrial.artifact
            : null,
          m1_pepperstone_demo_alternative_trial_expires_at: demoAlternativeTrial?.eligible
            ? demoAlternativeTrial.endsAt
            : null,
          m1_pepperstone_demo_max_risk_percent: pepperstoneDemoRiskPilot
            ? noonLotTrialForAdmittedReversal
              ? noonLotTrial.maximumPrescreenRiskPercent
              : 0.25
            : null,
          // Distinct artifact: never falsely label a new ongoing trade as
          // part of the expired 03:57–12:00 UTC size experiment.
          m1_owner_demo_noon_lot_trial_artifact:
            noonLotTrialForAdmittedReversal && !ongoingSevenLot.eligible
              ? OWNER_DEMO_NOON_LOT_TRIAL_ARTIFACT : null,
          m1_owner_demo_noon_lot_trial_expires_at:
            noonLotTrialForAdmittedReversal && !ongoingSevenLot.eligible
              ? noonLotTrial.endsAt : null,
          m1_owner_demo_noon_lot_trial_max_requested_lots:
            noonLotTrialForAdmittedReversal && !ongoingSevenLot.eligible
              ? noonLotTrial.maxRequestedLots : null,
          m1_owner_demo_noon_lot_trial_advisory_quality_fraction:
            noonLotTrialForAdmittedReversal && !ongoingSevenLot.eligible
              ? (qualityRisk?.riskFraction ?? null) : null,
          m1_owner_demo_ongoing_seven_lot_artifact:
            noonLotTrialForAdmittedReversal && ongoingSevenLot.eligible
              ? OWNER_DEMO_ONGOING_SEVEN_LOT_ARTIFACT : null,
          m1_owner_demo_ongoing_seven_lot_max_requested_lots:
            noonLotTrialForAdmittedReversal && ongoingSevenLot.eligible
              ? ongoingSevenLot.maxRequestedLots : null,
          m1_pepperstone_demo_aligned_target_percent: pepperstoneDemoRiskPilot
            ? M1_PEPPERSTONE_DEMO_ALIGNED_CURRENCY_TARGET_PERCENT
            : null,
          m1_pepperstone_demo_pre_screen_lot_cap: finalExecutionVolumeCap,
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
