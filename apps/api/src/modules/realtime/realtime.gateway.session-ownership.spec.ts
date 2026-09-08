import { WsException } from '@nestjs/websockets';
import { RealtimeGateway } from './realtime.gateway';

/**
 * Security regressions for persisted trading-session ownership and identifier
 * validation. Session ownership must come from authoritative persistence, and
 * malformed identifiers must never reach persistence or room operations.
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

  it('canonicalizes a valid uppercase UUID before persistence and room use', async () => {
    const { gateway, tradingSessionRepo, client } = setup();
    const uppercaseSession = 'ABCDEF12-3456-4789-ABCD-EF1234567890';
    const canonicalSession = uppercaseSession.toLowerCase();
    tradingSessionRepo.findOne.mockResolvedValue({ id: canonicalSession, userId: USER });

    await expect(
      gateway.handleJoinSession(client as never, { sessionId: uppercaseSession }),
    ).resolves.toEqual({ status: 'joined' });

    expect(tradingSessionRepo.findOne).toHaveBeenCalledWith({
      where: { id: canonicalSession },
      select: ['id', 'userId'],
    });
    expect(client.join).toHaveBeenCalledWith(`trading-session:${canonicalSession}`);
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

  it.each([
    'not-a-uuid',
    '33333333-3333-4333-8333-333333333333\nforged-log-line',
    'x'.repeat(4096),
  ])('rejects malformed sessionId %p before persistence or room use', async (sessionId) => {
    const { gateway, tradingSessionRepo, client } = setup();

    await expect(gateway.handleJoinSession(client as never, { sessionId })).rejects.toThrow(
      'sessionId must be a valid UUID',
    );

    expect(tradingSessionRepo.findOne).not.toHaveBeenCalled();
    expect(client.join).not.toHaveBeenCalled();
  });

  it.each([
    'not-a-uuid',
    '33333333-3333-4333-8333-333333333333\nforged-log-line',
    'x'.repeat(4096),
  ])('rejects malformed leave-session ID %p before room use', (sessionId) => {
    const { gateway, client } = setup();

    expect(() => gateway.handleLeaveSession(client as never, { sessionId })).toThrow(
      'sessionId must be a valid UUID',
    );
    expect(client.leave).not.toHaveBeenCalled();
  });
});
