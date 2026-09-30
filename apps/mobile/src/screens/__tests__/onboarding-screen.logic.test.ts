import type { EligibilityStatusView } from '@irexpro/types/eligibility';
import {
  buildDisclosureAcceptance,
  buildProfileUpdate,
  destinationForOnboardingStep,
  disclosuresAreSelectable,
} from '../onboarding-screen.logic';

const HASH = 'a'.repeat(64);
const FINGERPRINT = 'b'.repeat(64);

function eligibility(overrides: Partial<EligibilityStatusView> = {}): EligibilityStatusView {
  return {
    policyVersion: 'policy-1',
    policyFingerprint: FINGERPRINT,
    countryCode: 'GH',
    jurisdictionStatus: 'ELIGIBLE',
    decisionSource: 'POLICY',
    reasonCode: 'ALLOWED_COUNTRY',
    reviewedAt: null,
    ageStatus: 'ADULT',
    kycStatus: 'APPROVED',
    identityReasonCode: 'KYC_APPROVED',
    disclosures: [
      {
        key: 'AUTOMATED_TRADING_RISK',
        version: '1',
        title: 'Automated trading risk',
        body: 'Risk disclosure',
        contentSha256: HASH,
        required: true,
      },
      {
        key: 'NO_PROFIT_GUARANTEE',
        version: '1',
        title: 'No profit guarantee',
        body: 'No guarantee disclosure',
        contentSha256: 'c'.repeat(64),
        required: true,
      },
      {
        key: 'BROKER_EXECUTION_AUTHORITY',
        version: '1',
        title: 'Broker execution authority',
        body: 'Broker authority disclosure',
        contentSha256: 'd'.repeat(64),
        required: true,
      },
      {
        key: 'LEGAL_ELIGIBILITY_ATTESTATION',
        version: '1',
        title: 'Legal eligibility',
        body: 'Legal eligibility disclosure',
        contentSha256: 'e'.repeat(64),
        required: true,
      },
    ],
    consents: [],
    missingConsentKeys: [
      'AUTOMATED_TRADING_RISK',
      'NO_PROFIT_GUARANTEE',
      'BROKER_EXECUTION_AUTHORITY',
      'LEGAL_ELIGIBILITY_ATTESTATION',
    ],
    canProceed: false,
    ...overrides,
  };
}

describe('native onboarding pure logic', () => {
  test('normalizes a valid profile request', () => {
    expect(
      buildProfileUpdate({
        firstName: ' Christian ',
        lastName: ' Agbotah ',
        dateOfBirth: '1987-01-02',
        countryCode: ' gh ',
        timezone: ' Africa/Accra ',
        preferredCurrency: ' usd ',
      }),
    ).toEqual({
      body: {
        firstName: 'Christian',
        lastName: 'Agbotah',
        dateOfBirth: '1987-01-02',
        countryCode: 'GH',
        timezone: 'Africa/Accra',
        preferredCurrency: 'USD',
      },
    });
  });

  test.each([
    ['bad DOB', { dateOfBirth: '02/01/1987' }, 'YYYY-MM-DD'],
    ['bad country', { countryCode: 'GHA' }, 'two-letter country code'],
    ['bad currency', { preferredCurrency: 'US' }, 'three-letter currency code'],
    ['empty timezone', { timezone: ' ' }, 'Timezone is required'],
  ])('%s fails closed', (_label, override, fragment) => {
    const result = buildProfileUpdate({
      firstName: '',
      lastName: '',
      dateOfBirth: '1987-01-02',
      countryCode: 'GH',
      timezone: 'Africa/Accra',
      preferredCurrency: 'USD',
      ...override,
    });
    expect(result.error).toContain(fragment);
  });

  test.each([
    ['PROFILE', 'profile-onboarding'],
    ['ELIGIBILITY', 'eligibility-onboarding'],
    ['BROKER_CONNECTION', 'brokers'],
    ['READY', null],
  ] as const)('routes %s to the expected native destination', (step, expected) => {
    expect(destinationForOnboardingStep(step)).toBe(expected);
  });

  test('builds exact disclosure evidence from current server contract', () => {
    const status = eligibility();
    const selected = new Set(status.missingConsentKeys);
    const result = buildDisclosureAcceptance(status, selected);
    expect(result.error).toBeUndefined();
    expect(result.body).toEqual({
      policyVersion: 'policy-1',
      policyFingerprint: FINGERPRINT,
      acceptances: status.disclosures.map((item) => ({
        key: item.key,
        version: item.version,
        contentSha256: item.contentSha256,
      })),
    });
  });

  test('refuses partial disclosure selection', () => {
    const result = buildDisclosureAcceptance(
      eligibility(),
      new Set(['AUTOMATED_TRADING_RISK']),
    );
    expect(result.error).toContain('every outstanding required disclosure');
  });

  test('refuses disclosure recording before adult-age gate passes', () => {
    const status = eligibility({ ageStatus: 'MISSING_DOB' });
    const result = buildDisclosureAcceptance(
      status,
      new Set(status.missingConsentKeys),
    );
    expect(result.error).toContain('adult-age requirement');
  });

  test('returns no mutation body when all current disclosures are already accepted', () => {
    const base = eligibility();
    const consents = base.disclosures.map((item) => ({
      policyVersion: base.policyVersion,
      policyFingerprint: base.policyFingerprint,
      key: item.key,
      version: item.version,
      contentSha256: item.contentSha256,
      acceptedAt: '2026-09-30T00:00:00.000Z',
    }));
    const status = eligibility({
      consents,
      missingConsentKeys: [],
      canProceed: true,
    });
    expect(buildDisclosureAcceptance(status, new Set())).toEqual({ body: null });
  });

  test('disclosures remain fail-closed for ineligible jurisdiction', () => {
    expect(disclosuresAreSelectable(eligibility())).toBe(true);
    expect(
      disclosuresAreSelectable(
        eligibility({ jurisdictionStatus: 'INELIGIBLE', canProceed: false }),
      ),
    ).toBe(false);
  });
});
