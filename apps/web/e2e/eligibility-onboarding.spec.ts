import { test, expect, type Page } from '@playwright/test';
import {
  assertNoConsoleErrors,
  assertNoExternalRequests,
  assertNoFailedRequests,
  assertNoHorizontalOverflow,
  mockAuthTokens,
  mockAuthUser,
  setupErrorCollectors,
} from './fixtures';

const POLICY_VERSION = 'eligibility.2026-09';
const POLICY_FINGERPRINT = 'f'.repeat(64);

const disclosureDefinitions = [
  {
    key: 'AUTOMATED_TRADING_RISK',
    version: '1.0',
    title: 'Automated trading risk',
    body: 'Automated decisions can result in financial loss and controls cannot eliminate market risk.',
    contentSha256: 'a'.repeat(64),
    required: true,
  },
  {
    key: 'NO_PROFIT_GUARANTEE',
    version: '1.0',
    title: 'No profit guarantee',
    body: 'Historical research and prior results do not guarantee future profits or prevent losses.',
    contentSha256: 'b'.repeat(64),
    required: true,
  },
  {
    key: 'BROKER_EXECUTION_AUTHORITY',
    version: '1.0',
    title: 'Broker execution authority',
    body: 'Any separately enabled execution remains subject to platform controls and broker acceptance.',
    contentSha256: 'c'.repeat(64),
    required: true,
  },
  {
    key: 'LEGAL_ELIGIBILITY_ATTESTATION',
    version: '1.0',
    title: 'Age and legal eligibility attestation',
    body: 'I confirm that I am at least 18 years old, have the legal capacity to enter into this agreement, and am legally permitted to use automated trading services in the jurisdiction associated with my account.',
    contentSha256: 'd'.repeat(64),
    required: true,
  },
] as const;

function consentRows(prefix = '09') {
  return disclosureDefinitions.map((item, index) => ({
    policyVersion: POLICY_VERSION,
    policyFingerprint: POLICY_FINGERPRINT,
    key: item.key,
    version: item.version,
    contentSha256: item.contentSha256,
    acceptedAt: `2026-09-01T${prefix}:0${index}:00.000Z`,
  }));
}

const eligibleStatus = {
  policyVersion: POLICY_VERSION,
  policyFingerprint: POLICY_FINGERPRINT,
  countryCode: 'GH',
  jurisdictionStatus: 'ELIGIBLE',
  decisionSource: 'POLICY',
  reasonCode: 'POLICY_ALLOWED',
  reviewedAt: null,
  ageStatus: 'ADULT',
  kycStatus: 'APPROVED',
  identityReasonCode: 'IDENTITY_APPROVED',
  disclosures: disclosureDefinitions,
  consents: [],
  missingConsentKeys: disclosureDefinitions.map((item) => item.key),
  canProceed: false,
};

const reviewRequiredAfterConsent = {
  ...eligibleStatus,
  countryCode: 'NG',
  jurisdictionStatus: 'REVIEW_REQUIRED',
  reasonCode: 'POLICY_REVIEW_REQUIRED',
  consents: consentRows(),
  missingConsentKeys: [],
  canProceed: false,
};

function fulfill(route: Parameters<Parameters<Page['route']>[1]>[0], status: number, body: unknown) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

async function installEligibilityRoutes(
  page: Page,
  options: {
    initialStatus?: unknown;
    acceptedStatus?: unknown;
    acceptanceStatusCode?: number;
    onAcceptance?: (body: unknown) => void;
  } = {},
) {
  await page.route('**/api/v1/**', (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const apiPath = url.pathname.split('/api/v1/')[1] ?? '';

    if (apiPath === 'auth/refresh') return fulfill(route, 200, mockAuthTokens);
    if (apiPath === 'auth/me') return fulfill(route, 200, mockAuthUser);
    if (apiPath === 'auth/logout') return fulfill(route, 200, { message: 'Logged out' });
    if (apiPath === 'users/me/eligibility' && request.method() === 'GET') {
      return fulfill(route, 200, options.initialStatus ?? eligibleStatus);
    }
    if (apiPath === 'users/me/eligibility/disclosures' && request.method() === 'POST') {
      const body = request.postDataJSON();
      options.onAcceptance?.(body);
      return fulfill(
        route,
        options.acceptanceStatusCode ?? 200,
        options.acceptedStatus ?? reviewRequiredAfterConsent,
      );
    }
    return fulfill(route, 200, {});
  });
}

