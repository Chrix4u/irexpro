import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { User, UserStatus } from '../users/entities/user.entity';
import { PasswordResetDeliveryService } from './password-reset-delivery.service';
import { PasswordResetToken, ResetChannel } from './entities/password-reset-token.entity';
import { PasswordResetService } from './password-reset.service';

const PEPPER = 'phone-reset-test-pepper-at-least-32-characters';

function buildConfig(pepper: string | undefined) {
  return {
    get: jest.fn((key: string, def?: unknown) => {
      if (key === 'auth.verificationPepper') return pepper;
      if (key === 'auth.argon2MemoryCost') return 1024;
      if (key === 'auth.argon2TimeCost') return 2;
      if (key === 'auth.argon2Parallelism') return 1;
      return def;
    }),
  };
}

describe('PasswordResetService phone-code hardening', () => {
  const resetTokenRepo = {
    findOne: jest.fn(),
    save: jest.fn(async (entity) => entity),
    create: jest.fn((data) => ({ ...data, id: 'reset-token-id', createdAt: new Date() })),
    update: jest.fn(),
  };
  const userRepo = { findOne: jest.fn() };
  const auditService = { log: jest.fn() };
  const deliveryService = { deliver: jest.fn().mockResolvedValue(true) };
  const queryRunner = {
    connect: jest.fn(),
    startTransaction: jest.fn(),
    commitTransaction: jest.fn(),
    rollbackTransaction: jest.fn(),
    release: jest.fn(),
    isTransactionActive: true,
    manager: {
      findOne: jest.fn(),
      getRepository: jest.fn(),
      update: jest.fn(),
      save: jest.fn(async (entity) => entity),
    },
  };
  const dataSource = { createQueryRunner: jest.fn(() => queryRunner) };

  async function createService(pepper: string | undefined) {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PasswordResetService,
        { provide: getRepositoryToken(PasswordResetToken), useValue: resetTokenRepo },
        { provide: getRepositoryToken(User), useValue: userRepo },
        { provide: AuditService, useValue: auditService },
        { provide: PasswordResetDeliveryService, useValue: deliveryService },
        { provide: ConfigService, useValue: buildConfig(pepper) },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();
    return { module, service: module.get(PasswordResetService) };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    deliveryService.deliver.mockResolvedValue(true);
    resetTokenRepo.update.mockResolvedValue({ affected: 1 });
    queryRunner.manager.findOne.mockResolvedValue({ id: 'locked-user' });
    queryRunner.manager.getRepository.mockReturnValue(resetTokenRepo);
    queryRunner.manager.update.mockResolvedValue({ affected: 1 });
    queryRunner.isTransactionActive = true;
  });

  async function issuePhoneReset(service: PasswordResetService) {
    userRepo.findOne.mockResolvedValueOnce({
      id: 'phone-user',
      email: null,
      phone: '+233241234567',
      status: UserStatus.ACTIVE,
    });
    await service.requestReset('+233241234567');

    const result = {
      rawCode: deliveryService.deliver.mock.calls[0][0].rawToken as string,
      token: resetTokenRepo.create.mock.results[0].value as PasswordResetToken,
    };

    // Isolate subsequent verification-transaction assertions from the issuance
    // transaction that now serializes reset-token creation.
    queryRunner.connect.mockClear();
    queryRunner.startTransaction.mockClear();
    queryRunner.commitTransaction.mockClear();
    queryRunner.rollbackTransaction.mockClear();
    queryRunner.release.mockClear();
    queryRunner.manager.findOne.mockClear();
    queryRunner.manager.getRepository.mockClear();
    queryRunner.manager.update.mockClear();

    return result;
  }

  it('fails closed before invalidating an active token when phone reset pepper is unavailable', async () => {
    const { module, service } = await createService(undefined);
    userRepo.findOne.mockResolvedValueOnce({
      id: 'phone-user',
      email: null,
      phone: '+233241234567',
      status: UserStatus.ACTIVE,
    });

    await expect(service.requestReset('+233241234567')).rejects.toThrow(
      ServiceUnavailableException,
    );
    expect(dataSource.createQueryRunner).not.toHaveBeenCalled();
    expect(resetTokenRepo.update).not.toHaveBeenCalled();
    expect(resetTokenRepo.save).not.toHaveBeenCalled();
    expect(deliveryService.deliver).not.toHaveBeenCalled();
    await module.close();
  });

  it('increments the active token attempt count for an incorrect code', async () => {
    const { module, service } = await createService(PEPPER);
    const { token } = await issuePhoneReset(service);
    userRepo.findOne.mockResolvedValueOnce({
      id: 'phone-user',
      email: null,
      phone: '+233241234567',
      status: UserStatus.ACTIVE,
    });
    resetTokenRepo.findOne.mockResolvedValueOnce({ ...token, attemptCount: 0, usedAt: null });

    await expect(
      service.resetWithCode('+233241234567', '000000', 'NewStrongPassword123!'),
    ).rejects.toThrow(UnauthorizedException);

    expect(resetTokenRepo.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: 'phone-user',
          channel: ResetChannel.PHONE,
        }),
      }),
    );
    expect(resetTokenRepo.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: token.id, attemptCount: 0 }),
      { attemptCount: 1 },
    );
    await module.close();
  });

  it('invalidates the active token on the fifth incorrect code', async () => {
    const { module, service } = await createService(PEPPER);
    const { token } = await issuePhoneReset(service);
    userRepo.findOne.mockResolvedValueOnce({
      id: 'phone-user',
      email: null,
      phone: '+233241234567',
      status: UserStatus.ACTIVE,
    });
    resetTokenRepo.findOne.mockResolvedValueOnce({ ...token, attemptCount: 4, usedAt: null });

    await expect(
      service.resetWithCode('+233241234567', '000000', 'NewStrongPassword123!'),
    ).rejects.toThrow(UnauthorizedException);

    expect(resetTokenRepo.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: token.id, attemptCount: 4 }),
      expect.objectContaining({ attemptCount: 5, usedAt: expect.any(Date) }),
    );
    await module.close();
  });

  it('atomically consumes a correct phone code, retires pending MFA, then revokes sessions', async () => {
    const { module, service } = await createService(PEPPER);
    const { rawCode, token } = await issuePhoneReset(service);
    userRepo.findOne.mockResolvedValueOnce({
      id: 'phone-user',
      email: null,
      phone: '+233241234567',
      status: UserStatus.ACTIVE,
    });
    resetTokenRepo.findOne.mockResolvedValueOnce({ ...token, attemptCount: 0, usedAt: null });

    await service.resetWithCode('+233241234567', rawCode, 'NewStrongPassword123!');

    expect(queryRunner.manager.update).toHaveBeenNthCalledWith(
      1,
      PasswordResetToken,
      expect.objectContaining({ id: token.id, attemptCount: 0 }),
      { usedAt: expect.any(Date) },
    );
    expect(queryRunner.manager.update).toHaveBeenNthCalledWith(2, User, 'phone-user', {
      passwordHash: expect.stringMatching(/^\$argon2/),
    });
    expect(queryRunner.manager.update).toHaveBeenNthCalledWith(
      3,
      User,
      { id: 'phone-user', mfaEnabled: false },
      { mfaSecret: null, mfaSetupExpiresAt: null },
    );
    expect(queryRunner.manager.update).toHaveBeenNthCalledWith(4, User, 'phone-user', {
      sessionVersion: expect.any(Function),
    });
    expect(queryRunner.commitTransaction).toHaveBeenCalledTimes(1);
    await module.close();
  });

  it('preserves enabled MFA by scoping phone-reset secret cleanup to pending enrollment only', async () => {
    const { module, service } = await createService(PEPPER);
    const { rawCode, token } = await issuePhoneReset(service);
    userRepo.findOne.mockResolvedValueOnce({
      id: 'phone-user',
      email: null,
      phone: '+233241234567',
      status: UserStatus.ACTIVE,
    });
    resetTokenRepo.findOne.mockResolvedValueOnce({ ...token, attemptCount: 0, usedAt: null });

    await service.resetWithCode('+233241234567', rawCode, 'NewStrongPassword123!');

    const mfaClears = queryRunner.manager.update.mock.calls.filter(
      ([entity, , patch]) =>
        entity === User && patch?.mfaSecret === null && patch?.mfaSetupExpiresAt === null,
    );
    expect(mfaClears).toHaveLength(1);
    expect(mfaClears[0][1]).toEqual({ id: 'phone-user', mfaEnabled: false });
    await module.close();
  });

  it('rejects a replay when atomic consumption loses the race', async () => {
    const { module, service } = await createService(PEPPER);
    const { rawCode, token } = await issuePhoneReset(service);
    userRepo.findOne.mockResolvedValueOnce({
      id: 'phone-user',
      email: null,
      phone: '+233241234567',
      status: UserStatus.ACTIVE,
    });
    resetTokenRepo.findOne.mockResolvedValueOnce({ ...token, attemptCount: 0, usedAt: null });
    queryRunner.manager.update.mockResolvedValueOnce({ affected: 0 });

    await expect(
      service.resetWithCode('+233241234567', rawCode, 'NewStrongPassword123!'),
    ).rejects.toThrow(UnauthorizedException);
    expect(queryRunner.commitTransaction).not.toHaveBeenCalled();
    expect(queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
    await module.close();
  });
});
