import {
  MT5_BRIDGE_PROTOCOL_VERSION,
  Mt5BridgeProtocolError,
  buildMt5BridgeCommand,
  sanitizeMt5BridgeEnvelopeForLog,
  validateMt5BridgeCommand,
} from './mt5-bridge-protocol';
import { FakeMt5BridgeSession } from './mt5-bridge-fake-session';

const identity = {
  accountLogin: '113392789',
  server: 'MetaQuotes-Demo',
  company: 'MetaQuotes Ltd.',
  environment: 'DEMO' as const,
  currency: 'USD',
  leverage: 100,
  marginMode: 'HEDGING' as const,
};

const mutation = () =>
  buildMt5BridgeCommand({
    sessionId: 'session-1',
    requestId: 'request-1',
    sequence: 11,
    nonce: 'nonce-1',
    commandName: 'PLACE_ORDER',
    payload: { symbol: 'EURUSD', side: 'BUY', volume: '0.10' },
    signature: 'super-secret-signature',
    idempotencyKey: 'trade-1:open',
    expiresAt: '2026-10-25T20:01:00.000Z',
    expectedIdentity: identity,
    ownership: { magicNumber: 2601025, commentPrefix: 'IREXPRO:' },
    sentAt: '2026-10-25T20:00:00.000Z',
  });

describe('MT5 native bridge protocol v1', () => {
  it('rejects unknown protocol versions', () => {
    const command = { ...mutation(), protocolVersion: 99 } as any;
    expect(() =>
      validateMt5BridgeCommand(command, {
        now: new Date('2026-10-25T20:00:10.000Z'),
        expectedIdentity: identity,
        lastSequence: 10,
      }),
    ).toThrow(new Mt5BridgeProtocolError('PROTOCOL_VERSION_UNSUPPORTED'));
  });

  it('rejects expired mutating commands', () => {
    const command = { ...mutation(), expiresAt: '2026-10-25T19:59:59.000Z' };
    expect(() =>
      validateMt5BridgeCommand(command, {
        now: new Date('2026-10-25T20:00:10.000Z'),
        expectedIdentity: identity,
        lastSequence: 10,
      }),
    ).toThrow(new Mt5BridgeProtocolError('COMMAND_EXPIRED'));
  });

  it('requires idempotency and ownership on mutations', () => {
    const command = { ...mutation(), idempotencyKey: '', ownership: undefined } as any;
    expect(() =>
      validateMt5BridgeCommand(command, {
        now: new Date('2026-10-25T20:00:10.000Z'),
        expectedIdentity: identity,
        lastSequence: 10,
      }),
    ).toThrow(new Mt5BridgeProtocolError('MUTATION_IDEMPOTENCY_REQUIRED'));
  });

  it('rejects replayed sequence and account identity drift', () => {
    expect(() =>
      validateMt5BridgeCommand(mutation(), {
        now: new Date('2026-10-25T20:00:10.000Z'),
        expectedIdentity: identity,
        lastSequence: 11,
      }),
    ).toThrow(new Mt5BridgeProtocolError('SEQUENCE_REPLAYED'));

    expect(() =>
      validateMt5BridgeCommand(mutation(), {
        now: new Date('2026-10-25T20:00:10.000Z'),
        expectedIdentity: { ...identity, accountLogin: '999999' },
        lastSequence: 10,
      }),
    ).toThrow(new Mt5BridgeProtocolError('ACCOUNT_IDENTITY_MISMATCH'));
  });

  it('sanitizes authentication material before logging', () => {
    const sanitized = sanitizeMt5BridgeEnvelopeForLog({
      ...mutation(),
      signature: 'do-not-log',
      payload: { token: 'secret-token', symbol: 'EURUSD' },
    });
    expect(JSON.stringify(sanitized)).not.toContain('do-not-log');
    expect(JSON.stringify(sanitized)).not.toContain('secret-token');
    expect(sanitized).toMatchObject({ protocolVersion: MT5_BRIDGE_PROTOCOL_VERSION });
  });

  it('fake session records commands and returns deterministic scripted responses', async () => {
    const session = new FakeMt5BridgeSession({
      sessionId: 'session-1',
      identity,
      handler: async (command) => ({
        protocolVersion: 1,
        type: 'RESPONSE',
        sessionId: command.sessionId,
        requestId: command.requestId,
        sequence: command.sequence,
        sentAt: '2026-10-25T20:00:01.000Z',
        nonce: 'response-nonce',
        ok: true,
        payload: { providerOrderId: 'mt5-1001' },
      }),
    });

    await expect(session.request(mutation())).resolves.toMatchObject({
      ok: true,
      payload: { providerOrderId: 'mt5-1001' },
    });
    expect(session.commands).toHaveLength(1);
    expect(session.commands[0]).toMatchObject({ commandName: 'PLACE_ORDER' });
  });
});
