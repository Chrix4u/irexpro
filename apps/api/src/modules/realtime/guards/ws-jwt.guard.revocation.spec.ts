import { ExecutionContext } from '@nestjs/common';
import { WsException } from '@nestjs/websockets';
import { UserStatus } from '../../users/entities/user.entity';
import { WsJwtGuard } from './ws-jwt.guard';

describe('WsJwtGuard — Sprint 48 revocation enforcement', () => {
  const userId = '22222222-2222-4222-8222-222222222222';

  function setup() {
    const jwtService = { verify: jest.fn() };
    const configService = {
      get: jest.fn().mockReturnValue('test-jwt-secret-32-chars-minimum!!!'),
    };
    const userRepo = { findOne: jest.fn() };
    const guard = new WsJwtGuard(jwtService as never, configService as never, userRepo as never);

    const client = {
      id: 'socket-1',
      handshake: { auth: { token: 'socket-token' }, headers: {} },
      data: {},
    };
    const context = {
      switchToWs: () => ({ getClient: () => client }),
    } as unknown as ExecutionContext;

    return { guard, jwtService, userRepo, client, context };
  }

  it('accepts a current access token and attaches only safe identity/session fields', async () => {
    const { guard, jwtService, userRepo, client, context } = setup();
    jwtService.verify.mockReturnValue({
      sub: userId,
      email: 'user@example.com',
      roles: ['USER'],
      tokenType: 'access',
      sessionVersion: 3,
    });
    userRepo.findOne.mockResolvedValue({
      id: userId,
      email: 'user@example.com',
      status: UserStatus.ACTIVE,
      sessionVersion: 3,
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(client.data).toEqual({
      userId,
      userEmail: 'user@example.com',
      userRoles: ['USER'],
      authenticatedSessionVersion: 3,
    });
  });

  it('rejects a token with no explicit tokenType before opening a WebSocket session', async () => {
    const { guard, jwtService, userRepo, context } = setup();
    jwtService.verify.mockReturnValue({
      sub: userId,
      email: 'user@example.com',
      roles: ['USER'],
      sessionVersion: 3,
    });

    await expect(guard.canActivate(context)).rejects.toThrow(WsException);
    expect(userRepo.findOne).not.toHaveBeenCalled();
  });

  it('rejects a refresh token before opening a WebSocket session', async () => {
    const { guard, jwtService, userRepo, context } = setup();
    jwtService.verify.mockReturnValue({
      sub: userId,
      email: 'user@example.com',
      roles: ['USER'],
      tokenType: 'refresh',
      sessionVersion: 3,
    });

    await expect(guard.canActivate(context)).rejects.toThrow(WsException);
    expect(userRepo.findOne).not.toHaveBeenCalled();
  });

  it('rejects a stale access token after logout, refresh rotation, or password reset', async () => {
    const { guard, jwtService, userRepo, context } = setup();
    jwtService.verify.mockReturnValue({
      sub: userId,
      email: 'user@example.com',
      roles: ['USER'],
      tokenType: 'access',
      sessionVersion: 3,
    });
    userRepo.findOne.mockResolvedValue({
      id: userId,
      email: 'user@example.com',
      status: UserStatus.ACTIVE,
      sessionVersion: 4,
    });

    await expect(guard.canActivate(context)).rejects.toThrow(WsException);
  });

  it('rejects an inactive account even when the JWT generation matches', async () => {
    const { guard, jwtService, userRepo, context } = setup();
    jwtService.verify.mockReturnValue({
      sub: userId,
      email: 'user@example.com',
      roles: ['USER'],
      tokenType: 'access',
      sessionVersion: 4,
    });
    userRepo.findOne.mockResolvedValue({
      id: userId,
      email: 'user@example.com',
      status: UserStatus.SUSPENDED,
      sessionVersion: 4,
    });

    await expect(guard.canActivate(context)).rejects.toThrow(WsException);
  });
});
