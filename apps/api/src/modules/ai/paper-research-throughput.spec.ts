import {
  PAPER_RESEARCH_THROUGHPUT_EPISODE_COOLDOWN_MINUTES,
  PAPER_RESEARCH_THROUGHPUT_LOT_CAP,
  PAPER_RESEARCH_THROUGHPUT_MIN_DIRECTION_QUALITY,
  PAPER_RESEARCH_THROUGHPUT_RELIABILITY_MIN_SAMPLES,
  PAPER_RESEARCH_THROUGHPUT_RELIABILITY_SOURCE_ARTIFACTS,
  PAPER_PAIRED_REVERSAL_RESEARCH_LOT_CAP,
  evaluatePaperResearchEpisodeGuard,
  evaluatePaperResearchPairSideReliability,
  evaluatePaperResearchThroughput,
  evaluatePaperPairedReversalResearch,
  paperResearchThroughputModelVersion,
  selectPaperExecutionRoute,
} from './paper-research-throughput';

describe('evaluatePaperResearchThroughput', () => {
  const base = {
    normalPaperExecution: false,
    confidence: 0.68,
    netExpectedR: 0.16,
    executionSpreadEvidenceValid: true,
    eventRisk: 'CLEAR',
    strategyRoute: 'TREND_CONTINUATION',
    driftState: 'NORMAL',
    directionQuality: 0.32,
    tradeQuality: 0.58,
    exitQuality: 0.56,
    paperExecutionBlockers: ['ENSEMBLE_NOT_PAPER_ADMITTED', 'ENSEMBLE_NOT_PROMOTABLE_ADMISSION'],
  };

  it('marks a positive-EV research candidate PAPER-only without granting qualification authority', () => {
    expect(evaluatePaperResearchThroughput(base)).toEqual({
      eligible: true,
      artifact: 'paper-research-throughput-v11-momentum-confirmed-exploration',
      route: 'PAPER_RESEARCH_THROUGHPUT',
      reason: 'RESEARCH_EVIDENCE_CANDIDATE',
      qualificationEvidence: false,
      executionAuthority: 'PAPER_ONLY_RESEARCH',
    });
  });

  it('admits a controlled PAPER exploration sample when strict confidence is missed but economics and quality remain usable', () => {
    expect(
      evaluatePaperResearchThroughput({
        ...base,
        confidence: 0.6,
        driftState: 'OUT_OF_DISTRIBUTION',
        directionQuality: 0.18,
        alignedMomentumAtr: 0.3,
        tradeQuality: 0.44,
        exitQuality: 0.43,
        paperExecutionBlockers: [...base.paperExecutionBlockers, 'DRIFT_OUT_OF_DISTRIBUTION'],
      }),
    ).toMatchObject({
      eligible: true,
      reason: 'RESEARCH_EXPLORATION_CANDIDATE',
      qualificationEvidence: false,
      executionAuthority: 'PAPER_ONLY_RESEARCH',
    });
  });

  it('requires aligned short-horizon momentum for exploration even when structural quality otherwise passes', () => {
    expect(
      evaluatePaperResearchThroughput({
        ...base,
        confidence: 0.6,
        driftState: 'OUT_OF_DISTRIBUTION',
        directionQuality: 0.18,
        tradeQuality: 0.44,
        exitQuality: 0.43,
        alignedMomentumAtr: 0.1499,
        paperExecutionBlockers: [...base.paperExecutionBlockers, 'DRIFT_OUT_OF_DISTRIBUTION'],
      }),
    ).toMatchObject({ eligible: false, reason: 'MOMENTUM_NOT_CONFIRMED' });

    expect(
      evaluatePaperResearchThroughput({
        ...base,
        confidence: 0.6,
        driftState: 'OUT_OF_DISTRIBUTION',
        directionQuality: 0.18,
        tradeQuality: 0.44,
        exitQuality: 0.43,
        alignedMomentumAtr: -0.2,
        paperExecutionBlockers: [...base.paperExecutionBlockers, 'DRIFT_OUT_OF_DISTRIBUTION'],
      }),
    ).toMatchObject({ eligible: false, reason: 'MOMENTUM_NOT_CONFIRMED' });
  });

  it('keeps strict research evidence admission unchanged when momentum is weak', () => {
    expect(evaluatePaperResearchThroughput({ ...base, alignedMomentumAtr: -0.2 })).toMatchObject({
      eligible: true,
      reason: 'RESEARCH_EVIDENCE_CANDIDATE',
    });
  });

  it('admits a positive-edge PAPER exploration sample when trade and exit quality narrowly miss the old 0.40 floor', () => {
    expect(
      evaluatePaperResearchThroughput({
        ...base,
        confidence: 0.6935,
        netExpectedR: 0.0932,
        directionQuality: 0.4709,
        alignedMomentumAtr: 0.3,
        tradeQuality: 0.3967,
        exitQuality: 0.3858,
      }),
    ).toMatchObject({
      eligible: true,
      reason: 'RESEARCH_EXPLORATION_CANDIDATE',
      qualificationEvidence: false,
      executionAuthority: 'PAPER_ONLY_RESEARCH',
    });
  });

  it('admits a stronger positive-edge PAPER exploration sample at the bounded strong-edge structural floors', () => {
    expect(
      evaluatePaperResearchThroughput({
        ...base,
        confidence: 0.6352,
        netExpectedR: 0.1699,
        driftState: 'OUT_OF_DISTRIBUTION',
        directionQuality: 0.1238,
        alignedMomentumAtr: 0.3,
        tradeQuality: 0.3342,
        exitQuality: 0.3223,
        paperExecutionBlockers: [...base.paperExecutionBlockers, 'DRIFT_OUT_OF_DISTRIBUTION'],
      }),
    ).toMatchObject({
      eligible: true,
      reason: 'RESEARCH_EXPLORATION_CANDIDATE',
      qualificationEvidence: false,
      executionAuthority: 'PAPER_ONLY_RESEARCH',
    });
  });

  it('accepts direction-confirmed PAPER exploration when fast aligned momentum covers a blind legacy direction score', () => {
    const liveDirectionConfirmedCandidate = {
      ...base,
      confidence: 0.6,
      netExpectedR: 0.0993,
      driftState: 'OUT_OF_DISTRIBUTION',
      directionQuality: 0,
      tradeQuality: 0.4059,
      exitQuality: 0.4018,
      alignedMomentumAtr: 1.0247,
      paperExecutionBlockers: [...base.paperExecutionBlockers, 'DRIFT_OUT_OF_DISTRIBUTION'],
    };

    expect(evaluatePaperResearchThroughput(liveDirectionConfirmedCandidate)).toMatchObject({
      eligible: true,
      reason: 'RESEARCH_EXPLORATION_CANDIDATE',
      qualificationEvidence: false,
      executionAuthority: 'PAPER_ONLY_RESEARCH',
    });
  });

  it('does not let weak, opposing, or exhausted momentum bypass the direction floor', () => {
    const momentumOnly = {
      ...base,
      confidence: 0.6,
      netExpectedR: 0.1,
      driftState: 'OUT_OF_DISTRIBUTION',
      directionQuality: 0,
      tradeQuality: 0.41,
      exitQuality: 0.4,
      paperExecutionBlockers: [...base.paperExecutionBlockers, 'DRIFT_OUT_OF_DISTRIBUTION'],
    };

    for (const alignedMomentumAtr of [-0.2, 0.1499, 1.5001]) {
      expect(
        evaluatePaperResearchThroughput({ ...momentumOnly, alignedMomentumAtr }),
      ).toMatchObject({ eligible: false, reason: 'DIRECTION_QUALITY_TOO_LOW' });
    }
  });

  it('keeps the exploration fallback bounded below its reduced confidence and quality floors', () => {
    expect(evaluatePaperResearchThroughput({ ...base, confidence: 0.5999 })).toMatchObject({
      eligible: false,
      reason: 'CONFIDENCE_TOO_LOW',
    });
    expect(
      evaluatePaperResearchThroughput({
        ...base,
        confidence: 0.6,
        netExpectedR: 0.1,
        directionQuality: 0.0999,
      }),
    ).toMatchObject({ eligible: false, reason: 'DIRECTION_QUALITY_TOO_LOW' });
    expect(
      evaluatePaperResearchThroughput({
        ...base,
        confidence: 0.6,
        netExpectedR: 0.1,
        tradeQuality: 0.3499,
      }),
    ).toMatchObject({ eligible: false, reason: 'TRADE_QUALITY_TOO_LOW' });
    expect(
      evaluatePaperResearchThroughput({
        ...base,
        confidence: 0.6,
        netExpectedR: 0.1,
        exitQuality: 0.3499,
      }),
    ).toMatchObject({ eligible: false, reason: 'EXIT_QUALITY_TOO_LOW' });
  });

  it('admits a bounded single-MTF-drift PAPER research sample without weakening the general exploration floor', () => {
    const liveSingleMtfDriftCandidate = {
      ...base,
      confidence: 0.654,
      netExpectedR: 0.084,
      driftState: 'OUT_OF_DISTRIBUTION',
      driftDiagnostics: ['mtfStrength:HARD_LOW'],
      directionQuality: 0.197,
      tradeQuality: 0.218,
      exitQuality: 0.202,
      alignedMomentumAtr: 0.853,
      paperExecutionBlockers: [...base.paperExecutionBlockers, 'DRIFT_OUT_OF_DISTRIBUTION'],
    };

    expect(evaluatePaperResearchThroughput(liveSingleMtfDriftCandidate)).toMatchObject({
      eligible: true,
      reason: 'BOUNDED_MTF_RESEARCH_CANDIDATE',
      qualificationEvidence: false,
      executionAuthority: 'PAPER_ONLY_RESEARCH',
    });

    const unsafeMultiFeatureDriftCandidate = {
      ...liveSingleMtfDriftCandidate,
      driftDiagnostics: ['mtfStrength:HARD_LOW', 'confidence:HARD_LOW'],
    };
    expect(evaluatePaperResearchThroughput(unsafeMultiFeatureDriftCandidate)).toMatchObject({
      eligible: false,
    });

    expect(
      evaluatePaperResearchThroughput({
        ...liveSingleMtfDriftCandidate,
        alignedMomentumAtr: -0.04,
      }),
    ).toMatchObject({ eligible: false });
  });

  it('accelerates a quality-limited PAPER candidate only when recent pair-side expectancy is strongly positive', () => {
    const qualityLimited = {
      ...base,
      confidence: 0.64,
      netExpectedR: 0.14,
      driftState: 'OUT_OF_DISTRIBUTION',
      driftDiagnostics: ['confidence:HARD_LOW', 'emaSeparation:HARD_LOW', 'mtfStrength:HARD_LOW'],
      directionQuality: 0.08,
      tradeQuality: 0.28,
      exitQuality: 0.31,
      alignedMomentumAtr: 0.42,
      paperExecutionBlockers: [...base.paperExecutionBlockers, 'DRIFT_OUT_OF_DISTRIBUTION'],
      pairSideReliability: evaluatePaperResearchPairSideReliability({ wins: 3, losses: 1 }),
    } as Parameters<typeof evaluatePaperResearchThroughput>[0] & {
      pairSideReliability: ReturnType<typeof evaluatePaperResearchPairSideReliability>;
    };

    expect(evaluatePaperResearchThroughput(qualityLimited)).toMatchObject({
      eligible: true,
      reason: 'EVIDENCE_BACKED_PAIR_SIDE_ACCELERATION',
      qualificationEvidence: false,
      executionAuthority: 'PAPER_ONLY_RESEARCH',
    });

    const negativeEvidence = {
      ...qualityLimited,
      pairSideReliability: evaluatePaperResearchPairSideReliability({ wins: 1, losses: 2 }),
    };
    expect(evaluatePaperResearchThroughput(negativeEvidence)).toMatchObject({ eligible: false });

    const weakMomentum = { ...qualityLimited, alignedMomentumAtr: 0.1499 };
    expect(evaluatePaperResearchThroughput(weakMomentum)).toMatchObject({
      eligible: false,
      reason: 'MOMENTUM_NOT_CONFIRMED',
    });
  });

  it('keeps the strong-edge relaxation bounded at 0.05 direction and 0.30 trade/exit quality', () => {
    const strong = { ...base, confidence: 0.64, netExpectedR: 0.16 };
    expect(evaluatePaperResearchThroughput({ ...strong, directionQuality: 0.0499 })).toMatchObject({
      eligible: false,
      reason: 'DIRECTION_QUALITY_TOO_LOW',
    });
    expect(evaluatePaperResearchThroughput({ ...strong, tradeQuality: 0.2999 })).toMatchObject({
      eligible: false,
      reason: 'TRADE_QUALITY_TOO_LOW',
    });
    expect(evaluatePaperResearchThroughput({ ...strong, exitQuality: 0.2999 })).toMatchObject({
      eligible: false,
      reason: 'EXIT_QUALITY_TOO_LOW',
    });
  });

  it('allows stressed or out-of-distribution drift only through non-promotable exploration', () => {
    expect(
      evaluatePaperResearchThroughput({ ...base, driftState: 'STRESSED', alignedMomentumAtr: 0.3 }),
    ).toMatchObject({
      eligible: true,
      reason: 'RESEARCH_EXPLORATION_CANDIDATE',
    });
    expect(
      evaluatePaperResearchThroughput({
        ...base,
        driftState: 'OUT_OF_DISTRIBUTION',
        alignedMomentumAtr: 0.3,
        paperExecutionBlockers: [...base.paperExecutionBlockers, 'DRIFT_OUT_OF_DISTRIBUTION'],
      }),
    ).toMatchObject({ eligible: true, reason: 'RESEARCH_EXPLORATION_CANDIDATE' });
  });

  it('rejects unusably weak direction, trade, or exit quality even for exploration', () => {
    expect(
      evaluatePaperResearchThroughput({ ...base, netExpectedR: 0.1, directionQuality: 0.0999 }),
    ).toMatchObject({
      eligible: false,
      reason: 'DIRECTION_QUALITY_TOO_LOW',
    });
    expect(
      evaluatePaperResearchThroughput({ ...base, netExpectedR: 0.1, tradeQuality: 0.3499 }),
    ).toMatchObject({
      eligible: false,
      reason: 'TRADE_QUALITY_TOO_LOW',
    });
    expect(
      evaluatePaperResearchThroughput({ ...base, netExpectedR: 0.1, exitQuality: 0.3499 }),
    ).toMatchObject({
      eligible: false,
      reason: 'EXIT_QUALITY_TOO_LOW',
    });
  });

  it('allows realistic risk-sized PAPER research up to a 1.0-lot safety ceiling', () => {
    expect(PAPER_RESEARCH_THROUGHPUT_LOT_CAP).toBe(1);
    expect(PAPER_RESEARCH_THROUGHPUT_MIN_DIRECTION_QUALITY).toBe(0.25);
  });

  it('does not duplicate a candidate already eligible for normal PAPER execution', () => {
    expect(evaluatePaperResearchThroughput({ ...base, normalPaperExecution: true })).toMatchObject({
      eligible: false,
      reason: 'NORMAL_PAPER_EXECUTION',
    });
  });

  it('allows non-promotable research throughput when PAPER simulation cost is usable', () => {
    expect(
      evaluatePaperResearchThroughput({
        ...base,
        executionSpreadEvidenceValid: false,
        paperExecutionCostUsable: true,
      }),
    ).toMatchObject({ eligible: true, reason: 'RESEARCH_EVIDENCE_CANDIDATE' });
  });

  it('fails closed on non-positive-enough economics, invalid spread, or event risk', () => {
    expect(evaluatePaperResearchThroughput({ ...base, netExpectedR: 0.0799 })).toMatchObject({
      eligible: false,
      reason: 'NET_EXPECTED_R_TOO_LOW',
    });
    expect(
      evaluatePaperResearchThroughput({ ...base, executionSpreadEvidenceValid: false }),
    ).toMatchObject({ eligible: false, reason: 'SPREAD_EVIDENCE_INVALID' });
    expect(evaluatePaperResearchThroughput({ ...base, eventRisk: 'BLOCKED' })).toMatchObject({
      eligible: false,
      reason: 'EVENT_RISK_NOT_CLEAR',
    });
  });

  it('rejects unsafe governance blockers instead of bypassing the risk engine', () => {
    expect(
      evaluatePaperResearchThroughput({
        ...base,
        paperExecutionBlockers: [...base.paperExecutionBlockers, 'PAPER_NET_EXPECTED_R'],
      }),
    ).toMatchObject({ eligible: false, reason: 'UNSAFE_BLOCKER' });
  });
});

