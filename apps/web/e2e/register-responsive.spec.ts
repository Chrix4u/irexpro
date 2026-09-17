import { expect, test } from '@playwright/test';

test.describe('Register responsive layout', () => {
  test('desktop register heading and first fields remain accessible', async ({ page }) => {
    const viewport = page.viewportSize();
    test.skip(!viewport || viewport.width < 901, 'Desktop auth layout regression only');

    await page.goto('/register');

    const heading = page.getByRole('heading', { name: 'Create your account' });
    const subtitle = page.getByText('Start trading with AI-powered risk-gated execution');
    const firstNameLabel = page.locator('label[for="first-name"]');
    const lastNameLabel = page.locator('label[for="last-name"]');

    await expect(heading).toBeVisible();
    await expect(heading).toBeInViewport();
    await expect(subtitle).toBeInViewport();
    await expect(firstNameLabel).toBeInViewport();
    await expect(lastNameLabel).toBeInViewport();

    const formPanel = page.locator('.auth-layout__form-side');
    const positions = await formPanel.evaluate((panel) => {
      const panelRect = panel.getBoundingClientRect();
      const headingRect = panel.querySelector('h1')?.getBoundingClientRect();
      return {
        panelTop: panelRect.top,
        headingTop: headingRect?.top ?? -1,
      };
    });

    expect(positions.headingTop).toBeGreaterThanOrEqual(positions.panelTop);

    const nameRow = page.locator('.register-name-row');
    const hasHorizontalOverflow = await nameRow.evaluate(
      (row) => row.scrollWidth > row.clientWidth,
    );
    expect(hasHorizontalOverflow).toBe(false);
  });
});
