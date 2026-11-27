'use strict';
/**
 * V2 reliability-gate contract — the machine-readable mirror of backlog item
 * P1-3 (`docs/research/AI_ENGINE_V2_P1_3_RELIABILITY_CONSOLIDATION_SPEC_20261127.md`).
 *
 * Contents: (a) the verified inventory of the nine V1 reliability gates G1-G9
 * with floors, constants, line references and invocation sites; (b) the frozen
 * synthetic disagreement corpus RL-D01..RL-D12 — twelve borderline
 * sleeve-evidence snapshots on which the nine gates disagree today (ten
 * disagreement records plus two controls), evaluated by faithful research
 * mirrors of the nine predicates, never by hardcoded verdicts; (c) RL-1 — the
 * single V2 reliability contract (one sample ladder, one floor set per tier,
 * one authority gradient, one verdict vocabulary) with a fail-closed
 * application surface; (d) the extraction-seam anchors (SEAM-1/2/3) that pin
 * where the consolidation must cut, per the phase-2 map's runOnce finding.
 *
 * Research-only: this module grants no order authority, imports no runtime
 * path, and changes no runtime behavior (`executionAuthority: NONE`).
 * `verifyReliabilityGatePaths()` re-proves on every CI run that each mapped
 * gate file still exists AND still carries its pinned constants (content
 * anchors, never bare line numbers); `verifyOrchestrationSeams()` re-proves
 * that the scheduler and collector still invoke the gates where the seams are
 * pinned; `validateReliabilityGateContract()` re-computes the corpus verdict
 * matrix and reconciles every statistic against the committed expectations.
 *
 * Typed refusals raised by this module:
 *   RELIABILITY_CONTRACT_INPUT_REQUIRED, RELIABILITY_META_INCOMPLETE,
 *   RELIABILITY_COUNT_MISMATCH, RELIABILITY_DUPLICATE_KEY,
 *   RELIABILITY_MISSING_FIELD, RELIABILITY_CONSTANT_MALFORMED,
 *   RELIABILITY_CORPUS_RECORD_MALFORMED, RELIABILITY_VERDICT_MISMATCH,
 *   RELIABILITY_STATISTICS_MISMATCH, RELIABILITY_GATE_PATH_MISSING,
 *   RELIABILITY_CONSTANT_ANCHOR_MISSING, RELIABILITY_SEAM_ANCHOR_MISSING
 * and, from applyReliabilityContract():
 *   RELIABILITY_INPUT_REQUIRED, RELIABILITY_UNSUPPORTED_SURFACE,
 *   RELIABILITY_INPUT_OUT_OF_RANGE.
 */

const fs = require('node:fs');
const path = require('node:path');

const CONTRACT_ARTIFACT = 'v2-reliability-gate-contract-v1';

const AI = 'apps/api/src/modules/ai';
const SCHEDULER = `${AI}/m1-tactical-scheduler.service.ts`;
const COLLECTOR = `${AI}/vps-forex-signal-collector.service.ts`;

const const_ = (name, value, line) => ({ name, value, line });

// ------------------------------------------------- the nine reliability gates

