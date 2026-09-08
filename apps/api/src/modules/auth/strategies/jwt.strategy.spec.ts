import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { UnauthorizedException } from '@nestjs/common';
import { JwtStrategy, JwtPayload } from './jwt.strategy';
import { User, UserStatus } from '../../users/entities/user.entity';

/**
 * JwtStrategy tests — Hotfix: sanitized AuthenticatedPrincipal.
 *
 * Verifies:
 *   - validate() returns userId (not id)
 *   - passwordHash is absent from the principal
 *   - mfaSecret is absent
 *   - userRoles are absent
 *   - roles are preserved from the JWT payload
 *   - the server-validated session generation is retained for downstream CAS-bound auth mutations
 *   - email and phone are nullable
 *   - SUSPENDED/PERMANENTLY_LOCKED/CLOSED users are rejected
 *   - missing subject is rejected
 *   - only explicitly typed access tokens are accepted
 */
describe('JwtStrategy (Hotfix — sanitized principal)', () => {
  let strategy: JwtStrategy;
  let userRepo: { findOne: jest.Mock };
  let configService: { get: jest.Mock };

  beforeEach(async () => {
    userRepo = {
      findOne: jest.fn(),
    };
    configService = {
      get: jest.fn().mockReturnValue('test-jwt-secret-32-chars-minimum!!!'),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        JwtStrategy,
        { provide: ConfigService, useValue: configService },
        { provide: getRepositoryToken(User), useValue: userRepo },
      ],
    }).compile();

    strategy = module.get<JwtStrategy>(JwtStrategy);
  });

  const validPayload: JwtPayload = {
    sub: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    email: 'user@example.com',
    roles: ['USER'],
    tokenType: 'access',
    sessionVersion: 1,
  };

  const mockUser = {
    id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    email: 'user@example.com',
    phone: '+233243618186',
    status: UserStatus.ACTIVE,
    sessionVersion: 1,
    // These fields would be on the full entity but should NEVER be in the principal
    passwordHash: 'super_secret_hash',
    mfaSecret: 'super_secret_mfa',
    userRoles: [{ role: { name: 'USER' } }],
  };

  it('should return an AuthenticatedPrincipal with userId (not id)', async () => {
    userRepo.findOne.mockResolvedValue(mockUser);
    const result = await strategy.validate(validPayload);
    expect(result.userId).toBe('a1b2c3d4-e5f6-7890-abcd-ef1234567890');
    expect(result).not.toHaveProperty('id');
  });

  it('should NOT include passwordHash in the principal', async () => {
    userRepo.findOne.mockResolvedValue(mockUser);
    const result = await strategy.validate(validPayload);
    expect(result).not.toHaveProperty('passwordHash');
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('super_secret_hash');
  });

  it('should NOT include mfaSecret in the principal', async () => {
    userRepo.findOne.mockResolvedValue(mockUser);
    const result = await strategy.validate(validPayload);
    expect(result).not.toHaveProperty('mfaSecret');
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('super_secret_mfa');
  });

  it('should NOT include userRoles in the principal', async () => {
    userRepo.findOne.mockResolvedValue(mockUser);
    const result = await strategy.validate(validPayload);
    expect(result).not.toHaveProperty('userRoles');
  });

  it('should preserve roles from the JWT payload', async () => {
    userRepo.findOne.mockResolvedValue(mockUser);
    const result = await strategy.validate({ ...validPayload, roles: ['USER', 'ADMIN'] });
    expect(result.roles).toEqual(['USER', 'ADMIN']);
  });

  it('should preserve the server-validated session generation for downstream auth CAS operations', async () => {
    userRepo.findOne.mockResolvedValue({ ...mockUser, sessionVersion: 7 });
    const result = await strategy.validate({ ...validPayload, sessionVersion: 7 });
    expect(result.authenticatedSessionVersion).toBe(7);
  });

  it('should handle nullable email', async () => {
    userRepo.findOne.mockResolvedValue({ ...mockUser, email: null });
    const result = await strategy.validate({ ...validPayload, email: null });
    expect(result.email).toBeNull();
  });

  it('should handle nullable phone', async () => {
    userRepo.findOne.mockResolvedValue({ ...mockUser, phone: null });
    const result = await strategy.validate(validPayload);
    expect(result.phone).toBeNull();
  });

  it('should reject SUSPENDED users', async () => {
    userRepo.findOne.mockResolvedValue({ ...mockUser, status: UserStatus.SUSPENDED });
    await expect(strategy.validate(validPayload)).rejects.toThrow(UnauthorizedException);
  });

  it('should reject CLOSED users', async () => {
    userRepo.findOne.mockResolvedValue({ ...mockUser, status: UserStatus.CLOSED });
    await expect(strategy.validate(validPayload)).rejects.toThrow(UnauthorizedException);
  });

  it('should reject PERMANENTLY_LOCKED users', async () => {
    userRepo.findOne.mockResolvedValue({ ...mockUser, status: UserStatus.PERMANENTLY_LOCKED });
    await expect(strategy.validate(validPayload)).rejects.toThrow(UnauthorizedException);
  });

  it('should reject when user is not found', async () => {
    userRepo.findOne.mockResolvedValue(null);
    await expect(strategy.validate(validPayload)).rejects.toThrow(UnauthorizedException);
  });

  it('should reject when payload.sub is missing', async () => {
    await expect(strategy.validate({ ...validPayload, sub: '' } as JwtPayload)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('should reject a bearer token with no explicit tokenType', async () => {
    const untypedPayload: JwtPayload = {
      sub: validPayload.sub,
      email: validPayload.email,
      roles: validPayload.roles,
      sessionVersion: validPayload.sessionVersion,
    };

    await expect(strategy.validate(untypedPayload)).rejects.toThrow(UnauthorizedException);
    expect(userRepo.findOne).not.toHaveBeenCalled();
  });

  it('should reject a refresh token at the bearer access boundary', async () => {
    await expect(strategy.validate({ ...validPayload, tokenType: 'refresh' })).rejects.toThrow(
      UnauthorizedException,
    );
    expect(userRepo.findOne).not.toHaveBeenCalled();
  });

  it('should return a principal that satisfies the AuthenticatedPrincipal interface', async () => {
    userRepo.findOne.mockResolvedValue(mockUser);
    const result = await strategy.validate(validPayload);
    // Verify all required fields are present
    expect(result).toHaveProperty('userId');
    expect(result).toHaveProperty('email');
    expect(result).toHaveProperty('phone');
    expect(result).toHaveProperty('roles');
    expect(result).toHaveProperty('status');
    expect(result).toHaveProperty('authenticatedSessionVersion');
    // Verify the shape matches exactly the sanitized principal keys (no secrets/extras).
    expect(Object.keys(result).sort()).toEqual([
      'authenticatedSessionVersion',
      'email',
      'phone',
      'roles',
      'status',
      'userId',
    ]);
  });
});