describe('PAPER execution route provenance', () => {
  it('quarantines rejected-edge canary execution by default and lets controlled research own the trade', () => {
    expect(
      selectPaperExecutionRoute({
        normalPaperExecution: false,
        rejectedEdgeCanaryEligible: true,
        paperResearchThroughputEligible: true,
        pairedReversalResearchEligible: true,
      }),
    ).toBe('PAPER_RESEARCH_THROUGHPUT');
  });

  it('can explicitly re-enable rejected-edge canary execution after new evidence qualifies it', () => {
    expect(
      selectPaperExecutionRoute({
        normalPaperExecution: false,
        rejectedEdgeCanaryEligible: true,
        rejectedEdgeCanaryExecutionEnabled: true,
        paperResearchThroughputEligible: true,
        pairedReversalResearchEligible: true,
      }),
    ).toBe('REJECTED_EDGE_CANARY');
  });

  it('keeps normal PAPER execution authoritative over research routes', () => {
    expect(
      selectPaperExecutionRoute({
        normalPaperExecution: true,
        rejectedEdgeCanaryEligible: true,
        paperResearchThroughputEligible: true,
        pairedReversalResearchEligible: true,
      }),
    ).toBe('NORMAL_PAPER');
  });

  it('selects controlled PAPER research when normal and canary routes do not qualify', () => {
    expect(
      selectPaperExecutionRoute({
        normalPaperExecution: false,
        rejectedEdgeCanaryEligible: false,
        paperResearchThroughputEligible: true,
        pairedReversalResearchEligible: true,
      }),
    ).toBe('PAPER_RESEARCH_THROUGHPUT');
  });

  it('selects extension-exhaustion PAPER research when the existing routes do not qualify', () => {
    expect(
      selectPaperExecutionRoute({
        normalPaperExecution: false,
        rejectedEdgeCanaryEligible: false,
        paperResearchThroughputEligible: false,
        pairedReversalResearchEligible: false,
        extensionExhaustionResearchEligible: true,
      }),
    ).toBe('PAPER_EXTENSION_EXHAUSTION_RESEARCH');
  });

  it('abstains when no PAPER route qualifies', () => {
    expect(
      selectPaperExecutionRoute({
        normalPaperExecution: false,
        rejectedEdgeCanaryEligible: false,
        paperResearchThroughputEligible: false,
        pairedReversalResearchEligible: false,
      }),
    ).toBe('NONE');
  });
});

