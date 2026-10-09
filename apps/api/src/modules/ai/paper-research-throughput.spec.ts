import {
  PAPER_RESEARCH_THROUGHPUT_LOT_CAP,
  evaluatePaperResearchThroughput,
} from './paper-research-throughput';

describe('evaluatePaperResearchThroughput', () => {
  const base = {
    normalPaperExecution: false,
    confidence: 0.6,
    netExpectedR: 0.16,
    executionSpreadEvidenceValid: true,
    eventRisk: 'CLEAR',
    strategyRoute: 'TREND_CONTINUATION',
    paperExecutionBlockers: [
      'ENSEMBLE_NOT_PAPER_ADMITTED',
      'ENSEMBLE_NOT_PROMOTABLE_ADMISSION',
      'DRIFT_OUT_OF_DISTRIBUTION',
    ],
  };

  it('admits a positive-EV candidate into research PAPER without granting qualification authority', () => {
    expect(evaluatePaperResearchThroughput(base)).toEqual({
      eligible: true,
      artifact: 'paper-research-throughput-v1',
      route: 'PAPER_RESEARCH_THROUGHPUT',
      reason: 'RESEARCH_EVIDENCE_CANDIDATE',
      qualificationEvidence: false,
      executionAuthority: 'PAPER_ONLY',
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
