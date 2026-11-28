'use strict';
/**
 * V2 engine component map — the machine-readable inventory of the V1
 * Champion's duplicated-intelligence surfaces, delivered as backlog item
 * P1-0 (groundwork for the P1 consolidation specs P1-1..P1-5 in
 * `docs/research/AI_ENGINE_V2_EXECUTION_BACKLOG_20261127.md`).
 *
 * Every entry cites a real source path, the exported artifact (or null for
 * inline logic), and the constants with the line numbers verified on this
 * branch's tree. The companion document
 * `docs/research/AI_ENGINE_V2_COMPONENT_MAP_20261127.md` carries the full
 * tables and the count reconciliation against
 * `AI_ENGINE_V2_AUDIT_FINDINGS_20261127.md`.
 *
 * Research-only: this module reads nothing at validation time, grants no
 * order authority, and changes no runtime behavior (`executionAuthority:
 * NONE`). `verifyComponentPaths()` is the drift detector — CI re-proves on
 * every run that each mapped file still exists at the recorded location.
 */

const fs = require('node:fs');
const path = require('node:path');

const MAP_ARTIFACT = 'v2-engine-component-map-v1';

const ALLOWED_LAYERS = Object.freeze([
  'L0-data',
  'L1-features',
  'L2-candidate',
  'L3-governance',
  'L4-experts',
  'L5-orchestration',
  'L7-exits',
  'L8-evidence',
  'PY-engine',
]);

const ALLOWED_FAMILIES = Object.freeze([
  'direction-scorer',
  'reversal-definition',
  'reliability-gate',
  'calibration-layer',
  'calibration-auxiliary',
  'exit-engine',
  'prediction-family',
  'confidence-floor',
  'governance-core',
  'expert-consensus',
  'expert-registry',
  'owner-carveout',
  'expired-trial',
  'deprecated-shim',
  'feature-contract',
  'data-quality',
  'orchestration-core',
]);

/**
 * Audit-claimed counts from AI_ENGINE_V2_AUDIT_FINDINGS_20261127.md — the
 * map must reconcile exactly with these (exit engines: audit says
 * "four-plus", so the claim is a minimum).
 */
const AUDIT_CLAIMED_COUNTS = Object.freeze({
  'direction-scorer': 4,
  'reversal-definition': 6,
  'reliability-gate': 9,
  'calibration-layer': 6,
  'exit-engine': 4,
  'prediction-family': 5,
  'confidence-floor': 6,
});

const AI = 'apps/api/src/modules/ai';
const PY = 'services/ai-engine/app/domain';

const component = (key, layer, family, filePath, artifact, constants, notes) =>
  ({ key, layer, family, path: filePath, artifact, constants, notes });

const c = (name, value, line) => ({ name, value, line });

