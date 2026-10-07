import { test, expect } from '@playwright/test';
import {
  gotoAsAdmin,
  assertNoHorizontalOverflow,
  assertNoConsoleErrors,
  assertBoundingBoxHorizontallyInViewport,
} from './fixtures';

/**
 * Admin data-heavy pages responsive E2E — Sprint 31 remediation (architect §5, §12).
 *
 * Verifies the remaining admin pages render without horizontal overflow at
 * every required viewport and that their content stays within bounds. The
 * Brokers and Audit retain lightweight content while Payments is data-driven.
 * The same page-level no-horizontal-overflow invariant applies to all of them,
 * while vertically tall cards remain valid scrollable page content.
 *
 * Required viewports: 360×800, 390×844, 430×932, 768×1024, 1440×900.
 *
 * Per architect §12: "the TABLE container may scroll horizontally; the PAGE
 * must not scroll horizontally." These specs assert the PAGE-level invariant.
 */

const ADMIN_PAGES = [
  { path: '/admin/brokers', heading: /^brokers$/i, name: 'Brokers' },
  { path: '/admin/payments', heading: /^payments$/i, name: 'Payments' },
  { path: '/admin/audit', heading: /^audit log$/i, name: 'Audit' },
];

for (const page of ADMIN_PAGES) {
  test.describe(`Admin ${page.name} page`, () => {
    test.beforeEach(async ({ browser }) => {
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      void browser;
    });

    test(`${page.name} page renders heading and does not overflow`, async ({ page: pwPage }) => {
      await gotoAsAdmin(pwPage, page.path, { heading: page.heading });

      // Heading visible.
      await expect(pwPage.getByRole('heading', { level: 1, name: page.heading })).toBeVisible();

      // No horizontal overflow (page-level invariant).
      await assertNoHorizontalOverflow(pwPage);

      // The main content card must stay horizontally within the viewport.
      // Tall cards may extend below the fold because the page scrolls vertically.
      const card = pwPage.locator('.card').first();
      if (await card.count() > 0) {
        await assertBoundingBoxHorizontallyInViewport(card);
      }
    });

    test(`${page.name} page bottom nav does not overlap content on mobile`, async ({ page: pwPage }) => {
      const viewport = pwPage.viewportSize();
      if (!viewport || viewport.width > 700) {
        test.skip();
        return;
      }

      await gotoAsAdmin(pwPage, page.path, { heading: page.heading });

      const bottomNav = pwPage.locator('.mobile-bottom-nav').first();
      const navBox = await bottomNav.boundingBox();
      expect(navBox, 'Bottom nav must have a bounding box').not.toBeNull();
      if (!navBox) return;

      // Scroll to bottom; last content must not be hidden behind the nav.
      await pwPage.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await pwPage.waitForTimeout(100);

      const cards = pwPage.locator('.card:visible');
      const count = await cards.count();
      if (count === 0) return;
      const lastCard = cards.nth(count - 1);
      const cardRect = await lastCard.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return { bottom: r.bottom };
      });
      expect(cardRect.bottom, `Last card bottom=${cardRect.bottom} ≤ nav top=${navBox.y}`).toBeLessThanOrEqual(navBox.y + 1);
    });

    test(`${page.name} page: no console errors`, async ({ page: pwPage }) => {
      await gotoAsAdmin(pwPage, page.path, { heading: page.heading });
      assertNoConsoleErrors(pwPage);
    });
  });
}
