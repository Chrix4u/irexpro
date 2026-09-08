import type { Page, Locator } from '@playwright/test';
import { expect } from '@playwright/test';
import type {
  AuthUser,
  OnboardingStatus,
  RiskProfile,
  BrokerConnectionView,
  SupportedBroker,
} from '@irexpro/types';

/**
 * Shared E2E fixtures for the iRexPro web Playwright suite.
 *
 * Authentication strategy: route interception (mocking). Every API call the
 * AuthProvider / pages make is intercepted via `page.route()` and fulfilled
 * with deterministic fixture data. No real backend is contacted, no test
 * passwords live in source, and no auth bypass is added to the app.
 *
 * Route matching: a SINGLE page.route() handler catches all `/api/v1/**`
 * requests and dispatches based on the URL path + HTTP method. This avoids
 * any ambiguity in Playwright's multi-route registration order and keeps the
 * interception logic in one readable place.
 */

// ── Mock data ────────────────────────────────────────────────────────────────

export const mockAuthUser: AuthUser = {
  id: 'usr_00000000-0000-0000-0000-000000000001',
  email: 'adaezi.okafor@example.com',
  phone: '+233241234567',
  firstName: 'Adaezi',
  lastName: 'Okafor',
  countryCode: 'GH',
  status: 'ACTIVE',
  roles: ['USER'],
  mfaEnabled: false,
  lastLoginAt: '2025-01-15T10:00:00.000Z',
  createdAt: '2024-09-01T08:00:00.000Z',
};

export const mockAuthTokens = {
  accessToken: 'mock-access-token-for-e2e-tests-not-a-real-jwt',
  refreshToken: 'mock-refresh-token-for-e2e-tests-not-a-real-jwt',
};

export const mockUserProfile = {
  id: mockAuthUser.id,
  email: mockAuthUser.email,
  phone: mockAuthUser.phone,
  countryCode: mockAuthUser.countryCode,
  timezone: 'Africa/Accra',
  preferredCurrency: 'USD',
  profile: {
    tradingExperienceLevel: 'INTERMEDIATE' as const,
  },
};

export const mockOnboardingStatus: OnboardingStatus = {
  profileCompleted: true,
  riskProfileCompleted: true,
  brokerConnected: true,
  brokerConnectionStatus: 'CONNECTED',
  canStartTrading: true,
  missingSteps: [],
  nextStep: 'READY',
};

export const mockRiskProfile: RiskProfile = {
  id: 'rp_00000000-0000-0000-0000-000000000001',
  userId: mockAuthUser.id,
  killSwitchActive: false,
  killSwitchReason: null,
  maxDailyLossPercent: '5',
  maxDrawdownPercent: '10',
  maxOpenTrades: 3,
  maxDailyTrades: 10,
  maxPositionSizeLot: '1.00',
  minStopLossPips: '10',
  allowedInstruments: null,
  maxVolatilityScore: '7',
  rejectLowLiquidity: true,
  riskAcknowledgementAccepted: false,
  riskAcknowledgementAcceptedAt: null,
  maxTradeRiskPercent: '2',
  maxLeverageAllowed: 30,
  allowedTradingModes: 'PAPER_ONLY',
  createdAt: '2025-01-10T08:00:00.000Z',
  updatedAt: '2025-01-10T08:00:00.000Z',
};

export const mockSupportedBrokers: SupportedBroker[] = [
  {
    brokerId: 'paper-broker',
    brokerName: 'Paper Broker',
    supportsDemo: true,
    supportsLive: false,
  },
  {
    brokerId: 'metatrader5',
    brokerName: 'MetaTrader 5',
    supportsDemo: true,
    supportsLive: true,
  },
];

