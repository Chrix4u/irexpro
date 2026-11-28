'use strict';
/**
 * V2 reversal-definition contract — the machine-readable mirror of backlog item
 * P1-2 (`docs/research/AI_ENGINE_V2_P1_2_REVERSAL_DEFINITION_UNIFICATION_SPEC_20261127.md`).
 *
 * Contents: (a) the verified inventory of the six V1 reversal definitions R1-R6
 * with predicates, constants and line references; (b) the frozen synthetic
 * disagreement corpus — twelve borderline decision-time snapshots on which the
 * six definitions disagree today (eleven disagreement records plus one
 * all-reject control), evaluated by faithful research mirrors of the six
 * predicates, never by hardcoded verdicts; (c) RD-1 — the single V2 reversal
 * contract (one column set, one unit per concept, one predicate structure with
 * pre-registered constant slots) with a fail-closed application surface.
 *
 * Research-only: this module grants no order authority, imports no runtime
 * path, and changes no runtime behavior (`executionAuthority: NONE`).
 * `verifyDefinitionPaths()` is the drift detector — CI re-proves on every run
 * that each mapped source still exists; `validateReversalDefinitionContract()`
 * re-proves the six-definition count, the corpus counts, and the computed
 * verdict matrix against the committed expectations, so neither the inventory
 * nor the corpus can silently drift from the spec document.
 *
 * Typed refusals raised by this module:
 *   CONTRACT_INPUT_REQUIRED, CONTRACT_META_INCOMPLETE, CONTRACT_COUNT_MISMATCH,
 *   CONTRACT_DUPLICATE_KEY, CONTRACT_MISSING_FIELD, CONTRACT_CONSTANT_MALFORMED,
 *   CONTRACT_CORPUS_RECORD_MALFORMED, CONTRACT_VERDICT_MISMATCH,
 *   CONTRACT_DISAGREEMENT_COUNT_MISMATCH, CONTRACT_DEFINITION_PATH_NOT_FOUND
 * and, from applyReversalDefinitionContract():
 *   REVERSAL_INPUT_REQUIRED, REVERSAL_UNSUPPORTED_INSTRUMENT,
 *   REVERSAL_INPUT_OUT_OF_RANGE.
 */

const fs = require('node:fs');
const path = require('node:path');

const CONTRACT_ARTIFACT = 'v2-reversal-definition-contract-v1';

const AI = 'apps/api/src/modules/ai';

const SUPPORTED_INSTRUMENTS = Object.freeze([
  'EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCAD', 'USDCHF',
]);

// Regime enum — the union of R2's TREND_WEAK-only surface and R3's
// PairedReversalBaseRegime (verified in paired-direction-reversal.ts l.9-16).
const REGIME_ENUM = Object.freeze([
  'TREND_HEALTHY', 'TREND_WEAK', 'TREND_EXTENDED', 'VOLATILE',
  'ROLLOVER_RISK', 'REVERSAL_CONFIRMED', 'TRANSITION_EARLY',
]);

const const_ = (name, value, line) => ({ name, value, line });

// ------------------------------------------------ the six reversal definitions

const REVERSAL_DEFINITIONS = [
  {
    key: 'reversal.r1-m1-tactical-route',
    path: `${AI}/m1-tactical-route.ts`,
    artifact: 'classifyM1TacticalRoute',
    role: 'bar-level confirmer — the only definition whose TRUE routes an order in V1 (route M1_CONFIRMED_REVERSAL)',
    predicate: [
      'reversalImpulse (l.97-106): failedBreakoutAgainstDirection && directionQuality >= 0.6 && momentum1Atr >= 0.25 && momentum3Atr >= 0.25 && momentum5Atr >= 0.125 && emaSlopeAtr > 0',
      'm5ReversalConfirmed (l.108-122): establishedTurn (>=0.08/>=0.08/>=-0.1) OR decisiveFreshTurn (>=0.6/>=0.3/>=-0.1) on completed M5 bars',
      'conjunction at l.192-193; confirmed only after scoreEdge >= 0.08 (l.203); signal-without-turn abstains M5_REVERSAL_NOT_CONFIRMED (l.207-209)',
    ],
    constants: [
      const_('minDirectionalEdge', 0.08, 28), // m1-tactical-candidate.ts
      const_('minReversalQuality', 0.6, 32), // m1-tactical-candidate.ts
      const_('minReversalImpulseAtr', 0.25, 33), // m1-tactical-candidate.ts
      const_('momentum5Relaxation', 0.5, 103), // >= 0.25*0.5, inline
      const_('established.bodyPressure3', 0.08, 114),
      const_('established.m5Momentum3Atr', 0.08, 115),
      const_('established.m5Momentum1Atr', -0.1, 116),
      const_('decisive.latestBodyPressure', 0.6, 118),
      const_('decisive.m5Momentum1Atr', 0.3, 119),
      const_('decisive.m5Momentum3Atr', -0.1, 120),
    ],
    probabilitySurface: 'directionQuality (S1 dialect, P1-1) — no calibrated probability',
    notes: 'The failed-breakout requirement is R1-only; R4 exists to test exactly this discriminator. Constants live in m1-tactical-candidate.ts (M1_TACTICAL_POLICY_V1).',
  },
  {
    key: 'reversal.r2-plan-b-multimodel-shadow',
    path: `${AI}/plan-b-multimodel-shadow.ts`,
    artifact: 'reversalConfirmed',
    role: 'bar-level confirmer — Plan-B shadow admission side',
    predicate: [
      'reversalConfirmed (l.141-155): TREND_WEAK && confidence >= 0.64 && extensionAtr <= 1.15 && volatilityScore <= 0.55 && signed shortHorizonMomentumAtr in [0.5, 1.5] && grossExpectedR >= 0.18',
      'momentum signed by input.direction at l.135-139 (SELL -> -raw)',
    ],
    constants: [
      const_('PLAN_B_CANDIDATE_CONFIDENCE_FLOOR', 0.64, 50),
      const_('PLAN_B_REVERSAL_GROSS_EXPECTED_R_FLOOR', 0.18, 52),
      const_('PLAN_B_REVERSAL_MIN_MOMENTUM_ATR', 0.5, 53),
      const_('maxMomentumAtrCeiling', 1.5, 54),
      const_('extensionCeilingAtr', 1.15, 150), // inline literal
      const_('volatilityCeiling', 0.55, 151), // inline literal
    ],
    probabilitySurface: 'input.confidence (upstream, floor 0.64) — B5 floor constellation',
    notes: 'Two of the ceilings (1.15 / 0.55) are inline literals in the predicate, not named constants. Regime support: TREND_WEAK ONLY.',
  },
  {
    key: 'reversal.r3-paired-direction-reversal',
    path: `${AI}/paired-direction-reversal.ts`,
    artifact: 'evaluatePairedDirectionReversal',
    role: 'bar-level confirmer — paired probability-gap gate',
    predicate: [
      'directional probabilities: sigmoid(logit(buy) - logit(sell)) (l.98-101); preferred side is the reversal side when != primaryDirection',
      'gate ladder (l.132-156): directional probability >= 0.64; preferred != primary; absolute probability >= 0.40828402366863903; regime in {TREND_WEAK, TREND_EXTENDED}; aligned momentum >= 0.15; researchNetExpectedR >= 0.08',
      'netExpectedR = p*targetR - (1-p) - executionCostR (l.113-116)',
    ],
    constants: [
      const_('PAIRED_REVERSAL_MIN_DIRECTION_PROBABILITY', 0.64, 3),
      const_('PAIRED_REVERSAL_MIN_ABSOLUTE_PROBABILITY', 0.40828402366863903, 4), // = PLAN_B_SHADOW_ADMISSION_THRESHOLD
      const_('PAIRED_REVERSAL_MIN_ALIGNED_MOMENTUM_ATR', 0.15, 5),
      const_('PAIRED_REVERSAL_MIN_RESEARCH_NET_EXPECTED_R', 0.08, 6),
    ],
    probabilitySurface: 'buy/sell raw probabilities, logit-paired internally',
    notes: 'The only definition with an explicit typed reason ladder. Regime support: {TREND_WEAK, TREND_EXTENDED} — strictly wider than R2.',
  },
  {
    key: 'reversal.r4-m1-reversal-timing-fusion-shadow',
    path: `${AI}/m1-reversal-timing-fusion-shadow.ts`,
    artifact: 'm1-planb-reversal-dual-impulse-fusion-shadow-v1',
    role: 'fusion shadow over the R1/R2 timing disagreement — asks "would R1 confirm without the failed-breakout requirement?"',
    predicate: [
      'state ladder (l.107-123): INVALID_EVIDENCE -> PLAN_B_REVERSAL_NOT_ADMITTED -> ORIGINAL_M1_ALREADY_CONFIRMED -> M1_DIRECTION_QUALITY_LOW -> M1_MULTIBAR_IMPULSE_MISSING -> M1_SLOPE_NOT_ALIGNED -> COMPLETED_M5_TURN_MISSING -> FAILED_BREAKOUT_PRESENT_OTHER_ROUTE_BLOCK -> ALTERNATIVE_CONFIRMATION_CANDIDATE',
      'bar-level block: quality >= 0.6, momentum1/3 >= 0.25, momentum5 >= 0.125, slope > 0, established-or-decisive turn (l.87-103)',
    ],
    constants: [
      const_('M1_REVERSAL_TIMING_FUSION_MIN_QUALITY', 0.6, 6),
      const_('M1_REVERSAL_TIMING_FUSION_MIN_MOMENTUM', 0.25, 7),
      const_('momentum5Relaxation', 0.5, 93), // >= 0.25/2, inline
    ],
    probabilitySurface: 'none — consumes Plan-B admission (R2 outcome) and the R1 candidate block',
    notes: 'Shadow-only: wouldConfirmWithoutFailedBreakout === (state === ALTERNATIVE_CONFIRMATION_CANDIDATE).',
  },
  {
    key: 'reversal.r5-planb-reversal-m1-continuation-shadow',
    path: `${AI}/planb-reversal-m1-continuation-shadow.ts`,
    artifact: 'planb-reversal-m1-continuation-asof-shadow-v1',
    role: 'observation-only witness of the R2-vs-R1 disagreement — records CONFIRMED_REVERSAL regime coexisting with an M1 continuation',
    predicate: [
      'mismatchObserved (l.72-73): planBStrategyRoute === "CONFIRMED_REVERSAL" && m1Route === "M1_TREND_CONTINUATION"',
      'prospective-study eligibility ladder follows (l.76+); never permits an order (brokerOrderAuthority NONE)',
    ],
    constants: [
      const_('minNetExpectedRForStudy', 0.1, 57), // planBNetExpectedR <= 0.1 -> unsafe
      const_('minScoreEdgeForStudy', 0.3, 64),
      const_('minDirectionQualityForStudy', 0.68, 66),
      const_('minHtfAgreementForStudy', 0.2, 68),
      const_('minM5Momentum1ForStudy', 0.18, 74),
      const_('minM5Momentum3ForStudy', 0.1, 76),
      const_('minM5BodyPressure3ForStudy', 0.12, 78),
    ],
    probabilitySurface: 'none — records the disagreement itself as evidence',
    notes: 'Exists specifically because R1 and R2 disagree (audit A2/F4). Output is an observation, not a confirmation.',
  },
  {
    key: 'reversal.r6-confirmed-reversal-cross-sleeve-canary',
    path: `${AI}/confirmed-reversal-cross-sleeve-canary.ts`,
    artifact: 'CONFIRMED_REVERSAL_CROSS_SLEEVE_CANARY',
    role: 'execution-side DEMO probe — cost-aware confirmed reversal rescued from the EARLY_TRANSITION degraded-sample veto',
    predicate: [
      'gate chain (l.43-79): m1Route === M1_EARLY_TRANSITION && degradedEarlyTransitionVeto === true && !lossStreakVeto && strategyRoute === CONFIRMED_REVERSAL && execution/economic gates green && eventRisk CLEAR && driftState NORMAL && netExpectedR > 0 && broker-native expert aligned, freshness <= 120s, confidence >= 0.7, votes total >= 3 and unanimous',
    ],
    constants: [
      const_('CONFIRMED_REVERSAL_CROSS_SLEEVE_CANARY_LOT_CAP', 0.2, 14),
      const_('expertFreshnessCeilingSeconds', 120, 63),
      const_('expertConfidenceFloor', 0.7, 66),
      const_('expertMinTotalVotes', 3, 79),
    ],
    probabilitySurface: 'expert confidence (>= 0.7) + unanimous vote consensus — a sixth distinct conviction surface',
    notes: 'Four-hour broker-persisted same-pair/side recovery cooldown and the 0.20-lot ceiling are enforced outside the pure function (scheduler).',
  },
];

