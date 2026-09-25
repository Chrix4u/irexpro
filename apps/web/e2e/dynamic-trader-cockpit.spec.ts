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

const closedExecution = {
  ...executionPosition,
  id: '55555555-5555-4555-8555-555555555556',
  status: 'CLOSED',
  exitPrice: '1.10177000',
  realisedPnl: '16.70',
  executionReasonCode: null,
  closeReason: 'TAKE_PROFIT_HIT',
  openedAt: '2026-08-31T00:31:00.000Z',
  closedAt: '2026-08-31T00:35:00.000Z',
  createdAt: '2026-08-31T00:30:00.000Z',
  updatedAt: '2026-08-31T00:35:00.000Z',
};

const rejectedExecution = {
  ...executionPosition,
  id: '55555555-5555-4555-8555-555555555557',
  status: 'REJECTED',
  fillPrice: null,
  exitPrice: null,
  realisedPnl: null,
  executionReasonCode: 'MARKET_SAFETY_PRICE_DEVIATION_EXCESSIVE',
  openedAt: null,
  closedAt: null,
  createdAt: '2026-08-31T00:50:00.000Z',
  updatedAt: '2026-08-31T00:50:00.000Z',
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

async function gotoAiTrader(
  page: Parameters<typeof setupErrorCollectors>[0],
  options: {
    active?: boolean;
    onStart?: () => void;
    onStop?: () => void;
    failExecutionReads?: boolean;
    failPositionRead?: boolean;
    dropFirstRiskRead?: boolean;
    onRiskRead?: () => void;
    brokerPayload?: unknown[];
    riskContractMismatch?: boolean;
    sessionContractMismatch?: boolean;
    sessionEnvelope?: boolean;
    sessionDataEnvelope?: boolean;
    sessionGenerationString?: boolean;
    failAllocationRead?: boolean;
  } = {},
) {
  setupErrorCollectors(page);
  let riskReadCount = 0;
  await page.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url());
    const apiPath = url.pathname.split('/api/v1/')[1] ?? '';
    const fulfill = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (apiPath === 'auth/refresh') return fulfill(200, mockAuthTokens);
    if (apiPath === 'auth/me') return fulfill(200, mockAuthUser);
    if (apiPath === 'auth/logout') return fulfill(200, { message: 'Logged out' });
    if (apiPath === 'risk/status') {
      riskReadCount += 1;
      options.onRiskRead?.();
      if (options.dropFirstRiskRead && riskReadCount === 1) {
        return route.abort('connectionreset');
      }
      if (options.riskContractMismatch) {
        return fulfill(200, {
          killSwitchActive: false,
          brokerConnected: true,
          canTrade: true,
          limits: { maxOpenTrades: 3 },
        });
      }
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
      if (options.sessionContractMismatch) {
        return fulfill(200, { status: 'ACTIVE' });
      }
      if (options.active === false) {
        if (options.sessionDataEnvelope) return fulfill(200, { data: null });
        return fulfill(200, options.sessionEnvelope ? { session: null } : null);
      }
      const session = {
        id: '44444444-4444-4444-8444-444444444444',
        brokerConnectionId: mockBrokerConnections[0].id,
        executionMode: 'PAPER_ONLY',
        authorityGeneration: options.sessionGenerationString ? '1' : 1,
        status: 'ACTIVE',
        startedAt: '2026-08-31T00:30:00.000Z',
      };
      if (options.sessionDataEnvelope) return fulfill(200, { data: session });
      return fulfill(200, options.sessionEnvelope ? { session } : session);
    }
    if (apiPath === 'broker/connections') {
      return fulfill(200, options.brokerPayload ?? mockBrokerConnections);
    }
    if (apiPath === 'execution/positions/open') {
      return options.failExecutionReads
        ? fulfill(500, { statusCode: 500, message: 'Internal Server Error' })
        : fulfill(200, [executionPosition]);
    }
    if (apiPath === 'execution/trades/recent') {
      return options.failExecutionReads
        ? fulfill(500, { statusCode: 500, message: 'Internal Server Error' })
        : fulfill(200, [rejectedExecution, executionPosition, closedExecution]);
    }
    if (apiPath === 'execution/trades/closed') {
      return options.failExecutionReads
        ? fulfill(500, { statusCode: 500, message: 'Internal Server Error' })
        : fulfill(200, [closedExecution]);
    }
    if (apiPath === 'live-account/positions') {
      return options.failPositionRead
        ? fulfill(500, { statusCode: 500, message: 'Internal Server Error' })
        : fulfill(200, { positions: [livePosition], total: 1 });
    }
    if (apiPath === 'execution/capital-allocation') {
      if (options.failAllocationRead) {
        return fulfill(500, { statusCode: 500, message: 'Internal Server Error' });
      }
      return fulfill(200, {
        brokerConnectionId: mockBrokerConnections[0].id,
        logicalAccountKey: 'paper-broker|demo|demo-001',
        accountCurrency: 'USD',
        brokerEquity: '10000.00000000',
        hasAllocation: true,
        allocatedCapital: '2500.00000000',
        committedCapital: '250.00000000',
        inFlightCommitments: '25.00000000',
        pendingOrderCommitments: '50.00000000',
        openPositionCommitments: '175.00000000',
        availableCapital: '2250.00000000',
      });
    }
    if (apiPath === 'market-data/intelligence') return fulfill(200, marketSnapshot);
    if (apiPath.startsWith('trading/sessions/') && apiPath.endsWith('/automation-status')) {
      return fulfill(200, {
        enabled: true,
        registered: true,
        trading_session_id: '44444444-4444-4444-8444-444444444444',
        active: true,
        instruments: ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCAD', 'USDCHF'],
        timeframe: 'H1',
        interval_seconds: 60,
        source: 'broker',
        last_run_at: '2026-09-19T11:30:00.000Z',
        next_run_at: '2026-09-19T11:31:00.000Z',
        last_decision: 'NO_TRADE',
        last_reason: 'confidence_below_threshold',
        last_confidence_score: 0.54,
        confidence_threshold: 0.6,
        last_publish_failed: false,
      });
    }
    if (apiPath === 'trading/sessions/start') {
      options.onStart?.();
      return fulfill(201, {
        id: '55555555-5555-4555-8555-555555555555',
        brokerConnectionId: mockBrokerConnections[0].id,
        executionMode: 'PAPER_ONLY',
        authorityGeneration: 1,
        status: 'ACTIVE',
        startedAt: '2026-09-18T12:00:00.000Z',
      });
    }
    if (apiPath.startsWith('trading/sessions/') && apiPath.endsWith('/stop')) {
      options.onStop?.();
      return fulfill(200, {
        message: 'AI Trading stopped and all 1 AI-opened positions were confirmed closed.',
        sessionId: '44444444-4444-4444-8444-444444444444',
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

  await page.goto('/trade');
  await expect(page.getByTestId('ai-trader-workspace')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'AI Trader' })).toBeVisible();
}

test.describe('AI Trader novice workflow', () => {
  test('shows broker, allocation, one automation control, positions and AI activity', async ({ page }) => {
    await gotoAiTrader(page);

    await expect(page.getByText('Paper Trading Broker', { exact: false }).first()).toBeVisible();

    const researchUat = page.locator('.ai-research-uat-copy');
    const researchUatHeading = researchUat.getByText(
      'Research PAPER UAT · simulated execution only.',
      { exact: true },
    );
    const researchUatBody = researchUat.getByText(/Accelerated replay may advance multiple simulated market steps/i);
    await expect(researchUatHeading).toBeVisible();
    await expect(researchUatBody).toBeVisible();
    const [researchHeadingBox, researchBodyBox] = await Promise.all([
      researchUatHeading.boundingBox(),
      researchUatBody.boundingBox(),
    ]);
    expect(researchHeadingBox).not.toBeNull();
    expect(researchBodyBox).not.toBeNull();
    expect(researchBodyBox!.y).toBeGreaterThan(researchHeadingBox!.y);

    await expect(page.getByText('10,000.00 USD', { exact: true })).toBeVisible();
    await expect(page.getByText('2,500.00 USD', { exact: true }).first()).toBeVisible();
    const pool = page.getByLabel('AI capital pool breakdown');
    await expect(pool.getByText('Available', { exact: true })).toBeVisible();
    await expect(pool.getByText('2,250.00 USD', { exact: true })).toBeVisible();
    await expect(pool.getByText('Committed now', { exact: true })).toBeVisible();
    await expect(pool.getByText('250.00 USD', { exact: true })).toBeVisible();
    await expect(pool.getByText('Open positions', { exact: true })).toBeVisible();
    await expect(pool.getByText('175.00 USD', { exact: true })).toBeVisible();
    await expect(pool.getByText('Pending orders', { exact: true })).toBeVisible();
    await expect(pool.getByText('50.00 USD', { exact: true })).toBeVisible();
    await expect(pool.getByText('In-flight decisions', { exact: true })).toBeVisible();
    await expect(pool.getByText('25.00 USD', { exact: true })).toBeVisible();
    await expect(page.getByText(/Shared across multiple AI trades/i)).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Broker account' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Stop AI Trading' })).toBeVisible();

    await expect(page.getByRole('heading', { level: 2, name: 'AI Engine Monitor' })).toBeVisible();
    await expect(page.getByText('SCANNING', { exact: true })).toBeVisible();
    await expect(page.getByText(/EURUSD.*GBPUSD.*USDJPY/i)).toBeVisible();
    await expect(page.getByText('NO TRADE', { exact: true })).toBeVisible();
    await expect(page.getByText('54.00% / 60.00% required', { exact: true })).toBeVisible();
    await expect(
      page.getByText('Market setup did not meet the confidence threshold', { exact: true }),
    ).toBeVisible();

    await expect(page.getByRole('heading', { level: 2, name: 'Open Positions' })).toBeVisible();
    await expect(page.getByLabel('Total unrealized profit or loss')).toContainText('+41.00 USD');
    const positionsTable = page.getByRole('table', { name: 'Open positions live performance' });
    await expect(positionsTable).toBeVisible();
    await expect(positionsTable.getByText('EURUSD', { exact: true })).toBeVisible();
    await expect(positionsTable.getByText('+41.00 USD', { exact: true })).toBeVisible();
    await expect(positionsTable.getByRole('columnheader', { name: 'Current' })).toBeVisible();
    await expect(positionsTable.getByRole('columnheader', { name: 'Unrealized P&L' })).toBeVisible();

    await expect(page.getByRole('heading', { level: 2, name: 'Recent AI Activity' })).toBeVisible();
    await expect(page.getByText('OPEN', { exact: true }).first()).toBeVisible();
    await expect(
      page.getByText(/execution quote was too far from the risk-validated reference price/i),
    ).toBeVisible();

    const closedTrades = page.locator('.ai-section--closed-trades');
    await expect(closedTrades.getByText('CLOSED', { exact: true })).toBeVisible();
    await expect(closedTrades.getByText('+16.70 USD', { exact: true })).toBeVisible();
    await expect(closedTrades.getByText('Entry', { exact: true })).toBeVisible();
    await expect(closedTrades.getByText('1.10010000', { exact: true })).toBeVisible();
    await expect(closedTrades.getByText('Exit', { exact: true })).toBeVisible();
    await expect(closedTrades.getByText('1.10177000', { exact: true })).toBeVisible();
    await expect(closedTrades.getByText('TAKE PROFIT HIT', { exact: true })).toBeVisible();

    const recentActivity = page.locator('.ai-section--activity');
    const positionsSection = page.locator('.ai-section--positions');
    const closedScroll = closedTrades.locator('.ai-activity-list--scroll');
    const activityScroll = recentActivity.locator('.ai-activity-list--scroll');
    await expect(closedScroll).toBeVisible();
    await expect(activityScroll).toBeVisible();
    await expect(closedScroll).toHaveCSS('overflow-y', 'auto');
    await expect(activityScroll).toHaveCSS('overflow-y', 'auto');

    const viewport = page.viewportSize();
    if (viewport && viewport.width > 980) {
      const [positionsBox, closedBox, activityBox] = await Promise.all([
        positionsSection.boundingBox(),
        closedTrades.boundingBox(),
        recentActivity.boundingBox(),
      ]);
      expect(positionsBox).not.toBeNull();
      expect(closedBox).not.toBeNull();
      expect(activityBox).not.toBeNull();
      expect(closedBox!.y).toBeGreaterThan(positionsBox!.y);
      expect(Math.abs(closedBox!.y - activityBox!.y)).toBeLessThan(2);
      expect(activityBox!.x).toBeGreaterThan(closedBox!.x);
    }

    await expect(page.getByText(/execution mode selector/i)).toHaveCount(0);
    await expect(page.getByText(/trading experience/i)).toHaveCount(0);
    await expect(page.getByText(/configure.*risk/i)).toHaveCount(0);

    await assertNoHorizontalOverflow(page);
    assertNoConsoleErrors(page);
    assertNoFailedRequests(page);
    assertNoExternalRequests(page);
  });


  test('stacks every position metric on its own desktop row', async ({ page }) => {
    await gotoAiTrader(page);

    const viewport = page.viewportSize();
    expect(viewport).not.toBeNull();
    if (!viewport || viewport.width <= 700) {
      test.skip();
      return;
    }

    await page.getByRole('button', { name: 'Grid' }).click();
    const metrics = page.locator('.ai-trade-metrics').first();
    await expect(metrics).toBeVisible();

    const rows = metrics.locator(':scope > div');
    await expect(rows).toHaveCount(6);

    const boxes = await Promise.all(
      Array.from({ length: 6 }, (_, index) => rows.nth(index).boundingBox()),
    );
    for (let index = 1; index < boxes.length; index += 1) {
      expect(boxes[index]).not.toBeNull();
      expect(boxes[index - 1]).not.toBeNull();
      expect(boxes[index]!.y).toBeGreaterThan(boxes[index - 1]!.y);
      expect(Math.abs(boxes[index]!.x - boxes[index - 1]!.x)).toBeLessThan(1);
    }

    await assertNoHorizontalOverflow(page);
    assertNoConsoleErrors(page);
    assertNoFailedRequests(page);
    assertNoExternalRequests(page);
  });


  test('accepts the active-session envelope during rolling deployments', async ({ page }) => {
    await gotoAiTrader(page, { sessionEnvelope: true });

    await expect(page.getByRole('button', { name: 'Stop AI Trading' })).toBeEnabled();
    await expect(page.getByText(/AI session status could not be verified/i)).toHaveCount(0);
    await expect(
      page.locator('.ai-overview-card').filter({ hasText: 'AI session' }).getByText('ACTIVE', {
        exact: true,
      }),
    ).toBeVisible();

    assertNoExternalRequests(page);
  });

  test('accepts deployed data-envelope and canonical string session generation', async ({ page }) => {
    await gotoAiTrader(page, {
      sessionDataEnvelope: true,
      sessionGenerationString: true,
    });

    await expect(page.getByRole('button', { name: 'Stop AI Trading' })).toBeEnabled();
    await expect(page.getByText(/AI session status could not be verified/i)).toHaveCount(0);
    await expect(
      page.locator('.ai-overview-card').filter({ hasText: 'AI session' }).getByText('ACTIVE', {
        exact: true,
      }),
    ).toBeVisible();

    const allocationInput = page.getByRole('textbox', { name: 'AI capital allocation amount' });
    const allocateButton = page.getByRole('button', { name: 'Allocate' });
    const [inputBox, buttonBox] = await Promise.all([
      allocationInput.boundingBox(),
      allocateButton.boundingBox(),
    ]);
    expect(inputBox?.height).toBe(buttonBox?.height);

    assertNoExternalRequests(page);
  });

  test('keeps an already-connected broker visible when optional broker metadata is omitted', async ({ page }) => {
    const historicalConnectedBroker = {
      id: mockBrokerConnections[0].id,
      brokerId: mockBrokerConnections[0].brokerId,
      brokerName: mockBrokerConnections[0].brokerName,
      accountType: 'DEMO',
      status: 'CONNECTED',
      // Intentionally omit displayName, authorizationStatus,
      // liveTradingEnabled, health/error metadata and newer identity fields.
      // The UI must preserve the connected account while execution metadata
      // degrades fail-closed.
    };

    await gotoAiTrader(page, {
      active: false,
      brokerPayload: [historicalConnectedBroker],
    });

    await expect(page.getByText('Paper Trading Broker', { exact: false }).first()).toBeVisible();
    await expect(page.getByText('No broker connected', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Start AI Trading' })).toBeVisible();
    await expect(page.getByText(/Something went wrong\. Please try again\./i)).toHaveCount(0);

    assertNoExternalRequests(page);
  });

  test('keeps the connected broker visible when risk and session control state are unavailable', async ({ page }) => {
    await gotoAiTrader(page, {
      riskContractMismatch: true,
      sessionContractMismatch: true,
    });

    await expect(page.getByText('Paper Trading Broker', { exact: false }).first()).toBeVisible();
    await expect(page.getByText('No broker connected', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Connect broker' })).toHaveCount(0);
    await expect(page.getByText(/Risk protection status could not be verified/i)).toBeVisible();
    await expect(page.getByText(/AI session status could not be verified/i)).toBeVisible();

    const startButton = page.getByRole('button', { name: 'Start AI Trading' });
    await expect(startButton).toBeVisible();
    await expect(startButton).toBeDisabled();
    await expect(page.getByText('UNAVAILABLE', { exact: true })).toBeVisible();
    await expect(page.getByText(/Something went wrong\. Please try again\./i)).toHaveCount(0);

    assertNoExternalRequests(page);
  });

  test('keeps broker identity visible when capital allocation temporarily fails', async ({ page }) => {
    await gotoAiTrader(page, { active: false, failAllocationRead: true });

    await expect(page.getByText('Paper Trading Broker', { exact: false }).first()).toBeVisible();
    await expect(page.getByText('No broker connected', { exact: true })).toHaveCount(0);
    await expect(
      page.getByText(/broker account is connected, but its AI capital allocation could not be loaded/i),
    ).toBeVisible();
    await expect(page.getByText(/Something went wrong\. Please try again\./i)).toHaveCount(0);

    assertNoExternalRequests(page);
  });

  test('keeps Start/Stop controls usable when activity and position reads return 5xx', async ({ page }) => {
    await gotoAiTrader(page, {
      active: false,
      failExecutionReads: true,
      failPositionRead: true,
    });

    await expect(
      page.getByText(/AI Trading controls are available, but recent activity or position details could not be loaded/i),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Start AI Trading' })).toBeVisible();
    await expect(page.getByText(/Unable to reach the server/i)).toHaveCount(0);
    await expect(page.getByText(/No open positions/i)).toBeVisible();
    await expect(page.getByText(/No execution activity yet/i)).toBeVisible();

    assertNoExternalRequests(page);
  });

  test('recovers from a transient network reset on a core AI Trading read', async ({ page }) => {
    let riskReads = 0;
    await gotoAiTrader(page, {
      dropFirstRiskRead: true,
      onRiskRead: () => {
        riskReads += 1;
      },
    });

    // The heading is static and renders before the async terminal reads finish.
    // Wait for a broker-backed control so the assertion proves the one-shot
    // network retry actually completed.
    await expect(page.getByText('Paper Trading Broker', { exact: false }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Stop AI Trading' })).toBeVisible();
    await expect(page.getByText(/Unable to reach the server/i)).toHaveCount(0);
    expect(riskReads).toBe(2);

    await assertNoHorizontalOverflow(page);
    // The deliberately injected connection reset is expected to emit
    // net::ERR_CONNECTION_RESET in Chromium's console; do not treat that
    // synthetic transport failure itself as an application console defect.
    assertNoExternalRequests(page);
  });

  test('requires explicit confirmation before starting AI Trading', async ({ page }) => {
    let startRequests = 0;
    await gotoAiTrader(page, {
      active: false,
      onStart: () => {
        startRequests += 1;
      },
    });

    await page.getByRole('button', { name: 'Start AI Trading' }).click();

    const dialog = page.getByRole('alertdialog', { name: 'Start AI Trading?' });
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByText(/begin trading this broker account automatically/i),
    ).toBeVisible();
    expect(startRequests).toBe(0);

    await dialog.getByRole('button', { name: 'Start AI Trading' }).click();
    expect(startRequests).toBe(1);
    await expect(dialog).toHaveCount(0);

    assertNoExternalRequests(page);
  });

  test('requires confirmation before stopping and warns that AI positions will close', async ({ page }) => {
    let stopRequests = 0;
    await gotoAiTrader(page, { onStop: () => { stopRequests += 1; } });

    await page.getByRole('button', { name: 'Stop AI Trading' }).click();

    const dialog = page.getByRole('alertdialog', {
      name: 'Stop AI Trading and close AI positions?',
    });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/stopping also closes ai-opened positions/i)).toBeVisible();
    expect(stopRequests).toBe(0);

    await dialog.getByRole('button', { name: 'Stop & Close AI Positions' }).click();
    expect(stopRequests).toBe(1);
    await expect(dialog).toHaveCount(0);

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
      await expect(page.getByRole('button', { name: 'Stop AI Trading' })).toBeVisible();
    }

    assertNoConsoleErrors(page);
    assertNoFailedRequests(page);
    assertNoExternalRequests(page);
  });
});