export const mockBrokerConnections: BrokerConnectionView[] = [
  {
    id: 'bconn_00000000-0000-0000-0000-000000000001',
    userId: mockAuthUser.id,
    brokerId: 'paper-broker',
    brokerName: 'Paper Broker',
    displayName: 'Demo paper account',
    accountId: 'paper-acc-001',
    accountType: 'DEMO',
    accountCurrency: 'USD',
    accountLeverage: 1,
    status: 'CONNECTED',
    // Sprint 50 authorization state machine: a demo connection that has
    // completed its handshake is AUTHORIZED (automation gate is only ACTIVE
    // after explicit live-trading enablement, which this mock has not done).
    authorizationStatus: 'AUTHORIZED',
    credentialStatus: 'VERIFIED',
    authorizedAt: '2025-01-15T09:55:00.000Z',
    authorizationRevokedAt: null,
    demoValidated: true,
    liveTradingEnabled: false,
    lastHealthCheckAt: '2025-01-15T09:55:00.000Z',
    lastSyncAt: '2025-01-15T09:55:00.000Z',
    lastErrorMessage: null,
    createdAt: '2025-01-05T08:00:00.000Z',
    updatedAt: '2025-01-15T09:55:00.000Z',
  },
];

// ── Route interception ───────────────────────────────────────────────────────

function jsonFulfill(status: number, body: unknown) {
  return {
    status,
    contentType: 'application/json' as const,
    body: JSON.stringify(body),
  };
}