const REVERSAL_DEFINITION_COUNT = REVERSAL_DEFINITIONS.length; // 6 — reconciles with component map / audit A2

// ------------------------------------------ faithful predicate mirrors (research)

// R1 reduction: the reversal-predicate chain of classifyM1TacticalRoute only
// (scoreEdge gate -> signal -> M5 turn -> confirm). The continuation /
// transition branches of the full router are out of P1-2 scope (they are the
// P1-0 component map's L3 surface, not the reversal verdict).
function mirrorR1(record) {
  const reversalSignal =
    record.failedBreakoutAgainstDirection === true &&
    record.directionQuality >= 0.6 &&
    record.momentum1Atr >= 0.25 &&
    record.momentum3Atr >= 0.25 &&
    record.momentum5Atr >= 0.125 &&
    record.emaSlopeAtr > 0;
  const established =
    record.m5BodyPressure3 >= 0.08 &&
    record.m5Momentum3Atr >= 0.08 &&
    record.m5Momentum1Atr >= -0.1;
  const latestBp = record.m5LatestBodyPressure == null ? 0 : record.m5LatestBodyPressure;
  const decisive =
    Number.isFinite(latestBp) &&
    latestBp >= 0.6 &&
    record.m5Momentum1Atr >= 0.3 &&
    record.m5Momentum3Atr >= -0.1;
  const turn = established || decisive;
  if (!Number.isFinite(record.scoreEdge) || record.scoreEdge < 0.08) {
    return { confirmed: false, reason: 'DIRECTION_EDGE_TOO_SMALL', turn: established ? 'ESTABLISHED' : decisive ? 'DECISIVE_FRESH' : 'NONE' };
  }
  if (reversalSignal && !turn) {
    return { confirmed: false, reason: 'M5_REVERSAL_NOT_CONFIRMED', turn: 'NONE' };
  }
  if (reversalSignal && turn) {
    return { confirmed: true, reason: 'FAILED_MOVE_WITH_MULTI_BAR_REVERSAL_IMPULSE', turn: established ? 'ESTABLISHED' : 'DECISIVE_FRESH' };
  }
  return { confirmed: false, reason: 'REVERSAL_SIGNAL_ABSENT', turn: established ? 'ESTABLISHED' : decisive ? 'DECISIVE_FRESH' : 'NONE' };
}

// R2: rejection reason follows the source operand order (regime, confidence,
// extension, volatility, momentum band, expectedR).
function mirrorR2(record) {
  const signed = record.direction === 'SELL' ? -record.shortHorizonMomentumAtr : record.shortHorizonMomentumAtr;
  if (record.regime !== 'TREND_WEAK') return { confirmed: false, reason: 'REVERSAL_REGIME_NOT_TREND_WEAK' };
  if (!(record.confidence >= 0.64)) return { confirmed: false, reason: 'CONFIDENCE_BELOW_FLOOR' };
  if (!(record.extensionAtr <= 1.15)) return { confirmed: false, reason: 'EXTENSION_ABOVE_CEILING' };
  if (!(record.volatilityScore <= 0.55)) return { confirmed: false, reason: 'VOLATILITY_ABOVE_CEILING' };
  if (!(signed >= 0.5)) return { confirmed: false, reason: 'MOMENTUM_BELOW_BAND' };
  if (!(signed <= 1.5)) return { confirmed: false, reason: 'MOMENTUM_ABOVE_BAND' };
  if (!(record.grossExpectedR >= 0.18)) return { confirmed: false, reason: 'GROSS_EXPECTED_R_BELOW_FLOOR' };
  return { confirmed: true, reason: 'REVERSAL_CONFIRMED' };
}

const EPSILON = 1e-9;
function logit(p) {
  const bounded = Math.max(EPSILON, Math.min(1 - EPSILON, p));
  return Math.log(bounded / (1 - bounded));
}
function sigmoid(v) {
  if (v >= 30) return 1;
  if (v <= -30) return 0;
  return 1 / (1 + Math.exp(-v));
}

// R3: the paired probability-gap gate with its typed reason ladder.
function mirrorR3(record) {
  const buyDir = sigmoid(logit(record.buyProbability) - logit(record.sellProbability));
  const sellDir = 1 - buyDir;
  const preferred = buyDir >= sellDir ? 'BUY' : 'SELL';
  const preferredDirProb = Math.max(buyDir, sellDir);
  const preferredAbs = preferred === 'BUY' ? record.buyProbability : record.sellProbability;
  const aligned = preferred === 'BUY' ? record.rawMomentumAtr : -record.rawMomentumAtr;
  const netR = preferredDirProb * record.targetRMultiple - (1 - preferredDirProb) - record.executionCostR;
  const detail = { preferred, preferredDirProb, netR };
  if (preferredDirProb < 0.64) return { confirmed: false, reason: 'DIRECTION_EDGE_TOO_SMALL', ...detail };
  if (preferred === record.primaryDirection) return { confirmed: false, reason: 'PRIMARY_SIDE_STILL_PREFERRED', ...detail };
  if (preferredAbs < 0.40828402366863903) return { confirmed: false, reason: 'ABSOLUTE_TRADABILITY_TOO_LOW', ...detail };
  if (record.regime !== 'TREND_WEAK' && record.regime !== 'TREND_EXTENDED') {
    return { confirmed: false, reason: 'REVERSAL_REGIME_NOT_SUPPORTED', ...detail };
  }
  if (aligned < 0.15) return { confirmed: false, reason: 'REVERSAL_MOMENTUM_NOT_CONFIRMED', ...detail };
  if (netR < 0.08) return { confirmed: false, reason: 'RESEARCH_NET_EXPECTED_R_TOO_LOW', ...detail };
  return { confirmed: true, reason: 'PAIRED_REVERSAL_CANDIDATE', ...detail };
}

