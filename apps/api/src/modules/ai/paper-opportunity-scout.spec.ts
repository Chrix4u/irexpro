import { evaluatePaperOpportunityScout } from './paper-opportunity-scout';

describe('PAPER opportunity scout', () => {
  const base = {
    normalPaperExecution: false,
    strategyRoute: 'TREND_CONTINUATION' as const,
    regime: 'TREND_HEALTHY' as const,
    confidence: 0.66,
    consensusPassed: 4,
    consensusRequired: 6,
    netExpectedR: 0.14,
    directionQuality: 0.42,
    tradeQuality: 0.42,
    exitQuality: 0.42,
    alignedMomentumAtr: 0.28,
    paperExecutionCostUsable: true,
    eventRisk: 'CLEAR' as const,
    portfolioQuality: 0.8,
    driftState: 'STRESSED' as const,
    idleMinutes: null,
  };

  it('takes a reduced-risk positive-edge trend opportunity that misses two soft votes', () => {
    expect(evaluatePaperOpportunityScout(base)).toEqual({
      eligible: true,
      reason: 'OPPORTUNITY_SCOUT',
      lotUpperBound: 0.05,
      sizingTier: 'RESEARCH',
      mode: 'BASE',
      targetWindowMinutes: 30,
      idleMinutes: null,
    });
  });

  it('uses an active participation tier after 30 idle minutes with smaller size', () => {
    expect(
      evaluatePaperOpportunityScout({
        ...base,
        idleMinutes: 35,
        confidence: 0.59,
        netExpectedR: 0.07,
        directionQuality: 0.27,
        tradeQuality: 0.27,
        exitQuality: 0.27,
        alignedMomentumAtr: 0.18,
      }),
    ).toMatchObject({
      eligible: true,
      reason: 'OPPORTUNITY_SCOUT',
      lotUpperBound: 0.03,
      mode: 'ACTIVE',
      targetWindowMinutes: 30,
      idleMinutes: 35,
    });
  });

  it('uses a micro recovery tier after 60 idle minutes while keeping four-vote consensus', () => {
    expect(
      evaluatePaperOpportunityScout({
        ...base,
        idleMinutes: 65,
        confidence: 0.57,
        netExpectedR: 0.05,
        directionQuality: 0.22,
        tradeQuality: 0.22,
        exitQuality: 0.22,
        alignedMomentumAtr: 0.18,
      }),
    ).toMatchObject({
      eligible: true,
      lotUpperBound: 0.02,
      mode: 'RECOVERY',
      targetWindowMinutes: 30,
      idleMinutes: 65,
    });

    expect(
      evaluatePaperOpportunityScout({
        ...base,
        idleMinutes: 180,
        confidence: 0.59,
        consensusPassed: 3,
        netExpectedR: 0.08,
        directionQuality: 0.3,
        tradeQuality: 0.3,
        exitQuality: 0.3,
        alignedMomentumAtr: 0.2,
      }),
    ).toMatchObject({ eligible: false, reason: 'CONSENSUS_TOO_LOW', mode: 'RECOVERY' });
  });

  it('falls back to base policy when idle evidence is invalid or unavailable', () => {
    expect(
      evaluatePaperOpportunityScout({ ...base, idleMinutes: Number.NaN, confidence: 0.59 }),
    ).toMatchObject({
      eligible: false,
      reason: 'CONFIDENCE_TOO_LOW',
      mode: 'BASE',
      idleMinutes: null,
    });
  });

  it('does not relax out-of-distribution evidence after prolonged idleness', () => {
    expect(
      evaluatePaperOpportunityScout({
        ...base,
        idleMinutes: 180,
        driftState: 'OUT_OF_DISTRIBUTION',
        confidence: 0.61,
        consensusPassed: 5,
        netExpectedR: 0.11,
        directionQuality: 0.35,
        tradeQuality: 0.35,
        exitQuality: 0.35,
        alignedMomentumAtr: 0.2,
      }),
    ).toMatchObject({
      eligible: false,
      reason: 'DRIFT_EVIDENCE_TOO_WEAK',
      mode: 'RECOVERY',
    });
  });

  it('can scout a bounded out-of-distribution trend only with stronger evidence', () => {
    expect(
      evaluatePaperOpportunityScout({
        ...base,
        driftState: 'OUT_OF_DISTRIBUTION',
        confidence: 0.65,
        consensusPassed: 5,
        netExpectedR: 0.16,
      }),
    ).toMatchObject({ eligible: true, reason: 'OPPORTUNITY_SCOUT' });
  });

  it('does not reopen the deteriorated confirmed-reversal route', () => {
    expect(
      evaluatePaperOpportunityScout({
        ...base,
        strategyRoute: 'CONFIRMED_REVERSAL',
        regime: 'REVERSAL_CONFIRMED',
        confidence: 0.72,
        consensusPassed: 6,
        netExpectedR: 0.3,
      }),
    ).toMatchObject({ eligible: false, reason: 'ROUTE_NOT_SCOUTABLE' });
  });

  it('requires real positive economics and hard safety evidence at every idle tier', () => {
    expect(evaluatePaperOpportunityScout({ ...base, netExpectedR: 0.079 })).toMatchObject({
      eligible: false,
      reason: 'NET_EXPECTED_R_TOO_LOW',
    });
    expect(
      evaluatePaperOpportunityScout({ ...base, idleMinutes: 180, eventRisk: 'UNVERIFIED' }),
    ).toMatchObject({
      eligible: false,
      reason: 'EVENT_RISK_NOT_CLEAR',
      mode: 'RECOVERY',
    });
    expect(
      evaluatePaperOpportunityScout({
        ...base,
        idleMinutes: 180,
        paperExecutionCostUsable: false,
      }),
    ).toMatchObject({
      eligible: false,
      reason: 'EXECUTION_COST_UNUSABLE',
      mode: 'RECOVERY',
    });
  });

  it('admits the observed GBPUSD calibrated OOD opportunity at micro size after sustained idle time', () => {
    expect(
      evaluatePaperOpportunityScout({
        ...base,
        idleMinutes: 65,
        driftState: 'OUT_OF_DISTRIBUTION',
        driftDiagnostics: ['confidence:HARD_LOW', 'emaSeparation:HARD_LOW'],
        confidence: 0.6,
        consensusPassed: 4,
        netExpectedR: 0.07108316353572111,
        directionQuality: 0.18733685947336046,
        tradeQuality: 0.630311869260798,
        exitQuality: 0.6484997164263697,
        alignedMomentumAtr: 0.0755538621204476,
        calibration: {
          authoritative: true,
          sourceLevel: 'EXACT',
          maturity: 'COLLECTING',
          samples: 12,
          calibratedWinProbability: 0.64,
          profitFactor: 2.3307759200025924,
          calibratedNetExpectedR: 0.07108316353572111,
          recentDegradation: false,
          blockRecommended: false,
        },
      }),
    ).toMatchObject({
      eligible: true,
      reason: 'CALIBRATED_OOD_MICRO_SCOUT',
      lotUpperBound: 0.01,
      mode: 'RECOVERY',
    });
  });

  it('keeps calibrated OOD micro scouting fail-closed for opposite momentum, hard MTF disagreement, or weak calibration', () => {
    const calibratedOod = {
      ...base,
      idleMinutes: 65,
      driftState: 'OUT_OF_DISTRIBUTION' as const,
      driftDiagnostics: ['confidence:HARD_LOW', 'emaSeparation:HARD_LOW'],
      confidence: 0.6,
      consensusPassed: 4,
      netExpectedR: 0.07108316353572111,
      directionQuality: 0.18733685947336046,
      tradeQuality: 0.630311869260798,
      exitQuality: 0.6484997164263697,
      alignedMomentumAtr: 0.0755538621204476,
      calibration: {
        authoritative: true,
        sourceLevel: 'EXACT',
        maturity: 'COLLECTING',
        samples: 12,
        calibratedWinProbability: 0.64,
        profitFactor: 2.3307759200025924,
        calibratedNetExpectedR: 0.07108316353572111,
        recentDegradation: false,
        blockRecommended: false,
      },
    } as const;

    expect(
      evaluatePaperOpportunityScout({ ...calibratedOod, alignedMomentumAtr: -0.376 }),
    ).toMatchObject({ eligible: false, reason: 'MOMENTUM_NOT_CONFIRMED' });
    expect(
      evaluatePaperOpportunityScout({
        ...calibratedOod,
        driftDiagnostics: ['confidence:HARD_LOW', 'mtfStrength:HARD_LOW'],
      }),
    ).toMatchObject({ eligible: false, reason: 'DRIFT_EVIDENCE_TOO_WEAK' });
    expect(
      evaluatePaperOpportunityScout({
        ...calibratedOod,
        calibration: {
          ...calibratedOod.calibration,
          calibratedWinProbability: 0.49,
          profitFactor: 1.03,
        },
      }),
    ).toMatchObject({ eligible: false, reason: 'DRIFT_EVIDENCE_TOO_WEAK' });
  });
});
