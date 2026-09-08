import { test, expect, type Locator, type Page } from '@playwright/test';
import {
  setupErrorCollectors,
  setupAdminAuthInterception,
  assertNoConsoleErrors,
  assertNoFailedRequests,
  assertNoHorizontalOverflow,
} from './fixtures';
import type {
  AdminAuditPage,
  AdminAuditRowView,
  AdminConnectionRowView,
  AdminConnectionsPage,
  AdminDiscrepanciesPage,
  AdminDiscrepancyRowView,
  AdminLiveOpsOverviewView,
} from '@irexpro/types/admin-live-account';

/**
 * Admin Live Operations E2E — Sprint 50 PR-6 (Directive §39).
 *
 * Covers the three admin surfaces added in PR-6:
 *   - /admin/live-ops   — §39 operational overview
 *   - /admin/brokers    — cross-user connection inventory (fail-closed gate)
 *   - /admin/audit      — audit investigation view
 *
 * Auth strategy mirrors the shared fixtures: route interception with the mock
 * ADMIN user (mockAdminUser), so the (protected) layout's hasAdminRole guard
 * passes. The four PR-6 endpoints are mocked with contract-shaped fixtures
 * (respecting limit/offset + filter query params like the backend would).
 * The backend RolesGuard remains the real security boundary.
 */

// ── Shared fixture identities ───────────────────────────────────────────────

const ADMIN_ACTOR = 'usr_admin_00000000-0000-0000-0000-000000000001';
const TRADER_A = 'usr_00000000-0000-0000-0000-000000000002';
const TRADER_B = 'usr_00000000-0000-0000-0000-000000000003';

function jsonFulfill(status: number, body: unknown) {
  return { status, contentType: 'application/json' as const, body: JSON.stringify(body) };
}

// ── Overview fixture ─────────────────────────────────────────────────────────

const CONNECTION_COUNTS = {
  total: 8,
  connected: 5,
  connecting: 0,
  error: 2,
  disconnected: 1,
  suspendedConnectionStatus: 0,
  authorized: 4,
  authorizationRequired: 1,
  revoked: 1,
  suspended: 1,
  demo: 5,
  live: 3,
};

const DISCREPANCY_COUNTS = {
  open: 4,
  openCritical: 1,
  openWarning: 2,
  openInfo: 1,
  resolvedLast24h: 3,
};

const overviewFixture: AdminLiveOpsOverviewView = {
  generatedAt: '2025-07-15T09:30:00.000Z',
  connections: CONNECTION_COUNTS,
  discrepancies: DISCREPANCY_COUNTS,
  activeControls: [
    {
      id: 'ctl_00000000-0000-0000-0000-000000000001',
      scope: 'GLOBAL',
      scopeTarget: null,
      reason: 'Investigating provider reconciliation drift across LIVE connections',
      activatedBy: ADMIN_ACTOR,
      activatedAt: '2025-07-15T08:00:00.000Z',
      expiresAt: null,
    },
    {
      id: 'ctl_00000000-0000-0000-0000-000000000002',
      scope: 'BROKER_CONNECTION',
      scopeTarget: 'conn_00000000-0000-0000-0000-000000000010',
      reason: 'Credential rotation in progress after provider auth failures',
      activatedBy: ADMIN_ACTOR,
      activatedAt: '2025-07-15T08:30:00.000Z',
      expiresAt: '2025-07-16T08:30:00.000Z',
    },
  ],
  providers: [
    {
      brokerId: 'metatrader5',
      brokerName: 'MetaTrader 5',
      capabilities: [
        'MARKET_ORDERS',
        'LIMIT_ORDERS',
        'STOP_ORDERS',
        'STOP_LIMIT_ORDERS',
        'MODIFY_POSITION',
        'CLOSE_POSITION',
        'CLOSE_ALL',
        'TRAILING_STOP',
        'ACCOUNT_INFO',
        'OHLCV_HISTORY',
      ],
      supportsDemo: true,
      supportsLive: true,
    },
    {
      brokerId: 'paper-broker',
      brokerName: 'Paper Broker',
      capabilities: [
        'MARKET_ORDERS',
        'LIMIT_ORDERS',
        'STOP_ORDERS',
        'CLOSE_POSITION',
        'ACCOUNT_INFO',
      ],
      supportsDemo: true,
      supportsLive: false,
    },
    {
      brokerId: 'oanda',
      brokerName: 'OANDA',
      capabilities: [],
      supportsDemo: false,
      supportsLive: false,
    },
  ],
  automation: { activeSessions: 3, suspendedSessions: 1 },
};

// ── Connections fixture (30 rows → exercises 25-row pagination) ─────────────