const ENGINE_COMPONENT_MAP_COMPONENTS = [
  // ------------------------------------------------------------------ A1: four direction scorers
  component('scorer.m1-tactical', 'L2-candidate', 'direction-scorer',
    `${AI}/m1-tactical-candidate.ts`, 'M1_TACTICAL_POLICY_V1',
    [
      c('stopAtrMultiplier', 1.1, 24),
      c('targetR', 1.6, 25),
      c('minStopPips', 5, 26),
      c('maxConfidence', 0.738, 27),
      c('minReversalQuality', 0.6, 32),
      c('minReversalImpulseAtr', 0.25, 33),
      c('compositeWeight.emaSeparationAtr', 0.19, 146),
      c('compositeWeight.emaSlopeAtr', 0.1, 147),
      c('compositeWeight.momentum3Atr', 0.16, 148),
      c('compositeWeight.momentum5Atr', 0.1, 149),
      c('compositeWeight.higherTimeframeAgreement', 0.2, 150),
      c('compositeWeight.closePressure', 0.08, 151),
      c('compositeWeight.wickPressure', 0.05, 152),
      c('compositeWeight.rsiBias', 0.04, 153),
      c('compositeWeight.breakoutAtr', 0.08, 154),
    ],
    '9-term fixed-weight composite -> directionQuality = clamp01(0.5 + composite/2) at line 156; confidence = min(0.738, clamp01(0.5 + 0.3*dq + 0.08*efficiency5 - 0.08*volatilityScore)) at lines 157-161; score = dq + 0.15*confidence + 0.05*momentum1Atr + 0.05*htfAgreement at lines 163-167.'),
  component('scorer.plan-b-multimodel-shadow', 'L2-candidate', 'direction-scorer',
    `${AI}/plan-b-multimodel-shadow.ts`, 'PLAN_B_ENSEMBLE_ARTIFACT',
    [
      c('PLAN_B_CANDIDATE_CONFIDENCE_FLOOR', 0.64, 50),
      c('PLAN_B_GROSS_EXPECTED_R_FLOOR', 0.08, 51),
      c('PLAN_B_PORTFOLIO_QUALITY_FLOOR', 0.35, 61),
      c('directionQualityWeight.confidence', 0.42, 124),
      c('directionQualityWeight.emaSeparation', 0.25, 124),
      c('directionQualityWeight.mtfStrength', 0.23, 124),
      c('directionQualityWeight.rsiDirectional', 0.1, 124),
    ],
    'directionQuality() at lines 124-133: clamp01(0.42*clamp01((confidence-0.6)/0.2) + 0.25*emaSeparation + 0.23*mtfStrength + 0.10*rsiDirectional); rsiDirectional = clamp01((rsi14-50)/22). Feeds the Plan-B shadow admission surface.'),
  component('scorer.v8-shadow-meta', 'L2-candidate', 'direction-scorer',
    `${AI}/v8-shadow-meta-scorer.ts`, 'V8_SHADOW_ARTIFACT',
    [
      c('V8_SHADOW_ADMISSION_THRESHOLD', 0.46, 3),
      c('V8_SHADOW_TARGET_R_MULTIPLE', 2.5 / 1.5, 4),
      c('PLAN_B_SHADOW_ADMISSION_THRESHOLD', 0.40828402366863903, 7),
      c('BASE_WEIGHTS.entryCount', 29, 51),
      c('BASE_WEIGHTS.bias', -0.11578161968250648, 52),
      c('BASE_WEIGHTS.confidence', 0.17961055475997342, 53),
      c('BASE_WEIGHTS.ema', 0.2708431513544996, 54),
      c('BASE_WEIGHTS.mtf', -0.3645333135056978, 58),
    ],
    'Frozen 29-entry logistic (BASE_WEIGHTS lines 51-80: bias + 7 base features + hour_cos/hour_sin + side_BUY/SELL + 6 sym_* + 12 ps_* + volatility); probability = sigmoid(logit) at line 131. Audit labeled it "30-feature"; the verified weight-table length is 29.'),
  component('scorer.adaptive-opportunity', 'L2-candidate', 'direction-scorer',
    `${AI}/adaptive-opportunity-score.ts`, 'ADAPTIVE_OPPORTUNITY_SCORE_ARTIFACT',
    [
      c('weight.netExpectedR', 0.24, 8),
      c('weight.regimeFit', 0.14, 9),
      c('weight.directionQuality', 0.11, 10),
      c('weight.tradeQuality', 0.1, 11),
      c('weight.exitQuality', 0.08, 12),
      c('weight.edgeQuality', 0.08, 13),
      c('weight.shadowDirectionalPulseQuality', 0.05, 14),
      c('weight.executionCostQuality', 0.08, 15),
      c('weight.diversificationQuality', 0.07, 16),
      c('weight.stabilityQuality', 0.05, 17),
    ],
    'Ten weighted inputs (weights sum to 1.00, ADAPTIVE_OPPORTUNITY_WEIGHTS lines 8-17); directionQuality is one input at 0.11, not the output.'),

  // ------------------------------------------------------------------ A2: six reversal definitions
  component('reversal.m1-route-impulse-and-m5-confirmed', 'L2-candidate', 'reversal-definition',
    `${AI}/m1-tactical-route.ts`, null,
    [
      c('reversalImpulse.minReversalQuality', 0.6, 97),
      c('reversalImpulse.minReversalImpulseAtr', 0.25, 97),
      c('m5ReversalConfirmed.establishedTurn.bodyPressure3', 0.08, 108),
      c('m5ReversalConfirmed.establishedTurn.momentum3Atr', 0.08, 108),
      c('m5ReversalConfirmed.establishedTurn.momentum1AtrFloor', -0.1, 108),
      c('m5ReversalConfirmed.decisiveFreshTurn.latestBodyPressure', 0.6, 114),
      c('m5ReversalConfirmed.decisiveFreshTurn.momentum1Atr', 0.3, 114),
      c('m5ReversalConfirmed.decisiveFreshTurn.momentum3AtrFloor', -0.1, 114),
    ],
    'reversalImpulse() at lines 97-106 (failed breakout against direction + quality + multi-bar momentum + ema slope > 0); m5ReversalConfirmed() at lines 108-118: establishedTurn OR decisiveFreshTurn on completed M5 bars.'),
  component('reversal.plan-b-confirmed', 'L2-candidate', 'reversal-definition',
    `${AI}/plan-b-multimodel-shadow.ts`, null,
    [
      c('confidenceFloor', 0.64, 50),
      c('maxExtensionAtr', 1.15, 143),
      c('maxVolatilityScore', 0.55, 144),
      c('minMomentumAtr', 0.5, 53),
      c('maxMomentumAtr', 1.5, 54),
      c('minGrossExpectedR', 0.18, 52),
    ],
    'reversalConfirmed() at lines 141-155: TREND_WEAK regime AND confidence >= 0.64 AND extension <= 1.15 AND volatility <= 0.55 AND momentum in [0.5, 1.5] AND expectedR >= 0.18.'),
  component('reversal.paired-direction', 'L2-candidate', 'reversal-definition',
    `${AI}/paired-direction-reversal.ts`, null,
    [
      c('PAIRED_REVERSAL_MIN_DIRECTION_PROBABILITY', 0.64, 3),
      c('PAIRED_REVERSAL_MIN_ABSOLUTE_PROBABILITY', 0.40828402366863903, 4),
      c('PAIRED_REVERSAL_MIN_ALIGNED_MOMENTUM_ATR', 0.15, 5),
      c('PAIRED_REVERSAL_MIN_RESEARCH_NET_EXPECTED_R', 0.08, 6),
    ],
    'Paired BUY/SELL probability-gap reversal gate; MIN_ABSOLUTE_PROBABILITY is an alias of PLAN_B_SHADOW_ADMISSION_THRESHOLD.'),
  component('reversal.timing-fusion-shadow', 'L2-candidate', 'reversal-definition',
    `${AI}/m1-reversal-timing-fusion-shadow.ts`, 'M1_REVERSAL_TIMING_FUSION_SHADOW_ARTIFACT',
    [
      c('M1_REVERSAL_TIMING_FUSION_MIN_QUALITY', 0.6, 6),
      c('M1_REVERSAL_TIMING_FUSION_MIN_MOMENTUM', 0.25, 7),
    ],
    'Fusion shadow over the M1/Plan-B reversal-timing disagreement.'),
  component('reversal.planb-m1-continuation-shadow', 'L2-candidate', 'reversal-definition',
    `${AI}/planb-reversal-m1-continuation-shadow.ts`, 'PLANB_REVERSAL_M1_CONTINUATION_SHADOW_ARTIFACT',
    [],
    'Observation-only shadow: a same-direction M1 continuation coexisting with a regime called CONFIRMED_REVERSAL (the definition mismatch service).'),
  component('reversal.cross-sleeve-canary', 'L2-candidate', 'reversal-definition',
    `${AI}/confirmed-reversal-cross-sleeve-canary.ts`, null,
    [
      c('CONFIRMED_REVERSAL_CROSS_SLEEVE_CANARY_LOT_CAP', 0.2, 14),
    ],
    'DEMO probe: cost-aware confirmed reversal must not inherit the EARLY_TRANSITION degraded-sample veto; four-hour broker-persisted recovery cooldown; 0.20-lot ceiling.'),

  // ------------------------------------------------------------------ A3: nine reliability gates
  component('reliability.m1-tactical', 'L3-governance', 'reliability-gate',
    `${AI}/m1-tactical-reliability.ts`, 'M1_RELIABILITY_MIN_SAMPLES',
    [
      c('M1_RELIABILITY_MIN_SAMPLES', 5, 6),
      c('M1_RELIABILITY_EARLY_LOSS_BRAKE_SAMPLES', 3, 7),
      c('M1_RELIABILITY_EARLY_TRANSITION_LOSS_BRAKE_SAMPLES', 2, 8),
      c('M1_RELIABILITY_RECENT_PAYOFF_SAMPLES', 5, 9),
      c('M1_RELIABILITY_RECENT_AVERAGE_R_FLOOR', -0.1, 10),
      c('M1_RELIABILITY_MAX_SAMPLES', 20, 11),
    ],
    'M1 route reliability with early-loss brakes.'),
  component('reliability.m1-shadow-pair-side', 'L3-governance', 'reliability-gate',
    `${AI}/m1-shadow-pair-side-reliability.ts`, 'M1_SHADOW_MICRO_MIN_SAMPLES',
    [
      c('M1_SHADOW_MICRO_MIN_SAMPLES', 3, 4),
      c('M1_SHADOW_MICRO_MAX_SAMPLES', 20, 5),
      c('M1_SHADOW_MICRO_MAX_AGE_DAYS', 7, 6),
      c('M1_SHADOW_MICRO_MIN_PROFIT_FACTOR', 1.5, 7),
      c('M1_SHADOW_MICRO_MIN_AVERAGE_R', 0.1, 8),
      c('M1_SHADOW_MICRO_MIN_POSITIVE_FRACTION', 0.4, 9),
    ],
    'Micro pair-side reliability gate.'),
  component('reliability.m1-meaningful-scout', 'L3-governance', 'reliability-gate',
    `${AI}/m1-meaningful-scout-reliability.ts`, 'M1_MEANINGFUL_SCOUT_MIN_SAMPLES',
    [
      c('M1_MEANINGFUL_SCOUT_MIN_SAMPLES', 6, 5),
      c('M1_MEANINGFUL_SCOUT_MAX_SAMPLES', 20, 6),
      c('M1_MEANINGFUL_SCOUT_MAX_AGE_DAYS', 7, 7),
      c('M1_MEANINGFUL_SCOUT_MIN_PROFIT_FACTOR', 1.5, 8),
      c('M1_MEANINGFUL_SCOUT_MIN_AVERAGE_R', 0.1, 9),
      c('M1_MEANINGFUL_SCOUT_MIN_POSITIVE_FRACTION', 0.4, 10),
    ],
    'Meaningful-scout reliability gate.'),
  component('reliability.m1-provisional-scout', 'L3-governance', 'reliability-gate',
    `${AI}/m1-provisional-scout-reliability.ts`, 'M1_PROVISIONAL_SCOUT_MIN_SAMPLES',
    [
      c('M1_PROVISIONAL_SCOUT_MIN_SAMPLES', 3, 5),
      c('M1_PROVISIONAL_SCOUT_MATURE_SAMPLE_FLOOR', 6, 6),
      c('M1_PROVISIONAL_SCOUT_MAX_AGE_DAYS', 7, 7),
      c('M1_PROVISIONAL_SCOUT_MIN_PROFIT_FACTOR', 2.0, 8),
      c('M1_PROVISIONAL_SCOUT_MIN_AVERAGE_R', 0.2, 9),
      c('M1_PROVISIONAL_SCOUT_MIN_POSITIVE_FRACTION', 0.5, 10),
    ],
    'Provisional-scout reliability gate (stiffer floors: PF 2.0, avgR 0.2, positive fraction 0.5).'),
  component('reliability.paper-route', 'L3-governance', 'reliability-gate',
    `${AI}/paper-route-reliability.ts`, 'PAPER_TREND_ROUTE_RELIABILITY_MIN_EPISODES',
    [
      c('PAPER_TREND_ROUTE_RELIABILITY_MIN_EPISODES', 20, 4),
      c('PAPER_TREND_ROUTE_RELIABILITY_MIN_PROFIT_FACTOR', 1.0, 5),
      c('PAPER_TREND_ROUTE_RELIABILITY_MAX_DRAWDOWN', 0.12, 6),
      c('PAPER_REVERSAL_ROUTE_RELIABILITY_MIN_EPISODES', 8, 8),
    ],
    'PAPER route reliability (trend 20 / reversal 8 episodes; PF 1.0; maxDD 0.12).'),
  component('reliability.paper-scout-realised-payoff', 'L3-governance', 'reliability-gate',
    `${AI}/paper-scout-realised-payoff.ts`, 'PAPER_SCOUT_REALISED_PAYOFF_MIN_TRADES',
    [
      c('PAPER_SCOUT_REALISED_PAYOFF_MIN_TRADES', 6, 2),
      c('PAPER_SCOUT_REALISED_PAYOFF_REDUCE_PF', 1.0, 3),
      c('PAPER_SCOUT_REALISED_PAYOFF_SHADOW_PF', 0.75, 4),
      c('PAPER_SCOUT_REALISED_PAYOFF_REDUCED_LOT_CAP', 0.05, 5),
    ],
    'PAPER scout realised-payoff gate with reduced-lot fallback (0.05 lots).'),
  component('reliability.demo-profitability-gate', 'L3-governance', 'reliability-gate',
    `${AI}/demo-profitability-reliability-gate.ts`, null,
    [
      c('lossStreakVetoReason', 'EARLY_LOSS_STREAK', 32),
      c('blockerCode', 'M1_DEMO_RELIABILITY_EARLY_LOSS_STREAK', 39),
    ],
    'DEMO profitability gate: converts M1 reliability loss-streak state into a DEMO blocker (no numeric floors of its own).'),
  component('reliability.pepperstone-demo-advisory-quality-risk', 'L3-governance', 'reliability-gate',
    `${AI}/pepperstone-demo-advisory-quality-risk.ts`, null,
    [
      c('recentSamplesMinimum', 3, 138),
    ],
    'Advisory quality/risk gate on recent Pepperstone DEMO evidence (inline floor recent.samples >= 3 at line 138).'),
  component('reliability.paper-research-requalification', 'L3-governance', 'reliability-gate',
    `${AI}/paper-research-requalification-shadow.ts`, 'PAPER_RESEARCH_REQUALIFICATION_MIN_EPISODES',
    [
      c('PAPER_RESEARCH_REQUALIFICATION_MIN_EPISODES', 8, 3),
      c('PAPER_RESEARCH_REQUALIFICATION_MIN_PROFIT_FACTOR', 1.15, 4),
      c('PAPER_RESEARCH_REQUALIFICATION_MIN_SHARPE', 1.0, 5),
      c('PAPER_RESEARCH_REQUALIFICATION_MAX_DRAWDOWN', 0.12, 6),
    ],
    'PAPER research requalification gate (episodes 8, PF 1.15, Sharpe 1.0, maxDD 0.12).'),

  // ------------------------------------------------------------------ A4: six calibration layers (+2 auxiliaries)
  component('calibration.adaptive-prediction', 'L3-governance', 'calibration-layer',
    `${AI}/adaptive-prediction-calibration.service.ts`, 'ADAPTIVE_PREDICTION_CALIBRATION_ARTIFACT',
    [
      c('ADAPTIVE_CALIBRATION_MIN_AUTHORITATIVE_SAMPLES', 12, 8),
      c('ADAPTIVE_CALIBRATION_MATURE_MIN_SAMPLES', 20, 9),
      c('ADAPTIVE_CALIBRATION_MIN_WINS', 5, 10),
      c('ADAPTIVE_CALIBRATION_MIN_LOSSES', 5, 11),
      c('ADAPTIVE_CALIBRATION_RESCUE_MIN_NET_EXPECTED_R', 0.12, 12),
      c('ADAPTIVE_CALIBRATION_PRIOR_WEIGHT', 8, 13),
    ],
    'Bayesian blend (prior weight 8) of confidence with realised win rate; authoritative at >=12 samples, mature at >=20; can inject ADAPTIVE_CALIBRATION_NEGATIVE_EDGE blockers (audit B4).'),
  component('calibration.adaptive-edge-matrix', 'L3-governance', 'calibration-layer',
    `${AI}/adaptive-edge-matrix.service.ts`, 'ADAPTIVE_EDGE_MATRIX_ARTIFACT',
    [
      c('ADAPTIVE_EDGE_MATURE_MIN_SAMPLES', 20, 7),
      c('ADAPTIVE_EDGE_MIN_WINS', 5, 8),
      c('ADAPTIVE_EDGE_MIN_LOSSES', 5, 9),
    ],
    'Per-instrument edge matrix; mature at >=20 samples; supplies edge quality + smoothed expectedR to the opportunity score.'),
  component('calibration.adaptive-shadow-directional-pulse', 'L3-governance', 'calibration-layer',
    `${AI}/adaptive-shadow-directional-pulse.ts`, 'ADAPTIVE_SHADOW_DIRECTIONAL_PULSE_ARTIFACT',
    [
      c('ADAPTIVE_SHADOW_DIRECTIONAL_PULSE_MAX_OUTCOMES_PER_SIDE', 10, 2),
      c('ADAPTIVE_SHADOW_DIRECTIONAL_PULSE_MIN_OUTCOMES_PER_SIDE', 4, 3),
      c('ADAPTIVE_SHADOW_DIRECTIONAL_PULSE_DECAY', 0.65, 4),
    ],
    'Exponentially decayed directional pulse over the last <=10 outcomes per side (decay^index, line 67).'),
  component('calibration.paper-spread-shadow', 'L3-governance', 'calibration-layer',
    `${AI}/paper-spread-calibration-shadow.ts`, 'PAPER_SPREAD_CALIBRATION_SHADOW_ARTIFACT',
    [
      c('PAPER_SPREAD_CALIBRATION_MIN_SAMPLES', 100, 4),
      c('PAPER_SPREAD_CALIBRATION_MIN_FIXED_FRACTION', 0.25, 5),
    ],
    'Spread calibration shadow; companion history module is mapped as calibration-auxiliary.'),
  component('calibration.m1-causal-commission', 'L3-governance', 'calibration-layer',
    `${AI}/m1-causal-commission-shadow.ts`, 'M1_CAUSAL_COMMISSION_SHADOW_ARTIFACT',
    [
      c('M1_CAUSAL_COMMISSION_MIN_PRIOR_TRADES', 5, 4),
      c('M1_CAUSAL_COMMISSION_PERCENTILE', 0.9, 5),
    ],
    'Fee p90 estimator from prior broker-observed trades; feeds the cost-stress layer (audit E4).'),
  component('calibration.m1-probation-causal-cost-stress', 'L3-governance', 'calibration-layer',
    `${AI}/m1-probation-causal-cost-stress.ts`, 'PROBATION_CAUSAL_COST_STRESS_ARTIFACT',
    [
      c('PROBATION_MIN_PRIOR_FEES', 5, 6),
      c('PROBATION_MIN_PRIOR_SPREAD_BARS', 5, 7),
      c('PROBATION_SPREAD_STRESS_MULTIPLIER', 1.25, 8),
      c('PROBATION_SLIPPAGE_STRESS_PIPS', 0.5, 9),
    ],
    'Probation-period broker cost stress (1.25x spread multiplier + 0.5 pip slippage).'),
  component('calibration.paper-spread-history', 'L3-governance', 'calibration-auxiliary',
    `${AI}/paper-spread-calibration-history.ts`, null,
    [],
    'Companion persistence for the spread calibration shadow (audit A4 counts shadow+history as one layer).'),
  component('calibration.bidirectional-conflict', 'L3-governance', 'calibration-auxiliary',
    `${AI}/calibration-bidirectional-conflict.ts`, 'CALIBRATION_BIDIRECTIONAL_CONFLICT_ARTIFACT',
    [],
    'Arbitrates conflicts between two of the engine\'s own calibration layers (audit F4 complexity signature).'),

  // ------------------------------------------------------------------ A7: exit engines (verified six)
  component('exit.paper-profit-lock', 'L7-exits', 'exit-engine',
    'apps/api/src/modules/broker/adapters/paper-broker.adapter.ts', null,
    [
      c('arm.standardR', 0.5, 719),
      c('arm.confirmedReversalR', 1.0, 668),
      c('arm.earlyTransitionR', 0.75, 669),
      c('retention.m1RescueBand', 0.4, 671),
      c('retention.0.50to0.75R', 0.7, 672),
      c('retention.0.75to1.00R', 0.75, 673),
      c('retention.1.00to1.50R', 0.8, 674),
      c('retention.1.50to2.00R', 0.85, 675),
      c('retention.>=2.00R', 0.9, 676),
    ],
    'evaluatePaperProfitLock() at line 687; arm floors at lines 715-731; the M1 rescue band 0.395R-<0.50R retains 40% (0.005R sampling tolerance for 5-second cadence, doc block lines 663-686).'),
  component('exit.pepperstone-demo-net-lock', 'L7-exits', 'exit-engine',
    'apps/api/src/modules/execution/reconciliation/pepperstone-demo-net-profit-lock.ts', 'PEPPERSTONE_DEMO_NET_LOCK_ARTIFACT',
    [
      c('retention.below0.50R', 0.55, 31),
      c('retention.0.50to0.75R', 0.65, 32),
      c('retention.0.75to1.00R', 0.75, 33),
      c('tpOverlayLadder.maximum', 0.91, 107),
    ],
    'Retention ladder at lines 31-33 (>=1.00R -> 0.80); progressive TP overlay ladder at lines 88-93 capped at 0.91 of target (line 107).'),
  component('exit.live-demo-profit-protection', 'L7-exits', 'exit-engine',
    'apps/api/src/modules/execution/reconciliation/live-demo-profit-protection.service.ts', 'CONTINUATION_RECOVERY_GRACE_MINUTES',
    [
      c('CONTINUATION_RECOVERY_GRACE_MINUTES', 4.5, 48),
    ],
    'Thesis/adverse evaluation service (ADVERSE_THESIS_FAILED, EMERGENCY_ADVERSE_CUT paths; thesis staleness states).'),
  component('exit.v89-demo-drawdown-guard', 'L7-exits', 'exit-engine',
    `${AI}/post-entry-demo-drawdown-guard.service.ts`, 'PLAN_B_V89_DEMO_DRAWDOWN_GUARD_ARTIFACT',
    [
      c('PLAN_B_V89_DEMO_DRAWDOWN_CHECKPOINT_MINUTES', 5, 12),
      c('PLAN_B_V89_DEMO_DRAWDOWN_DEADLINE_MINUTES', 7, 13),
      c('PLAN_B_V89_DEMO_DRAWDOWN_CLOSE_R', -0.4, 14),
      c('PLAN_B_V89_DEMO_DRAWDOWN_INTERVAL_MS', 15000, 15),
    ],
    'v8.9 DEMO 5m drawdown guard: force-close at <= -0.4R by minute 7 (authority DEMO_ONLY, modifiesExecution true).'),
  component('exit.pepperstone-demo-post-peak-rescue', 'L7-exits', 'exit-engine',
    'apps/api/src/modules/execution/reconciliation/pepperstone-demo-post-peak-rescue.ts', 'PEPPERSTONE_DEMO_POST_PEAK_ADVERSE_RESCUE_ARTIFACT',
    [
      c('unprotectedBand.lowerR', 0.3, 144),
      c('unprotectedBand.upperR', 0.5, 144),
      c('givebackThresholdFraction', 0.3, 152),
    ],
    'Post-peak adverse rescue only in the 0.30-0.50R unprotected band (line 144); giveback condition at line 152.'),
  component('exit.verified-profit-stop-runner', 'L7-exits', 'exit-engine',
    'apps/api/src/modules/execution/reconciliation/verified-profit-stop-runner-policy.ts', null,
    [
      c('feeInclusiveFloor.minimumRiskFraction', 0.1, 226),
      c('feeInclusiveFloor.absoluteMinimum', 1, 226),
    ],
    'Fee-inclusive stop floor: net >= max(0.1 * initialRiskPnl, $1) or FEE_INCLUSIVE_STOP_FLOOR_UNPROVABLE (fail-closed, lines 226-232).'),

  // ------------------------------------------------------------------ E3: five prediction families
  component('prediction.plan-b-expected-r', 'L2-candidate', 'prediction-family',
    `${AI}/plan-b-multimodel-shadow.ts`, 'PLAN_B_GROSS_EXPECTED_R_FLOOR',
    [
      c('PLAN_B_GROSS_EXPECTED_R_FLOOR', 0.08, 51),
    ],
    'Plan-B shadow expectedR (gross geometry family).'),
  component('prediction.v8-meta-probability', 'L2-candidate', 'prediction-family',
    `${AI}/v8-shadow-meta-scorer.ts`, 'V8_SHADOW_ADMISSION_THRESHOLD',
    [
      c('V8_SHADOW_ADMISSION_THRESHOLD', 0.46, 3),
    ],
    'v8 meta logistic probability (never re-fit since freeze; audit B2).'),
  component('prediction.adaptive-calibrated-winrate', 'L3-governance', 'prediction-family',
    `${AI}/adaptive-prediction-calibration.service.ts`, 'ADAPTIVE_PREDICTION_CALIBRATION_ARTIFACT',
    [
      c('ADAPTIVE_CALIBRATION_MIN_AUTHORITATIVE_SAMPLES', 12, 8),
      c('ADAPTIVE_CALIBRATION_PRIOR_WEIGHT', 8, 13),
    ],
    'Adaptive calibrated win rate (Bayesian blend, audit B4).'),
  component('prediction.owner-forecast-net-r', 'L4-experts', 'prediction-family',
    `${AI}/owner-demo-entry-outcome-model.generated.ts`, null,
    [
      c('confirmedReversalSamples', 53, 1),
      c('earlyTransitionSamples', 45, 1),
      c('trainingCutoff', '2026-11-19T00:00:00Z', 1),
      c('status', 'RESEARCH_ONLY', 1),
    ],
    'Generated owner logistic on 53 + 45 same-broker fills; 7 features; coefficients are NOT V2 inputs (audit B3/D5). Line 1 records the header provenance block.'),
  component('prediction.m1-expectancy-blend', 'L3-governance', 'prediction-family',
    `${AI}/m1-tactical-expectancy.ts`, 'M1_TACTICAL_EXPECTANCY_ARTIFACT',
    [
      c('M1_EXPECTANCY_REALISED_MIN_SAMPLES', 5, 4),
      c('M1_EXPECTANCY_PRIOR_WEIGHT', 5, 5),
      c('M1_EXPECTANCY_RECENT_WEIGHT', 0.25, 6),
    ],
    'M1 heuristic-prior / realised pair-side expectancy blend (prior 5 / recent 0.25).'),

  // ------------------------------------------------------------------ B5: confidence floor copies
  component('confidence-floor.py.model-qualification', 'PY-engine', 'confidence-floor',
    `${PY}/training/model_qualification.py`, null,
    [
      c('CONFIDENCE_FLOOR', 0.6, 49),
    ],
    'Python copy 1 of 5.'),
  component('confidence-floor.py.bounded-final-campaign', 'PY-engine', 'confidence-floor',
    `${PY}/training/bounded_final_campaign.py`, null,
    [
      c('CONFIDENCE_FLOOR', 0.6, 50),
    ],
    'Python copy 2 of 5.'),
  component('confidence-floor.py.six-pair-opportunity-selector', 'PY-engine', 'confidence-floor',
    `${PY}/training/six_pair_opportunity_selector.py`, null,
    [
      c('CONFIDENCE_FLOOR', 0.6, 38),
    ],
    'Python copy 3 of 5.'),
  component('confidence-floor.py.deterministic-strategy-ensemble', 'PY-engine', 'confidence-floor',
    `${PY}/training/deterministic_strategy_ensemble.py`, null,
    [
      c('CONFIDENCE_FLOOR', 0.6, 31),
    ],
    'Python copy 4 of 5.'),
  component('confidence-floor.py.side-selection-three-class', 'PY-engine', 'confidence-floor',
    `${PY}/training/side_selection_three_class.py`, null,
    [
      c('CONFIDENCE_FLOOR', 0.6, 32),
    ],
    'Python copy 5 of 5.'),
  component('confidence-floor.ts.strategy-orchestrator', 'L5-orchestration', 'confidence-floor',
    'apps/api/src/modules/strategy/strategy-orchestrator.service.ts', 'CONFIDENCE_THRESHOLD',
    [
      c('CONFIDENCE_THRESHOLD', 0.6, 67),
      c('clampMaximum', 0.7, 217),
    ],
    'TS copy: CONFIDENCE_THRESHOLD 0.6 clamped to 0.60-0.70 (lines 213-218) so DEMO/PAPER/LIVE share one enforcement path.'),

  // ------------------------------------------------------------------ governance core (E2)
  component('governance.ensemble-governance', 'L3-governance', 'governance-core',
    `${AI}/ensemble-governance.ts`, 'ENSEMBLE_PREDICTED_COST_ADMISSION_MODE',
    [
      c('ENSEMBLE_PREDICTED_COST_ADMISSION_MODE', 'SHADOW_ONLY', 15),
      c('driftEnvelope.hardLow', 0.640079, 133),
      c('driftEnvelope.hardHigh', 0.751451, 134),
      c('costR.spreadMultiplier', 1.25, 416),
      c('paperNetExpectedRFloor', 0.08, 431),
    ],
    'Frozen 4,599-event drift envelope (lines 126-134); netExpectedR = grossExpectedR - estimatedExecutionCostR with costR = 1.25*spread/stopDistance (line 416); predicted-cost veto demoted to SHADOW_ONLY (audit E2).'),

  // ------------------------------------------------------------------ A5: duplicated Python consensus
  component('expert.python-baseline-xgboost', 'L4-experts', 'expert-consensus',
    `${PY}/models/baseline_xgboost.py`, null,
    [
      c('regimeRouter.feature1', 'm1_spread_bps_median', 540),
      c('regimeRouter.feature2', 'm1_volatility_20_median', 543),
    ],
    'Event-pair-bundle regime router (pooled opportunity + per-pair direction + regime routing).'),
  component('expert.python-planb-v4-high-conviction', 'L4-experts', 'expert-consensus',
    `${PY}/models/high_conviction_challenger.py`, null,
    [
      c('routeRegime.feature1', 'm1_spread_bps_median', 317),
      c('routeRegime.feature2', 'm1_volatility_20_median', 319),
    ],
    'Frozen three-expert consensus using the same regime thresholds as baseline_xgboost (audit A5: same thresholds in both, lines 540-549 vs 317-325).'),

  // ------------------------------------------------------------------ F1: expert registry
  component('registry.ensemble-expert', 'L3-governance', 'expert-registry',
    `${AI}/ensemble-expert-registry.ts`, null,
    [
      c('entryCount', 12, 67),
      c('executionAuthorityNoneCount', 12, 67),
    ],
    '12-entry expert registry; every entry declares executionAuthority \'NONE\' (verified by counting artifact markers and NONE occurrences inside the entries block starting at line 67).'),

  // ------------------------------------------------------------------ A8: owner carve-outs
  component('carveout.ongoing-seven-lot', 'L5-orchestration', 'owner-carveout',
    `${AI}/owner-pepperstone-demo-ongoing-seven-lot.ts`, 'OWNER_DEMO_ONGOING_SEVEN_LOT_REQUESTED_MAX_LOTS',
    [
      c('OWNER_DEMO_ONGOING_SEVEN_LOT_START', '2026-11-20T12:50:00.000Z', 14),
      c('OWNER_DEMO_ONGOING_SEVEN_LOT_REQUESTED_MAX_LOTS', 7, 15),
      c('OWNER_DEMO_ONGOING_SEVEN_LOT_STOP_RISK_SCREEN_PERCENT', 0.75, 16),
    ],
    'Owner 7-lot requested ceiling.'),
  component('carveout.weak-reversal-exposure-ceiling', 'L5-orchestration', 'owner-carveout',
    `${AI}/owner-demo-weak-reversal-exposure-ceiling.ts`, 'OWNER_DEMO_STANDARD_EXPOSURE_CEILING_LOTS',
    [
      c('OWNER_DEMO_STANDARD_EXPOSURE_CEILING_LOTS', 4, 12),
    ],
    'Weak-reversal pull-back ceiling: 4 lots.'),
  component('carveout.high-conviction-lot-ceiling', 'L5-orchestration', 'owner-carveout',
    `${AI}/pepperstone-demo-high-conviction-lot-ceiling.ts`, 'HIGH_CONVICTION_CEILING_LOTS',
    [
      c('HIGH_CONVICTION_CEILING_LOTS', 6, 9),
    ],
    'High-conviction ceiling: 6 lots. "Narrowest cap wins" precedence is resolved inside the scheduler (audit A8).'),

  // ------------------------------------------------------------------ A9: expired trials + deprecated shim
  component('trial.demo-alternative', 'L5-orchestration', 'expired-trial',
    `${AI}/pepperstone-demo-alternative-trial.ts`, 'DEMO_ALTERNATIVE_TRIAL_END',
    [
      c('DEMO_ALTERNATIVE_TRIAL_END', '2026-11-16T21:00:00.000Z', 12),
    ],
    'Expired 2026-11-16; still evaluated as a predicate each scan.'),
  component('trial.advisory-alternate', 'L5-orchestration', 'expired-trial',
    `${AI}/pepperstone-demo-advisory-alternate-trial.ts`, 'ADVISORY_ALTERNATE_END',
    [
      c('ADVISORY_ALTERNATE_END', '2026-11-17T20:00:00.000Z', 15),
    ],
    'Expired 2026-11-17 (unless continuousEvidence).'),
  component('trial.counter-pilot', 'L5-orchestration', 'expired-trial',
    `${AI}/pepperstone-demo-counter-pilot.ts`, 'COUNTER_PILOT_END',
    [
      c('COUNTER_PILOT_START', '2026-11-20T21:12:00.000Z', 10),
      c('COUNTER_PILOT_END', '2026-11-20T22:00:00.000Z', 11),
      c('COUNTER_PILOT_LOT_CAP', 4, 12),
    ],
    'Expired 2026-11-20.'),
  component('trial.noon-lot', 'L5-orchestration', 'expired-trial',
    `${AI}/owner-pepperstone-demo-noon-lot-trial.ts`, 'OWNER_DEMO_NOON_LOT_TRIAL_END',
    [
      c('OWNER_DEMO_NOON_LOT_TRIAL_START', '2026-11-20T03:57:00.000Z', 13),
      c('OWNER_DEMO_NOON_LOT_TRIAL_END', '2026-11-20T12:00:00.000Z', 14),
      c('OWNER_DEMO_NOON_LOT_TRIAL_REQUESTED_MAX_LOTS', 6, 15),
    ],
    'Expired 2026-11-20.'),
  component('shim.multimodel-demo-authority', 'L5-orchestration', 'deprecated-shim',
    `${AI}/multimodel-demo-authority.ts`, null,
    [],
    '@deprecated re-export shim of ./multimodel-authority (line 1).'),

  // ------------------------------------------------------------------ L1: feature contracts
  component('features.ts-m1-tactical-snapshot', 'L1-features', 'feature-contract',
    `${AI}/m1-tactical-features.ts`, 'M1TacticalFeatureSnapshot',
    [
      c('interfaceDeclaredAt', 16, 16),
      c('fileLines', 502, 1),
    ],
    'TS 9-feature clamped M1 composite input contract (M1TacticalFeatureSnapshot at line 16; 502-line file).'),
  component('features.py-multitimeframe-contract', 'L1-features', 'feature-contract',
    `${PY}/models/multitimeframe_features.py`, 'multitimeframe_feature_columns',
    [
      c('columnCount', 128, 92),
    ],
    'Python 128-column MTF contract; columnCount VERIFIED BY EXECUTION of multitimeframe_feature_columns() (not a grep).'),

  // ------------------------------------------------------------------ C7/C8: data-quality surfaces
  component('data.price-digits', 'L0-data', 'data-quality',
    'apps/api/src/modules/market-data/market-data.service.ts', null,
    [
      c('priceDigits', 10, 97),
    ],
    'Uniform priceDigits = 10 computes spreadPoints on a fixed 10^10 scale for all instruments (audit C7: unit-fragile, JPY mis-scale risk).'),
  component('data.metaapi-candle-store', 'L0-data', 'data-quality',
    'apps/api/src/modules/market-data/services/provider-quote-candle-store.service.ts', null,
    [
      c('firstSampleOpenHighLowCloseShareValue', '$4', 48),
    ],
    'First-sample insert writes open=high=low=close as the same value ($4 x4, lines 48-58) — MetaApi 30-second quote snapshots persisted as M1 bars (audit C8: mixed provenance, no type discriminator).'),

  // ------------------------------------------------------------------ L5/L8: orchestration and evidence scale
  component('orchestration.m1-tactical-scheduler', 'L5-orchestration', 'orchestration-core',
    `${AI}/m1-tactical-scheduler.service.ts`, null,
    [
      c('fileLines', 4871, 1),
    ],
    'DEMO-path decider: the canExecute conjunction + carve-out precedence (audit F1/F2).'),
  component('orchestration.vps-forex-signal-collector', 'L5-orchestration', 'orchestration-core',
    `${AI}/vps-forex-signal-collector.service.ts`, null,
    [
      c('fileLines', 7283, 1),
    ],
    'PAPER-path collector (VPS external signals; different geometry and authority from the DEMO path; audit F2).'),
  component('orchestration.strategy-orchestrator', 'L5-orchestration', 'orchestration-core',
    'apps/api/src/modules/strategy/strategy-orchestrator.service.ts', null,
    [
      c('fileLines', 1536, 1),
    ],
    'Strategy orchestration incl. the promoted-DEMO tuple allowlist and confidence clamp.'),
  component('evidence.m1-tactical-evidence', 'L8-evidence', 'orchestration-core',
    `${AI}/m1-tactical-evidence.service.ts`, null,
    [
      c('fileLines', 3013, 1),
    ],
    'Decision-time persistence + outcome settlement (trading.m1_tactical_decisions).'),
];