// R4: the fusion state ladder reduced to its confirmation question.
function mirrorR4(record) {
  const established =
    record.m5BodyPressure3 >= 0.08 &&
    record.m5Momentum3Atr >= 0.08 &&
    record.m5Momentum1Atr >= -0.1;
  const latestBp = record.m5LatestBodyPressure == null ? 0 : record.m5LatestBodyPressure;
  const decisive =
    Number.isFinite(latestBp) &&
    latestBp >= 0.6 &&
    record.m5Momentum1Atr >= 0.3 &&
    record.m5Momentum3Atr >= -0.1;
  const planBReversal = record.planBPaperAdmitted === true && record.planBStrategyRoute === 'CONFIRMED_REVERSAL';
  if (!planBReversal) return { confirmed: false, reason: 'PLAN_B_REVERSAL_NOT_ADMITTED' };
  if (record.originalRoute === 'M1_CONFIRMED_REVERSAL') return { confirmed: false, reason: 'ORIGINAL_M1_ALREADY_CONFIRMED' };
  if (record.directionQuality < 0.6) return { confirmed: false, reason: 'M1_DIRECTION_QUALITY_LOW' };
  if (!(record.momentum1Atr >= 0.25 && record.momentum3Atr >= 0.25 && record.momentum5Atr >= 0.125)) {
    return { confirmed: false, reason: 'M1_MULTIBAR_IMPULSE_MISSING' };
  }
  if (!(record.emaSlopeAtr > 0)) return { confirmed: false, reason: 'M1_SLOPE_NOT_ALIGNED' };
  if (!(established || decisive)) return { confirmed: false, reason: 'COMPLETED_M5_TURN_MISSING' };
  if (record.failedBreakoutAgainstDirection === true) {
    return { confirmed: false, reason: 'FAILED_BREAKOUT_PRESENT_OTHER_ROUTE_BLOCK' };
  }
  return { confirmed: true, reason: 'ALTERNATIVE_CONFIRMATION_CANDIDATE' };
}

// R5: the observation predicate only (the study-eligibility ladder is recorded
// in the inventory, not re-mirrored — it never yields a confirmation).
function mirrorR5(record) {
  const observed = record.planBStrategyRoute === 'CONFIRMED_REVERSAL' && record.m1Route === 'M1_TREND_CONTINUATION';
  return { observed, reason: observed ? 'MISMATCH_OBSERVED' : 'NOT_A_REVERSAL_CONTINUATION_MISMATCH' };
}

// R6: the cross-sleeve canary gate chain.
function mirrorR6(canary) {
  const g = canary;
  if (g.m1Route !== 'M1_EARLY_TRANSITION') return { confirmed: false, reason: 'M1_ROUTE_NOT_EARLY_TRANSITION' };
  if (g.reliabilityGate == null || g.reliabilityGate.degradedEarlyTransitionVeto !== true) {
    return { confirmed: false, reason: 'DEGRADED_TRANSITION_VETO_INACTIVE' };
  }
  if (g.reliabilityGate.lossStreakVeto === true) return { confirmed: false, reason: 'LOSS_STREAK_VETO_ACTIVE' };
  if (g.strategyRoute !== 'CONFIRMED_REVERSAL') return { confirmed: false, reason: 'STRATEGY_ROUTE_MISMATCH' };
  if (g.eventRisk !== 'CLEAR' || g.driftState !== 'NORMAL' || !(g.netExpectedR > 0)) {
    return { confirmed: false, reason: 'EXECUTION_ECONOMICS_UNSAFE' };
  }
  if (!g.primaryPlanBExecutable || !g.portfolioSnapshotAvailable || !g.brokerVerifiedPepperstoneDemo
    || !g.paperExecutionEligible || !g.executionCostUsable) {
    return { confirmed: false, reason: 'EXECUTION_GATES_UNSAFE' };
  }
  if (!g.expertAllBrokerNative || g.expertDirection !== g.candidateDirection) {
    return { confirmed: false, reason: 'EXPERT_NOT_ALIGNED' };
  }
  if (!(g.expertFreshnessSeconds >= 0 && g.expertFreshnessSeconds <= 120) || !(g.expertConfidence >= 0.7)) {
    return { confirmed: false, reason: 'EXPERT_EVIDENCE_STALE_OR_WEAK' };
  }
  const total = g.expertLongVotes + g.expertShortVotes;
  const aligned = g.candidateDirection === 'BUY' ? g.expertLongVotes : g.expertShortVotes;
  if (!(total >= 3 && aligned === total)) return { confirmed: false, reason: 'EXPERT_CONSENSUS_NOT_UNANIMOUS' };
  return { confirmed: true, reason: 'CANARY_ADMITTED' };
}

// ---------------------------------------- the frozen disagreement corpus (P1-2)

// Frozen all-green execution-side canary baseline. Per-record canary objects
// override the fields their verdict depends on; both halves are committed
// fixtures and the merged surface is what mirrorR6 consumes.
const CORPUS_CANARY_BASELINE = Object.freeze({
  m1Route: 'M1_EARLY_TRANSITION',
  reliabilityGate: Object.freeze({ lossStreakVeto: false, degradedEarlyTransitionVeto: true }),
  strategyRoute: 'CONFIRMED_REVERSAL',
  primaryPlanBExecutable: true,
  portfolioSnapshotAvailable: true,
  brokerVerifiedPepperstoneDemo: true,
  paperExecutionEligible: true,
  executionCostUsable: true,
  eventRisk: 'CLEAR',
  driftState: 'NORMAL',
  netExpectedR: 0.25,
  expertAllBrokerNative: true,
  expertDirection: 'BUY',
  candidateDirection: 'BUY',
  expertFreshnessSeconds: 30,
  expertConfidence: 0.8,
  expertLongVotes: 3,
  expertShortVotes: 0,
});

const R1_TRUE_BLOCK = Object.freeze({
  failedBreakoutAgainstDirection: true,
  directionQuality: 0.68,
  momentum1Atr: 0.3,
  momentum3Atr: 0.3,
  momentum5Atr: 0.2,
  emaSlopeAtr: 0.1,
  m5BodyPressure3: 0.12,
  m5Momentum1Atr: 0.1,
  m5Momentum3Atr: 0.1,
  m5LatestBodyPressure: 0.2,
  htfAgreement: 0.1,
  scoreEdge: 0.25,
});

const R1_SIGNAL_OFF = Object.freeze({
  failedBreakoutAgainstDirection: false,
  directionQuality: 0.68,
  momentum1Atr: 0.3,
  momentum3Atr: 0.3,
  momentum5Atr: 0.2,
  emaSlopeAtr: 0.1,
  m5BodyPressure3: 0.12,
  m5Momentum1Atr: 0.1,
  m5Momentum3Atr: 0.1,
  m5LatestBodyPressure: 0.2,
  htfAgreement: 0.1,
  scoreEdge: 0.25,
});

const TURN_NONE_BLOCK = Object.freeze({
  failedBreakoutAgainstDirection: true,
  directionQuality: 0.68,
  momentum1Atr: 0.3,
  momentum3Atr: 0.3,
  momentum5Atr: 0.2,
  emaSlopeAtr: 0.1,
  m5BodyPressure3: 0.05,
  m5Momentum1Atr: 0.05,
  m5Momentum3Atr: 0.05,
  m5LatestBodyPressure: 0.2,
  htfAgreement: 0.1,
  scoreEdge: 0.25,
});

const R2_GREEN = Object.freeze({
  regime: 'TREND_WEAK',
  confidence: 0.75,
  extensionAtr: 0.9,
  volatilityScore: 0.4,
  shortHorizonMomentumAtr: 0.8,
  grossExpectedR: 0.2,
});

const R3_SELL_SIDE = Object.freeze({
  primaryDirection: 'BUY',
  buyProbability: 0.3,
  sellProbability: 0.68,
  rawMomentumAtr: -0.5,
  executionCostR: 0.05,
  targetRMultiple: 1.5,
});

const R3_BUY_SIDE = Object.freeze({
  primaryDirection: 'SELL',
  buyProbability: 0.72,
  sellProbability: 0.3,
  rawMomentumAtr: 0.5,
  executionCostR: 0.05,
  targetRMultiple: 1.5,
});

