import { expect, test, type Page, type Route } from '@playwright/test';

const USER = {
  id: 'usr_browser_session_e2e',
  email: 'browser-session@example.com',
  phone: '+233241234567',
  firstName: 'Browser',
  lastName: 'Session',
  countryCode: 'GH',
  status: 'ACTIVE',
  roles: ['USER'],
  mfaEnabled: false,
  emailVerified: true,
  phoneVerified: true,
  lastLoginAt: '2026-09-04T08:00:00.000Z',
  createdAt: '2026-08-01T08:00:00.000Z',
};

function apiPath(route: Route): string {
  const url = new URL(route.request().url());
  const marker = '/api/v1/';
  const index = url.pathname.indexOf(marker);
  return index >= 0 ? url.pathname.slice(index + marker.length) : '';
}

function json(status: number, body: unknown) {
  return { status, contentType: 'application/json', body: JSON.stringify(body) };
}

async function silenceFavicon(page: Page) {
  await page.route('**/favicon.ico', (route) => route.fulfill({ status: 204, body: '' }));
}

async function clickResponsiveLogout(page: Page) {
  const viewport = page.viewportSize();
  if (viewport && viewport.width <= 700) {
    await page.getByRole('button', { name: 'More navigation' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Log out' }).click();
  } else {
    await page.getByRole('button', { name: 'Log out' }).click();
  }
}

test.describe('Sprint 49 browser session security — Web', () => {
  test('browser login requests cookie-only refresh transport and works with an access-only response', async ({ page }) => {
    let loginRefreshTransport: string | null = null;
    let loginBody: Record<string, unknown> | null = null;

    await silenceFavicon(page);
    await page.route('**/api/v1/**', async (route) => {
      const path = apiPath(route);
      if (path === 'auth/refresh') {
        return route.fulfill(json(401, { statusCode: 401, message: 'Unauthorized' }));
      }
      if (path === 'auth/login') {
        loginRefreshTransport = new URL(route.request().url()).searchParams.get('refreshTransport');
        loginBody = route.request().postDataJSON() as Record<string, unknown>;
        return route.fulfill(json(200, { accessToken: 'browser-login-access-only' }));
      }
      if (path === 'auth/me') {
        return route.fulfill(json(200, USER));
      }
      return route.fulfill(json(200, {}));
    });

    await page.goto('/login');
    await page.getByLabel('Email or international phone number').fill('browser-session@example.com');
    await page.getByLabel('Password').fill('not-a-real-test-password');
    await page.getByRole('button', { name: /^log in$/i }).click();

    await expect(page).toHaveURL(/\/dashboard$/);
    expect(loginRefreshTransport).toBe('cookie');
    expect(loginBody).toMatchObject({ identifier: 'browser-session@example.com' });

    const storage = await page.evaluate(() => `${JSON.stringify(localStorage)}${JSON.stringify(sessionStorage)}`);
    expect(storage).not.toContain('refreshToken');
    expect(storage).not.toContain('browser-login-access-only');
  });

  test('logout recovers from a stale bearer, revokes with a fresh access token, clears the cookie, and reload stays signed out', async ({ page }) => {
    let refreshCalls = 0;
    let logoutCalls = 0;
    let browserSessionClears = 0;
    const logoutAuthorizations: Array<string | null> = [];

    await silenceFavicon(page);
    await page.route('**/api/v1/**', async (route) => {
      const path = apiPath(route);
      const request = route.request();

      if (path === 'auth/refresh') {
        refreshCalls += 1;
        if (refreshCalls === 1) {
          return route.fulfill(json(200, { accessToken: 'stale-browser-access' }));
        }
        if (refreshCalls === 2) {
          return route.fulfill(json(200, { accessToken: 'fresh-browser-access' }));
        }
        return route.fulfill(json(401, { statusCode: 401, message: 'Unauthorized' }));
      }

      if (path === 'auth/me') {
        return route.fulfill(json(200, USER));
      }

      if (path === 'auth/logout') {
        logoutCalls += 1;
        logoutAuthorizations.push(request.headers()['authorization'] ?? null);
        if (logoutCalls === 1) {
          return route.fulfill(json(401, { statusCode: 401, message: 'Unauthorized' }));
        }
        return route.fulfill(json(200, { message: 'Logged out successfully' }));
      }

      if (path === 'auth/browser-session' && request.method() === 'DELETE') {
        browserSessionClears += 1;
        return route.fulfill({ status: 204, body: '' });
      }

      return route.fulfill(json(200, {}));
    });

    await page.goto('/security');
    await expect(page.getByRole('heading', { level: 1, name: 'Account Security' })).toBeVisible();

    await clickResponsiveLogout(page);

    await expect(page.getByText('Sign in required')).toBeVisible();
    expect(refreshCalls).toBe(2);
    expect(logoutCalls).toBe(2);
    expect(logoutAuthorizations).toEqual([
      'Bearer stale-browser-access',
      'Bearer fresh-browser-access',
    ]);
    expect(browserSessionClears).toBe(1);

    const storage = await page.evaluate(() => `${JSON.stringify(localStorage)}${JSON.stringify(sessionStorage)}`);
    expect(storage).not.toContain('stale-browser-access');
    expect(storage).not.toContain('fresh-browser-access');

    await page.reload();
    await expect(page.getByText('Sign in required')).toBeVisible();
    expect(refreshCalls).toBe(3);
    expect(logoutCalls).toBe(2);
  });
});
