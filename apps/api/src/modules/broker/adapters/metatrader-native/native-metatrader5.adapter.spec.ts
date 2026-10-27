import { ProviderDispatchCertainty } from '../../interfaces/provider-dispatch-certainty';
import { BrokerErrorCode } from '../../interfaces/broker-adapter.errors';
import { BrokerMode } from '../../interfaces/broker-adapter.interface';
import { FakeMt5BridgeSession } from './mt5-bridge-fake-session';
import {
  Mt5BridgeAccountIdentity,
  Mt5BridgeCommand,
  Mt5BridgeResponse,
} from './mt5-bridge-protocol';
import { Mt5BridgeSessionRegistry } from './mt5-bridge-session-registry.service';
import { NativeMetaTrader5Adapter } from './native-metatrader5.adapter';

const identity: Mt5BridgeAccountIdentity = {
  accountLogin: '113392789',
  server: 'MetaQuotes-Demo',
  company: 'MetaQuotes Ltd.',
  environment: 'DEMO',
  currency: 'USD',
  leverage: 100,
  marginMode: 'HEDGING',
};

function response(command: Mt5BridgeCommand, payload: unknown): Mt5BridgeResponse {
  return {
    protocolVersion: 1,
    type: 'RESPONSE',
    sessionId: command.sessionId,
    requestId: command.requestId,
    sequence: command.sequence,
    sentAt: new Date().toISOString(),
    nonce: `response-${command.nonce}`,
    ok: true,
    payload,
  };
}

function setup(handler?: (command: Mt5BridgeCommand) => Promise<Mt5BridgeResponse>) {
  const registry = new Mt5BridgeSessionRegistry({ requestTimeoutMs: 20 });
  const session = new FakeMt5BridgeSession({
    sessionId: 'bridge-session-1',
    identity,
    handler:
      handler ??
      (async (command) => {
        switch (command.commandName) {
          case 'GET_ACCOUNT_INFO':
            return response(command, {
              accountId: identity.accountLogin,
              currency: 'USD',
              leverage: 100,
              balance: '10000.00',
              equity: '10020.00',
              margin: '100.00',
              freeMargin: '9920.00',
              marginLevel: '10020.00',
            });
          case 'GET_TICK':
            return response(command, {
              instrument: 'EURUSD',
              bid: '1.10000',
              ask: '1.10020',
              timestamp: '2026-10-25T19:00:00.000Z',
            });
          case 'GET_SYMBOLS':
            return response(command, {
              instruments: [
                {
                  symbol: 'EURUSD',
                  description: 'Euro vs US Dollar',
                  digits: 5,
                  minLot: '0.01',
                  maxLot: '100.00',
                  lotStep: '0.01',
                  contractSize: '100000',
                },
              ],
            });
          case 'CALCULATE_MARGIN':
            return response(command, { requiredMargin: '110.02' });
          case 'LIST_POSITIONS':
            return response(command, { positions: [] });
          case 'LIST_ORDERS':
            return response(command, { orders: [] });
          case 'GET_ORDER':
            return response(command, { order: null });
          case 'GET_HISTORY':
            return response(command, { trades: [] });
          case 'GET_RATES':
            return response(command, { candles: [] });
          case 'PLACE_ORDER':
            return response(command, {
              success: true,
              providerOrderId: 'mt5-position-1001',
              status: 'FILLED',
              filledPrice: '1.10020',
              filledQuantity: '0.10',
              filledAt: '2026-10-25T19:00:01.000Z',
              brokerMessage: 'done',
            });
          case 'CLOSE_IREXPRO_POSITIONS':
            return response(command, { closedCount: 2, failedCount: 0, errors: [] });
          default:
            return response(command, { success: true, status: 'FILLED' });
        }
      }),
  });
  registry.attach('connection-1', session);
  const adapter = new NativeMetaTrader5Adapter(registry, 'connection-1');
  return { registry, session, adapter };
}

const credentials = { accountId: identity.accountLogin };

