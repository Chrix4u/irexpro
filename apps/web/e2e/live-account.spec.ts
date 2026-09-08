import { expect, test, type Page } from '@playwright/test';
import type {
  LiveAccountActivityPage,
  LiveAccountOrdersPage,
  LiveAccountOverviewView,
  LiveAccountPositionsView,
  LiveActivityRowView,
  LiveOrderRowView,
} from '@irexpro/types/live-account';
import {
  assertNoConsoleErrors,
  assertNoExternalRequests,
  assertNoFailedRequests,
  assertNoHorizontalOverflow,
  mockAuthTokens,
  mockAuthUser,
  setupErrorCollectors,
} from './fixtures';

/**
 * Sprint 50 PR-5 — Live Account dashboard e2e (Directive PHASE K, §36/§38).
 *
 * Every /api/v1/** call is intercepted with contract-shaped fixtures
 * (packages/types/src/live-account.ts) — no backend, no real broker, no
 * external host. The suite asserts the §36 environment banner, per-connection
 * cards, the fail-closed execution gate, positions/orders/activity panels,
 * offset pagination, and the no-overflow / no-console-error / no-external-
 * request invariants across the configured viewports.
 */

const LIVE_CONNECTION_ID = 'bconn_11111111-1111-4111-8111-111111111111';
const DEMO_CONNECTION_ID = 'bconn_22222222-2222-4222-8222-222222222222';
const SESSION_ID = 'sess_33333333-3333-4333-8333-333333333333';

// ── Overview fixture: LIVE+healthy+executable, DEMO+alert+reconciliation ─────

const mockOverview = {
  generatedAt: '2026-09-01T12:00:00.000Z',
  connections: [
    {
      id: LIVE_CONNECTION_ID,
      brokerName: 'MetaTrader 5',
      displayName: 'Primary live account',
      maskedAccountId: '•••4123',
      accountType: 'LIVE',
      accountCurrency: 'USD',
      accountLeverage: 30,
      connectionStatus: 'CONNECTED',
      authorizationStatus: 'ACTIVE',
      credentialStatus: 'VERIFIED',
      executable: true,
      liveTradingEnabled: true,
      health: 'HEALTHY',
      lastSyncAt: '2026-09-01T11:58:00.000Z',
      lastHealthCheckAt: '2026-09-01T11:59:00.000Z',
      lastErrorMessage: null,
      financial: {
        currency: 'USD',
        balance: '10432.50',
        equity: '10501.23',
        margin: '412.00',
        freeMargin: '10089.23',
        marginLevel: '2551.26',
        openPositionsCount: 3,
        syncedAt: '2026-09-01T11:58:00.000Z',
      },
      reconciliation: {
        lastRunAt: '2026-09-01T11:55:00.000Z',
        lastRunStatus: 'COMPLETED',
        openDiscrepancies: 0,
        openCritical: 0,
        openWarning: 0,
        inSync: true,
      },
      createdAt: '2026-08-01T08:00:00.000Z',
      updatedAt: '2026-09-01T11:59:00.000Z',
    },
    {
      id: DEMO_CONNECTION_ID,
      brokerName: 'Paper Broker',
      displayName: 'Demo paper account',
      maskedAccountId: '•••9001',
      accountType: 'DEMO',
      accountCurrency: 'USD',
      accountLeverage: 1,
      connectionStatus: 'CONNECTED',
      authorizationStatus: 'AUTHORIZED',
      credentialStatus: 'EXPIRED',
      executable: false,
      liveTradingEnabled: false,
      health: 'DEGRADED',
      lastSyncAt: '2026-09-01T10:12:00.000Z',
      lastHealthCheckAt: '2026-09-01T11:40:00.000Z',
      lastErrorMessage: 'Provider health check reported degraded response latency.',
      financial: null,
      reconciliation: {
        lastRunAt: '2026-09-01T11:50:00.000Z',
        lastRunStatus: 'COMPLETED_WITH_WARNINGS',
        openDiscrepancies: 3,
        openCritical: 0,
        openWarning: 3,
        inSync: false,
      },
      createdAt: '2026-07-15T08:00:00.000Z',
      updatedAt: '2026-09-01T11:50:00.000Z',
    },
  ],
  automation: {
    status: 'ACTIVE',
    sessionId: SESSION_ID,
    sessionConnectionId: LIVE_CONNECTION_ID,
    killSwitchActive: false,
    killSwitchReason: null,
    startedAt: '2026-09-01T09:00:00.000Z',
    endedAt: null,
  },
  executionHealth: {
    openPositions: 3,
    workingOrders: 12,
    reconciliationPending: 2,
    rejectedLast24h: 1,
    filledLast24h: 5,
  },
  alerts: [
    {
      kind: 'CREDENTIALS_EXPIRED',
      severity: 'CRITICAL',
      key: 'alert-credentials-expired-demo',
      connectionId: DEMO_CONNECTION_ID,
      brokerName: 'Paper Broker',
      message:
        'Paper Broker credentials have expired; synchronization and automation are blocked for this connection.',
      action: 'Rotate the broker credentials from the broker connections page.',
    },
    {
      kind: 'RECONCILIATION_DISCREPANCIES',
      severity: 'WARNING',
      key: 'alert-reconciliation-discrepancies-demo',
      connectionId: DEMO_CONNECTION_ID,
      brokerName: 'Paper Broker',
      message: '3 open reconciliation discrepancies require attention on the demo connection.',
      action: 'Review the reconciliation status panel.',
    },
    {
      kind: 'ACCOUNT_SYNC_STALE',
      severity: 'INFO',
      key: 'alert-account-sync-stale',
      connectionId: null,
      brokerName: null,
      message: 'One account snapshot is older than 30 minutes.',
      action: 'Refresh the live account or wait for the next synchronization cycle.',
    },
  ],
  /** Worst-case across the two connections (backend-computed). */
  environment: 'LIVE',
  hasConnections: true,
} satisfies LiveAccountOverviewView;

