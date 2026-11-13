import {
  evaluateIndependentM1OpportunityShadow,
  INDEPENDENT_M1_OPPORTUNITY_ARTIFACT,
} from './independent-m1-opportunity-shadow';

const m1Buy = {
  instrument: 'EURUSD',
  direction: 'SELL' as const,
  route: 'M1_TREND_CONTINUATION',
  evaluatedAt: new Date('2026-11-12T17:02:00.000Z'),
  candidateEntry: 1.105635,
  stopLoss: 1.106135,
  takeProfit: 1.104835,
  confidence: 0.681,
  directionQuality: 0.7,
  routeEligible: true,
  m1PaperEligible: true,
  m1NetExpectedR: 0.1017,
  spreadEvidenceValid: true,
  eventRisk: 'CLEAR' as const,
  reliability: {
    eligible: true, reason: 'PROFIT_GIVEBACK_CAUTION',
    samples: 4, wins: 3, losses: 1, recentRealizedR: 0.86,
  },
  planB: { paperAdmitted: false, netExpectedR: -0.372, regime: 'TREND_WEAK' },
};

describe('independent M1 opportunity research with Plan B disagreement', () => {
  it('preserves an independently qualified M1 SELL as a shadow-only study even if Plan B rejects it', () => {
    const decision = evaluateIndependentM1OpportunityShadow(m1Buy);
    expect(decision).toMatchObject({
      artifact: INDEPENDENT_M1_OPPORTUNITY_ARTIFACT,
      mode: 'SHADOW_ONLY',
      executionAuthority: 'NONE',
      eligibleForStudy: true,
      reasons: [],
      planBDisagrees: true,
      m1NetExpectedR: 0.1017,
      snapshotEntry: 1.105635,
      snapshotStopLoss: 1.106135,
      snapshotTakeProfit: 1.104835,
      outcomeScored: false,
      outcomeRequiredBeforePromotion: true,
      modifiesExecution: false,
      modifiesOpenPositions: false,
      changesStopLoss: false,
    });
    expect(decision.exitHorizonMinutes).toEqual([3, 5, 6, 7, 10]);
  });

  it('does not treat an insufficient data or high-impact event setup as an opportunity', () => {
    const decision = evaluateIndependentM1OpportunityShadow({
      ...m1Buy, spreadEvidenceValid: false, eventRisk: 'HIGH_IMPACT_BLOCK',
    });
    expect(decision.eligibleForStudy).toBe(false);
    expect(decision.reasons).toContain('BROKER_SPREAD_NOT_VERIFIED');
    expect(decision.reasons).toContain('EVENT_RISK_NOT_CLEAR');
    expect(decision.executionAuthority).toBe('NONE');
  });

  it('requires valid direction, stop and target geometry, without creating trade authority', () => {
    const bad = evaluateIndependentM1OpportunityShadow({
      ...m1Buy, stopLoss: 1.104, takeProfit: 1.107, m1NetExpectedR: NaN,
    });
    expect(bad.reasons).toEqual(expect.arrayContaining([
      'M1_EXPECTED_RETURN_NOT_FINITE', 'CANDIDATE_STOP_TARGET_INCONSISTENT',
    ]));
    expect(bad.eligibleForStudy).toBe(false);
    expect(bad.executionAuthority).toBe('NONE');
  });

  it('never admits M1 ABSTAIN even with a high confidence snapshot', () => {
    const bad = evaluateIndependentM1OpportunityShadow({
      ...m1Buy, route: 'ABSTAIN', routeEligible: false,
      confidence: 0.99, m1PaperEligible: false,
    });
    expect(bad.eligibleForStudy).toBe(false);
    expect(bad.planBDisagrees).toBe(false);
    expect(bad.reasons).toContain('OTHER_M1_ROUTE');
    expect(bad.executionAuthority).toBe('NONE');
  });
});
