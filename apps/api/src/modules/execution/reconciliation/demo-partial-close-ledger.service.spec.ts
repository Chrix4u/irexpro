import { DataSource } from 'typeorm';
import { DemoPartialCloseLedgerService } from './demo-partial-close-ledger.service';

const trade = {
  id: 'trade-1',
  broker_connection_id: 'connection-1',
  external_position_id: 'provider-position-1',
  lot_size: '0.0200',
  account_currency: 'EUR',
  status: 'OPEN',
  strategy_route: 'CONFIRMED_REVERSAL',
  broker_id: 'ctrader',
  account_type: 'DEMO',
  connection_currency: 'EUR',
  logical_account_key: 'ctrader|broker|account',
  connection_logical_account_key: 'ctrader|broker|account',
  session_status: 'ACTIVE',
  execution_mode: 'FULL_AUTO',
  session_currency: 'EUR',
};
const leg = {
  id: 'leg-1',
  client_order_id: 'zai-p1-partial-trade-1',
  state: 'RESERVED',
  original_lots: '0.0200',
  requested_close_lots: '0.0100',
  broker_position_id: 'provider-position-1',
  broker_connection_id: 'connection-1',
  account_currency: 'EUR',
};

function harness(
  opts: {
    trade?: Record<string, unknown> | null;
    existing?: Record<string, unknown> | null;
    inserted?: Record<string, unknown> | null;
  } = {},
) {
  const query = jest.fn(async (sql: string, _params?: unknown[]) => {
    if (sql.includes('FROM trading.trades t')) {
      return opts.trade === null ? [] : [opts.trade ?? trade];
    }
    if (sql.includes('FROM trading.demo_partial_close_legs')) {
      return opts.existing ? [opts.existing] : [];
    }
    if (sql.includes('INSERT INTO trading.demo_partial_close_legs')) {
      return opts.inserted === null ? [] : [opts.inserted ?? leg];
    }
    throw new Error('unexpected query');
  });
  const manager = { query };
  const transaction = jest.fn(async (fn: (tx: { query: typeof query }) => Promise<unknown>) =>
    fn(manager),
  );
  const service = new DemoPartialCloseLedgerService({ transaction } as unknown as DataSource);
  return { service, query, transaction };
}

describe('DEMO P1 partial reservation is tenant-scoped and never broker-authorized', () => {
  it('reserves exact 0.02 -> 0.01 once in a transaction, without dispatch', async () => {
    const { service, query, transaction } = harness();
    const outcome = await service.reservePilot('user-1', 'trade-1');
    expect(outcome).toEqual({
      ledgerId: 'leg-1',
      clientOrderId: 'zai-p1-partial-trade-1',
      state: 'RESERVED',
      originalLots: '0.0200',
      requestedCloseLots: '0.0100',
      idempotent: false,
      canDispatchOrder: false,
    });
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toContain('FOR UPDATE OF t');
    expect(query.mock.calls[0][0]).toContain('JOIN trading.trade_intents ti');
    expect(query.mock.calls[0][0]).toContain('JOIN trading.trading_sessions s');
    expect(query.mock.calls[0][0]).not.toContain('t.strategy_route');
    expect(query.mock.calls[0][1]).toEqual(['user-1', 'trade-1']);
    expect(query.mock.calls[2][1]).toEqual([
      'user-1',
      'trade-1',
      'connection-1',
      'provider-position-1',
      'zai-p1-partial-trade-1',
      'EUR',
      '0.0200',
      '0.0100',
    ]);
  });

  it('returns only an idempotent stored record on a repeat, no fresh insert', async () => {
    const { service, query } = harness({ existing: leg });
    const outcome = await service.reservePilot('user-1', 'trade-1');
    expect(outcome).toMatchObject({
      ledgerId: 'leg-1',
      idempotent: true,
      canDispatchOrder: false,
    });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it.each([
    [null, 'unknown/unowned'],
    [{ ...trade, account_type: 'LIVE' }, 'LIVE'],
    [{ ...trade, broker_id: 'direct-mt5' }, 'other provider'],
    [{ ...trade, status: 'CLOSED' }, 'closed'],
    [{ ...trade, session_status: 'ENDED' }, 'session ended'],
    [{ ...trade, execution_mode: 'PAPER_ONLY' }, 'not FULL_AUTO'],
    [{ ...trade, session_currency: 'USD' }, 'session currency switch'],
    [{ ...trade, status: 'RECONCILIATION_PENDING' }, 'ambiguous'],
    [{ ...trade, strategy_route: 'PRIMARY_PLAN_B' }, 'wrong route'],
    [{ ...trade, external_position_id: null }, 'missing provider position'],
    [{ ...trade, account_currency: null }, 'missing historic currency'],
    [{ ...trade, account_currency: 'USD' }, 'changed currency'],
    [{ ...trade, connection_logical_account_key: 'other account' }, 'changed account'],
    [{ ...trade, logical_account_key: null }, 'missing immutable account'],
    [{ ...trade, lot_size: '0.0100' }, 'too small'],
    [{ ...trade, lot_size: '0.0400' }, 'pilot too large'],
  ])('rejects %s (%s) without an insert', async (changed, _reason) => {
    const { service, query } = harness({ trade: changed });
    await expect(service.reservePilot('user-1', 'trade-1')).rejects.toThrow();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('refuses stale conflicting broker position instead of returning an old reservation', async () => {
    const { service, query } = harness({
      existing: { ...leg, broker_position_id: 'old-provider-position' },
    });
    await expect(service.reservePilot('user-1', 'trade-1')).rejects.toThrow();
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('refuses a concurrent database uniqueness conflict instead of granting authority', async () => {
    const { service } = harness({ inserted: null });
    await expect(service.reservePilot('user-1', 'trade-1')).rejects.toThrow(
      'conflicting reservation',
    );
  });

  it('fails closed if database queries are unavailable', async () => {
    const query = jest.fn(async () => {
      throw new Error('db unavailable');
    });
    const dataSource = {
      transaction: jest.fn(async (fn: (manager: { query: typeof query }) => Promise<unknown>) =>
        fn({ query }),
      ),
    };
    const service = new DemoPartialCloseLedgerService(dataSource as unknown as DataSource);
    await expect(service.reservePilot('user-1', 'trade-1')).rejects.toThrow('db unavailable');
  });
});
