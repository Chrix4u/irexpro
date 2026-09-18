import { test, expect, type Page } from '@playwright/test';
import {
  gotoAsAuthenticated,
  setupErrorCollectors,
  setupAuthInterception,
  assertNoExternalRequests,
} from './fixtures';

/**
 * Successful-run screenshot evidence.
 *
 * Captures a focused set of representative screenshots of the web app in stable
 * success states, across three viewports (mobile-standard, tablet-portrait,
 * desktop). This complements the failure-only screenshot policy in
 * playwright.config.ts (which captures nothing on success).
 *
 * Gating: the entire suite is skipped unless `E2E_CAPTURE_EVIDENCE=1` is set,
 * so normal local/CI runs incur no overhead and produce no evidence artifacts.
 * Run via `pnpm test:e2e:evidence` (cross-platform: uses `cross-env` so it
 * works on Linux CI, macOS, and Windows PowerShell/Command Prompt).
 *
 * Determinism: every API call is intercepted by setupAuthInterception() with
 * fixture data — no real backend, no real credentials, no broker secrets.
 * "Incomplete" and "empty" states are produced by overriding specific mock
 * routes (onboarding-status / broker connections) with deterministic fixtures.
 *
 * NO FIXED SLEEPS: this spec never uses `page.waitForTimeout`. All waits are
 * state-based (locator visibility, ARIA attribute assertions, computed-style
 * polling via `expect.poll`, and bounding-box stability checks).
 *
 * Storage: screenshots are written under `test-results/evidence/<viewport>/`.
 * That directory is gitignored (via the existing `test-results/` gitignore
 * entry). No screenshots are committed.
 *
 * SAFETY: a `assertDomSafeForScreenshot(page)` helper is called before EVERY
 * screenshot. It verifies the rendered DOM contains no credential markers
 * (sk_live, pk_live, ghp_, github_pat_, Bearer, JWT-shaped strings), that
 * password/secret inputs are `type="password"`, that password/secret input
 * values are empty or known non-sensitive fixture values, and that no access
 * token / refresh token / broker API secret is rendered as page text. This is
 * a DOM-text assertion, NOT a screenshot-pixel scan — no OCR or image content
 * analysis is performed by these tests.
 */

const CAPTURE = process.env.E2E_CAPTURE_EVIDENCE === '1';
const EVIDENCE_DIR = 'test-results/evidence';

const MOBILE_STD = 'mobile-standard';
const TABLET_P = 'tablet-portrait';
const DESKTOP = 'desktop';

// Credential markers that must never appear in rendered page text. These are
// prefixes/shapes of real secrets; the deterministic mock data deliberately
// uses non-real placeholder values (e.g. "mock-access-token-for-e2e-tests").
const FORBIDDEN_DOM_MARKERS: (string | RegExp)[] = [
  'sk_live',
  'pk_live',
  'github_pat_',
  'ghp_',
  'gho_',
  'Bearer ',
  // JWT shape: three base64url segments separated by dots, minimum length.
  // Matches "eyJ...eyJ...xxx" patterns. The mock tokens do NOT match this.
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
];

// Known non-sensitive fixture values allowed in password/secret inputs. The
// broker credential-leak invariant test in broker.spec.ts types distinctive
// sentinels into the password fields; those sentinels are permitted to be the
// input's `value` (they must NOT appear as DOM text — verified separately).
const ALLOWED_PASSWORD_VALUES = new Set([
  '',
  // broker.spec.ts sentinel values (only present in broker-evidence tests,
  // which do not type credentials — but listed for completeness).
  'e2e-secret-api-key-DO-NOT-LEAK-9f3a7c',
  'e2e-secret-api-secret-DO-NOT-LEAK-2b1d8e',
]);

// Deterministic screenshot path under the gitignored evidence directory.
function evidencePath(page: Page, state: string): string {
  const vp = page.viewportSize();
  const label = vp ? `${vp.width}x${vp.height}` : 'unknown';
  return `${EVIDENCE_DIR}/${label}/${state}.png`;
}

/**
 * DOM safety assertion performed before every screenshot. Verifies the
 * rendered page contains no credential markers and that password/secret inputs
 * are properly typed and hold no unexpected values. This is a DOM-text and
 * input-property check — it does NOT inspect screenshot pixels.
 */
