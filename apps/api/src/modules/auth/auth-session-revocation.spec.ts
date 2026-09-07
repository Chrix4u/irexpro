import { UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { PasswordResetService } from './password-reset.service';
import { JwtStrategy, JwtPayload } from './strategies/jwt.strategy';
import { PasswordResetToken, ResetChannel } from './entities/password-reset-token.entity';
import { User, UserStatus } from '../users/entities/user.entity';
import { AuditAction } from '../../common/enums/audit-action.enum';

/**
 * Sprint 48 adversarial authentication tests.
 *
 * These tests focus on server-side revocation semantics without adding any
 * broker, funding, strategy, execution, or trading behavior.
 */
describe('Sprint 48 — server-side auth session revocation', () => {
  const userId = '11111111-1111-4111-8111-111111111111';

  function buildAuthService() {
    const userRepo = {
      findOne: jest.fn(),
      update: jest.fn(),
    };
    const jwtService = {
      verify: jest.fn(),
      sign: jest.fn(
        (payload: Record<string, unknown>) =>
          `${String(payload.tokenType)}:${String(payload.sessionVersion)}:${String(payload.jti)}`,
      ),
    };
    const configService = {
      get: jest.fn((_key: string, defaultValue?: unknown) => defaultValue),
    };
    const auditService = { log: jest.fn() };
    const dataSource = { createQueryRunner: jest.fn() };

    const service = new AuthService(
      userRepo as never,
      {} as never,
      {} as never,
      {} as never,
      jwtService as never,
      configService as never,
      auditService as never,
      dataSource as never,
    );

    return { service, userRepo, jwtService, auditService };
  }

  it('rotates the server-side generation and issues explicitly typed replacement tokens', async () => {
    const { service, userRepo, jwtService, auditService } = buildAuthService();
    jwtService.verify.mockReturnValue({
      sub: userId,
      email: 'user@example.com',
      roles: ['USER'],
      tokenType: 'refresh',
      sessionVersion: 4,
    } satisfies JwtPayload);
    userRepo.findOne.mockResolvedValue({
      id: userId,
      email: 'user@example.com',
      status: UserStatus.ACTIVE,
      sessionVersion: 4,
      userRoles: [{ role: { name: 'USER' } }],
    });
    userRepo.update.mockResolvedValue({ affected: 1 });

    const result = await service.refreshTokens('refresh-token-v4');

    expect(userRepo.update).toHaveBeenCalledWith(
      { id: userId, sessionVersion: 4 },
      { sessionVersion: 5 },
    );
    expect(result.accessToken).toMatch(/^access:5:/);
    expect(result.refreshToken).toMatch(/^refresh:5:/);
    expect(jwtService.sign.mock.calls[0][0]).toEqual(
      expect.objectContaining({ tokenType: 'access', sessionVersion: 5 }),
    );
    expect(jwtService.sign.mock.calls[1][0]).toEqual(
      expect.objectContaining({ tokenType: 'refresh', sessionVersion: 5 }),
    );
    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: AuditAction.USER_TOKEN_REFRESHED }),
    );
  });

  it('rejects a stale refresh token after another rotation has advanced the generation', async () => {
    const { service, userRepo, jwtService } = buildAuthService();
    jwtService.verify.mockReturnValue({
      sub: userId,
      email: 'user@example.com',
      roles: ['USER'],
      tokenType: 'refresh',
      sessionVersion: 4,
    } satisfies JwtPayload);
    userRepo.findOne.mockResolvedValue({
      id: userId,
      email: 'user@example.com',
      status: UserStatus.ACTIVE,
      sessionVersion: 5,
      userRoles: [],
    });

    await expect(service.refreshTokens('replayed-refresh-v4')).rejects.toThrow(
      UnauthorizedException,
    );
    expect(userRepo.update).not.toHaveBeenCalled();
  });

  it('rejects an access JWT submitted to the refresh endpoint', async () => {
    const { service, userRepo, jwtService } = buildAuthService();
    jwtService.verify.mockReturnValue({
      sub: userId,
      email: 'user@example.com',
      roles: ['USER'],
      tokenType: 'access',
      sessionVersion: 4,
    } satisfies JwtPayload);

    await expect(service.refreshTokens('access-token')).rejects.toThrow(UnauthorizedException);
    expect(userRepo.findOne).not.toHaveBeenCalled();
  });

  it('rejects refresh-token replay when the compare-and-swap rotation loses a race', async () => {
    const { service, userRepo, jwtService } = buildAuthService();
    jwtService.verify.mockReturnValue({
      sub: userId,
      email: 'user@example.com',
      roles: ['USER'],
      tokenType: 'refresh',
      sessionVersion: 8,
    } satisfies JwtPayload);
    userRepo.findOne.mockResolvedValue({
      id: userId,
      email: 'user@example.com',
      status: UserStatus.ACTIVE,
      sessionVersion: 8,
      userRoles: [],
    });
    userRepo.update.mockResolvedValue({ affected: 0 });

    await expect(service.refreshTokens('same-refresh-token-twice')).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('logout advances the server-side generation and records an audit event without tokens', async () => {
    const { service, userRepo, auditService } = buildAuthService();
    userRepo.update.mockResolvedValue({ affected: 1 });

    await service.logout(userId, '203.0.113.10');

    expect(userRepo.update).toHaveBeenCalledWith(
      userId,
      expect.objectContaining({ sessionVersion: expect.any(Function) }),
    );
    const audit = auditService.log.mock.calls[0][0];
    expect(audit).toEqual(
      expect.objectContaining({
        actorUserId: userId,
        action: AuditAction.USER_LOGOUT,
        ipAddress: '203.0.113.10',
      }),
    );
    expect(JSON.stringify(audit)).not.toMatch(/refresh-token|access-token/i);
  });

  function buildStrategy() {
    const userRepo = { findOne: jest.fn() };
    const configService = {
      get: jest.fn().mockReturnValue('test-jwt-secret-32-chars-minimum!!!'),
    };
    const strategy = new JwtStrategy(configService as never, userRepo as never);
    return { strategy, userRepo };
  }

  it('JwtStrategy rejects a bearer token whose server-side generation is stale', async () => {
    const { strategy, userRepo } = buildStrategy();
    userRepo.findOne.mockResolvedValue({
      id: userId,
      email: 'user@example.com',
      phone: null,
      status: UserStatus.ACTIVE,
      sessionVersion: 7,
    });

    await expect(
      strategy.validate({
        sub: userId,
        email: 'user@example.com',
        roles: ['USER'],
        tokenType: 'access',
        sessionVersion: 6,
      }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('JwtStrategy rejects a refresh JWT when it is presented as a bearer access token', async () => {
    const { strategy, userRepo } = buildStrategy();

    await expect(
      strategy.validate({
        sub: userId,
        email: 'user@example.com',
        roles: ['USER'],
        tokenType: 'refresh',
        sessionVersion: 7,
      }),
    ).rejects.toThrow(UnauthorizedException);
    expect(userRepo.findOne).not.toHaveBeenCalled();
  });

  it('password reset advances session_version in the same transaction as the password change', async () => {
    const resetToken = {
      id: 'reset-1',
      userId,
      tokenHash: 'stored-hash',
      channel: ResetChannel.EMAIL,
      expiresAt: new Date(Date.now() + 60_000),
      usedAt: null,
      attemptCount: 0,
    } as PasswordResetToken;

    const resetTokenRepo = {
      findOne: jest.fn().mockResolvedValue(resetToken),
      save: jest.fn(),
      update: jest.fn(),
      create: jest.fn(),
    };
    const queryRunner = {
      connect: jest.fn(),
      startTransaction: jest.fn(),
      commitTransaction: jest.fn(),
      rollbackTransaction: jest.fn(),
      release: jest.fn(),
      manager: {
        update: jest.fn().mockResolvedValue({ affected: 1 }),
        save: jest.fn(),
      },
    };
    const dataSource = { createQueryRunner: jest.fn(() => queryRunner) };
    const configService = {
      get: jest.fn((key: string, defaultValue?: unknown) => {
        if (key === 'auth.argon2MemoryCost') return 1024;
        if (key === 'auth.argon2TimeCost') return 2;
        if (key === 'auth.argon2Parallelism') return 1;
        return defaultValue;
      }),
    };
    const auditService = { log: jest.fn() };

    const service = new PasswordResetService(
      resetTokenRepo as never,
      { findOne: jest.fn() } as never,
      configService as never,
      auditService as never,
      { deliver: jest.fn() } as never,
      dataSource as never,
    );

    await service.resetWithToken('raw-reset-token', 'NewStrongPassword123!');

    expect(queryRunner.manager.update).toHaveBeenNthCalledWith(
      1,
      PasswordResetToken,
      expect.objectContaining({ id: resetToken.id, usedAt: expect.anything() }),
      { usedAt: expect.any(Date) },
    );
    expect(queryRunner.manager.update).toHaveBeenNthCalledWith(2, User, userId, {
      passwordHash: expect.any(String),
    });
    expect(queryRunner.manager.update).toHaveBeenNthCalledWith(
      3,
      User,
      { id: userId, mfaEnabled: false },
      { mfaSecret: null, mfaSetupExpiresAt: null },
    );
    expect(queryRunner.manager.update).toHaveBeenNthCalledWith(
      4,
      User,
      userId,
      expect.objectContaining({ sessionVersion: expect.any(Function) }),
    );
    expect(queryRunner.commitTransaction).toHaveBeenCalledTimes(1);
    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.USER_PASSWORD_RESET_COMPLETED,
        metadata: expect.objectContaining({ sessionsRevoked: true }),
      }),
    );
  });
});