// ── Positions fixture: OPEN + RECONCILIATION_PENDING across environments ────

const mockPositions = {
  positions: [
    {
      id: 'pos_44444444-4444-4444-8444-444444444444',
      brokerConnectionId: LIVE_CONNECTION_ID,
      brokerName: 'MetaTrader 5',
      environment: 'LIVE',
      instrument: 'EURUSD',
      direction: 'BUY',
      lotSize: '0.1000',
      requestedEntryPrice: '1.10000000',
      fillPrice: '1.10010000',
      stopLoss: '1.09500000',
      takeProfit: '1.11000000',
      trailingStopPips: null,
      status: 'OPEN',
      openedAt: '2026-09-01T09:35:00.000Z',
      createdAt: '2026-09-01T09:34:00.000Z',
    },
    {
      id: 'pos_55555555-5555-4555-8555-555555555555',
      brokerConnectionId: LIVE_CONNECTION_ID,
      brokerName: 'MetaTrader 5',
      environment: 'LIVE',
      instrument: 'XAUUSD',
      direction: 'SELL',
      lotSize: '0.0500',
      requestedEntryPrice: '2510.500000',
      fillPrice: '2510.250000',
      stopLoss: '2525.000000',
      takeProfit: '2480.000000',
      trailingStopPips: null,
      status: 'OPEN',
      openedAt: '2026-09-01T10:05:00.000Z',
      createdAt: '2026-09-01T10:04:00.000Z',
    },
    {
      id: 'pos_66666666-6666-4666-8666-666666666666',
      brokerConnectionId: DEMO_CONNECTION_ID,
      brokerName: 'Paper Broker',
      environment: 'DEMO',
      instrument: 'GBPUSD',
      direction: 'BUY',
      lotSize: '0.0200',
      requestedEntryPrice: '1.31250000',
      fillPrice: null,
      stopLoss: '1.30800000',
      takeProfit: '1.32000000',
      trailingStopPips: null,
      status: 'RECONCILIATION_PENDING',
      openedAt: '2026-09-01T10:45:00.000Z',
      createdAt: '2026-09-01T10:44:00.000Z',
    },
  ],
  total: 3,
} satisfies LiveAccountPositionsView;

// ── Orders fixtures: WORKING (12 rows, paginated) + HISTORY (terminal) ───────

const WORKING_INSTRUMENTS = ['EURUSD', 'GBPUSD', 'USDJPY', 'XAUUSD', 'AUDUSD'];

