import {
  DEMO_DOUBLE_ABSTAIN_UNCALIBRATED_OOD,
  DemoDoubleAbstainAdmissionInput,
  evaluateDemoDoubleAbstainAdmission,
} from './demo-double-abstain-admission';

const asOfWeakDemo: DemoDoubleAbstainAdmissionInput = {
  verifiedPepperstoneDemo: true,
  professionalDemoPhase: true,
  professionalM1Fallback: false,
  m1Route: 'ABSTAIN',
  independentExpertState: 'ABSTAIN',
  matchedExpectancySamples: 0,
  driftOutOfDistribution: true,
  independentGovernanceEligible: false,
};

describe('DEMO double-abstain admission at original entry timestamp', () => {
  it('abstains on the exact USDCAD, USDJPY and EURUSD loss cohort evidence without hindsight outcomes', () => {
    expect(evaluateDemoDoubleAbstainAdmission(asOfWeakDemo)).toEqual({
      allowed: false, reason: DEMO_DOUBLE_ABSTAIN_UNCALIBRATED_OOD,
    });
  });
  it('also abstains on a historically profitable EURUSD signal with identical as-of weakness, exposing false rejects', () => {
    expect(evaluateDemoDoubleAbstainAdmission(asOfWeakDemo).allowed).toBe(false);
  });
  it.each([
    ['other broker or LIVE', { verifiedPepperstoneDemo: false }],
    ['nonprofessional research', { professionalDemoPhase: false }],
    ['approved M1 fallback', { professionalM1Fallback: true }],
    ['M1 specialist approval', { m1Route: 'M1_EARLY_TRANSITION' }],
    ['independent expert confirms direction', { independentExpertState: 'BUY' }],
    ['model inside its supported distribution', { driftOutOfDistribution: false }],
    ['historically supported statistical expectancy', { matchedExpectancySamples: 11 }],
    ['independent governance genuinely admits', { independentGovernanceEligible: true }],
    ['unknown evidence does not impersonate explicit zero', { matchedExpectancySamples: null }],
  ])('does not invent a prohibition when %s', (_label, override) => {
    expect(evaluateDemoDoubleAbstainAdmission({ ...asOfWeakDemo, ...override }).allowed).toBe(true);
  });
});
