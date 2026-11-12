import { evaluateDemoPrimaryOnlyProbation } from './demo-primary-only-route-probation';

const primary = {
  enabled: true,
  primaryAuthorityPath: 'PRIMARY_PLAN_B',
  m5HandoffEligible: false,
  executableFallbackTier: null,
  extensionScoutExecutable: false,
};

describe('reversible DEMO-only entry-authority probation', () => {
  it('keeps legitimate primary authority while never granting it independently', () => {
    expect(evaluateDemoPrimaryOnlyProbation(primary)).toMatchObject({
      enabled: true,
      blocked: false,
      reason: 'PRIMARY_PLAN_B',
      chosenAuthorityPath: 'PRIMARY_PLAN_B',
      modifiesOpenPositions: false,
    });
  });
  it('blocks M5 handoff even when its own evidence is locally eligible', () => {
    expect(evaluateDemoPrimaryOnlyProbation({ ...primary, m5HandoffEligible: true })).toMatchObject(
      {
        blocked: true,
        chosenAuthorityPath: 'M5_EARLY_TRANSITION_HANDOFF',
      },
    );
  });
  it('blocks bootstrap and qualified continuation in probation', () => {
    for (const tier of ['BOOTSTRAP_CONTINUATION', 'QUALIFIED_CONTINUATION']) {
      expect(
        evaluateDemoPrimaryOnlyProbation({ ...primary, executableFallbackTier: tier }),
      ).toMatchObject({
        blocked: true,
        chosenAuthorityPath: tier,
      });
    }
  });
  it('blocks high-conviction rescue and extension scout unless promoted separately', () => {
    expect(
      evaluateDemoPrimaryOnlyProbation({
        ...primary,
        primaryAuthorityPath: 'HIGH_CONVICTION_RESCUE',
      }).blocked,
    ).toBe(true);
    expect(
      evaluateDemoPrimaryOnlyProbation({ ...primary, extensionScoutExecutable: true }).blocked,
    ).toBe(true);
    // Blocked primary admission is already non-executable, so probation
    // must not be reported as the veto that stopped that decision.
    expect(
      evaluateDemoPrimaryOnlyProbation({ ...primary, primaryAuthorityPath: 'BLOCKED' }),
    ).toMatchObject({
      enabled: true,
      blocked: false,
      reason: 'NO_EXECUTABLE_PATH',
      chosenAuthorityPath: 'BLOCKED',
    });
  });
  it('reports missing executable authority accurately, without changing fallback vetoes', () => {
    expect(
      evaluateDemoPrimaryOnlyProbation({ ...primary, primaryAuthorityPath: null }),
    ).toMatchObject({
      blocked: false,
      chosenAuthorityPath: 'UNKNOWN',
      reason: 'NO_EXECUTABLE_PATH',
    });
    expect(
      evaluateDemoPrimaryOnlyProbation({
        ...primary,
        primaryAuthorityPath: 'BLOCKED',
        extensionScoutExecutable: true,
      }),
    ).toMatchObject({
      blocked: true,
      chosenAuthorityPath: 'EXTENSION_EXHAUSTION_DEMO_SCOUT',
      reason: 'FALLBACK_ROUTE_IN_PROBATION',
    });
  });

  const qualifiedAfterFee = {
    sampleCount: 7,
    netWins: 5,
    averageNetR: 0.274286,
    recentNetR: 0.42,
    complete: true,
  };
  const qualified = {
    eligible: true,
    reason: 'POSITIVE_EXPECTANCY',
    samples: 7,
    wins: 5,
    averageRealizedR: 0.3942857,
    recentRealizedR: 0.78,
  };

  it('removes only the redundant probation veto for a mature positive owner-bound DEMO continuation', () => {
    const decision=evaluateDemoPrimaryOnlyProbation({
      ...primary,
      primaryAuthorityPath: 'BLOCKED',
      executableFallbackTier: 'QUALIFIED_CONTINUATION',
      qualifiedContinuationEvidence: qualified,
      afterCommissionEvidence: qualifiedAfterFee,
      brokerAccountIsDemo: true,
      genuineRollover: false,
    });
    expect(decision).toMatchObject({
      blocked: false,
      qualifiedContinuationCanary: true,
      chosenAuthorityPath: 'QUALIFIED_CONTINUATION',
      reason: 'QUALIFIED_CONTINUATION_CANARY',
      modifiesOpenPositions: false,
    });
  });

  it('denies an otherwise qualified trial in the hour before NY rollover', () => {
    const decision=evaluateDemoPrimaryOnlyProbation({
      ...primary,
      primaryAuthorityPath:'BLOCKED',
      executableFallbackTier:'QUALIFIED_CONTINUATION',
      qualifiedContinuationEvidence:qualified,
      afterCommissionEvidence:qualifiedAfterFee,
      brokerAccountIsDemo:true,
      genuineRollover:false,
      preRolloverRiskWindow:true,
    });
    expect(decision).toMatchObject({
      blocked:true,
      qualifiedContinuationCanary:false,
      chosenAuthorityPath:'QUALIFIED_CONTINUATION',
      reason:'FALLBACK_ROUTE_IN_PROBATION',
      modifiesOpenPositions:false,
    });
  });

  it('denies the exemption for LIVE, unknown account, rollover, thin or negative sleeves', () => {
    const base = {
      ...primary,
      primaryAuthorityPath: 'BLOCKED',
      executableFallbackTier: 'QUALIFIED_CONTINUATION',
      qualifiedContinuationEvidence: qualified,
      afterCommissionEvidence: qualifiedAfterFee,
      brokerAccountIsDemo: true,
      genuineRollover: false,
    };
    for (const patch of [
      {afterCommissionEvidence: null},
      {afterCommissionEvidence: {...qualifiedAfterFee, complete: false}},
      {afterCommissionEvidence: {...qualifiedAfterFee, sampleCount: 6}},
      {afterCommissionEvidence: {...qualifiedAfterFee, netWins: 4}},
      {afterCommissionEvidence: {...qualifiedAfterFee, averageNetR: -0.1}},
      {afterCommissionEvidence: {...qualifiedAfterFee, recentNetR: -0.1}},
      {brokerAccountIsDemo: false},
      {brokerAccountIsDemo: undefined},
      {genuineRollover: true},
      {qualifiedContinuationEvidence: {...qualified, samples: 6}},
      {qualifiedContinuationEvidence: {...qualified, wins: 4}},
      {qualifiedContinuationEvidence: {...qualified, recentRealizedR: -0.1}},
      {qualifiedContinuationEvidence: {...qualified, averageRealizedR: -0.1}},
      {qualifiedContinuationEvidence: {...qualified, reason: 'PROFIT_GIVEBACK_CAUTION'}},
      {executableFallbackTier: 'BOOTSTRAP_CONTINUATION'},
      {executableFallbackTier: 'QUALIFIED'},
      {extensionScoutExecutable: true, executableFallbackTier: null},
    ]) {
      const d=evaluateDemoPrimaryOnlyProbation({...base,...patch});
      expect(d.blocked).toBe(true);
      expect(d.qualifiedContinuationCanary).toBe(false);
    }
  });

  it('is fully inactive for prior rollout policies and never modifies open positions', () => {
    expect(
      evaluateDemoPrimaryOnlyProbation({ ...primary, enabled: false, m5HandoffEligible: true }),
    ).toMatchObject({
      enabled: false,
      blocked: false,
      reason: 'NOT_ENFORCED',
      modifiesOpenPositions: false,
    });
  });
});