function parseBody(postData: string | null): Record<string, unknown> {
  if (!postData) return {};
  try {
    return JSON.parse(postData) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * The API path prefix. The web app's API client concatenates
 * NEXT_PUBLIC_API_BASE_URL (e.g. "http://localhost:3999/api/v1") with a path
 * like "/auth/refresh". We match on the path that follows the base.
 */
const API_PATH_PREFIX = '/api/v1/';

/**
 * Extract the API path (without the /api/v1/ prefix and without query string)
 * from a full request URL. Returns an empty string if the URL is not under
 * /api/v1/.
 */
function extractApiPath(fullUrl: string): string {
  const idx = fullUrl.indexOf(API_PATH_PREFIX);
  if (idx < 0) return '';
  return fullUrl.slice(idx + API_PATH_PREFIX.length).split('?')[0];
}

/**
 * Intercept every API call the authenticated pages make and respond with
 * deterministic fixture data. A single route handler catches all `/api/v1/**`
 * requests and dispatches based on path + method, so there are no
 * route-registration-order ambiguities.
 */
export async function setupAuthInterception(page: Page): Promise<void> {
  await page.route('**/api/v1/**', (route) => {
    const request = route.request();
    const method = request.method();
    const apiPath = extractApiPath(request.url());

    // ── Auth ────────────────────────────────────────────────────────────
    if (apiPath === 'auth/refresh') {
      return route.fulfill(jsonFulfill(200, mockAuthTokens));
    }
    if (apiPath === 'auth/me') {
      return route.fulfill(jsonFulfill(200, mockAuthUser));
    }
    if (apiPath === 'auth/logout') {
      return route.fulfill(jsonFulfill(200, { message: 'Logged out' }));
    }

    // ── Users / onboarding ──────────────────────────────────────────────
    if (apiPath === 'users/me/onboarding-status') {
      return route.fulfill(jsonFulfill(200, mockOnboardingStatus));
    }
    if (apiPath === 'users/me') {
      if (method === 'PATCH') {
        return route.fulfill(
          jsonFulfill(200, { ...mockUserProfile, ...parseBody(request.postData()) }),
        );
      }
      return route.fulfill(jsonFulfill(200, mockUserProfile));
    }

    // ── Risk ────────────────────────────────────────────────────────────
    if (apiPath === 'risk/profile') {
      if (method === 'PATCH') {
        return route.fulfill(
          jsonFulfill(200, {
            ...mockRiskProfile,
            ...parseBody(request.postData()),
            riskAcknowledgementAccepted: true,
            riskAcknowledgementAcceptedAt: new Date().toISOString(),
          }),
        );
      }
      return route.fulfill(jsonFulfill(200, mockRiskProfile));
    }

    // ── Broker ──────────────────────────────────────────────────────────
    // Static segments must be checked before the dynamic :id segment.
    if (apiPath === 'broker/connections/supported') {
      return route.fulfill(jsonFulfill(200, mockSupportedBrokers));
    }
    if (apiPath === 'broker/connections/test') {
      return route.fulfill(jsonFulfill(200, { success: true, accountId: 'paper-acc-001' }));
    }
    if (apiPath === 'broker/connections') {
      if (method === 'POST') {
        return route.fulfill(jsonFulfill(201, mockBrokerConnections[0]));
      }
      return route.fulfill(jsonFulfill(200, mockBrokerConnections));
    }
    // Dynamic :id sub-routes.
    const brokerConnMatch = apiPath.match(/^broker\/connections\/([^/]+)(?:\/(connect|disconnect))?$/);
    if (brokerConnMatch) {
      const [, , action] = brokerConnMatch;
      if (action === 'connect') {
        return route.fulfill(
          jsonFulfill(200, { ...mockBrokerConnections[0], status: 'CONNECTED' }),
        );
      }
      if (action === 'disconnect') {
        return route.fulfill(
          jsonFulfill(200, { ...mockBrokerConnections[0], status: 'DISCONNECTED' }),
        );
      }
      // No action → the connection :id itself.
      if (method === 'DELETE') {
        return route.fulfill({ status: 204, body: '' });
      }
      return route.fulfill(jsonFulfill(200, mockBrokerConnections[0]));
    }

    // ── Trading ─────────────────────────────────────────────────────────
    if (apiPath === 'trading/sessions/start') {
      return route.fulfill(
        jsonFulfill(201, {
          id: 'sess_00000000-0000-0000-0000-000000000001',
          status: 'ACTIVE',
          requestedMode: 'PAPER_ONLY',
          startedAt: new Date().toISOString(),
        }),
      );
    }

    // ── Subscriptions / payments (defensive — not exercised by target pages) ──
    if (apiPath.startsWith('subscriptions/') || apiPath === 'subscriptions') {
      return route.fulfill(jsonFulfill(200, []));
    }
    if (apiPath.startsWith('payments/') || apiPath === 'payments') {
      return route.fulfill(jsonFulfill(200, []));
    }

    // ── Catch-all: any unhandled /api/v1/ route returns an empty 200 so no
    // test produces a spurious "failed request" from an unmocked call.
    return route.fulfill(jsonFulfill(200, {}));
  });

  // Silence favicon 404s so they don't show up as failed requests.
  await page.route('**/favicon.ico', (route) =>
    route.fulfill({ status: 204, body: '' }),
  );
}

/**
 * Intercept only the auth refresh endpoint and return 401. This simulates the
 * "no httpOnly refresh cookie" / "expired session" state the AuthProvider treats
 * as "user is unauthenticated".
 */
export async function setupUnauthenticatedInterception(page: Page): Promise<void> {
  await page.route('**/api/v1/**', (route) =>
    route.fulfill(jsonFulfill(401, { statusCode: 401, message: 'Unauthorized' })),
  );
  await page.route('**/favicon.ico', (route) =>
    route.fulfill({ status: 204, body: '' }),
  );
}

// ── Error / invariant collectors ─────────────────────────────────────────────

interface ErrorCollector {
  consoleErrors: string[];
  failedRequests: string[];
  allRequestHosts: Set<string>;
}

const pageCollectors = new WeakMap<Page, ErrorCollector>();

// Hosts that must NEVER be contacted by the deterministic E2E suite. Any request
// to a production/staging API, broker, payment-provider, or external AI host is
// a deterministic-isolation failure. The suite must only ever talk to the local
// Playwright-started Next.js server (localhost) whose /api/v1/** calls are all
// intercepted by setupAuthInterception().
const FORBIDDEN_HOST_PATTERNS = [
  /irexpro\.lightworldtech\.com/i,
  /lightworldtech\.com/i,
  /metatrader/i,
  /mt[45]\./i,
  /broker/i,
  /stripe/i,
  /paypal/i,
  /paystack/i,
  /flutterwave/i,
  /openai/i,
  /anthropic/i,
  /huggingface/i,
  /z-ai/i,
  /zai\./i,
];

// URL substrings that may legitimately return non-2xx during tests without
// indicating a real bug. Kept as narrow as possible so real regressions surface.
// Only favicon.ico (a harmless 404 when no icon asset exists) is allowlisted.
const IGNORED_FAILURE_PATTERNS = [/favicon\.ico/i];

/**
 * Attach console + network-failure collectors to a page. Must be called BEFORE
 * navigating to the page under test so events aren't missed. Each test should
 * call this once at the top, then call `assertNoConsoleErrors(page)` and
 * `assertNoFailedRequests(page)` at the end.
 */
export function setupErrorCollectors(page: Page): void {
  const collector: ErrorCollector = { consoleErrors: [], failedRequests: [], allRequestHosts: new Set() };
  pageCollectors.set(page, collector);

  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    collector.consoleErrors.push(`[console.error] ${text}`);
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
    collector.failedRequests.push(
      `FAILED ${request.method()} ${url} — ${request.failure()?.errorText ?? 'unknown'}`,
    );
  });

  // Track every request's host so assertNoExternalRequests() can prove no
  // production/staging/broker/payment/AI host was ever contacted.
  page.on('request', (request) => {
    try {
      const u = new URL(request.url());
      collector.allRequestHosts.add(u.host);
    } catch {
      // non-URL requests (e.g. data:) — ignore
    }
  });
}

