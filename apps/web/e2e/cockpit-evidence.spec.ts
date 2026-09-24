import { expect, test, type Page } from '@playwright/test';
import {
  assertNoExternalRequests,
  mockAuthTokens,
  mockAuthUser,
  mockBrokerConnections,
  setupErrorCollectors,
} from './fixtures';

const CAPTURE = process.env.E2E_CAPTURE_EVIDENCE === '1';
const EVIDENCE_DIR = 'test-results/evidence';
const ALLOWED_PROJECTS = new Set(['mobile-standard', 'tablet-portrait', 'desktop']);

const executionPosition = {
  id: '55555555-5555-4555-8555-555555555541',
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
  openedAt: '2026-09-18T13:00:00.000Z',
  closedAt: null,
  createdAt: '2026-09-18T12:59:00.000Z',
  updatedAt: '2026-09-18T13:00:00.000Z',
};

const livePosition = {
  id: executionPosition.id,
  brokerConnectionId: mockBrokerConnections[0].id,
  brokerName: 'Paper Broker',
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
  openedAt: '2026-09-18T13:00:00.000Z',
  createdAt: '2026-09-18T12:59:00.000Z',
};

const marketSnapshot = {
  instrument: 'EURUSD',
  timeframe: 'H1',
  source: 'BROKER',
  status: 'FRESH',
  retrievedAt: '2026-09-18T13:05:30.000Z',
  latestCandleAt: '2026-09-18T13:00:00.000Z',
  quote: {
    bid: '1.17001',
    ask: '1.17013',
    spread: '0.00012',
    timestamp: '2026-09-18T13:05:15.000Z',
    freshness: 'FRESH',
  },
  candles: [
    {
      timestamp: '2026-09-18T13:00:00.000Z',
      open: '1.16965',
      high: '1.17030',
      low: '1.16955',
      close: '1.17005',
      volume: '1200',
    },
  ],
};

function evidencePath(page: Page): string {
  const viewport = page.viewportSize();
  const label = viewport ? `${viewport.width}x${viewport.height}` : 'unknown';
  return `${EVIDENCE_DIR}/${label}/ai-trader-stop-confirmation.png`;
}

async function assertEvidenceDomSafe(page: Page) {
  const bodyText = (await page.locator('body').textContent()) ?? '';
  for (const marker of [
    'sk_live',
    'pk_live',
    'github_pat_',
    'ghp_',
    'Bearer ',
    'providerAccountId',
    'encryptedCredentials',
    'credentialIv',
    'credentialTag',
    'idempotencyKey',
  ]) {
    expect(bodyText).not.toContain(marker);
  }
  expect(bodyText).not.toMatch(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/);
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
}

async function setupAiTraderEvidence(page: Page) {
  setupErrorCollectors(page);

  await page.route('**/api/v1/**', (route) => {
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
        id: '44444444-4444-4444-8444-444444444441',
        brokerConnectionId: mockBrokerConnections[0].id,
        executionMode: 'PAPER_ONLY',
        authorityGeneration: 1,
        status: 'ACTIVE',
        startedAt: '2026-09-18T12:30:00.000Z',
      });
    }

    if (apiPath === 'broker/connections') return fulfill(200, mockBrokerConnections);
    if (apiPath === 'execution/positions/open') return fulfill(200, [executionPosition]);
    if (apiPath === 'execution/trades/recent') return fulfill(200, [executionPosition]);
    if (apiPath === 'execution/trades/closed') return fulfill(200, []);

    if (apiPath === 'live-account/positions') {
      return fulfill(200, { positions: [livePosition], total: 1 });
    }

    if (apiPath === 'execution/capital-allocation') {
      return fulfill(200, {
        brokerConnectionId: mockBrokerConnections[0].id,
        logicalAccountKey: 'paper-broker|demo|paper-acc-001',
        accountCurrency: 'USD',
        brokerEquity: '10000',
        hasAllocation: true,
        allocatedCapital: '2500',
        committedCapital: '250',
        inFlightCommitments: '25',
        pendingOrderCommitments: '50',
        openPositionCommitments: '175',
        availableCapital: '2250',
      });
    }

    if (apiPath === 'market-data/intelligence') return fulfill(200, marketSnapshot);

    if (apiPath.startsWith('trading/sessions/') && apiPath.endsWith('/stop')) {
      return fulfill(200, {
        message: 'AI Trading stopped and all 1 AI-opened positions were confirmed closed.',
        sessionId: '44444444-4444-4444-8444-444444444441',
        positionCloseSummary: {
          state: 'COMPLETE',
          targetCount: 1,
          closedCount: 1,
          unresolvedCount: 0,
        },
      });
    }

    return fulfill(200, {});
  });

  await page.route('**/favicon.ico', (route) => route.fulfill({ status: 204, body: '' }));

  await page.goto('/trade');
  await expect(page.getByTestId('ai-trader-workspace')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'AI Trader' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Stop AI Trading' })).toBeVisible();
  await expect(page.getByText('+41.00 USD', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Stop AI Trading' }).click();

  const dialog = page.getByRole('alertdialog', {
    name: 'Stop AI Trading and close AI positions?',
  });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/stopping also closes ai-opened positions/i)).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Stop & Close AI Positions' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Keep AI Trading Running' })).toBeVisible();
}

test.beforeEach(async ({}, testInfo) => {
  test.skip(!CAPTURE, 'set E2E_CAPTURE_EVIDENCE=1 to capture AI Trader evidence');
  test.skip(!ALLOWED_PROJECTS.has(testInfo.project.name), 'AI Trader evidence: wrong project');
});

test('captures AI Trader stop confirmation in a deterministic authoritative state', async ({ page }) => {
  await setupAiTraderEvidence(page);
  await assertEvidenceDomSafe(page);
  await page.screenshot({ path: evidencePath(page), fullPage: false });
  assertNoExternalRequests(page);
});
