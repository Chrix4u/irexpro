import { INestApplication, UnauthorizedException, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { ThrottlerModule } from '@nestjs/throttler';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
// Supertest exposes a CommonJS callable in this Jest/CommonJS API package.
// eslint-disable-next-line @typescript-eslint/no-require-imports
import request = require('supertest');
import { randomUUID } from 'crypto';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthCookieService } from './auth-cookie.service';
import { PasswordResetService } from './password-reset.service';
import { AuditService } from '../audit/audit.service';
import { User, UserStatus } from '../users/entities/user.entity';
import { JwtStrategy } from './strategies/jwt.strategy';

/**
 * Sprint 55 — HTTP-level verification for the account security center routes.
 *
 * Mirrors the Sprint 48 rate-limit HTTP spec pattern (real Nest requests via
 * supertest with a real ThrottlerGuard) but keeps the REAL JwtAuthGuard and a
 * REAL JwtStrategy, so the unauthenticated 401 paths and the signed-token
 * access paths exercise the actual guard pipeline. The global ValidationPipe
 * is registered exactly like main.ts (whitelist + forbidNonWhitelisted +
 * transform), so the 400 validation behavior matches production.
 *
 * Cookie-transport behavior for revoke-others (trusted-origin boundary +
 * HttpOnly rotation) is covered in auth-revoke-others-sessions.spec.ts with a
 * real AuthCookieService at the controller boundary.
 */

const TEST_JWT_SECRET = 'test-jwt-secret-for-sprint-55-security-center-32chars!';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const CHANGE_PASSWORD_MESSAGE =
  'Password has been changed. All sessions have been revoked — please sign in again.';