describe('PAPER research-throughput provenance and pair-side reliability', () => {
  it('inherits reliability evidence from the deployed v2 episode-guarded artifact', () => {
    expect(PAPER_RESEARCH_THROUGHPUT_RELIABILITY_SOURCE_ARTIFACTS).toContain(
      'paper-research-throughput-v2-episode-guarded',
    );
  });

  it('keeps the prior v5 cohort in reliability history while emitting a distinct exploration artifact', () => {
    expect(PAPER_RESEARCH_THROUGHPUT_RELIABILITY_SOURCE_ARTIFACTS).toContain(
      'paper-research-throughput-v5-controlled-execution',
    );
    expect(PAPER_RESEARCH_THROUGHPUT_RELIABILITY_SOURCE_ARTIFACTS).toContain(
      'paper-research-throughput-v8-momentum-confirmed-exploration',
    );
    expect(PAPER_RESEARCH_THROUGHPUT_RELIABILITY_SOURCE_ARTIFACTS).toContain(
      'paper-research-throughput-v10-evidence-backed-acceleration',
    );
  });

  it('derives the emitted model version from the active research artifact', () => {
    expect(paperResearchThroughputModelVersion('irexpro-multimodel-ensemble-v1')).toBe(
      'external-provider/irexpro-multimodel-ensemble-v1/paper-research-throughput-v11-momentum-confirmed-exploration',
    );
  });

  it('keeps collecting while mixed pair-side evidence is still sparse', () => {
    expect(evaluatePaperResearchPairSideReliability({ wins: 1, losses: 2 })).toMatchObject({
      eligible: true,
      samples: 3,
      reason: 'INSUFFICIENT_EVIDENCE',
    });
    expect(PAPER_RESEARCH_THROUGHPUT_RELIABILITY_MIN_SAMPLES).toBe(5);
  });

  it('brakes a three-loss pair-side before the normal five-sample reliability threshold', () => {
    expect(evaluatePaperResearchPairSideReliability({ wins: 0, losses: 3 })).toMatchObject({
      eligible: false,
      samples: 3,
      reason: 'EARLY_LOSS_STREAK',
    });
  });

  it('quarantines a sufficiently observed pair-side with negative smoothed expectancy', () => {
    expect(evaluatePaperResearchPairSideReliability({ wins: 1, losses: 4 })).toMatchObject({
      eligible: false,
      samples: 5,
      reason: 'NEGATIVE_PAIR_SIDE_EXPECTANCY',
    });
  });

  it('keeps a sufficiently observed positive pair-side eligible', () => {
    expect(evaluatePaperResearchPairSideReliability({ wins: 6, losses: 0 })).toMatchObject({
      eligible: true,
      samples: 6,
      reason: 'POSITIVE_PAIR_SIDE_EXPECTANCY',
    });
  });

  it('quarantines a pair-side whose realised payoff is negative even when win-count expectancy is positive', () => {
    expect(
      evaluatePaperResearchPairSideReliability({
        wins: 3,
        losses: 2,
        realisedRSamples: 5,
        realisedRSum: -0.5,
      }),
    ).toMatchObject({
      eligible: false,
      samples: 5,
      realisedRSamples: 5,
      realisedAverageR: -0.1,
      reason: 'NEGATIVE_REALISED_PAIR_SIDE_EXPECTANCY',
    });
  });

  it('keeps positive realised-R payoff eligible after the five-sample threshold', () => {
    expect(
      evaluatePaperResearchPairSideReliability({
        wins: 2,
        losses: 3,
        realisedRSamples: 5,
        realisedRSum: 0.6,
      }),
    ).toMatchObject({
      eligible: true,
      samples: 5,
      realisedRSamples: 5,
      realisedAverageR: 0.12,
      reason: 'POSITIVE_PAIR_SIDE_EXPECTANCY',
    });
  });

  it('does not make incomplete realised-R geometry authoritative before five valid payoff samples', () => {
    expect(
      evaluatePaperResearchPairSideReliability({
        wins: 3,
        losses: 2,
        realisedRSamples: 4,
        realisedRSum: -4,
      }),
    ).toMatchObject({
      eligible: true,
      samples: 5,
      realisedRSamples: 4,
      realisedAverageR: -1,
      reason: 'POSITIVE_PAIR_SIDE_EXPECTANCY',
    });
  });
});

