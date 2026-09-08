import { ServiceUnavailableException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AuthController } from './auth.controller';
import { AuditService, UserSecurityEvent } from '../audit/audit.service';
import { SecurityEventsQueryDto } from './dto/security-events-query.dto';
import { RoleName } from '../users/entities/role.entity';
import { UserStatus } from '../users/entities/user.entity';
import { AuditSeverity } from '../audit/entities/audit-log.entity';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';

/**
 * Sprint 55 — GET /auth/security-events (controller + query DTO).
 *
 * The controller stays a thin, fail-closed delegate: paging validation is the
 * global ValidationPipe's job (mirrors MarketIntelligenceQueryDto), ownership
 * and projection live inside AuditService.listUserSecurityEvents, and a
 * minimal module that omits the audit read provider fails closed with 503.
 */

const USER_ID = '11111111-1111-4111-8111-111111111111';

describe('Sprint 55 — GET /auth/security-events', () => {
  const principal = {
    userId: USER_ID,
    email: 'user@example.com',
    phone: null,
    roles: [RoleName.USER],
    status: UserStatus.ACTIVE,
  } as never;

  function buildAuditService() {
    return {
      listUserSecurityEvents: jest.fn().mockResolvedValue({
        events: [
          {
            id: 'event-1',
            action: 'USER_PASSWORD_CHANGED',
            createdAt: '2026-09-07T10:30:00.000Z',
            severity: AuditSeverity.INFO,
          },
          {
            id: 'event-2',
            action: 'USER_SESSIONS_REVOKED_OTHERS',
            createdAt: '2026-09-06T09:00:00.000Z',
            severity: AuditSeverity.INFO,
          },
        ] satisfies UserSecurityEvent[],
        hasMore: false,
      }),
    };
  }

  describe('AuthController.listSecurityEvents', () => {
    function buildController(withAuditService = true) {
      const authService = {};
      const auditService = buildAuditService();
      const controller = new AuthController(
        authService as never,
        {} as never,
        {} as never,
        undefined,
        undefined,
        withAuditService ? (auditService as unknown as AuditService) : undefined,
      );
      return { controller, auditService };
    }

    it("returns the caller's own paginated security events", async () => {
      const { controller, auditService } = buildController();
      const query = plainToInstance(SecurityEventsQueryDto, { limit: '50', offset: '10' });

      const result = await controller.listSecurityEvents(principal, query);

      expect(auditService.listUserSecurityEvents).toHaveBeenCalledWith(USER_ID, {
        limit: 50,
        offset: 10,
      });
      expect(result).toEqual({
        events: [
          {
            id: 'event-1',
            action: 'USER_PASSWORD_CHANGED',
            createdAt: '2026-09-07T10:30:00.000Z',
            severity: AuditSeverity.INFO,
          },
          {
            id: 'event-2',
            action: 'USER_SESSIONS_REVOKED_OTHERS',
            createdAt: '2026-09-06T09:00:00.000Z',
            severity: AuditSeverity.INFO,
          },
        ],
        hasMore: false,
      });
      expect(Object.keys(result).sort()).toEqual(['events', 'hasMore']);
    });

    it('defaults to limit 20 / offset 0 when the query string is empty', async () => {
      const { controller, auditService } = buildController();
      const query = plainToInstance(SecurityEventsQueryDto, {});

      await controller.listSecurityEvents(principal, query);

      expect(auditService.listUserSecurityEvents).toHaveBeenCalledWith(USER_ID, {
        limit: 20,
        offset: 0,
      });
    });

    it('propagates the audit read failure to the HTTP layer', async () => {
      const { controller, auditService } = buildController();
      auditService.listUserSecurityEvents.mockRejectedValue(new Error('audit read failed'));

      await expect(
        controller.listSecurityEvents(principal, new SecurityEventsQueryDto()),
      ).rejects.toThrow('audit read failed');
    });

    it('fails closed with 503 when the audit read provider is unavailable', async () => {
      const { controller } = buildController(false);

      await expect(
        controller.listSecurityEvents(principal, new SecurityEventsQueryDto()),
      ).rejects.toThrow(ServiceUnavailableException);
    });

    it('is JWT-guarded and not public (unauthenticated requests are rejected by JwtAuthGuard)', () => {
      const guards = Reflect.getMetadata(
        '__guards__',
        AuthController.prototype.listSecurityEvents,
      ) as unknown[];
      expect(guards).toContain(JwtAuthGuard);
      expect(
        Reflect.getMetadata('isPublic', AuthController.prototype.listSecurityEvents),
      ).toBeUndefined();
    });
  });

  describe('SecurityEventsQueryDto (global ValidationPipe → 400)', () => {
    it('coerces numeric query strings and applies the defaults', async () => {
      const dto = plainToInstance(SecurityEventsQueryDto, { limit: '50', offset: '10' });

      expect(await validate(dto)).toHaveLength(0);
      expect(dto.limit).toBe(50);
      expect(dto.offset).toBe(10);
    });

    it('rejects a limit above 100 with 400 (validated by the global pipe)', async () => {
      const dto = plainToInstance(SecurityEventsQueryDto, { limit: '101' });

      const errors = await validate(dto);
      expect(errors).not.toHaveLength(0);
      expect(errors.map((e) => e.constraints)).toEqual(
        expect.arrayContaining([expect.objectContaining({ max: expect.any(String) })]),
      );
    });

    it('rejects a limit below 1', async () => {
      const dto = plainToInstance(SecurityEventsQueryDto, { limit: '0' });

      expect(await validate(dto)).not.toHaveLength(0);
    });

    it('rejects a non-numeric limit', async () => {
      const dto = plainToInstance(SecurityEventsQueryDto, { limit: 'abc' });

      expect(await validate(dto)).not.toHaveLength(0);
    });

    it('rejects a negative offset', async () => {
      const dto = plainToInstance(SecurityEventsQueryDto, { offset: '-1' });

      expect(await validate(dto)).not.toHaveLength(0);
    });

    it('rejects non-integer paging values', async () => {
      const dto = plainToInstance(SecurityEventsQueryDto, { limit: '2.5' });

      expect(await validate(dto)).not.toHaveLength(0);
    });
  });
});
