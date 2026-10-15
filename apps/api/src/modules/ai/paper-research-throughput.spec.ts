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
      artifact: 'paper-research-throughput-v9-payoff-aware-exploration',
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

  it('admits a positive-edge PAPER exploration sample when trade and exit quality narrowly miss the old 0.40 floor', () => {
    expect(
      evaluatePaperResearchThroughput({
        ...base,
        confidence: 0.6935,
        netExpectedR: 0.0932,
        directionQuality: 0.4709,
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
    expect(evaluatePaperResearchThroughput({ ...base, driftState: 'STRESSED' })).toMatchObject({
      eligible: true,
      reason: 'RESEARCH_EXPLORATION_CANDIDATE',
    });
    expect(
      evaluatePaperResearchThroughput({
        ...base,
        driftState: 'OUT_OF_DISTRIBUTION',
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

  it('uses a tiny fixed PAPER lot cap and calibrated research-only direction floor', () => {
    expect(PAPER_RESEARCH_THROUGHPUT_LOT_CAP).toBe(0.01);
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
  it('gives rejected-edge canary precedence when both research routes qualify', () => {
    expect(
      selectPaperExecutionRoute({
        normalPaperExecution: false,
        rejectedEdgeCanaryEligible: true,
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
  });

  it('derives the emitted model version from the payoff-aware research artifact', () => {
    expect(PAPER_RESEARCH_THROUGHPUT_RELIABILITY_SOURCE_ARTIFACTS).toContain(
      'paper-research-throughput-v8-momentum-confirmed-exploration',
    );
    expect(paperResearchThroughputModelVersion('irexpro-multimodel-ensemble-v1')).toBe(
      'external-provider/irexpro-multimodel-ensemble-v1/paper-research-throughput-v9-payoff-aware-exploration',
    );
  });

  it('keeps sparse mixed evidence collecting when no catastrophic early loss pattern exists', () => {
    expect(
      evaluatePaperResearchPairSideReliability({
        wins: 1,
        losses: 2,
        grossProfit: 16,
        grossLoss: 18,
      }),
    ).toMatchObject({
      eligible: true,
      samples: 3,
      reason: 'INSUFFICIENT_EVIDENCE',
    });
    expect(PAPER_RESEARCH_THROUGHPUT_RELIABILITY_MIN_SAMPLES).toBe(5);
  });

  it('brakes a pair-side after three realised losses without a single winner', () => {
    expect(
      evaluatePaperResearchPairSideReliability({
        wins: 0,
        losses: 3,
        grossProfit: 0,
        grossLoss: 29.07,
      }),
    ).toMatchObject({
      eligible: false,
      samples: 3,
      profitFactor: 0,
      reason: 'EARLY_REALIZED_LOSS_BRAKE',
    });
  });

  it('keeps a low-win-rate pair-side eligible when its realised payoff is profitable', () => {
    expect(
      evaluatePaperResearchPairSideReliability({
        wins: 1,
        losses: 4,
        grossProfit: 40,
        grossLoss: 30,
      }),
    ).toMatchObject({
      eligible: true,
      samples: 5,
      profitFactor: 40 / 30,
      reason: 'POSITIVE_REALIZED_PAYOFF',
    });
  });

  it('quarantines a high-win-rate pair-side when its realised payoff loses money', () => {
    expect(
      evaluatePaperResearchPairSideReliability({
        wins: 3,
        losses: 2,
        grossProfit: 15,
        grossLoss: 30,
      }),
    ).toMatchObject({
      eligible: false,
      samples: 5,
      profitFactor: 0.5,
      reason: 'NEGATIVE_REALIZED_PAYOFF',
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
      lotCap: 0.01,
    });
    expect(PAPER_PAIRED_REVERSAL_RESEARCH_LOT_CAP).toBe(0.01);
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
