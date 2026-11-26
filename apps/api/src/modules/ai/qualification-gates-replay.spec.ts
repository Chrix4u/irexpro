/**
 * Isolated, broker-disconnected replay of the LIVE qualification gates.
 *
 * Reproduces the November 25, 2026 14:03–23:01 GMT LIVE blockage shape
 * (4,269 evaluations, zero trades) WITHOUT any broker connection, production
 * database, or real market recording:
 *
 *   candles → buildM1TacticalFeatures → buildM1TacticalCandidates
 *     → m1CandidateToPlanBInput → scorePlanBMultimodelShadow
 *     → evaluateEnsembleGovernance → evaluateMultimodelAuthority
 *     → scheduler signal metadata → evaluateM1PrimaryModelDecision
 *
 * All candle series are synthetic, deterministic fixtures. They characterize
 * gate behavior; they are NOT recorded market data and prove nothing about
 * profitability. The asserted overlaps map each recorded rejection counter
 * to its single upstream boolean, so duplicated admission reasons can no
 * longer be misread as independent failures.
 */
import { buildM1TacticalFeatures, type M1TacticalFeatureInput } from './m1-tactical-features';
import { buildM1TacticalCandidates, M1_TACTICAL_POLICY_V2 } from './m1-tactical-candidate';
import { classifyM1TacticalRoute } from './m1-tactical-route';
import { evaluateMultimodelAuthority, m1CandidateToPlanBInput } from './multimodel-authority';
import { scorePlanBMultimodelShadow } from './plan-b-multimodel-shadow';
import { evaluateEnsembleGovernance } from './ensemble-governance';
import {
  brandServerM1Signal,
  evaluateM1PrimaryModelDecision,
  hasServerM1Origin,
  isStrictLiveM1PrimarySignal,
  PRIMARY_M1_MODEL_IDENTITY,
} from '../strategy/server-m1-signal-origin';
import type { AiSignalCandidate } from '../strategy/interfaces/strategy.interface';
import type { EnsembleGovernanceDecision } from './ensemble-governance';
import type { MultimodelAuthorityDecision } from './multimodel-authority';
import type { PlanBEnsembleScore } from './plan-b-multimodel-shadow';
import type { M1TacticalRouteDecision } from './m1-tactical-route';
import type { HighConvictionOverlay } from './high-conviction-overlay';

const DECISION_TIME = new Date('2026-11-25T15:07:03.000Z');

interface Candle {
  timestamp: Date;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}

/**
 * Alternating up/down increments around an optional bias. Alternation keeps
 * RSI mid-range and the price near its EMAs, so every drift dimension except
 * the deliberately controlled final-bar impulse stays inside the envelope.
 */
function oscillating(
  tfMinutes: number,
  count: number,
  start: number,
  amplitude: number,
  opts: { wiggle?: number; bias?: number } = {},
): Candle[] {
  const wiggle = opts.wiggle ?? 0;
  const bias = opts.bias ?? 0;
  const candles: Candle[] = [];
  const lastOpenMs = DECISION_TIME.getTime() - tfMinutes * 60_000;
  for (let index = 0; index < count; index += 1) {
    const openMs = lastOpenMs - (count - 1 - index) * tfMinutes * 60_000;
    const open = index === 0 ? start : Number(candles[index - 1]!.close);
    const delta =
      index === count - 1 ? amplitude : (index % 2 === 0 ? amplitude : -amplitude) + bias;
    const close = open + delta;
    const high = Math.max(open, close) + wiggle;
    const low = Math.min(open, close) - wiggle;
    candles.push({
      timestamp: new Date(openMs),
      open: open.toFixed(10),
      high: high.toFixed(10),
      low: low.toFixed(10),
      close: close.toFixed(10),
      volume: '3',
    });
  }
  return candles;
}

function neutralTf(tf: number, start: number): Candle[] {
  return oscillating(tf, 30, start, 0.00001, { wiggle: 0.0001 });
}

/**
 * Flat oscillating M1 with one controlled final-bar impulse, on flat M5/M15
 * context. The impulse size (in ATR units) is the ONLY scenario variable.
 */
function flatImpulse(finalStep: number): M1TacticalFeatureInput {
  const base = oscillating(1, 58, 1.08, 0.00005, { wiggle: 0.00004 }).slice(0, 57);
  const impulseStart = Number(base[base.length - 1]!.close);
  return {
    instrument: 'EURUSD',
    decisionTime: new Date(DECISION_TIME),
    m1: [
      ...base,
      {
        timestamp: new Date(DECISION_TIME.getTime() - 60_000),
        open: impulseStart.toFixed(10),
        high: (impulseStart + Math.abs(finalStep) + 0.00004).toFixed(10),
        low: (impulseStart - 0.00004).toFixed(10),
        close: (impulseStart + finalStep).toFixed(10),
        volume: '3',
      },
    ],
    m5: oscillating(5, 30, 1.081, 0.00001, { wiggle: 0.00008 }),
    m15: oscillating(15, 30, 1.083, 0.00001, { wiggle: 0.00008 }),
    h1: neutralTf(60, 1.08),
    h4: neutralTf(240, 1.08),
  };
}