const INVENTORY_COUNTS = Object.freeze({
  'direction-scorer': 4,
  'reversal-definition': 6,
  'reliability-gate': 9,
  'calibration-layer': 6,
  'calibration-auxiliary': 2,
  'exit-engine': 6,
  'prediction-family': 5,
  'confidence-floor': 6,
  'governance-core': 1,
  'expert-consensus': 2,
  'expert-registry': 1,
  'owner-carveout': 3,
  'expired-trial': 4,
  'deprecated-shim': 1,
  'feature-contract': 2,
  'data-quality': 2,
  'orchestration-core': 4,
});

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

const ENGINE_COMPONENT_MAP = deepFreeze(Object.freeze({
  meta: Object.freeze({
    artifact: MAP_ARTIFACT,
    capturedOn: '2026-11-27',
    scope: 'V1 Champion engine component inventory (research-only, P1-0)',
    executionAuthority: 'NONE',
    auditReference: 'docs/research/AI_ENGINE_V2_AUDIT_FINDINGS_20261127.md',
    companionDoc: 'docs/research/AI_ENGINE_V2_COMPONENT_MAP_20261127.md',
  }),
  auditClaims: AUDIT_CLAIMED_COUNTS,
  inventoryCounts: INVENTORY_COUNTS,
  pythonMtfColumnsClaim: 128,
  components: ENGINE_COMPONENT_MAP_COMPONENTS,
}));

