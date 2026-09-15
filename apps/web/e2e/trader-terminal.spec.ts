import { test, expect } from '@playwright/test';
import {
  gotoAsAuthenticated,
  setupErrorCollectors,
  assertNoHorizontalOverflow,
  assertNoConsoleErrors,
  assertNoFailedRequests,
  assertNoExternalRequests,
  mockAuthUser,
  mockAuthTokens,
  mockBrokerConnections,
} from './fixtures';

const ACTIVE_SESSION_ID = '44444444-4444-4444-8444-444444444444';
const OPEN_TRADE_ID = '55555555-5555-4555-8555-555555555555';
const CLOSED_TRADE_ID = '66666666-6666-4666-8666-666666666666';

const emptyDecisionExplorerSnapshot = {
  generatedAt: '2026-08-28T22:30:00.000Z',
  decisions: [],
};

const mockOpenPosition = {
  id: OPEN_TRADE_ID,
  instrument: 'EURUSD',
  direction: 'BUY',
  lotSize: '0.1000',
  requestedEntryPrice: '1.10000000',
  fillPrice: '1.10010000',
  stopLoss: '1.09500000',
  takeProfit: '1.11000000',
  trailingStopPips: null,
  status: 'OPEN',
  exitPrice: null,
  closeReason: null,
  openedAt: '2026-08-28T18:05:00.000Z',
  closedAt: null,
  createdAt: '2026-08-28T18:04:00.000Z',
  updatedAt: '2026-08-28T18:05:00.000Z',
};

const mockClosedExecution = {
  id: CLOSED_TRADE_ID,
  instrument: 'GBPUSD',
  direction: 'SELL',
  lotSize: '0.0500',
  requestedEntryPrice: '1.35000000',
  fillPrice: '1.34990000',
  stopLoss: '1.35500000',
  takeProfit: '1.34000000',
  trailingStopPips: null,
  status: 'CLOSED',
  exitPrice: '1.34200000',
  closeReason: 'TAKE_PROFIT_HIT',
  openedAt: '2026-08-28T15:00:00.000Z',
  closedAt: '2026-08-28T17:00:00.000Z',
  createdAt: '2026-08-28T14:59:00.000Z',
  updatedAt: '2026-08-28T17:00:00.000Z',
};

async function gotoTradeWithLiveStatusMocks(page: Parameters<typeof setupErrorCollectors>[0]) {
  setupErrorCollectors(page);

  await page.route('**/api/v1/**', (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const apiPath = url.pathname.split('/api/v1/')[1] ?? '';

    const fulfill = (status: number, body: unknown) =>
      route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify(body),
      });

    if (apiPath === 'auth/refresh') return fulfill(200, mockAuthTokens);
    if (apiPath === 'auth/me') return fulfill(200, mockAuthUser);
    if (apiPath === 'auth/logout') return fulfill(200, { message: 'Logged out' });

    if (apiPath === 'risk/status') {
      return fulfill(200, {
        killSwitchActive: false,
        brokerConnected: true,
        canTrade: true,
        limits: {
          maxDailyLossPercent: '5',
          maxDrawdownPercent: '10',
          maxOpenTrades: 3,
          maxPositionSizeLot: '1.00',
          allowedInstruments: 'ALL',
          maxVolatilityScore: '7',
        },
      });
    }

    if (apiPath === 'trading/sessions/active') {
      // TradingController returns TradingSessionResponseDto directly (or null),
      // never a legacy { session } envelope.
      return fulfill(200, {
        id: ACTIVE_SESSION_ID,
        brokerConnectionId: mockBrokerConnections[0].id,
        executionMode: 'PAPER_ONLY',
        authorityGeneration: 1,
        status: 'ACTIVE',
        openingBalance: '10000.00',
        peakEquity: '10000.00',
        startedAt: '2026-08-28T18:00:00.000Z',
      });
    }

    if (apiPath === 'broker/connections') {
      return fulfill(200, mockBrokerConnections);
    }

    if (apiPath === 'execution/positions/open') {
      return fulfill(200, [mockOpenPosition]);
    }

    if (apiPath === 'execution/trades/recent') {
      return fulfill(200, [mockOpenPosition, mockClosedExecution]);
    }

    return fulfill(200, {});
  });

  await page.goto('/trade');
  await expect(page.getByRole('heading', { level: 1, name: 'Trading Workspace' })).toBeVisible();
}