function connectionRow(i: number): AdminConnectionRowView {
  const n = String(i + 1).padStart(2, '0');
  const isError = i === 5 || i === 20;
  const isSuspended = i === 12;
  const accountType = i % 3 === 0 ? 'LIVE' : 'DEMO';
  const connectionStatus = isError ? 'ERROR' : isSuspended ? 'SUSPENDED' : 'CONNECTED';
  const authorizationStatus = isError
    ? 'ERROR'
    : isSuspended
      ? 'SUSPENDED'
      : i === 2
        ? 'REVOKED'
        : i === 8
          ? 'AUTHORIZATION_REQUIRED'
          : i % 4 === 0
            ? 'ACTIVE'
            : 'AUTHORIZED';
  const credentialStatus = isError ? 'INVALID' : i === 2 ? 'REVOKED' : 'VERIFIED';
  const executable = !isError && !isSuspended && i !== 2;
  return {
    id: `conn_00000000-0000-0000-0000-0000000000${n}`,
    userId: i % 2 === 0 ? TRADER_A : TRADER_B,
    brokerId: i % 3 === 0 ? 'metatrader5' : 'paper-broker',
    brokerName: `MT5 Broker ${n}`,
    displayName: i % 5 === 0 ? null : `Account ${n}`,
    maskedAccountId: `•••${810000 + i}`,
    accountType,
    connectionStatus,
    authorizationStatus,
    credentialStatus,
    executable,
    liveTradingEnabled: accountType === 'LIVE' && executable,
    lastSyncAt: i % 7 === 0 ? null : `2025-07-${String((i % 28) + 1).padStart(2, '0')}T10:00:00.000Z`,
    lastHealthCheckAt: i % 7 === 0 ? null : `2025-07-${String((i % 28) + 1).padStart(2, '0')}T10:00:00.000Z`,
    lastErrorMessage: isError
      ? i === 5
        ? 'Provider reported repeated authorization timeouts while refreshing the session token during the scheduled health check cycle — see sanitized provider trace 0x1f for the full context'
        : 'MT5 provider rejected the session handshake after 3 attempts (auth timeout)'
      : null,
    openDiscrepancies: i === 20 ? 3 : i === 5 ? 1 : 0,
    createdAt: '2025-06-01T08:00:00.000Z',
    updatedAt: '2025-07-15T09:00:00.000Z',
  };
}

const connectionRows: AdminConnectionRowView[] = Array.from({ length: 30 }, (_, i) =>
  connectionRow(i),
);

function filterConnections(
  rows: AdminConnectionRowView[],
  filter: string,
): AdminConnectionRowView[] {
  switch (filter) {
    case 'CONNECTED':
      return rows.filter((row) => row.connectionStatus === 'CONNECTED');
    case 'ERROR':
      return rows.filter((row) => row.connectionStatus === 'ERROR');
    case 'LIVE':
      return rows.filter((row) => row.accountType === 'LIVE');
    case 'DEMO':
      return rows.filter((row) => row.accountType === 'DEMO');
    default:
      return rows;
  }
}

// ── Discrepancies fixture (12 rows → 2 pages at limit 10) ───────────────────

const DISCREPANCY_TYPES: Array<{
  type: string;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  status: 'OPEN' | 'RESOLVED';
}> = [
  { type: 'ACCOUNT_BALANCE_DRIFT', severity: 'CRITICAL', status: 'OPEN' },
  { type: 'POSITION_MISSING_INTERNALLY', severity: 'WARNING', status: 'OPEN' },
  { type: 'DUPLICATE_PROVIDER_ID', severity: 'INFO', status: 'OPEN' },
  { type: 'ORDER_STATE_MISMATCH', severity: 'CRITICAL', status: 'OPEN' },
  { type: 'FILL_QUANTITY_MISMATCH', severity: 'WARNING', status: 'OPEN' },
  { type: 'ACCOUNT_SYNC_STALE', severity: 'INFO', status: 'OPEN' },
  { type: 'POSITION_MISSING_AT_PROVIDER', severity: 'WARNING', status: 'OPEN' },
  { type: 'PROVIDER_UNKNOWN_ORDER', severity: 'CRITICAL', status: 'OPEN' },
  { type: 'WORKING_ORDER_UNKNOWN', severity: 'WARNING', status: 'OPEN' },
  { type: 'FILL_QUANTITY_MISMATCH', severity: 'WARNING', status: 'RESOLVED' },
  { type: 'DUPLICATE_PROVIDER_ID', severity: 'INFO', status: 'RESOLVED' },
  { type: 'ACCOUNT_BALANCE_DRIFT', severity: 'CRITICAL', status: 'RESOLVED' },
];