const RELIABILITY_GATES = [
  {
    key: 'reliability.g1-m1-route-pair-side',
    path: `${AI}/m1-tactical-reliability.ts`,
    artifact: 'evaluateM1RoutePairSideReliability',
    role: 'executed-evidence admission gate — the only gate whose decision routes full-size V1 authority; asymmetric cold start (INSUFFICIENT_EVIDENCE is eligible=true)',
    predicate: [
      'evidence window: same route/instrument/direction, policy-lineage compatible, realisedPnl != 0, closedAt within 7 days (l.118-136); carry-forward from predecessor policies below the sample floor (l.142-158)',
      'decision ladder (l.223-378): giveback loss streak (2) -> early loss streak (3, or 2 for M1_EARLY_TRANSITION) with 180-min recovery-canary branch -> giveback caution (eligible=true, flagged) -> samples < 5 -> payoff geometry incomplete (fail-closed) -> average realized R <= 0 -> recent-5 payoff < -0.1 -> POSITIVE_EXPECTANCY',
      'smoothed win rate carries a 1/1 Laplace prior (l.23-24, l.164); expectancy uses the policy targetR (1.6)',
    ],
    constants: [
      const_('M1_RELIABILITY_MIN_SAMPLES', 5, 6),
      const_('M1_RELIABILITY_EARLY_LOSS_BRAKE_SAMPLES', 3, 7),
      const_('M1_RELIABILITY_EARLY_TRANSITION_LOSS_BRAKE_SAMPLES', 2, 8),
      const_('M1_RELIABILITY_RECENT_PAYOFF_SAMPLES', 5, 9),
      const_('M1_RELIABILITY_RECENT_AVERAGE_R_FLOOR', -0.1, 10),
      const_('M1_RELIABILITY_MAX_SAMPLES', 20, 11),
      const_('M1_RELIABILITY_CARRY_FORWARD_DAYS', 7, 12),
      const_('M1_RELIABILITY_EARLY_LOSS_COOLDOWN_MINUTES', 180, 15),
    ],
    sampleFloor: 5,
    authority: 'ADMISSION_GATE',
    callSites: [
      `${SCHEDULER}:4843 (evaluateM1RoutePairSideReliability)`,
      `${SCHEDULER}:165-168 (import block)`,
    ],
    notes: 'Ten reason codes; the only gate that requires provable per-trade risk geometry once mature (PAYOFF_EVIDENCE_INCOMPLETE, l.315-333).',
  },
  {
    key: 'reliability.g2-shadow-pair-side-micro',
    path: `${AI}/m1-shadow-pair-side-reliability.ts`,
    artifact: 'evaluateM1ShadowPairSideReliability',
    role: 'scout tier — shadow pair/side micro evidence for M1_EARLY_TRANSITION only',
    predicate: [
      'route restriction: M1_EARLY_TRANSITION only (l.73-75)',
      'window: 7 days, latest 20 outcomes (l.77-89)',
      'ladder (l.91-107): < 3 samples -> INSUFFICIENT_SHADOW_EVIDENCE -> last 3 all netR <= 0 -> RECENT_SHADOW_LOSS_STREAK -> PF >= 1.5 && averageNetR >= 0.1 && positiveFraction >= 0.4 -> POSITIVE_SHADOW_EXPECTANCY',
    ],
    constants: [
      const_('M1_SHADOW_MICRO_MIN_SAMPLES', 3, 4),
      const_('M1_SHADOW_MICRO_MAX_SAMPLES', 20, 5),
      const_('M1_SHADOW_MICRO_MAX_AGE_DAYS', 7, 6),
      const_('M1_SHADOW_MICRO_MIN_PROFIT_FACTOR', 1.5, 7),
      const_('M1_SHADOW_MICRO_MIN_AVERAGE_R', 0.1, 8),
      const_('M1_SHADOW_MICRO_MIN_POSITIVE_FRACTION', 0.4, 9),
    ],
    sampleFloor: 3,
    authority: 'SCOUT_TIER',
    callSites: [
      `${SCHEDULER}:4815 (evaluateM1ShadowPairSideReliability)`,
      `${SCHEDULER}:178-181 (import block)`,
    ],
    notes: 'Recent-degradation predicate: ALL last-3 outcomes non-positive (l.94) — differs from G3/G4 which use the sum.',
  },
  {
    key: 'reliability.g3-meaningful-scout',
    path: `${AI}/m1-meaningful-scout-reliability.ts`,
    artifact: 'evaluateM1MeaningfulScoutReliability',
    role: 'scout tier — meaningful scout evidence, the primary scout rung above the micro floor',
    predicate: [
      'route restriction: M1_EARLY_TRANSITION only (l.81-83)',
      'window: 7 days, latest 20 outcomes (l.85-97)',
      'ladder (l.99-116): < 6 samples -> INSUFFICIENT_MEANINGFUL_EVIDENCE -> recent-3 sum <= 0 -> RECENT_MEANINGFUL_DEGRADATION -> PF >= 1.5 && averageNetR >= 0.1 && positiveFraction >= 0.4 -> POSITIVE_MEANINGFUL_EXPECTANCY',
    ],
    constants: [
      const_('M1_MEANINGFUL_SCOUT_MIN_SAMPLES', 6, 5),
      const_('M1_MEANINGFUL_SCOUT_MAX_SAMPLES', 20, 6),
      const_('M1_MEANINGFUL_SCOUT_MAX_AGE_DAYS', 7, 7),
      const_('M1_MEANINGFUL_SCOUT_MIN_PROFIT_FACTOR', 1.5, 8),
      const_('M1_MEANINGFUL_SCOUT_MIN_AVERAGE_R', 0.1, 9),
      const_('M1_MEANINGFUL_SCOUT_MIN_POSITIVE_FRACTION', 0.4, 10),
      const_('M1_MEANINGFUL_SCOUT_RECENT_SAMPLE_COUNT', 3, 11),
    ],
    sampleFloor: 6,
    authority: 'SCOUT_TIER',
    callSites: [
      `${SCHEDULER}:4785 and :4797 (evaluateM1MeaningfulScoutReliability, two invocations)`,
      `${SCHEDULER}:184-187 (import block)`,
    ],
    notes: 'Recent-degradation predicate: recent-3 SUM <= 0 (l.104) — fires where G2\'s all-<=0 rule does not (corpus RL-D05).',
  },
  {
    key: 'reliability.g4-provisional-scout',
    path: `${AI}/m1-provisional-scout-reliability.ts`,
    artifact: 'evaluateM1ProvisionalScoutReliability',
    role: 'scout tier — the provisional rung below the meaningful floor; the only gate with a lot cap and the only gate that REFUSES because evidence became mature',
    predicate: [
      'route restriction: M1_EARLY_TRANSITION only (l.80-82)',
      'window: 7 days, sorted but NOT capped (no max-sample slice, l.85-95)',
      'ladder (l.97-116): >= 6 samples -> MATURE_EVIDENCE_AVAILABLE (handoff, never eligible) -> < 3 -> INSUFFICIENT_PROVISIONAL_EVIDENCE -> recent-3 sum <= 0 -> RECENT_PROVISIONAL_DEGRADATION -> PF >= 2.0 && averageNetR >= 0.2 && positiveFraction >= 0.5 -> POSITIVE_PROVISIONAL_EXPECTANCY (tier PROVISIONAL)',
    ],
    constants: [
      const_('M1_PROVISIONAL_SCOUT_MIN_SAMPLES', 3, 5),
      const_('M1_PROVISIONAL_SCOUT_MATURE_SAMPLE_FLOOR', 6, 6),
      const_('M1_PROVISIONAL_SCOUT_MAX_AGE_DAYS', 7, 7),
      const_('M1_PROVISIONAL_SCOUT_MIN_PROFIT_FACTOR', 2.0, 8),
      const_('M1_PROVISIONAL_SCOUT_MIN_AVERAGE_R', 0.2, 9),
      const_('M1_PROVISIONAL_SCOUT_MIN_POSITIVE_FRACTION', 0.5, 10),
      const_('M1_PROVISIONAL_SCOUT_LOT_CAP', 0.05, 11),
    ],
    sampleFloor: 3,
    authority: 'SCOUT_TIER',
    callSites: [
      `${SCHEDULER}:4806 (evaluateM1ProvisionalScoutReliability)`,
      `${SCHEDULER}:190-193 (import block)`,
    ],
    notes: 'The strictest floor constellation (PF 2.0 / avgR 0.2 / posFrac 0.5) and the ladder handoff seam at the mature floor 6.',
  },
  {
    key: 'reliability.g5-paper-route',
    path: `${AI}/paper-route-reliability.ts`,
    artifact: 'evaluatePaperTrendRouteReliability (+5 sibling evaluators and 2 execution gates)',
    role: 'paper sleeve tier — route-wide and pair/side reliability for the collector paper path (trend 20 / reversal 8 / pair-side 8 episode floors)',
    predicate: [
      'evaluatePaperTrendRouteReliability (l.290-365): TREND_CONTINUATION only -> < 20 episodes COLLECTING -> maxDD > 0.12 RESEARCH_ONLY -> PF < 1.0 RESEARCH_ONLY -> HEALTHY',
      'evaluatePaperTrendPairSideReliabilityShadow (l.38-83): TREND_CONTINUATION|CONFIRMED_REVERSAL -> < 8 episodes COLLECTING -> same maxDD/PF floors -> WEAK; the non-shadow wrapper (l.106-136) maps WEAK -> RESEARCH_ONLY + researchFallbackRequested',
      'evaluatePaperReversalRouteReliability (l.154-220): CONFIRMED_REVERSAL only -> < 8 episodes COLLECTING (fullSizeEligible stays TRUE, unlike trend) -> same floors',
      'evaluatePaperRealisedContinuationRouteReliability (l.403-449): < 20 realised trades COLLECTING -> PF < 1.0 RESEARCH_ONLY',
      'execution gates (l.229-266, l.457-469): compose full-size eligibility; the mature-healthy-pair-side override can rescue a demoted route',
    ],
    constants: [
      const_('PAPER_TREND_ROUTE_RELIABILITY_MIN_EPISODES', 20, 4),
      const_('PAPER_TREND_ROUTE_RELIABILITY_MIN_PROFIT_FACTOR', 1.0, 5),
      const_('PAPER_TREND_ROUTE_RELIABILITY_MAX_DRAWDOWN', 0.12, 6),
      const_('PAPER_REVERSAL_ROUTE_RELIABILITY_MIN_EPISODES', 8, 8),
      const_('PAPER_TREND_PAIR_SIDE_RELIABILITY_MIN_EPISODES', 8, 12),
      const_('PAPER_REALISED_CONTINUATION_ROUTE_RELIABILITY_MIN_TRADES', 20, 369),
    ],
    sampleFloor: 20,
    authority: 'PAPER_TIER',
    callSites: [
      `${COLLECTOR}:4832/4836 (trend/reversal route)`,
      `${COLLECTOR}:4851 and :5359 (pair side)`,
      `${COLLECTOR}:4863/4892 (execution gates)`,
      `${COLLECTOR}:111 (import block)`,
    ],
    notes: 'One file, six evaluators sharing the PF 1.0 / maxDD 0.12 pair but split across three episode floors (20/8/8) — the route-level rung of the ladder.',
  },
  {
    key: 'reliability.g6-paper-scout-realised-payoff',
    path: `${AI}/paper-scout-realised-payoff.ts`,
    artifact: 'evaluatePaperScoutRealisedPayoff',
    role: 'paper scout tier — realised payoff state machine; the only gate whose authority degrades gradually (PAPER -> PAPER-capped -> SHADOW_ONLY)',
    predicate: [
      'ladder (l.56-92): < 6 closed trades -> COLLECTING (authority stays PAPER) -> netPnl < 0 && PF < 0.75 -> SHADOW_ONLY -> netPnl < 0 && PF < 1.0 -> REDUCED (lot cap 0.05, authority stays PAPER) -> HEALTHY',
      'applyPaperScoutRealisedPayoffAuthority (l.95-110): SHADOW_ONLY forbids execution; REDUCED min-clamps the lot upper bound',
    ],
    constants: [
      const_('PAPER_SCOUT_REALISED_PAYOFF_MIN_TRADES', 6, 2),
      const_('PAPER_SCOUT_REALISED_PAYOFF_REDUCE_PF', 1.0, 3),
      const_('PAPER_SCOUT_REALISED_PAYOFF_SHADOW_PF', 0.75, 4),
      const_('PAPER_SCOUT_REALISED_PAYOFF_REDUCED_LOT_CAP', 0.05, 5),
    ],
    sampleFloor: 6,
    authority: 'PAPER_TIER',
    callSites: [
      `${COLLECTOR}:3137 (evaluatePaperScoutRealisedPayoff)`,
      `${COLLECTOR}:161 (import block)`,
    ],
    notes: 'Same PF<1.0 concept as G5 but with a different disposition: a capped-lot REDUCED state instead of research-only demotion (corpus RL-D04).',
  },
  {
    key: 'reliability.g7-demo-profitability-composition',
    path: `${AI}/demo-profitability-reliability-gate.ts`,
    artifact: 'evaluateDemoProfitabilityReliabilityGate',
    role: 'composition veto — converts G1/G3/G4 reason codes into the two DEMO blockers; consumes REASONS, not samples',
    predicate: [
      'lossStreakVeto = m1ReliabilityReason === "EARLY_LOSS_STREAK" (l.32) — note: EARLY_LOSS_STREAK_RECOVERY_CANARY deliberately does NOT veto',
      'degradedEarlyTransitionVeto = m1Route === M1_EARLY_TRANSITION && pairSideReliability.eligible === false && reason in {WEAK_MEANINGFUL_EXPECTANCY, RECENT_MEANINGFUL_DEGRADATION, WEAK_PROVISIONAL_EXPECTANCY, RECENT_PROVISIONAL_DEGRADATION} (l.22-36)',
      'blockers (l.38-42): M1_DEMO_RELIABILITY_EARLY_LOSS_STREAK, M1_DEMO_EARLY_TRANSITION_PAIR_SIDE_DEGRADED; executable = blockers empty',
    ],
    constants: [],
    sampleFloor: null,
    authority: 'COMPOSITION_VETO',
    callSites: [
      `${SCHEDULER}:1699 (evaluateDemoProfitabilityReliabilityGate)`,
      `${SCHEDULER}:158 (import)`,
    ],
    notes: 'No numeric floors of its own; the veto vocabulary covers only 2 of G1\'s ten failure reasons and 4 of G3/G4\'s — the composition gap RL-1 must close (corpus RL-D07).',
  },
  {
    key: 'reliability.g8-pepperstone-advisory-quality',
    path: `${AI}/pepperstone-demo-advisory-quality-risk.ts`,
    artifact: 'evaluatePepperstoneDemoAdvisoryQuality',
    role: 'advisory-only risk overlay — multiplies requested risk, can never veto or enlarge (the only continuous-output gate)',
    predicate: [
      'route restriction: CONFIRMED_REVERSAL | EARLY_TRANSITION else NOT_ALTERNATE_ROUTE (l.97-110)',
      'multipliers: double abstain x0.5 (l.113), single abstain x0.75 (l.116), M1 continuation mismatch x0.65 (l.122), M5+H1 against x0.7 (l.128), M5 against x0.85 (l.131), recent same-pair-side net-losing x0.7 (l.149)',
      'recent-loss evidence: inline floor recent.samples >= 3 (l.138), losing >= ceil(samples * 0.6) and averageNetR < 0 (l.145-146)',
      'output clamped to [0.2, 1] rounded to 4 decimals (l.155) — the 0.2 floor is the only named bound',
    ],
    constants: [
      const_('advisoryFloor', 0.2, 155), // inline literal, Math.max clamp
      const_('recentSamplesInlineFloor', 3, 138), // inline literal: recent.samples >= 3
      const_('losingFractionCeiling', 0.6, 145), // inline literal: losing >= ceil(samples * 0.6)
      const_('momentumBandAtrShare', 0.35, 50), // inline literal: broker-completed momentum band
    ].map((c) => ({
      ...c,
      anchor: {
        advisoryFloor: 'Math\\.max\\(0\.2, Math\\.min\\(1,',
        recentSamplesInlineFloor: 'recent\\.samples >= 3',
        losingFractionCeiling: 'recent!?\\.losing >= Math\\.ceil\\(recent!?\\.samples \\* 0\\.6\\)',
        momentumBandAtrShare: 'stopDistance \\* 0\\.35',
      }[c.name],
    })),
    sampleFloor: 3,
    authority: 'ADVISORY_ONLY',
    callSites: [
      `${SCHEDULER}:4020 (evaluatePepperstoneDemoAdvisoryQuality, assignment prepared l.3998)`,
      `${SCHEDULER}:53 (import)`,
    ],
    notes: 'Broker-completed M5/H1 momentum direction is computed from bars inside the gate; the RL-1 mirror consumes the direction verdict as frozen evidence (out of reliability scope).',
  },
  {
    key: 'reliability.g9-paper-requalification-shadow',
    path: `${AI}/paper-research-requalification-shadow.ts`,
    artifact: 'evaluatePaperResearchRequalificationShadow / evaluatePaperResearchRequalificationEvidence',
    role: 'requalification shadow — strictly NONE authority; decides whether a recovery candidate may be OBSERVED, never traded',
    predicate: [
      'shadow ladder (l.45-72): throughput -> pairSide -> episode -> calibration -> costAware reasons; candidate only when every block is green',
      'evidence ladder (l.103-150): < 8 episodes -> COLLECTING -> PF gate (losses==0 ? wins>0 && netR>0 : PF >= 1.15) && Sharpe >= 1.0 && maxDD <= 0.12 && netR > 0 -> RECOVERY_SIGNAL else WEAK',
      'every decision hard-codes executionAuthority NONE, modifiesExecution false, productionEligible false (l.55-71, l.115-129)',
    ],
    constants: [
      const_('PAPER_RESEARCH_REQUALIFICATION_MIN_EPISODES', 8, 3),
      const_('PAPER_RESEARCH_REQUALIFICATION_MIN_PROFIT_FACTOR', 1.15, 4),
      const_('PAPER_RESEARCH_REQUALIFICATION_MIN_SHARPE', 1.0, 5),
      const_('PAPER_RESEARCH_REQUALIFICATION_MAX_DRAWDOWN', 0.12, 6),
    ],
    sampleFloor: 8,
    authority: 'SHADOW_NONE',
    callSites: [
      `${COLLECTOR}:2472 (evaluatePaperResearchRequalificationShadow)`,
      `${COLLECTOR}:147 (import block)`,
    ],
    notes: 'PF 1.15 is a fourth profit-factor rung (0.75 / 1.0 / 1.15 / 1.5 / 2.0 across G6/G5/G9/G2-G3/G4) — recorded as a requalification stratifier in RL-1, not a separate ladder.',
  },
];

const RELIABILITY_GATE_COUNT = RELIABILITY_GATES.length; // 9 — reconciles with component map / audit A3

// ------------------------------------------- faithful predicate mirrors (research)

