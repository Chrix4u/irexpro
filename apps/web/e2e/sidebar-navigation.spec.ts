import { test, expect } from '@playwright/test';
import {
  assertNoConsoleErrors,
  assertNoHorizontalOverflow,
  gotoAsAuthenticated,
} from './fixtures';

test.describe('Workspace sidebar navigation', () => {
  test.beforeEach(async ({ page }) => {
    await gotoAsAuthenticated(page, '/dashboard', { heading: /welcome back/i });
  });

  test('desktop sidebar exposes both portfolio destinations', async ({ page }) => {
    const viewport = page.viewportSize();
    if (!viewport || viewport.width <= 700) {
      test.skip();
      return;
    }

    const sidebar = page.locator('.terminal-sidebar');
    await expect(sidebar).toBeVisible();

    await expect(sidebar.getByRole('link', { name: 'Portfolio', exact: true })).toHaveAttribute(
      'href',
      '/trade/portfolio',
    );
    await expect(sidebar.getByRole('link', { name: 'Portfolio & Risk', exact: true })).toHaveAttribute(
      'href',
      '/portfolio',
    );

    await assertNoHorizontalOverflow(page);
    assertNoConsoleErrors(page);
  });

  test('desktop sidebar collapses to an accessible icon rail and expands again', async ({ page }) => {
    const viewport = page.viewportSize();
    if (!viewport || viewport.width <= 700) {
      test.skip();
      return;
    }

    const sidebar = page.locator('.terminal-sidebar');
    const collapseButton = page.getByRole('button', { name: 'Collapse sidebar' });

    const expandedBox = await sidebar.boundingBox();
    expect(expandedBox).not.toBeNull();

    await collapseButton.click();
    await expect(sidebar).toHaveAttribute('data-sidebar-collapsed', 'true');

    const expandButton = page.getByRole('button', { name: 'Expand sidebar' });
    await expect(expandButton).toHaveAttribute('aria-expanded', 'false');
    await expect(sidebar.getByRole('link', { name: 'Portfolio', exact: true })).toBeVisible();
    await expect(sidebar.getByRole('link', { name: 'Portfolio & Risk', exact: true })).toBeVisible();

    await expect(sidebar).toHaveCSS('width', '84px');
    const collapsedBox = await sidebar.boundingBox();
    expect(collapsedBox).not.toBeNull();
    if (expandedBox && collapsedBox) {
      expect(collapsedBox.width).toBeLessThan(expandedBox.width);
      expect(collapsedBox.width).toBeLessThanOrEqual(90);
    }

    await expandButton.click();
    await expect(sidebar).toHaveAttribute('data-sidebar-collapsed', 'false');
    await expect(page.getByRole('button', { name: 'Collapse sidebar' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );

    if (expandedBox) {
      await expect
        .poll(async () => {
          const restoredBox = await sidebar.boundingBox();
          return restoredBox ? Math.abs(restoredBox.width - expandedBox.width) : Number.POSITIVE_INFINITY;
        })
        .toBeLessThanOrEqual(1);
    }

    await assertNoHorizontalOverflow(page);
    assertNoConsoleErrors(page);
  });

  test('portfolio truth does not mark AI Trading active', async ({ page }) => {
    const viewport = page.viewportSize();
    if (!viewport || viewport.width <= 700) {
      test.skip();
      return;
    }

    await gotoAsAuthenticated(page, '/trade/portfolio', { heading: /portfolio/i });

    const sidebar = page.locator('.terminal-sidebar');
    await expect(sidebar.getByRole('link', { name: 'Portfolio', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(sidebar.getByRole('link', { name: 'AI Trading', exact: true })).not.toHaveAttribute(
      'aria-current',
      'page',
    );
  });
});