function makeWorkingOrder(index: number): LiveOrderRowView {
  const status: LiveOrderRowView['status'] =
    index === 0
      ? 'RECONCILIATION_PENDING'
      : index % 3 === 1
        ? 'ACKNOWLEDGED'
        : index % 3 === 2
          ? 'PARTIALLY_FILLED'
          : 'SUBMITTED';
  const isLimit = index % 2 === 0;
  return {
    id: `ord-work-${index}`,
    brokerConnectionId: index % 4 === 3 ? DEMO_CONNECTION_ID : LIVE_CONNECTION_ID,
    brokerName: index % 4 === 3 ? 'Paper Broker' : 'MetaTrader 5',
    clientOrderId: `client-work-${index}`,
    providerOrderId: index === 0 ? null : `provider-work-${index}`,
    tradeId: null,
    orderKind: isLimit ? 'LIMIT' : 'MARKET',
    timeInForce: 'GTC',
    instrument: WORKING_INSTRUMENTS[index % WORKING_INSTRUMENTS.length],
    direction: index % 2 === 0 ? 'BUY' : 'SELL',
    requestedQuantity: '0.1000',
    requestedPrice: isLimit ? '1.10500000' : null,
    stopPrice: null,
    filledQuantity: status === 'PARTIALLY_FILLED' ? '0.0400' : '0.0000',
    avgFillPrice: status === 'PARTIALLY_FILLED' ? '1.10490000' : null,
    status,
    rejectReason: null,
    submittedAt: '2026-09-01T11:00:00.000Z',
    finalizedAt: null,
    createdAt: '2026-09-01T10:59:00.000Z',
  };
}

const allWorkingOrders: LiveOrderRowView[] = Array.from({ length: 12 }, (_, index) =>
  makeWorkingOrder(index),
);

const mockHistoryOrders: LiveOrderRowView[] = [
  {
    id: 'ord-hist-0',
    brokerConnectionId: LIVE_CONNECTION_ID,
    brokerName: 'MetaTrader 5',
    clientOrderId: 'client-hist-0',
    providerOrderId: 'provider-hist-0',
    tradeId: 'trade-hist-0',
    orderKind: 'MARKET',
    timeInForce: 'GTC',
    instrument: 'EURUSD',
    direction: 'BUY',
    requestedQuantity: '0.1000',
    requestedPrice: null,
    stopPrice: null,
    filledQuantity: '0.1000',
    avgFillPrice: '1.10020000',
    status: 'FILLED',
    rejectReason: null,
    submittedAt: '2026-08-31T14:00:00.000Z',
    finalizedAt: '2026-08-31T14:00:05.000Z',
    createdAt: '2026-08-31T13:59:55.000Z',
  },
  {
    id: 'ord-hist-1',
    brokerConnectionId: LIVE_CONNECTION_ID,
    brokerName: 'MetaTrader 5',
    clientOrderId: 'client-hist-1',
    providerOrderId: 'provider-hist-1',
    tradeId: null,
    orderKind: 'MARKET',
    timeInForce: 'GTC',
    instrument: 'GBPUSD',
    direction: 'SELL',
    requestedQuantity: '0.0500',
    requestedPrice: null,
    stopPrice: null,
    filledQuantity: '0.0000',
    avgFillPrice: null,
    status: 'REJECTED',
    rejectReason: 'Insufficient margin for the requested position size.',
    submittedAt: '2026-08-31T12:30:00.000Z',
    finalizedAt: '2026-08-31T12:30:02.000Z',
    createdAt: '2026-08-31T12:29:58.000Z',
  },
  {
    id: 'ord-hist-2',
    brokerConnectionId: DEMO_CONNECTION_ID,
    brokerName: 'Paper Broker',
    clientOrderId: 'client-hist-2',
    providerOrderId: 'provider-hist-2',
    tradeId: null,
    orderKind: 'STOP',
    timeInForce: 'DAY',
    instrument: 'USDJPY',
    direction: 'BUY',
    requestedQuantity: '0.0200',
    requestedPrice: '156.500000',
    stopPrice: '156.800000',
    filledQuantity: '0.0000',
    avgFillPrice: null,
    status: 'CANCELLED',
    rejectReason: null,
    submittedAt: '2026-08-30T09:15:00.000Z',
    finalizedAt: '2026-08-30T17:00:00.000Z',
    createdAt: '2026-08-30T09:14:55.000Z',
  },
];

function ordersPage(
  rows: LiveOrderRowView[],
  total: number,
  limit: number,
  offset: number,
): LiveAccountOrdersPage {
  return { orders: rows.slice(offset, offset + limit), total, limit, offset };
}

// ── Activity fixture: 12 rows across two offset pages ────────────────────────