const discrepancyRows: AdminDiscrepancyRowView[] = DISCREPANCY_TYPES.map((meta, i) => {
  const n = String(i + 1).padStart(2, '0');
  const resolved = meta.status === 'RESOLVED';
  return {
    id: `dsc_00000000-0000-0000-0000-0000000000${n}`,
    userId: i % 2 === 0 ? TRADER_A : TRADER_B,
    brokerConnectionId: `conn_00000000-0000-0000-0000-0000000000${n}`,
    brokerId: i % 3 === 0 ? 'metatrader5' : 'paper-broker',
    type: meta.type,
    severity: meta.severity,
    status: meta.status,
    internalRefId: `ord_00000000-0000-0000-0000-0000000000${n}`,
    providerRef: `mt5-ticket-${9000 + i}`,
    description: `Internal ${meta.type.toLowerCase().replace(/_/g, ' ')} detected against provider truth for this connection.`,
    detectedAt: `2025-07-15T0${i % 10}:${String((i * 7) % 60).padStart(2, '0')}:00.000Z`,
    resolvedAt: resolved ? '2025-07-15T10:30:00.000Z' : null,
    resolutionNote: resolved ? 'Provider-authoritative close adopted by the reconciliation job.' : null,
  };
});

function filterDiscrepancies(
  rows: AdminDiscrepancyRowView[],
  filter: string,
): AdminDiscrepancyRowView[] {
  switch (filter) {
    case 'OPEN':
      return rows.filter((row) => row.status === 'OPEN');
    case 'RESOLVED':
      return rows.filter((row) => row.status === 'RESOLVED');
    case 'CRITICAL':
      return rows.filter((row) => row.severity === 'CRITICAL');
    case 'WARNING':
      return rows.filter((row) => row.severity === 'WARNING');
    default:
      return rows;
  }
}

// ── Audit fixture (30 rows → exercises 25-row pagination) ───────────────────

const AUDIT_ACTIONS = [
  'ORDER_SUBMITTED',
  'EXECUTION_CONTROL_ACTIVATED',
  'RECONCILIATION_RUN_COMPLETED',
  'BROKER_CONNECTION_CONNECTED',
  'KILL_SWITCH_ACTIVATED',
];

const AUDIT_RESOURCE_TYPES = ['Order', 'ExecutionControl', 'ReconciliationRun', 'BrokerConnection', 'RiskProfile'];

const auditRows: AdminAuditRowView[] = Array.from({ length: 30 }, (_, i) => ({
  id: `aud_00000000-0000-0000-0000-0000000000${String(i + 1).padStart(2, '0')}`,
  action: AUDIT_ACTIONS[i % 5],
  actorType: i % 5 === 1 ? 'ADMIN' : i % 5 === 2 ? 'SYSTEM' : 'USER',
  actorUserId: i % 2 === 0 ? TRADER_A : TRADER_B,
  resourceType: AUDIT_RESOURCE_TYPES[i % 5],
  resourceId: `res-00000000-0000-0000-0000-0000000000${String(i + 1).padStart(2, '0')}`,
  correlationId: i % 3 === 0 ? null : `corr-${1000 + i}`,
  severity: i % 3 === 0 ? 'CRITICAL' : i % 3 === 1 ? 'WARNING' : 'INFO',
  createdAt: `2025-07-15T${String(i % 24).padStart(2, '0')}:${String((i * 3) % 60).padStart(2, '0')}:00.000Z`,
}));

function filterAuditLogs(
  rows: AdminAuditRowView[],
  filter: string,
  actorUserId: string | null,
  resourceType: string | null,
): AdminAuditRowView[] {
  let logs = rows;
  if (filter === 'CRITICAL') logs = logs.filter((row) => row.severity === 'CRITICAL');
  if (filter === 'WARNING') logs = logs.filter((row) => row.severity === 'WARNING');
  if (actorUserId) logs = logs.filter((row) => row.actorUserId === actorUserId);
  if (resourceType) logs = logs.filter((row) => row.resourceType === resourceType);
  return logs;
}

// ── Route interception (registered AFTER setupAdminAuthInterception so the
//    more specific handlers win Playwright's LIFO route matching) ────────────

interface LiveOpsCapture {
  overview: string[];
  connections: string[];
  discrepancies: string[];
  audit: string[];
}

function readQuery(url: string): URLSearchParams {
  return new URL(url).searchParams;
}

