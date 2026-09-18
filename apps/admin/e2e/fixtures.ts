import type { Page, Locator } from '@playwright/test';
import { expect } from '@playwright/test';
import type { AuthUser, OnboardingStatus } from '@irexpro/types';

/**
 * Shared E2E fixtures for the iRexPro ADMIN Playwright suite (Sprint 31).
 *
 * Mirrors apps/web/e2e/fixtures.ts. Authentication strategy: route
 * interception (mocking). Every /api/v1/** call the admin AuthProvider/pages
 * make is intercepted and fulfilled with deterministic admin-role fixture data.
 * No real backend is contacted, no test passwords live in source, and no auth
 * bypass is added to the app.
 *
 * The mock admin user has roles: ['ADMIN'] so the (protected) layout's
 * hasAdminRole guard passes and the full admin shell (sidebar + mobile bottom
 * nav) renders. The backend RolesGuard remains the real security boundary —
 * these fixtures only exercise the frontend presentation layer.
 */

// ── Mock admin data ──────────────────────────────────────────────────────────

export const mockAdminUser: AuthUser = {
  id: 'usr_admin_00000000-0000-0000-0000-000000000001',
  email: 'admin.okafor@irexpro.example',
  phone: '+233241111111',
  firstName: 'Admin',
  lastName: 'Okafor',
  countryCode: 'GH',
  status: 'ACTIVE',
  roles: ['ADMIN'],
  mfaEnabled: false,
  lastLoginAt: '2025-01-15T10:00:00.000Z',
  createdAt: '2024-09-01T08:00:00.000Z',
};

export const mockAdminTokens = {
  accessToken: 'mock-admin-access-token-for-e2e-tests-not-a-real-jwt',
  refreshToken: 'mock-admin-refresh-token-for-e2e-tests-not-a-real-jwt',
};

export interface AdminUser {
  id: string;
  email: string | null;
  phone: string | null;
  status: string;
  countryCode: string | null;
  createdAt: string;
  profile: {
    firstName: string | null;
    lastName: string | null;
    tradingExperienceLevel: string | null;
  } | null;
}

/**
 * Mock admin users list. Includes deliberately long email + UUID to exercise
 * the responsive overflow guards (.break-long, .truncate-long) on mobile.
 * The architect (§6) specifically asked to verify long email addresses do
 * not break the viewport.
 */
export const mockAdminUsers: AdminUser[] = [
  {
    id: 'usr_00000000-0000-0000-0000-000000000001',
    email: 'adaezi.okafor.with.a.very.long.email.address@example.com',
    phone: '+233241234567',
    status: 'ACTIVE',
    countryCode: 'GH',
    createdAt: '2025-01-15T10:00:00.000Z',
    profile: { firstName: 'Adaezi', lastName: 'Okafor', tradingExperienceLevel: 'INTERMEDIATE' },
  },
  {
    id: 'usr_00000000-0000-0000-0000-000000000002',
    email: 'kwame.mensah@example.com',
    phone: null,
    status: 'ACTIVE',
    countryCode: 'GH',
    createdAt: '2025-01-20T14:30:00.000Z',
    profile: { firstName: 'Kwame', lastName: 'Mensah', tradingExperienceLevel: 'BEGINNER' },
  },
  {
    id: 'usr_00000000-0000-0000-0000-000000000003',
    email: null,
    phone: '+233244567890',
    status: 'SUSPENDED',
    countryCode: 'NG',
    createdAt: '2025-02-01T08:00:00.000Z',
    profile: { firstName: 'Chioma', lastName: 'Eze', tradingExperienceLevel: 'EXPERT' },
  },
];

export const mockAdminOnboardingStatus: OnboardingStatus = {
  profileCompleted: true,
  eligibilityCompleted: true,
  riskProfileCompleted: true,
  brokerConnected: true,
  brokerConnectionStatus: 'CONNECTED',
  canStartTrading: true,
  missingSteps: [],
  nextStep: 'READY',
};

// ── Route interception ───────────────────────────────────────────────────────