// Shared scout-window selection: 7-day age window, newest-first, optional cap.
// Faithful to G2/G3 (slice to max) and G4 (sort only, no slice).
function scoutWindow(outcomes, evaluatedAtMs, maxAgeDays, cap) {
  const cutoff = evaluatedAtMs - maxAgeDays * 24 * 60 * 60_000;
  const filtered = (outcomes || [])
    .filter((row) => {
      const observedAtMs = Date.parse(row.observedAt);
      return (
        Number.isFinite(observedAtMs) &&
        observedAtMs <= evaluatedAtMs &&
        observedAtMs >= cutoff &&
        Number.isFinite(row.netR)
      );
    })
    .sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt));
  return cap == null ? filtered : filtered.slice(0, cap);
}

function scoutMetrics(selected) {
  const positive = selected.filter((row) => row.netR > 0).length;
  const totalNetR = selected.reduce((sum, row) => sum + row.netR, 0);
  const grossProfit = selected.reduce((sum, row) => sum + Math.max(row.netR, 0), 0);
  const grossLoss = -selected.reduce((sum, row) => sum + Math.min(row.netR, 0), 0);
  return {
    samples: selected.length,
    positive,
    averageNetR: selected.length ? totalNetR / selected.length : 0,
    recentNetR: selected.slice(0, 3).reduce((sum, row) => sum + row.netR, 0),
    profitFactor:
      grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Number.POSITIVE_INFINITY : null,
    positiveFraction: selected.length ? positive / selected.length : 0,
  };
}

function mirrorG2(input) {
  const evaluatedAtMs = Date.parse(input.evaluatedAt);
  if (!Number.isFinite(evaluatedAtMs) || !Array.isArray(input.outcomes)) {
    return { eligible: false, reason: 'INVALID_SHADOW_EVIDENCE' };
  }
  if (input.route !== 'M1_EARLY_TRANSITION') {
    return { eligible: false, reason: 'ROUTE_NOT_MICRO_ELIGIBLE' };
  }
  const selected = scoutWindow(input.outcomes, evaluatedAtMs, 7, 20);
  if (selected.length < 3) return { eligible: false, reason: 'INSUFFICIENT_SHADOW_EVIDENCE' };
  if (selected.slice(0, 3).every((row) => row.netR <= 0)) {
    return { eligible: false, reason: 'RECENT_SHADOW_LOSS_STREAK' };
  }
  const m = scoutMetrics(selected);
  const profitable =
    m.profitFactor !== null &&
    m.profitFactor >= 1.5 &&
    m.averageNetR >= 0.1 &&
    m.positiveFraction >= 0.4;
  return profitable
    ? { eligible: true, reason: 'POSITIVE_SHADOW_EXPECTANCY' }
    : { eligible: false, reason: 'WEAK_SHADOW_EXPECTANCY' };
}

function mirrorG3(input) {
  const evaluatedAtMs = Date.parse(input.evaluatedAt);
  if (!Number.isFinite(evaluatedAtMs) || !Array.isArray(input.outcomes)) {
    return { eligible: false, reason: 'INVALID_MEANINGFUL_EVIDENCE' };
  }
  if (input.route !== 'M1_EARLY_TRANSITION') {
    return { eligible: false, reason: 'ROUTE_NOT_MEANINGFUL_SCOUT_ELIGIBLE' };
  }
  const selected = scoutWindow(input.outcomes, evaluatedAtMs, 7, 20);
  if (selected.length < 6) return { eligible: false, reason: 'INSUFFICIENT_MEANINGFUL_EVIDENCE' };
  const m = scoutMetrics(selected);
  if (m.recentNetR <= 0) return { eligible: false, reason: 'RECENT_MEANINGFUL_DEGRADATION' };
  const profitable =
    m.profitFactor !== null &&
    m.profitFactor >= 1.5 &&
    m.averageNetR >= 0.1 &&
    m.positiveFraction >= 0.4;
  return profitable
    ? { eligible: true, reason: 'POSITIVE_MEANINGFUL_EXPECTANCY' }
    : { eligible: false, reason: 'WEAK_MEANINGFUL_EXPECTANCY' };
}

function mirrorG4(input) {
  const evaluatedAtMs = Date.parse(input.evaluatedAt);
  if (!Number.isFinite(evaluatedAtMs) || !Array.isArray(input.outcomes)) {
    return { eligible: false, reason: 'INVALID_PROVISIONAL_EVIDENCE' };
  }
  if (input.route !== 'M1_EARLY_TRANSITION') {
    return { eligible: false, reason: 'ROUTE_NOT_PROVISIONAL_SCOUT_ELIGIBLE' };
  }
  const selected = scoutWindow(input.outcomes, evaluatedAtMs, 7, null); // no cap — faithful to l.85-95
  if (selected.length >= 6) return { eligible: false, reason: 'MATURE_EVIDENCE_AVAILABLE' };
  if (selected.length < 3) return { eligible: false, reason: 'INSUFFICIENT_PROVISIONAL_EVIDENCE' };
  const m = scoutMetrics(selected);
  if (m.recentNetR <= 0) return { eligible: false, reason: 'RECENT_PROVISIONAL_DEGRADATION' };
  const profitable =
    m.profitFactor !== null &&
    m.profitFactor >= 2.0 &&
    m.averageNetR >= 0.2 &&
    m.positiveFraction >= 0.5;
  return profitable
    ? { eligible: true, reason: 'POSITIVE_PROVISIONAL_EXPECTANCY' }
    : { eligible: false, reason: 'WEAK_PROVISIONAL_EXPECTANCY' };
}

// G1 — executed-evidence admission ladder. Policy lineage frozen to the three
// versions the source declares (l.17-21); targetR frozen to the V1 policy's
// 1.6 (m1-tactical-candidate.ts l.25) for the smoothed expectancy field.
const G1_POLICY_LINEAGE = Object.freeze({
  'm1-tactical-v1': Object.freeze(['m1-tactical-v1']),
  'm1-tactical-v1-cal1': Object.freeze(['m1-tactical-v1-cal1', 'm1-tactical-v1']),
  'm1-tactical-v2-m5-lifecycle': Object.freeze(['m1-tactical-v2-m5-lifecycle']),
});
const G1_TARGET_R = 1.6;

function mirrorG1(input) {
  const evaluatedAtMs = Date.parse(input.evaluatedAt);
  const instrument = String(input.instrument || '').trim().toUpperCase();
  if (
    !Number.isFinite(evaluatedAtMs) ||
    !instrument ||
    !String(input.currentPolicyVersion || '').trim() ||
    !Array.isArray(input.evidenceRows)
  ) {
    return { eligible: false, reason: 'INVALID_EVIDENCE' };
  }
  const compatible = G1_POLICY_LINEAGE[input.currentPolicyVersion] || [input.currentPolicyVersion];
  const compatibleSet = new Set(compatible);
  const cutoffMs = evaluatedAtMs - 7 * 24 * 60 * 60_000;
  const matching = input.evidenceRows
    .filter((row) => {
      const closedAtMs = Date.parse(row.closedAt);
      return (
        row.route === input.route &&
        String(row.instrument || '').trim().toUpperCase() === instrument &&
        row.direction === input.direction &&
        compatibleSet.has(row.policyVersion) &&
        Number.isFinite(row.realisedPnl) &&
        row.realisedPnl !== 0 &&
        Number.isFinite(closedAtMs) &&
        closedAtMs <= evaluatedAtMs &&
        closedAtMs >= cutoffMs
      );
    })
    .sort((a, b) => Date.parse(b.closedAt) - Date.parse(a.closedAt));

  const current = matching
    .filter((row) => row.policyVersion === input.currentPolicyVersion)
    .slice(0, 20);

  let selected;
  let carriedSamples = 0;
  if (current.length >= 5) {
    selected = current;
  } else {
    const missing = 5 - current.length;
    const predecessor = matching
      .filter((row) => row.policyVersion !== input.currentPolicyVersion)
      .sort((a, b) => {
        const policyOrder =
          compatible.indexOf(a.policyVersion) - compatible.indexOf(b.policyVersion);
        return policyOrder !== 0 ? policyOrder : Date.parse(b.closedAt) - Date.parse(a.closedAt);
      })
      .slice(0, missing);
    carriedSamples = predecessor.length;
    selected = [...current, ...predecessor];
  }

  selected = [...selected].sort((a, b) => Date.parse(b.closedAt) - Date.parse(a.closedAt));
  const wins = selected.filter((row) => row.realisedPnl > 0).length;
  const losses = selected.filter((row) => row.realisedPnl < 0).length;
  const samples = wins + losses;
  const smoothedWinRate = (wins + 1) / (samples + 2);
  const rValues = selected.flatMap((row) => {
    const risk = Number(row.riskAtStop);
    return Number.isFinite(risk) && risk > 0 ? [row.realisedPnl / risk] : [];
  });
  const realizedRSamples = rValues.length;
  const averageRealizedR =
    realizedRSamples > 0 ? rValues.reduce((s, v) => s + v, 0) / realizedRSamples : null;
  const recentPayoffRows = selected.slice(0, 5);
  const recentPayoffValues = recentPayoffRows.flatMap((row) => {
    const risk = Number(row.riskAtStop);
    return Number.isFinite(risk) && risk > 0 ? [row.realisedPnl / risk] : [];
  });
  const recentPayoffAverageR =
    recentPayoffRows.length === 5 && recentPayoffValues.length === 5
      ? recentPayoffValues.reduce((s, v) => s + v, 0) / 5
      : null;

  const decision = (eligible, reason) => ({
    eligible,
    reason,
    samples,
    wins,
    losses,
    carriedSamples,
    smoothedWinRate,
    smoothedExpectedR: smoothedWinRate * G1_TARGET_R - (1 - smoothedWinRate),
    realizedRSamples,
    averageRealizedR,
    recentPayoffAverageR,
  });

  const brakeSamples =
    input.route === 'M1_EARLY_TRANSITION' ? 2 : 3;
  const recentLossStreak =
    selected.length >= brakeSamples &&
    selected.slice(0, brakeSamples).every((row) => row.realisedPnl < 0);
  const isMeaningfulGivebackLoss = (row) => {
    const risk = Number(row.riskAtStop);
    const maxFavorable = Number(row.maxFavorablePnl);
    const giveback = Number(row.profitGiveback);
    return (
      row.realisedPnl < 0 &&
      Number.isFinite(risk) &&
      risk > 0 &&
      Number.isFinite(maxFavorable) &&
      maxFavorable / risk >= 0.4 &&
      Number.isFinite(giveback) &&
      giveback >= maxFavorable
    );
  };
  const givebackLossStreak =
    selected.length >= 2 && selected.slice(0, 2).every(isMeaningfulGivebackLoss);
  const givebackCaution = selected.length >= 1 && isMeaningfulGivebackLoss(selected[0]);

  if (givebackLossStreak) return decision(false, 'PROFIT_GIVEBACK_LOSS_STREAK');
  if (recentLossStreak) {
    const mostRecentLossAgeMs = evaluatedAtMs - Date.parse(selected[0].closedAt);
    const canAttemptRecovery = mostRecentLossAgeMs >= 180 * 60_000;
    return decision(false, canAttemptRecovery ? 'EARLY_LOSS_STREAK_RECOVERY_CANARY' : 'EARLY_LOSS_STREAK');
  }
  if (givebackCaution) return decision(true, 'PROFIT_GIVEBACK_CAUTION');
  if (samples < 5) return decision(true, 'INSUFFICIENT_EVIDENCE');
  if (realizedRSamples !== samples) return decision(false, 'PAYOFF_EVIDENCE_INCOMPLETE');
  if (!((averageRealizedR ?? 0) > 0)) return decision(false, 'NEGATIVE_EXPECTANCY');
  const recentPayoffDecayed =
    recentPayoffValues.length === 5 &&
    recentPayoffAverageR !== null &&
    recentPayoffAverageR < -0.1;
  if (recentPayoffDecayed) return decision(false, 'RECENT_NEGATIVE_PAYOFF');
  return decision(true, 'POSITIVE_EXPECTANCY');
}

