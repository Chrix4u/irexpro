import { UnauthorizedException } from '@nestjs/common';
import { WsException } from '@nestjs/websockets';
import { AuthService } from './auth.service';
import { JwtPayload, JwtStrategy } from './strategies/jwt.strategy';
import { WsJwtGuard } from '../realtime/guards/ws-jwt.guard';

/**
 * Security regression for #259: every signed JWT subject reaches the same UUID
 * identity table, so malformed subjects must fail before any persistence call
 * regardless of whether the token arrives over HTTP bearer, refresh, or WS.
 */
describe('JWT subject UUID boundary', () => {
  const malformedSubjects = [
    'not-a-uuid',
    '22222222-2222-4222-8222-222222222222\nforged-log-line',
    'x'.repeat(4096),
  ];

  it.each(malformedSubjects)('rejects bearer subject %p before user lookup', async (sub) => {
    const userRepo = { findOne: jest.fn() };
    const configService = {
      get: jest.fn().mockReturnValue('test-jwt-secret-32-chars-minimum!!!'),
    };
    const strategy = new JwtStrategy(configService as never, userRepo as never);
    const payload: JwtPayload = {
      sub,
      email: 'user@example.com',
      roles: ['USER'],
      tokenType: 'access',
      sessionVersion: 1,
    };

    await expect(strategy.validate(payload)).rejects.toThrow(UnauthorizedException);
    expect(userRepo.findOne).not.toHaveBeenCalled();
  });

  it.each(malformedSubjects)('rejects refresh subject %p before user lookup', async (sub) => {
    const userRepo = { findOne: jest.fn(), update: jest.fn() };
    const jwtService = {
      verify: jest.fn().mockReturnValue({
        sub,
        email: 'user@example.com',
        roles: ['USER'],
        tokenType: 'refresh',
        sessionVersion: 1,
      }),
      sign: jest.fn(),
    };
    const service = new AuthService(
      userRepo as never,
      {} as never,
      {} as never,
      {} as never,
      jwtService as never,
      { get: jest.fn() } as never,
      { log: jest.fn() } as never,
      {} as never,
    );

    await expect(service.refreshTokens('signed-refresh-token')).rejects.toThrow(
      'Invalid or expired refresh token',
    );
    expect(userRepo.findOne).not.toHaveBeenCalled();
    expect(userRepo.update).not.toHaveBeenCalled();
  });

  it.each(malformedSubjects)(
    'rejects WebSocket subject %p before user lookup and clears the socket',
    async (sub) => {
      const userRepo = { findOne: jest.fn() };
      const jwtService = {
        verify: jest.fn().mockReturnValue({
          sub,
          email: 'user@example.com',
          roles: ['USER'],
          tokenType: 'access',
          sessionVersion: 1,
        }),
      };
      const guard = new WsJwtGuard(
        jwtService as never,
        { get: jest.fn().mockReturnValue('test-jwt-secret-32-chars-minimum!!!') } as never,
        userRepo as never,
      );
      const client = {
        id: 'socket-invalid-subject',
        handshake: { auth: { token: 'signed-access-token' }, headers: {} },
        data: {
          userId: 'stale-user',
          userEmail: 'stale@example.com',
          userRoles: ['USER'],
          authenticatedSessionVersion: 1,
        },
        userId: 'stale-user',
        userEmail: 'stale@example.com',
        userRoles: ['USER'],
        authenticatedSessionVersion: 1,
        disconnect: jest.fn(),
      };
      const context = {
        switchToWs: () => ({ getClient: () => client }),
      };

      await expect(guard.canActivate(context as never)).rejects.toThrow(WsException);
      expect(userRepo.findOne).not.toHaveBeenCalled();
      expect(client.disconnect).toHaveBeenCalledWith(true);
      expect(client.data).toEqual({});
      expect(client).not.toHaveProperty('userId');
      expect(client).not.toHaveProperty('userEmail');
      expect(client).not.toHaveProperty('userRoles');
      expect(client).not.toHaveProperty('authenticatedSessionVersion');
    },
  );
});