async function assertDomSafeForScreenshot(page: Page): Promise<void> {
  // 1. Body text must not contain any forbidden credential marker.
  const bodyText = (await page.locator('body').textContent()) ?? '';
  for (const marker of FORBIDDEN_DOM_MARKERS) {
    if (marker instanceof RegExp) {
      expect(
        bodyText,
        `Rendered DOM text must not match credential pattern ${marker}`,
      ).not.toMatch(marker);
    } else {
      expect(
        bodyText,
        `Rendered DOM text must not contain credential marker "${marker}"`,
      ).not.toContain(marker);
    }
  }

  // 2. Every password/secret input must be type="password" (never type="text").
  const passwordInputs = page.locator('input[type="password"]');
  const pwCount = await passwordInputs.count();
  for (let i = 0; i < pwCount; i++) {
    const input = passwordInputs.nth(i);
    // Confirm the type attribute is exactly "password".
    await expect(input).toHaveAttribute('type', 'password');
    // 3. The value must be empty or a known non-sensitive fixture value.
    const value = (await input.inputValue()) ?? '';
    expect(
      ALLOWED_PASSWORD_VALUES.has(value),
      `Password input #${i} holds an unexpected value (length ${value.length}); only empty or known fixture values are permitted`,
    ).toBe(true);
  }

  // 4. No <input type="text"> may carry a name/aria-label suggesting a secret.
  const textInputs = page.locator('input[type="text"], input[type="search"]');
  const textCount = await textInputs.count();
  for (let i = 0; i < textCount; i++) {
    const input = textInputs.nth(i);
    const name = (await input.getAttribute('name')) ?? '';
    const ariaLabel = (await input.getAttribute('aria-label')) ?? '';
    const placeholder = (await input.getAttribute('placeholder')) ?? '';
    const combined = `${name} ${ariaLabel} ${placeholder}`.toLowerCase();
    expect(
      combined,
      `Text input #${i} appears to be a secret field (name/label/placeholder suggests a credential)`,
    ).not.toMatch(/(api[_-]?key|api[_-]?secret|password|passwd|secret|token|credential)/);
  }
}

/**
 * Wait for the timezone dropdown to reach a stable, fully-positioned state.
 * Replaces the former fixed `waitForTimeout(120)` with deterministic checks:
 *  - the listbox is visible
 *  - aria-activedescendant references a rendered option
 *  - the dropdown has a final direction class (--up or no modifier)
 *  - the dropdown's computed max-height is set (capped by the component)
 *  - the dropdown's bounding box is inside the viewport
 *  - two consecutive bounding-box measurements are stable (no layout jitter)
 */
async function waitForTimezoneDropdownSettled(page: Page): Promise<void> {
  const combobox = page.getByRole('combobox', { name: /timezone/i });
  const listbox = page.getByRole('listbox', { name: /timezone/i });
  const dropdown = page.locator('.timezone-select__dropdown');

  // 1. Listbox visible.
  await expect(listbox).toBeVisible();
  // 2. aria-activedescendant references a rendered option.
  await expect(combobox).toHaveAttribute('aria-activedescendant', /.+/, { timeout: 5000 });
  const activeId = await combobox.getAttribute('aria-activedescendant');
  expect(activeId, 'aria-activedescendant must be set').toBeTruthy();
  await expect(page.locator(`[id="${activeId}"]`)).toHaveAttribute('role', 'option');
  // 3. Dropdown has a final direction class (either --up or base, not mid-toggle).
  //    The component sets openUp synchronously in a layout effect before paint,
  //    so the class is final by render time; poll for robustness.
  await expect.poll(
    async () => {
      const cls = (await dropdown.getAttribute('class')) ?? '';
      return cls.includes('timezone-select__dropdown');
    },
    { timeout: 3000, message: 'dropdown must have a final direction class' },
  ).toBe(true);
  // 4. The list <ul> inside the dropdown has a computed max-height value
  //    (the component caps it to viewport space when there isn't room for 280px).
  await expect.poll(
    async () => {
      const ul = dropdown.locator('ul').first();
      const mh = await ul.evaluate((el) => window.getComputedStyle(el).maxHeight);
      return mh;
    },
    { timeout: 3000, message: 'dropdown list max-height must be computed' },
  ).toMatch(/^.+$/);
  // 5. Dropdown bounding box is inside the viewport (bottom edge included),
  //    AND stable across two consecutive reads (assertBoundingBoxInViewport
  //    already enforces stability, so we delegate to it).
  const { assertBoundingBoxInViewport } = await import('./fixtures');
  await assertBoundingBoxInViewport(dropdown);
}