describe('Sprint 55 — account security center routes (HTTP)', () => {
  let app: INestApplication;
  let jwtService: JwtService;

  const authService = {
    changePassword: jest.fn().mockResolvedValue(undefined),
    revokeOtherSessions: jest
      .fn()
      .mockResolvedValue({ accessToken: 'new-access', refreshToken: 'new-refresh' }),
  };

  const authCookieService = {
    getRefreshTokenFromCookie: jest.fn().mockReturnValue(null),
    assertTrustedBrowserRequest: jest.fn(),
    setRefreshCookie: jest.fn(),
    clearRefreshCookie: jest.fn(),
  };

  const passwordResetService = {};

  const auditService = {
    listUserSecurityEvents: jest.fn().mockResolvedValue({ events: [], hasMore: false }),
  };

  const userRepo = {
    findOne: jest.fn().mockResolvedValue({
      id: USER_ID,
      email: 'user@example.com',
      phone: null,
      status: UserStatus.ACTIVE,
      sessionVersion: 4,
    }),
  };

  const configService = {
    get: jest.fn((key: string, def?: unknown) => {
      if (key === 'jwt.secret') return TEST_JWT_SECRET;
      return def;
    }),
  };

  function bearerToken(): string {
    return jwtService.sign(
      {
        sub: USER_ID,
        email: 'user@example.com',
        roles: ['USER'],
        tokenType: 'access',
        sessionVersion: 4,
        jti: randomUUID(),
      },
      { expiresIn: '15m' },
    );
  }

  beforeAll(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      imports: [
        ThrottlerModule.forRoot({ throttlers: [{ name: 'default', ttl: 60_000, limit: 100 }] }),
        JwtModule.register({ secret: TEST_JWT_SECRET, signOptions: { expiresIn: '15m' } }),
      ],
      controllers: [AuthController],
      providers: [
        { provide: getRepositoryToken(User), useValue: userRepo },
        { provide: ConfigService, useValue: configService },
        { provide: AuthService, useValue: authService },
        { provide: AuthCookieService, useValue: authCookieService },
        { provide: PasswordResetService, useValue: passwordResetService },
        { provide: AuditService, useValue: auditService },
        JwtStrategy,
      ],
    }).compile();

    app = module.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    await app.init();
    jwtService = module.get(JwtService);
  });

  afterAll(async () => {
    await app.close();
  });

  // Call data is reset per test so `not.toHaveBeenCalled()` assertions stay
  // scoped to the request each test issues. Implementations (mockResolvedValue
  // and friends) survive mockClear and remain from the shared module mocks.
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /auth/change-password', () => {
    const validBody = {
      currentPassword: 'CurrentPassword123',
      newPassword: 'NewStrongPassword123!',
    };

    it('rejects an unauthenticated request with 401 before the service runs', async () => {
      const response = await request(app.getHttpServer())
        .post('/auth/change-password')
        .send(validBody)
        .expect(401);

      expect(response.body.message).toBeDefined();
      expect(authService.changePassword).not.toHaveBeenCalled();
    });

    it('returns 400 for a weak new password before the service runs', async () => {
      await request(app.getHttpServer())
        .post('/auth/change-password')
        .set('Authorization', `Bearer ${bearerToken()}`)
        .send({ currentPassword: 'CurrentPassword123', newPassword: 'weakpass' })
        .expect(400);

      expect(authService.changePassword).not.toHaveBeenCalled();
    });

    it('returns 400 for an unknown request-body field', async () => {
      await request(app.getHttpServer())
        .post('/auth/change-password')
        .set('Authorization', `Bearer ${bearerToken()}`)
        .send({ ...validBody, password: 'aliasing-the-old-field-name' })
        .expect(400);

      expect(authService.changePassword).not.toHaveBeenCalled();
    });

    it('returns 200 with the pinned message on success', async () => {
      const response = await request(app.getHttpServer())
        .post('/auth/change-password')
        .set('Authorization', `Bearer ${bearerToken()}`)
        .send(validBody)
        .expect(200);

      expect(response.body).toEqual({ message: CHANGE_PASSWORD_MESSAGE });
      expect(authService.changePassword).toHaveBeenCalledWith(
        USER_ID,
        'CurrentPassword123',
        'NewStrongPassword123!',
        expect.any(String),
      );
      // The password material never appears in the response.
      expect(JSON.stringify(response.body)).not.toContain('NewStrongPassword123!');
    });

    it('maps failed current-password re-authentication to 401', async () => {
      authService.changePassword.mockRejectedValueOnce(
        new UnauthorizedException('Current password verification failed'),
      );

      const response = await request(app.getHttpServer())
        .post('/auth/change-password')
        .set('Authorization', `Bearer ${bearerToken()}`)
        .send({ currentPassword: 'WrongCurrentPassword1', newPassword: 'NewStrongPassword123!' })
        .expect(401);

      expect(response.body.message).toContain('Current password verification failed');
    });
  });

  describe('POST /auth/sessions/revoke-others', () => {
    it('rejects an unauthenticated request with 401 before the service runs', async () => {
      await request(app.getHttpServer()).post('/auth/sessions/revoke-others').expect(401);

      expect(authService.revokeOtherSessions).not.toHaveBeenCalled();
    });

    it('returns 200 with the fresh token pair on body transport (mobile)', async () => {
      const response = await request(app.getHttpServer())
        .post('/auth/sessions/revoke-others')
        .set('Authorization', `Bearer ${bearerToken()}`)
        .expect(200);

      expect(response.body).toEqual({ accessToken: 'new-access', refreshToken: 'new-refresh' });
      expect(authService.revokeOtherSessions).toHaveBeenCalledWith(USER_ID, {
        ipAddress: expect.any(String),
        inheritRememberMeFrom: undefined,
      });
      expect(authCookieService.setRefreshCookie).not.toHaveBeenCalled();
    });

    it('maps a lost CAS race to 401', async () => {
      authService.revokeOtherSessions.mockRejectedValueOnce(
        new UnauthorizedException('Session state changed concurrently; please retry'),
      );

      const response = await request(app.getHttpServer())
        .post('/auth/sessions/revoke-others')
        .set('Authorization', `Bearer ${bearerToken()}`)
        .expect(401);

      expect(response.body.message).toContain('Session state changed concurrently');
    });
  });

  describe('GET /auth/security-events', () => {
    it('rejects an unauthenticated request with 401 before the audit read runs', async () => {
      await request(app.getHttpServer()).get('/auth/security-events').expect(401);

      expect(auditService.listUserSecurityEvents).not.toHaveBeenCalled();
    });

    it('returns 400 when limit exceeds 100', async () => {
      await request(app.getHttpServer())
        .get('/auth/security-events')
        .set('Authorization', `Bearer ${bearerToken()}`)
        .query({ limit: 101 })
        .expect(400);

      expect(auditService.listUserSecurityEvents).not.toHaveBeenCalled();
    });

    it('returns 400 for a non-numeric limit', async () => {
      await request(app.getHttpServer())
        .get('/auth/security-events')
        .set('Authorization', `Bearer ${bearerToken()}`)
        .query({ limit: 'abc' })
        .expect(400);

      expect(auditService.listUserSecurityEvents).not.toHaveBeenCalled();
    });

    it('returns 200 with the caller-scoped page for valid paging', async () => {
      const page = {
        events: [
          {
            id: 'event-1',
            action: 'USER_PASSWORD_CHANGED',
            createdAt: '2026-09-07T10:30:00.000Z',
            severity: 'INFO',
          },
        ],
        hasMore: false,
      };
      auditService.listUserSecurityEvents.mockResolvedValueOnce(page);

      const response = await request(app.getHttpServer())
        .get('/auth/security-events')
        .set('Authorization', `Bearer ${bearerToken()}`)
        .query({ limit: 50, offset: 10 })
        .expect(200);

      expect(response.body).toEqual(page);
      expect(auditService.listUserSecurityEvents).toHaveBeenCalledWith(USER_ID, {
        limit: 50,
        offset: 10,
      });
    });

    it('defaults to limit 20 / offset 0 when no paging query is supplied', async () => {
      await request(app.getHttpServer())
        .get('/auth/security-events')
        .set('Authorization', `Bearer ${bearerToken()}`)
        .expect(200);

      expect(auditService.listUserSecurityEvents).toHaveBeenCalledWith(USER_ID, {
        limit: 20,
        offset: 0,
      });
    });

    it('rejects a bearer token whose server-side generation is stale (revoked mid-session)', async () => {
      const staleToken = jwtService.sign(
        {
          sub: USER_ID,
          email: 'user@example.com',
          roles: ['USER'],
          tokenType: 'access',
          sessionVersion: 3,
          jti: randomUUID(),
        },
        { expiresIn: '15m' },
      );

      await request(app.getHttpServer())
        .get('/auth/security-events')
        .set('Authorization', `Bearer ${staleToken}`)
        .expect(401);

      expect(auditService.listUserSecurityEvents).not.toHaveBeenCalled();
    });
  });
});