// --------------------------------------------------------------- validation

const finiteNumber = (v) => typeof v === 'number' && Number.isFinite(v);
const nonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;

function countByFamily(components) {
  const counts = {};
  for (const entry of components) {
    counts[entry.family] = (counts[entry.family] || 0) + 1;
  }
  return counts;
}

/**
 * Validate the structural integrity and audit-count reconciliation of an
 * engine component map. Typed refusals: MAP_INPUT_REQUIRED,
 * MAP_META_INCOMPLETE, MAP_COMPONENTS_EMPTY, MAP_UNKNOWN_LAYER,
 * MAP_UNKNOWN_FAMILY, MAP_DUPLICATE_KEY, MAP_MISSING_FIELD,
 * MAP_CONSTANT_MALFORMED, MAP_COUNT_MISMATCH.
 */
function validateEngineComponentMap(map) {
  if (!map || typeof map !== 'object' || Array.isArray(map)) {
    throw new Error('MAP_INPUT_REQUIRED');
  }
  const meta = map.meta;
  if (!meta || !nonEmptyString(meta.artifact) || !nonEmptyString(meta.capturedOn)
      || meta.executionAuthority !== 'NONE') {
    throw new Error('MAP_META_INCOMPLETE');
  }
  if (!Array.isArray(map.components) || map.components.length === 0) {
    throw new Error('MAP_COMPONENTS_EMPTY');
  }
  const layers = new Set(ALLOWED_LAYERS);
  const families = new Set(ALLOWED_FAMILIES);
  const seenKeys = new Set();
  map.components.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`MAP_MISSING_FIELD: components[${index}] must be an object`);
    }
    for (const field of ['key', 'layer', 'family', 'path', 'constants', 'notes']) {
      if (!(field in entry)) {
        throw new Error(`MAP_MISSING_FIELD: components[${index}].${field}`);
      }
    }
    if (!nonEmptyString(entry.key)) {
      throw new Error(`MAP_MISSING_FIELD: components[${index}].key must be a non-empty string`);
    }
    if (seenKeys.has(entry.key)) {
      throw new Error(`MAP_DUPLICATE_KEY: ${entry.key}`);
    }
    seenKeys.add(entry.key);
    if (!layers.has(entry.layer)) {
      throw new Error(`MAP_UNKNOWN_LAYER: ${entry.layer} (component ${entry.key})`);
    }
    if (!families.has(entry.family)) {
      throw new Error(`MAP_UNKNOWN_FAMILY: ${entry.family} (component ${entry.key})`);
    }
    if (!nonEmptyString(entry.path) || entry.path.startsWith('/')
        || entry.path.includes('..')) {
      throw new Error(`MAP_MISSING_FIELD: components[${index}].path must be a relative in-repo path (${entry.path})`);
    }
    if (entry.artifact !== null && !nonEmptyString(entry.artifact)) {
      throw new Error(`MAP_MISSING_FIELD: components[${index}].artifact must be a non-empty string or null`);
    }
    if (!Array.isArray(entry.constants)) {
      throw new Error(`MAP_CONSTANT_MALFORMED: components[${index}].constants must be an array`);
    }
    entry.constants.forEach((k, kIndex) => {
      if (!k || typeof k !== 'object' || !nonEmptyString(k.name)
          || !(finiteNumber(k.value) || nonEmptyString(k.value) || typeof k.value === 'boolean')
          || !Number.isInteger(k.line) || k.line < 1) {
        throw new Error(`MAP_CONSTANT_MALFORMED: components[${index}].constants[${kIndex}]`);
      }
    });
    if (!nonEmptyString(entry.notes)) {
      throw new Error(`MAP_MISSING_FIELD: components[${index}].notes`);
    }
  });

  // Audit-count reconciliation (exact for the pinned families).
  const counts = countByFamily(map.components);
  for (const [family, claimed] of Object.entries(AUDIT_CLAIMED_COUNTS)) {
    const actual = counts[family] || 0;
    if (family === 'exit-engine') {
      if (actual < claimed) {
        throw new Error(`MAP_COUNT_MISMATCH: exit-engine expected >= ${claimed}, found ${actual}`);
      }
    } else if (actual !== claimed) {
      throw new Error(`MAP_COUNT_MISMATCH: ${family} expected ${claimed}, found ${actual}`);
    }
  }

  // Declared inventory counts must match the computed counts exactly.
  const declared = map.inventoryCounts;
  if (!declared || typeof declared !== 'object') {
    throw new Error('MAP_META_INCOMPLETE: inventoryCounts missing');
  }
  for (const family of Object.keys(declared)) {
    if ((counts[family] || 0) !== declared[family]) {
      throw new Error(`MAP_COUNT_MISMATCH: ${family} declared ${declared[family]}, found ${counts[family] || 0}`);
    }
  }
  for (const family of Object.keys(counts)) {
    if (!(family in declared)) {
      throw new Error(`MAP_COUNT_MISMATCH: family ${family} present but undeclared in inventoryCounts`);
    }
  }

  // The 128-column Python contract claim is pinned by execution.
  const mtf = map.components.find((e) => e.key === 'features.py-multitimeframe-contract');
  const columnCount = mtf && mtf.constants.find((k) => k.name === 'columnCount');
  if (!columnCount || columnCount.value !== map.pythonMtfColumnsClaim) {
    throw new Error(`MAP_COUNT_MISMATCH: pythonMtfColumnsClaim ${map.pythonMtfColumnsClaim} not pinned`);
  }
  return true;
}

