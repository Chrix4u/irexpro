import { test, expect } from '@playwright/test';
import {
  gotoAsAuthenticated,
  assertNoHorizontalOverflow,
  assertNoConsoleErrors,
  assertNoExternalRequests,
} from './fixtures';

test.describe('AI-first trader workspace navigation', () => {
  test('desktop navigation exposes Dashboard, AI Trading and Positions & Activity', async ({ page }) => {
    await gotoAsAuthenticated(page, '/dashboard', { heading: /welcome back/i });

    const viewport = page.viewportSize();
    expect(viewport).not.toBeNull();
    if (!viewport || viewport.width <= 700) {
      test.skip();
      return;
    }

    const nav = page.getByRole('navigation', { name: /primary workspace navigation/i });
    await expect(nav.getByRole('link', { name: 'Dashboard' })).toHaveAttribute('aria-current', 'page');
    await expect(nav.getByRole('link', { name: 'AI Trading' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Portfolio', exact: true })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Portfolio & Risk', exact: true })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Positions & Activity' })).toBeVisible();
    await expect(nav.getByRole('link', { name: /trading workspace/i })).toHaveCount(0);

    await assertNoHorizontalOverflow(page);
    assertNoConsoleErrors(page);
    assertNoExternalRequests(page);
  });

  test('mobile navigation keeps AI Trading primary and Positions & Activity in More', async ({ page }) => {
    await gotoAsAuthenticated(page, '/dashboard', { heading: /welcome back/i });

    const viewport = page.viewportSize();
    expect(viewport).not.toBeNull();
    if (!viewport || viewport.width > 700) {
      test.skip();
      return;
    }

    const bottomNav = page.getByRole('navigation', { name: /primary mobile navigation/i });
    await expect(bottomNav.getByRole('link', { name: 'Home' })).toBeVisible();
    await expect(bottomNav.getByRole('link', { name: 'AI Trading' })).toBeVisible();
    await page.getByRole('button', { name: /more navigation/i }).click();

    const sheet = page.locator('#mobile-more-sheet');
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole('link', { name: 'Positions & Activity' })).toBeVisible();
    await expect(sheet.getByRole('link', { name: 'Broker Account' })).toBeVisible();

    await assertNoHorizontalOverflow(page);
    assertNoConsoleErrors(page);
    assertNoExternalRequests(page);
  });

  test('AI Decision Explorer remains evidence-only and does not expose hidden reasoning', async ({ page }) => {
    await page.route('**/api/v1/ai/decisions', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          generatedAt: '2026-09-18T13:00:00.000Z',
          decisions: [],
        }),
      }),
    );
    await gotoAsAuthenticated(page, '/ai', { heading: /AI Decision Explorer/i });
    await expect(page.getByText(/does not expose hidden model reasoning/i)).toBeVisible();
    await assertNoHorizontalOverflow(page);
    assertNoConsoleErrors(page);
    assertNoExternalRequests(page);
  });
});