test.describe('Sprint 46 policy-bound eligibility onboarding gate', () => {
  test('renders server-authoritative policy, identity, and jurisdiction readiness without internal identifiers', async ({ page }) => {
    setupErrorCollectors(page);
    await installEligibilityRoutes(page);

    await page.goto('/onboarding/eligibility');

    await expect(page.getByRole('heading', { level: 1, name: 'Eligibility & disclosures' })).toBeVisible();
    await expect(page.getByText('Step 2 of 4', { exact: true })).toBeVisible();
    await expect(page.getByText(/eligibility\.2026-09/)).toBeVisible();
    await expect(page.getByText(/Policy fingerprint:/)).toBeVisible();
    await expect(page.getByText(new RegExp(`${POLICY_FINGERPRINT.slice(0, 12)}…`))).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'Identity review approved' })).toBeVisible();
    await expect(page.getByText('4 disclosures outstanding', { exact: true })).toBeVisible();
    await expect(page.getByText(/policy change requires fresh evidence/i)).toBeVisible();

    for (const disclosure of disclosureDefinitions) {
      await expect(page.getByText(disclosure.title, { exact: true })).toBeVisible();
    }
    await expect(page.getByText(/at least 18 years old/i)).toBeVisible();

    await expect(page.getByText('reviewerNote', { exact: false })).toHaveCount(0);
    await expect(page.getByText('brokerConnectionId', { exact: false })).toHaveCount(0);
    await expect(page.getByText('providerAccountId', { exact: false })).toHaveCount(0);
    await expect(page.getByText('passwordHash', { exact: false })).toHaveCount(0);

    await assertNoHorizontalOverflow(page);
    assertNoConsoleErrors(page);
    assertNoFailedRequests(page);
    assertNoExternalRequests(page);
  });

  test('submits exact policy fingerprint and disclosure evidence but remains blocked when jurisdiction review remains', async ({ page }) => {
    setupErrorCollectors(page);
    let submittedBody: unknown;
    await installEligibilityRoutes(page, {
      initialStatus: {
        ...eligibleStatus,
        countryCode: 'NG',
        jurisdictionStatus: 'REVIEW_REQUIRED',
        reasonCode: 'POLICY_REVIEW_REQUIRED',
      },
      acceptedStatus: reviewRequiredAfterConsent,
      onAcceptance: (body) => {
        submittedBody = body;
      },
    });

    await page.goto('/onboarding/eligibility');
    const checkboxes = page.getByRole('checkbox');
    await expect(checkboxes).toHaveCount(4);
    for (let index = 0; index < 4; index += 1) {
      await checkboxes.nth(index).check();
    }

    await page.getByRole('button', { name: 'Accept required disclosures' }).click();

    await expect(page.getByText('Disclosures complete', { exact: true })).toBeVisible();
    await expect(page.getByText('Readiness blocked', { exact: true })).toBeVisible();
    await expect(page.getByText(/jurisdiction review is still required/i)).toBeVisible();
    await expect(page).toHaveURL(/\/onboarding\/eligibility$/);

    expect(submittedBody).toEqual({
      policyVersion: POLICY_VERSION,
      policyFingerprint: POLICY_FINGERPRINT,
      acceptances: disclosureDefinitions.map((item) => ({
        key: item.key,
        version: item.version,
        contentSha256: item.contentSha256,
      })),
    });

    assertNoConsoleErrors(page);
    assertNoFailedRequests(page);
    assertNoExternalRequests(page);
  });

  test('shows the safe actionable error and keeps evidence unaccepted when the server rejects a stale policy snapshot', async ({ page }) => {
    setupErrorCollectors(page);
    const stalePolicyMessage =
      'Eligibility policy changed. Refresh the current disclosures before recording consent.';
    await installEligibilityRoutes(page, {
      acceptanceStatusCode: 400,
      acceptedStatus: {
        statusCode: 400,
        message: stalePolicyMessage,
        error: 'Bad Request',
      },
    });

    await page.goto('/onboarding/eligibility');
    const checkboxes = page.getByRole('checkbox');
    for (let index = 0; index < 4; index += 1) {
      await checkboxes.nth(index).check();
    }
    await page.getByRole('button', { name: 'Accept required disclosures' }).click();

    await expect(page.getByRole('alert').filter({ hasText: stalePolicyMessage }).first()).toBeVisible();
    await expect(page.getByText(/something went wrong/i)).toHaveCount(0);
    await expect(page.getByText('4 disclosures outstanding', { exact: true })).toBeVisible();
    await expect(page.getByText('Disclosures complete', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Continue to next step' })).toHaveCount(0);

    // The mocked HTTP 400 is the expected fail-closed behavior for this test.
    // Chromium logs the intentional rejected request as a console error, so
    // this scenario verifies the rendered safe actionable error instead of
    // requiring a zero-error network console.
    assertNoExternalRequests(page);
  });

  test('blocks an under-18 status and disables disclosure acceptance', async ({ page }) => {
    setupErrorCollectors(page);
    await installEligibilityRoutes(page, {
      initialStatus: {
        ...eligibleStatus,
        ageStatus: 'UNDER_18',
        kycStatus: 'NONE',
        identityReasonCode: 'AGE_REQUIREMENT_NOT_MET',
        canProceed: false,
      },
    });

    await page.goto('/onboarding/eligibility');

    await expect(page.getByRole('heading', { level: 2, name: 'Adult-age requirement not met' })).toBeVisible();
    await expect(page.getByText(/restricted to adults age 18 or older/i)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Accept required disclosures' })).toHaveCount(0);
    for (const checkbox of await page.getByRole('checkbox').all()) {
      await expect(checkbox).toBeDisabled();
    }
    await expect(page.getByRole('button', { name: 'Continue to next step' })).toHaveCount(0);

    assertNoConsoleErrors(page);
    assertNoFailedRequests(page);
    assertNoExternalRequests(page);
  });

  test('keeps an adult account blocked while KYC is pending even with all policy-bound disclosures accepted', async ({ page }) => {
    setupErrorCollectors(page);
    await installEligibilityRoutes(page, {
      initialStatus: {
        ...eligibleStatus,
        kycStatus: 'PENDING',
        identityReasonCode: 'KYC_PENDING',
        consents: consentRows('10'),
        missingConsentKeys: [],
        canProceed: false,
      },
    });

    await page.goto('/onboarding/eligibility');

    await expect(page.getByRole('heading', { level: 2, name: 'KYC review pending' })).toBeVisible();
    await expect(page.getByText('Disclosures complete', { exact: true })).toBeVisible();
    await expect(page.getByText('Readiness blocked', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Continue to next step' })).toHaveCount(0);

    assertNoConsoleErrors(page);
    assertNoFailedRequests(page);
    assertNoExternalRequests(page);
  });

  test('fails closed when consent evidence is bound to a different policy fingerprint', async ({ page }) => {
    setupErrorCollectors(page);
    await installEligibilityRoutes(page, {
      initialStatus: {
        ...eligibleStatus,
        consents: consentRows().map((item) => ({ ...item, policyFingerprint: 'e'.repeat(64) })),
        missingConsentKeys: [],
        canProceed: true,
      },
    });

    await page.goto('/onboarding/eligibility');

    await expect(page.getByRole('heading', { level: 2, name: 'Eligibility unavailable' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Continue to next step' })).toHaveCount(0);
    await expect(page.getByText(/frontend-safe contract verification/i)).toHaveCount(0);

    assertNoConsoleErrors(page);
    assertNoFailedRequests(page);
    assertNoExternalRequests(page);
  });

  test('fails closed when the browser contract unexpectedly broadens', async ({ page }) => {
    setupErrorCollectors(page);
    await installEligibilityRoutes(page, {
      initialStatus: { ...eligibleStatus, reviewerNote: 'must-never-reach-the-browser-contract' },
    });

    await page.goto('/onboarding/eligibility');

    await expect(page.getByRole('heading', { level: 2, name: 'Eligibility unavailable' })).toBeVisible();
    await expect(page.getByRole('alert').filter({ hasText: /something went wrong/i })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Accept required disclosures' })).toHaveCount(0);
    await expect(page.getByText('must-never-reach-the-browser-contract', { exact: false })).toHaveCount(0);
    await expect(page.getByText(/frontend-safe contract verification/i)).toHaveCount(0);

    assertNoConsoleErrors(page);
    assertNoFailedRequests(page);
    assertNoExternalRequests(page);
  });

  test('has no horizontal overflow across nine target viewports', async ({ page }) => {
    setupErrorCollectors(page);
    await installEligibilityRoutes(page);

    const viewports = [
      { width: 320, height: 568 },
      { width: 360, height: 800 },
      { width: 375, height: 667 },
      { width: 390, height: 844 },
      { width: 430, height: 932 },
      { width: 768, height: 1024 },
      { width: 1024, height: 768 },
      { width: 1366, height: 768 },
      { width: 1440, height: 900 },
    ];

    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      await page.goto('/onboarding/eligibility');
      await expect(page.getByRole('heading', { level: 1, name: 'Eligibility & disclosures' })).toBeVisible();
      await assertNoHorizontalOverflow(page);
    }

    assertNoConsoleErrors(page);
    assertNoFailedRequests(page);
    assertNoExternalRequests(page);
  });
});