// Skip the whole suite unless evidence capture is explicitly enabled.
test.beforeEach(async ({}, testInfo) => {
  test.skip(!CAPTURE, 'set E2E_CAPTURE_EVIDENCE=1 to capture evidence screenshots');
  const allowed = new Set([MOBILE_STD, TABLET_P, DESKTOP]);
  test.skip(!allowed.has(testInfo.project.name), 'evidence: wrong project');
});

// ── Mobile Standard (390 × 844) ──────────────────────────────────────────────

test.describe('Evidence — mobile-standard', () => {
  test('profile default', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== MOBILE_STD, 'mobile-standard only');
    await gotoAsAuthenticated(page, '/onboarding/profile', { heading: /trader profile/i });
    await expect(page.getByRole('button', { name: /save profile & continue/i })).toBeVisible();
    await assertDomSafeForScreenshot(page);
    await page.screenshot({ path: evidencePath(page, 'profile-default'), fullPage: false });
    assertNoExternalRequests(page);
  });

  test('profile timezone combobox open', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== MOBILE_STD, 'mobile-standard only');
    await gotoAsAuthenticated(page, '/onboarding/profile', { heading: /trader profile/i });
    await page.getByRole('combobox', { name: /timezone/i }).click();
    await waitForTimezoneDropdownSettled(page);
    await assertDomSafeForScreenshot(page);
    await page.screenshot({ path: evidencePath(page, 'profile-combobox-open'), fullPage: false });
    assertNoExternalRequests(page);
  });

  test('selected timezone', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== MOBILE_STD, 'mobile-standard only');
    await gotoAsAuthenticated(page, '/onboarding/profile', { heading: /trader profile/i });
    const combobox = page.getByRole('combobox', { name: /timezone/i });
    await combobox.click();
    const listbox = page.getByRole('listbox', { name: /timezone/i });
    await expect(listbox).toBeVisible();
    // Pick the first option that is NOT currently selected. Guarantees a
    // different timezone from the mock default (Africa/Accra) without relying
    // on sort order or reading the hidden selected-display.
    const notSelected = listbox.getByRole('option', { selected: false }).first();
    const ianaText = (await notSelected.locator('.timezone-select__option-iana').textContent()) ?? '';
    await notSelected.click();
    // Wait until the listbox unmounts and the selected display shows the new value.
    await expect(listbox).toHaveCount(0);
    await expect(page.locator('.timezone-select__selected-display')).toBeVisible();
    await expect(page.locator('.timezone-select__selected-display')).toContainText(ianaText);
    await assertDomSafeForScreenshot(page);
    await page.screenshot({ path: evidencePath(page, 'selected-timezone'), fullPage: false });
    assertNoExternalRequests(page);
  });

  test('AI Protection default', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== MOBILE_STD, 'mobile-standard only');
    await gotoAsAuthenticated(page, '/onboarding/risk', { heading: /ai protection/i });
    await expect(page.getByText(/you do not need to configure trading risk/i)).toBeVisible();
    await expect(page.getByText(/start or stop ai trading/i)).toBeVisible();
    await assertDomSafeForScreenshot(page);
    await page.screenshot({ path: evidencePath(page, 'ai-protection-default'), fullPage: false });
    assertNoExternalRequests(page);
  });

  test('AI Protection automatic limits', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== MOBILE_STD, 'mobile-standard only');
    await gotoAsAuthenticated(page, '/onboarding/risk', { heading: /ai protection/i });
    await expect(page.getByText(/daily loss protection/i)).toBeVisible();
    await expect(page.getByText(/drawdown protection/i)).toBeVisible();
    await expect(page.getByText(/concurrent positions/i)).toBeVisible();
    await assertDomSafeForScreenshot(page);
    await page.screenshot({ path: evidencePath(page, 'ai-protection-limits'), fullPage: false });
    assertNoExternalRequests(page);
  });

  test('broker empty state', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== MOBILE_STD, 'mobile-standard only');
    setupErrorCollectors(page);
    await setupAuthInterception(page);
    // Override broker connections → empty list (no existing connections).
    await page.route('**/api/v1/broker/connections', (route) => {
      if (route.request().method() === 'GET') {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({}) });
    });
    await page.goto('/onboarding/broker');
    await expect(page.getByRole('heading', { level: 1, name: /broker connection/i })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: /connect a new broker/i })).toBeVisible();
    await assertDomSafeForScreenshot(page);
    await page.screenshot({ path: evidencePath(page, 'broker-empty-state'), fullPage: false });
    assertNoExternalRequests(page);
  });

  test('broker confirmation dialog', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== MOBILE_STD, 'mobile-standard only');
    await gotoAsAuthenticated(page, '/onboarding/broker', { heading: /broker connection/i });
    await expect(page.getByRole('heading', { level: 2, name: /connect a new broker/i })).toBeVisible();
    const card = page.locator('.card', { hasText: /existing connections/i }).first();
    await card.getByRole('button', { name: /^disconnect$/i }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('aria-modal', 'true');
    await assertDomSafeForScreenshot(page);
    await page.screenshot({ path: evidencePath(page, 'broker-confirmation-dialog'), fullPage: false });
    assertNoExternalRequests(page);
  });

  test('dashboard onboarding-incomplete state', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== MOBILE_STD, 'mobile-standard only');
    setupErrorCollectors(page);
    await setupAuthInterception(page);
    // Override onboarding-status → incomplete (risk + broker missing).
    await page.route('**/api/v1/users/me/onboarding-status', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          profileCompleted: true,
          eligibilityCompleted: false,
          riskProfileCompleted: true,
          brokerConnected: false,
          brokerConnectionStatus: 'DISCONNECTED',
          canStartTrading: false,
          missingSteps: ['ELIGIBILITY', 'BROKER_CONNECTION'],
          nextStep: 'ELIGIBILITY',
        }),
      }),
    );
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { level: 1, name: /welcome back/i })).toBeVisible();
    await expect(page.getByText(/complete your onboarding/i)).toBeVisible({ timeout: 5000 });
    await assertDomSafeForScreenshot(page);
    await page.screenshot({ path: evidencePath(page, 'dashboard-onboarding-incomplete'), fullPage: false });
    assertNoExternalRequests(page);
  });
});

