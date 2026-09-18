import { expect, test } from '@playwright/test';
import {
  assertNoConsoleErrors,
  assertNoExternalRequests,
  assertNoFailedRequests,
  assertNoHorizontalOverflow,
  mockAuthTokens,
  mockAuthUser,
  mockBrokerConnections,
  setupErrorCollectors,
} from './fixtures';

const executionPosition = {
  id: '55555555-5555-4555-8555-555555555555',
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
  accountCurrency: 'USD',
  realisedPnl: null,
  commission: '0.20',
  swap: '0',
  closeReason: null,
  openedAt: '2026-08-31T00:45:00.000Z',
  closedAt: null,
  createdAt: '2026-08-31T00:44:00.000Z',
  updatedAt: '2026-08-31T00:45:00.000Z',
};

const livePosition = {
  id: executionPosition.id,
  brokerConnectionId: mockBrokerConnections[0].id,
  brokerName: 'Paper Trading Broker',
  environment: 'DEMO',
  instrument: 'EURUSD',
  direction: 'BUY',
  lotSize: '0.1000',
  requestedEntryPrice: '1.10000000',
  fillPrice: '1.10010000',
  accountCurrency: 'USD',
  currentPrice: '1.10420000',
  unrealisedPnl: '41.00',
  commission: '0.20',
  swap: '0',
  stopLoss: '1.09500000',
  takeProfit: '1.11000000',
  trailingStopPips: null,
  status: 'OPEN',
  openedAt: '2026-08-31T00:45:00.000Z',
  createdAt: '2026-08-31T00:44:00.000Z',
};

const marketSnapshot = {
  instrument: 'EURUSD',
  timeframe: 'H1',
  source: 'BROKER',
  status: 'FRESH',
  retrievedAt: '2026-08-31T01:00:30.000Z',
  latestCandleAt: '2026-08-31T01:00:00.000Z',
  quote: {
    bid: '1.17001',
    ask: '1.17013',
    spread: '0.00012',
    timestamp: '2026-08-31T01:00:15.000Z',
    freshness: 'FRESH',
  },
  candles: [
    {
      timestamp: '2026-08-31T01:00:00.000Z',
      open: '1.16965',
      high: '1.17030',
      low: '1.16955',
      close: '1.17005',
      volume: '1200',
    },
  ],
};

async function gotoAiTrader(page: Parameters<typeof setupErrorCollectors>[0]) {
  setupErrorCollectors(page);
  await page.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url());
    const apiPath = url.pathname.split('/api/v1/')[1] ?? '';
    const fulfill = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

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
          maxPositionSizeLot: '0.1000',
          allowedInstruments: 'ALL',
          maxVolatilityScore: '0.85',
        },
      });
    }
    if (apiPath === 'trading/sessions/active') {
      return fulfill(200, {
        id: '44444444-4444-4444-8444-444444444444',
        brokerConnectionId: mockBrokerConnections[0].id,
        executionMode: 'PAPER_ONLY',
        authorityGeneration: 1,
        status: 'ACTIVE',
        startedAt: '2026-08-31T00:30:00.000Z',
      });
    }
    if (apiPath === 'broker/connections') return fulfill(200, mockBrokerConnections);
    if (apiPath === 'execution/positions/open') return fulfill(200, [executionPosition]);
    if (apiPath === 'execution/trades/recent') return fulfill(200, [executionPosition]);
    if (apiPath === 'live-account/positions') {
      return fulfill(200, { positions: [livePosition], total: 1 });
    }
    if (apiPath === 'execution/capital-allocation') {
      return fulfill(200, {
        brokerConnectionId: mockBrokerConnections[0].id,
        logicalAccountKey: 'paper-broker|demo|demo-001',
        accountCurrency: 'USD',
        brokerEquity: '10000',
        hasAllocation: true,
        allocatedCapital: '2500',
        committedCapital: '250',
        availableCapital: '2250',
      });
    }
    if (apiPath === 'market-data/intelligence') return fulfill(200, marketSnapshot);
    if (apiPath.startsWith('trading/sessions/') && apiPath.endsWith('/stop')) return fulfill(200, {});
    return fulfill(200, {});
  });

  await page.goto('/trade');
  await expect(page.getByTestId('ai-trader-workspace')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'AI Trader' })).toBeVisible();
}

test.describe('AI Trader novice workflow', () => {
  test('shows broker, allocation, one automation control, positions and AI activity', async ({ page }) => {
    await gotoAiTrader(page);

    await expect(page.getByText('Paper Trading Broker', { exact: false }).first()).toBeVisible();
    await expect(page.getByText('2500 USD', { exact: false }).first()).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Broker account' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Turn AI automation off' })).toBeVisible();

    await expect(page.getByRole('heading', { level: 2, name: 'Open Positions' })).toBeVisible();
    await expect(page.getByText('EURUSD', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('+41.00 USD', { exact: true })).toBeVisible();

    await expect(page.getByRole('heading', { level: 2, name: 'Recent AI Activity' })).toBeVisible();
    await expect(page.getByText('OPEN', { exact: true }).first()).toBeVisible();

    await expect(page.getByText(/execution mode selector/i)).toHaveCount(0);
    await expect(page.getByText(/trading experience/i)).toHaveCount(0);
    await expect(page.getByText(/configure.*risk/i)).toHaveCount(0);

    await assertNoHorizontalOverflow(page);
    assertNoConsoleErrors(page);
    assertNoFailedRequests(page);
    assertNoExternalRequests(page);
  });

  test('remains responsive across the nine release viewports', async ({ page }) => {
    const viewports = [
      { width: 320, height: 568 },
      { width: 360, height: 800 },
      { width: 375, height: 667 },
      { width: 390, height: 844 },
      { width: 430, height: 932 },
      { width: 768, height: 1024 },
      { width: 1024, height: 768 },
      { width: 1366, height: 768 },
      { width: 1440, height: 900 },
    ];

    await gotoAiTrader(page);
    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      await assertNoHorizontalOverflow(page);
      await expect(page.getByTestId('ai-trader-workspace')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Turn AI automation off' })).toBeVisible();
    }

    assertNoConsoleErrors(page);
    assertNoFailedRequests(page);
    assertNoExternalRequests(page);
  });
});