async function setupLiveOpsFixtures(page: Page): Promise<LiveOpsCapture> {
  const capture: LiveOpsCapture = { overview: [], connections: [], discrepancies: [], audit: [] };

  await setupAdminAuthInterception(page);

  await page.route('**/api/v1/admin/live-account/overview**', (route) => {
    capture.overview.push(route.request().url());
    return route.fulfill(jsonFulfill(200, overviewFixture));
  });

  await page.route('**/api/v1/admin/live-account/connections**', (route) => {
    const url = route.request().url();
    capture.connections.push(url);
    const query = readQuery(url);
    const filter = query.get('filter') ?? 'ALL';
    const limit = Number(query.get('limit') ?? 25);
    const offset = Number(query.get('offset') ?? 0);
    const filtered = filterConnections(connectionRows, filter);
    const pageRows = filtered.slice(offset, offset + limit);
    const payload: AdminConnectionsPage = {
      connections: pageRows,
      total: filtered.length,
      limit,
      offset,
    };
    return route.fulfill(jsonFulfill(200, payload));
  });

  await page.route(
    '**/api/v1/admin/live-account/reconciliation/discrepancies**',
    (route) => {
      const url = route.request().url();
      capture.discrepancies.push(url);
      const query = readQuery(url);
      const filter = query.get('filter') ?? 'ALL';
      const limit = Number(query.get('limit') ?? 10);
      const offset = Number(query.get('offset') ?? 0);
      const filtered = filterDiscrepancies(discrepancyRows, filter);
      const pageRows = filtered.slice(offset, offset + limit);
      const payload: AdminDiscrepanciesPage = {
        discrepancies: pageRows,
        total: filtered.length,
        limit,
        offset,
      };
      return route.fulfill(jsonFulfill(200, payload));
    },
  );

  await page.route('**/api/v1/admin/audit/logs**', (route) => {
    const url = route.request().url();
    capture.audit.push(url);
    const query = readQuery(url);
    const filter = query.get('filter') ?? 'ALL';
    const actorUserId = query.get('actorUserId');
    const resourceType = query.get('resourceType');
    const limit = Number(query.get('limit') ?? 25);
    const offset = Number(query.get('offset') ?? 0);
    const filtered = filterAuditLogs(auditRows, filter, actorUserId, resourceType);
    const pageRows = filtered.slice(offset, offset + limit);
    const payload: AdminAuditPage = { logs: pageRows, total: filtered.length, limit, offset };
    return route.fulfill(jsonFulfill(200, payload));
  });

  return capture;
}

async function gotoLiveOpsPage(
  page: Page,
  path: string,
  heading: string | RegExp,
): Promise<LiveOpsCapture> {
  await setupErrorCollectors(page);
  const capture = await setupLiveOpsFixtures(page);
  await page.goto(path);
  await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
  return capture;
}

/** Locate a stat-card value by its exact label text. */
function statValue(page: Page, label: string): Locator {
  return page
    .locator('.stat-card')
    .filter({
      has: page.locator('.stat-card__label', { hasText: new RegExp(`^${label}$`) }),
    })
    .locator('.stat-card__value');
}

// ── /admin/live-ops — §39 operational overview ──────────────────────────────