const corpus = (id, scenario, block) => ({
  id,
  scenario,
  instrument: 'EURUSD',
  decisionTime: '2026-11-27T10:30:00.000Z',
  policyVersion: 'm1-tactical-v1',
  ...block,
});

const DISAGREEMENT_CORPUS = [
  corpus('RV-D01', 'R1-only confirmation: Plan-B regime TREND_HEALTHY and paired edge 0.60 < 0.64 both reject what R1 confirms', {
    direction: 'SELL',
    ...R1_TRUE_BLOCK,
    regime: 'TREND_HEALTHY', confidence: 0.75, extensionAtr: 0.8, volatilityScore: 0.4,
    shortHorizonMomentumAtr: -0.8, grossExpectedR: 0.25,
    primaryDirection: 'BUY', buyProbability: 0.4, sellProbability: 0.5,
    rawMomentumAtr: -0.3, executionCostR: 0.05, targetRMultiple: 1.5,
    planBPaperAdmitted: true, planBStrategyRoute: 'CONFIRMED_REVERSAL',
    originalRoute: 'M1_CONFIRMED_REVERSAL', m1Route: 'M1_CONFIRMED_REVERSAL',
    canary: { m1Route: 'M1_CONFIRMED_REVERSAL', candidateDirection: 'SELL', expertDirection: 'SELL', expertLongVotes: 0, expertShortVotes: 3 },
    expected: { r1: true, r1Reason: 'FAILED_MOVE_WITH_MULTI_BAR_REVERSAL_IMPULSE', r2: false, r2Reason: 'REVERSAL_REGIME_NOT_TREND_WEAK', r3: false, r3Reason: 'DIRECTION_EDGE_TOO_SMALL', r4: false, r4Reason: 'ORIGINAL_M1_ALREADY_CONFIRMED', r5: false, r5Reason: 'NOT_A_REVERSAL_CONTINUATION_MISMATCH', r6: false, r6Reason: 'M1_ROUTE_NOT_EARLY_TRANSITION' },
  }),
  corpus('RV-D02', 'R1+R3 confirm (SELL side); R2 regime-rejects TREND_EXTENDED — regime-support divergence {WEAK} vs {WEAK,EXTENDED}', {
    direction: 'SELL',
    ...R1_TRUE_BLOCK,
    ...R2_GREEN, regime: 'TREND_EXTENDED',
    ...R3_SELL_SIDE,
    planBPaperAdmitted: true, planBStrategyRoute: 'CONFIRMED_REVERSAL',
    originalRoute: 'M1_CONFIRMED_REVERSAL', m1Route: 'M1_CONFIRMED_REVERSAL',
    canary: { m1Route: 'M1_CONFIRMED_REVERSAL', candidateDirection: 'SELL', expertDirection: 'SELL', expertLongVotes: 0, expertShortVotes: 3 },
    expected: { r1: true, r1Reason: 'FAILED_MOVE_WITH_MULTI_BAR_REVERSAL_IMPULSE', r2: false, r2Reason: 'REVERSAL_REGIME_NOT_TREND_WEAK', r3: true, r3Reason: 'PAIRED_REVERSAL_CANDIDATE', r4: false, r4Reason: 'ORIGINAL_M1_ALREADY_CONFIRMED', r5: false, r5Reason: 'NOT_A_REVERSAL_CONTINUATION_MISMATCH', r6: false, r6Reason: 'M1_ROUTE_NOT_EARLY_TRANSITION' },
  }),
  corpus('RV-D03', 'R2-only confirmation without failed breakout; R4 flags the alternative candidate and R5 records the institutional mismatch', {
    direction: 'BUY',
    ...R1_SIGNAL_OFF,
    ...R2_GREEN,
    primaryDirection: 'SELL', buyProbability: 0.42, sellProbability: 0.5,
    rawMomentumAtr: 0.3, executionCostR: 0.05, targetRMultiple: 1.5,
    planBPaperAdmitted: true, planBStrategyRoute: 'CONFIRMED_REVERSAL',
    originalRoute: 'M1_TREND_CONTINUATION', m1Route: 'M1_TREND_CONTINUATION',
    canary: { m1Route: 'M1_TREND_CONTINUATION' },
    expected: { r1: false, r1Reason: 'REVERSAL_SIGNAL_ABSENT', r2: true, r2Reason: 'REVERSAL_CONFIRMED', r3: false, r3Reason: 'DIRECTION_EDGE_TOO_SMALL', r4: true, r4Reason: 'ALTERNATIVE_CONFIRMATION_CANDIDATE', r5: true, r5Reason: 'MISMATCH_OBSERVED', r6: false, r6Reason: 'M1_ROUTE_NOT_EARLY_TRANSITION' },
  }),
  corpus('RV-D04', 'R2+R3 confirm (BUY side) while R1 lacks the failed breakout — the mirror image of RV-D01', {
    direction: 'BUY',
    ...R1_SIGNAL_OFF,
    ...R2_GREEN,
    ...R3_BUY_SIDE,
    planBPaperAdmitted: true, planBStrategyRoute: 'CONFIRMED_REVERSAL',
    originalRoute: 'M1_TREND_CONTINUATION', m1Route: 'M1_TREND_CONTINUATION',
    canary: { m1Route: 'M1_TREND_CONTINUATION' },
    expected: { r1: false, r1Reason: 'REVERSAL_SIGNAL_ABSENT', r2: true, r2Reason: 'REVERSAL_CONFIRMED', r3: true, r3Reason: 'PAIRED_REVERSAL_CANDIDATE', r4: true, r4Reason: 'ALTERNATIVE_CONFIRMATION_CANDIDATE', r5: true, r5Reason: 'MISMATCH_OBSERVED', r6: false, r6Reason: 'M1_ROUTE_NOT_EARLY_TRANSITION' },
  }),
  corpus('RV-D05', 'R3-only confirmation on TREND_EXTENDED: R2 rejects the regime R3 supports', {
    direction: 'SELL',
    ...R1_SIGNAL_OFF,
    ...R2_GREEN, regime: 'TREND_EXTENDED',
    primaryDirection: 'BUY', buyProbability: 0.3, sellProbability: 0.72,
    rawMomentumAtr: -0.5, executionCostR: 0.05, targetRMultiple: 1.5,
    planBPaperAdmitted: true, planBStrategyRoute: 'CONFIRMED_REVERSAL',
    originalRoute: 'M1_TREND_CONTINUATION', m1Route: 'M1_TREND_CONTINUATION',
    canary: { m1Route: 'M1_TREND_CONTINUATION', candidateDirection: 'SELL', expertDirection: 'SELL', expertLongVotes: 0, expertShortVotes: 3 },
    expected: { r1: false, r1Reason: 'REVERSAL_SIGNAL_ABSENT', r2: false, r2Reason: 'REVERSAL_REGIME_NOT_TREND_WEAK', r3: true, r3Reason: 'PAIRED_REVERSAL_CANDIDATE', r4: true, r4Reason: 'ALTERNATIVE_CONFIRMATION_CANDIDATE', r5: true, r5Reason: 'MISMATCH_OBSERVED', r6: false, r6Reason: 'M1_ROUTE_NOT_EARLY_TRANSITION' },
  }),
  corpus('RV-D06', 'CONTROL (all six reject): the near-miss corridor — every gate of every definition fails by its own smallest margin', {
    direction: 'BUY',
    failedBreakoutAgainstDirection: true, directionQuality: 0.59,
    momentum1Atr: 0.24, momentum3Atr: 0.24, momentum5Atr: 0.2, emaSlopeAtr: 0.1,
    m5BodyPressure3: 0.12, m5Momentum1Atr: 0.1, m5Momentum3Atr: 0.1, m5LatestBodyPressure: 0.2,
    htfAgreement: 0.1, scoreEdge: 0.079,
    regime: 'TREND_WEAK', confidence: 0.63, extensionAtr: 1.16, volatilityScore: 0.56,
    shortHorizonMomentumAtr: 0.49, grossExpectedR: 0.17,
    primaryDirection: 'SELL', buyProbability: 0.42, sellProbability: 0.52,
    rawMomentumAtr: 0.14, executionCostR: 0.28, targetRMultiple: 1.5,
    planBPaperAdmitted: true, planBStrategyRoute: 'TREND_CONTINUATION',
    originalRoute: 'ABSTAIN', m1Route: 'ABSTAIN',
    canary: { m1Route: 'ABSTAIN' },
    expected: { r1: false, r1Reason: 'DIRECTION_EDGE_TOO_SMALL', r2: false, r2Reason: 'CONFIDENCE_BELOW_FLOOR', r3: false, r3Reason: 'DIRECTION_EDGE_TOO_SMALL', r4: false, r4Reason: 'PLAN_B_REVERSAL_NOT_ADMITTED', r5: false, r5Reason: 'NOT_A_REVERSAL_CONTINUATION_MISMATCH', r6: false, r6Reason: 'M1_ROUTE_NOT_EARLY_TRANSITION' },
  }),
  corpus('RV-D07', 'R1 signal without a completed M5 turn vs R2 confirmation — the timing disagreement the fusion shadow exists for', {
    direction: 'BUY',
    ...TURN_NONE_BLOCK,
    ...R2_GREEN,
    primaryDirection: 'SELL', buyProbability: 0.42, sellProbability: 0.5,
    rawMomentumAtr: 0.3, executionCostR: 0.05, targetRMultiple: 1.5,
    planBPaperAdmitted: true, planBStrategyRoute: 'CONFIRMED_REVERSAL',
    originalRoute: 'ABSTAIN', m1Route: 'ABSTAIN',
    canary: { m1Route: 'ABSTAIN' },
    expected: { r1: false, r1Reason: 'M5_REVERSAL_NOT_CONFIRMED', r2: true, r2Reason: 'REVERSAL_CONFIRMED', r3: false, r3Reason: 'DIRECTION_EDGE_TOO_SMALL', r4: false, r4Reason: 'COMPLETED_M5_TURN_MISSING', r5: false, r5Reason: 'NOT_A_REVERSAL_CONTINUATION_MISMATCH', r6: false, r6Reason: 'M1_ROUTE_NOT_EARLY_TRANSITION' },
  }),
  corpus('RV-D08', 'Momentum-band divergence: R2 rejects 1.6 > 1.5 while R1 and R3 confirm', {
    direction: 'SELL',
    ...R1_TRUE_BLOCK,
    ...R2_GREEN, shortHorizonMomentumAtr: -1.6, // direction SELL -> signed +1.6
    ...R3_SELL_SIDE,
    planBPaperAdmitted: true, planBStrategyRoute: 'CONFIRMED_REVERSAL',
    originalRoute: 'M1_CONFIRMED_REVERSAL', m1Route: 'M1_CONFIRMED_REVERSAL',
    canary: { m1Route: 'M1_CONFIRMED_REVERSAL', candidateDirection: 'SELL', expertDirection: 'SELL', expertLongVotes: 0, expertShortVotes: 3 },
    expected: { r1: true, r1Reason: 'FAILED_MOVE_WITH_MULTI_BAR_REVERSAL_IMPULSE', r2: false, r2Reason: 'MOMENTUM_ABOVE_BAND', r3: true, r3Reason: 'PAIRED_REVERSAL_CANDIDATE', r4: false, r4Reason: 'ORIGINAL_M1_ALREADY_CONFIRMED', r5: false, r5Reason: 'NOT_A_REVERSAL_CONTINUATION_MISMATCH', r6: false, r6Reason: 'M1_ROUTE_NOT_EARLY_TRANSITION' },
  }),
  corpus('RV-D09', 'Economics-floor divergence 0.08 vs 0.18: net 0.119 clears R3, gross 0.17 fails R2', {
    direction: 'SELL',
    ...R1_SIGNAL_OFF,
    ...R2_GREEN, shortHorizonMomentumAtr: -0.8, grossExpectedR: 0.17,
    primaryDirection: 'BUY', buyProbability: 0.4, sellProbability: 0.58,
    rawMomentumAtr: -0.2, executionCostR: 0.28, targetRMultiple: 1.074,
    planBPaperAdmitted: true, planBStrategyRoute: 'CONFIRMED_REVERSAL',
    originalRoute: 'M1_TREND_CONTINUATION', m1Route: 'M1_TREND_CONTINUATION',
    canary: { m1Route: 'M1_TREND_CONTINUATION', candidateDirection: 'SELL', expertDirection: 'SELL', expertLongVotes: 0, expertShortVotes: 3 },
    expected: { r1: false, r1Reason: 'REVERSAL_SIGNAL_ABSENT', r2: false, r2Reason: 'GROSS_EXPECTED_R_BELOW_FLOOR', r3: true, r3Reason: 'PAIRED_REVERSAL_CANDIDATE', r4: true, r4Reason: 'ALTERNATIVE_CONFIRMATION_CANDIDATE', r5: true, r5Reason: 'MISMATCH_OBSERVED', r6: false, r6Reason: 'M1_ROUTE_NOT_EARLY_TRANSITION' },
  }),
  corpus('RV-D10', 'Extension divergence: R2 rejects 1.16 > 1.15 while R1 and R3 confirm', {
    direction: 'SELL',
    ...R1_TRUE_BLOCK,
    ...R2_GREEN, extensionAtr: 1.16,
    ...R3_SELL_SIDE,
    planBPaperAdmitted: true, planBStrategyRoute: 'CONFIRMED_REVERSAL',
    originalRoute: 'M1_CONFIRMED_REVERSAL', m1Route: 'M1_CONFIRMED_REVERSAL',
    canary: { m1Route: 'M1_CONFIRMED_REVERSAL', candidateDirection: 'SELL', expertDirection: 'SELL', expertLongVotes: 0, expertShortVotes: 3 },
    expected: { r1: true, r1Reason: 'FAILED_MOVE_WITH_MULTI_BAR_REVERSAL_IMPULSE', r2: false, r2Reason: 'EXTENSION_ABOVE_CEILING', r3: true, r3Reason: 'PAIRED_REVERSAL_CANDIDATE', r4: false, r4Reason: 'ORIGINAL_M1_ALREADY_CONFIRMED', r5: false, r5Reason: 'NOT_A_REVERSAL_CONTINUATION_MISMATCH', r6: false, r6Reason: 'M1_ROUTE_NOT_EARLY_TRANSITION' },
  }),
  corpus('RV-D11', 'Volatility divergence (R2 0.56 > 0.55) plus R3 momentum-reject at 0.10 aligned: three rejection reasons for one bar', {
    direction: 'SELL',
    ...R1_TRUE_BLOCK,
    ...R2_GREEN, volatilityScore: 0.56,
    primaryDirection: 'BUY', buyProbability: 0.3, sellProbability: 0.72,
    rawMomentumAtr: 0.1, executionCostR: 0.05, targetRMultiple: 1.5,
    planBPaperAdmitted: true, planBStrategyRoute: 'CONFIRMED_REVERSAL',
    originalRoute: 'M1_CONFIRMED_REVERSAL', m1Route: 'M1_CONFIRMED_REVERSAL',
    canary: { m1Route: 'M1_CONFIRMED_REVERSAL', candidateDirection: 'SELL', expertDirection: 'SELL', expertLongVotes: 0, expertShortVotes: 3 },
    expected: { r1: true, r1Reason: 'FAILED_MOVE_WITH_MULTI_BAR_REVERSAL_IMPULSE', r2: false, r2Reason: 'VOLATILITY_ABOVE_CEILING', r3: false, r3Reason: 'REVERSAL_MOMENTUM_NOT_CONFIRMED', r4: false, r4Reason: 'ORIGINAL_M1_ALREADY_CONFIRMED', r5: false, r5Reason: 'NOT_A_REVERSAL_CONTINUATION_MISMATCH', r6: false, r6Reason: 'M1_ROUTE_NOT_EARLY_TRANSITION' },
  }),
  corpus('RV-D12', 'Canary divergence: R2+R3+R4 confirm while R1 never saw a failed breakout and R6 rescues the EARLY_TRANSITION-labelled candidate', {
    direction: 'BUY',
    ...R1_SIGNAL_OFF,
    ...R2_GREEN,
    ...R3_BUY_SIDE,
    planBPaperAdmitted: true, planBStrategyRoute: 'CONFIRMED_REVERSAL',
    originalRoute: 'M1_EARLY_TRANSITION', m1Route: 'M1_EARLY_TRANSITION',
    canary: { m1Route: 'M1_EARLY_TRANSITION', netExpectedR: 0.12 },
    expected: { r1: false, r1Reason: 'REVERSAL_SIGNAL_ABSENT', r2: true, r2Reason: 'REVERSAL_CONFIRMED', r3: true, r3Reason: 'PAIRED_REVERSAL_CANDIDATE', r4: true, r4Reason: 'ALTERNATIVE_CONFIRMATION_CANDIDATE', r5: false, r5Reason: 'NOT_A_REVERSAL_CONTINUATION_MISMATCH', r6: true, r6Reason: 'CANARY_ADMITTED' },
  }),
];

