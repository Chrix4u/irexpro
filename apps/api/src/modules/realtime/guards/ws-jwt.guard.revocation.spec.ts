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
      disconnect: jest.fn(),
    };
    const context = {
      switchToWs: () => ({ getClient: () => client }),
    } as unknown as ExecutionContext;

    return { guard, jwtService, userRepo, client, context };
  }

  function attachStaleIdentity(client: ReturnType<typeof setup>['client']): void {
    Object.assign(client, {
      userId,
      userEmail: 'old@example.com',
      userRoles: ['USER'],
      authenticatedSessionVersion: 3,
    });
    Object.assign(client.data, {
      userId,
      userEmail: 'old@example.com',
      userRoles: ['USER'],
      authenticatedSessionVersion: 3,
    });
  }

  function expectIdentityCleared(client: ReturnType<typeof setup>['client']): void {
    expect(client).not.toHaveProperty('userId');
    expect(client).not.toHaveProperty('userEmail');
    expect(client).not.toHaveProperty('userRoles');
    expect(client).not.toHaveProperty('authenticatedSessionVersion');
    expect(client.data).toEqual({});
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
    expect(client.disconnect).not.toHaveBeenCalled();
  });

  it('rejects a token with no explicit tokenType before opening a WebSocket session', async () => {
    const { guard, jwtService, userRepo, client, context } = setup();
    jwtService.verify.mockReturnValue({
      sub: userId,
      email: 'user@example.com',
      roles: ['USER'],
      sessionVersion: 3,
    });

    await expect(guard.canActivate(context)).rejects.toThrow(WsException);
    expect(userRepo.findOne).not.toHaveBeenCalled();
    expect(client.disconnect).toHaveBeenCalledWith(true);
    expectIdentityCleared(client);
  });

  it('rejects a refresh token before opening a WebSocket session', async () => {
    const { guard, jwtService, userRepo, client, context } = setup();
    jwtService.verify.mockReturnValue({
      sub: userId,
      email: 'user@example.com',
      roles: ['USER'],
      tokenType: 'refresh',
      sessionVersion: 3,
    });

    await expect(guard.canActivate(context)).rejects.toThrow(WsException);
    expect(userRepo.findOne).not.toHaveBeenCalled();
    expect(client.disconnect).toHaveBeenCalledWith(true);
    expectIdentityCleared(client);
  });

  it('disconnects and clears a stale access token after logout, refresh rotation, or password reset', async () => {
    const { guard, jwtService, userRepo, client, context } = setup();
    attachStaleIdentity(client);
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
    expect(client.disconnect).toHaveBeenCalledWith(true);
    expectIdentityCleared(client);
  });

  it('disconnects and clears an inactive account even when the JWT generation matches', async () => {
    const { guard, jwtService, userRepo, client, context } = setup();
    attachStaleIdentity(client);
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
    expect(client.disconnect).toHaveBeenCalledWith(true);
    expectIdentityCleared(client);
  });

  it('clears stale identity and disconnects when a guarded message has no token', async () => {
    const { guard, client, context } = setup();
    attachStaleIdentity(client);
    client.handshake.auth = {};

    await expect(guard.canActivate(context)).rejects.toThrow('Unauthorized: no token provided');
    expect(client.disconnect).toHaveBeenCalledWith(true);
    expectIdentityCleared(client);
  });
});
