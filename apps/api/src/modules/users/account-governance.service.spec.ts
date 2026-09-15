import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { AuditAction } from '../../common/enums/audit-action.enum';
import { AuditService } from '../audit/audit.service';
import {
  AccountAppeal,
  AccountAppealDecision,
  AccountAppealStatus,
} from './entities/account-appeal.entity';
import { User, UserStatus } from './entities/user.entity';
import { AccountStatusAction } from './dto/update-account-status.dto';
import { AccountGovernanceService } from './account-governance.service';

const PUBLIC_MESSAGE = 'If an eligible account exists, the request has been received for review.';

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    email: 'locked@example.com',
    phone: '+233241234567',
    status: UserStatus.SUSPENDED,
    sessionVersion: 3,
    deletedAt: null,
    profile: {
      firstName: 'Amina',
      lastName: 'Kofi',
    },
    ...overrides,
  } as User;
}

function makeAppeal(overrides: Partial<AccountAppeal> = {}): AccountAppeal {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    userId: '11111111-1111-4111-8111-111111111111',
    reason: 'Please review my account access because I believe it was disabled in error.',
    status: AccountAppealStatus.PENDING,
    decision: null,
    reviewerUserId: null,
    reviewerNote: null,
    resolvedAt: null,
    createdAt: new Date('2026-08-01T12:00:00.000Z'),
    updatedAt: new Date('2026-08-01T12:00:00.000Z'),
    user: makeUser(),
    ...overrides,
  } as AccountAppeal;
}