function mirrorG5TrendRoute(input) {
  const evidence = input.evidence || null;
  const episodes = Math.max(0, Math.trunc(evidence?.closedTrades ?? 0));
  const profitFactor = evidence?.profitFactor ?? null;
  const maxDrawdown = evidence?.maxDrawdown ?? null;
  if (input.strategyRoute !== 'TREND_CONTINUATION') {
    return { state: 'NOT_APPLICABLE', fullSizeEligible: true, reason: 'NON_CONTINUATION_ROUTE' };
  }
  if (episodes < 20) {
    return { state: 'COLLECTING', fullSizeEligible: true, reason: 'INSUFFICIENT_ROUTE_EVIDENCE' };
  }
  if (maxDrawdown != null && maxDrawdown > 0.12) {
    return { state: 'RESEARCH_ONLY', fullSizeEligible: false, reason: 'ROUTE_DRAWDOWN_EXCEEDED' };
  }
  if (profitFactor != null && Number.isFinite(profitFactor) && profitFactor < 1.0) {
    return {
      state: 'RESEARCH_ONLY',
      fullSizeEligible: false,
      reason: 'ROUTE_PROFIT_FACTOR_BELOW_ONE',
    };
  }
  return { state: 'HEALTHY', fullSizeEligible: true, reason: 'ROUTE_HEALTHY' };
}

function mirrorG6(input) {
  const closedTrades = Number.isFinite(input.closedTrades)
    ? Math.max(0, Math.trunc(input.closedTrades))
    : 0;
  const grossProfit = Number.isFinite(input.grossProfit) ? Math.max(0, input.grossProfit) : 0;
  const grossLoss = Number.isFinite(input.grossLoss) ? Math.max(0, input.grossLoss) : 0;
  const netPnl = Number.isFinite(input.netPnl) ? input.netPnl : grossProfit - grossLoss;
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : null;
  if (closedTrades < 6) {
    return { state: 'COLLECTING', executionAuthority: 'PAPER', reason: 'INSUFFICIENT_SCOUT_REALISED_EVIDENCE' };
  }
  if (netPnl < 0 && profitFactor !== null && profitFactor < 0.75) {
    return { state: 'SHADOW_ONLY', executionAuthority: 'SHADOW_ONLY', reason: 'SCOUT_REALISED_PAYOFF_NEGATIVE' };
  }
  if (netPnl < 0 && profitFactor !== null && profitFactor < 1.0) {
    return { state: 'REDUCED', executionAuthority: 'PAPER', reason: 'SCOUT_REALISED_PAYOFF_MARGINAL' };
  }
  return { state: 'HEALTHY', executionAuthority: 'PAPER', reason: 'SCOUT_REALISED_PAYOFF_HEALTHY' };
}

const G7_DEGRADED_REASONS = Object.freeze([
  'WEAK_MEANINGFUL_EXPECTANCY',
  'RECENT_MEANINGFUL_DEGRADATION',
  'WEAK_PROVISIONAL_EXPECTANCY',
  'RECENT_PROVISIONAL_DEGRADATION',
]);

function mirrorG7(input) {
  const lossStreakVeto = input.m1ReliabilityReason === 'EARLY_LOSS_STREAK';
  const degradedEarlyTransitionVeto =
    input.m1Route === 'M1_EARLY_TRANSITION' &&
    input.pairSideReliability?.eligible === false &&
    G7_DEGRADED_REASONS.includes(input.pairSideReliability.reason);
  const blockers = [];
  if (lossStreakVeto) blockers.push('M1_DEMO_RELIABILITY_EARLY_LOSS_STREAK');
  if (degradedEarlyTransitionVeto) blockers.push('M1_DEMO_EARLY_TRANSITION_PAIR_SIDE_DEGRADED');
  return {
    executable: blockers.length === 0,
    blockers,
    lossStreakVeto,
    degradedEarlyTransitionVeto,
  };
}

// G8 — the advisory multiplier ladder. m5/h1 direction verdicts and the
// recent-evidence aggregate are frozen record inputs: the bar-path momentum
// computation (brokerCompletedMomentum, l.23-53) is market-data scope, not
// reliability scope, and is consumed here as evidence, faithfully to the
// reliability predicate this contract mirrors (l.96-155).
function mirrorG8(input) {
  const m1Abstained = input.m1Route === 'ABSTAIN';
  const expertAbstained = input.expertState === 'ABSTAIN';
  if (!['CONFIRMED_REVERSAL', 'EARLY_TRANSITION'].includes(input.route ?? '')) {
    return { riskFraction: 1, rationale: ['NOT_ALTERNATE_ROUTE'], vetoCapable: false };
  }
  const rationale = [];
  let riskFraction = 1;
  if (m1Abstained && expertAbstained) {
    riskFraction *= 0.5;
    rationale.push('DOUBLE_ABSTAIN_HALF_RISK');
  } else if (m1Abstained || expertAbstained) {
    riskFraction *= 0.75;
    rationale.push('SINGLE_ABSTAIN_REDUCED_RISK');
  }
  if (input.m1Route === 'M1_TREND_CONTINUATION') {
    riskFraction *= 0.65;
    rationale.push('M1_CONTINUATION_VS_PLAN_B_ALTERNATE_MISMATCH');
  }
  if (input.m5Direction === 'AGAINST' && input.h1Direction === 'AGAINST') {
    riskFraction *= 0.7;
    rationale.push('M5_H1_AGAINST_SIDE');
  } else if (input.m5Direction === 'AGAINST') {
    riskFraction *= 0.85;
    rationale.push('M5_AGAINST_SIDE');
  }
  const recent = input.recent;
  const completeRecent =
    !!recent &&
    Number.isInteger(recent.samples) &&
    recent.samples >= 3 &&
    Number.isInteger(recent.losing) &&
    Number.isInteger(recent.winning) &&
    recent.losing + recent.winning <= recent.samples &&
    Number.isFinite(recent.averageNetR);
  const recentLossEvidenceUsed = !!(
    completeRecent &&
    recent.losing >= Math.ceil(recent.samples * 0.6) &&
    (recent.averageNetR ?? 0) < 0
  );
  if (recentLossEvidenceUsed) {
    riskFraction *= 0.7;
    rationale.push('RECENT_SAME_PAIR_ROUTE_SIDE_NET_LOSING');
  }
  if (!rationale.length) rationale.push('NORMAL_APPROVAL');
  return {
    riskFraction: Math.max(0.2, Math.min(1, Number(riskFraction.toFixed(4)))),
    rationale,
    vetoCapable: false,
  };
}

function mirrorG9Evidence(input) {
  const episodes = Math.max(0, Math.trunc(input.episodes));
  const wins = Math.max(0, Math.trunc(input.wins));
  const losses = Math.max(0, Math.trunc(input.losses));
  const netR = Number.isFinite(input.netR) ? input.netR : 0;
  const profitFactor =
    input.profitFactor !== null && Number.isFinite(input.profitFactor) ? input.profitFactor : null;
  const sharpe = input.sharpe !== null && Number.isFinite(input.sharpe) ? input.sharpe : null;
  const maxDrawdown =
    input.maxDrawdown !== null && Number.isFinite(input.maxDrawdown) ? input.maxDrawdown : null;
  if (episodes < 8) {
    return { state: 'COLLECTING', reason: 'INSUFFICIENT_FRESH_EPISODES' };
  }
  const profitFactorPassed =
    losses === 0
      ? wins > 0 && netR > 0
      : profitFactor !== null && profitFactor >= 1.15;
  const recovered =
    profitFactorPassed &&
    sharpe !== null &&
    sharpe >= 1.0 &&
    maxDrawdown !== null &&
    maxDrawdown <= 0.12 &&
    netR > 0;
  return recovered
    ? { state: 'RECOVERY_SIGNAL', reason: 'FRESH_EDGE_RECOVERY_SIGNAL' }
    : { state: 'WEAK', reason: 'FRESH_EDGE_NOT_RECOVERED' };
}

// ------------------------------------- the frozen disagreement corpus (P1-3)

// T0 anchors every corpus timestamp. Scout outcomes are listed oldest -> newest;
// mirrors re-sort newest-first exactly like the sources.
const T0 = '2026-11-27T10:00:00.000Z';
const minsAgo = (m) => new Date(Date.parse(T0) - m * 60_000).toISOString();
const daysAgo = (d, mExtra = 0) => minsAgo(d * 24 * 60 + mExtra);

const scoutOutcomes = (netRList) =>
  netRList.map((netR, i) => ({ observedAt: minsAgo(2000 - i * 60), netR }));

const scout = (route, outcomes) => ({
  route,
  evaluatedAt: T0,
  outcomes: scoutOutcomes(outcomes),
});

const executedRows = (rows) =>
  rows.map((r, i) => ({
    route: r.route || 'M1_TREND_CONTINUATION',
    instrument: r.instrument || 'EURUSD',
    direction: r.direction || 'BUY',
    policyVersion: r.policyVersion || 'm1-tactical-v1',
    realisedPnl: r.realisedPnl,
    riskAtStop: r.riskAtStop == null ? null : r.riskAtStop,
    maxFavorablePnl: r.maxFavorablePnl == null ? null : r.maxFavorablePnl,
    profitGiveback: r.profitGiveback == null ? null : r.profitGiveback,
    closedAt: minsAgo(r.minsAgo == null ? 50 + (rows.length - 1 - i) * 10 : r.minsAgo),
  }));

const executed = (route, rows, overrides = {}) => ({
  route,
  instrument: 'EURUSD',
  direction: 'BUY',
  currentPolicyVersion: 'm1-tactical-v1',
  evaluatedAt: T0,
  evidenceRows: executedRows(rows),
  ...overrides,
});

