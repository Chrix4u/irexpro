import { test, expect } from '@playwright/test';
import {
  gotoAsAuthenticated,
  assertNoHorizontalOverflow,
  assertNoConsoleErrors,
  assertBoundingBoxInViewport,
} from './fixtures';

/**
 * E2E tests for /onboarding/broker.
 *
 * Focus: existing connection display, new-connection form (with password-type
 * credential inputs), ConfirmDialog accessibility (role="dialog", focus trap,
 * Escape close, viewport bounds), and the credential-leak invariant —
 * sensitive values typed into password inputs must never appear as DOM text.
 */

// A distinctive sentinel value we type into the credential fields and then
// verify is NOT present anywhere in the page's text content.
const SECRET_API_KEY = 'e2e-secret-api-key-DO-NOT-LEAK-9f3a7c';
const SECRET_API_SECRET = 'e2e-secret-api-secret-DO-NOT-LEAK-2b1d8e';

test.describe('Onboarding / Broker', () => {
  test.beforeEach(async ({ page }) => {
    await gotoAsAuthenticated(page, '/onboarding/broker', { heading: /broker connection/i });
    // The broker page briefly shows "Loading broker data…" while the supported
    // brokers + connections fetch. Wait for the form to render.
    await expect(page.getByRole('heading', { level: 2, name: /connect a new broker/i })).toBeVisible();
  });

  // ── Page-load invariants ──────────────────────────────────────────────────

  test('page loads with authenticated state', async ({ page }) => {
    await expect(page.getByRole('heading', { level: 1, name: /broker connection/i })).toBeVisible();
    await expect(page.getByText(/Step 3 of 3/i)).toBeVisible();
  });

  test('no horizontal overflow', async ({ page }) => {
    await assertNoHorizontalOverflow(page);
  });

  test('no console errors', async ({ page }) => {
    assertNoConsoleErrors(page);
  });

  // ── Existing connections ──────────────────────────────────────────────────

  test('existing connections are displayed', async ({ page }) => {
    // The mock fixture returns one CONNECTED Paper Broker connection.
    await expect(page.getByText('Paper Broker').first()).toBeVisible();
    await expect(page.getByText(/paper-acc-001/i)).toBeVisible();
  });

  test('broker name and status badge visible', async ({ page }) => {
    const card = page.locator('.card', { hasText: /existing connections/i }).first();
    await expect(card).toBeVisible();
    await expect(card.getByText('Paper Broker')).toBeVisible();
    // The status badge shows "CONNECTED".
    await expect(card.getByText(/connected/i).first()).toBeVisible();
  });

  test('Connect/Disconnect buttons exist for existing connections', async ({ page }) => {
    const card = page.locator('.card', { hasText: /existing connections/i }).first();
    // The mock connection is CONNECTED, so a Disconnect button renders.
    await expect(card.getByRole('button', { name: /^disconnect$/i })).toBeVisible();
    // Delete is always present.
    await expect(card.getByRole('button', { name: /^delete$/i })).toBeVisible();
  });

  // ── New connection form ───────────────────────────────────────────────────

  test('"Connect a new broker" section visible', async ({ page }) => {
    await expect(page.getByRole('heading', { level: 2, name: /connect a new broker/i })).toBeVisible();
  });

  test('broker selector exists', async ({ page }) => {
    const brokerSelect = page.locator('#broker-select');
    await expect(brokerSelect).toBeVisible();
    // The mock supported brokers list has Paper Broker + MetaTrader 5.
    const options = brokerSelect.locator('option');
    const count = await options.count();
    expect(count).toBeGreaterThanOrEqual(2);
  });

  test('credential input fields exist as password type', async ({ page }) => {
    const apiKeyInput = page.locator('input[type="password"]').nth(0);
    const apiSecretInput = page.locator('input[type="password"]').nth(1);
    await expect(apiKeyInput).toBeVisible();
    await expect(apiSecretInput).toBeVisible();
    // Confirm via label text as well.
    await expect(page.locator('.input-label', { hasText: /api key/i })).toBeVisible();
    await expect(page.locator('.input-label', { hasText: /api secret/i })).toBeVisible();
  });

  test('Account ID input exists', async ({ page }) => {
    await expect(page.locator('.input-label', { hasText: /account id/i })).toBeVisible();
    const accountIdInput = page.locator('input[placeholder="Your broker account ID"]');
    await expect(accountIdInput).toBeVisible();
  });

  test('Test button exists', async ({ page }) => {
    await expect(page.getByRole('button', { name: /test credentials/i })).toBeVisible();
  });

  test('Save button exists', async ({ page }) => {
    await expect(page.getByRole('button', { name: /save connection/i })).toBeVisible();
  });

  test('cTrader platform prerequisites are surfaced before OAuth can start', async ({ page }) => {
    await page.locator('#broker-select').selectOption('ctrader');

    await expect(
      page.getByText(/cTrader authorization is awaiting platform configuration/i),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: /cTrader authorization unavailable/i }),
    ).toBeDisabled();
  });

  // ── Credential leak invariant ─────────────────────────────────────────────

  test('no credential values appear in DOM text (apiKey/apiSecret stay in password inputs)', async ({ page }) => {
    const apiKeyInput = page.locator('input[type="password"]').nth(0);
    const apiSecretInput = page.locator('input[type="password"]').nth(1);
    await apiKeyInput.fill(SECRET_API_KEY);
    await apiSecretInput.fill(SECRET_API_SECRET);

    // Password inputs store the value in the `value` attribute (not as text
    // content), so it must NOT appear in body.textContent().
    const bodyText = (await page.locator('body').textContent()) ?? '';
    expect(
      bodyText,
      `API key leaked into DOM text. Secret "${SECRET_API_KEY}" must not appear in body.textContent().`,
    ).not.toContain(SECRET_API_KEY);
    expect(
      bodyText,
      `API secret leaked into DOM text. Secret "${SECRET_API_SECRET}" must not appear in body.textContent().`,
    ).not.toContain(SECRET_API_SECRET);

    // Also verify the input's value attribute IS set (so the form is usable).
    await expect(apiKeyInput).toHaveValue(SECRET_API_KEY);
    await expect(apiSecretInput).toHaveValue(SECRET_API_SECRET);
  });

  // ── ConfirmDialog ─────────────────────────────────────────────────────────

  test('ConfirmDialog opens when clicking Disconnect (role="dialog")', async ({ page }) => {
    const card = page.locator('.card', { hasText: /existing connections/i }).first();
    const disconnectButton = card.getByRole('button', { name: /^disconnect$/i });
    await disconnectButton.click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('aria-modal', 'true');
  });

  test('ConfirmDialog has title and description', async ({ page }) => {
    const card = page.locator('.card', { hasText: /existing connections/i }).first();
    await card.getByRole('button', { name: /^disconnect$/i }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText(/disconnect broker\?/i);
    await expect(dialog).toContainText(/automated trading will remain unavailable/i);
  });

  test('ConfirmDialog has Cancel and Confirm buttons', async ({ page }) => {
    const card = page.locator('.card', { hasText: /existing connections/i }).first();
    await card.getByRole('button', { name: /^disconnect$/i }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('button', { name: /^cancel$/i })).toBeVisible();
    await expect(dialog.getByRole('button', { name: /^disconnect$/i })).toBeVisible();
  });

  test('ConfirmDialog is within viewport bounds', async ({ page }) => {
    const card = page.locator('.card', { hasText: /existing connections/i }).first();
    await card.getByRole('button', { name: /^disconnect$/i }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await assertBoundingBoxInViewport(dialog);
  });

  test('Escape closes ConfirmDialog', async ({ page }) => {
    const card = page.locator('.card', { hasText: /existing connections/i }).first();
    await card.getByRole('button', { name: /^disconnect$/i }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  });

  test('Delete button exists and opens its own ConfirmDialog', async ({ page }) => {
    const card = page.locator('.card', { hasText: /existing connections/i }).first();
    await card.getByRole('button', { name: /^delete$/i }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(/delete broker connection\?/i);
  });

  // ── Credential leak after typing (defense-in-depth) ───────────────────────

  test('no sensitive credential value in page content after typing and opening dialog', async ({ page }) => {
    const apiKeyInput = page.locator('input[type="password"]').nth(0);
    const apiSecretInput = page.locator('input[type="password"]').nth(1);
    await apiKeyInput.fill(SECRET_API_KEY);
    await apiSecretInput.fill(SECRET_API_SECRET);

    // Open the disconnect dialog — it renders on top of the page. The secrets
    // must still not leak into DOM text.
    const card = page.locator('.card', { hasText: /existing connections/i }).first();
    await card.getByRole('button', { name: /^disconnect$/i }).click();
    await expect(page.getByRole('dialog')).toBeVisible();

    const bodyText = (await page.locator('body').textContent()) ?? '';
    expect(bodyText).not.toContain(SECRET_API_KEY);
    expect(bodyText).not.toContain(SECRET_API_SECRET);
  });
});