const ACTIVITY_SEED: Array<{
  action: string;
  severity: LiveActivityRowView['severity'];
  resourceType: string | null;
}> = [
  { action: 'ORDER_SUBMITTED', severity: 'INFO', resourceType: 'ORDER' },
  { action: 'ORDER_FILLED', severity: 'INFO', resourceType: 'ORDER' },
  { action: 'RECONCILIATION_RUN_COMPLETED', severity: 'WARNING', resourceType: 'RECONCILIATION_RUN' },
  { action: 'DISCREPANCY_DETECTED', severity: 'WARNING', resourceType: 'RECONCILIATION_DISCREPANCY' },
  { action: 'DISCREPANCY_RESOLVED', severity: 'INFO', resourceType: 'RECONCILIATION_DISCREPANCY' },
  { action: 'BROKER_CONNECTED', severity: 'INFO', resourceType: 'BROKER_CONNECTION' },
  { action: 'ORDER_REJECTED', severity: 'CRITICAL', resourceType: 'ORDER' },
  { action: 'ACCOUNT_SYNCED', severity: 'INFO', resourceType: 'BROKER_ACCOUNT' },
  { action: 'TRADING_SESSION_STARTED', severity: 'INFO', resourceType: 'TRADING_SESSION' },
  { action: 'CREDENTIALS_ROTATED', severity: 'WARNING', resourceType: 'BROKER_CONNECTION' },
  { action: 'EXECUTION_CONTROL_ACTIVATED', severity: 'INFO', resourceType: 'EXECUTION_CONTROL' },
  { action: 'KILL_SWITCH_DEACTIVATED', severity: 'CRITICAL', resourceType: 'RISK_PROFILE' },
];

const mockActivity: LiveActivityRowView[] = ACTIVITY_SEED.map((seed, index) => ({
  id: `audit-act-${index}`,
  action: seed.action,
  resourceType: seed.resourceType,
  resourceId: `res-${index}`,
  severity: seed.severity,
  createdAt: new Date(Date.parse('2026-09-01T12:00:00.000Z') - index * 60_000).toISOString(),
}));

function activityPage(limit: number, offset: number): LiveAccountActivityPage {
  return {
    activity: mockActivity.slice(offset, offset + limit),
    total: mockActivity.length,
    limit,
    offset,
  };
}

// ── Route interception ───────────────────────────────────────────────────────

/**
 * Single-handler interception (the established pattern from
 * trader-terminal.spec.ts / fixtures.ts): one page.route() catches every
 * /api/v1/** request and dispatches on path + query, so there are no
 * route-registration-order ambiguities.
 */
async function setupLiveAccountRoutes(page: Page): Promise<void> {
  await page.route('**/api/v1/**', (route) => {
    const url = new URL(route.request().url());
    const apiPath = url.pathname.split('/api/v1/')[1] ?? '';

    const fulfill = (status: number, body: unknown) =>
      route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify(body),
      });

    // ── Auth (AuthProvider restore + shell) ─────────────────────────────
    if (apiPath === 'auth/refresh') return fulfill(200, mockAuthTokens);
    if (apiPath === 'auth/me') return fulfill(200, mockAuthUser);
    if (apiPath === 'auth/logout') return fulfill(200, { message: 'Logged out' });

    // ── Live account contract routes ────────────────────────────────────
    if (apiPath === 'live-account/overview') return fulfill(200, mockOverview);
    if (apiPath === 'live-account/positions') return fulfill(200, mockPositions);

    if (apiPath === 'live-account/orders') {
      const status = url.searchParams.get('status') ?? 'WORKING';
      const limit = Number(url.searchParams.get('limit') ?? '10');
      const offset = Number(url.searchParams.get('offset') ?? '0');
      if (status === 'HISTORY') {
        return fulfill(200, ordersPage(mockHistoryOrders, mockHistoryOrders.length, limit, offset));
      }
      if (status === 'ALL') {
        const all = [...allWorkingOrders, ...mockHistoryOrders];
        return fulfill(200, ordersPage(all, all.length, limit, offset));
      }
      return fulfill(200, ordersPage(allWorkingOrders, allWorkingOrders.length, limit, offset));
    }

    if (apiPath === 'live-account/activity') {
      const limit = Number(url.searchParams.get('limit') ?? '10');
      const offset = Number(url.searchParams.get('offset') ?? '0');
      return fulfill(200, activityPage(limit, offset));
    }

    // Catch-all: any unhandled /api/v1/ route returns an empty 200 so no test
    // produces a spurious "failed request" from an unmocked call.
    return fulfill(200, {});
  });

  // Silence favicon 404s so they don't show up as failed requests.
  await page.route('**/favicon.ico', (route) => route.fulfill({ status: 204, body: '' }));
}

