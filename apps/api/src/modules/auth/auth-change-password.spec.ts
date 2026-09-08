import { UnauthorizedException } from '@nestjs/common';
import { validate } from 'class-validator';
import * as argon2 from 'argon2';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { ChangePasswordDto } from './dto/change-password.dto';
import { RoleName } from '../users/entities/role.entity';
import { User, UserStatus } from '../users/entities/user.entity';
import { AuditAction } from '../../common/enums/audit-action.enum';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';

/**
 * Sprint 55 — POST /auth/change-password (service + controller + DTO).
 *
 * Mirrors reset-password's hardened transactional semantics:
 *   - current-password re-authentication happens BEFORE any mutation;
 *   - wrong current password → 401 + USER_PASSWORD_CHANGE_FAILED audit and
 *     NO hash/version/MFA state changes;
 *   - success writes the new argon2 hash, retires pending (mfaEnabled=false)
 *     enrollment, and CAS-bumps session_version in ONE transaction;
 *   - audit metadata NEVER contains password material.
 */

const CURRENT_PASSWORD = 'CurrentPassword123';
const NEW_PASSWORD = 'NewStrongPassword123!';
const USER_ID = '11111111-1111-4111-8111-111111111111';

describe('Sprint 55 — POST /auth/change-password', () => {
  function buildService() {
    const userRepo = {
      findOne: jest.fn(),
      update: jest.fn(),
    };
    const jwtService = {
      verify: jest.fn(),
      sign: jest.fn(
        (payload: { tokenType?: string }) => `${String(payload.tokenType)}:refresh-token-material`,
      ),
    };
    const configService = {
      get: jest.fn((key: string, def?: unknown) => {
        // Low-cost argon2 params keep the real hash path fast in unit tests.
        if (key === 'auth.argon2MemoryCost') return 1024;
        if (key === 'auth.argon2TimeCost') return 2;
        if (key === 'auth.argon2Parallelism') return 1;
        return def;
      }),
    };
    const auditService = { log: jest.fn().mockResolvedValue(undefined) };
    const queryRunner = {
      connect: jest.fn(),
      startTransaction: jest.fn(),
      commitTransaction: jest.fn(),
      rollbackTransaction: jest.fn(),
      release: jest.fn(),
      isTransactionActive: true,
      manager: {
        update: jest.fn().mockResolvedValue({ affected: 1 }),
      },
    };
    const dataSource = { createQueryRunner: jest.fn(() => queryRunner) };

    const service = new AuthService(
      userRepo as never,
      {} as never,
      {} as never,
      {} as never,
      jwtService as never,
      configService as never,
      auditService as never,
      dataSource as never,
    );

    const user = {
      id: USER_ID,
      email: 'user@example.com',
      status: UserStatus.ACTIVE,
      passwordHash: 'stored-password-hash',
      mfaEnabled: false,
      mfaSecret: 'pending-enrollment-secret',
      mfaSetupExpiresAt: new Date(Date.now() + 60_000),
      sessionVersion: 7,
      userRoles: [],
    } as unknown as User;

    userRepo.findOne.mockResolvedValue(user);

    return { service, userRepo, auditService, queryRunner, dataSource, user };
  }

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('AuthService.changePassword', () => {
    let passwordVerifySpy: jest.SpiedFunction<typeof argon2.verify>;

    beforeEach(() => {
      passwordVerifySpy = jest.spyOn(argon2, 'verify').mockResolvedValue(true);
    });

    it('re-authenticates with the current password before any mutation', async () => {
      const { service, queryRunner, user } = buildService();

      await service.changePassword(user.id, CURRENT_PASSWORD, NEW_PASSWORD);

      expect(passwordVerifySpy).toHaveBeenCalledWith('stored-password-hash', CURRENT_PASSWORD);
      expect(passwordVerifySpy.mock.invocationCallOrder[0]).toBeLessThan(
        queryRunner.manager.update.mock.invocationCallOrder[0],
      );
    });

    it('stores only a one-way argon2 hash for the new password', async () => {
      const { service, queryRunner, user } = buildService();

      await service.changePassword(user.id, CURRENT_PASSWORD, NEW_PASSWORD);

      expect(queryRunner.manager.update).toHaveBeenNthCalledWith(1, User, user.id, {
        passwordHash: expect.any(String),
      });
      const writtenHash = queryRunner.manager.update.mock.calls[0][2].passwordHash;
      expect(writtenHash).toMatch(/^\$argon2/);
      expect(writtenHash).not.toBe(NEW_PASSWORD);
      expect(writtenHash).not.toBe(CURRENT_PASSWORD);
    });

    it('retires a pending MFA enrollment scoped to mfaEnabled=false', async () => {
      const { service, queryRunner, user } = buildService();

      await service.changePassword(user.id, CURRENT_PASSWORD, NEW_PASSWORD);

      expect(queryRunner.manager.update).toHaveBeenNthCalledWith(
        2,
        User,
        { id: user.id, mfaEnabled: false },
        { mfaSecret: null, mfaSetupExpiresAt: null },
      );
    });

    it('keeps the MFA retirement predicate intact when MFA is already enabled (active secrets out of scope)', async () => {
      const { service, queryRunner, user } = buildService();
      (user as { mfaEnabled: boolean }).mfaEnabled = true;

      await service.changePassword(user.id, CURRENT_PASSWORD, NEW_PASSWORD);

      // The SQL predicate itself is the guarantee: the update can only match
      // rows where mfa_enabled=false, so an active MFA secret is never cleared.
      expect(queryRunner.manager.update).toHaveBeenCalledWith(
        User,
        { id: user.id, mfaEnabled: false },
        { mfaSecret: null, mfaSetupExpiresAt: null },
      );
    });

    it('CAS-bumps session_version (revoking every session) in the same transaction', async () => {
      const { service, queryRunner, user } = buildService();

      await service.changePassword(user.id, CURRENT_PASSWORD, NEW_PASSWORD);

      expect(queryRunner.manager.update).toHaveBeenNthCalledWith(
        3,
        User,
        { id: user.id, sessionVersion: 7 },
        { sessionVersion: 8 },
      );
      expect(queryRunner.commitTransaction).toHaveBeenCalledTimes(1);
      expect(queryRunner.rollbackTransaction).not.toHaveBeenCalled();
    });

    it('audits USER_PASSWORD_CHANGED with sessionsRevoked metadata only', async () => {
      const { service, auditService, user } = buildService();

      await service.changePassword(user.id, CURRENT_PASSWORD, NEW_PASSWORD);

      expect(auditService.log).toHaveBeenCalledTimes(1);
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          actorUserId: user.id,
          action: AuditAction.USER_PASSWORD_CHANGED,
          resourceType: 'User',
          resourceId: user.id,
          metadata: { sessionsRevoked: true },
        }),
      );
    });

    it('never places password material in the audit trail on success', async () => {
      const { service, auditService, user } = buildService();

      await service.changePassword(user.id, CURRENT_PASSWORD, NEW_PASSWORD);

      const auditJson = JSON.stringify(auditService.log.mock.calls);
      expect(auditJson).not.toContain(CURRENT_PASSWORD);
      expect(auditJson).not.toContain(NEW_PASSWORD);
      expect(auditJson).not.toContain('passwordHash');
    });

    it('rejects a wrong current password with 401, audits the failure reason, and changes nothing', async () => {
      const { service, userRepo, auditService, queryRunner, dataSource, user } = buildService();
      passwordVerifySpy.mockResolvedValueOnce(false);

      await expect(
        service.changePassword(user.id, 'WrongCurrentPassword1', NEW_PASSWORD),
      ).rejects.toThrow(new UnauthorizedException('Current password verification failed'));

      expect(auditService.log).toHaveBeenCalledTimes(1);
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          actorUserId: user.id,
          action: AuditAction.USER_PASSWORD_CHANGE_FAILED,
          metadata: { result: 'failed', reason: 'invalid_current_password' },
        }),
      );

      // Fail-closed: no transaction, no hash/version/MFA mutation at all.
      expect(dataSource.createQueryRunner).not.toHaveBeenCalled();
      expect(queryRunner.manager.update).not.toHaveBeenCalled();
      expect(userRepo.update).not.toHaveBeenCalled();

      const auditJson = JSON.stringify(auditService.log.mock.calls);
      expect(auditJson).not.toContain('WrongCurrentPassword1');
      expect(auditJson).not.toContain(NEW_PASSWORD);
    });

    it('fails closed with 401 when the authenticated user no longer exists', async () => {
      const { service, userRepo, auditService } = buildService();
      userRepo.findOne.mockResolvedValueOnce(null);

      await expect(service.changePassword(USER_ID, CURRENT_PASSWORD, NEW_PASSWORD)).rejects.toThrow(
        UnauthorizedException,
      );
      expect(passwordVerifySpy).not.toHaveBeenCalled();
      expect(auditService.log).not.toHaveBeenCalled();
    });

    it('rolls the whole transaction back (no partial state) when the CAS bump loses a race', async () => {
      const { service, queryRunner, auditService, user } = buildService();
      // Password + MFA-retirement statements succeed; only the CAS bump loses.
      queryRunner.manager.update.mockImplementation(async (_target: unknown, criteria: unknown) =>
        typeof criteria === 'object' && criteria !== null && 'sessionVersion' in criteria
          ? { affected: 0 }
          : { affected: 1 },
      );

      await expect(service.changePassword(user.id, CURRENT_PASSWORD, NEW_PASSWORD)).rejects.toThrow(
        new UnauthorizedException('Session state changed concurrently; please retry'),
      );

      expect(queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
      expect(queryRunner.commitTransaction).not.toHaveBeenCalled();
      expect(auditService.log).not.toHaveBeenCalled();
    });
  });

  describe('ChangePasswordDto (reset-password policy)', () => {
    it('accepts a strong password pair', async () => {
      const dto = new ChangePasswordDto();
      dto.currentPassword = CURRENT_PASSWORD;
      dto.newPassword = NEW_PASSWORD;

      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    });

    it('rejects a newPassword shorter than 12 characters', async () => {
      const dto = new ChangePasswordDto();
      dto.currentPassword = CURRENT_PASSWORD;
      dto.newPassword = 'Short1';

      expect(await validate(dto)).not.toHaveLength(0);
    });

    it('rejects a newPassword longer than 128 characters', async () => {
      const dto = new ChangePasswordDto();
      dto.currentPassword = CURRENT_PASSWORD;
      dto.newPassword = `A1${'a'.repeat(127)}`;

      expect(await validate(dto)).not.toHaveLength(0);
    });

    it('rejects a newPassword without a letter', async () => {
      const dto = new ChangePasswordDto();
      dto.currentPassword = CURRENT_PASSWORD;
      dto.newPassword = '123456789012';

      const errors = await validate(dto);
      expect(errors.map((e) => e.constraints)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            matches: expect.stringContaining('newPassword must contain at least one letter'),
          }),
        ]),
      );
    });

    it('rejects a newPassword without a number', async () => {
      const dto = new ChangePasswordDto();
      dto.currentPassword = CURRENT_PASSWORD;
      dto.newPassword = 'OnlyLettersHere';

      const errors = await validate(dto);
      expect(errors.map((e) => e.constraints)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            matches: expect.stringContaining('newPassword must contain at least one number'),
          }),
        ]),
      );
    });

    it('rejects a missing currentPassword', async () => {
      const dto = { newPassword: NEW_PASSWORD } as unknown as ChangePasswordDto;

      expect(await validate(dto)).not.toHaveLength(0);
    });
  });

  describe('AuthController.changePassword', () => {
    const principal = {
      userId: USER_ID,
      email: 'user@example.com',
      phone: null,
      roles: [RoleName.USER],
      status: UserStatus.ACTIVE,
    } as never;

    function buildController() {
      const authService = {
        changePassword: jest.fn().mockResolvedValue(undefined),
      };
      const controller = new AuthController(authService as never, {} as never, {} as never);
      return { controller, authService };
    }

    it('returns the pinned all-sessions-revoked response message', async () => {
      const { controller, authService } = buildController();

      const result = await controller.changePassword(
        principal,
        { currentPassword: CURRENT_PASSWORD, newPassword: NEW_PASSWORD } as ChangePasswordDto,
        '203.0.113.10',
      );

      expect(result).toEqual({
        message:
          'Password has been changed. All sessions have been revoked — please sign in again.',
      });
      expect(authService.changePassword).toHaveBeenCalledWith(
        USER_ID,
        CURRENT_PASSWORD,
        NEW_PASSWORD,
        '203.0.113.10',
      );
    });

    it('propagates the 401 re-authentication failure to the HTTP layer', async () => {
      const { controller, authService } = buildController();
      authService.changePassword.mockRejectedValue(
        new UnauthorizedException('Current password verification failed'),
      );

      await expect(
        controller.changePassword(
          principal,
          {
            currentPassword: 'WrongCurrentPassword1',
            newPassword: NEW_PASSWORD,
          } as ChangePasswordDto,
          '203.0.113.10',
        ),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('is JWT-guarded and not public (unauthenticated requests are rejected by JwtAuthGuard)', () => {
      const guards = Reflect.getMetadata(
        '__guards__',
        AuthController.prototype.changePassword,
      ) as unknown[];
      expect(guards).toContain(JwtAuthGuard);
      expect(
        Reflect.getMetadata('isPublic', AuthController.prototype.changePassword),
      ).toBeUndefined();
    });
  });
});
