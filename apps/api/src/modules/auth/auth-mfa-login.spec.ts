import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { DataSource, Repository } from 'typeorm';
import * as argon2 from 'argon2';
import { AuditAction } from '../../common/enums/audit-action.enum';
import { AuditService } from '../audit/audit.service';
import { Role, RoleName } from '../users/entities/role.entity';
import { User, UserStatus } from '../users/entities/user.entity';
import { UserProfile } from '../users/entities/user-profile.entity';
import { UserRole } from '../users/entities/user-role.entity';
import { AuthService } from './auth.service';
import { MfaService } from './mfa.service';

jest.mock('argon2', () => ({
  hash: jest.fn(),
  verify: jest.fn(),
}));

describe('AuthService MFA login enforcement', () => {
  const user: User = {
    id: '11111111-1111-4111-8111-111111111111',
    email: 'user@example.com',
    phone: null,
    passwordHash: 'stored-password-hash',
    status: UserStatus.ACTIVE,
    emailVerifiedAt: new Date(),
    phoneVerifiedAt: null,
    lastLoginAt: null,
    failedLoginAttempts: 0,
    loginLockedUntil: null,
    countryCode: 'GH',
    timezone: null,
    preferredCurrency: null,
    mfaEnabled: true,
    mfaSecret: 'v1.encrypted.secret.envelope',
    mfaSetupExpiresAt: null,
    sessionVersion: 3,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    profile: undefined as never,
    userRoles: [
      {
        id: '22222222-2222-4222-8222-222222222222',
        userId: '11111111-1111-4111-8111-111111111111',
        roleId: '33333333-3333-4333-8333-333333333333',
        createdAt: new Date(),
        user: undefined as never,
        role: { name: RoleName.USER } as Role,
      } as unknown as UserRole,
    ],
  };

  let userRepo: { findOne: jest.Mock; update: jest.Mock };
  let jwtService: { sign: jest.Mock };
  let auditService: { log: jest.Mock };
  let mfaService: { verifyLoginChallenge: jest.Mock };
  let service: AuthService;

  beforeEach(() => {
    jest.clearAllMocks();
    (argon2.verify as jest.Mock).mockResolvedValue(true);

    userRepo = {
      findOne: jest.fn().mockResolvedValue({ ...user }),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    jwtService = {
      sign: jest.fn().mockReturnValueOnce('access-token').mockReturnValueOnce('refresh-token'),
    };
    auditService = { log: jest.fn().mockResolvedValue(undefined) };
    mfaService = { verifyLoginChallenge: jest.fn() };

    const configService = {
      get: jest.fn((_key: string, fallback?: unknown) => fallback),
    } as unknown as ConfigService;

    service = new AuthService(
      userRepo as unknown as Repository<User>,
      {} as Repository<UserProfile>,
      {} as Repository<UserRole>,
      {} as Repository<Role>,
      jwtService as unknown as JwtService,
      configService,
      auditService as unknown as AuditService,
      {} as DataSource,
      mfaService as unknown as MfaService,
    );
  });

  it('returns generic invalid credentials and never signs tokens when MFA challenge fails', async () => {
    mfaService.verifyLoginChallenge.mockReturnValue(false);

    await expect(
      service.login(
        {
          identifier: 'user@example.com',
          password: 'correct-password',
          mfaCode: '000000',
        },
        '127.0.0.1',
      ),
    ).rejects.toThrow('Invalid credentials');

    expect(mfaService.verifyLoginChallenge).toHaveBeenCalledWith(
      expect.objectContaining({ id: user.id, mfaEnabled: true }),
      '000000',
    );
    expect(jwtService.sign).not.toHaveBeenCalled();
    expect(userRepo.update).not.toHaveBeenCalledWith(
      user.id,
      expect.objectContaining({ lastLoginAt: expect.any(Date) }),
    );
    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.USER_LOGIN_FAILED,
        metadata: { reason: 'invalid_mfa', result: 'failed' },
      }),
    );
  });

  it('issues tokens only after password and MFA both succeed', async () => {
    mfaService.verifyLoginChallenge.mockReturnValue(true);

    const tokens = await service.login({
      identifier: 'user@example.com',
      password: 'correct-password',
      mfaCode: '123456',
    });

    expect(tokens).toEqual({ accessToken: 'access-token', refreshToken: 'refresh-token' });
    expect(mfaService.verifyLoginChallenge).toHaveBeenCalledWith(expect.any(Object), '123456');
    expect(userRepo.update).toHaveBeenCalledWith(
      user.id,
      expect.objectContaining({
        lastLoginAt: expect.any(Date),
        failedLoginAttempts: 0,
        loginLockedUntil: null,
      }),
    );
    expect(jwtService.sign).toHaveBeenCalledTimes(2);
    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.USER_LOGIN_SUCCESS,
        metadata: { result: 'success', mfaVerified: true },
      }),
    );
  });
});