describe('evaluatePaperResearchEpisodeGuard', () => {
  const evaluatedAt = new Date('2026-10-09T05:00:00.000Z');
  const episodeKey = 'USDCHF|BUY|TREND_HEALTHY|TREND_CONTINUATION';

  it('blocks a duplicate research sample while the same pair-side episode is still open', () => {
    expect(
      evaluatePaperResearchEpisodeGuard({
        currentEpisodeKey: episodeKey,
        previousEpisodeKey: episodeKey,
        previousTradeStatus: 'OPEN',
        previousClosedAt: null,
        evaluatedAt,
      }),
    ).toEqual({ eligible: false, reason: 'ACTIVE_RESEARCH_SAMPLE' });
  });

  it.each(['REJECTED', 'CANCELLED'] as const)(
    'does not let an unsuccessful terminal %s trade block future research samples',
    (previousTradeStatus) => {
      expect(
        evaluatePaperResearchEpisodeGuard({
          currentEpisodeKey: episodeKey,
          previousEpisodeKey: episodeKey,
          previousTradeStatus,
          previousClosedAt: null,
          evaluatedAt,
        }),
      ).toEqual({ eligible: true, reason: 'TERMINAL_RESEARCH_SAMPLE' });
    },
  );

  it('keeps the same resolved episode in cooldown before collecting another live sample', () => {
    expect(
      evaluatePaperResearchEpisodeGuard({
        currentEpisodeKey: episodeKey,
        previousEpisodeKey: episodeKey,
        previousTradeStatus: 'CLOSED',
        previousClosedAt: new Date(evaluatedAt.getTime() - 15 * 60_000),
        evaluatedAt,
      }),
    ).toEqual({ eligible: false, reason: 'EPISODE_COOLDOWN' });
  });

  it('allows a materially changed episode immediately and the same episode after cooldown', () => {
    expect(
      evaluatePaperResearchEpisodeGuard({
        currentEpisodeKey: 'USDCHF|BUY|TREND_WEAK|TREND_CONTINUATION',
        previousEpisodeKey: episodeKey,
        previousTradeStatus: 'CLOSED',
        previousClosedAt: new Date(evaluatedAt.getTime() - 5 * 60_000),
        evaluatedAt,
      }),
    ).toEqual({ eligible: true, reason: 'EPISODE_CHANGED' });

    expect(
      evaluatePaperResearchEpisodeGuard({
        currentEpisodeKey: episodeKey,
        previousEpisodeKey: episodeKey,
        previousTradeStatus: 'CLOSED',
        previousClosedAt: new Date(
          evaluatedAt.getTime() - (PAPER_RESEARCH_THROUGHPUT_EPISODE_COOLDOWN_MINUTES + 1) * 60_000,
        ),
        evaluatedAt,
      }),
    ).toEqual({ eligible: true, reason: 'EPISODE_COOLDOWN_ELAPSED' });
  });
  it('keeps a reliability-demoted continuation eligible only for shadow research collection', () => {
    expect(
      evaluatePaperResearchThroughput({
        normalPaperExecution: false,
        routeReliabilityDemoted: true,
        confidence: 0.7,
        netExpectedR: 0.2,
        executionSpreadEvidenceValid: true,
        eventRisk: 'CLEAR',
        strategyRoute: 'TREND_CONTINUATION',
        driftState: 'NORMAL',
        directionQuality: 0.65,
        tradeQuality: 0.6,
        exitQuality: 0.6,
        paperExecutionBlockers: [],
      }),
    ).toMatchObject({ eligible: true, route: 'PAPER_RESEARCH_THROUGHPUT' });
  });

  it('still rejects zero-blocker research candidates when no route demotion occurred', () => {
    expect(
      evaluatePaperResearchThroughput({
        normalPaperExecution: false,
        confidence: 0.7,
        netExpectedR: 0.2,
        executionSpreadEvidenceValid: true,
        eventRisk: 'CLEAR',
        strategyRoute: 'TREND_CONTINUATION',
        driftState: 'NORMAL',
        directionQuality: 0.65,
        tradeQuality: 0.6,
        exitQuality: 0.6,
        paperExecutionBlockers: [],
      }),
    ).toMatchObject({ eligible: false, reason: 'UNSAFE_BLOCKER' });
  });
});

