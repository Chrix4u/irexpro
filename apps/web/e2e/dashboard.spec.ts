import { test, expect } from '@playwright/test';
import {
  gotoAsAuthenticated,
  assertNoHorizontalOverflow,
  assertNoConsoleErrors,
  assertBoundingBoxInViewport,
} from './fixtures';

test.describe('Dashboard', () => {
  test.beforeEach(async ({ page }) => {
    await gotoAsAuthenticated(page, '/dashboard', { heading: /welcome back/i });
    await expect(
      page.locator('.readiness-card, .card', { hasText: /trading setup ready|complete your onboarding/i }).first(),
    ).toBeVisible();
  });

  test('renders authenticated account, broker and performance-fee status', async ({ page }) => {
    await expect(page.getByRole('heading', { level: 1, name: /welcome back/i })).toHaveText(
      'WELCOME BACK, ADAEZI',
    );
    await expect(page.locator('.card__title', { hasText: /account status/i })).toBeVisible();
    await expect(page.locator('.card__title', { hasText: /broker connection/i })).toBeVisible();
    await expect(page.locator('.card__title', { hasText: /performance fee/i })).toBeVisible();
  });

  test('uses the simplified three-step readiness model', async ({ page }) => {
    const checklist = page.locator('.checklist').first();
    await expect(checklist).toBeVisible();

    const steps = checklist.locator('[role="listitem"]');
    await expect(steps).toHaveCount(3);
    await expect(checklist.getByText(/verify your profile/i)).toBeVisible();
    await expect(checklist.getByText(/complete required disclosures/i)).toBeVisible();
    await expect(checklist.getByText(/connect broker/i)).toBeVisible();

    await expect(page.getByText(/risk limits/i)).toHaveCount(0);
  });

  test('routes ready users to AI Trading instead of starting a session from Dashboard', async ({ page }) => {
    const openAiTrading = page.getByRole('link', { name: /open ai trading/i }).last();
    await expect(openAiTrading).toBeVisible();
    await expect(openAiTrading).toHaveAttribute('href', '/trade');
    expect(
      await openAiTrading.evaluate((element) => parseFloat(getComputedStyle(element).marginTop)),
    ).toBeGreaterThan(0);

    await expect(page.getByRole('button', { name: /start paper trading session/i })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /start ai trading/i })).toHaveCount(0);
  });

  test('remains responsive with reachable actions and no console errors', async ({ page }) => {
    await assertNoHorizontalOverflow(page);
    assertNoConsoleErrors(page);

    const actions = page.locator('a.btn:visible, button.btn:visible');
    const count = await actions.count();
    for (let index = 0; index < count; index += 1) {
      const action = actions.nth(index);
      await action.scrollIntoViewIfNeeded();
      await assertBoundingBoxInViewport(action);
    }
  });

  test('desktop sidebar is hidden only at mobile widths', async ({ page }) => {
    const sidebar = page.locator('.dashboard-sidebar').first();
    const viewport = page.viewportSize();
    expect(viewport).not.toBeNull();
    if (!viewport) return;

    if (viewport.width <= 700) {
      await expect(sidebar).toBeHidden();
      await expect(page.locator('.mobile-bottom-nav')).toBeVisible();
    } else {
      await expect(sidebar).toBeVisible();
    }
  });
});
