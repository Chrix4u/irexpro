import { DirectMt5BridgeSession } from './direct-mt5-bridge-session';
import { buildMt5BridgeCommand } from './mt5-bridge-protocol';

const identity = {
  accountLogin: '113392789',
  server: 'Broker-Demo',
  company: 'Broker Ltd',
  environment: 'DEMO' as const,
  currency: 'USD',
  leverage: 100,
  marginMode: 'HEDGING' as const,
};

const capabilities = {
  terminalConnected: true,
  terminalTradeAllowed: true,
  accountTradeAllowed: true,
  eaTradingAllowed: true,
};

function command(
  commandName: Parameters<typeof buildMt5BridgeCommand>[0]['commandName'],
  payload: Record<string, unknown> = {},
) {
  const mutation = [
    'PLACE_ORDER',
    'MODIFY_ORDER',
    'CLOSE_POSITION',
    'CANCEL_ORDER',
    'CLOSE_IREXPRO_POSITIONS',
  ].includes(commandName);
  return buildMt5BridgeCommand({
    sessionId: 'connector-1',
    requestId: `req-${commandName}`,
    sequence: 1,
    nonce: 'nonce-1',
    commandName,
    payload,
    signature: 'registry-authenticated',
    idempotencyKey: mutation ? `idem-${commandName}` : undefined,
    expiresAt: mutation ? new Date(Date.now() + 30_000).toISOString() : undefined,
    expectedIdentity: mutation ? identity : undefined,
    ownership: mutation ? { magicNumber: 2601025, commentPrefix: 'IREXPRO:' } : undefined,
  });
}

describe('DirectMt5BridgeSession', () => {
  it('maps native read RPCs onto durable connector commands and returns the result', async () => {
    const commands = {
      enqueue: jest.fn().mockResolvedValue({ id: 'cmd-1' }),
      waitForOutcome: jest.fn().mockResolvedValue({
        state: 'SUCCEEDED',
        result: { balance: '10000', equity: '10005' },
        error: null,
      }),
    };
    const session = new DirectMt5BridgeSession({
      connectorId: 'connector-1',
      brokerConnectionId: 'connection-1',
      identity,
      capabilities,
      lastHeartbeatAt: new Date(),
      commands: commands as never,
    });

    const response = await session.request(command('GET_ACCOUNT_INFO'));

    expect(commands.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        connectorId: 'connector-1',
        brokerConnectionId: 'connection-1',
        commandType: 'ACCOUNT_SNAPSHOT',
        idempotencyKey: 'read:req-GET_ACCOUNT_INFO',
      }),
    );
    expect(response).toMatchObject({
      ok: true,
      sessionId: 'connector-1',
      requestId: 'req-GET_ACCOUNT_INFO',
      payload: { balance: '10000', equity: '10005' },
    });
  });

  it('preserves mutation idempotency, ownership and uncertain outcomes', async () => {
    const commands = {
      enqueue: jest.fn().mockResolvedValue({ id: 'cmd-2' }),
      waitForOutcome: jest.fn().mockResolvedValue({
        state: 'UNCERTAIN',
        result: null,
        error: 'lease expired after possible MT5 mutation',
      }),
    };
    const session = new DirectMt5BridgeSession({
      connectorId: 'connector-1',
      brokerConnectionId: 'connection-1',
      identity,
      capabilities,
      lastHeartbeatAt: new Date(),
      commands: commands as never,
    });

    const response = await session.request(
      command('PLACE_ORDER', { instrument: 'EURUSD', direction: 'BUY', lotSize: '0.10' }),
    );

    expect(commands.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        commandType: 'PLACE_ORDER',
        idempotencyKey: 'idem-PLACE_ORDER',
        payload: expect.objectContaining({
          instrument: 'EURUSD',
          direction: 'BUY',
          volume: '0.10',
          ownership: { magicNumber: 2601025, commentPrefix: 'IREXPRO:' },
        }),
      }),
    );
    expect(response).toMatchObject({
      ok: false,
      error: { certainty: 'UNCERTAIN' },
    });
  });

  it('fails closed for native commands the installed connector cannot execute', async () => {
    const commands = { enqueue: jest.fn(), waitForOutcome: jest.fn() };
    const session = new DirectMt5BridgeSession({
      connectorId: 'connector-1',
      brokerConnectionId: 'connection-1',
      identity,
      capabilities,
      lastHeartbeatAt: new Date(),
      commands: commands as never,
    });

    const response = await session.request(command('GET_SYMBOLS'));

    expect(commands.enqueue).not.toHaveBeenCalled();
    expect(response).toMatchObject({
      ok: false,
      error: { code: 'UNSUPPORTED_COMMAND', certainty: 'KNOWN_NOT_SENT' },
    });
  });
});
