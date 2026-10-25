import { Mt5BridgeSessionRegistry } from './mt5-bridge-session-registry.service';
import { DirectMt5BridgeSessionManager } from './direct-mt5-bridge-session-manager.service';

const heartbeat = {
  connectorId: 'connector-1',
  brokerConnectionId: 'connection-1',
  accountLogin: '113392789',
  brokerServer: 'Broker-Demo',
  company: 'Broker Ltd',
  environment: 'DEMO' as const,
  currency: 'USD',
  leverage: 100,
  marginMode: 'HEDGING' as const,
  terminalConnected: true,
  terminalTradeAllowed: true,
  accountTradeAllowed: true,
  eaTradingAllowed: true,
  observedAt: new Date(),
};

describe('DirectMt5BridgeSessionManager', () => {
  it('attaches an authenticated DEMO connector heartbeat to the exact BrokerConnection', () => {
    const registry = new Mt5BridgeSessionRegistry();
    const commands = { enqueue: jest.fn(), waitForOutcome: jest.fn() };
    const manager = new DirectMt5BridgeSessionManager(registry, commands as never);

    manager.synchronize(heartbeat);

    const session = registry.getHealthySession('connection-1');
    expect(session.sessionId).toBe('connector-1');
    expect(session.identity).toMatchObject({
      accountLogin: '113392789',
      server: 'Broker-Demo',
      company: 'Broker Ltd',
      environment: 'DEMO',
      currency: 'USD',
      leverage: 100,
      marginMode: 'HEDGING',
    });
  });

  it('refreshes the same connector heartbeat without creating a new session generation', () => {
    const registry = new Mt5BridgeSessionRegistry();
    const commands = { enqueue: jest.fn(), waitForOutcome: jest.fn() };
    const manager = new DirectMt5BridgeSessionManager(registry, commands as never);
    const firstAt = new Date(Date.now() - 5_000);
    manager.synchronize({ ...heartbeat, observedAt: firstAt });
    const firstGeneration = registry.health('connection-1').generation;

    const secondAt = new Date();
    manager.synchronize({ ...heartbeat, observedAt: secondAt, terminalTradeAllowed: false });

    expect(registry.health('connection-1').generation).toBe(firstGeneration);
    expect(registry.health('connection-1').state).toBe('TRADING_UNAVAILABLE');
    expect(registry.health('connection-1').lastHeartbeatAt).toBe(secondAt.toISOString());
  });

  it('replaces a re-paired connector as a new fenced session generation', () => {
    const registry = new Mt5BridgeSessionRegistry();
    const commands = { enqueue: jest.fn(), waitForOutcome: jest.fn() };
    const manager = new DirectMt5BridgeSessionManager(registry, commands as never);
    manager.synchronize(heartbeat);
    const firstGeneration = registry.health('connection-1').generation!;

    manager.synchronize({ ...heartbeat, connectorId: 'connector-2', observedAt: new Date() });

    expect(registry.health('connection-1').sessionId).toBe('connector-2');
    expect(registry.health('connection-1').generation).toBe(firstGeneration + 1);
  });

  it('rejects LIVE connector identity and detaches revoked sessions immediately', () => {
    const registry = new Mt5BridgeSessionRegistry();
    const commands = { enqueue: jest.fn(), waitForOutcome: jest.fn() };
    const manager = new DirectMt5BridgeSessionManager(registry, commands as never);

    expect(() => manager.synchronize({ ...heartbeat, environment: 'LIVE' })).toThrow('DEMO');
    manager.synchronize(heartbeat);
    expect(manager.detach('connection-1', 'connector-1')).toBe(true);
    expect(registry.health('connection-1').state).toBe('DISCONNECTED');
  });
});
