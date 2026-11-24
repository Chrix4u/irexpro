import { DataSource } from 'typeorm';
import { BrokerService } from '../../broker/broker.service';
import { DemoProfitStopAuthoritySyncService } from './demo-profit-stop-authority-sync.service';

const OWNER = 'owner';
const LEDGER = 'ledger1';
const TRADE = 'trade1';
const CONNECTION = 'connection1';
const POSITION = 'position1';

const proposed = '1.10120000';
const entry = '1.10000000';
const originalStop = '1.09800000';
const tp = '1.10400000';

function makeFixture(overrides?: {
  row?: Record<string, unknown>;
  preliminary?: Record<string, unknown>;
  brokerPosition?: Record<string, unknown>;
  brokerConnection?: Record<string, unknown>;
  tradeCasRows?: Array<{ stop_loss: string }>;
  ledgerCasRows?: Array<{ id: string }>;
}) {
  const now = Date.now();
  const row = {
    id: LEDGER,
    user_id: OWNER,
    trade_id: TRADE,
    broker_connection_id: CONNECTION,
    broker_position_id: POSITION,
    broker_id: 'pepperstone-ctrader',
    account_type: 'DEMO',
    account_currency: 'USD',
    strategy_route: 'EARLY_TRANSITION',
    instrument: 'EURUSD',
    direction: 'BUY',
    trade_lots: '0.9000',
    entry_price: entry,
    original_stop: originalStop,
    original_take_profit: tp,
    proposed_positive_stop: proposed,
    estimated_exit_cost_reserve: '5',
    estimated_net_floor_after_reserve: '10',
    broker_ack_at: new Date(now - 10000),
    expires_at: new Date(now + 600000),
    state: 'ACKNOWLEDGED',
    trade_status: 'OPEN',
    trade_currency: 'USD',
    trade_direction: 'BUY',
    trade_instrument: 'EURUSD',
    trade_lots_current: '0.9000',
    trade_fill: entry,
    trade_stop: originalStop,
    trade_tp: tp,
    trade_provider_position: POSITION,
    trade_logical_key: 'logical1',
    broker_logical_key: 'logical1',
    connection_currency: 'USD',
    connection_type: 'DEMO',
    connection_broker: 'pepperstone-ctrader',
    route_provenance: 'EARLY_TRANSITION',
    ...overrides?.row,
  };
  const prior = {
    ...row,
    ...overrides?.preliminary,
  };
  const position = {
    externalOrderId: POSITION,
    instrument: 'EURUSD',
    direction: 'BUY',
    lotSize: '0.9000',
    openPrice: entry,
    currentPrice: '1.10250000',
    stopLoss: proposed,
    takeProfit: tp,
    ...overrides?.brokerPosition,
  };
  const connection = {
    id: CONNECTION,
    userId: OWNER,
    brokerId: 'pepperstone-ctrader',
    accountType: 'DEMO',
    accountCurrency: 'USD',
    ...overrides?.brokerConnection,
  };
  const queries: string[] = [];
  const writes: string[] = [];
  const query = jest.fn(async (sql: string) => {
    queries.push(sql);
    if (sql.includes('SELECT id, user_id, trade_id')) return [prior];
    throw Error('Unexpected top-level query: ' + sql.slice(0, 70));
  });
  const manager = {
    query: jest.fn(async (sql: string) => {
      queries.push(sql);
      if (sql.includes('SELECT l.id, l.user_id')) return [row];
      if (sql.includes('UPDATE trading.trades')) {
        writes.push('TRADE');
        return overrides?.tradeCasRows ?? [{ stop_loss: proposed }];
      }
      if (sql.includes('UPDATE trading.demo_profit_stop_amendment_intents')) {
        writes.push('LEDGER');
        return overrides?.ledgerCasRows ?? [{ id: LEDGER }];
      }
      throw Error('Unexpected transaction query: ' + sql.slice(0, 70));
    }),
  };
  const transaction = jest.fn(async (cb: (m: typeof manager) => Promise<unknown>) => cb(manager));
  const dataSource = { query, transaction } as unknown as DataSource;
  const getOpenPositionsForConnection = jest.fn().mockResolvedValue({
    connection,
    positions: [position],
  });
  const brokerService = { getOpenPositionsForConnection } as unknown as BrokerService;
  const service = new DemoProfitStopAuthoritySyncService(dataSource, brokerService);
  return { service, query, transaction, manager, queries, writes, getOpenPositionsForConnection };
}