test.describe('Admin Live Ops overview page', () => {
  test('connection-state and discrepancy stat tiles render contract numbers', async ({ page }) => {
    await gotoLiveOpsPage(page, '/admin/live-ops', /^live ops$/i);

    await expect(statValue(page, 'Total connections')).toHaveText('8');
    await expect(statValue(page, 'Connected')).toHaveText('5');
    await expect(statValue(page, 'Error')).toHaveText('2');
    await expect(statValue(page, 'Authorization required')).toHaveText('1');
    await expect(statValue(page, 'Suspended')).toHaveText('1');
    await expect(statValue(page, 'Revoked')).toHaveText('1');
    await expect(statValue(page, 'Demo accounts')).toHaveText('5');
    await expect(statValue(page, 'Live accounts')).toHaveText('3');

    await expect(statValue(page, 'Open')).toHaveText('4');
    await expect(statValue(page, 'Critical \\(open\\)')).toHaveText('1');
    await expect(statValue(page, 'Warning \\(open\\)')).toHaveText('2');
    await expect(statValue(page, 'Resolved last 24h')).toHaveText('3');

    await expect(statValue(page, 'Active sessions')).toHaveText('3');
    await expect(statValue(page, 'Suspended sessions')).toHaveText('1');

    // Non-zero error/warning tiles get the semantic value coloring.
    await expect(
      page.locator('.stat-card--error .stat-card__label', { hasText: /^Error$/ }),
    ).toBeVisible();
    await expect(
      page.locator('.stat-card--warning .stat-card__label', { hasText: /^Open$/ }),
    ).toBeVisible();

    // generatedAt surfaces with the Refresh control.
    await expect(page.getByText(/Generated 2025-07-15 09:30 UTC/)).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Refresh live operations overview' }),
    ).toBeVisible();
  });

  test('active execution controls list shows GLOBAL and scoped controls', async ({ page }) => {
    await gotoLiveOpsPage(page, '/admin/live-ops', /^live ops$/i);

    const controls = page.locator('.admin-control-card');
    await expect(controls).toHaveCount(2);

    // GLOBAL scope → error badge; the target falls back to "Entire platform".
    const globalCard = controls.first();
    await expect(globalCard.locator('.badge--error')).toHaveText(/global/i);
    await expect(globalCard).toContainText('Entire platform');
    await expect(globalCard).toContainText('Investigating provider reconciliation drift');
    await expect(globalCard).toContainText('Until cleared');

    // BROKER_CONNECTION scope → warning badge with its scope target.
    const scopedCard = controls.nth(1);
    await expect(scopedCard.locator('.badge--warning')).toHaveText(/broker connection/i);
    await expect(scopedCard).toContainText('conn_00000000-0000-0000-0000-000000000010');
    await expect(scopedCard).toContainText('Credential rotation in progress');
    await expect(scopedCard).toContainText('Expires'); // expiresAt renders
  });

  test('provider registry renders brokers, environments, capability chips and +N more', async ({
    page,
  }) => {
    await gotoLiveOpsPage(page, '/admin/live-ops', /^live ops$/i);

    const registry = page.locator('table[aria-label="Provider registry"]');
    await expect(registry.locator('tbody tr')).toHaveCount(3);

    // Capability chips are capped: MetaTrader 5 has 10 → 6 chips + "+4 more".
    const mt5Row = registry.locator('tbody tr').first();
    await expect(mt5Row).toContainText('MetaTrader 5');
    await expect(mt5Row.locator('.admin-chip')).toHaveCount(7); // 6 + the "+4 more" chip
    await expect(mt5Row.locator('.admin-chip--more')).toHaveText('+4 more');

    const paperRow = registry.locator('tbody tr').nth(1);
    await expect(paperRow).toContainText('Paper Broker');
    await expect(paperRow.locator('.admin-chip')).toHaveCount(5); // under the cap — no more chip

    const oandaRow = registry.locator('tbody tr').nth(2);
    await expect(oandaRow).toContainText('OANDA');
    await expect(oandaRow).toContainText('No capabilities');
  });

  test('shows the empty state when no emergency controls are active', async ({ page }) => {
    await gotoLiveOpsPage(page, '/admin/live-ops', /^live ops$/i);
    await expect(page.locator('.admin-control-card')).toHaveCount(2);

    // Override the overview with a zero-controls variant (later route wins),
    // then reload to refetch.
    await page.route('**/api/v1/admin/live-account/overview**', (route) =>
      route.fulfill(jsonFulfill(200, { ...overviewFixture, activeControls: [] })),
    );
    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: /^live ops$/i })).toBeVisible();
    await expect(page.getByText('No active emergency controls')).toBeVisible();
    await expect(page.locator('.admin-control-card')).toHaveCount(0);
  });

  test('discrepancy log renders severity and status badges', async ({ page }) => {
    await gotoLiveOpsPage(page, '/admin/live-ops', /^live ops$/i);

    const table = page.locator('table[aria-label="Reconciliation discrepancies"]');
    await expect(table.locator('tbody tr')).toHaveCount(10);
    // First row is the CRITICAL OPEN fixture.
    await expect(table.locator('tbody tr').first().locator('.badge--error')).toHaveText('CRITICAL');
    await expect(
      table.locator('tbody tr').first().locator('.badge--warning'),
    ).toHaveText('OPEN');
    await expect(table.locator('tbody tr').first()).toContainText('ACCOUNT_BALANCE_DRIFT');
    await expect(page.getByText(/Showing 1–10 of 12/)).toBeVisible();
  });

  test('discrepancy filter CRITICAL refetches with the query param and filters rows', async ({
    page,
  }) => {
    const capture = await gotoLiveOpsPage(page, '/admin/live-ops', /^live ops$/i);

    await page
      .locator('.filter-group__btn', { hasText: /^CRITICAL$/ })
      .first()
      .click();

    const table = page.locator('table[aria-label="Reconciliation discrepancies"]');
    // 4 CRITICAL rows in the fixture.
    await expect(table.locator('tbody tr')).toHaveCount(4);
    await expect(page.getByText(/Showing 1–4 of 4/)).toBeVisible();
    // Every row carries the error severity badge.
    await expect(table.locator('tbody tr .badge--error')).toHaveCount(4);

    expect(
      capture.discrepancies.some((url) => readQuery(url).get('filter') === 'CRITICAL'),
      `Expected a discrepancies request with filter=CRITICAL, got: ${capture.discrepancies.join(', ')}`,
    ).toBe(true);
  });

  test('discrepancy pagination advances the offset and swaps rows', async ({ page }) => {
    const capture = await gotoLiveOpsPage(page, '/admin/live-ops', /^live ops$/i);

    await page.getByRole('button', { name: 'Next discrepancy page' }).click();

    // 12 rows at limit 10 → page 2 shows rows 11–12.
    await expect(page.getByText(/Showing 11–12 of 12/)).toBeVisible();
    expect(
      capture.discrepancies.some((url) => readQuery(url).get('offset') === '10'),
      `Expected a discrepancies request with offset=10, got: ${capture.discrepancies.join(', ')}`,
    ).toBe(true);

    // Previous returns to the first page.
    await page.getByRole('button', { name: 'Previous discrepancy page' }).click();
    await expect(page.getByText(/Showing 1–10 of 12/)).toBeVisible();
  });

  test('refresh button refetches the overview', async ({ page }) => {
    const capture = await gotoLiveOpsPage(page, '/admin/live-ops', /^live ops$/i);

    // Wait for the initial overview load to land before counting requests
    // (the h1 renders before the data does).
    await expect(page.getByText(/Generated 2025-07-15 09:30 UTC/)).toBeVisible();
    const requestsBefore = capture.overview.length;
    expect(requestsBefore).toBeGreaterThan(0);

    await page.getByRole('button', { name: 'Refresh live operations overview' }).click();
    await expect
      .poll(() => capture.overview.length, {
        message: 'overview should be re-requested',
        timeout: 15000,
      })
      .toBeGreaterThan(requestsBefore);
  });

  test('Live Ops navigation entry is reachable', async ({ page }) => {
    await gotoLiveOpsPage(page, '/admin/live-ops', /^live ops$/i);
    const viewport = page.viewportSize();

    if (viewport && viewport.width > 700) {
      // Desktop: sidebar entry, active for the current page.
      const link = page.locator('.sidebar nav a', { hasText: 'Live Ops' });
      await expect(link).toBeVisible();
      await expect(link).toHaveAttribute('href', '/admin/live-ops');
      await expect(link).toHaveAttribute('aria-current', 'page');
    } else {
      // Mobile: inside the "More" bottom sheet.
      await page.getByRole('button', { name: 'More admin navigation' }).click();
      const sheetItem = page.locator('.mobile-sheet__item', { hasText: 'Live ops' });
      await expect(sheetItem).toBeVisible();
    }
  });

  test('page does not horizontally overflow (table container scrolls, page must not)', async ({
    page,
  }) => {
    await gotoLiveOpsPage(page, '/admin/live-ops', /^live ops$/i);
    await expect(page.locator('.admin-control-card').first()).toBeVisible();
    await assertNoHorizontalOverflow(page);
  });

  test('no console errors and no failed requests', async ({ page }) => {
    await gotoLiveOpsPage(page, '/admin/live-ops', /^live ops$/i);
    await expect(page.locator('.admin-control-card').first()).toBeVisible();
    assertNoConsoleErrors(page);
    assertNoFailedRequests(page);
  });

  test('filter buttons meet 44px touch targets on mobile', async ({ page }) => {
    const viewport = page.viewportSize();
    if (!viewport || viewport.width > 700) {
      test.skip();
      return;
    }
    await gotoLiveOpsPage(page, '/admin/live-ops', /^live ops$/i);
    const buttons = page.locator('.filter-group__btn');
    await expect(buttons.first()).toBeVisible();
    const count = await buttons.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      const box = await buttons.nth(i).boundingBox();
      expect(box, `Filter button ${i} has no bounding box`).not.toBeNull();
      if (!box) continue;
      expect(box.height, `Filter button ${i} height=${box.height} < 44`).toBeGreaterThanOrEqual(44);
    }
  });
});