const CORPUS = [
  {
    id: 'RL-D01',
    scenario: 'scout sample-floor divergence: 4 strong outcomes on M1_EARLY_TRANSITION — G2 (min 3) admits, G3 (min 6) refuses, G4 (min 3, strictest floors) admits',
    divergenceClass: 'DISAGREEMENT',
    divergenceKind: 'verdict',
    input: scout('M1_EARLY_TRANSITION', [0.6, 0.4, 0.3, 0.5]),
    evaluations: [
      { gate: 'g2', expected: { ok: true, reason: 'POSITIVE_SHADOW_EXPECTANCY' } },
      { gate: 'g3', expected: { ok: false, reason: 'INSUFFICIENT_MEANINGFUL_EVIDENCE' } },
      { gate: 'g4', expected: { ok: true, reason: 'POSITIVE_PROVISIONAL_EXPECTANCY' } },
    ],
  },
  {
    id: 'RL-D02',
    scenario: 'profit-factor rung divergence: PF exactly 1.5 clears G2\'s floor and fails G4\'s 2.0 on the same five outcomes; G3 never reaches the floors (5 < 6)',
    divergenceClass: 'DISAGREEMENT',
    divergenceKind: 'verdict',
    input: scout('M1_EARLY_TRANSITION', [-0.6, -0.6, 0.6, 0.5, 0.7]),
    evaluations: [
      { gate: 'g2', expected: { ok: true, reason: 'POSITIVE_SHADOW_EXPECTANCY' } },
      { gate: 'g3', expected: { ok: false, reason: 'INSUFFICIENT_MEANINGFUL_EVIDENCE' } },
      { gate: 'g4', expected: { ok: false, reason: 'WEAK_PROVISIONAL_EXPECTANCY' } },
    ],
  },
  {
    id: 'RL-D03',
    scenario: 'the mature handoff seam: 6 strong outcomes — G2 and G3 both admit, G4 refuses BECAUSE the evidence became mature (MATURE_EVIDENCE_AVAILABLE)',
    divergenceClass: 'DISAGREEMENT',
    divergenceKind: 'verdict',
    input: scout('M1_EARLY_TRANSITION', [0.5, 0.4, 0.6, 0.3, 0.5, 0.4]),
    evaluations: [
      { gate: 'g2', expected: { ok: true, reason: 'POSITIVE_SHADOW_EXPECTANCY' } },
      { gate: 'g3', expected: { ok: true, reason: 'POSITIVE_MEANINGFUL_EXPECTANCY' } },
      { gate: 'g4', expected: { ok: false, reason: 'MATURE_EVIDENCE_AVAILABLE' } },
    ],
  },
  {
    id: 'RL-D04',
    scenario: 'authority divergence on PF 0.97 at route maturity: G5 demotes to RESEARCH_ONLY, G6 keeps PAPER authority with a 0.05 lot cap (REDUCED), G9 records WEAK shadow',
    divergenceClass: 'DISAGREEMENT',
    divergenceKind: 'authority',
    input: {
      g5: {
        strategyRoute: 'TREND_CONTINUATION',
        evidence: { closedTrades: 20, profitFactor: 0.97, sharpe: 1.1, maxDrawdown: 0.05 },
      },
      g6: { closedTrades: 20, grossProfit: 145, grossLoss: 150, netPnl: -5 },
      g9: {
        episodes: 20, wins: 11, losses: 9, netR: -0.5,
        profitFactor: 0.97, sharpe: 0.9, maxDrawdown: 0.10,
      },
    },
    evaluations: [
      { gate: 'g5', expected: { ok: false, reason: 'ROUTE_PROFIT_FACTOR_BELOW_ONE' } },
      { gate: 'g6', expected: { ok: true, reason: 'SCOUT_REALISED_PAYOFF_MARGINAL' } },
      { gate: 'g9', expected: { ok: false, reason: 'FRESH_EDGE_NOT_RECOVERED' } },
    ],
  },
  {
    id: 'RL-D05',
    scenario: 'recent-degradation predicate divergence: last-3 window sums to -0.4 but contains a positive outcome — G2 (ALL last-3 <= 0) passes, G3 (sum <= 0) degrades, G4 hands off',
    divergenceClass: 'DISAGREEMENT',
    divergenceKind: 'reason',
    input: scout('M1_EARLY_TRANSITION', [0.5, 0.6, 0.4, 0.5, -0.3, -0.2, -0.3, 0.1]),
    evaluations: [
      { gate: 'g2', expected: { ok: true, reason: 'POSITIVE_SHADOW_EXPECTANCY' } },
      { gate: 'g3', expected: { ok: false, reason: 'RECENT_MEANINGFUL_DEGRADATION' } },
      { gate: 'g4', expected: { ok: false, reason: 'MATURE_EVIDENCE_AVAILABLE' } },
    ],
  },
  {
    id: 'RL-D06',
    scenario: 'CONTROL — 2 outcomes: every scout gate refuses uniformly (INSUFFICIENT_*) on the same cold sleeve',
    divergenceClass: 'CONTROL',
    divergenceKind: 'none',
    input: scout('M1_EARLY_TRANSITION', [0.3, 0.2]),
    evaluations: [
      { gate: 'g2', expected: { ok: false, reason: 'INSUFFICIENT_SHADOW_EVIDENCE' } },
      { gate: 'g3', expected: { ok: false, reason: 'INSUFFICIENT_MEANINGFUL_EVIDENCE' } },
      { gate: 'g4', expected: { ok: false, reason: 'INSUFFICIENT_PROVISIONAL_EVIDENCE' } },
    ],
  },
  {
    id: 'RL-D07',
    scenario: 'composition gap: G1 refuses (NEGATIVE_EXPECTANCY at a 60% win rate — win rate is never a decision criterion) while G7 reports executable because only 2 of G1\'s ten failure reasons veto',
    divergenceClass: 'DISAGREEMENT',
    divergenceKind: 'verdict',
    input: {
      g1: executed('M1_TREND_CONTINUATION', [
        { realisedPnl: 20, riskAtStop: 100, minsAgo: 50 },
        { realisedPnl: 15, riskAtStop: 100, minsAgo: 40 },
        { realisedPnl: 18, riskAtStop: 100, minsAgo: 30 },
        { realisedPnl: -55, riskAtStop: 100, minsAgo: 20 },
        { realisedPnl: -50, riskAtStop: 100, minsAgo: 10 },
      ]),
      g7: {
        m1Route: 'M1_TREND_CONTINUATION',
        m1ReliabilityReason: 'NEGATIVE_EXPECTANCY',
        pairSideReliability: null,
      },
    },
    evaluations: [
      { gate: 'g1', expected: { ok: false, reason: 'NEGATIVE_EXPECTANCY' } },
      { gate: 'g7', expected: { ok: true, reason: 'NO_BLOCKERS' } },
    ],
  },
  {
    id: 'RL-D08',
    scenario: 'provability asymmetry: the same six economics — G1 fail-closes on one missing riskAtStop (PAYOFF_EVIDENCE_INCOMPLETE) while G2 admits the identical netR surface',
    divergenceClass: 'DISAGREEMENT',
    divergenceKind: 'verdict',
    input: {
      g1: executed('M1_TREND_CONTINUATION', [
        { realisedPnl: 40, riskAtStop: 100, minsAgo: 60 },
        { realisedPnl: 20, riskAtStop: 100, minsAgo: 50 },
        { realisedPnl: 30, riskAtStop: 100, minsAgo: 40 },
        { realisedPnl: 50, riskAtStop: 100, minsAgo: 30 },
        { realisedPnl: 10, riskAtStop: 100, minsAgo: 20 },
        { realisedPnl: 25, riskAtStop: null, minsAgo: 10 },
      ]),
      g2: scout('M1_EARLY_TRANSITION', [0.4, 0.2, 0.3, 0.5, 0.1, 0.25]),
    },
    evaluations: [
      { gate: 'g1', expected: { ok: false, reason: 'PAYOFF_EVIDENCE_INCOMPLETE' } },
      { gate: 'g2', expected: { ok: true, reason: 'POSITIVE_SHADOW_EXPECTANCY' } },
    ],
  },
  {
    id: 'RL-D09',
    scenario: 'the soft state only G1 has: one fresh giveback loss makes the sleeve eligible-but-flagged (PROFIT_GIVEBACK_CAUTION) — G7 passes the reason through without a blocker',
    divergenceClass: 'DISAGREEMENT',
    divergenceKind: 'reason',
    input: {
      g1: executed('M1_TREND_CONTINUATION', [
        { realisedPnl: 25, riskAtStop: 100, minsAgo: 60 },
        { realisedPnl: 20, riskAtStop: 100, minsAgo: 50 },
        { realisedPnl: 28, riskAtStop: 100, minsAgo: 40 },
        { realisedPnl: 22, riskAtStop: 100, minsAgo: 30 },
        { realisedPnl: 30, riskAtStop: 100, minsAgo: 20 },
        { realisedPnl: -30, riskAtStop: 100, maxFavorablePnl: 55, profitGiveback: 60, minsAgo: 10 },
      ]),
      g7: {
        m1Route: 'M1_TREND_CONTINUATION',
        m1ReliabilityReason: 'PROFIT_GIVEBACK_CAUTION',
        pairSideReliability: null,
      },
    },
    evaluations: [
      { gate: 'g1', expected: { ok: true, reason: 'PROFIT_GIVEBACK_CAUTION' } },
      { gate: 'g7', expected: { ok: true, reason: 'NO_BLOCKERS' } },
    ],
  },
  {
    id: 'RL-D10',
    scenario: 'intra-gate cooldown divergence: the same 3-loss streak is EARLY_LOSS_STREAK at +30 min and EARLY_LOSS_STREAK_RECOVERY_CANARY at +200 min — the 180-minute branch is G1-only',
    divergenceClass: 'DISAGREEMENT',
    divergenceKind: 'temporal',
    input: {
      before: executed('M1_TREND_CONTINUATION', [
        { realisedPnl: -45, riskAtStop: 100, minsAgo: 50 },
        { realisedPnl: -50, riskAtStop: 100, minsAgo: 40 },
        { realisedPnl: -40, riskAtStop: 100, minsAgo: 30 },
      ]),
      after: executed('M1_TREND_CONTINUATION', [
        { realisedPnl: -45, riskAtStop: 100, minsAgo: 220 },
        { realisedPnl: -50, riskAtStop: 100, minsAgo: 210 },
        { realisedPnl: -40, riskAtStop: 100, minsAgo: 200 },
      ]),
    },
    evaluations: [
      { gate: 'g1', label: 'before-cooldown', inputRef: 'before', expected: { ok: false, reason: 'EARLY_LOSS_STREAK' } },
      { gate: 'g1', label: 'after-cooldown', inputRef: 'after', expected: { ok: false, reason: 'EARLY_LOSS_STREAK_RECOVERY_CANARY' } },
    ],
  },
  {
    id: 'RL-D11',
    scenario: 'temporal composition: the same early-transition sleeve blocks twice before the canary window (loss streak + degraded pair side) and executes after it (recovery-canary reason + green pair side)',
    divergenceClass: 'DISAGREEMENT',
    divergenceKind: 'temporal',
    input: {
      before: {
        m1Route: 'M1_EARLY_TRANSITION',
        m1ReliabilityReason: 'EARLY_LOSS_STREAK',
        pairSideReliability: { eligible: false, reason: 'WEAK_MEANINGFUL_EXPECTANCY' },
      },
      after: {
        m1Route: 'M1_EARLY_TRANSITION',
        m1ReliabilityReason: 'EARLY_LOSS_STREAK_RECOVERY_CANARY',
        pairSideReliability: { eligible: true, reason: 'POSITIVE_MEANINGFUL_EXPECTANCY' },
      },
    },
    evaluations: [
      {
        gate: 'g7', label: 'before-cooldown', inputRef: 'before',
        expected: { ok: false, reason: 'M1_DEMO_RELIABILITY_EARLY_LOSS_STREAK+M1_DEMO_EARLY_TRANSITION_PAIR_SIDE_DEGRADED' },
      },
      { gate: 'g7', label: 'after-cooldown', inputRef: 'after', expected: { ok: true, reason: 'NO_BLOCKERS' } },
    ],
  },
  {
    id: 'RL-D12',
    scenario: 'authority gradient control: every gate approves yet the dispositions differ — G6 HEALTHY (PAPER), G8 advisory cuts risk to 0.595 without vetoing, G9 records RECOVERY_SIGNAL (NONE)',
    divergenceClass: 'CONTROL',
    divergenceKind: 'authority',
    input: {
      g8: {
        route: 'CONFIRMED_REVERSAL',
        m1Route: 'M1_CONFIRMED_REVERSAL',
        expertState: 'ADMITTED',
        m5Direction: 'AGAINST',
        h1Direction: 'NEUTRAL',
        recent: { samples: 5, losing: 3, winning: 2, averageNetR: -0.2 },
      },
      g6: { closedTrades: 10, grossProfit: 300, grossLoss: 100, netPnl: 150 },
      g9: {
        episodes: 8, wins: 6, losses: 2, netR: 2.4,
        profitFactor: 2.6, sharpe: 1.3, maxDrawdown: 0.07,
      },
    },
    evaluations: [
      { gate: 'g6', expected: { ok: true, reason: 'SCOUT_REALISED_PAYOFF_HEALTHY' } },
      { gate: 'g8', expected: { ok: true, reason: 'M5_AGAINST_SIDE+RECENT_SAME_PAIR_ROUTE_SIDE_NET_LOSING' } },
      { gate: 'g9', expected: { ok: true, reason: 'FRESH_EDGE_RECOVERY_SIGNAL' } },
    ],
  },
];

