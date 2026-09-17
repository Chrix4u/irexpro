import { test, expect } from '@playwright/test';
import {
  gotoAsAuthenticated,
  assertNoHorizontalOverflow,
  assertNoConsoleErrors,
} from './fixtures';

/** Compatibility coverage for the retired manual risk-configuration route. */
test.describe('AI-managed protection', () => {
  test.beforeEach(async ({ page }) => {
    await gotoAsAuthenticated(page, '/onboarding/risk', { heading: /nothing to configure/i });
  });

  test('explains that risk protection is automatic and exposes no tuning controls', async ({ page }) => {
    await expect(page.getByRole('heading', { level: 1, name: /nothing to configure/i })).toBeVisible();
    await expect(page.getByText(/connect broker, allocate capital, then switch ai auto on or off/i)).toBeVisible();
    await expect(page.locator('input[type="number"]')).toHaveCount(0);
    await expect(page.getByRole('radiogroup')).toHaveCount(0);
    await expect(page.getByRole('checkbox')).toHaveCount(0);
    await expect(page.getByRole('link', { name: /connect broker/i })).toBeVisible();
  });

  test('is responsive and does not trap page scrolling', async ({ page }) => {
    await assertNoHorizontalOverflow(page);
    const content = page.locator('.dashboard-content, .terminal-content').first();
    const overflow = await content.evaluate((element) => {
      const styles = getComputedStyle(element);
      return { overflowY: styles.overflowY, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight };
    });
    expect(['auto', 'scroll', 'visible']).toContain(overflow.overflowY);
    expect(overflow.scrollHeight).toBeGreaterThanOrEqual(overflow.clientHeight);
    assertNoConsoleErrors(page);
  });
});