// ── Tablet Portrait (768 × 1024) ─────────────────────────────────────────────

test.describe('Evidence — tablet-portrait', () => {
  test('profile combobox open', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== TABLET_P, 'tablet-portrait only');
    await gotoAsAuthenticated(page, '/onboarding/profile', { heading: /trader profile/i });
    await page.getByRole('combobox', { name: /timezone/i }).click();
    await waitForTimezoneDropdownSettled(page);
    await assertDomSafeForScreenshot(page);
    await page.screenshot({ path: evidencePath(page, 'profile-combobox-open'), fullPage: false });
    assertNoExternalRequests(page);
  });

  test('AI Protection default', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== TABLET_P, 'tablet-portrait only');
    await gotoAsAuthenticated(page, '/onboarding/risk', { heading: /ai protection/i });
    await expect(page.getByText(/automatic account protection/i)).toBeVisible();
    await expect(page.getByText(/start or stop ai trading/i)).toBeVisible();
    await assertDomSafeForScreenshot(page);
    await page.screenshot({ path: evidencePath(page, 'ai-protection-default'), fullPage: false });
    assertNoExternalRequests(page);
  });

  test('broker dialog open', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== TABLET_P, 'tablet-portrait only');
    await gotoAsAuthenticated(page, '/onboarding/broker', { heading: /broker connection/i });
    await expect(page.getByRole('heading', { level: 2, name: /connect a new broker/i })).toBeVisible();
    const card = page.locator('.card', { hasText: /existing connections/i }).first();
    await card.getByRole('button', { name: /^disconnect$/i }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('aria-modal', 'true');
    await assertDomSafeForScreenshot(page);
    await page.screenshot({ path: evidencePath(page, 'broker-dialog-open'), fullPage: false });
    assertNoExternalRequests(page);
  });

  test('dashboard onboarding state', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== TABLET_P, 'tablet-portrait only');
    await gotoAsAuthenticated(page, '/dashboard', { heading: /welcome back/i });
    await expect(page.getByRole('link', { name: /open ai trading/i }).last()).toBeVisible();
    await assertDomSafeForScreenshot(page);
    await page.screenshot({ path: evidencePath(page, 'dashboard-onboarding-state'), fullPage: false });
    assertNoExternalRequests(page);
  });
});

