import { evaluatePaperOpportunityScout } from './paper-opportunity-scout';
import { evaluatePaperChampionDirectionPrior } from './paper-champion-direction-prior';
import { evaluatePaperShadowLocalEdgePocket } from './paper-shadow-local-edge-pocket';

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

describe('PAPER local shadow-edge scout authority', () => {
  const supportedPocket = evaluatePaperShadowLocalEdgePocket({
    samples: 44,
    wins: 31,
    losses: 13,
    grossProfitR: 40.2,
    grossLossR: 14.33,
    netR: 25.87,
    averageNetR: 0.588,
    profitFactor: 2.542,
    recentSamples: 8,
    recentWins: 8,
    recentNetR: 10.98,
    latestResolvedAt: '2026-10-23T20:40:00.000Z',
  });

  const candidate = {
    normalPaperExecution: false,
    direction: 'SELL' as const,
    strategyRoute: 'TREND_CONTINUATION' as const,
    regime: 'TREND_WEAK' as const,
    confidence: 0.6,
    consensusPassed: 4,
    consensusRequired: 6,
    netExpectedR: -0.48,
    directionQuality: 0,
    tradeQuality: 0.32,
    exitQuality: 0.31,
    alignedMomentumAtr: -0.7,
    paperExecutionCostUsable: true,
    eventRisk: 'CLEAR' as const,
    portfolioQuality: 0.8,
    driftState: 'OUT_OF_DISTRIBUTION' as const,
    idleMinutes: 65,
    calibration: {
      authoritative: true,
      sourceLevel: 'EXACT',
      maturity: 'MATURE',
      samples: 40,
      calibratedWinProbability: 0.42,
      profitFactor: 0.7,
      calibratedNetExpectedR: -0.48,
      recentDegradation: false,
      blockRecommended: true,
    },
    shadowLocalEdgePocket: supportedPocket,
  };

  it('keeps mature local pocket evidence shadow-only until execution transfer is validated', () => {
    expect(evaluatePaperOpportunityScout(candidate)).toMatchObject({
      eligible: false,
      reason: 'LOCAL_EDGE_TRANSFER_SHADOW_ONLY',
      lotUpperBound: 0.1,
      sizingTier: 'RESEARCH',
    });
  });

  it('keeps even an exceptionally strong three-vote local pocket shadow-only until transfer is validated', () => {
    expect(evaluatePaperOpportunityScout({ ...candidate, consensusPassed: 3 })).toMatchObject({
      eligible: false,
      reason: 'LOCAL_EDGE_TRANSFER_SHADOW_ONLY',
      lotUpperBound: 0.1,
      sizingTier: 'RESEARCH',
    });
  });

  it('keeps an ordinary supported local pocket behind the existing four-vote floor', () => {
    const ordinarySupportedPocket = evaluatePaperShadowLocalEdgePocket({
      samples: 24,
      wins: 14,
      losses: 10,
      grossProfitR: 7.8,
      grossLossR: 6,
      netR: 2.88,
      averageNetR: 0.12,
      profitFactor: 1.3,
      recentSamples: 8,
      recentWins: 5,
      recentNetR: 0.6,
      latestResolvedAt: '2026-10-25T20:40:00.000Z',
    });
    expect(ordinarySupportedPocket.supported).toBe(true);
    expect(
      evaluatePaperOpportunityScout({
        ...candidate,
        consensusPassed: 3,
        shadowLocalEdgePocket: ordinarySupportedPocket,
      }),
    ).toMatchObject({ eligible: false, reason: 'CONSENSUS_TOO_LOW' });
  });

  it('never lets local pocket evidence reduce consensus below three votes', () => {
    expect(evaluatePaperOpportunityScout({ ...candidate, consensusPassed: 2 })).toMatchObject({
      eligible: false,
      reason: 'CONSENSUS_TOO_LOW',
    });
  });

  it('keeps rollover-risk regimes non-scoutable even with exceptional local evidence', () => {
    expect(
      evaluatePaperOpportunityScout({
        ...candidate,
        consensusPassed: 3,
        regime: 'ROLLOVER_RISK',
      }),
    ).toMatchObject({ eligible: false, reason: 'REGIME_NOT_SCOUTABLE' });
  });

  it('still lets hard event risk veto a supported local pocket', () => {
    expect(
      evaluatePaperOpportunityScout({ ...candidate, eventRisk: 'HIGH_IMPACT_BLOCK' }),
    ).toMatchObject({ eligible: false, reason: 'EVENT_RISK_NOT_CLEAR' });
  });
});

describe('PAPER provisional local-edge scout', () => {
  const provisionalPocket = evaluatePaperShadowLocalEdgePocket({
    samples: 3,
    wins: 3,
    losses: 0,
    grossProfitR: 1.8,
    grossLossR: 0,
    netR: 1.8,
    averageNetR: 0.6,
    profitFactor: 1_000_000,
    recentSamples: 3,
    recentWins: 3,
    recentNetR: 1.8,
    latestResolvedAt: '2026-10-26T16:00:00.000Z',
  });
  const candidate = {
    normalPaperExecution: false,
    evaluatedAt: new Date('2026-10-26T16:30:00.000Z'),
    direction: 'SELL' as const,
    strategyRoute: 'TREND_CONTINUATION' as const,
    regime: 'TREND_WEAK' as const,
    confidence: 0.62,
    consensusPassed: 4,
    consensusRequired: 6,
    netExpectedR: 0.12,
    directionQuality: 0.34,
    tradeQuality: 0.4,
    exitQuality: 0.38,
    alignedMomentumAtr: 0.18,
    paperExecutionCostUsable: true,
    eventRisk: 'CLEAR' as const,
    portfolioQuality: 0.8,
    driftState: 'NORMAL' as const,
    idleMinutes: 90,
    shadowLocalEdgePocket: provisionalPocket,
  };

  it('keeps a fresh 3-for-3 exact local pocket shadow-only until mature support is established', () => {
    expect(evaluatePaperOpportunityScout(candidate)).toMatchObject({
      eligible: false,
      reason: 'PROVISIONAL_LOCAL_EDGE_SHADOW_ONLY',
      lotUpperBound: 0.1,
      sizingTier: 'RESEARCH',
    });
  });

  it('does not let provisional evidence rescue OOD, non-positive edge, or event risk', () => {
    expect(
      evaluatePaperOpportunityScout({ ...candidate, driftState: 'OUT_OF_DISTRIBUTION' }),
    ).toMatchObject({ eligible: false, reason: 'DRIFT_EVIDENCE_TOO_WEAK' });
    expect(evaluatePaperOpportunityScout({ ...candidate, netExpectedR: 0.01 })).toMatchObject({
      eligible: false,
      reason: 'NET_EXPECTED_R_TOO_LOW',
    });
    expect(
      evaluatePaperOpportunityScout({ ...candidate, eventRisk: 'HIGH_IMPACT_BLOCK' }),
    ).toMatchObject({ eligible: false, reason: 'EVENT_RISK_NOT_CLEAR' });
  });
});