const CORPUS_SIZE = DISAGREEMENT_CORPUS.length; // 12 — eleven disagreements + one control

/** Evaluate one frozen corpus record through all six mirrors. */
function evaluateCorpusRecord(record) {
  const r1 = mirrorR1(record);
  const r2 = mirrorR2(record);
  const r3 = mirrorR3(record);
  const r4 = mirrorR4(record);
  const r5 = mirrorR5(record);
  const canary = Object.assign({}, CORPUS_CANARY_BASELINE, record.canary || {});
  const r6 = mirrorR6(canary);
  return {
    id: record.id,
    r1: r1.confirmed, r1Reason: r1.reason,
    r2: r2.confirmed, r2Reason: r2.reason,
    r3: r3.confirmed, r3Reason: r3.reason,
    r4: r4.confirmed, r4Reason: r4.reason,
    r5: r5.observed, r5Reason: r5.reason,
    r6: r6.confirmed, r6Reason: r6.reason,
  };
}

/** Compute the full verdict matrix and its disagreement statistics. */
function buildDisagreementMatrix(corpusRecords) {
  const rows = corpusRecords.map(evaluateCorpusRecord);
  const disagreementRows = rows.filter((row) => {
    const verdicts = [row.r1, row.r2, row.r3, row.r4, row.r5, row.r6];
    return verdicts.some((v) => v !== verdicts[0]);
  });
  const patterns = new Set(
    rows.map((row) => `${row.r1}:${row.r1Reason}|${row.r2}:${row.r2Reason}|${row.r3}:${row.r3Reason}|${row.r4}:${row.r4Reason}|${row.r5}:${row.r5Reason}|${row.r6}:${row.r6Reason}`),
  );
  return {
    rows,
    disagreementCount: disagreementRows.length,
    controlCount: rows.length - disagreementRows.length,
    distinctPatterns: patterns.size,
    confirmations: {
      r1: rows.filter((row) => row.r1).length,
      r2: rows.filter((row) => row.r2).length,
      r3: rows.filter((row) => row.r3).length,
      r4: rows.filter((row) => row.r4).length,
      r5: rows.filter((row) => row.r5).length,
      r6: rows.filter((row) => row.r6).length,
    },
  };
}