/**
 * Fail the test if any unexpected console errors were collected since
 * `setupErrorCollectors(page)` was called.
 */
export function assertNoConsoleErrors(page: Page): void {
  const collector = pageCollectors.get(page);
  if (!collector) {
    throw new Error('assertNoConsoleErrors: call setupErrorCollectors(page) first');
  }
  if (collector.consoleErrors.length > 0) {
    throw new Error(
      `Unexpected console errors (${collector.consoleErrors.length}):\n${collector.consoleErrors.join('\n')}`,
    );
  }
}

/**
 * Fail the test if any non-2xx HTTP responses or network-failed requests were
 * collected. favicon.ico and other ignored patterns are filtered out.
 */
export function assertNoFailedRequests(page: Page): void {
  const collector = pageCollectors.get(page);
  if (!collector) {
    throw new Error('assertNoFailedRequests: call setupErrorCollectors(page) first');
  }
  if (collector.failedRequests.length > 0) {
    throw new Error(
      `Unexpected failed requests (${collector.failedRequests.length}):\n${collector.failedRequests.join('\n')}`,
    );
  }
}

// ── Viewport / layout assertions ─────────────────────────────────────────────

/**
 * Fail the test if any request was sent to a production, staging, broker,
 * payment-provider, or external AI host. The deterministic E2E suite must only
 * ever contact the local Playwright-started Next.js server, with every /api/v1/**
 * call intercepted by setupAuthInterception(). This proves no real backend,
 * broker, payment, or AI service is ever contacted.
 */
export function assertNoExternalRequests(page: Page): void {
  const collector = pageCollectors.get(page);
  if (!collector) {
    throw new Error('assertNoExternalRequests: call setupErrorCollectors(page) first');
  }
  const violations: string[] = [];
  for (const host of collector.allRequestHosts) {
    if (FORBIDDEN_HOST_PATTERNS.some((re) => re.test(host))) {
      violations.push(host);
    }
  }
  if (violations.length > 0) {
    throw new Error(
      `Deterministic E2E suite contacted a forbidden external host(s):\n${violations.join('\n')}\n` +
        `All hosts contacted: ${Array.from(collector.allRequestHosts).join(', ')}`,
    );
  }
}

/**
 * Assert the document has no horizontal overflow (scrollWidth <= clientWidth).
 * Catches responsive layout regressions where a fixed-width element breaks the
 * viewport at smaller breakpoints.
 */
export async function assertNoHorizontalOverflow(page: Page): Promise<void> {
  const metrics = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    scrollHeight: document.documentElement.scrollHeight,
    clientHeight: document.documentElement.clientHeight,
  }));
  expect(
    metrics.scrollWidth,
    `Horizontal overflow: scrollWidth=${metrics.scrollWidth} > clientWidth=${metrics.clientWidth}`,
  ).toBeLessThanOrEqual(metrics.clientWidth);
}

/**
 * Assert an element's bounding box is entirely inside the viewport (both
 * horizontally and vertically). Used to verify dropdowns, tooltips, and
 * dialogs don't get clipped by the viewport edge.
 *
 * Determinism: waits for the page scroll position to stabilize (no `scroll`
 * event for one animation frame) AND for the element's bounding box to be
 * stable across two consecutive reads before asserting viewport bounds. This
 * eliminates transient failures caused by reading the box mid-scroll or
 * mid-reflow (e.g. `scrollIntoViewIfNeeded` resolves on scroll-command ack,
 * but under load the actual scroll may still be animating). No fixed sleeps.
 */
