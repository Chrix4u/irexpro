import { test, expect } from '@playwright/test';
import {
  assertNoConsoleErrors,
  assertNoHorizontalOverflow,
  gotoAsAuthenticated,
} from './fixtures';

const LEGACY_WORKSPACE_ROUTES = [
  { path: '/dashboard', heading: /welcome back/i, label: 'Dashboard' },
  { path: '/onboarding/profile', heading: /trader profile/i, label: 'Profile' },
  { path: '/onboarding/risk', heading: /risk management/i, label: 'Risk Limits' },
  { path: '/onboarding/broker', heading: /broker connection/i, label: 'Broker Accounts' },
  { path: '/security', heading: /account security/i, label: 'Security' },
  { path: '/payments/success', heading: /fees & payments/i, label: 'Fees & Payments' },
] as const;

test.describe('Responsive workspace refresh', () => {
  for (const route of LEGACY_WORKSPACE_ROUTES) {
    test(`${route.label} remains responsive and inside the workspace shell`, async ({ page }) => {
      await gotoAsAuthenticated(page, route.path, { heading: route.heading });

      await assertNoHorizontalOverflow(page);
      assertNoConsoleErrors(page);

      await expect(page.locator('.dashboard-main, .terminal-main').first()).toBeVisible();
      await expect(page.locator('.dashboard-content, .terminal-content').first()).toBeVisible();

      const viewport = page.viewportSize();
      expect(viewport).not.toBeNull();
      if (!viewport) return;

      const sidebar = page.locator('.dashboard-sidebar').first();
      if (viewport.width <= 700) {
        await expect(sidebar).toBeHidden();
        await expect(page.locator('.mobile-bottom-nav')).toBeVisible();
      } else {
        await expect(sidebar).toBeVisible();
      }

      const visibleButtons = page.locator('a.btn:visible, button.btn:visible');
      const buttonCount = await visibleButtons.count();
      for (let index = 0; index < buttonCount; index += 1) {
        const box = await visibleButtons.nth(index).boundingBox();
        if (!box) continue;
        expect(box.x, `${route.label}: button left edge`).toBeGreaterThanOrEqual(-1);
        expect(
          box.x + box.width,
          `${route.label}: button right edge ${box.x + box.width} > viewport ${viewport.width}`,
        ).toBeLessThanOrEqual(viewport.width + 1);
      }
    });
  }
});
