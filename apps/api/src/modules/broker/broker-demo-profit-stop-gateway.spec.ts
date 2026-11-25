import { BrokerService } from './broker.service';
import { BrokerMode, BrokerConnectionStatus } from './interfaces/broker-adapter.interface';

const USER = 'owner-user';
const CONNECTION = 'conn-owner-demo';
const LEDGER = 'ledger-verified';
const POSITION = 'position-123';
const initial = {
  externalOrderId: POSITION,
  instrument: 'USDJPY',
  direction: 'SELL',
  lotSize: '0.1000',
  openPrice: '159.072',
  currentPrice: '159.042',
  stopLoss: '159.119',
  takeProfit: '158.989',
  unrealisedPnl: '10',
  openedAt: new Date(),
  commission: '-0.6',
  swap: '0',
};
const after = { ...initial, stopLoss: '159.060' };
const validIntent = () => ({
  id: LEDGER,
  user_id: USER,
  broker_connection_id: CONNECTION,
  broker_position_id: POSITION,
  broker_id: 'pepperstone-ctrader',
  account_type: 'DEMO',
  account_currency: 'USD',
  state: 'DISPATCHING',
  instrument: 'USDJPY',
  direction: 'SELL',
  trade_lots: '0.1000',
  original_stop: '159.119',
  proposed_positive_stop: '159.060',
  entry_price: '159.072',
  original_take_profit: '158.989',
  estimated_net_floor_after_reserve: '5.20',
  broker_quote_at: new Date(),
  expires_at: new Date(Date.now() + 60000),
  trade_status: 'OPEN',
  trade_stop: '159.119',
  trade_tp: '158.989',
  trade_lots_current: '0.1000',
  trade_position: POSITION,
  active_session: true,
  trade_route: 'EARLY_TRANSITION',
  strategy_route: 'EARLY_TRANSITION',
});
const connection = () => ({
  id: CONNECTION,
  userId: USER,
  brokerId: 'pepperstone-ctrader',
  accountType: BrokerMode.DEMO,
  accountCurrency: 'USD',
  status: BrokerConnectionStatus.CONNECTED,
  encryptedCredentials: 'encrypted',
  credentialIv: 'iv',
  credentialTag: 'tag',
  encryptionKeyId: 'env-key-v1',
});

function fixture(
  overrides: {
    intent?: Record<string, unknown>;
    connection?: Record<string, unknown>;
    quote?: Record<string, unknown>;
    before?: Record<string, unknown>;
    after?: Record<string, unknown>;
    dispatchClaimed?: boolean;
    ack?: Record<string, unknown>;
    throwAmend?: boolean;
    spec?: Record<string, unknown>;
  } = {},
) {
  const intent = { ...validIntent(), ...overrides.intent };
  const query = jest.fn(async (sql: string) => {
    if (sql.includes('SELECT l.id')) return [intent];
    if (sql.includes('UPDATE trading.demo_profit_stop_amendment_intents l'))
      return overrides.dispatchClaimed === false ? [] : [{ id: LEDGER }];
    if (sql.includes("SET state='ACKNOWLEDGED'")) return [{ id: LEDGER }];
    if (sql.includes("SET state='NEEDS_MANUAL_RECONCILIATION'")) return [{ id: LEDGER }];
    return [];
  });
  const modifyOrder = overrides.throwAmend
    ? jest.fn(async () => {
        throw new Error('simulated provider timeout');
      })
    : jest.fn(async () => ({
        ...{ success: true, status: 'FILLED', externalOrderId: POSITION },
        ...overrides.ack,
      }));
  const getOpenPositions = jest
    .fn()
    .mockResolvedValueOnce([{ ...initial, ...overrides.before }])
    .mockResolvedValueOnce([{ ...after, ...overrides.after }]);
  const adapter = {
    setMode: jest.fn(),
    connect: jest.fn().mockResolvedValue({ success: true }),
    getOpenPositions,
    getInstrumentList: jest.fn().mockResolvedValue([
      {
        symbol: 'USDJPY',
        digits: 3,
        minLot: '0.01',
        maxLot: '100',
        lotStep: '0.01',
        contractSize: '100000',
        minStopLossDistance: '0',
        minStopLossDistanceUnit: 'POINTS',
        ...overrides.spec,
      },
    ]),
    getCurrentPrice: jest.fn().mockResolvedValue({
      instrument: 'USDJPY',
      bid: '159.041',
      ask: '159.043',
      spread: '0.002',
      timestamp: new Date(),
      ...overrides.quote,
    }),
    modifyOrder,
  };
  const decrypt = jest.fn().mockReturnValue({ apiKey: 'secret-only-in-memory', accountId: '123' });
  const srv = Object.create(BrokerService.prototype) as BrokerService;
  Object.assign(srv, {
    findConnectionById: jest.fn().mockResolvedValue({ ...connection(), ...overrides.connection }),
    assertCredentialsUsable: jest.fn(),
    connectionRepo: { manager: { query } },
    adapterRegistry: { getAdapterForConnection: jest.fn().mockReturnValue(adapter) },
    encryptionService: { decrypt },
  });
  return { srv, query, adapter, modifyOrder, decrypt, getOpenPositions };
}