export async function assertBoundingBoxInViewport(locator: Locator): Promise<void> {
  const page = locator.page();

  // 1. Wait for the page scroll position to stabilize. We attach a one-shot
  //    scroll listener and wait for one requestAnimationFrame with no scroll
  //    event. This proves any in-flight scroll (e.g. from scrollIntoViewIfNeeded
  //    in the calling test) has completed before we read the bounding box.
  await page.evaluate(() => {
    return new Promise<void>((resolve) => {
      let lastScroll = window.scrollY;
      let rafId = 0;
      const check = () => {
        if (window.scrollY === lastScroll) {
          // No scroll since last frame — scroll has settled.
          resolve();
        } else {
          lastScroll = window.scrollY;
          rafId = requestAnimationFrame(check);
        }
      };
      // Also resolve immediately if no scroll happens within a short budget
      // (covers the case where the page isn't scrollable at all).
      const timeoutId = window.setTimeout(() => {
        cancelAnimationFrame(rafId);
        resolve();
      }, 150);
      rafId = requestAnimationFrame(check);
      // If scroll settles before the timeout, clear the timeout.
      const origResolve = resolve;
      resolve = () => {
        window.clearTimeout(timeoutId);
        cancelAnimationFrame(rafId);
        origResolve();
      };
    });
  });

  // 2. Wait for the bounding box to be stable across two consecutive reads.
  //    This proves layout has settled (no in-flight reflow) before we assert.
  const deadline = Date.now() + 3000;
  let box: { x: number; y: number; width: number; height: number } | null = null;
  while (Date.now() < deadline) {
    const first = await locator.boundingBox();
    if (!first) break; // element not visible — handled by the null check below
    const second = await locator.boundingBox();
    if (!second) break;
    const isStable =
      Math.abs(first.x - second.x) < 0.5 &&
      Math.abs(first.y - second.y) < 0.5 &&
      Math.abs(first.width - second.width) < 0.5 &&
      Math.abs(first.height - second.height) < 0.5;
    if (isStable) {
      box = second;
      break;
    }
    // Layout still settling; loop and re-read. No fixed sleep.
  }
  // If we never reached stability, fall back to a single read so the
  // not-visible / null case is still reported clearly.
  if (!box) {
    box = await locator.boundingBox();
  }
  expect(box, 'Element has no bounding box (not visible)').not.toBeNull();
  if (!box) return;

  const viewport = page.viewportSize();
  expect(viewport, 'Page has no viewport size').not.toBeNull();
  if (!viewport) return;

  // 1px tolerance for subpixel rounding
  expect(box.x, `Element left=${box.x} is outside viewport left=0`).toBeGreaterThanOrEqual(-1);
  expect(box.y, `Element top=${box.y} is outside viewport top=0`).toBeGreaterThanOrEqual(-1);
  expect(
    box.x + box.width,
    `Element right=${box.x + box.width} overflows viewport width=${viewport.width}`,
  ).toBeLessThanOrEqual(viewport.width + 1);
  expect(
    box.y + box.height,
    `Element bottom=${box.y + box.height} overflows viewport height=${viewport.height}`,
  ).toBeLessThanOrEqual(viewport.height + 1);
}

// ── Composite helpers ────────────────────────────────────────────────────────

/**
 * Convenience: navigate to a page as an authenticated user and wait for the
 * AuthProvider to finish restoring (the dashboard shell renders). Returns once
 * the main heading of the page is visible — a stable signal that the page has
 * hydrated and the auth-gated content has rendered.
 */
export async function gotoAsAuthenticated(
  page: Page,
  path: string,
  waitFor: { heading?: string | RegExp } = {},
): Promise<void> {
  await setupErrorCollectors(page);
  await setupAuthInterception(page);
  await page.goto(path);
  // Wait for the AuthProvider to flip `restoring` to false. The dashboard
  // shell renders an <h1> once authenticated — wait for it.
  if (waitFor.heading) {
    await expect(page.getByRole('heading', { level: 1, name: waitFor.heading })).toBeVisible();
  } else {
    // Generic wait: the "Restoring session…" placeholder disappears and an <h1>
    // appears once the page has rendered its auth-gated content.
    await expect(page.getByText('Restoring session…')).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  }
}
