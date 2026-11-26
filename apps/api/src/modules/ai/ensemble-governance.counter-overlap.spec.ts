/**
 * Recorded-counter regression for the November 25, 2026 LIVE blockage.
 *
 * The operator dashboard counted, for one eight-hour LIVE window:
 *   4,139 ensemble paper admission failures
 *   4,138 ensemble promotion admission failures
 *
 * The one-event difference is the EARLY_TRANSITION route: the governance
 * layer deliberately omits ENSEMBLE_NOT_PROMOTABLE_ADMISSION for it because
 * early transitions are PAPER-only by policy, not failed admissions. These
 * tests pin that asymmetry and the paper/promotion duplication so the
 * counters keep being read as ONE upstream boolean plus documented
 * exceptions — never as independent causes.
 */
import { evaluateEnsembleGovernance, ENSEMBLE_GOVERNANCE_VERSION } from './ensemble-governance';
import type { PlanBEnsembleScore } from './plan-b-multimodel-shadow';

const EVALUATED_AT = new Date('2026-11-25T15:07:03.000Z');

const SPREAD_EVIDENCE = {
  source: 'BROKER_OBSERVED_P90' as const,
  spreadPrice: 0.00008,
  sampleCount: 12,
  percentile: 0.9,
  windowMinutes: 30,
  latestSampleAt: new Date(EVALUATED_AT.getTime() - 20_000).toISOString(),
};

function ensembleScore(
  overrides: Partial<PlanBEnsembleScore> & { strategyRoute: PlanBEnsembleScore['strategyRoute'] },
): PlanBEnsembleScore {
  const base: Omit<PlanBEnsembleScore, 'strategyRoute'> = {
    artifact: 'plan-b-multimodel-shadow-v4',
    mode: 'PROSPECTIVE_SHADOW_ONLY',
    modifiesExecution: false,
    regime: 'TREND_HEALTHY',
    regimeAllowed: true,
    directionQuality: 0.7,
    expectedR: 0.3,
    tradeQuality: 0.7,
    exitQuality: 0.7,
    pairSideQuality: 0.5,
    pairSideRoute: 'GOVERNANCE',
    sessionQuality: 0.9,
    consensusPassed: 7,
    consensusRequired: 6,
    portfolioQuality: 1,
    portfolioRiskScore: 0,
    openPositionCount: 0,
    sameInstrumentCount: 0,
    sameInstrumentDirectionalLots: 0,
    metaProbability: 0.5,
    ensembleScore: 0.6,
    paperAdmitted: false,
    admitted: false,
    reasons: ['REGIME_TREND_WEAK'],
  };
  return { ...base, ...overrides };
}

function evaluate(ensemble: PlanBEnsembleScore, featureOverrides: { emaSeparation?: number } = {}) {
  return evaluateEnsembleGovernance({
    ensemble,
    instrument: 'EURUSD',
    direction: 'BUY',
    entryPrice: 1.08,
    stopLoss: 1.0795,
    takeProfit: 1.0808,
    confidence: 0.66,
    extensionAtr: 0.5,
    volatilityScore: 0.2,
    emaSeparation: featureOverrides.emaSeparation ?? 0.3,
    mtfStrength: 0.5,
    rsi14: 52,
    shortHorizonMomentumAtr: 0.8,
    eventRisk: 'CLEAR',
    evaluatedAt: EVALUATED_AT,
    executionSpreadEvidence: SPREAD_EVIDENCE,
  });
}

describe('ensemble governance recorded-counter semantics', () => {
  it('records one failed admission under three different counter names', () => {
    const decision = evaluate(ensembleScore({ strategyRoute: 'TREND_CONTINUATION' }));
    expect(decision.paperExecutionBlockers).toContain('ENSEMBLE_NOT_PAPER_ADMITTED');
    expect(decision.paperExecutionBlockers).toContain('ENSEMBLE_NOT_PROMOTABLE_ADMISSION');
    expect(decision.blockers).toContain('ENSEMBLE_NOT_ADMITTED');
    // All three trace to the same upstream paperAdmitted/admitted booleans.
    expect(decision.paperExecutionEligible).toBe(false);
    expect(decision.paperPromotionEligible).toBe(false);
  });

  it('omits ENSEMBLE_NOT_PROMOTABLE_ADMISSION for the PAPER-only EARLY_TRANSITION route', () => {
    const decision = evaluate(
      ensembleScore({ strategyRoute: 'EARLY_TRANSITION', regime: 'TRANSITION_EARLY' }),
    );
    // Paper admission still records the failure...
    expect(decision.paperExecutionBlockers).toContain('ENSEMBLE_NOT_PAPER_ADMITTED');
    // ...but the promotion counter deliberately does not: an early
    // transition can never be promotion-admitted by policy, so its absence
    // is not counted as an admission REFUSAL. This one-by-design exception
    // is exactly the recorded 4,139 vs 4,138 asymmetry.
    expect(decision.paperExecutionBlockers).not.toContain('ENSEMBLE_NOT_PROMOTABLE_ADMISSION');
    expect(decision.blockers).toContain('ENSEMBLE_NOT_ADMITTED');
  });

  it('keeps paper-admitted-but-drift-blocked evaluations out of the admission counters', () => {
    // Admission passed (paperAdmitted/admitted true) but the feature vector
    // is below the continuation emaSeparation hard floor → drift OOD:
    const decision = evaluate(
      ensembleScore({
        strategyRoute: 'TREND_CONTINUATION',
        regime: 'TREND_WEAK',
        paperAdmitted: true,
        admitted: true,
      }),
      { emaSeparation: 0.02 },
    );
    // Admission counters stay silent; only drift/sleeve remain:
    expect(decision.paperExecutionBlockers).not.toContain('ENSEMBLE_NOT_PAPER_ADMITTED');
    expect(decision.paperExecutionBlockers).not.toContain('ENSEMBLE_NOT_PROMOTABLE_ADMISSION');
    expect(decision.paperExecutionBlockers).toContain('DRIFT_OUT_OF_DISTRIBUTION');
    // Sleeve evidence is absent, so the promotion path still blocks:
    expect(decision.blockers).toContain('SLEEVE_COLLECTING');
    // This is the recorded 4,145 governance blocks vs 4,139 admission
    // failures residual: governance can block for drift, spread, sleeve or
    // event risk even when admission itself passed.
  });

  it('keeps the governance version stable so counter lineage stays queryable', () => {
    expect(ENSEMBLE_GOVERNANCE_VERSION).toBe('ensemble-governance-v3');
  });
});