describe('durable owner Pepperstone DEMO profit-stop authority synchronization', () => {
  let oldFlag: string | undefined;
  let oldOwner: string | undefined;
  beforeEach(() => {
    oldFlag = process.env.IREXPRO_PEPPERSTONE_DEMO_STOP_AUTHORITY_SYNC;
    oldOwner = process.env.VPS_FOREX_SCANNER_USER_ID;
    process.env.IREXPRO_PEPPERSTONE_DEMO_STOP_AUTHORITY_SYNC = 'enabled';
    process.env.VPS_FOREX_SCANNER_USER_ID = OWNER;
  });
  afterEach(() => {
    if (oldFlag === undefined) delete process.env.IREXPRO_PEPPERSTONE_DEMO_STOP_AUTHORITY_SYNC;
    else process.env.IREXPRO_PEPPERSTONE_DEMO_STOP_AUTHORITY_SYNC = oldFlag;
    if (oldOwner === undefined) delete process.env.VPS_FOREX_SCANNER_USER_ID;
    else process.env.VPS_FOREX_SCANNER_USER_ID = oldOwner;
  });

  it('commits broker-confirmed positive stop and trade authority atomically, no provider order', async () => {
    const h = makeFixture();
    const result = await h.service.commitVerifiedStop(OWNER, LEDGER);
    expect(result).toMatchObject({
      state: 'AUTHORITY_COMMITTED',
      idempotent: false,
      brokerStop: proposed,
      committedStop: proposed,
      brokerOrderActions: 0,
      canDelayProfitClose: false,
    });
    expect(h.getOpenPositionsForConnection).toHaveBeenCalledWith(CONNECTION, OWNER);
    expect(h.transaction).toHaveBeenCalledTimes(1);
    expect(h.writes).toEqual(['TRADE', 'LEDGER']);
    expect(h.queries.join('\n')).toContain('FOR UPDATE OF t, l');
    expect(h.queries.join('\n')).toContain('AND stop_loss=$6 AND take_profit=$7');
    // Pepperstone cTrader DEMO trade rows have external_position_id=NULL;
    // verified provider position ID lives in external_order_id. A strict
    // external_position_id-only CAS would reject 100% of real DEMO positions.
    expect(h.queries.join('\n')).toContain('COALESCE(external_position_id,external_order_id)=$5');
    expect(h.queries.join('\n')).not.toContain('AND external_position_id=$5');
    expect(h.queries.join('\n')).toContain("AND state='ACKNOWLEDGED'");
  });

  it('is idempotent only when both broker and database already match', async () => {
    const h = makeFixture({ row: { state: 'AUTHORITY_COMMITTED', trade_stop: proposed } });
    const r = await h.service.commitVerifiedStop(OWNER, LEDGER);
    expect(r.idempotent).toBe(true);
    expect(r.canDelayProfitClose).toBe(false);
    expect(h.writes).toEqual([]);
  });

  it('refuses disabled sync and any non-owner caller before reading database', async () => {
    const h = makeFixture();
    process.env.IREXPRO_PEPPERSTONE_DEMO_STOP_AUTHORITY_SYNC = 'disabled';
    await expect(h.service.commitVerifiedStop(OWNER, LEDGER)).rejects.toThrow('disabled');
    process.env.IREXPRO_PEPPERSTONE_DEMO_STOP_AUTHORITY_SYNC = 'enabled';
    await expect(h.service.commitVerifiedStop('other', LEDGER)).rejects.toThrow('disabled');
    expect(h.query).not.toHaveBeenCalled();
    expect(h.getOpenPositionsForConnection).not.toHaveBeenCalled();
  });

  it.each([
    { brokerId: 'icmarkets-ctrader' },
    { accountType: 'LIVE' },
    { accountCurrency: 'EUR' },
    { userId: 'another' },
  ])('rejects a wrong broker account snapshot before transaction %j', async (bad) => {
    const h = makeFixture({ brokerConnection: bad });
    await expect(h.service.commitVerifiedStop(OWNER, LEDGER)).rejects.toThrow();
    expect(h.transaction).not.toHaveBeenCalled();
  });

  it.each([
    { stopLoss: '1.09800000' },
    { stopLoss: '1.10110000' },
    { direction: 'SELL' },
    { lotSize: '1.2' },
    { externalOrderId: 'other-position' },
    { instrument: 'GBPUSD' },
    { takeProfit: '1.10500000' },
    { currentPrice: '1.10120001' },
    { openPrice: '1.09900000' },
  ])('rejects missing or mismatched provider readback before transaction %j', async (bad) => {
    const h = makeFixture({ brokerPosition: bad });
    await expect(h.service.commitVerifiedStop(OWNER, LEDGER)).rejects.toThrow();
    expect(h.transaction).not.toHaveBeenCalled();
  });

  it.each([
    { state: 'PREPARED' },
    { state: 'DISPATCHING' },
    { state: 'BROKER_VERIFIED' },
    { state: 'FAILED' },
  ])('does not treat an unacknowledged intent as ready: %j', async (bad) => {
    const h = makeFixture({ preliminary: bad });
    await expect(h.service.commitVerifiedStop(OWNER, LEDGER)).rejects.toThrow();
    expect(h.getOpenPositionsForConnection).not.toHaveBeenCalled();
  });

  it.each([
    { broker_ack_at: null },
    { expires_at: new Date('2026-01-01') },
    { trade_status: 'CLOSED' },
    { trade_currency: 'EUR' },
    { trade_direction: 'SELL' },
    { trade_instrument: 'GBPUSD' },
    { trade_lots_current: '1.2' },
    { trade_stop: '1.10100000' },
    { trade_tp: '1.10300000' },
    { trade_provider_position: 'other' },
    { trade_logical_key: null },
    { broker_logical_key: 'another' },
    { connection_type: 'LIVE' },
    { connection_currency: 'EUR' },
    { route_provenance: 'CONFIRMED_REVERSAL' },
    { estimated_exit_cost_reserve: '0' },
    { estimated_net_floor_after_reserve: '0' },
  ])('refuses stale/changed broker, account, trade and risk authority %j', async (bad) => {
    const h = makeFixture({ row: bad });
    await expect(h.service.commitVerifiedStop(OWNER, LEDGER)).rejects.toThrow();
    expect(h.writes).toEqual([]);
  });

  it('fails closed on trade CAS rejection without advancing the ledger', async () => {
    const h = makeFixture({ tradeCasRows: [] });
    await expect(h.service.commitVerifiedStop(OWNER, LEDGER)).rejects.toThrow('CAS');
    expect(h.writes).toEqual(['TRADE']);
  });

  it('rejects failed ledger commit, ensuring the DB transaction must rollback', async () => {
    const h = makeFixture({ ledgerCasRows: [] });
    await expect(h.service.commitVerifiedStop(OWNER, LEDGER)).rejects.toThrow(
      'Ledger authority commit failed',
    );
    expect(h.transaction).toHaveBeenCalledTimes(1);
    expect(h.writes).toEqual(['TRADE', 'LEDGER']);
  });

  it('never acts on a provider read failure', async () => {
    const h = makeFixture();
    h.getOpenPositionsForConnection.mockRejectedValue(new Error('broker timeout'));
    await expect(h.service.commitVerifiedStop(OWNER, LEDGER)).rejects.toThrow('timeout');
    expect(h.transaction).not.toHaveBeenCalled();
  });
});