function jsonFulfill(status: number, body: unknown) {
  return { status, contentType: 'application/json' as const, body: JSON.stringify(body) };
}

const API_PATH_PREFIX = '/api/v1/';

function extractApiPath(fullUrl: string): string {
  const idx = fullUrl.indexOf(API_PATH_PREFIX);
  if (idx < 0) return '';
  return fullUrl.slice(idx + API_PATH_PREFIX.length).split('?')[0];
}

/**
 * Intercept every admin API call with admin-role fixture data. A single
 * page.route() handler catches all /api/v1/** requests and dispatches by path.
 */
export async function setupAdminAuthInterception(page: Page): Promise<void> {
  await page.route('**/api/v1/**', (route) => {
    const request = route.request();
    const apiPath = extractApiPath(request.url());

    // ── Auth ────────────────────────────────────────────────────────────
    if (apiPath === 'auth/refresh') {
      return route.fulfill(jsonFulfill(200, mockAdminTokens));
    }
    if (apiPath === 'auth/me') {
      return route.fulfill(jsonFulfill(200, mockAdminUser));
    }
    if (apiPath === 'auth/logout') {
      return route.fulfill(jsonFulfill(200, { message: 'Logged out' }));
    }

    // ── Admin users ─────────────────────────────────────────────────────
    if (apiPath === 'admin/users') {
      return route.fulfill(jsonFulfill(200, { users: mockAdminUsers, total: mockAdminUsers.length }));
    }
    const onboardingMatch = apiPath.match(/^admin\/users\/([^/]+)\/onboarding-status$/);
    if (onboardingMatch) {
      return route.fulfill(jsonFulfill(200, mockAdminOnboardingStatus));
    }

    // ── Catch-all: empty 200 so no test produces a spurious failed request.
    return route.fulfill(jsonFulfill(200, {}));
  });

  // Silence favicon 404s.
  await page.route('**/favicon.ico', (route) => route.fulfill({ status: 204, body: '' }));
}

// ── Error / invariant collectors (mirrors web fixtures) ─────────────────────

interface ErrorCollector {
  consoleErrors: string[];
  failedRequests: string[];
}

const pageCollectors = new WeakMap<Page, ErrorCollector>();

const IGNORED_FAILURE_PATTERNS = [/favicon\.ico/i];

export function setupErrorCollectors(page: Page): void {
  const collector: ErrorCollector = { consoleErrors: [], failedRequests: [] };
  pageCollectors.set(page, collector);

  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    collector.consoleErrors.push(`[console.error] ${msg.text()}`);
  });
  page.on('pageerror', (err) => {
    collector.consoleErrors.push(`[pageerror] ${err.message}`);
  });
  page.on('response', (response) => {
    const status = response.status();
    const url = response.url();
    if (status < 400) return;
    if (IGNORED_FAILURE_PATTERNS.some((re) => re.test(url))) return;
    collector.failedRequests.push(`${status} ${response.request().method()} ${url}`);
  });
  page.on('requestfailed', (request) => {
    const url = request.url();
    if (IGNORED_FAILURE_PATTERNS.some((re) => re.test(url))) return;
    collector.failedRequests.push(`FAILED ${request.method()} ${url} — ${request.failure()?.errorText ?? 'unknown'}`);
  });
}

export function assertNoConsoleErrors(page: Page): void {
  const collector = pageCollectors.get(page);
  if (!collector) throw new Error('assertNoConsoleErrors: call setupErrorCollectors(page) first');
  if (collector.consoleErrors.length > 0) {
    throw new Error(`Unexpected console errors (${collector.consoleErrors.length}):\n${collector.consoleErrors.join('\n')}`);
  }
}

export function assertNoFailedRequests(page: Page): void {
  const collector = pageCollectors.get(page);
  if (!collector) throw new Error('assertNoFailedRequests: call setupErrorCollectors(page) first');
  if (collector.failedRequests.length > 0) {
    throw new Error(`Unexpected failed requests (${collector.failedRequests.length}):\n${collector.failedRequests.join('\n')}`);
  }
}

// ── Viewport / layout assertions ─────────────────────────────────────────────

