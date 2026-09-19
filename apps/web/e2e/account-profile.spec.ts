import { test, expect } from '@playwright/test';
import {
  assertNoConsoleErrors,
  assertNoHorizontalOverflow,
  gotoAsAuthenticated,
} from './fixtures';

test.describe('Signed-in account profile center', () => {
  test.beforeEach(async ({ page }) => {
    await gotoAsAuthenticated(page, '/profile', { heading: /my profile/i });
  });

  test('shows editable profile, identity status and password controls', async ({ page }) => {
    await expect(page.getByLabel('First name')).toHaveValue('Adaezi');
    await expect(page.getByLabel('Last name')).toHaveValue('Okafor');
    await expect(page.getByLabel('Date of birth')).toHaveValue('1990-05-15');
    await expect(page.getByText(/KYC · Approved/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /save profile/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /change password/i })).toBeVisible();
    await expect(page.getByRole('link', { name: /forgot current password/i })).toHaveAttribute(
      'href',
      '/forgot-password',
    );
    await expect(page.getByRole('link', { name: /open security center/i })).toHaveAttribute(
      'href',
      '/security',
    );

    await assertNoHorizontalOverflow(page);
    assertNoConsoleErrors(page);
  });

  test('profile is reachable from responsive account navigation', async ({ page }) => {
    const viewport = page.viewportSize();
    expect(viewport).not.toBeNull();

    if (viewport && viewport.width <= 700) {
      await page.getByRole('button', { name: /more navigation/i }).click();
      const sheet = page.locator('#mobile-more-sheet');
      await expect(sheet.getByRole('link', { name: 'My Profile' })).toHaveAttribute(
        'aria-current',
        'page',
      );
    } else {
      const nav = page.getByRole('navigation', { name: /primary workspace navigation/i });
      await expect(nav.getByRole('link', { name: 'My Profile' })).toHaveAttribute(
        'aria-current',
        'page',
      );
    }

    await assertNoHorizontalOverflow(page);
  });

  test('profile edits use the signed-in update contract without leaving account center', async ({ page }) => {
    await page.getByLabel('First name').fill('Ama');
    await page.getByRole('button', { name: /save profile/i }).click();
    await expect(page.getByLabel('First name')).toHaveValue('Adaezi');
    await expect(page).toHaveURL(/\/profile$/);
  });
});
