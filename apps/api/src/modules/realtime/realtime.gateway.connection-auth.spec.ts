import { WsException } from '@nestjs/websockets';
import { UserStatus } from '../users/entities/user.entity';
import { WsJwtGuard } from './guards/ws-jwt.guard';
import { RealtimeGateway } from './realtime.gateway';

describe('RealtimeGateway — connection-time authentication', () => {
  const userId = '22222222-2222-4222-8222-222222222222';

  function setup() {
    const jwtService = { verify: jest.fn() };
    const configService = {
      get: jest.fn().mockReturnValue('test-jwt-secret-32-chars-minimum!!!'),
    };
    const userRepo = { findOne: jest.fn() };
    const guard = new WsJwtGuard(jwtService as never, configService as never, userRepo as never);
    const realtimeService = { setServer: jest.fn() };
    const tradingSessionRepo = { findOne: jest.fn() };
    const gateway = new RealtimeGateway(
      realtimeService as never,
      guard,
      tradingSessionRepo as never,
    );
    const client = {
      id: 'socket-connection-1',
      handshake: { auth: { token: 'socket-token' }, headers: {} },
      data: {},
      emit: jest.fn(),
      disconnect: jest.fn(),
      join: jest.fn(),
      leave: jest.fn(),
    };

    return { gateway, guard, jwtService, userRepo, tradingSessionRepo, client };
  }

  function currentAccessPayload() {
    return {
      sub: userId,
      email: 'user@example.com',
      roles: ['USER'],
      tokenType: 'access' as const,
      sessionVersion: 3,
    };
  }

  it('fully validates a current access token and records its generation on the socket', async () => {
    const { gateway, jwtService, userRepo, client } = setup();
    jwtService.verify.mockReturnValue(currentAccessPayload());
    userRepo.findOne.mockResolvedValue({
      id: userId,
      email: 'user@example.com',
      status: UserStatus.ACTIVE,
      sessionVersion: 3,
    });

    await gateway.handleConnection(client as never);

    expect(jwtService.verify).toHaveBeenCalledWith('socket-token', {
      secret: 'test-jwt-secret-32-chars-minimum!!!',
    });
    expect(client.data).toEqual({
      userId,
      userEmail: 'user@example.com',
      userRoles: ['USER'],
      authenticatedSessionVersion: 3,
    });
    expect(client.emit).not.toHaveBeenCalled();
    expect(client.disconnect).not.toHaveBeenCalled();
  });

  it('disconnects a refresh-class token immediately at connection time', async () => {
    const { gateway, jwtService, userRepo, client } = setup();
    jwtService.verify.mockReturnValue({
      ...currentAccessPayload(),
      tokenType: 'refresh',
    });

    await gateway.handleConnection(client as never);

    expect(userRepo.findOne).not.toHaveBeenCalled();
    expect(client.emit).toHaveBeenCalledWith('error', { message: 'Unauthorized' });
    expect(client.disconnect).toHaveBeenCalledWith(true);
  });

  it('disconnects a revoked session immediately at connection time', async () => {
    const { gateway, jwtService, userRepo, client } = setup();
    jwtService.verify.mockReturnValue(currentAccessPayload());
    userRepo.findOne.mockResolvedValue({
      id: userId,
      email: 'user@example.com',
      status: UserStatus.ACTIVE,
      sessionVersion: 4,
    });

    await gateway.handleConnection(client as never);

    expect(client.emit).toHaveBeenCalledWith('error', { message: 'Unauthorized' });
    expect(client.disconnect).toHaveBeenCalledWith(true);
    expect(client.data).toEqual({});
  });

  it('disconnects an invalid or expired JWT without exposing validation details', async () => {
    const { gateway, jwtService, client } = setup();
    jwtService.verify.mockImplementation(() => {
      throw new WsException('provider-specific validation detail');
    });

    await gateway.handleConnection(client as never);

    expect(client.emit).toHaveBeenCalledTimes(1);
    expect(client.emit).toHaveBeenCalledWith('error', { message: 'Unauthorized' });
    expect(client.disconnect).toHaveBeenCalledWith(true);
  });
});