/** Trending market: every bar biases upward, higher timeframes agree. */
function counterTrendUptrend(): M1TacticalFeatureInput {
  return {
    instrument: 'EURUSD',
    decisionTime: new Date(DECISION_TIME),
    m1: oscillating(1, 60, 1.08, 0.00012, { wiggle: 0.00003, bias: 0.00006 }),
    m5: oscillating(5, 30, 1.082, 0.0003, { wiggle: 0.0001, bias: 0.0002 }),
    m15: oscillating(15, 30, 1.085, 0.0005, { wiggle: 0.00015, bias: 0.0004 }),
    h1: neutralTf(60, 1.08),
    h4: neutralTf(240, 1.08),
  };
}

function unanimousExpert(direction: 'BUY' | 'SELL'): HighConvictionOverlay {
  return {
    state: 'CONFIRM',
    reason: null,
    decisionTime: DECISION_TIME.toISOString(),
    freshnessSeconds: 30,
    allBrokerNative: true,
    direction,
    admitted: true,
    ensembleConfidence: 0.8,
    meanOpportunityProbability: 0.7,
    longVotes: direction === 'BUY' ? 3 : 0,
    shortVotes: direction === 'SELL' ? 3 : 0,
    regime: null,
    modifiesExecution: false,
  };
}

interface ReplayStep {
  direction: 'BUY' | 'SELL';
  entry: number;
  stopDistance: number;
  stopLoss: number;
  takeProfit: number;
  route: M1TacticalRouteDecision;
  ensemble: PlanBEnsembleScore;
  governance: EnsembleGovernanceDecision;
  authority: MultimodelAuthorityDecision;
}

/** Exact replica of the scheduler's per-candidate evaluation chain. */
function replayCandidate(input: M1TacticalFeatureInput, direction: 'BUY' | 'SELL'): ReplayStep {
  const features = buildM1TacticalFeatures(input);
  if (!features) throw new Error('fixture must produce a valid feature snapshot');
  const [buy, sell] = buildM1TacticalCandidates(features, M1_TACTICAL_POLICY_V2);
  const candidate = direction === 'BUY' ? buy : sell;
  const opposite = direction === 'BUY' ? sell : buy;

  const routeDecision = classifyM1TacticalRoute(
    candidate,
    opposite,
    features,
    M1_TACTICAL_POLICY_V2,
  );
  const planBInput = m1CandidateToPlanBInput(candidate, features, DECISION_TIME);
  const ensemble = scorePlanBMultimodelShadow(planBInput, []);
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
    eventRisk: 'CLEAR',
    evaluatedAt: DECISION_TIME,
    executionSpreadEvidence: {
      source: 'BROKER_OBSERVED_P90',
      spreadPrice: 0.00008,
      sampleCount: 12,
      percentile: 0.9,
      windowMinutes: 30,
      latestSampleAt: new Date(DECISION_TIME.getTime() - 20_000).toISOString(),
    },
  });
  const authority = evaluateMultimodelAuthority({
    ensemble,
    governance,
    trainedExpert: unanimousExpert(candidate.direction),
    candidateDirection: candidate.direction,
    m1TimingRoute: routeDecision.route,
    m1ReversalEvidence: candidate,
  });

  return {
    direction: candidate.direction,
    entry: candidate.entry,
    stopDistance: candidate.stopDistance,
    stopLoss: candidate.stopLoss,
    takeProfit: candidate.takeProfit,
    route: routeDecision,
    ensemble,
    governance,
    authority,
  };
}