/**
 * Verify every mapped source path exists under the repository root.
 * Typed refusal: MAP_PATH_NOT_FOUND. Returns { verified, total }.
 */
function verifyComponentPaths(map, repoRoot) {
  if (!map || !Array.isArray(map.components)) {
    throw new Error('MAP_INPUT_REQUIRED');
  }
  if (!nonEmptyString(repoRoot)) {
    throw new Error('MAP_INPUT_REQUIRED: repoRoot');
  }
  let verified = 0;
  for (const entry of map.components) {
    const resolved = path.join(repoRoot, entry.path);
    if (!fs.existsSync(resolved)) {
      throw new Error(`MAP_PATH_NOT_FOUND: ${entry.path} (component ${entry.key})`);
    }
    verified += 1;
  }
  return { verified, total: map.components.length };
}

/** Summary: counts per family/layer plus the audit reconciliation table. */
function summarizeEngineComponentMap(map) {
  validateEngineComponentMap(map);
  const byFamily = countByFamily(map.components);
  const byLayer = {};
  for (const entry of map.components) {
    byLayer[entry.layer] = (byLayer[entry.layer] || 0) + 1;
  }
  const auditClaimComparison = Object.entries(AUDIT_CLAIMED_COUNTS).map(([family, claimed]) => ({
    family,
    claimed,
    mapped: byFamily[family] || 0,
    reconciled: family === 'exit-engine' ? (byFamily[family] || 0) >= claimed
      : (byFamily[family] || 0) === claimed,
  }));
  return {
    artifact: map.meta.artifact,
    totalComponents: map.components.length,
    byFamily,
    byLayer,
    auditClaimComparison,
  };
}

module.exports = {
  ENGINE_COMPONENT_MAP,
  AUDIT_CLAIMED_COUNTS,
  ALLOWED_LAYERS,
  ALLOWED_FAMILIES,
  validateEngineComponentMap,
  verifyComponentPaths,
  summarizeEngineComponentMap,
};
