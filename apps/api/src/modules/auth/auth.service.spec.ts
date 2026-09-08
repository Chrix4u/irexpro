import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { BadRequestException, ConflictException, UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { User, UserStatus } from '../users/entities/user.entity';
import { UserProfile } from '../users/entities/user-profile.entity';
import { UserRole } from '../users/entities/user-role.entity';
import { Role, RoleName } from '../users/entities/role.entity';
import { AuditService } from '../audit/audit.service';

const mockUserRepo = {
  findOne: jest.fn(),
  update: jest.fn(),
};
const mockProfileRepo = { create: jest.fn(), save: jest.fn() };
const mockUserRoleRepo = { create: jest.fn(), save: jest.fn() };
const mockRoleRepo = { findOne: jest.fn() };
const mockJwtService = { sign: jest.fn(() => 'mock_token'), verify: jest.fn() };
/**
 * Use minimal argon2 cost parameters in tests to avoid CPU/memory timeouts.
 * Production values (memoryCost=65536, timeCost=3) are not changed.
 * These are injected via ConfigService — the same path register() and hashPassword() use.
 */
// argon2 enforces: memoryCost >= 1024, timeCost >= 2, parallelism >= 1.
// These values sit at (or near) the library minimums — ~64× cheaper than
// production defaults (65536 / 3 / 1) while still exercising the real hash path.
const TEST_ARGON2_COSTS: Record<string, unknown> = {
  'auth.argon2MemoryCost': 1024,
  'auth.argon2TimeCost': 2,
  'auth.argon2Parallelism': 1,
};
const mockConfigService = {
  get: jest.fn((key: string, def?: unknown) => TEST_ARGON2_COSTS[key] ?? def),
};
const mockAuditService = { log: jest.fn() };
const mockQueryRunner = {
  connect: jest.fn(),
  startTransaction: jest.fn(),
  commitTransaction: jest.fn(),
  rollbackTransaction: jest.fn(),
  release: jest.fn(),
  manager: {
    create: jest.fn(),
    save: jest.fn(),
  },
};
const mockDataSource = { createQueryRunner: jest.fn(() => mockQueryRunner) };

const REFRESH_USER_ID = '11111111-1111-4111-8111-111111111111';
const PHONE_REFRESH_USER_ID = '22222222-2222-4222-8222-222222222222';
const SUB_REFRESH_USER_ID = '33333333-3333-4333-8333-333333333333';
const MISSING_REFRESH_USER_ID = '44444444-4444-4444-8444-444444444444';

describe('AuthService', () => {
  let module: TestingModule;
  let service: AuthService;

  beforeEach(async () => {
    jest.clearAllMocks();

    module = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: getRepositoryToken(User), useValue: mockUserRepo },
        { provide: getRepositoryToken(UserProfile), useValue: mockProfileRepo },
        { provide: getRepositoryToken(UserRole), useValue: mockUserRoleRepo },
        { provide: getRepositoryToken(Role), useValue: mockRoleRepo },
        { provide: JwtService, useValue: mockJwtService },
        { provide: ConfigService, useValue: mockConfigService },
        { provide: AuditService, useValue: mockAuditService },
        { provide: DataSource, useValue: mockDataSource },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  afterEach(async () => {
    await module.close();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('hashPassword / verifyPassword', () => {
    // Argon2 with test-injected low cost (memoryCost=256, timeCost=1) is fast.
    // Timeout is generous to stay safe under parallel worker load on Windows.
    const ARGON2_TEST_TIMEOUT = 10_000;

    it(
      'should hash and verify a password correctly',
      async () => {
        const password = 'TestP@ssw0rd!';
        const hash = await service.hashPassword(password);
        expect(hash).not.toBe(password);
        const isValid = await service.verifyPassword(hash, password);
        expect(isValid).toBe(true);
      },
      ARGON2_TEST_TIMEOUT,
    );

    it(
      'should reject a wrong password',
      async () => {
        const hash = await service.hashPassword('CorrectP@ss1!');
        const isValid = await service.verifyPassword(hash, 'WrongP@ss1!');
        expect(isValid).toBe(false);
      },
      ARGON2_TEST_TIMEOUT,
    );
  });

  describe('register', () => {
    it('should throw ConflictException if email already exists', async () => {
      mockUserRepo.findOne.mockResolvedValueOnce({
        id: 'existing-user',
        email: 'test@example.com',
      });
      await expect(
        service.register({ email: 'test@example.com', password: 'Pass@1234!' }),
      ).rejects.toThrow(ConflictException);
    });

    it('should register a new user and return tokens', async () => {
      mockUserRepo.findOne.mockResolvedValueOnce(null);
      mockRoleRepo.findOne.mockResolvedValueOnce({ id: 'role-id', name: RoleName.USER });
      mockQueryRunner.manager.create.mockReturnValue({
        id: 'new-user-id',
        email: 'new@example.com',
      });
      mockQueryRunner.manager.save.mockResolvedValue({ id: 'new-user-id' });

      const result = await service.register({
        email: 'new@example.com',
        password: 'SecureP@ssw0rd!',
      });
      expect(result).toHaveProperty('accessToken');
      expect(result).toHaveProperty('refreshToken');
      expect(mockAuditService.log).toHaveBeenCalledTimes(1);
      // Hotfix: register must create users as ACTIVE (no verification flow yet)
      expect(mockQueryRunner.manager.create).toHaveBeenCalledWith(
        User,
        expect.objectContaining({ status: UserStatus.ACTIVE }),
      );
    });

    // ── Sprint 27: phone registration ──────────────────────────────────────────

    it('should throw BadRequestException if neither email nor phone is provided', async () => {
      await expect(service.register({ password: 'SecureP@ssw0rd!' })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should register a user with phone only (no email)', async () => {
      mockUserRepo.findOne.mockResolvedValueOnce(null); // no duplicate phone
      mockRoleRepo.findOne.mockResolvedValueOnce({ id: 'role-id', name: RoleName.USER });
      mockQueryRunner.manager.create.mockReturnValue({
        id: 'phone-user-id',
        phone: '+233241234567',
      });
      mockQueryRunner.manager.save.mockResolvedValue({ id: 'phone-user-id' });

      const result = await service.register({
        phone: '+233241234567',
        password: 'SecureP@ssw0rd!',
      });
      expect(result).toHaveProperty('accessToken');
      expect(result).toHaveProperty('refreshToken');
    });

    it('should throw ConflictException if phone already exists', async () => {
      mockUserRepo.findOne.mockResolvedValueOnce({
        id: 'existing-phone-user',
        phone: '+233241234567',
      });
      await expect(
        service.register({ phone: '+233241234567', password: 'SecureP@ssw0rd!' }),
      ).rejects.toThrow(ConflictException);
    });

    it('should register a user with both email and phone', async () => {
      mockUserRepo.findOne
        .mockResolvedValueOnce(null) // no duplicate email
        .mockResolvedValueOnce(null); // no duplicate phone
      mockRoleRepo.findOne.mockResolvedValueOnce({ id: 'role-id', name: RoleName.USER });
      mockQueryRunner.manager.create.mockReturnValue({ id: 'both-user-id' });
      mockQueryRunner.manager.save.mockResolvedValue({ id: 'both-user-id' });

      const result = await service.register({
        email: 'both@example.com',
        phone: '+233241234567',
        password: 'SecureP@ssw0rd!',
      });
      expect(result).toHaveProperty('accessToken');
    });
  });

  describe('login', () => {
    it('should throw UnauthorizedException for unknown email', async () => {
      mockUserRepo.findOne.mockResolvedValueOnce(null);
      await expect(
        service.login({ identifier: 'unknown@example.com', password: 'Pass@1234!' }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('should throw UnauthorizedException for wrong password', async () => {
      // hashPassword() now uses test-injected low argon2 cost (memoryCost=256, timeCost=1)
      // so this completes well within the timeout even on Windows under parallel load.
      const hash = await service.hashPassword('CorrectP@ss1!');
      mockUserRepo.findOne.mockResolvedValueOnce({
        id: 'user-id',
        email: 'test@example.com',
        passwordHash: hash,
        status: UserStatus.ACTIVE,
        userRoles: [],
      });
      await expect(
        service.login({ identifier: 'test@example.com', password: 'WrongP@ss1!' }),
      ).rejects.toThrow(UnauthorizedException);
    }, 10_000);

    it('should throw UnauthorizedException for suspended account', async () => {
      mockUserRepo.findOne.mockResolvedValueOnce({
        id: 'user-id',
        email: 'test@example.com',
        passwordHash: 'some-hash',
        status: UserStatus.SUSPENDED,
        userRoles: [],
      });
      await expect(
        service.login({ identifier: 'test@example.com', password: 'Pass@1234!' }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('should throw UnauthorizedException for permanently locked account', async () => {
      mockUserRepo.findOne.mockResolvedValueOnce({
        id: 'user-id',
        email: 'test@example.com',
        passwordHash: 'some-hash',
        status: UserStatus.PERMANENTLY_LOCKED,
        userRoles: [],
      });
      await expect(
        service.login({ identifier: 'test@example.com', password: 'Pass@1234!' }),
      ).rejects.toThrow(UnauthorizedException);
    });
  });

  // ── Sprint 25: refresh token flow (mobile JSON body + web/admin cookie) ──────────
  // Hotfix: extended to cover null-email, empty-roles, PENDING_VERIFICATION,
  // CLOSED status, sub-based lookup, and expired-token (401 not 500).

  describe('refreshTokens (Sprint 25 — mobile JSON body + web/admin cookie)', () => {
    it('should return new tokens when given a valid refresh token (mobile flow)', async () => {
      const mockPayload = {
        sub: REFRESH_USER_ID,
        email: 'test@example.com',
        roles: [RoleName.USER],
        tokenType: 'refresh' as const,
      };
      mockJwtService.verify.mockReturnValueOnce(mockPayload);
      mockUserRepo.findOne.mockResolvedValueOnce({
        id: REFRESH_USER_ID,
        email: 'test@example.com',
        status: UserStatus.ACTIVE,
        userRoles: [{ role: { name: RoleName.USER } }],
      });

      const result = await service.refreshTokens('valid-refresh-token');

      expect(result).toHaveProperty('accessToken');
      expect(result).toHaveProperty('refreshToken');
      expect(mockJwtService.verify).toHaveBeenCalledWith('valid-refresh-token');
    });

    it('should throw UnauthorizedException for an invalid refresh token', async () => {
      mockJwtService.verify.mockImplementationOnce(() => {
        throw new Error('invalid token');
      });

      await expect(service.refreshTokens('invalid-token')).rejects.toThrow(UnauthorizedException);
    });

    it('should reject a signed JWT with no explicit tokenType before user lookup', async () => {
      mockJwtService.verify.mockReturnValueOnce({
        sub: REFRESH_USER_ID,
        email: 'test@example.com',
        roles: [RoleName.USER],
        sessionVersion: 1,
      });

      await expect(service.refreshTokens('untyped-token')).rejects.toThrow(UnauthorizedException);
      expect(mockUserRepo.findOne).not.toHaveBeenCalled();
    });

    it('should reject an access token at the refresh boundary before user lookup', async () => {
      mockJwtService.verify.mockReturnValueOnce({
        sub: REFRESH_USER_ID,
        email: 'test@example.com',
        roles: [RoleName.USER],
        tokenType: 'access',
        sessionVersion: 1,
      });

      await expect(service.refreshTokens('access-token')).rejects.toThrow(UnauthorizedException);
      expect(mockUserRepo.findOne).not.toHaveBeenCalled();
    });

    it('should throw UnauthorizedException if user is not found', async () => {
      const mockPayload = {
        sub: MISSING_REFRESH_USER_ID,
        email: 'x@example.com',
        roles: [],
        tokenType: 'refresh' as const,
      };
      mockJwtService.verify.mockReturnValueOnce(mockPayload);
      mockUserRepo.findOne.mockResolvedValueOnce(null);

      await expect(service.refreshTokens('some-token')).rejects.toThrow(UnauthorizedException);
    });

    it('should throw UnauthorizedException if user status is SUSPENDED', async () => {
      const mockPayload = {
        sub: REFRESH_USER_ID,
        email: 'test@example.com',
        roles: [],
        tokenType: 'refresh' as const,
      };
      mockJwtService.verify.mockReturnValueOnce(mockPayload);
      mockUserRepo.findOne.mockResolvedValueOnce({
        id: REFRESH_USER_ID,
        status: UserStatus.SUSPENDED,
        userRoles: [],
      });

      await expect(service.refreshTokens('some-token')).rejects.toThrow(UnauthorizedException);
    });

    it('should throw UnauthorizedException if user status is CLOSED', async () => {
      const mockPayload = {
        sub: REFRESH_USER_ID,
        email: 'test@example.com',
        roles: [],
        tokenType: 'refresh' as const,
      };
      mockJwtService.verify.mockReturnValueOnce(mockPayload);
      mockUserRepo.findOne.mockResolvedValueOnce({
        id: REFRESH_USER_ID,
        status: UserStatus.CLOSED,
        userRoles: [],
      });

      await expect(service.refreshTokens('some-token')).rejects.toThrow(UnauthorizedException);
    });

    it('should throw UnauthorizedException if user status is PERMANENTLY_LOCKED', async () => {
      const mockPayload = {
        sub: REFRESH_USER_ID,
        email: 'test@example.com',
        roles: [],
        tokenType: 'refresh' as const,
      };
      mockJwtService.verify.mockReturnValueOnce(mockPayload);
      mockUserRepo.findOne.mockResolvedValueOnce({
        id: REFRESH_USER_ID,
        status: UserStatus.PERMANENTLY_LOCKED,
        userRoles: [],
      });

      await expect(service.refreshTokens('some-token')).rejects.toThrow(UnauthorizedException);
    });

    // ── Hotfix: refresh works for phone-only users (email is null) ──────────

    it('should refresh successfully when user email is null (phone-only user)', async () => {
      const mockPayload = {
        sub: PHONE_REFRESH_USER_ID,
        email: null,
        roles: [RoleName.USER],
        tokenType: 'refresh' as const,
      };
      mockJwtService.verify.mockReturnValueOnce(mockPayload);
      mockUserRepo.findOne.mockResolvedValueOnce({
        id: PHONE_REFRESH_USER_ID,
        email: null,
        phone: '+233241234567',
        status: UserStatus.ACTIVE,
        userRoles: [{ role: { name: RoleName.USER } }],
      });

      const result = await service.refreshTokens('phone-user-refresh-token');

      expect(result).toHaveProperty('accessToken');
      expect(result).toHaveProperty('refreshToken');
    });

    // ── Hotfix: refresh works when roles array is empty ─────────────────────

    it('should refresh successfully when roles array is empty', async () => {
      const mockPayload = {
        sub: REFRESH_USER_ID,
        email: 'test@example.com',
        roles: [],
        tokenType: 'refresh' as const,
      };
      mockJwtService.verify.mockReturnValueOnce(mockPayload);
      mockUserRepo.findOne.mockResolvedValueOnce({
        id: REFRESH_USER_ID,
        email: 'test@example.com',
        status: UserStatus.ACTIVE,
        userRoles: [],
      });

      const result = await service.refreshTokens('empty-roles-refresh-token');

      expect(result).toHaveProperty('accessToken');
      expect(result).toHaveProperty('refreshToken');
    });

    // ── Hotfix: refresh loads user by sub (not by email) ────────────────────

    it('should load the user by payload.sub (not by email)', async () => {
      const mockPayload = {
        sub: SUB_REFRESH_USER_ID,
        email: 'old@example.com',
        roles: [],
        tokenType: 'refresh' as const,
      };
      mockJwtService.verify.mockReturnValueOnce(mockPayload);
      mockUserRepo.findOne.mockResolvedValueOnce({
        id: SUB_REFRESH_USER_ID,
        email: 'new@example.com',
        status: UserStatus.ACTIVE,
        userRoles: [{ role: { name: RoleName.USER } }],
      });

      const result = await service.refreshTokens('token');

      expect(mockUserRepo.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: SUB_REFRESH_USER_ID },
        }),
      );
      expect(result).toHaveProperty('accessToken');
    });

    // ── Hotfix: PENDING_VERIFICATION users can refresh (no activation flow) ─

    it('should allow refresh for PENDING_VERIFICATION users (no activation flow exists)', async () => {
      const mockPayload = {
        sub: REFRESH_USER_ID,
        email: 'test@example.com',
        roles: [],
        tokenType: 'refresh' as const,
      };
      mockJwtService.verify.mockReturnValueOnce(mockPayload);
      mockUserRepo.findOne.mockResolvedValueOnce({
        id: REFRESH_USER_ID,
        email: 'test@example.com',
        status: UserStatus.PENDING_VERIFICATION,
        userRoles: [{ role: { name: RoleName.USER } }],
      });

      const result = await service.refreshTokens('pending-user-token');

      expect(result).toHaveProperty('accessToken');
      expect(result).toHaveProperty('refreshToken');
    });

    // ── Hotfix: expired token returns 401 (not 500) ─────────────────────────

    it('should throw UnauthorizedException (not 500) for an expired token', async () => {
      mockJwtService.verify.mockImplementationOnce(() => {
        const err = new Error('jwt expired');
        (err as Error & { name: string }).name = 'TokenExpiredError';
        throw err;
      });

      await expect(service.refreshTokens('expired-token')).rejects.toThrow(UnauthorizedException);
    });

    // ── Hotfix: refresh does not expose sensitive fields ────────────────────

    it('should not include passwordHash or mfaSecret in the generated token payload', async () => {
      const mockPayload = {
        sub: REFRESH_USER_ID,
        email: 'test@example.com',
        roles: [],
        tokenType: 'refresh' as const,
      };
      mockJwtService.verify.mockReturnValueOnce(mockPayload);
      mockUserRepo.findOne.mockResolvedValueOnce({
        id: REFRESH_USER_ID,
        email: 'test@example.com',
        status: UserStatus.ACTIVE,
        passwordHash: 'super_secret_hash',
        mfaSecret: 'super_secret_mfa',
        userRoles: [{ role: { name: RoleName.USER } }],
      });

      await service.refreshTokens('token');

      const calls = mockJwtService.sign.mock.calls as unknown as Array<
        [Record<string, unknown>, unknown]
      >;
      expect(calls.length).toBeGreaterThan(0);
      const signedPayload = calls[0][0];
      expect(signedPayload).not.toHaveProperty('passwordHash');
      expect(signedPayload).not.toHaveProperty('mfaSecret');
      expect(signedPayload.sub).toBe(REFRESH_USER_ID);
    });
  });

  // ── Sprint 25: /auth/me frontend-safe AuthUserDto ───────────────────────────

  describe('getAuthUserDto (Sprint 25 — frontend-safe /auth/me)', () => {
    it('should return a frontend-safe DTO with roles and profile fields', async () => {
      const mockUser = {
        id: 'user-123',
        email: 'trader@example.com',
        countryCode: 'GH',
        status: UserStatus.ACTIVE,
        mfaEnabled: false,
        lastLoginAt: new Date('2026-01-15T10:00:00Z'),
        createdAt: new Date('2026-01-01T00:00:00Z'),
        passwordHash: 'secret_hash',
        mfaSecret: 'secret_mfa',
        deletedAt: null,
        profile: {
          firstName: 'John',
          lastName: 'Doe',
        },
      };
      mockUserRepo.findOne.mockResolvedValueOnce(mockUser);

      const dto = await service.getAuthUserDto('user-123', [RoleName.USER]);

      expect(dto.id).toBe('user-123');
      expect(dto.email).toBe('trader@example.com');
      expect(dto.firstName).toBe('John');
      expect(dto.lastName).toBe('Doe');
      expect(dto.countryCode).toBe('GH');
      expect(dto.status).toBe('ACTIVE');
      expect(dto.roles).toEqual([RoleName.USER]);
      expect(dto.mfaEnabled).toBe(false);
      expect(dto.lastLoginAt).toBe('2026-01-15T10:00:00.000Z');
      expect(dto.createdAt).toBe('2026-01-01T00:00:00.000Z');

      expect(dto).not.toHaveProperty('passwordHash');
      expect(dto).not.toHaveProperty('mfaSecret');
      expect(dto).not.toHaveProperty('deletedAt');
      expect(dto).not.toHaveProperty('userRoles');
      expect(dto).not.toHaveProperty('profile');
    });

    it('should include ADMIN role when the user has an admin role', async () => {
      const mockUser = {
        id: 'admin-123',
        email: 'admin@example.com',
        countryCode: 'US',
        status: UserStatus.ACTIVE,
        mfaEnabled: true,
        lastLoginAt: null,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        passwordHash: 'secret_hash',
        mfaSecret: 'secret_mfa',
        deletedAt: null,
        profile: { firstName: 'Admin', lastName: 'User' },
      };
      mockUserRepo.findOne.mockResolvedValueOnce(mockUser);

      const dto = await service.getAuthUserDto('admin-123', [RoleName.ADMIN, RoleName.SUPER_ADMIN]);

      expect(dto.roles).toContain(RoleName.ADMIN);
      expect(dto.roles).toContain(RoleName.SUPER_ADMIN);
      expect(dto.roles).not.toContain(RoleName.USER);
    });

    it('should NOT include passwordHash, mfaSecret, deletedAt, or profile PII', async () => {
      const mockUser = {
        id: 'user-456',
        email: 'user@example.com',
        countryCode: null,
        status: UserStatus.PENDING_VERIFICATION,
        mfaEnabled: false,
        lastLoginAt: null,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        passwordHash: 'very_secret_hash',
        mfaSecret: 'very_secret_mfa',
        deletedAt: new Date('2026-01-02T00:00:00Z'),
        profile: {
          firstName: null,
          lastName: null,
          dateOfBirth: '1990-01-01',
          addressLine1: '123 Secret St',
          kycStatus: 'PENDING',
          riskDisclosureAccepted: false,
        },
      };
      mockUserRepo.findOne.mockResolvedValueOnce(mockUser);

      const dto = await service.getAuthUserDto('user-456', [RoleName.USER]);

      const serialized = JSON.stringify(dto);
      expect(serialized).not.toContain('passwordHash');
      expect(serialized).not.toContain('mfaSecret');
      expect(serialized).not.toContain('deletedAt');
      expect(serialized).not.toContain('dateOfBirth');
      expect(serialized).not.toContain('addressLine1');
      expect(serialized).not.toContain('kycStatus');
      expect(serialized).not.toContain('riskDisclosureAccepted');
    });

    it('should throw UnauthorizedException if user is not found', async () => {
      mockUserRepo.findOne.mockResolvedValueOnce(null);
      await expect(service.getAuthUserDto('nonexistent-id', [RoleName.USER])).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('should handle null profile gracefully (firstName/lastName = null)', async () => {
      const mockUser = {
        id: 'user-789',
        email: 'noprofile@example.com',
        countryCode: 'NG',
        status: UserStatus.ACTIVE,
        mfaEnabled: false,
        lastLoginAt: null,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        passwordHash: 'hash',
        mfaSecret: null,
        deletedAt: null,
        profile: null,
      };
      mockUserRepo.findOne.mockResolvedValueOnce(mockUser);

      const dto = await service.getAuthUserDto('user-789', [RoleName.USER]);

      expect(dto.firstName).toBeNull();
      expect(dto.lastName).toBeNull();
    });
  });
});
