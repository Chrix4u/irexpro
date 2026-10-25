import { evaluatePaperOpportunityScout } from './paper-opportunity-scout';
import { evaluatePaperChampionDirectionPrior } from './paper-champion-direction-prior';

describe('PAPER opportunity scout', () => {
  const base = {
    normalPaperExecution: false,
    direction: 'BUY' as const,
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
      lotUpperBound: 0.1,
      sizingTier: 'RESEARCH',
      mode: 'BASE',
      targetWindowMinutes: 30,
      idleMinutes: null,
    });
  });

  it('uses a 0.10 RESEARCH scout after 30 idle minutes', () => {
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
      lotUpperBound: 0.1,
      sizingTier: 'RESEARCH',
      mode: 'ACTIVE',
      targetWindowMinutes: 30,
      idleMinutes: 35,
    });
  });

  it('uses a 0.10 RESEARCH recovery scout after 60 idle minutes while keeping four-vote consensus', () => {
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
      lotUpperBound: 0.1,
      sizingTier: 'RESEARCH',
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

  it('executes evidence-backed calibrated OOD at the 0.10 scout tier', () => {
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
      reason: 'CALIBRATED_OOD_SCOUT',
      lotUpperBound: 0.1,
      sizingTier: 'RESEARCH',
      mode: 'RECOVERY',
    });
  });

  it('executes the observed 19:30 GBPUSD calibrated OOD opportunity at the 0.10 scout tier', () => {
    expect(
      evaluatePaperOpportunityScout({
        ...base,
        idleMinutes: 65,
        driftState: 'OUT_OF_DISTRIBUTION',
        driftDiagnostics: [
          'confidence:HARD_LOW',
          'extensionAtr:STRESSED_LOW',
          'emaSeparation:HARD_LOW',
        ],
        confidence: 0.6,
        consensusPassed: 4,
        netExpectedR: 0.06428745122227793,
        directionQuality: 0.08694993758243813,
        tradeQuality: 0.575158568988934,
        exitQuality: 0.5822114407259837,
        alignedMomentumAtr: 0.18702597095742032,
        calibration: {
          authoritative: true,
          sourceLevel: 'EXACT',
          maturity: 'COLLECTING',
          samples: 13,
          calibratedWinProbability: 0.6095238095238096,
          profitFactor: 1.843279981350856,
          calibratedNetExpectedR: 0.06428745122227793,
          recentDegradation: false,
          blockRecommended: false,
        },
      }),
    ).toMatchObject({
      eligible: true,
      reason: 'CALIBRATED_OOD_SCOUT',
      lotUpperBound: 0.1,
      sizingTier: 'RESEARCH',
      mode: 'RECOVERY',
    });
  });

  it('keeps calibrated OOD scouting blocked below the empirically losing 0.08 direction-quality boundary', () => {
    expect(
      evaluatePaperOpportunityScout({
        ...base,
        idleMinutes: 65,
        driftState: 'OUT_OF_DISTRIBUTION',
        driftDiagnostics: ['confidence:HARD_LOW', 'emaSeparation:HARD_LOW'],
        confidence: 0.61,
        consensusPassed: 4,
        netExpectedR: 0.07,
        directionQuality: 0.079,
        tradeQuality: 0.58,
        exitQuality: 0.58,
        alignedMomentumAtr: 0.18,
        calibration: {
          authoritative: true,
          sourceLevel: 'EXACT',
          maturity: 'COLLECTING',
          samples: 13,
          calibratedWinProbability: 0.61,
          profitFactor: 1.84,
          calibratedNetExpectedR: 0.07,
          recentDegradation: false,
          blockRecommended: false,
        },
      }),
    ).toMatchObject({ eligible: false, reason: 'QUALITY_TOO_LOW' });
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

  describe('causal shadow-pulse confidence rescue', () => {
    const supportedPulse = {
      artifact: 'adaptive-shadow-directional-pulse-v1' as const,
      available: true,
      direction: 'BUY' as const,
      status: 'SUPPORTED' as const,
      candidateSamples: 8,
      oppositeSamples: 8,
      candidateWeightedR: 0.62,
      oppositeWeightedR: -0.28,
      advantageR: 0.9,
      quality: 0.725,
    };

    it('rescues a positive-edge trend candidate at 0.10 lots when causal shadow evidence strongly supports the side', () => {
      expect(
        evaluatePaperOpportunityScout({
          ...base,
          confidence: 0.54,
          netExpectedR: 0.052,
          directionQuality: 0.24,
          tradeQuality: 0.25,
          exitQuality: 0.26,
          alignedMomentumAtr: 0.14,
          driftState: 'STRESSED',
          shadowDirectionalPulse: supportedPulse,
        }),
      ).toMatchObject({
        eligible: true,
        reason: 'SHADOW_PULSE_SCOUT',
        lotUpperBound: 0.1,
        sizingTier: 'RESEARCH',
      });
    });

    it('does not let neutral, opposed, sparse, or weak-advantage pulse evidence rescue the trade', () => {
      for (const shadowDirectionalPulse of [
        { ...supportedPulse, status: 'NEUTRAL' as const, advantageR: 0.4, quality: 0.6 },
        { ...supportedPulse, status: 'OPPOSED' as const, advantageR: -0.9, quality: 0.275 },
        {
          ...supportedPulse,
          available: false,
          status: 'INSUFFICIENT' as const,
          candidateSamples: 3,
        },
        { ...supportedPulse, advantageR: 0.7, quality: 0.675 },
      ]) {
        expect(
          evaluatePaperOpportunityScout({
            ...base,
            confidence: 0.54,
            netExpectedR: 0.052,
            directionQuality: 0.24,
            tradeQuality: 0.25,
            exitQuality: 0.26,
            alignedMomentumAtr: 0.14,
            shadowDirectionalPulse,
          }),
        ).toMatchObject({ eligible: false, reason: 'CONFIDENCE_TOO_LOW' });
      }
    });

    it('keeps hard economics, consensus, OOD, route, event and cost boundaries authoritative despite a strong pulse', () => {
      const common = {
        ...base,
        confidence: 0.54,
        netExpectedR: 0.052,
        directionQuality: 0.24,
        tradeQuality: 0.25,
        exitQuality: 0.26,
        alignedMomentumAtr: 0.14,
        shadowDirectionalPulse: supportedPulse,
      };
      expect(evaluatePaperOpportunityScout({ ...common, netExpectedR: 0.039 })).toMatchObject({
        eligible: false,
        reason: 'NET_EXPECTED_R_TOO_LOW',
      });
      expect(evaluatePaperOpportunityScout({ ...common, consensusPassed: 3 })).toMatchObject({
        eligible: false,
        reason: 'CONSENSUS_TOO_LOW',
      });
      expect(
        evaluatePaperOpportunityScout({ ...common, driftState: 'OUT_OF_DISTRIBUTION' }),
      ).toMatchObject({ eligible: false, reason: 'DRIFT_EVIDENCE_TOO_WEAK' });
      expect(
        evaluatePaperOpportunityScout({
          ...common,
          strategyRoute: 'CONFIRMED_REVERSAL',
          regime: 'REVERSAL_CONFIRMED',
        }),
      ).toMatchObject({ eligible: false, reason: 'ROUTE_NOT_SCOUTABLE' });
      expect(evaluatePaperOpportunityScout({ ...common, eventRisk: 'UNVERIFIED' })).toMatchObject({
        eligible: false,
        reason: 'EVENT_RISK_NOT_CLEAR',
      });
      expect(
        evaluatePaperOpportunityScout({ ...common, paperExecutionCostUsable: false }),
      ).toMatchObject({ eligible: false, reason: 'EXECUTION_COST_UNUSABLE' });
    });

    it('requires genuinely strong causal pulse quality, payoff and sample depth', () => {
      const common = {
        ...base,
        confidence: 0.54,
        netExpectedR: 0.052,
        directionQuality: 0.24,
        tradeQuality: 0.25,
        exitQuality: 0.26,
        alignedMomentumAtr: 0.14,
      };
      for (const shadowDirectionalPulse of [
        { ...supportedPulse, candidateWeightedR: 0.24 },
        { ...supportedPulse, quality: 0.67 },
        { ...supportedPulse, oppositeSamples: 3 },
      ]) {
        expect(evaluatePaperOpportunityScout({ ...common, shadowDirectionalPulse })).toMatchObject({
          eligible: false,
          reason: 'CONFIDENCE_TOO_LOW',
        });
      }
    });
  });

  describe('champion direction prior acceleration', () => {
    const supportedPrior = evaluatePaperChampionDirectionPrior({
      instrument: 'GBPUSD',
      direction: 'SELL',
      evidence: { trades: 12, grossProfit: 27.8, grossLoss: 20.4, netPnl: 7.4 },
    });

    it('does not bypass the idle window for a supported champion direction', () => {
      expect(
        evaluatePaperOpportunityScout({
          ...base,
          direction: 'SELL',
          idleMinutes: 5,
          confidence: 0.57,
          netExpectedR: 0.05,
          directionQuality: 0.22,
          tradeQuality: 0.22,
          exitQuality: 0.22,
          alignedMomentumAtr: 0.18,
          championDirectionPrior: supportedPrior,
        }),
      ).toMatchObject({
        eligible: false,
        reason: 'CONFIDENCE_TOO_LOW',
        mode: 'BASE',
        idleMinutes: 5,
      });
    });

    it('uses champion labeling only after the active participation window is reached', () => {
      expect(
        evaluatePaperOpportunityScout({
          ...base,
          direction: 'SELL',
          idleMinutes: 35,
          confidence: 0.59,
          netExpectedR: 0.07,
          directionQuality: 0.27,
          tradeQuality: 0.27,
          exitQuality: 0.27,
          alignedMomentumAtr: 0.18,
          championDirectionPrior: supportedPrior,
        }),
      ).toMatchObject({
        eligible: true,
        reason: 'CHAMPION_DIRECTION_SCOUT',
        lotUpperBound: 0.1,
        mode: 'CHAMPION_DIRECTION',
        idleMinutes: 35,
      });
    });

    it('does not accelerate an unsupported direction', () => {
      const unsupportedPrior = evaluatePaperChampionDirectionPrior({
        instrument: 'EURUSD',
        direction: 'SELL',
        evidence: { trades: 11, grossProfit: 20.4, grossLoss: 39.5, netPnl: -19.1 },
      });
      expect(
        evaluatePaperOpportunityScout({
          ...base,
          direction: 'SELL',
          idleMinutes: 5,
          confidence: 0.57,
          netExpectedR: 0.05,
          directionQuality: 0.22,
          tradeQuality: 0.22,
          exitQuality: 0.22,
          alignedMomentumAtr: 0.18,
          championDirectionPrior: unsupportedPrior,
        }),
      ).toMatchObject({ eligible: false, reason: 'CONFIDENCE_TOO_LOW', mode: 'BASE' });
    });

    it('keeps consensus, route and hard safety vetoes authoritative', () => {
      expect(
        evaluatePaperOpportunityScout({
          ...base,
          direction: 'SELL',
          idleMinutes: 5,
          confidence: 0.62,
          consensusPassed: 3,
          netExpectedR: 0.08,
          directionQuality: 0.3,
          tradeQuality: 0.3,
          exitQuality: 0.3,
          alignedMomentumAtr: 0.2,
          championDirectionPrior: supportedPrior,
        }),
      ).toMatchObject({ eligible: false, reason: 'CONSENSUS_TOO_LOW' });
      expect(
        evaluatePaperOpportunityScout({
          ...base,
          direction: 'SELL',
          strategyRoute: 'CONFIRMED_REVERSAL',
          regime: 'REVERSAL_CONFIRMED',
          championDirectionPrior: supportedPrior,
        }),
      ).toMatchObject({ eligible: false, reason: 'ROUTE_NOT_SCOUTABLE', mode: 'BASE' });
      expect(
        evaluatePaperOpportunityScout({
          ...base,
          direction: 'SELL',
          eventRisk: 'UNVERIFIED',
          championDirectionPrior: supportedPrior,
        }),
      ).toMatchObject({ eligible: false, reason: 'EVENT_RISK_NOT_CLEAR' });
      expect(
        evaluatePaperOpportunityScout({
          ...base,
          direction: 'SELL',
          paperExecutionCostUsable: false,
          championDirectionPrior: supportedPrior,
        }),
      ).toMatchObject({ eligible: false, reason: 'EXECUTION_COST_UNUSABLE' });
    });

    it('does not use the prior to bypass OOD calibration evidence', () => {
      expect(
        evaluatePaperOpportunityScout({
          ...base,
          direction: 'SELL',
          idleMinutes: 5,
          driftState: 'OUT_OF_DISTRIBUTION',
          confidence: 0.61,
          consensusPassed: 5,
          netExpectedR: 0.11,
          directionQuality: 0.35,
          tradeQuality: 0.35,
          exitQuality: 0.35,
          alignedMomentumAtr: 0.2,
          championDirectionPrior: supportedPrior,
        }),
      ).toMatchObject({ eligible: false, reason: 'DRIFT_EVIDENCE_TOO_WEAK' });
    });
  });
});