describe('isolated qualification-gate replay (broker-disconnected)', () => {
  it('qualifies a confirmed-reversal geometry end-to-end: admitted, drift-normal, PRIMARY_PLAN_B authority', () => {
    // Final-bar impulse ≈ 0.7 ATR inside the reversal momentum envelope.
    const step = replayCandidate(flatImpulse(0.00009), 'BUY');
    expect(step.ensemble.regime).toBe('REVERSAL_CONFIRMED');
    expect(step.ensemble.paperAdmitted).toBe(true);
    expect(step.ensemble.admitted).toBe(true);
    expect(step.governance.driftState).toBe('NORMAL');
    expect(step.governance.paperExecutionBlockers).toEqual([]);
    expect(step.authority.authorityPath).toBe('PRIMARY_PLAN_B');
    expect(step.authority.executable).toBe(true);
    expect(step.authority.blockers).toEqual([]);
    // The policy stop floor: max(1.1 × ATR, 5 pips) — a 1.3-pip ATR yields
    // the exact 5.0-pip model stop that the LIVE risk gate later measured
    // against a moved executable quote (4.4 / 3.6 / 4.1 pips on Nov 25).
    expect(step.stopDistance).toBeCloseTo(0.0005, 12);
  });

  it('reproduces the overlap: one failed admission records the same boolean under multiple counter names', () => {
    // Final-bar impulse ≈ 0.16 ATR — below the 0.5 reversal floor. The
    // TREND_WEAK context is then not admission-eligible AND drift-OOD by
    // construction (emaSeparation sits below the continuation hard floor).
    const step = replayCandidate(flatImpulse(0.00002), 'BUY');
    expect(step.ensemble.paperAdmitted).toBe(false);
    expect(step.ensemble.regime).toBe('TREND_WEAK');
    // Governance records the SAME upstream boolean under two names:
    expect(step.governance.paperExecutionBlockers).toContain('ENSEMBLE_NOT_PAPER_ADMITTED');
    expect(step.governance.paperExecutionBlockers).toContain('ENSEMBLE_NOT_PROMOTABLE_ADMISSION');
    // ...a third copy in the promotion blockers, alongside drift and sleeve:
    expect(step.governance.blockers).toContain('ENSEMBLE_NOT_ADMITTED');
    expect(step.governance.blockers).toContain('DRIFT_OUT_OF_DISTRIBUTION');
    expect(step.governance.blockers).toContain('SLEEVE_COLLECTING');
    // ...and two more wrapped copies in the authority blockers:
    expect(step.authority.authorityPath).toBe('BLOCKED');
    expect(step.authority.blockers).toContain('MULTIMODEL_PLAN_B_NOT_ADMITTED');
    expect(step.authority.blockers).toContain('MULTIMODEL_GOVERNANCE_BLOCKED');
    expect(step.authority.blockers).toContain('ENSEMBLE_NOT_PAPER_ADMITTED');
    // One failed boolean ⇒ at least five distinct recorded reason strings.
    const recorded = new Set([
      ...step.governance.paperExecutionBlockers,
      ...step.governance.blockers,
      ...step.authority.blockers,
    ]);
    expect(recorded.size).toBeGreaterThanOrEqual(5);
  });

  it('proves the drift flag and the admission failure are coupled, not independent causes', () => {
    // The B fixture is OOD BECAUSE the reversal was not confirmed: the
    // TREND_WEAK context falls to the continuation envelope whose
    // emaSeparation hard floor (0.050248) a flat market cannot reach.
    const weak = replayCandidate(flatImpulse(0.00002), 'BUY');
    expect(weak.governance.driftState).toBe('OUT_OF_DISTRIBUTION');
    expect(weak.governance.driftDiagnostics).toContain('emaSeparation:HARD_LOW');
    expect(weak.governance.paperExecutionBlockers).toContain('ENSEMBLE_NOT_PAPER_ADMITTED');
    expect(weak.governance.paperExecutionBlockers).toContain('DRIFT_OUT_OF_DISTRIBUTION');

    // Same fixture family, impulse inside the momentum envelope: the drift
    // OOD flag disappears with the admission failure. The two counters move
    // together because they share upstream geometry.
    const strong = replayCandidate(flatImpulse(0.00009), 'BUY');
    expect(strong.governance.driftState).toBe('NORMAL');
    expect(strong.ensemble.paperAdmitted).toBe(true);
  });

  it('flags drift OUT_OF_DISTRIBUTION for a counter-M15 proposal via mtfStrength clamped to zero', () => {
    // A SELL proposal inside an uptrend: aligned M15 EMA separation is
    // negative, clamped to 0, below the 0.004236 hard floor.
    const sell = replayCandidate(counterTrendUptrend(), 'SELL');
    expect(sell.governance.driftState).toBe('OUT_OF_DISTRIBUTION');
    expect(sell.governance.driftDiagnostics).toContain('mtfStrength:HARD_LOW');
    expect(sell.route.route).toBe('ABSTAIN');
    expect(sell.route.reason).toBe('HIGHER_TIMEFRAME_CONFLICT');
    // Over-extended trend also rejects the aligned BUY on hard geometry:
    const buy = replayCandidate(counterTrendUptrend(), 'BUY');
    expect(buy.governance.driftDiagnostics).toContain('extensionAtr:HARD_HIGH');
  });

  it('rejects an overshooting impulse outside the reversal momentum envelope', () => {
    // Final-bar impulse ≈ 4.7 ATR ≫ 1.5: reversal not confirmed, regime
    // TREND_EXTENDED, drift OOD via extensionAtr hard-high.
    const step = replayCandidate(flatImpulse(0.0009), 'BUY');
    expect(step.governance.driftDiagnostics).toContain('extensionAtr:HARD_HIGH');
    expect(step.ensemble.paperAdmitted).toBe(false);
    expect(step.governance.paperExecutionBlockers).toContain('ENSEMBLE_NOT_PAPER_ADMITTED');
  });

  it('marks the strict LIVE primary decision QUALIFIED only for a fully-qualified scheduler signal', () => {
    const step = replayCandidate(flatImpulse(0.00009), 'BUY');
    expect(step.authority.authorityPath).toBe('PRIMARY_PLAN_B');

    // Refusal metadata (paperAdmitted=false) is refused account-independently:
    const refused = schedulerSignal(step, { paperAdmitted: false });
    expect(evaluateM1PrimaryModelDecision(refused)).toBe('PRIMARY_MODEL_NOT_ADMITTED');
    expect(isStrictLiveM1PrimarySignal(refused)).toBe(false);

    // A fully qualified metadata tuple with server branding IS the exact
    // LIVE primary admission contract (still not execution permission):
    const qualified = schedulerSignal(step, { paperAdmitted: true });
    expect(evaluateM1PrimaryModelDecision(qualified)).toBe('QUALIFIED');
    expect(hasServerM1Origin(qualified)).toBe(false);
    expect(isStrictLiveM1PrimarySignal(qualified)).toBe(false);
    const branded = brandServerM1Signal(schedulerSignal(step, { paperAdmitted: true }));
    expect(hasServerM1Origin(branded)).toBe(true);
    expect(evaluateM1PrimaryModelDecision(branded)).toBe('QUALIFIED');
    expect(isStrictLiveM1PrimarySignal(branded)).toBe(true);

    // A single broken expert-proof field downgrades to a typed reason:
    const brokenVotes = schedulerSignal(step, { paperAdmitted: true });
    brokenVotes.metadata!.multimodel_trained_expert_long_votes = 2;
    brokenVotes.metadata!.multimodel_trained_expert_short_votes = 0;
    expect(evaluateM1PrimaryModelDecision(brokenVotes)).toBe('NATIVE_EXPERT_PROOF_INVALID');
  });
});

