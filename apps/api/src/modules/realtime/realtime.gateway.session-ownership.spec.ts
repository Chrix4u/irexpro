import { WsException } from '@nestjs/websockets';
import { RealtimeGateway } from './realtime.gateway';

/**
 * Security regression for #243: trading-session room ownership must come from
 * authoritative persistence, never from identity claims supplied by the client.
 */
describe('RealtimeGateway — trading-session room ownership', () => {
  const USER = '11111111-1111-4111-8111-111111111111';
  const OTHER_USER = '22222222-2222-4222-8222-222222222222';
  const SESSION = '33333333-3333-4333-8333-333333333333';

  function setup() {
    const realtimeService = { setServer: jest.fn() };
    const guard = { authenticateClient: jest.fn() };
    const tradingSessionRepo = { findOne: jest.fn() };
    const gateway = new RealtimeGateway(
      realtimeService as never,
      guard as never,
      tradingSessionRepo as never,
    );
    const client = {
      id: 'socket-owner-check',
      data: { userId: USER, authenticatedSessionVersion: 4 },
      join: jest.fn().mockResolvedValue(undefined),
      leave: jest.fn(),
    };

    return { gateway, tradingSessionRepo, client };
  }

  it('joins when persisted ownership matches the authenticated socket user', async () => {
    const { gateway, tradingSessionRepo, client } = setup();
    tradingSessionRepo.findOne.mockResolvedValue({ id: SESSION, userId: USER });

    await expect(
      gateway.handleJoinSession(client as never, { sessionId: SESSION }),
    ).resolves.toEqual({ status: 'joined' });

    expect(tradingSessionRepo.findOne).toHaveBeenCalledWith({
      where: { id: SESSION },
      select: ['id', 'userId'],
    });
    expect(client.join).toHaveBeenCalledWith(`trading-session:${SESSION}`);
  });

  it('denies a foreign session even when the client omits any ownership claim', async () => {
    const { gateway, tradingSessionRepo, client } = setup();
    tradingSessionRepo.findOne.mockResolvedValue({ id: SESSION, userId: OTHER_USER });

    await expect(
      gateway.handleJoinSession(client as never, { sessionId: SESSION }),
    ).rejects.toThrow('Forbidden: cannot join trading session');

    expect(client.join).not.toHaveBeenCalled();
  });

  it('ignores a forged legacy sessionUserId field and still uses persisted ownership', async () => {
    const { gateway, tradingSessionRepo, client } = setup();
    tradingSessionRepo.findOne.mockResolvedValue({ id: SESSION, userId: OTHER_USER });

    const forgedPayload = { sessionId: SESSION, sessionUserId: USER };
    await expect(gateway.handleJoinSession(client as never, forgedPayload)).rejects.toThrow(
      WsException,
    );

    expect(client.join).not.toHaveBeenCalled();
  });

  it('returns the same generic denial when the session does not exist', async () => {
    const { gateway, tradingSessionRepo, client } = setup();
    tradingSessionRepo.findOne.mockResolvedValue(null);

    await expect(
      gateway.handleJoinSession(client as never, { sessionId: SESSION }),
    ).rejects.toThrow('Forbidden: cannot join trading session');

    expect(client.join).not.toHaveBeenCalled();
  });

  it('fails closed with the same generic denial when ownership storage is unavailable', async () => {
    const { gateway, tradingSessionRepo, client } = setup();
    tradingSessionRepo.findOne.mockRejectedValue(new Error('database unavailable'));

    await expect(
      gateway.handleJoinSession(client as never, { sessionId: SESSION }),
    ).rejects.toThrow('Forbidden: cannot join trading session');

    expect(client.join).not.toHaveBeenCalled();
  });

  it('rejects a missing sessionId before querying persistence', async () => {
    const { gateway, tradingSessionRepo, client } = setup();

    await expect(gateway.handleJoinSession(client as never, { sessionId: '' })).rejects.toThrow(
      'sessionId is required',
    );

    expect(tradingSessionRepo.findOne).not.toHaveBeenCalled();
    expect(client.join).not.toHaveBeenCalled();
  });
});
