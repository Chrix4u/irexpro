import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {
  gotoAsAuthenticated,
  setupErrorCollectors,
  setupAuthInterception,
} from './fixtures';

/**
 * Accessibility scans with @axe-core/playwright.
 *
 * Each test loads a page (or a specific interactive state) and runs an axe
 * scan, then filters the violations to critical + serious impact. Any such
 * violation fails the test.
 *
 * These scans run only on the `desktop` project to keep total suite runtime
 * reasonable — axe violations are overwhelmingly viewport-independent (they're
 * about ARIA semantics, color contrast, focus order, etc., not about layout
 * breakpoints). The other viewport projects exercise layout regressions via
 * the per-page spec files.
 */
test.describe('Accessibility (axe)', () => {
  test.describe.configure({ mode: 'serial' });

  test('profile page default state — no critical/serious violations', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'Axe scans run on Chromium only');
    await gotoAsAuthenticated(page, '/onboarding/profile', { heading: /trader profile/i });

    // No axe rules are disabled. The trading-experience <select> now has an
    // associated <label> (htmlFor + id), so the former `select-name` violation
    // is resolved at the source rather than suppressed.
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

    const severe = results.violations.filter(
      (v) => v.impact === 'critical' || v.impact === 'serious',
    );
    expect(
      severe,
      `Critical/serious axe violations on /onboarding/profile:\n${formatViolations(severe)}`,
    ).toEqual([]);
  });

  test('profile page with combobox open — no critical/serious violations', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'Axe scans run on Chromium only');
    await gotoAsAuthenticated(page, '/onboarding/profile', { heading: /trader profile/i });

    // Open the combobox so the listbox + options are in the DOM during the scan.
    await page.getByRole('combobox', { name: /timezone/i }).click();
    await expect(page.getByRole('listbox', { name: /timezone/i })).toBeVisible();

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

    const severe = results.violations.filter(
      (v) => v.impact === 'critical' || v.impact === 'serious',
    );
    expect(
      severe,
      `Critical/serious axe violations on /onboarding/profile (combobox open):\n${formatViolations(severe)}`,
    ).toEqual([]);
  });

  test('AI Protection page — no critical/serious violations', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'Axe scans run on Chromium only');
    await gotoAsAuthenticated(page, '/onboarding/risk', { heading: /ai protection/i });
    await expect(page.getByText(/you do not need to configure trading risk/i)).toBeVisible();

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

    const severe = results.violations.filter(
      (v) => v.impact === 'critical' || v.impact === 'serious',
    );
    expect(
      severe,
      `Critical/serious axe violations on /onboarding/risk:\n${formatViolations(severe)}`,
    ).toEqual([]);
  });

  test('broker page with dialog open — no critical/serious violations', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'Axe scans run on Chromium only');
    await gotoAsAuthenticated(page, '/onboarding/broker', { heading: /broker connection/i });
    await expect(page.getByRole('heading', { level: 2, name: /connect a new broker/i })).toBeVisible();

    // Open the disconnect ConfirmDialog so role="dialog" is in the DOM.
    const card = page.locator('.card', { hasText: /existing connections/i }).first();
    await card.getByRole('button', { name: /^disconnect$/i }).click();
    await expect(page.getByRole('dialog')).toBeVisible();

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

    const severe = results.violations.filter(
      (v) => v.impact === 'critical' || v.impact === 'serious',
    );
    expect(
      severe,
      `Critical/serious axe violations on /onboarding/broker (dialog open):\n${formatViolations(severe)}`,
    ).toEqual([]);
  });

  test('dashboard onboarding state — no critical/serious violations', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'Axe scans run on Chromium only');
    await gotoAsAuthenticated(page, '/dashboard', { heading: /welcome back/i });

    // Wait for the current novice-first readiness action.
    await expect(page.getByRole('link', { name: /open ai trading/i }).last()).toBeVisible();

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

    const severe = results.violations.filter(
      (v) => v.impact === 'critical' || v.impact === 'serious',
    );
    expect(
      severe,
      `Critical/serious axe violations on /dashboard:\n${formatViolations(severe)}`,
    ).toEqual([]);
  });
});

/**
 * Format axe violations into a readable multi-line string for assertion
 * failure messages. Includes the rule id, impact, help, and the offending
 * CSS selectors.
 *
 * The structural type accepts axe-core's `Result[]` (where `impact` is
 * `ImpactValue | undefined`, and `ImpactValue` includes `null`).
 */
type AxeViolation = {
  id: string;
  impact?: string | null;
  help?: string;
  nodes?: { target?: unknown[] }[];
};

function formatViolations(violations: AxeViolation[]): string {
  if (violations.length === 0) return '(none)';
  return violations
    .map((v) => {
      const targets = (v.nodes ?? []).map((n) => JSON.stringify(n.target)).join(', ');
      return `  • [${v.impact ?? '?'}] ${v.id}: ${v.help ?? ''} → ${targets}`;
    })
    .join('\n');
}

// Note: these axe scans are intentionally excluded from the per-page spec
// files so that a single axe regression doesn't block unrelated layout tests.
// The `setupErrorCollectors` + `setupAuthInterception` pair from fixtures is
// re-used here to keep the axe tests self-contained and deterministic.
test.describe('Accessibility (axe) — unauthenticated state', () => {
  test('unauthenticated dashboard shows "Not signed in" with no axe critical/serious violations', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'Axe scans run on Chromium only');
    setupErrorCollectors(page);
    await setupAuthInterception(page);
    // Override the refresh interception to return 401, simulating no session.
    await page.route('**/api/v1/auth/refresh', (route) =>
      route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ statusCode: 401, message: 'Unauthorized' }),
      }),
    );

    await page.goto('/dashboard');
    await expect(page.getByText(/not signed in/i)).toBeVisible();

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

    const severe = results.violations.filter(
      (v) => v.impact === 'critical' || v.impact === 'serious',
    );
    expect(
      severe,
      `Critical/serious axe violations on unauthenticated /dashboard:\n${formatViolations(severe)}`,
    ).toEqual([]);
  });
});