test.describe('Trader terminal workspaces', () => {
  test('AI Decision Explorer retains the authoritative-data foundation', async ({ page }) => {
    await gotoAsAuthenticated(page, '/ai', {
      heading: /AI Decision Explorer/i,
    });

    await page.route('**/api/v1/ai/decisions', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(emptyDecisionExplorerSnapshot),
      }),
    );
    await page.getByRole('button', { name: 'Refresh decisions' }).click();

    await expect(page.getByRole('heading', { level: 1, name: 'AI Decision Explorer' })).toBeVisible();
    await expect(page.getByText(/reports recorded evidence only/i)).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'Decision Timeline' })).toBeVisible();
    await expect(page.getByText('No persisted AI decisions yet', { exact: true })).toBeVisible();
    await expect(page.getByText(/does not expose hidden model reasoning/i)).toBeVisible();
    await expect(page.getByText(/unable to load persisted ai decision evidence/i)).toHaveCount(0);

    await assertNoHorizontalOverflow(page);
    assertNoConsoleErrors(page);
    assertNoFailedRequests(page);
    assertNoExternalRequests(page);
  });

  test('Trading Workspace renders authoritative risk, session, broker, and execution state', async ({ page }) => {
    await gotoTradeWithLiveStatusMocks(page);

    const riskCard = page
      .getByRole('heading', { level: 2, name: 'Risk Engine' })
      .locator('..');
    await expect(riskCard.getByText('Risk gate clear', { exact: true })).toBeVisible();
    await expect(riskCard.getByText('5%', { exact: true })).toBeVisible();
    await expect(riskCard.getByText('10%', { exact: true })).toBeVisible();

    const sessionCard = page
      .getByRole('heading', { level: 2, name: 'AI Trading Session' })
      .locator('..');
    await expect(sessionCard.getByText('Active', { exact: true })).toBeVisible();
    await expect(sessionCard.getByText('Trading session service', { exact: true })).toBeVisible();
    await expect(sessionCard.getByText(/not exposed to this browser contract/i)).toBeVisible();

    const brokerCard = page
      .getByRole('heading', { level: 2, name: 'Broker Health' })
      .locator('..');
    await expect(brokerCard.getByText('Paper Broker', { exact: true })).toBeVisible();
    await expect(brokerCard.getByText('Demo paper account', { exact: true })).toBeVisible();
    await expect(brokerCard.getByText('Connected', { exact: true })).toBeVisible();
    await expect(brokerCard.getByText('Demo', { exact: true })).toBeVisible();

    const openPositions = page
      .getByRole('heading', { level: 2, name: 'Open Positions (1)' })
      .locator('..');
    await expect(openPositions.getByText('EURUSD', { exact: true })).toBeVisible();
    await expect(openPositions.getByText(/BUY · 0.1000 lot/i)).toBeVisible();
    await expect(openPositions.getByText('1.10010000', { exact: true })).toBeVisible();

    const recentExecutions = page
      .getByRole('heading', { level: 2, name: 'Recent Executions' })
      .locator('..');
    await expect(recentExecutions.getByText('GBPUSD', { exact: true })).toBeVisible();
    await expect(recentExecutions.getByText('Take Profit Hit', { exact: true })).toBeVisible();

    await expect(page.getByText(/authoritative data only/i)).toBeVisible();
    await expect(page.getByText(/does not calculate or fabricate balances/i)).toBeVisible();
    await expect(page.getByText(/P&L remains intentionally hidden/i)).toBeVisible();

    // Internal persistence-only fields and ambiguous currency-less P&L must never appear.
    await expect(page.getByText('riskProfileSnapshot', { exact: false })).toHaveCount(0);
    await expect(page.getByText('openingBalance', { exact: false })).toHaveCount(0);
    await expect(page.getByText('peakEquity', { exact: false })).toHaveCount(0);
    await expect(page.getByText('idempotencyKey', { exact: false })).toHaveCount(0);
    await expect(page.getByText('externalOrderId', { exact: false })).toHaveCount(0);
    await expect(page.getByText('realisedPnl', { exact: false })).toHaveCount(0);

    await assertNoHorizontalOverflow(page);
    assertNoConsoleErrors(page);
    assertNoFailedRequests(page);
    assertNoExternalRequests(page);
  });

  test('desktop workspace navigation exposes the four primary product areas', async ({ page }) => {
    await gotoAsAuthenticated(page, '/trade', { heading: /Trading Workspace/i });
    const viewport = page.viewportSize();
    expect(viewport).not.toBeNull();
    if (!viewport || viewport.width <= 700) {
      test.skip();
      return;
    }

    const nav = page.getByRole('navigation', { name: /primary workspace navigation/i });
    await expect(nav.getByRole('link', { name: 'Dashboard' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Trading Workspace' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(nav.getByRole('link', { name: 'AI Command Center' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Portfolio & Risk' })).toBeVisible();
  });

  test('mobile More sheet exposes Trade, AI, and Portfolio without expanding the three-item bottom bar', async ({ page }) => {
    await gotoAsAuthenticated(page, '/trade', { heading: /Trading Workspace/i });
    const viewport = page.viewportSize();
    expect(viewport).not.toBeNull();
    if (!viewport || viewport.width > 700) {
      test.skip();
      return;
    }

    const bottomItems = page.locator('.mobile-bottom-nav__item');
    await expect(bottomItems).toHaveCount(3);

    await page.getByRole('button', { name: /more navigation/i }).click();
    const sheet = page.locator('#mobile-more-sheet');
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole('link', { name: 'Trading Workspace' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(sheet.getByRole('link', { name: 'AI Command Center' })).toBeVisible();
    await expect(sheet.getByRole('link', { name: 'Portfolio & Risk' })).toBeVisible();
  });
});
