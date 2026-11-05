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
    expect(
      evaluateDemoPrimaryOnlyProbation({ ...primary, primaryAuthorityPath: 'BLOCKED' }).blocked,
    ).toBe(true);
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
