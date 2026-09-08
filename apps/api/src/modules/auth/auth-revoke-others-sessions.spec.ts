import { Request, Response } from 'express';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthCookieService } from './auth-cookie.service';
import { AuthService, BrowserRefreshTokens } from './auth.service';
import { RoleName } from '../users/entities/role.entity';
import { User, UserStatus } from '../users/entities/user.entity';
import { AuditAction } from '../../common/enums/audit-action.enum';
import { AuditSeverity } from '../audit/entities/audit-log.entity';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';

/**
 * Sprint 55 — POST /auth/sessions/revoke-others (service + transports).
 *
 * Semantics: compare-and-set bump of the global session generation v → v+1
 * (kills every OTHER session's access/refresh tokens and realtime sockets via
 * the existing global checks) while immediately re-issuing a fresh token pair
 * to the CALLER at v+1. For HTTP callers, v is the exact generation already
 * validated by JwtStrategy and retained on AuthenticatedPrincipal — never a
 * later database generation observed after authentication. CAS loss
 * (affected !== 1) fails closed: 401, no minting, no audit.
 */

const USER_ID = '11111111-1111-4111-8111-111111111111';
const TRUSTED_BROWSER_ORIGIN = 'https://web.test';

describe('Sprint 55 — POST /auth/sessions/revoke-others', () => {
  function buildService() {
    const userRepo = {
      findOne: jest.fn(),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    const jwtService = {
      verify: jest.fn(),
      sign: jest.fn(
        (payload: { tokenType?: string; sessionVersion?: number }) =>
          `${String(payload.tokenType)}:${String(payload.sessionVersion)}`,
      ),
    };
    const configService = {
      get: jest.fn((_key: string, defaultValue?: unknown) => defaultValue),
    };
    const auditService = { log: jest.fn().mockResolvedValue(undefined) };

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

    const user = {
      id: USER_ID,
      email: 'user@example.com',
      status: UserStatus.ACTIVE,
      sessionVersion: 4,
      userRoles: [{ role: { name: RoleName.USER } }],
    } as unknown as User;

    userRepo.findOne.mockResolvedValue(user);

    return { service, userRepo, jwtService, auditService, user };
  }

  describe('AuthService.revokeOtherSessions', () => {
    it('CAS-bumps the global generation and mints the caller a fresh pair at v+1', async () => {
      const { service, userRepo, jwtService, user } = buildService();

      const result = await service.revokeOtherSessions(user.id, { ipAddress: '203.0.113.10' });

      expect(userRepo.update).toHaveBeenCalledWith(
        { id: user.id, sessionVersion: 4 },
        { sessionVersion: 5 },
      );
      expect(result.accessToken).toBe('access:5');
      expect(result.refreshToken).toBe('refresh:5');
      expect(jwtService.sign).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ tokenType: 'access', sessionVersion: 5 }),
        expect.objectContaining({ expiresIn: '15m' }),
      );
      expect(jwtService.sign).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ tokenType: 'refresh', sessionVersion: 5 }),
        expect.objectContaining({ expiresIn: '7d' }),
      );
    });

    it('audits USER_SESSIONS_REVOKED_OTHERS at INFO severity with the all_other scope', async () => {
      const { service, auditService, user } = buildService();

      await service.revokeOtherSessions(user.id, { ipAddress: '203.0.113.10' });

      expect(auditService.log).toHaveBeenCalledTimes(1);
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          actorUserId: user.id,
          action: AuditAction.USER_SESSIONS_REVOKED_OTHERS,
          resourceType: 'User',
          resourceId: user.id,
          ipAddress: '203.0.113.10',
          metadata: { sessionsRevoked: 'all_other' },
          severity: AuditSeverity.INFO,
        }),
      );
    });

    it('fails closed with 401 on a lost CAS race: no minting, no audit', async () => {
      const { service, userRepo, jwtService, auditService, user } = buildService();
      userRepo.update.mockResolvedValueOnce({ affected: 0 });

      await expect(service.revokeOtherSessions(user.id)).rejects.toThrow(
        new UnauthorizedException('Session state changed concurrently; please retry'),
      );

      expect(jwtService.sign).not.toHaveBeenCalled();
      expect(auditService.log).not.toHaveBeenCalled();
    });

    it('binds the CAS to the bearer generation that authenticated the request, not a later DB generation', async () => {
      const { service, userRepo, jwtService, auditService, user } = buildService();

      // Simulate the race boundary: this request passed JwtStrategy at v=4,
      // then another request advanced the authoritative row to v=5 before this
      // service method loaded it. The stale request must NOT adopt v=5 and
      // advance it to v=6.
      user.sessionVersion = 5;
      userRepo.update.mockResolvedValueOnce({ affected: 0 });

      await expect(
        service.revokeOtherSessions(user.id, { authenticatedSessionVersion: 4 }),
      ).rejects.toThrow(
        new UnauthorizedException('Session state changed concurrently; please retry'),
      );

      expect(userRepo.update).toHaveBeenCalledWith(
        { id: user.id, sessionVersion: 4 },
        { sessionVersion: 5 },
      );
      expect(userRepo.update).not.toHaveBeenCalledWith(
        { id: user.id, sessionVersion: 5 },
        { sessionVersion: 6 },
      );
      expect(jwtService.sign).not.toHaveBeenCalled();
      expect(auditService.log).not.toHaveBeenCalled();
    });

    it('fails closed with 401 for blocked account statuses before any bump', async () => {
      const { service, userRepo, user } = buildService();
      (user as { status: UserStatus }).status = UserStatus.SUSPENDED;

      await expect(service.revokeOtherSessions(user.id)).rejects.toThrow(UnauthorizedException);
      expect(userRepo.update).not.toHaveBeenCalled();
    });

    it('fails closed with 401 when the authenticated user no longer exists', async () => {
      const { service, userRepo } = buildService();
      userRepo.findOne.mockResolvedValueOnce(null);

      await expect(service.revokeOtherSessions(USER_ID)).rejects.toThrow(UnauthorizedException);
      expect(userRepo.update).not.toHaveBeenCalled();
    });

    describe('rememberMe preference', () => {
      it('defaults the body-transport refresh token to rememberMe=false', async () => {
        const { service, jwtService, user } = buildService();

        const result = await service.revokeOtherSessions(user.id);

        expect(result.rememberMe).toBe(false);
        expect(jwtService.verify).not.toHaveBeenCalled();
        expect(jwtService.sign).toHaveBeenNthCalledWith(
          2,
          expect.objectContaining({ tokenType: 'refresh', rememberMe: false }),
          expect.any(Object),
        );
      });

      it('inherits rememberMe=true from a verified same-user refresh cookie', async () => {
        const { service, jwtService, user } = buildService();
        jwtService.verify.mockReturnValue({
          sub: user.id,
          tokenType: 'refresh',
          rememberMe: true,
        });

        const result: BrowserRefreshTokens = await service.revokeOtherSessions(user.id, {
          inheritRememberMeFrom: 'cookie-refresh',
        });

        expect(jwtService.verify).toHaveBeenCalledWith('cookie-refresh');
        expect(result.rememberMe).toBe(true);
        expect(jwtService.sign).toHaveBeenNthCalledWith(
          2,
          expect.objectContaining({ tokenType: 'refresh', rememberMe: true }),
          expect.any(Object),
        );
      });

      it('downgrades cross-user cookie material to session-only', async () => {
        const { service, jwtService, user } = buildService();
        jwtService.verify.mockReturnValue({
          sub: '99999999-9999-4999-8999-999999999999',
          tokenType: 'refresh',
          rememberMe: true,
        });

        const result = await service.revokeOtherSessions(user.id, {
          inheritRememberMeFrom: 'someone-elses-cookie',
        });

        expect(result.rememberMe).toBe(false);
      });

      it('downgrades non-refresh cookie material to session-only', async () => {
        const { service, jwtService, user } = buildService();
        jwtService.verify.mockReturnValue({
          sub: user.id,
          tokenType: 'access',
          rememberMe: true,
        });

        const result = await service.revokeOtherSessions(user.id, {
          inheritRememberMeFrom: 'an-access-token',
        });

        expect(result.rememberMe).toBe(false);
      });

      it('downgrades an unverifiable/expired cookie to session-only', async () => {
        const { service, jwtService, user } = buildService();
        jwtService.verify.mockImplementation(() => {
          throw new Error('jwt expired');
        });

        const result = await service.revokeOtherSessions(user.id, {
          inheritRememberMeFrom: 'expired-cookie',
        });

        expect(result.rememberMe).toBe(false);
      });
    });
  });

  describe('AuthController.revokeOtherSessions transports', () => {
    const principal = {
      userId: USER_ID,
      email: 'user@example.com',
      phone: null,
      roles: [RoleName.USER],
      status: UserStatus.ACTIVE,
      authenticatedSessionVersion: 4,
    } as never;

    function buildController() {
      const authService = {
        revokeOtherSessions: jest.fn().mockResolvedValue({
          accessToken: 'new-access',
          refreshToken: 'new-refresh-rotated',
          rememberMe: true,
        }),
      };
      const configService = {
        get: jest.fn((key: string, def?: unknown) => {
          if (key === 'app.corsOrigins') return [TRUSTED_BROWSER_ORIGIN];
          if (key === 'app.env') return 'test';
          return def;
        }),
      };
      const cookieService = new AuthCookieService(configService as never);
      const controller = new AuthController(
        authService as never,
        cookieService as never,
        {} as never,
      );
      return { controller, authService, cookieService };
    }

    function mockRequest(cookies: Record<string, string> = {}, origin?: string): Request {
      return {
        cookies,
        headers: origin ? { origin } : {},
        ip: '127.0.0.1',
      } as unknown as Request;
    }

    function mockResponse(): Response & { _cookieCalls: unknown[][] } {
      const cookieCalls: unknown[][] = [];
      const res = {
        cookie: jest.fn((...args: unknown[]) => {
          cookieCalls.push(args);
        }),
        clearCookie: jest.fn(),
      };
      return Object.assign(res, { _cookieCalls: cookieCalls }) as unknown as Response & {
        _cookieCalls: unknown[][];
      };
    }

    it('body transport (mobile) returns the full pair, emits no cookie, and inherits nothing', async () => {
      const { controller, authService } = buildController();
      const res = mockResponse();

      const result = await controller.revokeOtherSessions(principal, mockRequest(), res);

      expect(authService.revokeOtherSessions).toHaveBeenCalledWith(USER_ID, {
        authenticatedSessionVersion: 4,
        ipAddress: '127.0.0.1',
        inheritRememberMeFrom: undefined,
      });
      expect(result).toEqual({ accessToken: 'new-access', refreshToken: 'new-refresh-rotated' });
      expect(res.cookie).not.toHaveBeenCalled();
    });

    it('cookie transport (trusted origin) returns accessToken only and rotates the HttpOnly cookie', async () => {
      const { controller, authService } = buildController();
      const req = mockRequest({ irexpro_refresh: 'cookie-refresh' }, TRUSTED_BROWSER_ORIGIN);
      const res = mockResponse();

      const result = await controller.revokeOtherSessions(principal, req, res, 'cookie');

      expect(authService.revokeOtherSessions).toHaveBeenCalledWith(USER_ID, {
        authenticatedSessionVersion: 4,
        ipAddress: '127.0.0.1',
        inheritRememberMeFrom: 'cookie-refresh',
      });
      expect(result).toEqual({ accessToken: 'new-access' });
      expect(JSON.stringify(result)).not.toContain('new-refresh-rotated');
      expect(res.cookie).toHaveBeenCalledWith(
        'irexpro_refresh',
        'new-refresh-rotated',
        expect.objectContaining({ httpOnly: true }),
      );
    });

    it('rejects untrusted browser transport before revocation or cookie issuance', async () => {
      const { controller, authService } = buildController();
      const req = mockRequest({ irexpro_refresh: 'cookie-refresh' }, 'https://attacker.example');
      const res = mockResponse();

      await expect(controller.revokeOtherSessions(principal, req, res, 'cookie')).rejects.toThrow(
        ForbiddenException,
      );

      expect(authService.revokeOtherSessions).not.toHaveBeenCalled();
      expect(res.cookie).not.toHaveBeenCalled();
    });

    it('propagates the CAS-race 401 to the HTTP layer', async () => {
      const { controller, authService } = buildController();
      authService.revokeOtherSessions.mockRejectedValue(
        new UnauthorizedException('Session state changed concurrently; please retry'),
      );

      await expect(
        controller.revokeOtherSessions(principal, mockRequest(), mockResponse()),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('is JWT-guarded and not public (unauthenticated requests are rejected by JwtAuthGuard)', () => {
      const guards = Reflect.getMetadata(
        '__guards__',
        AuthController.prototype.revokeOtherSessions,
      ) as unknown[];
      expect(guards).toContain(JwtAuthGuard);
      expect(
        Reflect.getMetadata('isPublic', AuthController.prototype.revokeOtherSessions),
      ).toBeUndefined();
    });
  });
});