describe('AccountGovernanceService', () => {
  const userRepo = { findOne: jest.fn() };
  const appealRepo = {
    create: jest.fn(),
    findAndCount: jest.fn(),
    findOne: jest.fn(),
    save: jest.fn(),
  };
  const auditService = { log: jest.fn() };
  const manager = {
    findOne: jest.fn(),
    save: jest.fn(),
  };
  const queryRunner = {
    connect: jest.fn(),
    startTransaction: jest.fn(),
    commitTransaction: jest.fn(),
    rollbackTransaction: jest.fn(),
    release: jest.fn(),
    manager,
  };
  const dataSource = { createQueryRunner: jest.fn(() => queryRunner) };

  let service: AccountGovernanceService;

  beforeEach(() => {
    jest.clearAllMocks();
    appealRepo.create.mockImplementation((value) => value);
    appealRepo.save.mockImplementation(async (value) => ({
      ...value,
      id: '22222222-2222-4222-8222-222222222222',
      createdAt: new Date('2026-08-01T12:00:00.000Z'),
      updatedAt: new Date('2026-08-01T12:00:00.000Z'),
    }));
    manager.save.mockImplementation(async (_entity, value) => value);
    auditService.log.mockResolvedValue(undefined);

    service = new AccountGovernanceService(
      userRepo as unknown as Repository<User>,
      appealRepo as unknown as Repository<AccountAppeal>,
      auditService as unknown as AuditService,
      dataSource as unknown as DataSource,
      // Round 6 (#300): the unified authority seams (mocked — the bump
      // matrices live in the execution-authority suites).
      { bumpGeneration: jest.fn().mockResolvedValue(2) } as never,
      { invalidateUserNewExposureAuthority: jest.fn().mockResolvedValue({}) } as never,
    );
  });

  describe('submitAppeal', () => {
    it('returns the exact generic response for an unknown identifier', async () => {
      userRepo.findOne.mockResolvedValue(null);

      await expect(
        service.submitAppeal({
          identifier: 'unknown@example.com',
          reason: 'Please review this account because I cannot access it at the moment.',
        }),
      ).resolves.toEqual({ message: PUBLIC_MESSAGE });

      expect(appealRepo.save).not.toHaveBeenCalled();
      expect(auditService.log).not.toHaveBeenCalled();
    });

    it('does not create an appeal for an active account, while keeping the same response', async () => {
      userRepo.findOne.mockResolvedValue(makeUser({ status: UserStatus.ACTIVE }));

      const result = await service.submitAppeal({
        identifier: 'locked@example.com',
        reason: 'Please review this account because I cannot access it at the moment.',
      });

      expect(result).toEqual({ message: PUBLIC_MESSAGE });
      expect(appealRepo.save).not.toHaveBeenCalled();
    });

    it('creates one eligible request without auditing the supplied identifier or appeal text', async () => {
      const user = makeUser({ status: UserStatus.PERMANENTLY_LOCKED });
      userRepo.findOne.mockResolvedValue(user);
      appealRepo.findOne.mockResolvedValue(null);

      const reason = 'Please review this account because I cannot access it at the moment.';
      const result = await service.submitAppeal(
        { identifier: 'LOCKED@example.com', reason },
        { ipAddress: '198.51.100.10', userAgent: 'test-agent' },
      );

      expect(result).toEqual({ message: PUBLIC_MESSAGE });
      expect(userRepo.findOne).toHaveBeenCalledWith({
        where: { email: 'locked@example.com' },
        withDeleted: true,
      });
      expect(appealRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ userId: user.id, reason, status: AccountAppealStatus.PENDING }),
      );

      const auditRecord = auditService.log.mock.calls[0][0] as { metadata: unknown };
      const serializedAudit = JSON.stringify(auditRecord.metadata);
      expect(serializedAudit).not.toContain(reason);
      expect(serializedAudit).not.toContain('LOCKED@example.com');
      expect(auditRecord).toEqual(
        expect.objectContaining({ action: AuditAction.ACCOUNT_APPEAL_SUBMITTED }),
      );
    });

    it('treats an existing pending request as generic and does not write a duplicate', async () => {
      userRepo.findOne.mockResolvedValue(makeUser());
      appealRepo.findOne.mockResolvedValue(makeAppeal());

      await expect(
        service.submitAppeal({
          identifier: 'locked@example.com',
          reason: 'Please review this account because I cannot access it at the moment.',
        }),
      ).resolves.toEqual({ message: PUBLIC_MESSAGE });

      expect(appealRepo.save).not.toHaveBeenCalled();
    });

    it('returns generic response for a database duplicate race', async () => {
      userRepo.findOne.mockResolvedValue(makeUser());
      appealRepo.findOne.mockResolvedValue(null);
      appealRepo.save.mockRejectedValue({ code: '23505' });

      await expect(
        service.submitAppeal({
          identifier: 'locked@example.com',
          reason: 'Please review this account because I cannot access it at the moment.',
        }),
      ).resolves.toEqual({ message: PUBLIC_MESSAGE });

      expect(auditService.log).not.toHaveBeenCalled();
    });

    it('returns generic response instead of persisting a whitespace-only appeal reason', async () => {
      await expect(
        service.submitAppeal({
          identifier: 'locked@example.com',
          reason: '                    ',
        }),
      ).resolves.toEqual({ message: PUBLIC_MESSAGE });

      expect(userRepo.findOne).not.toHaveBeenCalled();
      expect(appealRepo.save).not.toHaveBeenCalled();
    });
  });

  describe('listAppeals', () => {
    it('returns a bounded oldest-first page with total metadata and a frontend-safe projection', async () => {
      const user = makeUser({
        passwordHash: 'never-expose-password-hash',
      } as Partial<User>);
      appealRepo.findAndCount.mockResolvedValue([[makeAppeal({ user })], 41]);

      const result = await service.listAppeals(AccountAppealStatus.PENDING, 2, 20);

      expect(result).toEqual({
        items: [
          expect.objectContaining({
            id: '22222222-2222-4222-8222-222222222222',
            user: expect.objectContaining({ id: user.id, email: user.email, status: user.status }),
          }),
        ],
        page: 2,
        limit: 20,
        total: 41,
        totalPages: 3,
      });
      expect(JSON.stringify(result)).not.toContain('never-expose-password-hash');
      expect(appealRepo.findAndCount).toHaveBeenCalledWith({
        where: { status: AccountAppealStatus.PENDING },
        relations: ['user', 'user.profile'],
        withDeleted: true,
        order: { createdAt: 'ASC', id: 'ASC' },
        skip: 20,
        take: 20,
      });
    });

    it('normalizes hostile direct-call pagination before constructing TypeORM offsets', async () => {
      appealRepo.findAndCount.mockResolvedValue([[], 0]);

      const invalidResult = await service.listAppeals(
        undefined,
        Number.POSITIVE_INFINITY,
        Number.NaN,
      );
      expect(invalidResult).toEqual({
        items: [],
        page: 1,
        limit: 20,
        total: 0,
        totalPages: 0,
      });
      expect(appealRepo.findAndCount).toHaveBeenLastCalledWith(
        expect.objectContaining({ skip: 0, take: 20 }),
      );

      await service.listAppeals(undefined, Number.MAX_VALUE, 500.75);
      const options = appealRepo.findAndCount.mock.calls.at(-1)?.[0] as {
        skip: number;
        take: number;
      };
      expect(options.take).toBe(100);
      expect(Number.isSafeInteger(options.skip)).toBe(true);
      expect(options.skip).toBeGreaterThanOrEqual(0);
      expect(options.skip).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
    });
  });

  describe('resolveAppeal', () => {
    it('reactivates a soft-deleted account without restoring its pre-restriction session generation', async () => {
      const targetUser = makeUser({
        status: UserStatus.CLOSED,
        sessionVersion: 8,
        deletedAt: new Date('2026-07-01T00:00:00.000Z'),
      });
      const pendingAppeal = makeAppeal({ userId: targetUser.id, user: targetUser });
      manager.findOne.mockResolvedValueOnce(pendingAppeal).mockResolvedValueOnce(targetUser);
      appealRepo.findOne.mockResolvedValue(
        makeAppeal({
          userId: targetUser.id,
          user: targetUser,
          status: AccountAppealStatus.RESOLVED,
          decision: AccountAppealDecision.REACTIVATE,
          reviewerUserId: '33333333-3333-4333-8333-333333333333',
          reviewerNote: 'Evidence verified.',
          resolvedAt: new Date('2026-08-02T12:00:00.000Z'),
        }),
      );

      const result = await service.resolveAppeal(
        pendingAppeal.id,
        '33333333-3333-4333-8333-333333333333',
        { decision: AccountAppealDecision.REACTIVATE, reviewerNote: 'Evidence verified.' },
      );

      expect(targetUser.status).toBe(UserStatus.ACTIVE);
      expect(targetUser.deletedAt).toBeNull();
      expect(targetUser.sessionVersion).toBe(8);
      expect(queryRunner.commitTransaction).toHaveBeenCalledTimes(1);
      expect(queryRunner.release).toHaveBeenCalledTimes(1);
      expect(result).toEqual(
        expect.objectContaining({
          status: AccountAppealStatus.RESOLVED,
          decision: AccountAppealDecision.REACTIVATE,
        }),
      );

      const auditActions = auditService.log.mock.calls.map(
        (call) => (call[0] as { action: AuditAction }).action,
      );
      expect(auditActions).toEqual([
        AuditAction.ACCOUNT_APPEAL_RESOLVED,
        AuditAction.USER_REACTIVATED,
      ]);
    });

    it('advances the session generation when an appeal resolves to a restrictive state', async () => {
      const targetUser = makeUser({ status: UserStatus.SUSPENDED, sessionVersion: 5 });
      const pendingAppeal = makeAppeal({ userId: targetUser.id, user: targetUser });
      manager.findOne.mockResolvedValueOnce(pendingAppeal).mockResolvedValueOnce(targetUser);
      appealRepo.findOne.mockResolvedValue(
        makeAppeal({
          userId: targetUser.id,
          user: targetUser,
          status: AccountAppealStatus.RESOLVED,
          decision: AccountAppealDecision.PERMANENTLY_LOCK,
          reviewerUserId: '33333333-3333-4333-8333-333333333333',
          resolvedAt: new Date('2026-08-02T12:00:00.000Z'),
        }),
      );

      await service.resolveAppeal(pendingAppeal.id, '33333333-3333-4333-8333-333333333333', {
        decision: AccountAppealDecision.PERMANENTLY_LOCK,
      });

      expect(targetUser.status).toBe(UserStatus.PERMANENTLY_LOCKED);
      expect(targetUser.sessionVersion).toBe(6);
      expect(manager.save).toHaveBeenCalledWith(User, targetUser);
      expect(queryRunner.commitTransaction).toHaveBeenCalledTimes(1);
    });

    it('rejects a previously resolved appeal without changing the account', async () => {
      const resolvedAppeal = makeAppeal({ status: AccountAppealStatus.RESOLVED });
      manager.findOne.mockResolvedValue(resolvedAppeal);

      await expect(
        service.resolveAppeal(resolvedAppeal.id, '33333333-3333-4333-8333-333333333333', {
          decision: AccountAppealDecision.PERMANENTLY_LOCK,
        }),
      ).rejects.toThrow(ConflictException);

      expect(manager.save).not.toHaveBeenCalled();
      expect(queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
    });
  });

  describe('applyAdminAction', () => {
    it('rejects self-directed administrative actions before creating a transaction', async () => {
      await expect(
        service.applyAdminAction(
          '33333333-3333-4333-8333-333333333333',
          '33333333-3333-4333-8333-333333333333',
          { action: AccountStatusAction.DEACTIVATE, reason: 'Policy review' },
        ),
      ).rejects.toThrow(ForbiddenException);

      expect(dataSource.createQueryRunner).not.toHaveBeenCalled();
    });

    it('requires a meaningful trimmed administrative reason', async () => {
      await expect(
        service.applyAdminAction(
          '11111111-1111-4111-8111-111111111111',
          '33333333-3333-4333-8333-333333333333',
          { action: AccountStatusAction.DEACTIVATE, reason: '     ' },
        ),
      ).rejects.toThrow(BadRequestException);

      expect(dataSource.createQueryRunner).not.toHaveBeenCalled();
    });

    it('deactivates an eligible account, advances session generation, and keeps the reason out of audit metadata', async () => {
      const targetUser = makeUser({ status: UserStatus.ACTIVE, sessionVersion: 7 });
      manager.findOne.mockResolvedValue(targetUser);
      const reason = 'Repeated account-access policy breach';

      const result = await service.applyAdminAction(
        targetUser.id,
        '33333333-3333-4333-8333-333333333333',
        { action: AccountStatusAction.DEACTIVATE, reason },
      );

      expect(result).toEqual({ id: targetUser.id, status: UserStatus.SUSPENDED, deletedAt: null });
      expect(targetUser.status).toBe(UserStatus.SUSPENDED);
      expect(targetUser.sessionVersion).toBe(8);
      expect(manager.save).toHaveBeenCalledWith(User, targetUser);
      const auditRecord = auditService.log.mock.calls[0][0] as { metadata: unknown };
      expect(JSON.stringify(auditRecord.metadata)).not.toContain(reason);
      expect(auditRecord).toEqual(expect.objectContaining({ action: AuditAction.USER_SUSPENDED }));
    });

    it('advances the session generation again when a suspended account is closed', async () => {
      const targetUser = makeUser({ status: UserStatus.SUSPENDED, sessionVersion: 4 });
      manager.findOne.mockResolvedValue(targetUser);

      const result = await service.applyAdminAction(
        targetUser.id,
        '33333333-3333-4333-8333-333333333333',
        { action: AccountStatusAction.DELETE, reason: 'Confirmed account closure' },
      );

      expect(targetUser.status).toBe(UserStatus.CLOSED);
      expect(targetUser.sessionVersion).toBe(5);
      expect(targetUser.deletedAt).toBeInstanceOf(Date);
      expect(result.status).toBe(UserStatus.CLOSED);
      expect(manager.save).toHaveBeenCalledWith(User, targetUser);
    });

    it('does not allow a direct action to weaken a permanently locked account', async () => {
      manager.findOne.mockResolvedValue(makeUser({ status: UserStatus.PERMANENTLY_LOCKED }));

      await expect(
        service.applyAdminAction(
          '11111111-1111-4111-8111-111111111111',
          '33333333-3333-4333-8333-333333333333',
          { action: AccountStatusAction.DEACTIVATE, reason: 'Policy review' },
        ),
      ).rejects.toThrow(ConflictException);

      expect(manager.save).not.toHaveBeenCalled();
      expect(auditService.log).not.toHaveBeenCalled();
    });

    it('does not allow a direct action on an already closed account', async () => {
      manager.findOne.mockResolvedValue(
        makeUser({ status: UserStatus.CLOSED, deletedAt: new Date() }),
      );

      await expect(
        service.applyAdminAction(
          '11111111-1111-4111-8111-111111111111',
          '33333333-3333-4333-8333-333333333333',
          { action: AccountStatusAction.PERMANENTLY_LOCK, reason: 'Policy review' },
        ),
      ).rejects.toThrow(ConflictException);

      expect(manager.save).not.toHaveBeenCalled();
    });
  });
});
