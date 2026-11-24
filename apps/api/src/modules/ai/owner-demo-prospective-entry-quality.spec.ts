import { evaluateOwnerDemoProspectiveEntryQuality } from './owner-demo-prospective-entry-quality';
const example = {
  enabled: true,
  exactOwnerPepperstoneUsdDemoVerified: true,
  decisionAt: new Date('2026-11-24T09:21:10Z'),
  instrument: 'USDJPY',
  direction: 'SELL' as const,
  route: 'ABSTAIN',
  strategyRoute: 'CONFIRMED_REVERSAL',
  expertState: 'ABSTAIN',
  paperExpectancySamples: 0,
  entryConfidence: 0.73,
  m5Aligned: 0.2,
  m30DirectionalEfficiency: 0.1,
  h4Aligned: 0.5,
  originalAdmissionBlockers: ['DRIFT_OUT_OF_DISTRIBUTION', 'ENSEMBLE_NOT_PAPER_ADMITTED'],
  professionalFallbackExecutionEnabled: false,
};
describe('prospective entry quality: never opens, vetoes or sizes orders', () => {
  it('captures original double-abstain and both positive signs without granting authority', () => {
    expect(evaluateOwnerDemoProspectiveEntryQuality(example)).toMatchObject({
      status: 'ACTIVE_SHADOW',
      candidateWouldMatchOriginalHeldDoubleAbstain: true,
      alignmentGroup: 'M5_M30_BOTH_SUPPORT',
      researchOnly: true,
      modifiesAdmission: false,
      modifiesExecution: false,
      modifiesRiskOrLotSize: false,
      grantsLiveOrderAuthority: false,
      decisionTime: '2026-11-24T09:21:10.000Z',
    });
  });
  it('does not interpret zero or absent expert evidence as permission to trade', () => {
    expect(
      evaluateOwnerDemoProspectiveEntryQuality({ ...example, paperExpectancySamples: null })
        .candidateWouldMatchOriginalHeldDoubleAbstain,
    ).toBe(false);
    expect(
      evaluateOwnerDemoProspectiveEntryQuality({ ...example, expertState: 'CONFIRM' })
        .candidateWouldMatchOriginalHeldDoubleAbstain,
    ).toBe(false);
  });
  it('never observes an unverified account or disabled flag', () => {
    expect(evaluateOwnerDemoProspectiveEntryQuality({ ...example, enabled: false })).toMatchObject({
      status: 'DISABLED',
      evidence: null,
    });
    expect(
      evaluateOwnerDemoProspectiveEntryQuality({
        ...example,
        exactOwnerPepperstoneUsdDemoVerified: false,
      }),
    ).toMatchObject({ status: 'SCOPE_UNVERIFIED', evidence: null });
  });
  it('abstains when M5/M30 are missing, rather than assuming zero aligns', () => {
    expect(evaluateOwnerDemoProspectiveEntryQuality({ ...example, m5Aligned: null })).toMatchObject(
      { status: 'FEATURES_MISSING', alignmentGroup: 'UNKNOWN' },
    );
  });
  it('tracks mixed and adverse evidence without rejecting the order', () => {
    const adverse = evaluateOwnerDemoProspectiveEntryQuality({
      ...example,
      m5Aligned: -0.2,
      m30DirectionalEfficiency: -0.1,
    });
    expect(adverse.alignmentGroup).toBe('M5_M30_BOTH_ADVERSE');
    expect(adverse.modifiesAdmission).toBe(false);
    expect(
      evaluateOwnerDemoProspectiveEntryQuality({ ...example, m5Aligned: -0.2 }).alignmentGroup,
    ).toBe('M5_M30_DISAGREE');
  });
});