// ── /admin/brokers — connection inventory ───────────────────────────────────

test.describe('Admin Brokers connections page', () => {
  test('renders connection rows, state badges, and the fail-closed execution gate', async ({
    page,
  }) => {
    await gotoLiveOpsPage(page, '/admin/brokers', /^brokers$/i);

    const table = page.locator('table[aria-label="Broker connections"]');
    // 30 fixture rows at limit 25 → first page is full.
    await expect(table.locator('tbody tr')).toHaveCount(25);
    await expect(page.getByText(/Showing 1–25 of 30/)).toBeVisible();

    // Broker + display name: row 01 has no displayName (fixture) → brokerId
    // label fallback; row 02 carries its displayName.
    await expect(table.locator('tbody tr').first()).toContainText('MT5 Broker 01');
    await expect(table.locator('tbody tr').first()).toContainText('Metatrader5');
    await expect(table.locator('tbody tr', { hasText: 'MT5 Broker 02' })).toContainText(
      'Account 02',
    );

    // State badges: the first row is CONNECTED/AUTHORIZED/VERIFIED and
    // executable → success gate text.
    await expect(table.locator('tbody .badge--success').first()).toBeVisible();
    await expect(table.getByText(/Execution enabled/).first()).toBeVisible();

    // Row 06 (index 5) is the ERROR fixture: non-executable + open
    // discrepancies + sanitized last error.
    const errorRow = table.locator('tbody tr', { hasText: 'MT5 Broker 06' });
    await expect(errorRow).toContainText('Execution disabled');
    await expect(errorRow.locator('.badge--error').first()).toBeVisible();
    await expect(errorRow).toContainText('1 open');
    await expect(errorRow).toContainText('repeated authorization timeouts');
    // The full sanitized message is available via the title tooltip.
    await expect(errorRow.locator('.admin-table__error-cell')).toHaveAttribute(
      'title',
      /see sanitized provider trace 0x1f/,
    );

    // Row 07 (index 6, LIVE account) shows the LIVE badge; row 02 (index 1)
    // shows DEMO.
    await expect(table.locator('tbody tr', { hasText: 'MT5 Broker 07' })).toContainText('LIVE');
    await expect(table.locator('tbody tr', { hasText: 'MT5 Broker 02' })).toContainText('DEMO');

    // Masked account ids only — no raw account numbers.
    await expect(table.locator('tbody tr').first()).toContainText('•••810000');
  });

  test('connection filter ERROR refetches with the query param and shows only error rows', async ({
    page,
  }) => {
    const capture = await gotoLiveOpsPage(page, '/admin/brokers', /^brokers$/i);

    await page
      .locator('.filter-group__btn', { hasText: /^ERROR$/ })
      .first()
      .click();

    const table = page.locator('table[aria-label="Broker connections"]');
    // 2 ERROR rows in the fixture.
    await expect(table.locator('tbody tr')).toHaveCount(2);
    await expect(table.locator('tbody tr', { hasText: 'MT5 Broker 06' })).toBeVisible();
    await expect(table.locator('tbody tr', { hasText: 'MT5 Broker 21' })).toBeVisible();
    await expect(page.getByText(/Showing 1–2 of 2/)).toBeVisible();

    expect(
      capture.connections.some((url) => readQuery(url).get('filter') === 'ERROR'),
      `Expected a connections request with filter=ERROR, got: ${capture.connections.join(', ')}`,
    ).toBe(true);
  });

  test('connection pagination advances the offset and swaps rows', async ({ page }) => {
    const capture = await gotoLiveOpsPage(page, '/admin/brokers', /^brokers$/i);

    await page.getByRole('button', { name: 'Next connections page' }).click();

    // 30 rows at limit 25 → page 2 shows rows 26–30.
    await expect(page.getByText(/Showing 26–30 of 30/)).toBeVisible();
    const table = page.locator('table[aria-label="Broker connections"]');
    await expect(table.locator('tbody tr')).toHaveCount(5);
    await expect(table.locator('tbody tr', { hasText: 'MT5 Broker 26' })).toBeVisible();
    // Page-1-only row is gone.
    await expect(table.locator('tbody tr', { hasText: 'MT5 Broker 01' })).toHaveCount(0);

    expect(
      capture.connections.some((url) => readQuery(url).get('offset') === '25'),
      `Expected a connections request with offset=25, got: ${capture.connections.join(', ')}`,
    ).toBe(true);
  });

  test('page does not horizontally overflow', async ({ page }) => {
    await gotoLiveOpsPage(page, '/admin/brokers', /^brokers$/i);
    await expect(page.locator('table[aria-label="Broker connections"] tbody tr').first()).toBeVisible();
    await assertNoHorizontalOverflow(page);
  });

  test('no console errors and no failed requests', async ({ page }) => {
    await gotoLiveOpsPage(page, '/admin/brokers', /^brokers$/i);
    await expect(page.locator('table[aria-label="Broker connections"] tbody tr').first()).toBeVisible();
    assertNoConsoleErrors(page);
    assertNoFailedRequests(page);
  });
});

