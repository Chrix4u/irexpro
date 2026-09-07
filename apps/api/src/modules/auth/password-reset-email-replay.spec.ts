import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { User } from '../users/entities/user.entity';
import { PasswordResetDeliveryService } from './password-reset-delivery.service';
import { PasswordResetToken, ResetChannel } from './entities/password-reset-token.entity';
import { PasswordResetService } from './password-reset.service';

describe('PasswordResetService email replay safety', () => {
  const resetTokenRepo = {
    findOne: jest.fn(),
    save: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  };
  const userRepo = { findOne: jest.fn() };
  const auditService = { log: jest.fn() };
  const deliveryService = { deliver: jest.fn() };
  const configService = {
    get: jest.fn((key: string, fallback?: unknown) => {
      if (key === 'auth.argon2MemoryCost') return 1024;
      if (key === 'auth.argon2TimeCost') return 2;
      if (key === 'auth.argon2Parallelism') return 1;
      return fallback;
    }),
  };
  const queryRunner = {
    connect: jest.fn(),
    startTransaction: jest.fn(),
    commitTransaction: jest.fn(),
    rollbackTransaction: jest.fn(),
    release: jest.fn(),
    manager: {
      update: jest.fn(),
    },
  };
  const dataSource = { createQueryRunner: jest.fn(() => queryRunner) };

  let module: TestingModule;
  let service: PasswordResetService;

  const activeEmailToken = {
    id: 'email-reset-token',
    userId: 'user-1',
    tokenHash: 'stored-email-token-hash',
    channel: ResetChannel.EMAIL,
    destinationHash: null,
    expiresAt: new Date(Date.now() + 60_000),
    usedAt: null,
    attemptCount: 0,
  } as PasswordResetToken;

  beforeEach(async () => {
    jest.clearAllMocks();
    queryRunner.manager.update.mockResolvedValue({ affected: 1 });

    module = await Test.createTestingModule({
      providers: [
        PasswordResetService,
        { provide: getRepositoryToken(PasswordResetToken), useValue: resetTokenRepo },
        { provide: getRepositoryToken(User), useValue: userRepo },
        { provide: AuditService, useValue: auditService },
        { provide: PasswordResetDeliveryService, useValue: deliveryService },
        { provide: ConfigService, useValue: configService },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();

    service = module.get(PasswordResetService);
  });

  afterEach(async () => {
    await module.close();
  });

  it('consumes the email token, retires only pending MFA, then revokes sessions', async () => {
    resetTokenRepo.findOne.mockResolvedValueOnce(activeEmailToken);

    await service.resetWithToken('valid-email-reset-token', 'NewStrongPassword123!');

    expect(queryRunner.manager.update).toHaveBeenNthCalledWith(
      1,
      PasswordResetToken,
      expect.objectContaining({ id: activeEmailToken.id, usedAt: expect.anything() }),
      { usedAt: expect.any(Date) },
    );
    expect(queryRunner.manager.update).toHaveBeenNthCalledWith(2, User, 'user-1', {
      passwordHash: expect.stringMatching(/^\$argon2/),
    });
    expect(queryRunner.manager.update).toHaveBeenNthCalledWith(
      3,
      User,
      { id: 'user-1', mfaEnabled: false },
      { mfaSecret: null, mfaSetupExpiresAt: null },
    );
    expect(queryRunner.manager.update).toHaveBeenNthCalledWith(4, User, 'user-1', {
      sessionVersion: expect.any(Function),
    });
    expect(queryRunner.commitTransaction).toHaveBeenCalledTimes(1);
  });

  it('preserves enabled MFA by never issuing an unconditional secret-clearing update', async () => {
    resetTokenRepo.findOne.mockResolvedValueOnce(activeEmailToken);

    await service.resetWithToken('valid-email-reset-token', 'NewStrongPassword123!');

    const mfaClears = queryRunner.manager.update.mock.calls.filter(
      ([entity, , patch]) =>
        entity === User && patch?.mfaSecret === null && patch?.mfaSetupExpiresAt === null,
    );
    expect(mfaClears).toHaveLength(1);
    expect(mfaClears[0][1]).toEqual({ id: 'user-1', mfaEnabled: false });
  });

  it('rejects a concurrent replay before any user mutation when token consumption loses the race', async () => {
    resetTokenRepo.findOne.mockResolvedValueOnce(activeEmailToken);
    queryRunner.manager.update.mockResolvedValueOnce({ affected: 0 });

    await expect(
      service.resetWithToken('valid-email-reset-token', 'NewStrongPassword123!'),
    ).rejects.toThrow(UnauthorizedException);

    expect(queryRunner.manager.update).toHaveBeenCalledTimes(1);
    expect(queryRunner.manager.update).not.toHaveBeenCalledWith(
      User,
      expect.anything(),
      expect.anything(),
    );
    expect(queryRunner.commitTransaction).not.toHaveBeenCalled();
    expect(queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
  });
});