const CORPUS_SIZE = CORPUS.length; // 12

// ------------------------------------------------------- the corpus evaluation

const MIRROR_BY_GATE = {
  g1: (evaluationInput) => mirrorG1(evaluationInput.g1 ?? evaluationInput),
  g2: (evaluationInput) => mirrorG2(evaluationInput.g2 ?? evaluationInput),
  g3: (evaluationInput) => mirrorG3(evaluationInput.g3 ?? evaluationInput),
  g4: (evaluationInput) => mirrorG4(evaluationInput.g4 ?? evaluationInput),
  g5: (evaluationInput) => mirrorG5TrendRoute(evaluationInput.g5 ?? evaluationInput),
  g6: (evaluationInput) => mirrorG6(evaluationInput.g6 ?? evaluationInput),
  g7: (evaluationInput) => mirrorG7(evaluationInput.g7 ?? evaluationInput),
  g8: (evaluationInput) => mirrorG8(evaluationInput.g8 ?? evaluationInput),
  g9: (evaluationInput) => mirrorG9Evidence(evaluationInput.g9 ?? evaluationInput),
};

// Boolean semantics per gate: what "ok" means for the matrix.
const GATE_OK = {
  g1: (d) => d.eligible === true,
  g2: (d) => d.eligible === true,
  g3: (d) => d.eligible === true,
  g4: (d) => d.eligible === true,
  g5: (d) => d.fullSizeEligible === true,
  g6: (d) => d.executionAuthority === 'PAPER',
  g7: (d) => d.executable === true,
  g8: (d) => d.riskFraction < 1,
  g9: (d) => d.state === 'RECOVERY_SIGNAL',
};

const GATE_REASON = {
  g1: (d) => d.reason,
  g2: (d) => d.reason,
  g3: (d) => d.reason,
  g4: (d) => d.reason,
  g5: (d) => d.reason,
  g6: (d) => d.reason,
  g7: (d) => (d.blockers.length ? d.blockers.join('+') : 'NO_BLOCKERS'),
  g8: (d) => d.rationale.join('+'),
  g9: (d) => d.reason,
};

/** Evaluate one corpus record: run every declared evaluation through the
 * faithful mirror and compare with the committed expectation. Input
 * resolution: an explicit inputRef names a record-input sub-object (temporal
 * variants); a gate-named key (input.g1) scopes one gate's surface; otherwise
 * the whole record input IS the surface (the scout records share one window). */
function resolveEvaluationInput(input, evaluation) {
  if (evaluation.inputRef) {
    const scoped = input[evaluation.inputRef];
    if (scoped === undefined) {
      throw new Error(`RELIABILITY_CORPUS_RECORD_MALFORMED: ${evaluation.gate} inputRef ${evaluation.inputRef} missing`);
    }
    return scoped;
  }
  if (input[evaluation.gate] !== undefined) return input[evaluation.gate];
  return input;
}

function evaluateCorpusRecord(record) {
  const input = record.input;
  const evaluations = record.evaluations.map((evaluation) => {
    const mirror = MIRROR_BY_GATE[evaluation.gate];
    if (!mirror) return { ...evaluation, computed: null, match: false };
    const decision = mirror(resolveEvaluationInput(input, evaluation));
    const ok = GATE_OK[evaluation.gate](decision);
    const reason = GATE_REASON[evaluation.gate](decision);
    return {
      gate: evaluation.gate,
      label: evaluation.label || null,
      ok,
      reason,
      expected: evaluation.expected,
      match: ok === evaluation.expected.ok && reason === evaluation.expected.reason,
    };
  });
  return { id: record.id, divergenceClass: record.divergenceClass, evaluations };
}

/** Compute the verdict matrix and the corpus statistics the spec commits to. */
function buildReliabilityMatrix(corpusRecords) {
  const rows = corpusRecords.map(evaluateCorpusRecord);
  const allEvaluations = rows.flatMap((row) => row.evaluations);
  const confirmations = {};
  for (const gate of Object.keys(MIRROR_BY_GATE)) confirmations[gate] = 0;
  for (const evaluation of allEvaluations) {
    if (evaluation.ok) confirmations[evaluation.gate] += 1;
  }
  let disagreementInClass = 0;
  let controlViolations = 0;
  for (const row of rows) {
    const oks = row.evaluations.map((e) => e.ok);
    const uniform = oks.every((v) => v === oks[0]);
    const distinctReasons = new Set(row.evaluations.map((e) => `${e.gate}:${e.reason}`)).size;
    const hasSplit = !uniform;
    const hasReasonDivergence = distinctReasons > 1;
    if (row.divergenceClass === 'DISAGREEMENT') {
      if (hasSplit || hasReasonDivergence) disagreementInClass += 1;
    } else if (row.divergenceClass === 'CONTROL') {
      if (!uniform) controlViolations += 1;
    }
  }
  const patterns = new Set(
    rows.map((row) =>
      row.evaluations.map((e) => `${e.gate}[${e.label || '-'}]=${e.ok}:${e.reason}`).join('|'),
    ),
  );
  return {
    rows,
    confirmations,
    disagreementInClass,
    controlViolations,
    distinctPatterns: patterns.size,
  };
}

// ------------------------------------------- RL-1 — the unified V2 contract

const RL1_SURFACES = Object.freeze([
  'EXECUTED', 'SCOUT_SHADOW', 'PAPER_SLEEVE', 'ADVISORY', 'COMPOSITION',
]);

const RL1_TIERS = Object.freeze(['COLD', 'SCOUT', 'MEANINGFUL', 'MATURE_HANDOFF', 'ROUTE']);

const RL1_PROPOSED_AUTHORITY = Object.freeze([
  'NONE', 'SHADOW_ONLY', 'REDUCED_LOT_0_05', 'PROVISIONAL_LOT_0_05',
  'ADVISORY_MULTIPLIER', 'FULL', 'PAPER_FULL',
]);

// Pre-registered constant slots — PROPOSALS ONLY, frozen at campaign
// pre-registration (P5-4). Each slot takes the strictest observed V1 value for
// the same concept (per component map v1 §3) and retires the divergent copies;
// the two slots that are NOT the strictest (scout entry 3, requalification
// 1.15) are recorded as the ladder's rungs / stratifier, not silent overrides.
const RL1_PREREGISTERED = Object.freeze({
  sampleLadder: Object.freeze({ cold: 3, scout: 5, meaningful: 6, windowCap: 20 }),
  scoutFloors: Object.freeze({ profitFactor: 2.0, averageNetR: 0.2, positiveFraction: 0.5, lotCap: 0.05 }),
  meaningfulFloors: Object.freeze({ profitFactor: 1.5, averageNetR: 0.1, positiveFraction: 0.4 }),
  executedFloor: Object.freeze({ averageRealizedR: 'strictly-positive', geometryProvable: true, minSamples: 5 }),
  routeFloors: Object.freeze({ profitFactor: 1.0, maxDrawdown: 0.12, trendEpisodes: 20, reversalEpisodes: 8, pairSideEpisodes: 8 }),
  requalificationStratifier: Object.freeze({ profitFactor: 1.15, sharpe: 1.0, maxDrawdown: 0.12, episodes: 8 }),
  streakRules: Object.freeze({ lossStreak: 3, lossStreakEarlyTransition: 2, recoveryCanaryMinutes: 180, recentWindow: 3, recentDegradationRule: 'sum <= 0' }),
  ageWindowDays: 7,
  recentPayoffWindow: 5,
  recentPayoffFloor: -0.1,
  smoothingPrior: Object.freeze({ wins: 1, losses: 1 }),
  advisoryFloor: 0.2,
});

const RL1_VERDICTS = Object.freeze([
  'ELIGIBLE', 'ELIGIBLE_FLAGGED', 'COLD_START', 'DEGRADED', 'REFUSED',
  'HANDOFF_MATURE', 'RISK_REDUCED',
]);

const RL1_REFUSALS = Object.freeze([
  'RELIABILITY_INPUT_REQUIRED',
  'RELIABILITY_UNSUPPORTED_SURFACE',
  'RELIABILITY_INPUT_OUT_OF_RANGE',
]);

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    if (!Object.isFrozen(value)) Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

