import {
  DIRECT_MT5_PROTOCOL_VERSION,
  DIRECT_MT5_COMMAND_TYPES,
  DIRECT_MT5_EVENT_TYPES,
  parseDirectMt5Command,
  parseDirectMt5Event,
} from './direct-mt5.protocol';

describe('Direct MT5 protocol v2', () => {
  it('pins an immutable protocol version and supported command/event kinds', () => {
    expect(DIRECT_MT5_PROTOCOL_VERSION).toBe('irexpro-direct-mt5-v2');
    expect(DIRECT_MT5_COMMAND_TYPES).toEqual([
      'ACCOUNT_SNAPSHOT',
      'GET_PRICE',
      'GET_OHLCV',
      'LIST_SYMBOLS',
      'GET_SYMBOL_INFO',
      'CALCULATE_MARGIN',
      'PLACE_ORDER',
      'MODIFY_ORDER',
      'CLOSE_ORDER',
      'CLOSE_ALL',
      'LIST_POSITIONS',
      'LIST_ORDERS',
      'GET_ORDER',
      'GET_HISTORY',
    ]);
    expect(DIRECT_MT5_EVENT_TYPES).toEqual([
      'HELLO',
      'HEARTBEAT',
      'ACCOUNT_STATE',
      'COMMAND_RESULT',
      'POSITION_EVENT',
      'ORDER_EVENT',
      'DEAL_EVENT',
      'ERROR',
    ]);
  });

  it('accepts a well-formed idempotent PLACE_ORDER command', () => {
    expect(
      parseDirectMt5Command({
        protocolVersion: DIRECT_MT5_PROTOCOL_VERSION,
        commandId: 'cmd_01HZZZZZZZZZZZZZZZZZZZZZZZ',
        idempotencyKey: 'trade-intent-123',
        connectorId: 'connector-1',
        brokerConnectionId: 'connection-1',
        accountLogin: '113392789',
        brokerServer: 'Broker-Demo',
        accountType: 'DEMO',
        commandType: 'PLACE_ORDER',
        createdAt: '2026-10-24T18:00:00.000Z',
        leaseExpiresAt: '2026-10-24T18:00:30.000Z',
        payload: {
          symbol: 'EURUSD',
          side: 'BUY',
          volume: '0.20',
          stopLoss: '1.08000',
          takeProfit: '1.08500',
          comment: 'irexpro:trade-intent-123',
        },
      }),
    ).toMatchObject({ commandType: 'PLACE_ORDER', idempotencyKey: 'trade-intent-123' });
  });

  it('rejects missing command identity or unsupported command types', () => {
    expect(() =>
      parseDirectMt5Command({
        protocolVersion: DIRECT_MT5_PROTOCOL_VERSION,
        commandId: '',
        idempotencyKey: 'x',
        connectorId: 'connector-1',
        brokerConnectionId: 'connection-1',
        accountLogin: '1',
        brokerServer: 'Demo',
        accountType: 'DEMO',
        commandType: 'PLACE_ORDER',
        createdAt: '2026-10-24T18:00:00.000Z',
        leaseExpiresAt: '2026-10-24T18:00:30.000Z',
        payload: {},
      }),
    ).toThrow('commandId');

    expect(() =>
      parseDirectMt5Command({
        protocolVersion: DIRECT_MT5_PROTOCOL_VERSION,
        commandId: 'cmd-1',
        idempotencyKey: 'x',
        connectorId: 'connector-1',
        brokerConnectionId: 'connection-1',
        accountLogin: '1',
        brokerServer: 'Demo',
        accountType: 'DEMO',
        commandType: 'DELETE_ACCOUNT',
        createdAt: '2026-10-24T18:00:00.000Z',
        leaseExpiresAt: '2026-10-24T18:00:30.000Z',
        payload: {},
      }),
    ).toThrow('commandType');
  });

  it('accepts heartbeat events only when account identity and sequence are present', () => {
    expect(
      parseDirectMt5Event({
        protocolVersion: DIRECT_MT5_PROTOCOL_VERSION,
        eventId: 'evt-1',
        connectorId: 'connector-1',
        brokerConnectionId: 'connection-1',
        accountLogin: '113392789',
        brokerServer: 'Broker-Demo',
        accountType: 'DEMO',
        eventType: 'HEARTBEAT',
        sequence: 42,
        occurredAt: '2026-10-24T18:00:05.000Z',
        payload: { terminalConnected: true, tradingAllowed: true },
      }),
    ).toMatchObject({ eventType: 'HEARTBEAT', sequence: 42 });

    expect(() =>
      parseDirectMt5Event({
        protocolVersion: DIRECT_MT5_PROTOCOL_VERSION,
        eventId: 'evt-2',
        connectorId: 'connector-1',
        brokerConnectionId: 'connection-1',
        accountLogin: '',
        brokerServer: 'Broker-Demo',
        accountType: 'DEMO',
        eventType: 'HEARTBEAT',
        sequence: 0,
        occurredAt: '2026-10-24T18:00:05.000Z',
        payload: {},
      }),
    ).toThrow();
  });


  it('requires the MT5-observed DEMO/LIVE account environment on every command', () => {
    const base = {
      protocolVersion: 'irexpro-direct-mt5-v2',
      commandId: 'cmd-live-1',
      idempotencyKey: 'intent-live-1',
      connectorId: 'connector-1',
      brokerConnectionId: 'connection-1',
      accountLogin: '113392789',
      brokerServer: 'Broker-Live',
      commandType: 'GET_PRICE',
      createdAt: '2026-10-31T10:00:00.000Z',
      leaseExpiresAt: '2026-10-31T10:00:30.000Z',
      payload: { instrument: 'EURUSD' },
    };
    expect(parseDirectMt5Command({ ...base, accountType: 'LIVE' })).toMatchObject({ accountType: 'LIVE' });
    expect(() => parseDirectMt5Command(base)).toThrow('accountType');
    expect(() => parseDirectMt5Command({ ...base, accountType: 'CONTEST' })).toThrow('accountType');
  });

  it('rejects wrong protocol versions and invalid timestamps', () => {
    expect(() =>
      parseDirectMt5Event({
        protocolVersion: 'v0',
        eventId: 'evt-1',
        connectorId: 'connector-1',
        brokerConnectionId: 'connection-1',
        accountLogin: '1',
        brokerServer: 'Demo',
        accountType: 'DEMO',
        eventType: 'HEARTBEAT',
        sequence: 1,
        occurredAt: 'not-a-date',
        payload: {},
      }),
    ).toThrow();
  });
});
