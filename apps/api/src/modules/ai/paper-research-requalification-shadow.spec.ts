import {
  PAPER_RESEARCH_REQUALIFICATION_MAX_DRAWDOWN,
  PAPER_RESEARCH_REQUALIFICATION_MIN_EPISODES,
  PAPER_RESEARCH_REQUALIFICATION_MIN_PROFIT_FACTOR,
  PAPER_RESEARCH_REQUALIFICATION_MIN_SHARPE,
  evaluatePaperResearchRequalificationEvidence,
  evaluatePaperResearchRequalificationShadow,
} from './paper-research-requalification-shadow';

describe('PAPER research requalification shadow', () => {
  const base = {
    throughputEligible: true,
    pairSideEligible: true,
    episodeEligible: true,
    calibrationBlocked: false,
    portfolioBlocked: true,
    costAwareAction: 'ENTER_NOW' as const,
    costAwareReason: 'COST_EFFICIENT_ENTRY',
    pairSideSamples: 10,
    pairSideRealisedAverageR: 0.26,
  };

  it('collects a locally valid candidate even while the realised portfolio brake is blocked', () => {
    expect(evaluatePaperResearchRequalificationShadow(base)).toEqual({
      artifact: 'paper-research-requalification-shadow-v1',
      candidate: true,
      reason: 'SHADOW_RECOVERY_CANDIDATE',
      executionAuthority: 'NONE',
      modifiesExecution: false,
      qualificationEvidence: false,
      productionEligible: false,
      portfolioBrakeBlocked: true,
      pairSideSamples: 10,
      pairSideRealisedAverageR: 0.26,
      costAwareAction: 'ENTER_NOW',
      costAwareReason: 'COST_EFFICIENT_ENTRY',
    });
  });

  it.each([
    ['throughputEligible', false, 'RESEARCH_ROUTE_NOT_ELIGIBLE'],
    ['pairSideEligible', false, 'PAIR_SIDE_RELIABILITY_BLOCK'],
    ['episodeEligible', false, 'EPISODE_GUARD_BLOCK'],
    ['calibrationBlocked', true, 'BROAD_CALIBRATION_BRAKE'],
  ] as const)('rejects when %s is %s', (field, value, reason) => {
    expect(evaluatePaperResearchRequalificationShadow({ ...base, [field]: value })).toMatchObject({
      candidate: false,
      reason,
      executionAuthority: 'NONE',
      modifiesExecution: false,
    });
  });

  it.each(['DEFER', 'SHADOW_ONLY'] as const)(
    'requires the current cost-aware policy to say ENTER_NOW instead of %s',
    (costAwareAction) => {
      expect(
        evaluatePaperResearchRequalificationShadow({ ...base, costAwareAction }),
      ).toMatchObject({ candidate: false, reason: 'COST_AWARE_BLOCK' });
    },
  );

  it('does not require the realised portfolio brake to be blocked', () => {
    expect(
      evaluatePaperResearchRequalificationShadow({ ...base, portfolioBlocked: false }),
    ).toMatchObject({
      candidate: true,
      reason: 'SHADOW_RECOVERY_CANDIDATE',
      portfolioBrakeBlocked: false,
    });
  });
});

describe('PAPER research requalification evidence scorecard', () => {
  const mature = {
    episodes: PAPER_RESEARCH_REQUALIFICATION_MIN_EPISODES,
    wins: 6,
    losses: 2,
    netR: 4,
    profitFactor: 1.8,
    sharpe: 1.4,
    maxDrawdown: 0.05,
  };

  it('keeps fresh evidence collecting before eight non-overlapping episodes', () => {
    expect(
      evaluatePaperResearchRequalificationEvidence({
        ...mature,
        episodes: PAPER_RESEARCH_REQUALIFICATION_MIN_EPISODES - 1,
      }),
    ).toMatchObject({
      state: 'COLLECTING',
      reason: 'INSUFFICIENT_FRESH_EPISODES',
      executionAuthority: 'NONE',
      qualificationEvidence: false,
      productionEligible: false,
    });
  });

  it('reports a non-executing recovery signal only when existing system-quality gates all pass', () => {
    expect(evaluatePaperResearchRequalificationEvidence(mature)).toMatchObject({
      state: 'RECOVERY_SIGNAL',
      reason: 'FRESH_EDGE_RECOVERY_SIGNAL',
      executionAuthority: 'NONE',
      modifiesExecution: false,
      qualificationEvidence: false,
      productionEligible: false,
    });
    expect(PAPER_RESEARCH_REQUALIFICATION_MIN_PROFIT_FACTOR).toBe(1.15);
    expect(PAPER_RESEARCH_REQUALIFICATION_MIN_SHARPE).toBe(1);
    expect(PAPER_RESEARCH_REQUALIFICATION_MAX_DRAWDOWN).toBe(0.12);
  });

  it('keeps a mature cohort weak when any system-quality gate fails', () => {
    for (const input of [
      { ...mature, profitFactor: 1.1499 },
      { ...mature, sharpe: 0.9999 },
      { ...mature, maxDrawdown: 0.1201 },
      { ...mature, netR: 0 },
    ]) {
      expect(evaluatePaperResearchRequalificationEvidence(input)).toMatchObject({
        state: 'WEAK',
        reason: 'FRESH_EDGE_NOT_RECOVERED',
      });
    }
  });

  it('treats a mature zero-loss positive cohort as PF-passing without inventing a finite profit factor', () => {
    expect(
      evaluatePaperResearchRequalificationEvidence({
        ...mature,
        wins: 8,
        losses: 0,
        profitFactor: null,
        netR: 8,
      }),
    ).toMatchObject({
      state: 'RECOVERY_SIGNAL',
      reason: 'FRESH_EDGE_RECOVERY_SIGNAL',
    });
  });
});
