import { FakeMt5BridgeSession } from './mt5-bridge-fake-session';
import {
  buildMt5BridgeCommand,
  Mt5BridgeAccountIdentity,
  Mt5BridgeResponse,
} from './mt5-bridge-protocol';
import {
  Mt5BridgeSessionRegistry,
  Mt5BridgeSessionRegistryError,
} from './mt5-bridge-session-registry.service';

const identity: Mt5BridgeAccountIdentity = {
  accountLogin: '113392789',
  server: 'MetaQuotes-Demo',
  company: 'MetaQuotes Ltd.',
  environment: 'DEMO',
  currency: 'USD',
  leverage: 100,
  marginMode: 'HEDGING',
};

function responseFor(command: ReturnType<typeof queryCommand>): Mt5BridgeResponse {
  return {
    protocolVersion: 1,
    type: 'RESPONSE',
    sessionId: command.sessionId,
    requestId: command.requestId,
    sequence: command.sequence,
    sentAt: new Date().toISOString(),
    nonce: `response-${command.nonce}`,
    ok: true,
    payload: { ok: true },
  };
}

function queryCommand(sessionId = 'session-1', sequence = 1) {
  return buildMt5BridgeCommand({
    sessionId,
    requestId: `request-${sequence}`,
    sequence,
    nonce: `nonce-${sequence}`,
    commandName: 'GET_ACCOUNT_INFO',
    payload: {},
    signature: 'signed',
  });
}

function mutationCommand(sessionId = 'session-1', sequence = 1) {
  return buildMt5BridgeCommand({
    sessionId,
    requestId: `request-${sequence}`,
    sequence,
    nonce: `nonce-${sequence}`,
    commandName: 'PLACE_ORDER',
    payload: { symbol: 'EURUSD', volume: '0.10' },
    signature: 'signed',
    idempotencyKey: `trade-${sequence}:open`,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    expectedIdentity: identity,
    ownership: { magicNumber: 2601025, commentPrefix: 'IREXPRO:' },
  });
}

function session(
  input: {
    sessionId?: string;
    accountLogin?: string;
    server?: string;
    environment?: 'DEMO' | 'LIVE';
    lastHeartbeatAt?: Date;
    handler?: (command: ReturnType<typeof queryCommand>) => Promise<Mt5BridgeResponse>;
  } = {},
) {
  const sessionIdentity = {
    ...identity,
    accountLogin: input.accountLogin ?? identity.accountLogin,
    server: input.server ?? identity.server,
    environment: input.environment ?? identity.environment,
  };
  return new FakeMt5BridgeSession({
    sessionId: input.sessionId ?? 'session-1',
    identity: sessionIdentity,
    lastHeartbeatAt: input.lastHeartbeatAt,
    handler: input.handler ?? (async (command) => responseFor(command as any)),
  });
}

describe('Mt5BridgeSessionRegistry', () => {
  it('keeps sessions connection-scoped and rejects duplicate active writers', () => {
    const registry = new Mt5BridgeSessionRegistry();
    registry.attach('connection-a', session());

    expect(() => registry.attach('connection-a', session({ sessionId: 'session-2' }))).toThrow(
      new Mt5BridgeSessionRegistryError('SESSION_ALREADY_ATTACHED'),
    );
    expect(() => registry.attach('connection-b', session({ sessionId: 'session-3' }))).toThrow(
      new Mt5BridgeSessionRegistryError('ACCOUNT_ALREADY_BOUND'),
    );
  });

  it('rejects stale sessions and identity drift', () => {
    const registry = new Mt5BridgeSessionRegistry({ staleAfterMs: 1_000 });
    const stale = session({ lastHeartbeatAt: new Date(Date.now() - 5_000) });
    registry.attach('connection-a', stale);
    expect(() => registry.getHealthySession('connection-a', identity)).toThrow(
      new Mt5BridgeSessionRegistryError('SESSION_STALE'),
    );

    const freshRegistry = new Mt5BridgeSessionRegistry();
    const fresh = session();
    freshRegistry.attach('connection-a', fresh);
    (fresh.identity as any).accountLogin = '999999';
    expect(() => freshRegistry.getHealthySession('connection-a', identity)).toThrow(
      new Mt5BridgeSessionRegistryError('SESSION_IDENTITY_MISMATCH'),
    );
  });

  it('fences old generations across detach and reconnect', async () => {
    let release!: (value: Mt5BridgeResponse) => void;
    const pending = new Promise<Mt5BridgeResponse>((resolve) => (release = resolve));
    const oldSession = session({ handler: async () => pending });
    const registry = new Mt5BridgeSessionRegistry({ requestTimeoutMs: 5_000 });
    registry.attach('connection-a', oldSession);

    const request = registry.request('connection-a', queryCommand());
    expect(registry.detach('connection-a', 'wrong-session')).toBe(false);
    expect(registry.detach('connection-a', 'session-1')).toBe(true);
    registry.attach('connection-a', session({ sessionId: 'session-2' }));
    release(responseFor(queryCommand()));

    await expect(request).rejects.toThrow(
      new Mt5BridgeSessionRegistryError('SESSION_GENERATION_CHANGED'),
    );
  });

  it('classifies mutation timeouts as uncertain instead of retryable success', async () => {
    const registry = new Mt5BridgeSessionRegistry({ requestTimeoutMs: 15 });
    registry.attach(
      'connection-a',
      session({ handler: async () => new Promise<Mt5BridgeResponse>(() => undefined) }),
    );

    await expect(registry.request('connection-a', mutationCommand())).rejects.toThrow(
      new Mt5BridgeSessionRegistryError('COMMAND_OUTCOME_UNCERTAIN'),
    );
  });

  it('exposes sanitized health and dispatches a validated command', async () => {
    const registry = new Mt5BridgeSessionRegistry();
    registry.attach('connection-a', session());

    expect(registry.health('connection-a')).toMatchObject({
      state: 'HEALTHY',
      sessionId: 'session-1',
      accountLogin: '113392789',
      environment: 'DEMO',
    });
    await expect(registry.request('connection-a', queryCommand())).resolves.toMatchObject({
      ok: true,
      payload: { ok: true },
    });
  });
});
