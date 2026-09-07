import { instanceToPlain } from 'class-transformer';
import { User, UserStatus } from './user.entity';

function buildUser(): User {
  return Object.assign(new User(), {
    id: '11111111-1111-4111-8111-111111111111',
    email: 'user@example.com',
    phone: '+233200000000',
    passwordHash: 'password-hash-secret',
    status: UserStatus.ACTIVE,
    emailVerifiedAt: new Date('2026-01-01T00:00:00.000Z'),
    phoneVerifiedAt: null,
    lastLoginAt: new Date('2026-09-05T12:00:00.000Z'),
    failedLoginAttempts: 4,
    loginLockedUntil: new Date('2026-09-05T13:00:00.000Z'),
    countryCode: 'GH',
    timezone: 'Africa/Accra',
    preferredCurrency: 'GHS',
    mfaEnabled: true,
    mfaSecret: 'totp-secret',
    mfaSetupExpiresAt: new Date('2026-09-05T12:10:00.000Z'),
    sessionVersion: 27,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-09-05T12:00:00.000Z'),
    deletedAt: null,
    profile: undefined,
    userRoles: [],
  });
}

describe('User serialization privacy', () => {
  it('excludes authentication internals while preserving frontend account fields', () => {
    const plain = instanceToPlain(buildUser());

    expect(plain).toEqual(
      expect.objectContaining({
        id: '11111111-1111-4111-8111-111111111111',
        email: 'user@example.com',
        phone: '+233200000000',
        status: UserStatus.ACTIVE,
        countryCode: 'GH',
        timezone: 'Africa/Accra',
        preferredCurrency: 'GHS',
        mfaEnabled: true,
      }),
    );

    expect(plain).not.toHaveProperty('passwordHash');
    expect(plain).not.toHaveProperty('mfaSecret');
    expect(plain).not.toHaveProperty('mfaSetupExpiresAt');
    expect(plain).not.toHaveProperty('failedLoginAttempts');
    expect(plain).not.toHaveProperty('loginLockedUntil');
    expect(plain).not.toHaveProperty('sessionVersion');
  });

  it('keeps sessionVersion available to server-side code before serialization', () => {
    const user = buildUser();
    expect(user.sessionVersion).toBe(27);
  });
});