describe('internal owner-DEMO broker stop amendment with one-shot durable dispatch', () => {
  const oldFlag = process.env.IREXPRO_PEPPERSTONE_DEMO_PROTECTED_RUNNER_AMEND;
  const oldOwner = process.env.VPS_FOREX_SCANNER_USER_ID;
  beforeEach(() => {
    process.env.IREXPRO_PEPPERSTONE_DEMO_PROTECTED_RUNNER_AMEND = 'enabled';
    process.env.VPS_FOREX_SCANNER_USER_ID = USER;
  });
  afterAll(() => {
    if (oldFlag === undefined) delete process.env.IREXPRO_PEPPERSTONE_DEMO_PROTECTED_RUNNER_AMEND;
    else process.env.IREXPRO_PEPPERSTONE_DEMO_PROTECTED_RUNNER_AMEND = oldFlag;
    if (oldOwner === undefined) delete process.env.VPS_FOREX_SCANNER_USER_ID;
    else process.env.VPS_FOREX_SCANNER_USER_ID = oldOwner;
  });
  const call = (h: ReturnType<typeof fixture>) =>
    h.srv.amendVerifiedOwnerDemoProfitStop({
      userId: USER,
      connectionId: CONNECTION,
      ledgerId: LEDGER,
    });
  it('fails with the executor flag off before opening credentials or calling broker', async () => {
    delete process.env.IREXPRO_PEPPERSTONE_DEMO_PROTECTED_RUNNER_AMEND;
    const h = fixture();
    await expect(call(h)).rejects.toThrow('disabled');
    expect(h.decrypt).not.toHaveBeenCalled();
    expect(h.modifyOrder).not.toHaveBeenCalled();
  });
  it('never permits LIVE account even with owner flag enabled', async () => {
    const h = fixture({ connection: { accountType: BrokerMode.LIVE } });
    await expect(call(h)).rejects.toThrow('DEMO account required');
    expect(h.modifyOrder).not.toHaveBeenCalled();
  });
  it('requires a durable DISPATCHING intent and an active DEMO trading session', async () => {
    const h = fixture({ intent: { state: 'PREPARED' } });
    await expect(call(h)).rejects.toThrow('not dispatchable');
    expect(h.modifyOrder).not.toHaveBeenCalled();
    const z = fixture({ intent: { active_session: false } });
    await expect(call(z)).rejects.toThrow('not dispatchable');
    expect(z.modifyOrder).not.toHaveBeenCalled();
  });
  it('proves the owner position, natively rounded stop, unchanged TP and fresh quote before ONE amendment', async () => {
    const h = fixture();
    const result = await call(h);
    expect(result).toMatchObject({
      brokerPositionId: POSITION,
      brokerReadbackStop: '159.060',
      brokerReadbackTakeProfit: '158.989',
      executionAuthorityGranted: false,
      liveTradingEnabled: false,
    });
    expect(h.adapter.setMode).toHaveBeenCalledWith(BrokerMode.DEMO);
    expect(h.modifyOrder).toHaveBeenCalledTimes(1);
    expect(h.modifyOrder).toHaveBeenCalledWith(POSITION, {
      newStopLoss: '159.060',
      newTakeProfit: '158.989',
    });
    expect(h.query.mock.calls.some((c) => String(c[0]).includes("SET state='ACKNOWLEDGED'"))).toBe(
      true,
    );
  });
  it('never sends an amendment if the one-shot DB claim loses the race', async () => {
    const h = fixture({ dispatchClaimed: false });
    await expect(call(h)).rejects.toThrow('already claimed');
    expect(h.modifyOrder).not.toHaveBeenCalled();
  });
  it('rejects a stale broker-native quote before provider writes', async () => {
    const h = fixture({ quote: { timestamp: new Date(Date.now() - 30000) } });
    await expect(call(h)).rejects.toThrow('preflight');
    expect(h.modifyOrder).not.toHaveBeenCalled();
  });
  it('rejects an absent published minimum stop-distance unit', async () => {
    const h = fixture({ spec: { minStopLossDistanceUnit: undefined } });
    await expect(call(h)).rejects.toThrow('preflight');
    expect(h.modifyOrder).not.toHaveBeenCalled();
  });
  it('does not accept an already-modified stop as authority to resend an amendment', async () => {
    const h = fixture({ before: { stopLoss: '159.060' } });
    await expect(call(h)).rejects.toThrow('original protection');
    expect(h.modifyOrder).not.toHaveBeenCalled();
  });
  it('quarantines an ambiguous provider timeout and never retries', async () => {
    const h = fixture({ throwAmend: true });
    await expect(call(h)).rejects.toThrow('simulated provider timeout');
    expect(h.modifyOrder).toHaveBeenCalledTimes(1);
    expect(
      h.query.mock.calls.some((c) => String(c[0]).includes("state='NEEDS_MANUAL_RECONCILIATION'")),
    ).toBe(true);
  });
  it('an ACK with no matching provider readback is NOT a verified profit stop', async () => {
    const h = fixture({ after: { stopLoss: '159.119' } });
    await expect(call(h)).rejects.toThrow('readback is not proven');
    expect(
      h.query.mock.calls.some((c) => String(c[0]).includes("state='NEEDS_MANUAL_RECONCILIATION'")),
    ).toBe(true);
    expect(h.query.mock.calls.some((c) => String(c[0]).includes("SET state='ACKNOWLEDGED'"))).toBe(
      false,
    );
  });
  it('does not accept a provider rejection or unspecified ACK as success', async () => {
    const h = fixture({ ack: { success: false, status: 'REJECTED' } });
    await expect(call(h)).rejects.toThrow('not acknowledged');
    expect(
      h.query.mock.calls.some((c) => String(c[0]).includes("state='NEEDS_MANUAL_RECONCILIATION'")),
    ).toBe(true);
  });
});