/**
 * Builds the exact scheduler metadata tuple the orchestrator LIVE boundary
 * consumes (see m1-tactical-scheduler.service.ts signal metadata assembly).
 */
function schedulerSignal(step: ReplayStep, options: { paperAdmitted: boolean }): AiSignalCandidate {
  const direction = step.direction;
  return {
    signalId: 'replay-signal-1',
    userId: 'user-replay',
    tradingSessionId: 'session-replay',
    brokerConnectionId: 'conn-replay',
    instrument: 'EURUSD',
    direction,
    confidenceScore: 0.66,
    suggestedStopLoss: step.stopLoss,
    suggestedTakeProfit: step.takeProfit,
    suggestedVolume: 0.01,
    timeframe: PRIMARY_M1_MODEL_IDENTITY.timeframe,
    strategyCode: PRIMARY_M1_MODEL_IDENTITY.strategyCode,
    marketRegime: 'REVERSAL',
    generatedAt: new Date(DECISION_TIME),
    modelVersion: PRIMARY_M1_MODEL_IDENTITY.modelVersion,
    metadata: {
      signal_source: 'EXTERNAL_PROVIDER',
      external_provider_paper_only: true,
      multimodel_execution_authority_path: options.paperAdmitted ? 'PRIMARY_PLAN_B' : 'BLOCKED',
      multimodel_plan_b_route: step.ensemble.strategyRoute,
      multimodel_plan_b_paper_admitted: options.paperAdmitted,
      m1_professional_fallback: false,
      m5_early_transition_handoff: false,
      m1_pepperstone_demo_alternative_trial: false,
      extension_exhaustion_demo_scout: false,
      m1_tactical_route: step.route.route,
      multimodel_trained_expert_native: true,
      multimodel_trained_expert_direction: direction,
      multimodel_trained_expert_confidence: 0.8,
      multimodel_trained_expert_freshness_seconds: 30,
      multimodel_trained_expert_long_votes: direction === 'BUY' ? 3 : 0,
      multimodel_trained_expert_short_votes: direction === 'SELL' ? 3 : 0,
      multimodel_primary_reversal_timing_bridge: false,
    },
  };
}
