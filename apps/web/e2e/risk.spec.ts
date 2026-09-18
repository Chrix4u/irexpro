import { test, expect } from '@playwright/test';
import {
  gotoAsAuthenticated,
  assertNoHorizontalOverflow,
  assertNoConsoleErrors,
  assertBoundingBoxInViewport,
} from './fixtures';

test.describe('AI Protection', () => {
  test.beforeEach(async ({ page }) => {
    await gotoAsAuthenticated(page, '/onboarding/risk', { heading: /ai protection/i });
    await expect(page.getByText(/you do not need to configure trading risk/i)).toBeVisible();
  });

  test('renders server-managed protection instead of editable expert risk controls', async ({ page }) => {
    await expect(page.getByRole('heading', { level: 1, name: /ai protection/i })).toBeVisible();
    await expect(page.getByText(/automatic account protection/i)).toBeVisible();
    await expect(page.getByText(/daily loss protection/i)).toBeVisible();
    await expect(page.getByText(/drawdown protection/i)).toBeVisible();
    await expect(page.getByText(/concurrent positions/i)).toBeVisible();

    await expect(page.locator('input[type="number"]')).toHaveCount(0);
    await expect(page.getByRole('radiogroup', { name: /allowed trading mode/i })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /save risk profile/i })).toHaveCount(0);
  });

  test('explains the novice control model and routes to broker and AI Trading', async ({ page }) => {
    await expect(page.getByText(/1\. connect broker/i)).toBeVisible();
    await expect(page.getByText(/2\. allocate capital/i)).toBeVisible();
    await expect(page.getByText(/3\. ai automation/i)).toBeVisible();
    await expect(page.getByText(/start or stop ai trading/i)).toBeVisible();

    const protection = page.getByLabel('AI Protection');
    await expect(protection.getByRole('link', { name: /broker account/i })).toHaveAttribute(
      'href',
      '/onboarding/broker',
    );
    await expect(protection.getByRole('link', { name: /open ai trading/i })).toHaveAttribute(
      'href',
      '/trade',
    );
  });

  test('protection cards stay inside the viewport without console errors', async ({ page }) => {
    await assertNoHorizontalOverflow(page);
    assertNoConsoleErrors(page);

    const cards = page.locator('.card');
    const count = await cards.count();
    expect(count).toBeGreaterThan(0);
    for (let index = 0; index < count; index += 1) {
      const card = cards.nth(index);
      await card.scrollIntoViewIfNeeded();
      await assertBoundingBoxInViewport(card);
    }
  });

  test('focus-visible styling exists for keyboard users', async ({ page }) => {
    const hasFocusVisibleCSS = await page.evaluate(() => {
      for (const sheet of Array.from(document.styleSheets)) {
        try {
          for (const rule of Array.from(sheet.cssRules)) {
            if ((rule as CSSRule).cssText?.includes(':focus-visible')) return true;
          }
        } catch {
          // cross-origin stylesheets are irrelevant to this local build.
        }
      }
      return false;
    });
    expect(hasFocusVisibleCSS).toBe(true);
  });
});
