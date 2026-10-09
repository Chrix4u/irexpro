import {
  PAPER_RESEARCH_THROUGHPUT_EPISODE_COOLDOWN_MINUTES,
  PAPER_RESEARCH_THROUGHPUT_LOT_CAP,
  PAPER_RESEARCH_THROUGHPUT_RELIABILITY_MIN_SAMPLES,
  evaluatePaperResearchEpisodeGuard,
  evaluatePaperResearchPairSideReliability,
  evaluatePaperResearchThroughput,
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
    directionQuality: 0.62,
    tradeQuality: 0.58,
    exitQuality: 0.56,
    paperExecutionBlockers: ['ENSEMBLE_NOT_PAPER_ADMITTED', 'ENSEMBLE_NOT_PROMOTABLE_ADMISSION'],
  };

  it('keeps a positive-EV research candidate shadow-only without granting execution or qualification authority', () => {
    expect(evaluatePaperResearchThroughput(base)).toEqual({
      eligible: true,
      artifact: 'paper-research-throughput-v4-pair-side-reliability',
      route: 'PAPER_RESEARCH_THROUGHPUT',
      reason: 'RESEARCH_EVIDENCE_CANDIDATE',
      qualificationEvidence: false,
      executionAuthority: 'SHADOW_ONLY',
    });
  });

  it('rejects research throughput below the normal confidence floor', () => {
    expect(evaluatePaperResearchThroughput({ ...base, confidence: 0.6399 })).toMatchObject({
      eligible: false,
      reason: 'CONFIDENCE_TOO_LOW',
    });
  });

  it('rejects stressed or out-of-distribution drift', () => {
    expect(evaluatePaperResearchThroughput({ ...base, driftState: 'STRESSED' })).toMatchObject({
      eligible: false,
      reason: 'DRIFT_NOT_NORMAL',
    });
    expect(
      evaluatePaperResearchThroughput({ ...base, driftState: 'OUT_OF_DISTRIBUTION' }),
    ).toMatchObject({ eligible: false, reason: 'DRIFT_NOT_NORMAL' });
  });

  it('rejects weak direction, trade, or exit quality', () => {
    expect(evaluatePaperResearchThroughput({ ...base, directionQuality: 0.5499 })).toMatchObject({
      eligible: false,
      reason: 'DIRECTION_QUALITY_TOO_LOW',
    });
    expect(evaluatePaperResearchThroughput({ ...base, tradeQuality: 0.4799 })).toMatchObject({
      eligible: false,
      reason: 'TRADE_QUALITY_TOO_LOW',
    });
    expect(evaluatePaperResearchThroughput({ ...base, exitQuality: 0.4799 })).toMatchObject({
      eligible: false,
      reason: 'EXIT_QUALITY_TOO_LOW',
    });
  });

  it('uses a tiny fixed PAPER lot cap for accelerated evidence collection', () => {
    expect(PAPER_RESEARCH_THROUGHPUT_LOT_CAP).toBe(0.01);
  });

  it('does not duplicate a candidate already eligible for normal PAPER execution', () => {
    expect(evaluatePaperResearchThroughput({ ...base, normalPaperExecution: true })).toMatchObject({
      eligible: false,
      reason: 'NORMAL_PAPER_EXECUTION',
    });
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
        paperResearchExecutionEligible: true,
      }),
    ).toBe('REJECTED_EDGE_CANARY');
  });

  it('keeps normal PAPER execution authoritative over research routes', () => {
    expect(
      selectPaperExecutionRoute({
        normalPaperExecution: true,
        rejectedEdgeCanaryEligible: true,
        paperResearchExecutionEligible: true,
      }),
    ).toBe('NORMAL_PAPER');
  });

  it('keeps research-throughput shadow-only even when its evidence filters qualify', () => {
    expect(
      selectPaperExecutionRoute({
        normalPaperExecution: false,
        rejectedEdgeCanaryEligible: false,
        paperResearchExecutionEligible: true,
      }),
    ).toBe('NONE');
  });
});

describe('PAPER research-throughput provenance and pair-side reliability', () => {
  it('derives the emitted model version from the active research artifact', () => {
    expect(paperResearchThroughputModelVersion('irexpro-multimodel-ensemble-v1')).toBe(
      'external-provider/irexpro-multimodel-ensemble-v1/paper-research-throughput-v4-pair-side-reliability',
    );
  });

  it('keeps collecting while pair-side evidence is still sparse', () => {
    expect(evaluatePaperResearchPairSideReliability({ wins: 0, losses: 4 })).toMatchObject({
      eligible: true,
      samples: 4,
      reason: 'INSUFFICIENT_EVIDENCE',
    });
    expect(PAPER_RESEARCH_THROUGHPUT_RELIABILITY_MIN_SAMPLES).toBe(5);
  });

  it('quarantines a sufficiently observed pair-side with negative smoothed expectancy', () => {
    expect(evaluatePaperResearchPairSideReliability({ wins: 0, losses: 5 })).toMatchObject({
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
});
