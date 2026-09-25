import { test, expect } from '@playwright/test';
import {
  assertNoConsoleErrors,
  assertNoExternalRequests,
  assertNoFailedRequests,
  assertNoHorizontalOverflow,
  mockAuthTokens,
  mockAuthUser,
  setupErrorCollectors,
} from './fixtures';

const safeSnapshot = {
  engine: {
    killSwitchActive: false,
    brokerConnected: true,
  },
  policy: {
    riskAcknowledgementAccepted: true,
    allowedTradingMode: 'FULL_AUTO',
    limits: {
      maxDailyLossPercent: '5.00',
      maxDrawdownPercent: '10.00',
      maxOpenTrades: 3,
      maxPositionSizeLot: '0.1000',
      minStopLossPips: '5.00',
      maxVolatilityScore: '0.85',
      maxTradeRiskPercent: '2.00',
      maxLeverageAllowed: 30,
      allowedInstruments: ['EURUSD', 'GBPUSD'],
      rejectLowLiquidity: true,
    },
  },
  execution: {
    openPositions: 2,
    maxOpenPositions: 3,
    openPositionSlotsRemaining: 1,
    todayTrades: 7,
    dailyTradeCountPolicy: 'UNBOUNDED',
  },
  portfolio: {
    totalAccounts: 2,
    connectedAccounts: 1,
    freshSnapshots: 1,
    staleSnapshots: 1,
    unavailableSnapshots: 0,
  },
  recentViolations: [
    {
      id: 'violation-1',
      rejectionCode: 'MAX_CONCURRENT_TRADES',
      rejectionReason: 'Open trade limit reached',
      evaluatedAt: '2026-08-28T21:00:00.000Z',
    },
  ],
};

async function gotoPortfolioRisk(page: Parameters<typeof setupErrorCollectors>[0], body: unknown) {
  setupErrorCollectors(page);
  await page.route('**/api/v1/**', (route) => {
    const url = new URL(route.request().url());
    const apiPath = url.pathname.split('/api/v1/')[1] ?? '';
    const fulfill = (status: number, responseBody: unknown) =>
      route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify(responseBody),
      });

    if (apiPath === 'auth/refresh') return fulfill(200, mockAuthTokens);
    if (apiPath === 'auth/me') return fulfill(200, mockAuthUser);
    if (apiPath === 'auth/logout') return fulfill(200, { message: 'Logged out' });
    if (apiPath === 'risk/intelligence') return fulfill(200, body);
    return fulfill(200, {});
  });

  await page.goto('/portfolio');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Portfolio & Risk Intelligence' }),
  ).toBeVisible();
}

test.describe('Portfolio & Risk Intelligence', () => {
  test('renders authoritative policy, capacity, freshness, and sanitized risk vetoes', async ({ page }) => {
    await gotoPortfolioRisk(page, safeSnapshot);

    await expect(page.getByText('Full Auto', { exact: true })).toBeVisible();
    await expect(page.getByText('2 / 3', { exact: true })).toBeVisible();
    await expect(page.getByText('7', { exact: true })).toBeVisible();
    await expect(page.getByText('AI-driven · no fixed cap', { exact: true })).toBeVisible();
    await expect(page.getByText('1 / 1 / 0', { exact: true })).toBeVisible();
    await expect(page.getByText('Max Concurrent Trades', { exact: true })).toBeVisible();
    await expect(page.getByText('Open trade limit reached', { exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Open Portfolio Truth' })).toBeVisible();

    await expect(page.getByText('riskContext', { exact: false })).toHaveCount(0);
    await expect(page.getByText('signalId', { exact: false })).toHaveCount(0);
    await expect(page.getByText('userId', { exact: false })).toHaveCount(0);
    await expect(page.getByText('brokerBalance', { exact: false })).toHaveCount(0);

    await assertNoHorizontalOverflow(page);
    assertNoConsoleErrors(page);
    assertNoFailedRequests(page);
    assertNoExternalRequests(page);
  });

  test('fails closed if the API broadens the intelligence contract', async ({ page }) => {
    await gotoPortfolioRisk(page, {
      ...safeSnapshot,
      internalRiskContext: { brokerBalance: '10000.00' },
    });

    await expect(page.getByText(/unable to load the authoritative portfolio and risk snapshot/i)).toBeVisible();
    await expect(page.getByText('5.00%', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Open trade limit reached', { exact: true })).toHaveCount(0);
    await assertNoHorizontalOverflow(page);
    assertNoConsoleErrors(page);
    assertNoExternalRequests(page);
  });
});