describe('NativeMetaTrader5Adapter', () => {
  it('connects only to the paired DEMO identity and never needs a broker password', async () => {
    const { adapter } = setup();
    adapter.setMode(BrokerMode.DEMO);

    await expect(adapter.connect(credentials)).resolves.toMatchObject({
      success: true,
      accountId: '113392789',
      accountType: BrokerMode.DEMO,
      currency: 'USD',
    });
    expect(adapter.isConnected()).toBe(true);
  });

  it('fails closed on LIVE mode and account identity mismatch', async () => {
    const { adapter } = setup();
    adapter.setMode(BrokerMode.LIVE);
    await expect(adapter.connect(credentials)).rejects.toMatchObject({
      code: BrokerErrorCode.ENVIRONMENT_MISMATCH,
      dispatchCertainty: ProviderDispatchCertainty.DEFINITELY_NOT_SENT,
    });

    adapter.setMode(BrokerMode.DEMO);
    await expect(adapter.connect({ accountId: '999999' })).rejects.toMatchObject({
      code: BrokerErrorCode.AUTHENTICATION_FAILED,
      dispatchCertainty: ProviderDispatchCertainty.DEFINITELY_NOT_SENT,
    });
  });

  it('maps account, quote, instrument and native margin reads to normalized strings', async () => {
    const { adapter } = setup();
    await adapter.connect(credentials);

    await expect(adapter.getAccountInfo()).resolves.toMatchObject({
      accountId: '113392789',
      balance: '10000.00',
      equity: '10020.00',
      currency: 'USD',
      leverage: 100,
    });
    await expect(adapter.getCurrentPrice('EURUSD')).resolves.toEqual({
      instrument: 'EURUSD',
      bid: '1.10000',
      ask: '1.10020',
      spread: '0.00020',
      timestamp: new Date('2026-10-25T19:00:00.000Z'),
    });
    await expect(adapter.getInstrumentList()).resolves.toMatchObject([
      { symbol: 'EURUSD', contractSize: '100000', minLot: '0.01' },
    ]);
    await expect(
      adapter.getRequiredMargin({ instrument: 'EURUSD', lotSize: '0.10', direction: 'BUY' }),
    ).resolves.toBe('110.02');
  });

  it('places an owned idempotent order through the bound bridge session', async () => {
    const { adapter, session } = setup();
    await adapter.connect(credentials);

    await expect(
      adapter.placeOrder({
        idempotencyKey: 'trade-1:open',
        clientOrderId: 'sig-1',
        instrument: 'EURUSD',
        direction: 'BUY',
        lotSize: '0.10',
        stopLoss: '1.09500',
        takeProfit: '1.11000',
        orderKind: 'MARKET',
        timeInForce: 'GTC',
      }),
    ).resolves.toMatchObject({
      success: true,
      externalOrderId: 'mt5-position-1001',
      status: 'FILLED',
      filledPrice: '1.10020',
      filledQuantity: '0.10',
    });

    const placed = session.commands.find((command) => command.commandName === 'PLACE_ORDER');
    expect(placed).toMatchObject({
      idempotencyKey: 'trade-1:open',
      expectedIdentity: identity,
      ownership: { magicNumber: 2601025, commentPrefix: 'IREXPRO:' },
      payload: expect.objectContaining({
        clientOrderId: 'sig-1',
        instrument: 'EURUSD',
        direction: 'BUY',
        lotSize: '0.10',
      }),
    });
  });

  it('preserves terminal rejection and never retries or falls back after a healthy direct session responds', async () => {
    const { adapter, session } = setup(async (command) => {
      if (command.commandName === 'PLACE_ORDER') {
        return {
          protocolVersion: 1,
          type: 'RESPONSE',
          sessionId: command.sessionId,
          requestId: command.requestId,
          sequence: command.sequence,
          sentAt: new Date().toISOString(),
          nonce: `response-${command.nonce}`,
          ok: false,
          error: {
            code: 'MARKET_CLOSED',
            message: 'Market closed',
            certainty: 'REJECTED',
          },
        };
      }
      return response(command, {
        accountId: identity.accountLogin,
        currency: 'USD',
        leverage: 100,
        balance: '10000',
        equity: '10000',
        margin: '0',
        freeMargin: '10000',
        marginLevel: '0',
      });
    });
    await adapter.connect(credentials);

    await expect(
      adapter.placeOrder({
        idempotencyKey: 'market-closed:open',
        instrument: 'EURUSD',
        direction: 'BUY',
        lotSize: '0.20',
        stopLoss: '1.09500',
        takeProfit: '1.11000',
      }),
    ).rejects.toMatchObject({
      code: BrokerErrorCode.MARKET_CLOSED,
      message: 'Market closed',
      dispatchCertainty: ProviderDispatchCertainty.SENT_RESPONSE_RECEIVED,
    });
    expect(
      session.commands.filter((command) => command.commandName === 'PLACE_ORDER'),
    ).toHaveLength(1);
  });

  it('classifies a lost mutation response as uncertain and never auto-success', async () => {
    const { adapter } = setup(async (command) => {
      if (command.commandName === 'PLACE_ORDER') {
        return new Promise<Mt5BridgeResponse>(() => undefined);
      }
      return response(command, {
        accountId: identity.accountLogin,
        currency: 'USD',
        leverage: 100,
        balance: '10000',
        equity: '10000',
        margin: '0',
        freeMargin: '10000',
        marginLevel: '0',
      });
    });
    await adapter.connect(credentials);

    const promise = adapter.placeOrder({
      idempotencyKey: 'trade-timeout:open',
      instrument: 'EURUSD',
      direction: 'BUY',
      lotSize: '0.10',
      stopLoss: '1.09500',
      takeProfit: '1.11000',
    });
    await expect(promise).rejects.toMatchObject({
      code: BrokerErrorCode.CONNECTION_TIMEOUT,
      dispatchCertainty: ProviderDispatchCertainty.MAY_HAVE_REACHED_PROVIDER,
    });
  });

  it('closeAllOrders uses the ownership-scoped bridge command instead of touching manual positions', async () => {
    const { adapter, session } = setup();
    await adapter.connect(credentials);
    await expect(adapter.closeAllOrders()).resolves.toEqual({
      closedCount: 2,
      failedCount: 0,
      errors: [],
    });
    expect(session.commands.at(-1)).toMatchObject({
      commandName: 'CLOSE_IREXPRO_POSITIONS',
      ownership: { magicNumber: 2601025, commentPrefix: 'IREXPRO:' },
    });
  });

  it('declares all four MT5 normalized order kinds with SL/TP attached at placement', () => {
    const { adapter } = setup();
    expect(adapter.getOrderCapabilities()).toEqual({
      brokerId: 'metatrader5-native',
      supportedOrderKinds: ['MARKET', 'LIMIT', 'STOP', 'STOP_LIMIT'],
      requirements: {
        MARKET: { limitPriceRequired: false, stopPriceRequired: false },
        LIMIT: { limitPriceRequired: true, stopPriceRequired: false },
        STOP: { limitPriceRequired: false, stopPriceRequired: true },
        STOP_LIMIT: { limitPriceRequired: true, stopPriceRequired: true },
      },
      marketSlTpAttachedAtPlacement: true,
    });
  });
});