// --------------------------------------------- RD-1 — the unified V2 contract

const RD1_UNITS = Object.freeze([
  'enum:6-majors', 'enum:BUY|SELL', 'ISO-8601-UTC', 'string',
  'ATR-signed', 'ATR-per-bar-signed', 'signed:[-1,1]', 'fraction:[0,1]',
  'boolean', 'enum:7-regimes', 'R-units',
]);

const RD1_GROUPS = Object.freeze(['identity', 'turn', 'impulse', 'breakout', 'conviction', 'regime', 'economics', 'context']);

const rd1Column = (name, group, unit, required) => ({ name, group, unit, required });

const RD1_COLUMNS = [
  rd1Column('instrument', 'identity', 'enum:6-majors', true),
  rd1Column('direction', 'identity', 'enum:BUY|SELL', true),
  rd1Column('decisionTime', 'identity', 'ISO-8601-UTC', true),
  rd1Column('policyVersion', 'identity', 'string', true),
  rd1Column('m5BodyPressure3', 'turn', 'signed:[-1,1]', true),
  rd1Column('m5Momentum1Atr', 'turn', 'ATR-signed', true),
  rd1Column('m5Momentum3Atr', 'turn', 'ATR-signed', true),
  rd1Column('m5LatestBodyPressure', 'turn', 'signed:[-1,1]', false),
  rd1Column('momentum1Atr', 'impulse', 'ATR-signed', true),
  rd1Column('momentum3Atr', 'impulse', 'ATR-signed', true),
  rd1Column('momentum5Atr', 'impulse', 'ATR-signed', true),
  rd1Column('emaSlopeAtr', 'impulse', 'ATR-per-bar-signed', true),
  rd1Column('failedBreakoutAgainstDirection', 'breakout', 'boolean', true),
  rd1Column('calibratedProbability', 'conviction', 'fraction:[0,1]', true),
  rd1Column('regime', 'regime', 'enum:7-regimes', true),
  rd1Column('netExpectedR', 'economics', 'R-units', true),
  rd1Column('estimatedExecutionCostR', 'economics', 'R-units', true),
  rd1Column('htfAgreement', 'context', 'signed:[-1,1]', true),
  rd1Column('scoreEdge', 'context', 'ATR-signed', false),
];

const RD1_OUTPUT_FIELDS = Object.freeze([
  { name: 'reversalState', semantics: 'CONFIRMED | NOT_CONFIRMED — the single V2 reversal verdict' },
  { name: 'turnType', semantics: 'ESTABLISHED | DECISIVE_FRESH | NONE — which completed-M5 branch fired' },
  { name: 'gatesPassed', semantics: 'per-gate booleans (turn, impulse, conviction, economics, regime) for abstention attribution' },
  { name: 'evidenceRecord', semantics: 'all consumed inputs with presence flags; failedBreakout recorded as a stratifier, never the sole discriminator' },
  { name: 'registration', semantics: 'pre-outcome registration to the V2-7 scoreboard (P1-4)' },
  { name: 'executionAuthority', semantics: 'NONE — research contract; admission is a separate layer' },
]);

const RD1_REFUSALS = Object.freeze([
  'REVERSAL_INPUT_REQUIRED',
  'REVERSAL_UNSUPPORTED_INSTRUMENT',
  'REVERSAL_INPUT_OUT_OF_RANGE',
]);

// Pre-registered constant slots — PROPOSALS ONLY. Values are frozen at campaign
// pre-registration (P5-4), never edited mid-campaign. The proposal takes the
// strictest observed V1 value per slot and retires the divergent copies.
const RD1_PREREGISTERED = Object.freeze({
  turnEstablished: Object.freeze({ bodyPressure3: 0.08, m5Momentum3Atr: 0.08, m5Momentum1Atr: -0.1 }),
  turnDecisive: Object.freeze({ latestBodyPressure: 0.6, m5Momentum1Atr: 0.3, m5Momentum3Atr: -0.1 }),
  impulseFloorAtr: 0.25,
  impulse5Relaxation: 0.5,
  convictionFloor: 0.64,
  netExpectedRFloor: 0.18,
  supportedRegimes: Object.freeze(['TREND_WEAK', 'TREND_EXTENDED']),
});

// -------------------------------------------------------------- the contract

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    if (!Object.isFrozen(value)) {
      Object.freeze(value);
    }
    for (const key of Object.keys(value)) {
      deepFreeze(value[key]);
    }
  }
  return value;
}

const REVERSAL_DEFINITION_CONTRACT = deepFreeze(Object.freeze({
  meta: Object.freeze({
    artifact: CONTRACT_ARTIFACT,
    capturedOn: '2026-11-27',
    scope: 'P1-2 reversal-definition unification (research-only)',
    executionAuthority: 'NONE',
    specDoc: 'docs/research/AI_ENGINE_V2_P1_2_REVERSAL_DEFINITION_UNIFICATION_SPEC_20261127.md',
    componentMapRef: 'v2-engine-component-map-v1',
    auditReference: 'docs/research/AI_ENGINE_V2_AUDIT_FINDINGS_20261127.md (finding A2)',
  }),
  definitions: REVERSAL_DEFINITIONS,
  corpus: DISAGREEMENT_CORPUS,
  corpusExpectations: Object.freeze({
    size: 12,
    disagreementCount: 11,
    controlCount: 1,
    confirmations: Object.freeze({ r1: 5, r2: 4, r3: 7, r4: 5, r5: 4, r6: 1 }),
    distinctPatterns: 12,
  }),
  unifiedContract: Object.freeze({
    name: 'RD-1',
    alignmentConvention: 'direction alignment applied exactly once, at ingestion; signed columns are positive when favoring the candidate direction',
    prohibitedInputs: Object.freeze(['confidence', 'rawDirectionalProbabilityPairs']),
    columns: RD1_COLUMNS,
    outputFields: RD1_OUTPUT_FIELDS,
    refusals: RD1_REFUSALS,
    predicateStructure: Object.freeze([
      '1. completedTurn: established OR decisive on completed M5 bars (the R1/R4 shared block — the only structural turn test)',
      '2. impulseCorroboration: momentum1Atr/3Atr >= floor && momentum5Atr >= floor/2 && emaSlopeAtr > 0',
      '3. conviction: calibratedProbability (DS-1 output) >= floor — replaces R1 quality 0.6, R2 confidence 0.64, R3 0.64/0.408',
      '4. economics: netExpectedR >= floor (net, cost-inclusive — replaces R2 gross 0.18 vs R3 net 0.08)',
      '5. regimeSupport: regime in the pre-registered supported set (replaces R2 {TREND_WEAK} vs R3 {TREND_WEAK, TREND_EXTENDED})',
      'CONFIRMED = 1 AND 2 AND 3 AND 4 AND 5; failedBreakout is recorded evidence and a post-hoc stratifier, never a required gate',
    ]),
    preRegistered: RD1_PREREGISTERED,
    missingValueRule: Object.freeze({
      required: 'absent/null/undefined/non-finite -> typed refusal REVERSAL_INPUT_REQUIRED (fail-closed; no silent default, no NaN propagation)',
      optional: 'nullable: absence recorded as null with an explicit presence flag; never rewritten to 0',
      range: 'out-of-declared-range -> typed refusal REVERSAL_INPUT_OUT_OF_RANGE (never clamped into range)',
    }),
  }),
}));

// -------------------------------------------------------------- validation

const finiteNumber = (v) => typeof v === 'number' && Number.isFinite(v);
const nonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;