export async function assertNoHorizontalOverflow(page: Page): Promise<void> {
  const metrics = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(
    metrics.scrollWidth,
    `Horizontal overflow: scrollWidth=${metrics.scrollWidth} > clientWidth=${metrics.clientWidth}`,
  ).toBeLessThanOrEqual(metrics.clientWidth);
}

export async function assertBoundingBoxInViewport(locator: Locator): Promise<void> {
  const box = await locator.boundingBox();
  expect(box, 'Element has no bounding box (not visible)').not.toBeNull();
  if (!box) return;
  const viewport = locator.page().viewportSize();
  expect(viewport, 'Page has no viewport size').not.toBeNull();
  if (!viewport) return;
  expect(box.x).toBeGreaterThanOrEqual(-1);
  expect(box.y).toBeGreaterThanOrEqual(-1);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
}

// ── Composite helpers ────────────────────────────────────────────────────────

/**
 * Navigate to an admin page as an authenticated admin and wait for the
 * (protected) layout's hasAdminRole guard to pass (the admin shell renders).
 * Returns once the page's main heading is visible.
 */
export async function gotoAsAdmin(
  page: Page,
  path: string,
  waitFor: { heading?: string | RegExp } = {},
): Promise<void> {
  await setupErrorCollectors(page);
  await setupAdminAuthInterception(page);
  await page.goto(path);
  if (waitFor.heading) {
    await expect(page.getByRole('heading', { level: 1, name: waitFor.heading })).toBeVisible();
  } else {
    await expect(page.getByText('Restoring session…')).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  }
}

// ── Non-admin (access-denied) fixture ────────────────────────────────────────

/**
 * Mock non-admin user with a SUPER_ADMIN-lacking role set (USER + SUPER_ADMIN
 * mixed to exercise the humanization: "User, Super Admin" would render, but
 * here we use a plain USER role to trigger the access-denied branch). The
 * backend RolesGuard is the real security boundary; this only exercises the
 * frontend presentation.
 *
 * For the access-denied branch we use roles: ['USER'] so hasAdminRole is
 * false and the (protected) layout renders the access-denied shell.
 */
export const mockNonAdminUser: AuthUser = {
  id: 'usr_nonadmin_00000000-0000-0000-0000-000000000001',
  email: 'regular.user.with.a.long.email@example.com',
  phone: '+233249999999',
  firstName: 'Regular',
  lastName: 'User',
  countryCode: 'GH',
  status: 'ACTIVE',
  roles: ['USER'],
  mfaEnabled: false,
  lastLoginAt: '2025-01-15T10:00:00.000Z',
  createdAt: '2024-09-01T08:00:00.000Z',
};

/**
 * Intercept auth APIs with a NON-admin user so the (protected) layout's
 * hasAdminRole guard fails and renders the access-denied shell. Used by
 * the access-denied responsive tests.
 */
export async function setupNonAdminAuthInterception(page: Page): Promise<void> {
  await page.route('**/api/v1/**', (route) => {
    const apiPath = extractApiPath(route.request().url());
    if (apiPath === 'auth/refresh') {
      return route.fulfill(jsonFulfill(200, mockAdminTokens));
    }
    if (apiPath === 'auth/me') {
      return route.fulfill(jsonFulfill(200, mockNonAdminUser));
    }
    if (apiPath === 'auth/logout') {
      return route.fulfill(jsonFulfill(200, { message: 'Logged out' }));
    }
    return route.fulfill(jsonFulfill(200, {}));
  });
  await page.route('**/favicon.ico', (route) => route.fulfill({ status: 204, body: '' }));
}

/**
 * Navigate to an admin page as an authenticated NON-admin (roles: ['USER'])
 * so the access-denied shell renders. Returns once the "Access denied"
 * heading is visible.
 */
export async function gotoAsNonAdmin(
  page: Page,
  path: string,
): Promise<void> {
  await setupErrorCollectors(page);
  await setupNonAdminAuthInterception(page);
  await page.goto(path);
  await expect(page.getByText('Restoring session…')).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 1, name: /access denied/i })).toBeVisible();
}
