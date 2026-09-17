import { test, expect } from '@playwright/test';
import {
  gotoAsAuthenticated,
  assertNoHorizontalOverflow,
  assertNoConsoleErrors,
  assertBoundingBoxInViewport,
} from './fixtures';

/**
 * Sprint 31 — Mobile bottom navigation E2E coverage.
 *
 * Verifies the responsive navigation architecture introduced in Sprint 31:
 *   - Mobile bottom navigation is visible only on small viewports (≤ 700px)
 *   - Desktop sidebar remains hidden on mobile and visible on desktop
 *   - The "More" button opens an accessible bottom sheet (role="dialog")
 *   - The sheet contains secondary destinations and a Log out action
 *   - Sheet closes on Escape, overlay click, and item selection
 *   - Active route is indicated via aria-current="page"
 *   - No horizontal overflow is introduced by the fixed bottom nav
 *   - Bottom nav touch targets are ≥ 44px tall (WCAG 2.5.5)
 *
 * These tests run across all 5 viewport projects (360, 390, 768, 1024, 1440)
 * because the visibility assertions are viewport-conditional — the same test
 * file verifies both mobile-show and desktop-hide behaviour.
 */

test.describe('Mobile bottom navigation', () => {
  test.beforeEach(async ({ page }) => {
    await gotoAsAuthenticated(page, '/dashboard', { heading: /welcome back/i });
    // Wait for the onboarding card to finish loading so the dashboard shell
    // (including the bottom nav) has fully rendered.
    await expect(
      page.locator('.readiness-card, .card', { hasText: /onboarding checklist|trading setup ready/i }).first(),
    ).toBeVisible();
  });

  // ── Visibility across viewports ─────────────────────────────────────────────

  test('bottom nav visible on mobile, hidden on desktop', async ({ page }) => {
    const bottomNav = page.locator('.mobile-bottom-nav').first();
    const viewport = page.viewportSize();
    expect(viewport, 'Page must have a viewport').not.toBeNull();
    if (!viewport) return;

    const display = await bottomNav.evaluate((el) => window.getComputedStyle(el).display);

    if (viewport.width <= 700) {
      // Mobile (360, 390): bottom nav must be visible (display: flex).
      expect(
        display,
        `Bottom nav should be display:flex at viewport width ${viewport.width} (≤700px), got display=${display}`,
      ).toBe('flex');
      await expect(bottomNav).toBeVisible();
    } else {
      // Tablet (768, 1024) + desktop (1440): bottom nav must be hidden.
      expect(
        display,
        `Bottom nav should be display:none at viewport width ${viewport.width} (>700px), got display=${display}`,
      ).toBe('none');
    }
  });

  test('desktop sidebar visible on desktop, hidden on mobile', async ({ page }) => {
    // This mirrors the existing dashboard.spec.ts assertion — re-asserted here
    // so the responsive-nav suite is self-contained for regression protection.
    const sidebar = page.locator('.dashboard-sidebar').first();
    const viewport = page.viewportSize();
    expect(viewport, 'Page must have a viewport').not.toBeNull();
    if (!viewport) return;

    const display = await sidebar.evaluate((el) => window.getComputedStyle(el).display);

    if (viewport.width <= 700) {
      expect(display, `Sidebar should be display:none at viewport width ${viewport.width} (≤700px)`).toBe('none');
    } else {
      expect(display, `Sidebar should be visible at viewport width ${viewport.width} (>700px)`).not.toBe('none');
    }
  });

  // ── Primary destinations ───────────────────────────────────────────────────

  test('bottom nav contains the novice trading destinations on mobile', async ({ page }) => {
    const viewport = page.viewportSize();
    if (!viewport || viewport.width > 700) {
      // Skip on desktop — bottom nav is hidden there.
      test.skip();
      return;
    }

    const bottomNav = page.locator('.mobile-bottom-nav').first();
    // Dashboard + AI Trader + Live Account + More.
    const items = bottomNav.locator('.mobile-bottom-nav__item');
    await expect(items).toHaveCount(4);

    const labels = await items.allTextContents();
    const joined = labels.join(' ').toLowerCase();
    expect(joined, `Expected primary destinations, got: ${labels.join(' | ')}`).toContain('dashboard');
    expect(joined).toContain('ai trader');
    expect(joined).toContain('live account');
    expect(joined).toContain('more');
  });

  test('active route is indicated with aria-current="page"', async ({ page }) => {
    const viewport = page.viewportSize();
    if (!viewport || viewport.width > 700) {
      test.skip();
      return;
    }

    // On /dashboard, the Dashboard item should be active.
    const dashboardItem = page.locator('.mobile-bottom-nav__item').first();
    await expect(dashboardItem).toHaveAttribute('aria-current', 'page');
    // The active item should also have the active modifier class.
    await expect(dashboardItem).toHaveClass(/mobile-bottom-nav__item--active/);
  });

  // ── Touch target sizing (WCAG 2.5.5) ─────────────────────────────────────────

  test('bottom nav items meet 44px minimum touch target on mobile', async ({ page }) => {
    const viewport = page.viewportSize();
    if (!viewport || viewport.width > 700) {
      test.skip();
      return;
    }

    const items = page.locator('.mobile-bottom-nav__item');
    const count = await items.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      const box = await items.nth(i).boundingBox();
      expect(box, `Bottom nav item ${i} has no bounding box`).not.toBeNull();
      if (!box) continue;
      // Touch target ≥ 44px in both dimensions. The nav items are min-height:
      // 56px (tall enough) and flex: 1 (so width is viewport/4 ≈ 90px on a
      // 360px viewport with 4 items). We assert height ≥ 44 strictly.
      expect(box.height, `Bottom nav item ${i} height=${box.height} < 44`).toBeGreaterThanOrEqual(44);
      expect(box.width, `Bottom nav item ${i} width=${box.width} < 44`).toBeGreaterThanOrEqual(44);
    }
  });

  // ── "More" sheet ────────────────────────────────────────────────────────────

  test('More button opens an accessible bottom sheet on mobile', async ({ page }) => {
    const viewport = page.viewportSize();
    if (!viewport || viewport.width > 700) {
      test.skip();
      return;
    }

    const moreButton = page.getByRole('button', { name: /more navigation/i });
    await expect(moreButton).toBeVisible();
    await expect(moreButton).toHaveAttribute('aria-haspopup', 'dialog');
    await expect(moreButton).toHaveAttribute('aria-expanded', 'false');
    await expect(moreButton).toHaveAttribute('aria-controls', 'mobile-more-sheet');

    await moreButton.click();

    // Sheet should appear with role="dialog" and aria-modal="true".
    const sheet = page.locator('#mobile-more-sheet');
    await expect(sheet).toBeVisible();
    await expect(sheet).toHaveAttribute('role', 'dialog');
    await expect(sheet).toHaveAttribute('aria-modal', 'true');
    await expect(sheet).toHaveAttribute('aria-labelledby', 'mobile-more-sheet-title');

    // The More button should now reflect expanded state.
    await expect(moreButton).toHaveAttribute('aria-expanded', 'true');
  });

  test('More sheet contains secondary destinations and Log out', async ({ page }) => {
    const viewport = page.viewportSize();
    if (!viewport || viewport.width > 700) {
      test.skip();
      return;
    }

    await page.getByRole('button', { name: /more navigation/i }).click();
    const sheet = page.locator('#mobile-more-sheet');
    await expect(sheet).toBeVisible();

    // Only setup/account destinations belong in More.
    const items = sheet.locator('.mobile-sheet__item');
    await expect(items).toHaveCount(4);

    const labels = (await items.allTextContents()).map((s) => s.trim().toLowerCase());
    const joined = labels.join(' | ');
    expect(joined, `Expected secondary destinations, got: ${joined}`).toContain('broker accounts');
    expect(joined).toContain('security');
    expect(joined).toContain('fees & payments');
    expect(joined).toContain('log out');
    expect(joined).not.toContain('risk limits');
    expect(joined).not.toContain('strategy lab');
  });

  test('More sheet closes on Escape and restores focus to the trigger', async ({ page, browserName }) => {
    const viewport = page.viewportSize();
    if (!viewport || viewport.width > 700) {
      test.skip();
      return;
    }
    // Focus restoration is keyboard-dependent; skip on webkit where the
    // programmatic focus call may be deferred past the assertion window.
    test.skip(browserName === 'webkit', 'Focus restoration timing on webkit is flaky in CI');

    const moreButton = page.getByRole('button', { name: /more navigation/i });
    await moreButton.click();
    const sheet = page.locator('#mobile-more-sheet');
    await expect(sheet).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
    // Focus should return to the More button.
    await expect(moreButton).toBeFocused();
  });

  test('More sheet closes on overlay click', async ({ page }) => {
    const viewport = page.viewportSize();
    if (!viewport || viewport.width > 700) {
      test.skip();
      return;
    }

    await page.getByRole('button', { name: /more navigation/i }).click();
    const sheet = page.locator('#mobile-more-sheet');
    await expect(sheet).toBeVisible();

    // Click the overlay (the dimmed background outside the sheet).
    const overlay = page.locator('.mobile-sheet-overlay');
    await overlay.click({ position: { x: 5, y: 5 } });
    await expect(sheet).toHaveCount(0);
  });

  // ── Focus trap + body scroll lock (architect §9 — verified, not asserted) ───

  test('More sheet traps focus: Tab cannot escape the sheet', async ({ page, browserName }) => {
    const viewport = page.viewportSize();
    if (!viewport || viewport.width > 700) {
      test.skip();
      return;
    }
    test.skip(browserName === 'webkit', 'Focus timing on webkit is flaky in CI');

    // Use the class-based trigger selector to avoid ambiguity — the regex
    // /more navigation/i also matches the close button's "Close more
    // navigation" aria-label once the sheet is open.
    const moreButton = page.locator('.mobile-bottom-nav__item[aria-label="More navigation"]');
    await moreButton.click();
    const sheet = page.locator('#mobile-more-sheet');
    await expect(sheet).toBeVisible();

    // Wait for the sheet's scheduled initial-focus callback to complete before
    // moving focus to the last item. Otherwise the requestAnimationFrame used
    // by the component can race this test and steal focus back to Close.
    const closeButton = sheet.locator('.mobile-sheet__close');
    await expect(closeButton).toBeFocused();

    // The sheet's focusable elements (in tab order):
    //   1. Close button (focused on open)
    //   2. Profile link
    //   3. Risk limits link
    //   4. Broker link
    //   5. Log out button
    // Tabbing forward from the last focusable should wrap to the first (close).
    const logoutButton = sheet.locator('.mobile-sheet__item--danger');
    await logoutButton.focus();
    await expect(logoutButton).toBeFocused();

    await page.keyboard.press('Tab');

    // Focus should wrap to the FIRST focusable element in the sheet (the close
    // button), NOT escape to the More trigger or the page behind the overlay.
    await expect(closeButton).toBeFocused();
    // The More trigger must NOT have focus (it's behind the overlay).
    await expect(moreButton).not.toBeFocused();
  });

  test('More sheet traps focus: Shift+Tab wraps from first to last', async ({ page, browserName }) => {
    const viewport = page.viewportSize();
    if (!viewport || viewport.width > 700) {
      test.skip();
      return;
    }
    test.skip(browserName === 'webkit', 'Focus timing on webkit is flaky in CI');

    const moreButton = page.locator('.mobile-bottom-nav__item[aria-label="More navigation"]');
    await moreButton.click();
    const sheet = page.locator('#mobile-more-sheet');
    await expect(sheet).toBeVisible();

    // The close button is the first focusable (focused on open via the focus
    // trap effect). Shift+Tab should wrap to the LAST focusable (Log out).
    const closeButton = sheet.locator('.mobile-sheet__close');
    await expect(closeButton).toBeFocused();

    await page.keyboard.press('Shift+Tab');

    const logoutButton = sheet.locator('.mobile-sheet__item--danger');
    await expect(logoutButton).toBeFocused();
  });

  test('More sheet locks body scroll while open and restores on close', async ({ page }) => {
    const viewport = page.viewportSize();
    if (!viewport || viewport.width > 700) {
      test.skip();
      return;
    }

    // Before opening: body scroll is not locked.
    const overflowBefore = await page.evaluate(() => document.body.style.overflow);
    expect(overflowBefore, 'Body overflow should not be hidden before sheet opens').not.toBe('hidden');

    const moreButton = page.locator('.mobile-bottom-nav__item[aria-label="More navigation"]');
    await moreButton.click();
    const sheet = page.locator('#mobile-more-sheet');
    await expect(sheet).toBeVisible();

    // While open: body overflow is locked to 'hidden'.
    const overflowDuring = await page.evaluate(() => document.body.style.overflow);
    expect(overflowDuring, 'Body overflow must be hidden while sheet is open').toBe('hidden');

    // Close via the close button (class selector — unambiguous).
    await sheet.locator('.mobile-sheet__close').click();
    await expect(sheet).toHaveCount(0);

    // After close: body scroll lock is released (restored to the previous value,
    // which was '' — empty string, not 'hidden').
    const overflowAfter = await page.evaluate(() => document.body.style.overflow);
    expect(overflowAfter, 'Body overflow must be restored after sheet closes').not.toBe('hidden');
  });

  // ── Layout invariants ───────────────────────────────────────────────────────

  test('no horizontal overflow introduced by the bottom nav', async ({ page }) => {
    // The fixed bottom nav is position: fixed; left: 0; right: 0; so it must
    // NOT contribute to document.documentElement.scrollWidth.
    await assertNoHorizontalOverflow(page);
  });

  test('no console errors', async ({ page }) => {
    assertNoConsoleErrors(page);
  });

  test('bottom nav does not overlap the last dashboard card on mobile', async ({ page }) => {
    const viewport = page.viewportSize();
    if (!viewport || viewport.width > 700) {
      test.skip();
      return;
    }

    // The dashboard content has padding-bottom ≥ 72px on mobile (asserted in
    // responsive-overflow.spec.ts). Here we verify the fixed bottom nav sits
    // at the bottom of the viewport and the last card's bottom edge is above
    // the nav's top edge — i.e. the padding reserves enough space.
    const bottomNav = page.locator('.mobile-bottom-nav').first();
    const navBox = await bottomNav.boundingBox();
    expect(navBox, 'Bottom nav must have a bounding box').not.toBeNull();
    if (!navBox) return;

    // The nav is position: fixed; bottom: 0; so its top edge should be at
    // viewport.height - nav.height (minus safe-area, which is inside the
    // nav's box). Assert it's in the bottom 80px of the viewport.
    expect(
      navBox.y,
      `Bottom nav top=${navBox.y} should be in the bottom 80px of viewport height=${viewport.height}`,
    ).toBeGreaterThan(viewport.height - 80);

    // Scroll to the very bottom of the page and verify the last card is
    // fully visible above the nav (no part of the last card is hidden
    // behind the nav).
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    // Wait a tick for the scroll to settle.
    await page.waitForTimeout(100);

    const cards = page.locator('.card:visible');
    const count = await cards.count();
    expect(count).toBeGreaterThan(0);
    const lastCard = cards.nth(count - 1);

    // The last card's bottom edge (in viewport coords after scroll) must be
    // at or above the nav's top edge. We use the card's absolute position
    // relative to the viewport via getBoundingClientRect.
    const cardRect = await lastCard.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom };
    });
    expect(
      cardRect.bottom,
      `Last card bottom=${cardRect.bottom} should be ≤ nav top=${navBox.y} (no overlap)`,
    ).toBeLessThanOrEqual(navBox.y + 1); // 1px tolerance
  });

  test('bottom nav items are within viewport bounds on mobile', async ({ page }) => {
    const viewport = page.viewportSize();
    if (!viewport || viewport.width > 700) {
      test.skip();
      return;
    }

    const items = page.locator('.mobile-bottom-nav__item');
    const count = await items.count();
    for (let i = 0; i < count; i++) {
      await assertBoundingBoxInViewport(items.nth(i));
    }
  });
});