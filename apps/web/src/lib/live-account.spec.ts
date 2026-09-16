import type {
  LiveAccountOrdersPage,
  LiveAccountOverviewView,
  LiveOrderRowView,
} from '@irexpro/types/live-account';
import {
  loadLiveAccountOrders,
  loadLiveAccountOverview,
  loadLiveAccountPositions,
} from './live-account';

/**
 * Runtime contract-guard tests for the Live Account loaders (Directive §36
 * fail-closed validation — a contract mismatch throws instead of trusting
 * unvalidated backend data).
 *
 * Phase F additions:
 * - `environment: 'UNKNOWN'` is a CONTRACT value (environment truth that
 *   could not be established) and must validate — it is never coerced.
 * - The overview connection view ships NO full `accountId` (masked only).
 * - `reconciliationLoaded: false` (partial-failure tri-state) validates.
 */

jest.mock('@/lib/api', () => ({
  api: {
    request: jest.fn(),
  },
}));

import { api } from '@/lib/api';

const requestMock = api.request as jest.Mock;

const UNKNOWN_ENVIRONMENT_OVERVIEW = {
  generatedAt: '2026-09-01T12:00:00.000Z',
  connections: [
    {
      id: 'bconn_11111111-1111-4111-8111-111111111111',
      brokerName: 'MetaTrader 5',
      displayName: null,
      maskedAccountId: '•••4123',
      accountType: 'DEMO',
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
        lastRunAt: null,
        lastRunStatus: null,
        openDiscrepancies: 0,
        openCritical: 0,
        openWarning: 0,
        inSync: true,
      },
      createdAt: '2026-08-01T08:00:00.000Z',
      updatedAt: '2026-09-01T11:59:00.000Z',
    },
  ],
  automation: {
    status: 'IDLE',
    sessionId: null,
    sessionConnectionId: null,
    killSwitchActive: false,
    killSwitchReason: null,
    startedAt: null,
    endedAt: null,
  },
  executionHealth: {
    openPositions: 3,
    workingOrders: 12,
    reconciliationPending: 2,
    rejectedLast24h: 1,
    filledLast24h: 5,
  },
  alerts: [],
  /** Fail-closed truth value: no connection mode proven. */
  environment: 'UNKNOWN',
  hasConnections: true,
} satisfies LiveAccountOverviewView;

describe('loadLiveAccountOverview runtime guards', () => {
  beforeEach(() => {
    requestMock.mockReset();
  });

  it('accepts environment UNKNOWN (fail-closed truth value, never coerced)', async () => {
    requestMock.mockResolvedValue(UNKNOWN_ENVIRONMENT_OVERVIEW);

    const overview = await loadLiveAccountOverview();

    expect(overview.environment).toBe('UNKNOWN');
    expect(overview.hasConnections).toBe(true);
  });

  it('accepts a connection view without any full accountId (masked identifier only)', async () => {
    expect(JSON.stringify(UNKNOWN_ENVIRONMENT_OVERVIEW)).not.toContain('accountId":');
    expect(UNKNOWN_ENVIRONMENT_OVERVIEW.connections[0]).not.toHaveProperty('accountId');

    requestMock.mockResolvedValue(UNKNOWN_ENVIRONMENT_OVERVIEW);

    const overview = await loadLiveAccountOverview();

    expect(overview.connections[0].maskedAccountId).toBe('•••4123');
  });

  it('rejects an environment value outside the contract (fail-closed)', async () => {
    requestMock.mockResolvedValue({
      ...UNKNOWN_ENVIRONMENT_OVERVIEW,
      environment: 'GARBAGE',
    });

    await expect(loadLiveAccountOverview()).rejects.toThrow(
      'Live account overview contract mismatch',
    );
  });

  it('accepts the optional reconciliationLoaded tri-state flag when present', async () => {
    requestMock.mockResolvedValue({
      ...UNKNOWN_ENVIRONMENT_OVERVIEW,
      reconciliationLoaded: false,
    });

    const overview = await loadLiveAccountOverview();

    expect(overview.reconciliationLoaded).toBe(false);
  });

  it('accepts the Sprint 56 round-5 identity fields when present (validated, optional)', async () => {
    requestMock.mockResolvedValue({
      ...UNKNOWN_ENVIRONMENT_OVERVIEW,
      connections: [
        {
          ...UNKNOWN_ENVIRONMENT_OVERVIEW.connections[0],
          providerBrokerIdentity: 'cTrader',
          logicalAccountKey: 'ctrader:1234567',
        },
      ],
    });

    const overview = await loadLiveAccountOverview();

    expect(overview.connections[0].providerBrokerIdentity).toBe('cTrader');
    expect(overview.connections[0].logicalAccountKey).toBe('ctrader:1234567');
  });

  it('rejects a non-string logicalAccountKey (fail-closed on unknown shapes)', async () => {
    requestMock.mockResolvedValue({
      ...UNKNOWN_ENVIRONMENT_OVERVIEW,
      connections: [
        {
          ...UNKNOWN_ENVIRONMENT_OVERVIEW.connections[0],
          logicalAccountKey: 42,
        },
      ],
    });

    await expect(loadLiveAccountOverview()).rejects.toThrow(
      'Live account overview contract mismatch',
    );
  });

  it('rejects a non-boolean reconciliationLoaded value', async () => {
    requestMock.mockResolvedValue({
      ...UNKNOWN_ENVIRONMENT_OVERVIEW,
      reconciliationLoaded: 'nope',
    });

    await expect(loadLiveAccountOverview()).rejects.toThrow(
      'Live account overview contract mismatch',
    );
  });
});