async function gotoLiveAccount(page: Page): Promise<void> {
  setupErrorCollectors(page);
  await setupLiveAccountRoutes(page);
  await page.goto('/live-account');
  await expect(page.getByRole('heading', { level: 1, name: 'Live Account' })).toBeVisible();
}

/** Deterministic section locator — the page owns these heading ids. */
function liveSection(page: Page, headingId: string) {
  return page.locator(`section[aria-labelledby="${headingId}"]`);
}

// ── Tests ────────────────────────────────────────────────────────────────────

test.describe('Live Account dashboard (Sprint 50 PR-5)', () => {
  test('renders the §36 environment banner and authoritative per-connection state', async ({
    page,
  }) => {
    await gotoLiveAccount(page);

    // §36 banner — worst-case environment (LIVE) straight from the overview.
    const banner = page.getByTestId('live-env-banner');
    await expect(banner).toBeVisible();
    await expect(banner.getByText(/LIVE ACCOUNT — REAL FUNDS AT RISK/i)).toBeVisible();
    await expect(banner.getByText(/snapshot generated/i)).toBeVisible();

    // Account summary per connection.
    const summarySection = liveSection(page, 'live-summary-title');
    await expect(summarySection.getByText('Primary live account', { exact: true })).toBeVisible();
    await expect(summarySection.getByText('Demo paper account', { exact: true })).toBeVisible();
    await expect(summarySection.getByText('•••4123', { exact: true })).toBeVisible();
    await expect(summarySection.getByText('10432.50', { exact: true })).toBeVisible();
    await expect(summarySection.getByText('2551.26', { exact: true })).toBeVisible();
    await expect(
      summarySection.getByText(/no synchronized account data yet/i),
    ).toBeVisible();

    // Broker connection cards for both brokers + fail-closed execution gate.
    const connectionsSection = liveSection(page, 'live-connections-title');
    await expect(connectionsSection.getByText('MetaTrader 5', { exact: true })).toBeVisible();
    await expect(connectionsSection.getByText('Paper Broker', { exact: true })).toBeVisible();
    await expect(connectionsSection.getByText('Demo', { exact: true })).toBeVisible();
    await expect(connectionsSection.getByText('Execution enabled', { exact: true })).toBeVisible();
    await expect(connectionsSection.getByText('Execution disabled', { exact: true })).toBeVisible();
    await expect(connectionsSection.getByText('Degraded', { exact: true })).toBeVisible();
    await expect(connectionsSection.getByText('Expired', { exact: true })).toBeVisible();
    await expect(
      connectionsSection.getByRole('link', { name: 'Manage broker connections' }).first(),
    ).toBeVisible();

    // Automation status.
    const automationSection = liveSection(page, 'live-automation-title');
    await expect(automationSection.getByText('Active', { exact: true })).toBeVisible();
    await expect(
      automationSection.getByRole('link', { name: 'Open the trading workspace' }),
    ).toBeVisible();

    // Execution health tiles — reconciliation-pending is warning-colored.
    const healthSection = liveSection(page, 'live-health-title');
    await expect(healthSection.getByText('Open positions', { exact: true })).toBeVisible();
    await expect(healthSection.getByText('Reconciliation pending', { exact: true })).toBeVisible();
    await expect(healthSection.getByText('12', { exact: true })).toBeVisible();
    await expect(healthSection.getByText('Needs attention', { exact: true })).toBeVisible();

    // Open positions incl. a RECONCILIATION_PENDING row.
    const positionsSection = liveSection(page, 'live-positions-title');
    await expect(positionsSection.getByText('EURUSD', { exact: true })).toBeVisible();
    await expect(positionsSection.getByText('XAUUSD', { exact: true })).toBeVisible();
    await expect(positionsSection.getByText('GBPUSD', { exact: true })).toBeVisible();
    await expect(
      positionsSection.getByText('Reconciliation Pending', { exact: true }).first(),
    ).toBeVisible();

    // Orders default to the WORKING filter with the total count surfaced.
    const ordersSection = liveSection(page, 'live-orders-title');
    await expect(ordersSection.getByText('Showing 10 of 12 orders')).toBeVisible();

    // Reconciliation per connection — demo connection is not in sync.
    const reconciliationSection = liveSection(page, 'live-reconciliation-title');
    await expect(reconciliationSection.getByText('In sync', { exact: true })).toBeVisible();
    await expect(reconciliationSection.getByText('3 open discrepancies', { exact: true })).toBeVisible();
    await expect(
      reconciliationSection.getByText(/last run: completed with warnings/i),
    ).toBeVisible();

    // Alerts panel shows the CRITICAL alert with its remediation hint.
    const alertsCard = page.getByRole('heading', { level: 2, name: 'Alerts' }).locator('..');
    await expect(alertsCard.getByText('Credentials Expired', { exact: true })).toBeVisible();
    await expect(alertsCard.getByText('Critical', { exact: true })).toBeVisible();
    await expect(alertsCard.getByText(/rotate the broker credentials/i)).toBeVisible();

    // Activity timeline renders audited rows.
    await expect(page.getByText('Order Submitted', { exact: true }).first()).toBeVisible();

    // Data-integrity policy footer.
    await expect(page.getByText(/backend-authoritative live account state/i)).toBeVisible();

    await assertNoHorizontalOverflow(page);
    assertNoConsoleErrors(page);
    assertNoFailedRequests(page);
    assertNoExternalRequests(page);
  });

  test('renders the UNKNOWN environment banner when provenance is unprovable (§36 fail-closed)', async ({
    page,
  }) => {
    setupErrorCollectors(page);
    await setupLiveAccountRoutes(page);
    // Later-registered routes take precedence: override ONLY the overview so
    // the server reports UNKNOWN (no connection mode proven).
    await page.route('**/api/v1/live-account/overview', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ...mockOverview, environment: 'UNKNOWN' }),
      }),
    );
    await page.goto('/live-account');
    await expect(page.getByRole('heading', { level: 1, name: 'Live Account' })).toBeVisible();

    // §36 — UNKNOWN is its own cautionary banner, never a silent PAPER claim.
    const banner = page.getByTestId('live-env-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toHaveClass(/live-env-banner--unknown/);
    await expect(
      banner.getByText(/ACCOUNT ENVIRONMENT UNKNOWN — VERIFY BROKER CONNECTION/i),
    ).toBeVisible();
    await expect(banner.getByText(/PAPER TRADING/i)).toHaveCount(0);

    assertNoConsoleErrors(page);
    assertNoFailedRequests(page);
    assertNoExternalRequests(page);
  });

  test('orders filter switches between WORKING and HISTORY and paginates with offset', async ({
    page,
  }) => {
    await gotoLiveAccount(page);

    const ordersSection = liveSection(page, 'live-orders-title');
    const filterGroup = ordersSection.getByRole('group', { name: /order status filter/i });

    // Default WORKING filter is pressed and the first page is shown.
    await expect(filterGroup.getByRole('button', { name: 'Working' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(ordersSection.getByText('Showing 10 of 12 orders')).toBeVisible();
    await expect(ordersSection.getByText('Reconciliation Pending', { exact: true }).first()).toBeVisible();

    // Load more appends the second page fetched with offset=10.
    await ordersSection.getByRole('button', { name: 'Load more orders' }).click();
    await expect(ordersSection.getByText('Showing 12 of 12 orders')).toBeVisible();

    // Switching to HISTORY replaces the list with terminal orders.
    await filterGroup.getByRole('button', { name: 'History' }).click();
    await expect(ordersSection.getByText('Showing 3 of 3 orders')).toBeVisible();
    await expect(ordersSection.getByText('Filled', { exact: true }).first()).toBeVisible();
    await expect(ordersSection.getByText('Rejected', { exact: true })).toBeVisible();
    await expect(ordersSection.getByText('Cancelled', { exact: true })).toBeVisible();
    await expect(
      ordersSection.getByText('Insufficient margin for the requested position size.', {
        exact: true,
      }),
    ).toBeVisible();
    await expect(ordersSection.getByRole('button', { name: 'Load more orders' })).toHaveCount(0);

    await assertNoHorizontalOverflow(page);
    assertNoConsoleErrors(page);
    assertNoFailedRequests(page);
    assertNoExternalRequests(page);
  });

  test('activity timeline paginates with offset and the refresh button reloads state', async ({
    page,
  }) => {
    await gotoLiveAccount(page);

    const activityCard = page
      .getByRole('heading', { level: 2, name: 'Activity Timeline' })
      .locator('..');
    await expect(activityCard.getByText('Showing 10 of 12 activity rows')).toBeVisible();

    // The timeline is bounded and internally scrollable.
    await expect(activityCard.locator('.live-activity-list')).toBeVisible();

    await activityCard.getByRole('button', { name: 'Load more activity' }).click();
    await expect(activityCard.getByText('Showing 12 of 12 activity rows')).toBeVisible();
    await expect(
      activityCard.getByText('Execution Control Activated', { exact: true }),
    ).toBeVisible();
    await expect(activityCard.getByText('Kill Switch Deactivated', { exact: true })).toBeVisible();

    // Refresh reloads every panel from the intercepted contract routes.
    await page.getByRole('button', { name: /refresh live account/i }).click();
    await expect(page.getByTestId('live-env-banner')).toBeVisible();
    await expect(activityCard.getByText('Showing 10 of 12 activity rows')).toBeVisible();
    await expect(
      liveSection(page, 'live-orders-title').getByText('Showing 10 of 12 orders'),
    ).toBeVisible();

    await assertNoHorizontalOverflow(page);
    assertNoConsoleErrors(page);
    assertNoFailedRequests(page);
    assertNoExternalRequests(page);
  });

  test('overview failure keeps independent panels rendering (partial-failure design)', async ({
    page,
  }) => {
    setupErrorCollectors(page);

    await page.route('**/api/v1/**', (route) => {
      const url = new URL(route.request().url());
      const apiPath = url.pathname.split('/api/v1/')[1] ?? '';

      const fulfill = (status: number, body: unknown) =>
        route.fulfill({
          status,
          contentType: 'application/json',
          body: JSON.stringify(body),
        });

      if (apiPath === 'auth/refresh') return fulfill(200, mockAuthTokens);
      if (apiPath === 'auth/me') return fulfill(200, mockAuthUser);

      // The overview endpoint returns an invalid 200 payload; the runtime
      // guards must reject it (fail-closed) while the other panels keep their
      // verified data.
      if (apiPath === 'live-account/overview') {
        return fulfill(200, { environment: 'LIVE', generatedAt: 'not-a-timestamp' });
      }
      if (apiPath === 'live-account/positions') return fulfill(200, mockPositions);
      if (apiPath === 'live-account/orders') {
        const limit = Number(url.searchParams.get('limit') ?? '10');
        const offset = Number(url.searchParams.get('offset') ?? '0');
        return fulfill(
          200,
          ordersPage(allWorkingOrders, allWorkingOrders.length, limit, offset),
        );
      }
      if (apiPath === 'live-account/activity') {
        const limit = Number(url.searchParams.get('limit') ?? '10');
        const offset = Number(url.searchParams.get('offset') ?? '0');
        return fulfill(200, activityPage(limit, offset));
      }

      return fulfill(200, {});
    });
    await page.route('**/favicon.ico', (route) => route.fulfill({ status: 204, body: '' }));

    await page.goto('/live-account');
    await expect(page.getByRole('heading', { level: 1, name: 'Live Account' })).toBeVisible();

    // No environment is claimed when the overview cannot be verified.
    await expect(page.getByTestId('live-env-banner')).toHaveCount(0);
    await expect(page.getByText(/something went wrong/i)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Retry loading' })).toBeVisible();

    // Positions / orders / activity still render their verified payloads.
    await expect(page.getByText('EURUSD', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Showing 10 of 12 orders')).toBeVisible();
    await expect(page.getByText('Showing 10 of 12 activity rows')).toBeVisible();

    await assertNoHorizontalOverflow(page);
    assertNoConsoleErrors(page);
    assertNoFailedRequests(page);
    assertNoExternalRequests(page);
  });

  test('desktop sidebar marks Live Account as the active workspace destination', async ({
    page,
  }) => {
    await gotoLiveAccount(page);
    const viewport = page.viewportSize();
    expect(viewport).not.toBeNull();
    if (!viewport || viewport.width <= 700) {
      test.skip();
      return;
    }

    const nav = page.getByRole('navigation', { name: /primary workspace navigation/i });
    await expect(nav.getByRole('link', { name: 'Live Account' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  test('mobile More sheet exposes Live Account without expanding the bottom bar', async ({
    page,
  }) => {
    await gotoLiveAccount(page);
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
    await expect(sheet.getByRole('link', { name: 'Live Account' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });
});