/**
 * Validate the structural integrity of the reversal-definition contract,
 * including the frozen corpus: every computed verdict (from the faithful
 * mirrors) must equal the committed expectation, and the disagreement
 * statistics must equal the committed counts.
 * Typed refusals: CONTRACT_INPUT_REQUIRED, CONTRACT_META_INCOMPLETE,
 * CONTRACT_COUNT_MISMATCH, CONTRACT_DUPLICATE_KEY, CONTRACT_MISSING_FIELD,
 * CONTRACT_CONSTANT_MALFORMED, CONTRACT_CORPUS_RECORD_MALFORMED,
 * CONTRACT_VERDICT_MISMATCH, CONTRACT_DISAGREEMENT_COUNT_MISMATCH.
 */
function validateReversalDefinitionContract(contract) {
  if (!contract || typeof contract !== 'object' || Array.isArray(contract)) {
    throw new Error('CONTRACT_INPUT_REQUIRED');
  }
  const meta = contract.meta;
  if (!meta || !nonEmptyString(meta.artifact) || !nonEmptyString(meta.capturedOn)
    || !nonEmptyString(meta.scope) || !nonEmptyString(meta.specDoc)) {
    throw new Error('CONTRACT_META_INCOMPLETE');
  }
  if (meta.executionAuthority !== 'NONE') {
    throw new Error('CONTRACT_META_INCOMPLETE: executionAuthority must be NONE');
  }
  if (!Array.isArray(contract.definitions) || contract.definitions.length !== 6) {
    throw new Error('CONTRACT_COUNT_MISMATCH: exactly six reversal definitions required');
  }
  const seenKeys = new Set();
  for (const [index, definition] of contract.definitions.entries()) {
    if (!definition || typeof definition !== 'object') {
      throw new Error(`CONTRACT_MISSING_FIELD: definitions[${index}] malformed`);
    }
    if (!nonEmptyString(definition.key)) {
      throw new Error(`CONTRACT_MISSING_FIELD: definitions[${index}].key`);
    }
    if (seenKeys.has(definition.key)) {
      throw new Error(`CONTRACT_DUPLICATE_KEY: ${definition.key}`);
    }
    seenKeys.add(definition.key);
    if (!nonEmptyString(definition.path) || definition.path.startsWith('/') || definition.path.includes('..')) {
      throw new Error(`CONTRACT_MISSING_FIELD: definitions[${index}].path must be a relative in-repo path`);
    }
    if (!nonEmptyString(definition.artifact) || !nonEmptyString(definition.role)
      || !Array.isArray(definition.predicate) || !definition.predicate.length
      || !nonEmptyString(definition.probabilitySurface) || !nonEmptyString(definition.notes)) {
      throw new Error(`CONTRACT_MISSING_FIELD: definitions[${index}] inventory fields`);
    }
    if (!Array.isArray(definition.constants) || !definition.constants.length) {
      throw new Error(`CONTRACT_CONSTANT_MALFORMED: definitions[${index}].constants`);
    }
    definition.constants.forEach((entry, cIndex) => {
      if (!nonEmptyString(entry.name) || !finiteNumber(entry.value)
        || !Number.isInteger(entry.line) || entry.line < 1) {
        throw new Error(`CONTRACT_CONSTANT_MALFORMED: definitions[${index}].constants[${cIndex}]`);
      }
    });
  }

  if (!Array.isArray(contract.corpus) || contract.corpus.length !== contract.corpusExpectations.size) {
    throw new Error('CONTRACT_COUNT_MISMATCH: corpus size must equal the committed expectation');
  }
  const seenIds = new Set();
  for (const [index, record] of contract.corpus.entries()) {
    if (!record || typeof record !== 'object') {
      throw new Error(`CONTRACT_CORPUS_RECORD_MALFORMED: corpus[${index}]`);
    }
    if (!nonEmptyString(record.id) || !nonEmptyString(record.scenario)) {
      throw new Error(`CONTRACT_CORPUS_RECORD_MALFORMED: corpus[${index}].id/scenario`);
    }
    if (seenIds.has(record.id)) {
      throw new Error(`CONTRACT_DUPLICATE_KEY: ${record.id}`);
    }
    seenIds.add(record.id);
    if (!record.expected || typeof record.expected !== 'object') {
      throw new Error(`CONTRACT_CORPUS_RECORD_MALFORMED: corpus[${index}].expected`);
    }
    for (const field of ['r1', 'r2', 'r3', 'r4', 'r5', 'r6']) {
      if (typeof record.expected[field] !== 'boolean') {
        throw new Error(`CONTRACT_CORPUS_RECORD_MALFORMED: corpus[${index}].expected.${field}`);
      }
    }
    for (const field of ['r1Reason', 'r2Reason', 'r3Reason', 'r4Reason', 'r5Reason', 'r6Reason']) {
      if (!nonEmptyString(record.expected[field])) {
        throw new Error(`CONTRACT_CORPUS_RECORD_MALFORMED: corpus[${index}].expected.${field}`);
      }
    }
  }

  // The core enforcement: computed verdicts must equal committed expectations.
  const matrix = buildDisagreementMatrix(contract.corpus);
  for (const row of matrix.rows) {
    const record = contract.corpus.find((r) => r.id === row.id);
    for (const field of ['r1', 'r2', 'r3', 'r4', 'r5', 'r6']) {
      if (row[field] !== record.expected[field]) {
        throw new Error(`CONTRACT_VERDICT_MISMATCH: ${row.id}.${field} computed ${row[field]} expected ${record.expected[field]}`);
      }
    }
    for (const field of ['r1Reason', 'r2Reason', 'r3Reason', 'r4Reason', 'r5Reason', 'r6Reason']) {
      if (row[field] !== record.expected[field]) {
        throw new Error(`CONTRACT_VERDICT_MISMATCH: ${row.id}.${field} computed ${row[field]} expected ${record.expected[field]}`);
      }
    }
  }
  if (matrix.disagreementCount !== contract.corpusExpectations.disagreementCount) {
    throw new Error(`CONTRACT_DISAGREEMENT_COUNT_MISMATCH: ${matrix.disagreementCount} != ${contract.corpusExpectations.disagreementCount}`);
  }
  if (matrix.controlCount !== contract.corpusExpectations.controlCount) {
    throw new Error(`CONTRACT_DISAGREEMENT_COUNT_MISMATCH: control ${matrix.controlCount} != ${contract.corpusExpectations.controlCount}`);
  }
  if (matrix.distinctPatterns !== contract.corpusExpectations.distinctPatterns) {
    throw new Error(`CONTRACT_DISAGREEMENT_COUNT_MISMATCH: distinctPatterns ${matrix.distinctPatterns} != ${contract.corpusExpectations.distinctPatterns}`);
  }
  for (const [key, count] of Object.entries(contract.corpusExpectations.confirmations)) {
    if (matrix.confirmations[key] !== count) {
      throw new Error(`CONTRACT_DISAGREEMENT_COUNT_MISMATCH: confirmations.${key} ${matrix.confirmations[key]} != ${count}`);
    }
  }

  const unified = contract.unifiedContract;
  if (!unified || !nonEmptyString(unified.name)) {
    throw new Error('CONTRACT_MISSING_FIELD: unifiedContract');
  }
  if (!Array.isArray(unified.columns) || unified.columns.length < 18) {
    throw new Error('CONTRACT_COLUMN_MALFORMED: unifiedContract.columns');
  }
  const units = new Set(RD1_UNITS);
  const groups = new Set(RD1_GROUPS);
  const seenColumns = new Set();
  for (const [index, column] of unified.columns.entries()) {
    if (!nonEmptyString(column.name) || typeof column.required !== 'boolean') {
      throw new Error(`CONTRACT_COLUMN_MALFORMED: unifiedContract.columns[${index}]`);
    }
    if (seenColumns.has(column.name)) {
      throw new Error(`CONTRACT_DUPLICATE_KEY: column ${column.name}`);
    }
    seenColumns.add(column.name);
    if (!units.has(column.unit)) {
      throw new Error(`CONTRACT_UNKNOWN_UNIT: ${column.unit} (column ${column.name})`);
    }
    if (!groups.has(column.group)) {
      throw new Error(`CONTRACT_UNKNOWN_GROUP: ${column.group} (column ${column.name})`);
    }
  }
  const outputNames = (unified.outputFields || []).map((f) => f.name);
  for (const requiredOutput of ['reversalState', 'turnType', 'gatesPassed', 'evidenceRecord', 'executionAuthority']) {
    if (!outputNames.includes(requiredOutput)) {
      throw new Error(`CONTRACT_MISSING_FIELD: unifiedContract.outputFields must include ${requiredOutput}`);
    }
  }
  if (!Array.isArray(unified.refusals) || !unified.refusals.includes('REVERSAL_INPUT_REQUIRED')) {
    throw new Error('CONTRACT_MISSING_FIELD: unifiedContract.refusals');
  }
  if (!unified.preRegistered || !(unified.preRegistered.convictionFloor > 0)
    || !(unified.preRegistered.netExpectedRFloor > 0)) {
    throw new Error('CONTRACT_MISSING_FIELD: unifiedContract.preRegistered slots');
  }
  return true;
}