const RELIABILITY_GATE_CONTRACT = deepFreeze(Object.freeze({
  meta: Object.freeze({
    artifact: CONTRACT_ARTIFACT,
    capturedOn: '2026-11-27',
    scope: 'P1-3 reliability-layer consolidation (research-only)',
    executionAuthority: 'NONE',
    specDoc: 'docs/research/AI_ENGINE_V2_P1_3_RELIABILITY_CONSOLIDATION_SPEC_20261127.md',
    componentMapRef: 'v2-engine-component-map-v1 (+ phase-2 §13)',
    auditReference: 'docs/research/AI_ENGINE_V2_AUDIT_FINDINGS_20261127.md (finding A3)',
  }),
  gates: RELIABILITY_GATES,
  corpus: CORPUS,
  corpusExpectations: Object.freeze({
    size: 12,
    disagreementCount: 10,
    controlCount: 2,
    confirmations: Object.freeze({
      g1: 1, g2: 5, g3: 1, g4: 1, g5: 0, g6: 2, g7: 3, g8: 1, g9: 1,
    }),
    distinctPatterns: 12,
  }),
  unifiedContract: Object.freeze({
    name: 'RL-1',
    oneQuestion: 'has this sleeve accumulated enough provably-good evidence to trade at which authority tier?',
    surfaces: RL1_SURFACES,
    tiers: RL1_TIERS,
    proposedAuthority: RL1_PROPOSED_AUTHORITY,
    verdicts: RL1_VERDICTS,
    preRegistered: RL1_PREREGISTERED,
    refusals: RL1_REFUSALS,
    authorityGradient: Object.freeze([
      'NONE (G9 requalification shadow — observe only)',
      'SHADOW_ONLY (G6 negative-payoff scout)',
      'REDUCED_LOT_0_05 (G6 marginal scout / G4 provisional scout)',
      'PROVISIONAL_LOT_0_05 (RL-1 scout tier verdict PROVISIONAL)',
      'ADVISORY_MULTIPLIER (G8 — reduces requested risk, floor 0.2, never vetoes)',
      'PAPER_FULL (G6 healthy scout / G5 healthy route on the paper path)',
      'FULL (G1 positive-expectancy executed admission)',
    ]),
    ladderSemantics: Object.freeze([
      'COLD (< 3 outcomes): no scout rung may admit; executed surface stays cold-start eligible with G1 semantics recorded, proposed authority NONE for scouts',
      'SCOUT (3 <= n < 6): the G4 constellation (PF 2.0 / avgR 0.2 / posFrac 0.5) is the single scout floor; admission is PROVISIONAL_LOT_0_05',
      'MEANINGFUL (n >= 6): scouts hand off (G4 MATURE_EVIDENCE_AVAILABLE preserved as HANDOFF_MATURE); the G2/G3 constellation (PF 1.5 / avgR 0.1 / posFrac 0.4) governs',
      'MATURE_HANDOFF: scout gates stop answering at n >= 6 — one gate (G4) already implements this; RL-1 makes it the ladder rule instead of a per-gate accident',
      'ROUTE: paper route/requalification evidence uses the route floors (PF 1.0 / maxDD 0.12); the requalification PF 1.15 is a recorded stratifier',
      'windowCap 20 everywhere (G1/G2/G3 max samples; G5 trend episodes converge on the same ceiling)',
    ]),
    extractionSeams: Object.freeze([
      'SEAM-1 context-assembly: the scheduler helper cluster (m1-tactical-scheduler.service.ts l.4785-4843) assembles G1-G4 evidence; G7 composes at l.1699 and G8 at l.4020 inside runOnce (l.959-l.4652); the collector assembles G5/G6/G9 (l.2472, l.3137, l.4832-4892). One assembly point per surface; gates never read tables themselves.',
      'SEAM-2 pure evaluation: the nine predicates collapse to the RL-1 ladder — a pure function over the assembled evidence record (this contract\'s mirrors are the reference implementation).',
      'SEAM-3 verdict application: admission composition consumes RL-1 verdicts and reason codes (G7 generalizes from string-matching 2 of G1\'s 10 reasons + 4 of G3/G4\'s to consuming the whole verdict vocabulary).',
    ]),
    missingValueRule: Object.freeze({
      required: 'absent/null/undefined/non-finite -> typed refusal RELIABILITY_INPUT_REQUIRED (fail-closed; no silent default)',
      range: 'out-of-declared-range -> typed refusal RELIABILITY_INPUT_OUT_OF_RANGE (never clamped into range)',
      authority: 'every RL-1 output carries executionAuthority NONE — the proposedAuthority tier is a recommendation, never an order grant',
    }),
  }),
}));

// -------------------------------------------------------------- validation

const finiteNumber = (v) => typeof v === 'number' && Number.isFinite(v);
const nonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;
const VALID_CLASSES = ['DISAGREEMENT', 'CONTROL'];
const VALID_KINDS = ['verdict', 'reason', 'temporal', 'authority', 'none'];

/**
 * Validate the structural integrity of the reliability-gate contract,
 * including the frozen corpus: every computed evaluation (from the faithful
 * mirrors) must equal the committed expectation, every record's
 * divergenceClass must be consistent with its computed evaluations, and the
 * corpus statistics must equal the committed counts.
 */
function validateReliabilityGateContract(contract) {
  if (!contract || typeof contract !== 'object' || Array.isArray(contract)) {
    throw new Error('RELIABILITY_CONTRACT_INPUT_REQUIRED');
  }
  const meta = contract.meta;
  if (!meta || !nonEmptyString(meta.artifact) || !nonEmptyString(meta.capturedOn)
    || !nonEmptyString(meta.scope) || !nonEmptyString(meta.specDoc)) {
    throw new Error('RELIABILITY_META_INCOMPLETE');
  }
  if (meta.executionAuthority !== 'NONE') {
    throw new Error('RELIABILITY_META_INCOMPLETE: executionAuthority must be NONE');
  }

  const gates = contract.gates;
  if (!Array.isArray(gates) || gates.length !== RELIABILITY_GATE_COUNT) {
    throw new Error(`RELIABILITY_COUNT_MISMATCH: gates ${gates ? gates.length : 'null'} != ${RELIABILITY_GATE_COUNT}`);
  }
  const seen = new Set();
  for (const gate of gates) {
    for (const field of ['key', 'path', 'artifact', 'role', 'authority']) {
      if (!nonEmptyString(gate[field])) {
        throw new Error(`RELIABILITY_MISSING_FIELD: ${gate.key || '?'} missing ${field}`);
      }
    }
    if (!Array.isArray(gate.constants) || !Array.isArray(gate.predicate) || !Array.isArray(gate.callSites)) {
      throw new Error(`RELIABILITY_MISSING_FIELD: ${gate.key} missing arrays`);
    }
    for (const c of gate.constants) {
      if (!nonEmptyString(c.name) || !finiteNumber(c.value) || !Number.isInteger(c.line) || c.line <= 0) {
        throw new Error(`RELIABILITY_CONSTANT_MALFORMED: ${gate.key}.${c ? c.name : '?'}`);
      }
    }
    if (seen.has(gate.key)) throw new Error(`RELIABILITY_DUPLICATE_KEY: ${gate.key}`);
    seen.add(gate.key);
  }

  const corpus = contract.corpus;
  if (!Array.isArray(corpus) || corpus.length !== contract.corpusExpectations.size) {
    throw new Error(`RELIABILITY_COUNT_MISMATCH: corpus ${corpus ? corpus.length : 'null'} != ${contract.corpusExpectations.size}`);
  }
  const ids = new Set();
  for (const record of corpus) {
    if (!nonEmptyString(record.id) || !VALID_CLASSES.includes(record.divergenceClass)
      || !VALID_KINDS.includes(record.divergenceKind) || !nonEmptyString(record.scenario)
      || !record.input || !Array.isArray(record.evaluations) || record.evaluations.length === 0) {
      throw new Error(`RELIABILITY_CORPUS_RECORD_MALFORMED: ${record ? record.id || '?' : '?'}`);
    }
    if (ids.has(record.id)) throw new Error(`RELIABILITY_DUPLICATE_KEY: ${record.id}`);
    ids.add(record.id);
    for (const evaluation of record.evaluations) {
      if (!MIRROR_BY_GATE[evaluation.gate]) {
        throw new Error(`RELIABILITY_CORPUS_RECORD_MALFORMED: ${record.id} unknown gate ${evaluation.gate}`);
      }
      if (!evaluation.expected
        || typeof evaluation.expected.ok !== 'boolean'
        || !nonEmptyString(evaluation.expected.reason)) {
        throw new Error(`RELIABILITY_CORPUS_RECORD_MALFORMED: ${record.id}.${evaluation.gate} expected`);
      }
    }
  }

  const matrix = buildReliabilityMatrix(corpus);
  for (const row of matrix.rows) {
    for (const evaluation of row.evaluations) {
      if (!evaluation.match) {
        throw new Error(
          `RELIABILITY_VERDICT_MISMATCH: ${row.id}.${evaluation.gate}${evaluation.label ? `[${evaluation.label}]` : ''} computed ${evaluation.ok}:${evaluation.reason}, expected ${evaluation.expected.ok}:${evaluation.expected.reason}`,
        );
      }
    }
  }
  for (const row of matrix.rows) {
    const oks = row.evaluations.map((e) => e.ok);
    const uniform = oks.every((v) => v === oks[0]);
    if (row.divergenceClass === 'CONTROL' && !uniform) {
      throw new Error(`RELIABILITY_CORPUS_RECORD_MALFORMED: ${row.id} CONTROL with divergent verdicts`);
    }
    if (row.divergenceClass === 'DISAGREEMENT' && uniform
      && new Set(row.evaluations.map((e) => `${e.gate}:${e.reason}`)).size < 2) {
      throw new Error(`RELIABILITY_CORPUS_RECORD_MALFORMED: ${row.id} DISAGREEMENT with uniform verdicts and reasons`);
    }
  }
  if (matrix.controlViolations !== 0) {
    throw new Error('RELIABILITY_CORPUS_RECORD_MALFORMED: CONTROL records diverge');
  }

  const expected = contract.corpusExpectations;
  const disagreementCount = matrix.rows.filter((r) => r.divergenceClass === 'DISAGREEMENT').length;
  const controlCount = matrix.rows.filter((r) => r.divergenceClass === 'CONTROL').length;
  if (matrix.disagreementInClass !== disagreementCount
    || disagreementCount !== expected.disagreementCount
    || controlCount !== expected.controlCount) {
    throw new Error(
      `RELIABILITY_STATISTICS_MISMATCH: disagreement ${matrix.disagreementInClass}/${expected.disagreementCount}, control ${controlCount}/${expected.controlCount}`,
    );
  }
  for (const gate of Object.keys(expected.confirmations)) {
    if (matrix.confirmations[gate] !== expected.confirmations[gate]) {
      throw new Error(
        `RELIABILITY_STATISTICS_MISMATCH: confirmations.${gate} ${matrix.confirmations[gate]} != ${expected.confirmations[gate]}`,
      );
    }
  }
  if (matrix.distinctPatterns !== expected.distinctPatterns) {
    throw new Error(
      `RELIABILITY_STATISTICS_MISMATCH: distinctPatterns ${matrix.distinctPatterns} != ${expected.distinctPatterns}`,
    );
  }
  return true;
}

// ------------------------------------------------------------ drift detectors

/**
 * Path + constant-anchor drift detector: every mapped gate file must exist
 * AND still carry its pinned constants verbatim (content anchors — never bare
 * line numbers, per the map convention).
 */
