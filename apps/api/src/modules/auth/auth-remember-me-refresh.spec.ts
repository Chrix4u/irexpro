import { Request, Response } from 'express';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { RoleName } from '../users/entities/role.entity';
import { User, UserStatus } from '../users/entities/user.entity';

const USER_ID = '11111111-1111-4111-8111-111111111111';

function makeAuthService() {
  const userRepo = {
    findOne: jest.fn(),
    update: jest.fn(),
  };
  const jwtService = {
    verify: jest.fn(),
    sign: jest.fn((payload: { tokenType?: string }) =>
      payload.tokenType === 'access' ? 'rotated-access' : 'rotated-refresh',
    ),
  };
  const configService = {
    get: jest.fn((_key: string, defaultValue?: unknown) => defaultValue),
  };
  const auditService = { log: jest.fn() };

  const service = new AuthService(
    userRepo as never,
    {} as never,
    {} as never,
    {} as never,
    jwtService as never,
    configService as never,
    auditService as never,
    {} as never,
  );

  const activeUser = {
    id: USER_ID,
    email: 'user@example.com',
    status: UserStatus.ACTIVE,
    sessionVersion: 1,
    userRoles: [{ role: { name: RoleName.USER } }],
  } as unknown as User;

  userRepo.findOne.mockResolvedValue(activeUser);
  userRepo.update.mockResolvedValue({ affected: 1 });
  auditService.log.mockResolvedValue(undefined);

  return { service, userRepo, jwtService };
}

describe('remember-me refresh rotation', () => {
  it('carries signed rememberMe=true through browser refresh rotation', async () => {
    const { service, jwtService } = makeAuthService();
    jwtService.verify.mockReturnValue({
      sub: USER_ID,
      email: 'user@example.com',
      roles: [RoleName.USER],
      tokenType: 'refresh',
      sessionVersion: 1,
      rememberMe: true,
    });

    const result = await service.refreshBrowserTokens('incoming-refresh');

    expect(result).toEqual({
      accessToken: 'rotated-access',
      refreshToken: 'rotated-refresh',
      rememberMe: true,
    });
    expect(jwtService.sign).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ tokenType: 'refresh', rememberMe: true }),
      expect.objectContaining({ expiresIn: '7d' }),
    );
    expect(jwtService.sign.mock.calls[0]?.[0]).not.toHaveProperty('rememberMe');
  });

  it('downgrades a legacy refresh token without rememberMe to session-only', async () => {
    const { service, jwtService } = makeAuthService();
    jwtService.verify.mockReturnValue({
      sub: USER_ID,
      email: 'user@example.com',
      roles: [RoleName.USER],
      tokenType: 'refresh',
      sessionVersion: 1,
    });

    const result = await service.refreshBrowserTokens('legacy-refresh');

    expect(result.rememberMe).toBe(false);
    expect(jwtService.sign).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ tokenType: 'refresh', rememberMe: false }),
      expect.any(Object),
    );
  });

  it('keeps native/body refresh responses limited to the two-token contract', async () => {
    const { service, jwtService } = makeAuthService();
    jwtService.verify.mockReturnValue({
      sub: USER_ID,
      email: 'user@example.com',
      roles: [RoleName.USER],
      tokenType: 'refresh',
      sessionVersion: 1,
      rememberMe: true,
    });

    const result = await service.refreshTokens('native-refresh');

    expect(result).toEqual({
      accessToken: 'rotated-access',
      refreshToken: 'rotated-refresh',
    });
    expect(result).not.toHaveProperty('rememberMe');
  });

  it('uses signed persistence metadata when rotating a browser cookie', async () => {
    const authService = {
      refreshBrowserTokens: jest.fn().mockResolvedValue({
        accessToken: 'rotated-access',
        refreshToken: 'rotated-refresh',
        rememberMe: true,
      }),
      refreshTokens: jest.fn(),
    };
    const cookieService = {
      getRefreshTokenFromCookie: jest.fn().mockReturnValue('cookie-refresh'),
      assertTrustedBrowserRequest: jest.fn(),
      setRefreshCookie: jest.fn(),
    };
    const controller = new AuthController(
      authService as never,
      cookieService as never,
      {} as never,
    );
    const req = {} as Request;
    const res = {} as Response;

    const result = await controller.refresh(req, undefined, res);

    expect(cookieService.assertTrustedBrowserRequest).toHaveBeenCalledWith(req);
    expect(authService.refreshBrowserTokens).toHaveBeenCalledWith('cookie-refresh');
    expect(cookieService.setRefreshCookie).toHaveBeenCalledWith(res, 'rotated-refresh', true);
    expect(authService.refreshTokens).not.toHaveBeenCalled();
    expect(result).toEqual({ accessToken: 'rotated-access' });
  });

  it('leaves native/body refresh cookie-free and returns only access/refresh tokens', async () => {
    const authService = {
      refreshBrowserTokens: jest.fn(),
      refreshTokens: jest.fn().mockResolvedValue({
        accessToken: 'native-access',
        refreshToken: 'native-refresh-rotated',
      }),
    };
    const cookieService = {
      getRefreshTokenFromCookie: jest.fn().mockReturnValue(undefined),
      assertTrustedBrowserRequest: jest.fn(),
      setRefreshCookie: jest.fn(),
    };
    const controller = new AuthController(
      authService as never,
      cookieService as never,
      {} as never,
    );

    const result = await controller.refresh(
      {} as Request,
      { refreshToken: 'native-refresh' },
      {} as Response,
    );

    expect(authService.refreshTokens).toHaveBeenCalledWith('native-refresh');
    expect(authService.refreshBrowserTokens).not.toHaveBeenCalled();
    expect(cookieService.setRefreshCookie).not.toHaveBeenCalled();
    expect(result).toEqual({
      accessToken: 'native-access',
      refreshToken: 'native-refresh-rotated',
    });
    expect(result).not.toHaveProperty('rememberMe');
  });
});