describe('loadLiveAccountPositions runtime guards', () => {
  beforeEach(() => {
    requestMock.mockReset();
  });

  it('accepts position rows with environment UNKNOWN', async () => {
    requestMock.mockResolvedValue({
      positions: [
        {
          id: 'pos_44444444-4444-4444-8444-444444444444',
          brokerConnectionId: 'bconn_11111111-1111-4111-8111-111111111111',
          brokerName: null,
          environment: 'UNKNOWN',
          instrument: 'EURUSD',
          direction: 'BUY',
          lotSize: '0.1000',
          requestedEntryPrice: '1.10000000',
          fillPrice: null,
          stopLoss: '1.09500000',
          takeProfit: '1.11000000',
          trailingStopPips: null,
          status: 'OPEN',
          openedAt: '2026-09-01T09:35:00.000Z',
          createdAt: '2026-09-01T09:34:00.000Z',
        },
      ],
      total: 1,
    });

    const positions = await loadLiveAccountPositions();

    expect(positions.positions[0].environment).toBe('UNKNOWN');
    expect(positions.positions[0].brokerName).toBeNull();
  });

  it('rejects a position environment value outside the contract', async () => {
    requestMock.mockResolvedValue({
      positions: [],
      total: 0,
    });
    requestMock.mockResolvedValueOnce({
      positions: [
        {
          id: 'pos_1',
          brokerConnectionId: 'conn-1',
          brokerName: null,
          environment: 'MYSTERY',
          instrument: 'EURUSD',
          direction: 'BUY',
          lotSize: '0.1000',
          requestedEntryPrice: '1.10000000',
          fillPrice: null,
          stopLoss: '1.09500000',
          takeProfit: '1.11000000',
          trailingStopPips: null,
          status: 'OPEN',
          openedAt: null,
          createdAt: '2026-09-01T09:34:00.000Z',
        },
      ],
      total: 1,
    });

    await expect(loadLiveAccountPositions()).rejects.toThrow(
      'Live account positions contract mismatch',
    );
  });
});

describe('loadLiveAccountOrders runtime guards', () => {
  beforeEach(() => {
    requestMock.mockReset();
  });

  /**
   * A valid order row, every field per the LiveOrderRowView contract. The
   * default status is DISPATCH_COMMITTED — typing the fixture against
   * LiveOrderRowView makes the union membership of DISPATCH_COMMITTED a
   * compile-time guarantee (R7-audit-C A7).
   */
  const orderRow = (overrides: Partial<LiveOrderRowView> = {}): LiveOrderRowView => ({
    id: 'ord_33333333-3333-4333-8333-333333333333',
    brokerConnectionId: 'bconn_11111111-1111-4111-8111-111111111111',
    brokerName: 'MetaTrader 5',
    clientOrderId: 'client-ord-1',
    providerOrderId: null,
    tradeId: null,
    orderKind: 'MARKET',
    timeInForce: 'GTC',
    instrument: 'EURUSD',
    direction: 'BUY',
    requestedQuantity: '0.1000',
    requestedPrice: null,
    stopPrice: null,
    filledQuantity: '0.0000',
    avgFillPrice: null,
    status: 'DISPATCH_COMMITTED',
    rejectReason: null,
    submittedAt: '2026-09-01T11:00:00.000Z',
    finalizedAt: null,
    createdAt: '2026-09-01T10:59:00.000Z',
    ...overrides,
  });

  const ordersPage = (orders: LiveOrderRowView[]): LiveAccountOrdersPage => ({
    orders,
    total: orders.length,
    limit: 50,
    offset: 0,
  });

  it('accepts an in-flight DISPATCH_COMMITTED row under the ALL filter (R7-audit-C A7)', async () => {
    // Round 6 (#365): the API legitimately exposes orders in the
    // dispatch-committed state while the provider call is in flight; ALL is
    // the api-client default filter. The fail-closed guard must validate
    // (not reject) this contract value.
    requestMock.mockResolvedValue(
      ordersPage([orderRow(), orderRow({ id: 'ord-2', status: 'SUBMITTED' })]),
    );

    const page = await loadLiveAccountOrders('ALL', 50, 0);

    expect(page.orders[0].status).toBe('DISPATCH_COMMITTED');
    expect(page.orders[1].status).toBe('SUBMITTED');
    expect(page.total).toBe(2);
  });

  it('accepts a DISPATCH_COMMITTED row under the WORKING filter too (non-terminal state)', async () => {
    requestMock.mockResolvedValue(ordersPage([orderRow()]));

    const page = await loadLiveAccountOrders('WORKING', 50, 0);

    expect(page.orders[0].status).toBe('DISPATCH_COMMITTED');
  });

  it('rejects an order status outside the contract (fail-closed)', async () => {
    const invalidRow = { ...orderRow(), status: 'SOME_UNKNOWN_STATE' };
    requestMock.mockResolvedValue({ orders: [invalidRow], total: 1, limit: 50, offset: 0 });

    await expect(loadLiveAccountOrders('ALL', 50, 0)).rejects.toThrow(
      'Live account orders contract mismatch',
    );
  });

  it('rejects a non-string status value (fail-closed on unknown shapes)', async () => {
    const invalidRow = { ...orderRow(), status: 7 };
    requestMock.mockResolvedValue({ orders: [invalidRow], total: 1, limit: 50, offset: 0 });

    await expect(loadLiveAccountOrders('ALL', 50, 0)).rejects.toThrow(
      'Live account orders contract mismatch',
    );
  });
});
