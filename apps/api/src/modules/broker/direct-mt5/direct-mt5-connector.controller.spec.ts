import { UnauthorizedException } from '@nestjs/common';
import {
  DirectMt5ConnectorController,
  DirectMt5PairingController,
} from './direct-mt5-connector.controller';

describe('Direct MT5 connector controllers', () => {
  it('creates a pairing only for the authenticated user connection', async () => {
    const pairing = { createPairing: jest.fn().mockResolvedValue({ connectorId: 'c1' }) } as any;
    const controller = new DirectMt5PairingController(pairing);
    await expect(
      controller.createPairing('user-1', { brokerConnectionId: 'conn-1' } as any),
    ).resolves.toEqual({
      connectorId: 'c1',
    });
    expect(pairing.createPairing).toHaveBeenCalledWith('user-1', 'conn-1');
  });

  it('returns owner-facing direct MT5 connector health for onboarding', async () => {
    const pairing = {
      getConnectionHealth: jest.fn().mockResolvedValue({
        connectorId: 'c1',
        brokerConnectionId: 'conn-1',
        state: 'ACTIVE',
        connected: true,
        executionReady: true,
        tradeAllowed: true,
        lastHeartbeatAt: new Date('2026-10-24T22:00:00.000Z'),
        heartbeatAgeMs: 2_000,
        accountLogin: '113392789',
        brokerServer: 'Broker-Demo',
        reason: 'READY',
      }),
    } as any;
    const controller = new DirectMt5PairingController(pairing);

    await expect(controller.health('user-1', 'conn-1')).resolves.toMatchObject({
      connected: true,
      executionReady: true,
      reason: 'READY',
    });
    expect(pairing.getConnectionHealth).toHaveBeenCalledWith('user-1', 'conn-1');
  });

  it('revokes a connector only through the authenticated owner-facing surface', async () => {
    const pairing = {
      revokeConnector: jest.fn().mockResolvedValue({ connectorId: 'c1', revoked: true }),
    } as any;
    const controller = new DirectMt5PairingController(pairing);

    await expect(controller.revoke('user-1', 'conn-1')).resolves.toEqual({
      connectorId: 'c1',
      revoked: true,
    });
    expect(pairing.revokeConnector).toHaveBeenCalledWith('user-1', 'conn-1');
  });

  it('redeems the public one-time pairing code through the pairing service', async () => {
    const pairing = {
      redeemPairing: jest.fn().mockResolvedValue({ connectorId: 'c1', connectorToken: 'secret' }),
    } as any;
    const controller = new DirectMt5ConnectorController(pairing, {} as any);
    await controller.redeem({
      pairingCode: 'ABCDEFGH23',
      accountLogin: '113392789',
      brokerServer: 'Broker-Demo',
      currency: 'USD',
      tradeAllowed: true,
    } as any);
    expect(pairing.redeemPairing).toHaveBeenCalledWith('ABCDEFGH23', {
      accountLogin: '113392789',
      brokerServer: 'Broker-Demo',
      currency: 'USD',
      tradeAllowed: true,
    });
  });

  it('rejects connector endpoints without a Bearer token', async () => {
    const controller = new DirectMt5ConnectorController({} as any, {} as any);
    await expect(
      controller.heartbeat('connector-1', undefined, {
        brokerConnectionId: 'conn-1',
        accountLogin: '1',
        brokerServer: 'Demo',
        sequence: 1,
        terminalConnected: true,
        tradingAllowed: true,
      } as any),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('authenticates, identity-fences, and records a monotonic heartbeat', async () => {
    const binding = {
      connectorId: 'connector-1',
      userId: 'user-1',
      brokerConnectionId: 'conn-1',
      accountLogin: '113392789',
      brokerServer: 'Broker-Demo',
      lastSequence: 3,
    };
    const pairing = {
      authenticateConnector: jest.fn().mockResolvedValue(binding),
      recordHeartbeat: jest.fn().mockResolvedValue({ lastSequence: 4 }),
    } as any;
    const controller = new DirectMt5ConnectorController(pairing, {} as any);
    await expect(
      controller.heartbeat('connector-1', 'Bearer token-1', {
        brokerConnectionId: 'conn-1',
        accountLogin: '113392789',
        brokerServer: 'Broker-Demo',
        sequence: 4,
        terminalConnected: true,
        tradingAllowed: true,
      } as any),
    ).resolves.toEqual({ lastSequence: 4 });
    expect(pairing.authenticateConnector).toHaveBeenCalledWith('connector-1', 'token-1');
  });

  it('leases only after token and broker-connection identity match', async () => {
    const binding = {
      connectorId: 'connector-1',
      userId: 'user-1',
      brokerConnectionId: 'conn-1',
      accountLogin: '113392789',
      brokerServer: 'Broker-Demo',
      lastSequence: 3,
    };
    const pairing = { authenticateConnector: jest.fn().mockResolvedValue(binding) } as any;
    const commands = { leaseNext: jest.fn().mockResolvedValue(null) } as any;
    const controller = new DirectMt5ConnectorController(pairing, commands);

    await expect(
      controller.leaseNext('connector-1', 'Bearer token-1', {
        brokerConnectionId: 'other',
        accountLogin: '113392789',
        brokerServer: 'Broker-Demo',
      } as any),
    ).rejects.toThrow('identity');
    expect(commands.leaseNext).not.toHaveBeenCalled();
  });

  it('records an authoritative command result only after token and MT5 identity match', async () => {
    const binding = {
      connectorId: 'connector-1',
      userId: 'user-1',
      brokerConnectionId: 'conn-1',
      accountLogin: '113392789',
      brokerServer: 'Broker-Demo',
      lastSequence: 7,
    };
    const pairing = { authenticateConnector: jest.fn().mockResolvedValue(binding) } as any;
    const commands = {
      recordResult: jest.fn().mockResolvedValue({ id: 'cmd-1', state: 'SUCCEEDED' }),
    } as any;
    const controller = new DirectMt5ConnectorController(pairing, commands);

    await expect(
      controller.recordResult('connector-1', 'cmd-1', 'Bearer token-1', {
        brokerConnectionId: 'conn-1',
        accountLogin: '113392789',
        brokerServer: 'Broker-Demo',
        state: 'SUCCEEDED',
        result: { ticket: '1001' },
      } as any),
    ).resolves.toEqual({ id: 'cmd-1', state: 'SUCCEEDED' });

    expect(commands.recordResult).toHaveBeenCalledWith('connector-1', 'cmd-1', {
      state: 'SUCCEEDED',
      result: { ticket: '1001' },
      error: null,
    });
  });

  it('rejects command results from a connector whose MT5 identity changed', async () => {
    const binding = {
      connectorId: 'connector-1',
      userId: 'user-1',
      brokerConnectionId: 'conn-1',
      accountLogin: '113392789',
      brokerServer: 'Broker-Demo',
      lastSequence: 7,
    };
    const pairing = { authenticateConnector: jest.fn().mockResolvedValue(binding) } as any;
    const commands = { recordResult: jest.fn() } as any;
    const controller = new DirectMt5ConnectorController(pairing, commands);

    await expect(
      controller.recordResult('connector-1', 'cmd-1', 'Bearer token-1', {
        brokerConnectionId: 'conn-1',
        accountLogin: '999999999',
        brokerServer: 'Other-Server',
        state: 'SUCCEEDED',
        result: { ticket: '1001' },
      } as any),
    ).rejects.toThrow('identity');
    expect(commands.recordResult).not.toHaveBeenCalled();
  });
});
