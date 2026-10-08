import { buildEnsembleExpertRegistry } from './ensemble-expert-registry';

describe('buildEnsembleExpertRegistry', () => {
  it('distinguishes trained models from policies, guards and frozen baselines', () => {
    const registry = buildEnsembleExpertRegistry({
      highConvictionArtifact: 'plan-b-v4-oof-three-expert-consensus-challenger',
      highConvictionLoaded: true,
      highConvictionBrokerDataReady: false,
      postEntryArtifactReady: true,
      postEntryBrokerDataReady: false,
      postEntryShadowObservations: 0,
      macroEventConfigured: false,
      sleeveResolvedOutcomes: 0,
      legacyBaselineFrozen: true,
    });

    expect(registry.policy).toBe('EXPLICIT_PROVENANCE_V1');
    expect(registry.trainedModelCount).toBe(2);
    expect(registry.heuristicPolicyCount).toBe(3);
    expect(registry.riskGuardCount).toBe(4);
    expect(registry.frozenBaselineCount).toBe(1);

    const trained = registry.entries.find((entry) => entry.code === 'plan-b-v4-high-conviction');
    expect(trained).toMatchObject({
      kind: 'TRAINED_MODEL',
      trained: true,
      lifecycle: 'WAITING_FOR_DATA',
      executionAuthority: 'NONE',
      modifiesExecution: false,
    });

    const policy = registry.entries.find((entry) => entry.code === 'plan-b-multimodel-shadow-v4');
    expect(policy).toMatchObject({
      kind: 'HEURISTIC_POLICY',
      trained: false,
      lifecycle: 'SHADOW',
    });

    const baseline = registry.entries.find((entry) => entry.code === 'legacy-v7-baseline');
    expect(baseline?.lifecycle).toBe('FROZEN');
  });

  it('exposes the PAPER-only early-transition policy as an explicit expert route', () => {
    const registry = buildEnsembleExpertRegistry({
      highConvictionArtifact: null,
      highConvictionLoaded: false,
      highConvictionBrokerDataReady: false,
      postEntryArtifactReady: false,
      postEntryBrokerDataReady: false,
      postEntryShadowObservations: 0,
      macroEventConfigured: true,
      sleeveResolvedOutcomes: 0,
      legacyBaselineFrozen: true,
    });
    const transition = registry.entries.find(
      (entry) => entry.code === 'early-transition-paper-policy',
    );
    expect(transition).toMatchObject({
      kind: 'HEURISTIC_POLICY',
      lifecycle: 'COLLECTING',
      trained: false,
      executionAuthority: 'NONE',
      modifiesExecution: false,
      artifact:
        'plan-b-multimodel-shadow-v4-bidirectional-v2-early-transition-v3-neutral-meta-momentum-v1',
      prospectiveEvidenceRequired: true,
    });
  });

  it('promotes only lifecycle labels when required data/evidence becomes available', () => {
    const registry = buildEnsembleExpertRegistry({
      highConvictionArtifact: 'plan-b-v4-oof-three-expert-consensus-challenger',
      highConvictionLoaded: true,
      highConvictionBrokerDataReady: true,
      postEntryArtifactReady: true,
      postEntryBrokerDataReady: true,
      postEntryShadowObservations: 12,
      macroEventConfigured: true,
      sleeveResolvedOutcomes: 100,
      legacyBaselineFrozen: true,
    });

    expect(
      registry.entries.find((entry) => entry.code === 'plan-b-v4-high-conviction')?.lifecycle,
    ).toBe('READY_ARTIFACT');
    expect(
      registry.entries.find((entry) => entry.code === 'plan-b-v85-post-entry')?.lifecycle,
    ).toBe('COLLECTING');
    expect(
      registry.entries.find((entry) => entry.code === 'macro-event-risk-guard')?.lifecycle,
    ).toBe('ACTIVE_GUARD');
    expect(
      registry.entries.find((entry) => entry.code === 'drift-sleeve-health-guard')?.lifecycle,
    ).toBe('ACTIVE_GUARD');

    expect(registry.entries.every((entry) => entry.executionAuthority === 'NONE')).toBe(true);
  });
});