// ── /admin/audit — audit investigation ──────────────────────────────────────

test.describe('Admin Audit page', () => {
  test('renders audit rows with severity badges and masked actor ids', async ({ page }) => {
    await gotoLiveOpsPage(page, '/admin/audit', /^audit log$/i);

    const table = page.locator('table[aria-label="Audit records"]');
    await expect(table.locator('tbody tr')).toHaveCount(25);
    await expect(page.getByText(/Showing 1–25 of 30/)).toBeVisible();

    // Severity badges for all three severities.
    await expect(table.locator('tbody .badge--error').first()).toHaveText('CRITICAL');
    await expect(table.locator('tbody .badge--warning').first()).toHaveText('WARNING');
    await expect(table.locator('tbody .badge--info').first()).toHaveText('INFO');

    // Action + correlation render in the monospace cell style.
    await expect(table.locator('tbody .admin-table__cell-mono').first()).toBeVisible();
    await expect(table.getByText('ORDER_SUBMITTED').first()).toBeVisible();
    await expect(table.getByText('EXECUTION_CONTROL_ACTIVATED').first()).toBeVisible();

    // Actor ids are masked for display.
    await expect(table.getByText('usr_00000…0002').first()).toBeVisible();

    // The contract carries no metadata / IP / user-agent columns (checked
    // against the table, not the page copy which mentions the guarantee).
    await expect(table.getByText(/user agent/i)).toHaveCount(0);
    await expect(table.getByText(/ip address/i)).toHaveCount(0);
    await expect(table.locator('th', { hasText: /metadata/i })).toHaveCount(0);
    await expect(table.locator('thead th')).toHaveCount(6);
  });

  test('severity filter CRITICAL refetches with the query param and filters rows', async ({
    page,
  }) => {
    const capture = await gotoLiveOpsPage(page, '/admin/audit', /^audit log$/i);

    await page
      .locator('.filter-group__btn', { hasText: /^CRITICAL$/ })
      .first()
      .click();

    const table = page.locator('table[aria-label="Audit records"]');
    // 10 CRITICAL rows in the fixture.
    await expect(table.locator('tbody tr')).toHaveCount(10);
    await expect(table.locator('tbody .badge--error')).toHaveCount(10);
    await expect(page.getByText(/Showing 1–10 of 10/)).toBeVisible();

    expect(
      capture.audit.some((url) => readQuery(url).get('filter') === 'CRITICAL'),
      `Expected an audit request with filter=CRITICAL, got: ${capture.audit.join(', ')}`,
    ).toBe(true);
  });

  test('actorUserId and resourceType filters apply on submit with query params', async ({
    page,
  }) => {
    const capture = await gotoLiveOpsPage(page, '/admin/audit', /^audit log$/i);

    await page.locator('#audit-actor-user-id').fill(TRADER_B);
    await page.locator('#audit-resource-type').fill('BrokerConnection');
    await page.getByRole('button', { name: 'Apply audit filters' }).click();

    const table = page.locator('table[aria-label="Audit records"]');
    // Fixture rows with actorUserId=TRADER_B AND resourceType=BrokerConnection:
    // i % 2 !== 0 (odd) and i % 5 === 3 → i ∈ {3, 13, 23} → 3 rows.
    await expect(table.locator('tbody tr')).toHaveCount(3);
    await expect(page.getByText(/Showing 1–3 of 3/)).toBeVisible();
    // Only TRADER_B actors remain.
    await expect(table.getByText('usr_00000…0003').first()).toBeVisible();
    await expect(table.getByText('usr_00000…0002')).toHaveCount(0);

    const filteredRequest = capture.audit.find(
      (url) =>
        readQuery(url).get('actorUserId') === TRADER_B &&
        readQuery(url).get('resourceType') === 'BrokerConnection',
    );
    expect(
      filteredRequest,
      `Expected an audit request with actorUserId=${TRADER_B} & resourceType=BrokerConnection, got: ${capture.audit.join(', ')}`,
    ).toBeDefined();
  });

  test('audit pagination advances the offset and swaps rows', async ({ page }) => {
    const capture = await gotoLiveOpsPage(page, '/admin/audit', /^audit log$/i);

    await page.getByRole('button', { name: 'Next audit page' }).click();

    await expect(page.getByText(/Showing 26–30 of 30/)).toBeVisible();
    const table = page.locator('table[aria-label="Audit records"]');
    await expect(table.locator('tbody tr')).toHaveCount(5);

    expect(
      capture.audit.some((url) => readQuery(url).get('offset') === '25'),
      `Expected an audit request with offset=25, got: ${capture.audit.join(', ')}`,
    ).toBe(true);
  });

  test('page does not horizontally overflow', async ({ page }) => {
    await gotoLiveOpsPage(page, '/admin/audit', /^audit log$/i);
    await expect(page.locator('table[aria-label="Audit records"] tbody tr').first()).toBeVisible();
    await assertNoHorizontalOverflow(page);
  });

  test('no console errors and no failed requests', async ({ page }) => {
    await gotoLiveOpsPage(page, '/admin/audit', /^audit log$/i);
    await expect(page.locator('table[aria-label="Audit records"] tbody tr').first()).toBeVisible();
    assertNoConsoleErrors(page);
    assertNoFailedRequests(page);
  });
});