/**
 * Verify every mapped definition source path exists under the repository root.
 * Typed refusal: CONTRACT_DEFINITION_PATH_NOT_FOUND. Returns { verified, total }.
 */
function verifyDefinitionPaths(contract, repoRoot) {
  if (!contract || !Array.isArray(contract.definitions)) {
    throw new Error('CONTRACT_INPUT_REQUIRED');
  }
  if (!nonEmptyString(repoRoot)) {
    throw new Error('CONTRACT_INPUT_REQUIRED: repoRoot');
  }
  let verified = 0;
  for (const definition of contract.definitions) {
    const resolved = path.join(repoRoot, definition.path);
    if (!fs.existsSync(resolved)) {
      throw new Error(`CONTRACT_DEFINITION_PATH_NOT_FOUND: ${definition.path} (definition ${definition.key})`);
    }
    verified += 1;
  }
  return { verified, total: contract.definitions.length };
}

/** Summary: definition keys/roles, corpus stats, RD-1 column counts. */
function summarizeReversalDefinitionContract(contract) {
  validateReversalDefinitionContract(contract);
  const matrix = buildDisagreementMatrix(contract.corpus);
  const required = contract.unifiedContract.columns.filter((c) => c.required).length;
  const optional = contract.unifiedContract.columns.length - required;
  return {
    artifact: contract.meta.artifact,
    definitions: contract.definitions.map((d) => ({ key: d.key, role: d.role })),
    corpus: {
      size: contract.corpus.length,
      disagreementCount: matrix.disagreementCount,
      controlCount: matrix.controlCount,
      distinctPatterns: matrix.distinctPatterns,
      confirmations: matrix.confirmations,
    },
    rd1: {
      name: contract.unifiedContract.name,
      columns: contract.unifiedContract.columns.length,
      required,
      optional,
    },
  };
}

// ---------------------------------------- RD-1 application surface (fail-closed)

const RD1_OPTIONAL_COLUMNS = RD1_COLUMNS.filter((c) => !c.required).map((c) => c.name);
// Only genuinely numeric feature columns go through the finite/range loop; the
// boolean, enum and identity columns are validated by their own rules above.
const RD1_NUMERIC_UNITS = new Set(['ATR-signed', 'ATR-per-bar-signed', 'signed:[-1,1]', 'fraction:[0,1]', 'R-units']);
const RD1_REQUIRED_NUMERIC = RD1_COLUMNS
  .filter((c) => c.required && RD1_NUMERIC_UNITS.has(c.unit))
  .map((c) => c.name);

const RD1_BOUNDED = Object.freeze({
  m5BodyPressure3: [-1, 1],
  m5LatestBodyPressure: [-1, 1],
  htfAgreement: [-1, 1],
  calibratedProbability: [0, 1],
  estimatedExecutionCostR: [0, Infinity],
  netExpectedR: [-Infinity, Infinity],
  scoreEdge: [-Infinity, Infinity],
});

/**
 * Apply the RD-1 contract to a raw input record. Research-only demonstration
 * of the unified semantics: required columns must be present and finite
 * (REVERSAL_INPUT_REQUIRED), the instrument must be one of the six majors
 * (REVERSAL_UNSUPPORTED_INSTRUMENT), bounded columns must be within range
 * (REVERSAL_INPUT_OUT_OF_RANGE). Returns the single verdict with per-gate
 * attribution; admission is a separate layer and authority stays NONE.
 */
function applyReversalDefinitionContract(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('REVERSAL_INPUT_REQUIRED: input record');
  }
  const instrument = typeof input.instrument === 'string' ? input.instrument.trim().toUpperCase() : input.instrument;
  if (!SUPPORTED_INSTRUMENTS.includes(instrument)) {
    throw new Error(`REVERSAL_UNSUPPORTED_INSTRUMENT: ${input.instrument}`);
  }
  if (input.direction !== 'BUY' && input.direction !== 'SELL') {
    throw new Error('REVERSAL_INPUT_OUT_OF_RANGE: direction must be BUY or SELL');
  }
  if (!(input.decisionTime instanceof Date) || !Number.isFinite(input.decisionTime.getTime())) {
    throw new Error('REVERSAL_INPUT_REQUIRED: decisionTime');
  }
  if (!nonEmptyString(input.policyVersion)) {
    throw new Error('REVERSAL_INPUT_REQUIRED: policyVersion');
  }
  if (typeof input.failedBreakoutAgainstDirection !== 'boolean') {
    throw new Error('REVERSAL_INPUT_REQUIRED: failedBreakoutAgainstDirection');
  }
  if (!REGIME_ENUM.includes(input.regime)) {
    throw new Error(`REVERSAL_INPUT_OUT_OF_RANGE: regime ${input.regime}`);
  }
  const normalized = {};
  const presence = {};
  for (const name of RD1_REQUIRED_NUMERIC) {
    const value = input[name];
    if (value === undefined || value === null || !finiteNumber(value)) {
      throw new Error(`REVERSAL_INPUT_REQUIRED: ${name}`);
    }
    const bounds = RD1_BOUNDED[name];
    if (bounds && (value < bounds[0] || value > bounds[1])) {
      throw new Error(`REVERSAL_INPUT_OUT_OF_RANGE: ${name}=${value} outside [${bounds[0]}, ${bounds[1]}]`);
    }
    normalized[name] = value;
  }
  for (const name of RD1_OPTIONAL_COLUMNS) {
    const value = input[name];
    if (value === undefined || value === null) {
      normalized[name] = null;
      presence[name] = false;
      continue;
    }
    if (!finiteNumber(value)) {
      throw new Error(`REVERSAL_INPUT_REQUIRED: ${name} present but non-finite`);
    }
    const bounds = RD1_BOUNDED[name];
    if (bounds && (value < bounds[0] || value > bounds[1])) {
      throw new Error(`REVERSAL_INPUT_OUT_OF_RANGE: ${name}=${value} outside [${bounds[0]}, ${bounds[1]}]`);
    }
    normalized[name] = value;
    presence[name] = true;
  }

  const pre = RD1_PREREGISTERED;
  const latestBp = normalized.m5LatestBodyPressure == null ? 0 : normalized.m5LatestBodyPressure;
  const established =
    normalized.m5BodyPressure3 >= pre.turnEstablished.bodyPressure3 &&
    normalized.m5Momentum3Atr >= pre.turnEstablished.m5Momentum3Atr &&
    normalized.m5Momentum1Atr >= pre.turnEstablished.m5Momentum1Atr;
  const decisive =
    latestBp >= pre.turnDecisive.latestBodyPressure &&
    normalized.m5Momentum1Atr >= pre.turnDecisive.m5Momentum1Atr &&
    normalized.m5Momentum3Atr >= pre.turnDecisive.m5Momentum3Atr;
  const completedTurn = established || decisive;
  const turnType = established ? 'ESTABLISHED' : decisive ? 'DECISIVE_FRESH' : 'NONE';
  const impulseCorroboration =
    normalized.momentum1Atr >= pre.impulseFloorAtr &&
    normalized.momentum3Atr >= pre.impulseFloorAtr &&
    normalized.momentum5Atr >= pre.impulseFloorAtr * pre.impulse5Relaxation &&
    normalized.emaSlopeAtr > 0;
  const conviction = normalized.calibratedProbability >= pre.convictionFloor;
  const economics = normalized.netExpectedR >= pre.netExpectedRFloor;
  const regimeSupport = pre.supportedRegimes.includes(input.regime);
  const confirmed = completedTurn && impulseCorroboration && conviction && economics && regimeSupport;

  return {
    reversalState: confirmed ? 'CONFIRMED' : 'NOT_CONFIRMED',
    instrument,
    direction: input.direction,
    decisionTime: input.decisionTime.toISOString(),
    policyVersion: input.policyVersion,
    turnType,
    gatesPassed: {
      completedTurn,
      impulseCorroboration,
      conviction,
      economics,
      regimeSupport,
    },
    regime: input.regime,
    failedBreakoutAgainstDirection: input.failedBreakoutAgainstDirection,
    optionalPresence: presence,
    executionAuthority: 'NONE',
  };
}

module.exports = {
  REVERSAL_DEFINITION_CONTRACT,
  SUPPORTED_INSTRUMENTS,
  REGIME_ENUM,
  REVERSAL_DEFINITIONS,
  DISAGREEMENT_CORPUS,
  CORPUS_CANARY_BASELINE,
  RD1_COLUMNS,
  RD1_OUTPUT_FIELDS,
  RD1_REFUSALS,
  RD1_PREREGISTERED,
  validateReversalDefinitionContract,
  verifyDefinitionPaths,
  summarizeReversalDefinitionContract,
  buildDisagreementMatrix,
  evaluateCorpusRecord,
  applyReversalDefinitionContract,
};
