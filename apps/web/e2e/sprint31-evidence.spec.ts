import { test } from '@playwright/test';
import { gotoAsAuthenticated } from './fixtures';

/**
 * Sprint 31 closure — Rendered Visual QA evidence (architect §6).
 *
 * Captures non-secret responsive screenshots of all reachable Web routes at
 * the required mobile (390) and desktop (1440) widths. Uses route-interception
 * auth (no real backend, no secrets). Gated by E2E_CAPTURE_EVIDENCE=1.
 *
 * Screenshots written to test-results/evidence/<width>x<height>/<state>.png
 * (gitignored). Used for VLM-based Rendered Visual QA.
 */
const CAPTURE = process.env.E2E_CAPTURE_EVIDENCE === '1';

function evidencePath(width: number, height: number, state: string) {
  return `test-results/evidence/${width}x${height}/${state}.png`;
}

test.describe('Sprint 31 closure — Web evidence', () => {
  test.skip(!CAPTURE, 'Set E2E_CAPTURE_EVIDENCE=1 to capture evidence');

  // ── Public/auth routes (no auth interception needed) ────────────────────────
  test('login @ 390', async ({ page }) => {
    const v = page.viewportSize()!;
    await page.goto('/login');
    // AuthLayout renders two h1s (headline + form title) — wait for the form
    // input instead to avoid strict-mode ambiguity.
    await page.locator('input').first().waitFor({ timeout: 5000 });
    await page.screenshot({ path: evidencePath(v.width, v.height, 'login'), fullPage: false });
  });

  test('register @ 390', async ({ page }) => {
    const v = page.viewportSize()!;
    await page.goto('/register');
    await page.locator('input').first().waitFor({ timeout: 5000 });
    await page.screenshot({ path: evidencePath(v.width, v.height, 'register'), fullPage: false });
  });

  test('payments success @ 390', async ({ page }) => {
    const v = page.viewportSize()!;
    await page.goto('/payments/success');
    await page.screenshot({ path: evidencePath(v.width, v.height, 'payments-success'), fullPage: false });
  });

  test('payments cancel @ 390', async ({ page }) => {
    const v = page.viewportSize()!;
    await page.goto('/payments/cancel');
    await page.screenshot({ path: evidencePath(v.width, v.height, 'payments-cancel'), fullPage: false });
  });

  test('payments callback @ 390', async ({ page }) => {
    const v = page.viewportSize()!;
    await page.goto('/payments/callback?reference=test-ref&status=success');
    await page.screenshot({ path: evidencePath(v.width, v.height, 'payments-callback'), fullPage: false });
  });

  // ── Protected routes (auth interception) ────────────────────────────────────
  test('dashboard @ 390', async ({ page }) => {
    const v = page.viewportSize()!;
    await gotoAsAuthenticated(page, '/dashboard', { heading: /welcome back/i });
    await page.screenshot({ path: evidencePath(v.width, v.height, 'dashboard'), fullPage: false });
  });

  test('dashboard @ 1440', async ({ page }) => {
    const v = page.viewportSize()!;
    await gotoAsAuthenticated(page, '/dashboard', { heading: /welcome back/i });
    await page.screenshot({ path: evidencePath(v.width, v.height, 'dashboard'), fullPage: false });
  });

  test('onboarding profile @ 390', async ({ page }) => {
    const v = page.viewportSize()!;
    await gotoAsAuthenticated(page, '/onboarding/profile', { heading: /profile/i });
    await page.screenshot({ path: evidencePath(v.width, v.height, 'onboarding-profile'), fullPage: false });
  });

  test('onboarding risk @ 390', async ({ page }) => {
    const v = page.viewportSize()!;
    await gotoAsAuthenticated(page, '/onboarding/risk', { heading: /ai protection/i });
    await page.screenshot({ path: evidencePath(v.width, v.height, 'onboarding-risk'), fullPage: false });
  });

  test('onboarding broker @ 390', async ({ page }) => {
    const v = page.viewportSize()!;
    await gotoAsAuthenticated(page, '/onboarding/broker', { heading: /broker/i });
    await page.screenshot({ path: evidencePath(v.width, v.height, 'onboarding-broker'), fullPage: false });
  });

  test('More Sheet open @ 390', async ({ page }) => {
    const v = page.viewportSize();
    if (!v || v.width > 700) {
      // Bottom nav is hidden on desktop — skip.
      test.skip();
      return;
    }
    await gotoAsAuthenticated(page, '/dashboard', { heading: /welcome back/i });
    await page.locator('.mobile-bottom-nav__item[aria-label="More navigation"]').click();
    await page.locator('#mobile-more-sheet').waitFor();
    await page.screenshot({ path: evidencePath(v.width, v.height, 'more-sheet-open'), fullPage: false });
  });
});
