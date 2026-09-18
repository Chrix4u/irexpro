import { ConfigService } from '@nestjs/config';
import { createHash, createHmac } from 'crypto';
import { DataSource, Repository } from 'typeorm';
import { AuditAction } from '../../common/enums/audit-action.enum';
import { AuditService } from '../audit/audit.service';
import { User, UserStatus } from '../users/entities/user.entity';
import { EmailVerificationDeliveryService } from './email-verification-delivery.service';
import { AuthVerificationToken } from './entities/auth-verification-token.entity';
import { PhoneVerificationDeliveryService } from './phone-verification-delivery.service';
import { VerificationService } from './verification.service';

describe('VerificationService request flow', () => {
  const verificationPepper = 'phone-verification-pepper-32-bytes-minimum';

  function createIssuanceDataSource(
    user: User,
    tokenRepo: {
      update: jest.Mock;
      save: jest.Mock;
    },
  ): DataSource {
    const queryRunner = {
      connect: jest.fn(),
      startTransaction: jest.fn(),
      commitTransaction: jest.fn(),
      rollbackTransaction: jest.fn(),
      release: jest.fn(),
      isTransactionActive: true,
      manager: {
        findOne: jest.fn().mockResolvedValue({ id: user.id }),
        getRepository: jest.fn().mockReturnValue(tokenRepo),
      },
    };
    return { createQueryRunner: jest.fn().mockReturnValue(queryRunner) } as unknown as DataSource;
  }

  it('persists only a SHA-256 email token hash and keeps the raw token out of the request URL query', async () => {
    const user = {
      id: '11111111-1111-4111-8111-111111111111',
      email: 'user@example.com',
      emailVerifiedAt: null,
      status: UserStatus.ACTIVE,
    } as User;

    const userRepo = {
      findOne: jest.fn().mockResolvedValue(user),
    };
    const saved: Partial<AuthVerificationToken>[] = [];
    const tokenRepo = {
      update: jest.fn().mockResolvedValue({ affected: 0 }),
      create: jest.fn((value: Partial<AuthVerificationToken>) => value),
      save: jest.fn(async (value: Partial<AuthVerificationToken>) => {
        saved.push(value);
        return value;
      }),
    };
    const emailDelivery = {
      isConfigured: jest.fn().mockReturnValue(true),
      send: jest.fn().mockResolvedValue(true),
    };
    const phoneDelivery = {
      isConfigured: jest.fn().mockReturnValue(false),
      sendVerificationCode: jest.fn(),
    };
    const configService = {
      get: jest.fn((key: string, fallback?: unknown) => {
        if (key === 'app.webBaseUrl') return 'https://app.example.test';
        if (key === 'email.fromAddress') return 'no-reply@example.test';
        if (key === 'auth.verificationPepper') return verificationPepper;
        return fallback;
      }),
    } as unknown as ConfigService;
    const auditService = { log: jest.fn().mockResolvedValue(undefined) };

    const service = new VerificationService(
      userRepo as unknown as Repository<User>,
      tokenRepo as unknown as Repository<AuthVerificationToken>,
      emailDelivery as unknown as EmailVerificationDeliveryService,
      phoneDelivery as unknown as PhoneVerificationDeliveryService,
      configService,
      auditService as unknown as AuditService,
      createIssuanceDataSource(user, tokenRepo),
    );

    await service.requestEmailVerification(user.id, {
      ipAddress: '127.0.0.1',
      userAgent: 'verification-test-agent',
    });

    expect(saved).toHaveLength(1);
    expect(emailDelivery.send).toHaveBeenCalledTimes(1);

    const verificationLink = emailDelivery.send.mock.calls[0][0].verificationLink as string;
    const parsedLink = new URL(verificationLink);
    expect(parsedLink.pathname).toBe('/verify-email');
    expect(parsedLink.search).toBe('');
    expect(verificationLink).not.toContain('?token=');

    const rawToken = new URLSearchParams(parsedLink.hash.slice(1)).get('token');
    expect(rawToken).toBeTruthy();
    expect(rawToken).toHaveLength(43);

    const expectedHash = createHash('sha256').update(rawToken!, 'utf8').digest('hex');
    expect(saved[0].tokenHash).toBe(expectedHash);
    expect(saved[0].tokenHash).not.toBe(rawToken);
    expect(JSON.stringify(saved[0])).not.toContain(rawToken!);

    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: user.id,
        action: AuditAction.USER_EMAIL_VERIFICATION_REQUESTED,
        metadata: { result: 'sent', channel: 'email' },
      }),
    );
    expect(JSON.stringify(auditService.log.mock.calls)).not.toContain(rawToken!);
  });

  it('stores a keyed phone-code digest and never persists or audits the six-digit code', async () => {
    const user = {
      id: '11111111-1111-4111-8111-111111111111',
      phone: '+233244000000',
      phoneVerifiedAt: null,
      countryCode: 'GH',
      status: UserStatus.ACTIVE,
    } as User;
    const saved: Partial<AuthVerificationToken>[] = [];
    const userRepo = { findOne: jest.fn().mockResolvedValue(user) };
    const tokenRepo = {
      update: jest.fn().mockResolvedValue({ affected: 0 }),
      create: jest.fn((value: Partial<AuthVerificationToken>) => value),
      save: jest.fn(async (value: Partial<AuthVerificationToken>) => {
        saved.push(value);
        return value;
      }),
    };
    const emailDelivery = { isConfigured: jest.fn(), send: jest.fn() };
    const phoneDelivery = {
      isConfigured: jest.fn().mockReturnValue(true),
      sendVerificationCode: jest.fn().mockResolvedValue(true),
    };
    const configService = {
      get: jest.fn((key: string, fallback?: unknown) => {
        if (key === 'auth.verificationPepper') return verificationPepper;
        return fallback;
      }),
    } as unknown as ConfigService;
    const auditService = { log: jest.fn().mockResolvedValue(undefined) };

    const service = new VerificationService(
      userRepo as unknown as Repository<User>,
      tokenRepo as unknown as Repository<AuthVerificationToken>,
      emailDelivery as unknown as EmailVerificationDeliveryService,
      phoneDelivery as unknown as PhoneVerificationDeliveryService,
      configService,
      auditService as unknown as AuditService,
      createIssuanceDataSource(user, tokenRepo),
    );

    await service.requestPhoneVerification(user.id, {
      ipAddress: '127.0.0.1',
      userAgent: 'verification-test-agent',
    });

    const code = phoneDelivery.sendVerificationCode.mock.calls[0][1] as string;
    expect(phoneDelivery.isConfigured).toHaveBeenCalledWith('GH');
    expect(phoneDelivery.sendVerificationCode.mock.calls[0][2]).toBe('GH');
    expect(code).toMatch(/^\d{6}$/u);
    expect(saved).toHaveLength(1);

    const expectedHash = createHmac('sha256', verificationPepper)
      .update(`${user.id}:${user.phone}:${code}`, 'utf8')
      .digest('hex');
    expect(saved[0].tokenHash).toBe(expectedHash);
    expect(saved[0].tokenHash).not.toBe(code);
    expect(JSON.stringify(saved[0])).not.toContain(code);

    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: user.id,
        action: AuditAction.USER_PHONE_VERIFICATION_REQUESTED,
        metadata: { result: 'sent', channel: 'phone' },
      }),
    );
    const auditEvidence = JSON.stringify(auditService.log.mock.calls);
    expect(auditEvidence).not.toContain(code);
    expect(auditEvidence).not.toContain(user.phone!);
  });

  it('invalidates the generated challenge when the SMS provider does not accept delivery', async () => {
    const user = {
      id: '11111111-1111-4111-8111-111111111111',
      phone: '+233244000000',
      phoneVerifiedAt: null,
      status: UserStatus.ACTIVE,
    } as User;
    const userRepo = { findOne: jest.fn().mockResolvedValue(user) };
    const tokenRepo = {
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      create: jest.fn((value: Partial<AuthVerificationToken>) => value),
      save: jest.fn(async (value: Partial<AuthVerificationToken>) => value),
    };
    const phoneDelivery = {
      isConfigured: jest.fn().mockReturnValue(true),
      sendVerificationCode: jest.fn().mockResolvedValue(false),
    };
    const configService = {
      get: jest.fn((key: string, fallback?: unknown) =>
        key === 'auth.verificationPepper' ? verificationPepper : fallback,
      ),
    } as unknown as ConfigService;
    const auditService = { log: jest.fn().mockResolvedValue(undefined) };
    const service = new VerificationService(
      userRepo as unknown as Repository<User>,
      tokenRepo as unknown as Repository<AuthVerificationToken>,
      {} as EmailVerificationDeliveryService,
      phoneDelivery as unknown as PhoneVerificationDeliveryService,
      configService,
      auditService as unknown as AuditService,
      createIssuanceDataSource(user, tokenRepo),
    );

    await expect(service.requestPhoneVerification(user.id, {})).rejects.toThrow(
      'Phone verification is temporarily unavailable',
    );

    expect(tokenRepo.update).toHaveBeenCalledTimes(2);
    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.USER_PHONE_VERIFICATION_REQUESTED,
        metadata: { result: 'delivery_failed', channel: 'phone' },
      }),
    );
  });
});