function verifyReliabilityGatePaths(contract, repoRoot) {
  if (!contract || !Array.isArray(contract.gates)) {
    throw new Error('RELIABILITY_CONTRACT_INPUT_REQUIRED');
  }
  const results = [];
  for (const gate of contract.gates) {
    const absolute = path.join(repoRoot, gate.path);
    if (!fs.existsSync(absolute)) {
      throw new Error(`RELIABILITY_GATE_PATH_MISSING: ${gate.path}`);
    }
    const source = fs.readFileSync(absolute, 'utf8');
    for (const c of gate.constants) {
      if (c.anchor) {
        if (!new RegExp(c.anchor, 'm').test(source)) {
          throw new Error(`RELIABILITY_CONSTANT_ANCHOR_MISSING: ${gate.path}#${c.name}=${c.value}`);
        }
        continue;
      }
      const escaped = String(c.value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Integer-valued constants may be written with a trailing .0 in source.
      const valuePattern = Number.isInteger(c.value)
        ? `${escaped}(?:\\.0+)?`
        : escaped;
      const patterns = [
        new RegExp(`${c.name}\\s*=\\s*${valuePattern}(?:[^0-9.]|$)`, 'm'),
        new RegExp(`Math\\.max\\(${valuePattern}`, 'm'),
      ];
      const anchored = patterns.some((p) => p.test(source));
      if (!anchored) {
        throw new Error(`RELIABILITY_CONSTANT_ANCHOR_MISSING: ${gate.path}#${c.name}=${c.value}`);
      }
    }
    results.push({ key: gate.key, path: gate.path, constantsVerified: gate.constants.length });
  }
  return { verified: results.length, total: contract.gates.length, results };
}

/**
 * Extraction-seam drift detector: the scheduler and collector must still
 * invoke the gates exactly where the SEAM-1 anchors are pinned.
 */
function verifyOrchestrationSeams(repoRoot) {
  const seams = [
    { file: SCHEDULER, anchors: [
      'export class M1TacticalSchedulerService',
      'evaluateM1RoutePairSideReliability(',
      'evaluateM1ShadowPairSideReliability(',
      'evaluateM1MeaningfulScoutReliability(',
      'evaluateM1ProvisionalScoutReliability(',
      'evaluateDemoProfitabilityReliabilityGate(',
      'evaluatePepperstoneDemoAdvisoryQuality(',
    ] },
    { file: COLLECTOR, anchors: [
      'evaluatePaperTrendRouteReliability(',
      'evaluatePaperReversalRouteReliability(',
      'evaluatePaperTrendPairSideReliability(',
      'evaluatePaperScoutRealisedPayoff(',
      'evaluatePaperResearchRequalificationShadow(',
      'evaluatePaperRealisedContinuationRouteReliability(',
    ] },
  ];
  const results = [];
  for (const seam of seams) {
    const absolute = path.join(repoRoot, seam.file);
    if (!fs.existsSync(absolute)) {
      throw new Error(`RELIABILITY_SEAM_ANCHOR_MISSING: ${seam.file} (file gone)`);
    }
    const source = fs.readFileSync(absolute, 'utf8');
    for (const anchor of seam.anchors) {
      if (!source.includes(anchor)) {
        throw new Error(`RELIABILITY_SEAM_ANCHOR_MISSING: ${seam.file}#${anchor}`);
      }
    }
    results.push({ file: seam.file, anchorsVerified: seam.anchors.length });
  }
  return { verified: results.length, total: seams.length, results };
}

function summarizeReliabilityGateContract(contract) {
  const matrix = buildReliabilityMatrix(contract.corpus);
  return {
    artifact: contract.meta.artifact,
    gates: contract.gates.map((gate) => ({ key: gate.key, path: gate.path, authority: gate.authority, sampleFloor: gate.sampleFloor })),
    corpus: {
      size: contract.corpus.length,
      disagreementCount: contract.corpusExpectations.disagreementCount,
      controlCount: contract.corpusExpectations.controlCount,
      confirmations: matrix.confirmations,
      distinctPatterns: matrix.distinctPatterns,
    },
    rl1: {
      name: contract.unifiedContract.name,
      surfaces: contract.unifiedContract.surfaces.length,
      tiers: contract.unifiedContract.tiers.length,
      refusals: contract.unifiedContract.refusals,
      extractionSeams: contract.unifiedContract.extractionSeams.length,
    },
  };
}

// ------------------------------------------- RL-1 application surface (research)

function requireField(input, field, surface) {
  if (input[field] === undefined || input[field] === null) {
    throw new Error(`RELIABILITY_INPUT_REQUIRED: ${surface}.${field}`);
  }
}

function requireFinite(input, field, surface) {
  requireField(input, field, surface);
  if (!Number.isFinite(Number(input[field]))) {
    throw new Error(`RELIABILITY_INPUT_REQUIRED: ${surface}.${field} (non-finite)`);
  }
}

/**
 * Apply RL-1 to one assembled evidence record. Fail-closed: missing required
 * fields or out-of-range values are typed refusals, never defaults. The
 * output ALWAYS carries executionAuthority NONE — proposedAuthority is the
 * tier the ladder recommends, never an order grant.
 */
function applyReliabilityContract(input) {
  if (!input || typeof input !== 'object') throw new Error('RELIABILITY_INPUT_REQUIRED: input');
  if (!RL1_SURFACES.includes(input.surface)) {
    throw new Error(`RELIABILITY_UNSUPPORTED_SURFACE: ${String(input.surface)}`);
  }
  const surface = input.surface;

  if (surface === 'EXECUTED') {
    requireField(input, 'route', surface);
    requireField(input, 'instrument', surface);
    requireField(input, 'direction', surface);
    requireField(input, 'currentPolicyVersion', surface);
    requireField(input, 'evaluatedAt', surface);
    requireField(input, 'evidenceRows', surface);
    if (!Array.isArray(input.evidenceRows)) {
      throw new Error('RELIABILITY_INPUT_OUT_OF_RANGE: EXECUTED.evidenceRows (not an array)');
    }
    const decision = mirrorG1(input);
    const verdict =
      decision.reason === 'POSITIVE_EXPECTANCY' ? 'ELIGIBLE'
      : decision.reason === 'PROFIT_GIVEBACK_CAUTION' ? 'ELIGIBLE_FLAGGED'
      : decision.reason === 'INSUFFICIENT_EVIDENCE' ? 'COLD_START'
      : 'REFUSED';
    return {
      artifact: CONTRACT_ARTIFACT,
      surface,
      tier: 'ROUTE',
      verdict,
      proposedAuthority: verdict === 'REFUSED' ? 'NONE' : 'FULL',
      decisions: { g1: decision },
      executionAuthority: 'NONE',
    };
  }

  if (surface === 'SCOUT_SHADOW') {
    requireField(input, 'route', surface);
    requireField(input, 'evaluatedAt', surface);
    requireField(input, 'outcomes', surface);
    if (!Array.isArray(input.outcomes)) {
      throw new Error('RELIABILITY_INPUT_OUT_OF_RANGE: SCOUT_SHADOW.outcomes (not an array)');
    }
    for (const outcome of input.outcomes) {
      if (outcome.netR !== undefined && !Number.isFinite(Number(outcome.netR))) {
        throw new Error('RELIABILITY_INPUT_OUT_OF_RANGE: SCOUT_SHADOW.outcomes[].netR (non-finite)');
      }
    }
    const g2 = mirrorG2(input);
    const g3 = mirrorG3(input);
    const g4 = mirrorG4(input);
    const n = input.outcomes.filter((o) => Date.parse(o.observedAt) <= Date.parse(input.evaluatedAt)).length;
    const tier = n < RL1_PREREGISTERED.sampleLadder.cold ? 'COLD'
      : n < RL1_PREREGISTERED.sampleLadder.meaningful ? 'SCOUT'
      : 'MATURE_HANDOFF';
    let verdict;
    let proposedAuthority;
    if (g3.eligible) {
      verdict = 'ELIGIBLE';
      proposedAuthority = 'FULL';
    } else if (g4.eligible) {
      verdict = 'ELIGIBLE';
      proposedAuthority = 'PROVISIONAL_LOT_0_05';
    } else if (g4.reason === 'MATURE_EVIDENCE_AVAILABLE' || g3.reason === 'RECENT_MEANINGFUL_DEGRADATION') {
      verdict = g4.reason === 'MATURE_EVIDENCE_AVAILABLE' ? 'HANDOFF_MATURE' : 'DEGRADED';
      proposedAuthority = 'NONE';
    } else {
      verdict = n < RL1_PREREGISTERED.sampleLadder.cold ? 'COLD_START' : 'REFUSED';
      proposedAuthority = 'NONE';
    }
    return {
      artifact: CONTRACT_ARTIFACT,
      surface,
      tier,
      verdict,
      proposedAuthority,
      decisions: { g2, g3, g4 },
      executionAuthority: 'NONE',
    };
  }

  if (surface === 'PAPER_SLEEVE') {
    requireField(input, 'payoff', surface);
    requireFinite(input.payoff, 'closedTrades', surface);
    requireFinite(input.payoff, 'grossProfit', surface);
    requireFinite(input.payoff, 'grossLoss', surface);
    if (input.payoff.grossProfit < 0 || input.payoff.grossLoss < 0) {
      throw new Error('RELIABILITY_INPUT_OUT_OF_RANGE: PAPER_SLEEVE.payoff.gross (negative)');
    }
    const g6 = mirrorG6(input.payoff);
    const g9 = input.requalification ? mirrorG9Evidence(input.requalification) : null;
    const route = input.routeEvidence ? mirrorG5TrendRoute(input.routeEvidence) : null;
    const proposedAuthority =
      g6.state === 'SHADOW_ONLY' ? 'SHADOW_ONLY'
      : g6.state === 'REDUCED' ? 'REDUCED_LOT_0_05'
      : 'PAPER_FULL';
    const verdict = g6.state === 'SHADOW_ONLY' ? 'REFUSED'
      : g6.state === 'REDUCED' ? 'RISK_REDUCED'
      : g6.state === 'COLLECTING' ? 'COLD_START'
      : 'ELIGIBLE';
    return {
      artifact: CONTRACT_ARTIFACT,
      surface,
      tier: 'ROUTE',
      verdict,
      proposedAuthority,
      decisions: { g6, ...(g9 ? { g9 } : {}), ...(route ? { g5: route } : {}) },
      executionAuthority: 'NONE',
    };
  }

  if (surface === 'ADVISORY') {
    requireField(input, 'route', surface);
    requireField(input, 'm1Route', surface);
    requireField(input, 'expertState', surface);
    requireField(input, 'm5Direction', surface);
    requireField(input, 'h1Direction', surface);
    for (const field of ['m5Direction', 'h1Direction']) {
      if (!['WITH', 'AGAINST', 'NEUTRAL', 'UNAVAILABLE'].includes(input[field])) {
        throw new Error(`RELIABILITY_INPUT_OUT_OF_RANGE: ADVISORY.${field}`);
      }
    }
    const g8 = mirrorG8(input);
    return {
      artifact: CONTRACT_ARTIFACT,
      surface,
      tier: 'ROUTE',
      verdict: g8.riskFraction < 1 ? 'RISK_REDUCED' : 'ELIGIBLE',
      proposedAuthority: 'ADVISORY_MULTIPLIER',
      decisions: { g8 },
      executionAuthority: 'NONE',
    };
  }

  // COMPOSITION
  requireField(input, 'm1Route', surface);
  requireField(input, 'm1ReliabilityReason', surface);
  const g7 = mirrorG7(input);
  return {
    artifact: CONTRACT_ARTIFACT,
    surface,
    tier: 'ROUTE',
    verdict: g7.executable ? 'ELIGIBLE' : 'REFUSED',
    proposedAuthority: g7.executable ? 'FULL' : 'NONE',
    decisions: { g7 },
    executionAuthority: 'NONE',
  };
}

module.exports = {
  RELIABILITY_GATE_CONTRACT,
  RELIABILITY_GATES,
  RELIABILITY_GATE_COUNT,
  CORPUS,
  RL1_PREREGISTERED,
  RL1_SURFACES,
  RL1_REFUSALS,
  validateReliabilityGateContract,
  verifyReliabilityGatePaths,
  verifyOrchestrationSeams,
  summarizeReliabilityGateContract,
  buildReliabilityMatrix,
  evaluateCorpusRecord,
  applyReliabilityContract,
  // mirrors exported for research reuse (still authority NONE)
  mirrorG1,
  mirrorG2,
  mirrorG3,
  mirrorG4,
  mirrorG5TrendRoute,
  mirrorG6,
  mirrorG7,
  mirrorG8,
  mirrorG9Evidence,
};