describe('paired reversal PAPER research', () => {
  const base = {
    candidateDirection: 'SELL' as const,
    preferredDirection: 'SELL' as const,
    reversalCandidate: true,
    researchNetExpectedR: 0.18,
    executionSpreadEvidenceValid: true,
    eventRisk: 'CLEAR',
    driftState: 'STRESSED',
  };

  it('allows a confirmed paired reversal into tiny PAPER-only research under stressed drift', () => {
    expect(evaluatePaperPairedReversalResearch(base)).toEqual({
      eligible: true,
      route: 'PAIRED_REVERSAL_RESEARCH',
      reason: 'PAIRED_REVERSAL_RESEARCH_CANDIDATE',
      qualificationEvidence: false,
      executionAuthority: 'PAPER_ONLY_RESEARCH',
      lotCap: 1,
    });
    expect(PAPER_PAIRED_REVERSAL_RESEARCH_LOT_CAP).toBe(1);
  });

  it('only allows the pairwise-selected side to enter reversal research', () => {
    expect(
      evaluatePaperPairedReversalResearch({ ...base, candidateDirection: 'BUY' }),
    ).toMatchObject({ eligible: false, reason: 'PAIRED_DIRECTION_NOT_SELECTED' });
  });

  it('does not execute an unconfirmed opposite side', () => {
    expect(
      evaluatePaperPairedReversalResearch({ ...base, reversalCandidate: false }),
    ).toMatchObject({ eligible: false, reason: 'PAIRED_REVERSAL_NOT_CONFIRMED' });
  });

  it('allows paired reversal research when PAPER simulation cost is usable', () => {
    expect(
      evaluatePaperPairedReversalResearch({
        ...base,
        executionSpreadEvidenceValid: false,
        paperExecutionCostUsable: true,
      }),
    ).toMatchObject({ eligible: true, reason: 'PAIRED_REVERSAL_RESEARCH_CANDIDATE' });
  });

  it('fails closed on missing spread evidence, event risk, and out-of-distribution drift', () => {
    expect(
      evaluatePaperPairedReversalResearch({ ...base, executionSpreadEvidenceValid: false }),
    ).toMatchObject({ eligible: false, reason: 'SPREAD_EVIDENCE_INVALID' });
    expect(
      evaluatePaperPairedReversalResearch({ ...base, eventRisk: 'HIGH_IMPACT_BLOCK' }),
    ).toMatchObject({ eligible: false, reason: 'EVENT_RISK_NOT_CLEAR' });
    expect(
      evaluatePaperPairedReversalResearch({ ...base, driftState: 'OUT_OF_DISTRIBUTION' }),
    ).toMatchObject({ eligible: false, reason: 'DRIFT_OUT_OF_DISTRIBUTION' });
  });

  it('requires positive post-cost paired expectancy and accepts NORMAL as well as STRESSED drift', () => {
    expect(
      evaluatePaperPairedReversalResearch({ ...base, researchNetExpectedR: 0.0799 }),
    ).toMatchObject({ eligible: false, reason: 'NET_EXPECTED_R_TOO_LOW' });
    expect(evaluatePaperPairedReversalResearch({ ...base, driftState: 'NORMAL' })).toMatchObject({
      eligible: true,
    });
  });

  it('selects paired reversal research only after all existing PAPER routes decline', () => {
    expect(
      selectPaperExecutionRoute({
        normalPaperExecution: false,
        rejectedEdgeCanaryEligible: false,
        paperResearchThroughputEligible: false,
        pairedReversalResearchEligible: true,
      }),
    ).toBe('PAIRED_REVERSAL_RESEARCH');
  });
});