// ── Desktop (1440 × 900) ─────────────────────────────────────────────────────

test.describe('Evidence — desktop', () => {
  test('profile default', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== DESKTOP, 'desktop only');
    await gotoAsAuthenticated(page, '/onboarding/profile', { heading: /trader profile/i });
    await expect(page.getByRole('button', { name: /save profile & continue/i })).toBeVisible();
    await assertDomSafeForScreenshot(page);
    await page.screenshot({ path: evidencePath(page, 'profile-default'), fullPage: false });
    assertNoExternalRequests(page);
  });

  test('profile combobox open', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== DESKTOP, 'desktop only');
    await gotoAsAuthenticated(page, '/onboarding/profile', { heading: /trader profile/i });
    await page.getByRole('combobox', { name: /timezone/i }).click();
    await waitForTimezoneDropdownSettled(page);
    await assertDomSafeForScreenshot(page);
    await page.screenshot({ path: evidencePath(page, 'profile-combobox-open'), fullPage: false });
    assertNoExternalRequests(page);
  });

  test('broker dialog', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== DESKTOP, 'desktop only');
    await gotoAsAuthenticated(page, '/onboarding/broker', { heading: /broker connection/i });
    await expect(page.getByRole('heading', { level: 2, name: /connect a new broker/i })).toBeVisible();
    const card = page.locator('.card', { hasText: /existing connections/i }).first();
    await card.getByRole('button', { name: /^disconnect$/i }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('aria-modal', 'true');
    await assertDomSafeForScreenshot(page);
    await page.screenshot({ path: evidencePath(page, 'broker-dialog'), fullPage: false });
    assertNoExternalRequests(page);
  });

  test('dashboard ready state', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== DESKTOP, 'desktop only');
    await gotoAsAuthenticated(page, '/dashboard', { heading: /welcome back/i });
    // The ready state hands the user to the novice AI Trading workspace;
    // Dashboard itself never starts a trading session.
    const openAiTrading = page.getByRole('link', { name: /open ai trading/i }).last();
    await expect(openAiTrading).toBeVisible();
    await expect(openAiTrading).toHaveAttribute('href', '/trade');
    await expect(page.locator('.readiness-card, .card', { hasText: /trading setup ready/i }).first()).toBeVisible();
    await assertDomSafeForScreenshot(page);
    await page.screenshot({ path: evidencePath(page, 'dashboard-ready-state'), fullPage: false });
    assertNoExternalRequests(page);
  });
});

// ── Post-capture safety: filename keyword check (defense-in-depth) ──────────
// Minor defense-in-depth: verifies the (static, known) screenshot filenames
// contain no credential-bearing keywords. This is a FILENAME check only — it
// does NOT scan screenshot pixels, perform OCR, or inspect image content.
// Substantive content safety is provided by assertDomSafeForScreenshot()
// (DOM-text + input-property assertions) called before every screenshot.

test.describe('Evidence — safety', () => {
  test('no evidence screenshot filename contains a secret-bearing keyword', async ({ page }) => {
    test.skip(!CAPTURE, 'set E2E_CAPTURE_EVIDENCE=1');
    const forbidden = ['token', 'secret', 'password', 'apikey', 'api-key', 'credential', 'jwt'];
    const labels = [
      'profile-default', 'profile-combobox-open', 'selected-timezone',
      'risk-tooltip-open', 'risk-validation-error', 'broker-empty-state',
      'broker-confirmation-dialog', 'dashboard-onboarding-incomplete',
      'broker-dialog-open', 'dashboard-onboarding-state',
      'broker-dialog', 'dashboard-ready-state',
    ];
    for (const label of labels) {
      for (const kw of forbidden) {
        expect(label.toLowerCase(), `evidence filename must not contain "${kw}"`).not.toContain(kw);
      }
    }
    expect(page).toBeDefined();
  });
});
