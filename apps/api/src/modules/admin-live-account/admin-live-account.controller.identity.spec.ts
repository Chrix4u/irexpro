import 'reflect-metadata';
import { ExecutionContext, ForbiddenException, RequestMethod } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AdminLiveAccountController } from './admin-live-account.controller';
import { AdminAuditController } from './admin-audit.controller';
import { AdminLiveAccountService } from './admin-live-account.service';
import { RolesGuard } from '../../common/guards/roles.guard';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { ROLES_KEY } from '../../common/constants/roles.constants';
import { RoleName } from '../users/entities/role.entity';
import { BrokerConnection } from '../broker/entities/broker-connection.entity';
import { BrokerConnectionStatus, BrokerMode } from '../broker/interfaces/broker-adapter.interface';
import { BrokerAuthorizationStatus } from '../broker/authorization/broker-authorization-status';
import { BrokerCredentialStatus } from '../broker/authorization/broker-credential-status';
import { AuditLog, AuditSeverity } from '../audit/entities/audit-log.entity';
import { maskAccountId, toAdminConnectionRowView } from './dto/admin-connections-response.dto';
import { toAdminAuditRowView } from './dto/admin-audit-response.dto';

/**
 * Admin Live Operations controllers — identity/RBAC contract tests
 * (Directive §39 admin visibility + §51 substantial tests).
 *
 * Proves:
 * - the read endpoints exist under the right base paths/methods;
 * - @Roles(ADMIN, SUPER_ADMIN) + @UseGuards(JwtAuthGuard, RolesGuard) are
 *   attached AT THE CLASS LEVEL exactly like ExecutionControlController —
 *   the guard ordering actually rejects USER-role requests with 403;
 * - the controllers pass ONLY validated query params to the service
 *   (filters normalized, pagination clamped, investigation filters forwarded
 *   as plain strings for equality-only use);
 * - service entities serialize into the frozen response DTO shapes with
 *   credential/audit metadata never present.
 */
describe('Admin Live Operations controllers (identity + RBAC contract)', () => {
  const reflector = new Reflector();

  let liveController: AdminLiveAccountController;
  let auditController: AdminAuditController;
  let service: Record<string, jest.Mock>;

  beforeEach(() => {
    service = {
      getOverview: jest.fn().mockResolvedValue({
        generatedAt: '2026-01-15T12:00:00.000Z',
        connections: {},
        discrepancies: {},
        activeControls: [],
        providers: [],
        automation: { activeSessions: 0, suspendedSessions: 0 },
      }),
      getConnections: jest
        .fn()
        .mockResolvedValue({ connections: [], total: 0, limit: 50, offset: 0 }),
      getDiscrepancies: jest
        .fn()
        .mockResolvedValue({ discrepancies: [], total: 0, limit: 50, offset: 0 }),
      getAuditLogs: jest.fn().mockResolvedValue({ logs: [], total: 0, limit: 50, offset: 0 }),
    };

    liveController = new AdminLiveAccountController(service as unknown as AdminLiveAccountService);
    auditController = new AdminAuditController(service as unknown as AdminLiveAccountService);
  });

  // ─── Routes ───────────────────────────────────────────────────────────────

  describe('routes', () => {
    it('registers the admin/live-account base path', () => {
      expect(Reflect.getMetadata('path', AdminLiveAccountController)).toBe('admin/live-account');
    });

    it('exposes GET admin/live-account/overview', () => {
      expect(Reflect.getMetadata('path', liveController.getOverview)).toBe('overview');
      expect(Reflect.getMetadata('method', liveController.getOverview)).toBe(RequestMethod.GET);
    });

    it('exposes GET admin/live-account/connections', () => {
      expect(Reflect.getMetadata('path', liveController.getConnections)).toBe('connections');
      expect(Reflect.getMetadata('method', liveController.getConnections)).toBe(RequestMethod.GET);
    });

    it('exposes GET admin/live-account/reconciliation/discrepancies', () => {
      expect(Reflect.getMetadata('path', liveController.getDiscrepancies)).toBe(
        'reconciliation/discrepancies',
      );
      expect(Reflect.getMetadata('method', liveController.getDiscrepancies)).toBe(
        RequestMethod.GET,
      );
    });

    it('registers the admin/audit base path (separate controller)', () => {
      expect(Reflect.getMetadata('path', AdminAuditController)).toBe('admin/audit');
    });

    it('exposes GET admin/audit/logs', () => {
      expect(Reflect.getMetadata('path', auditController.getLogs)).toBe('logs');
      expect(Reflect.getMetadata('method', auditController.getLogs)).toBe(RequestMethod.GET);
    });
  });

  // ─── RBAC — the ExecutionControlController pattern ─────────────────────────

  describe('RBAC metadata (class-level, ExecutionControlController pattern)', () => {
    it.each([
      ['AdminLiveAccountController', AdminLiveAccountController],
      ['AdminAuditController', AdminAuditController],
    ])('%s requires ADMIN or SUPER_ADMIN at the class level', (_name, klass) => {
      const roles = reflector.get<RoleName[]>(ROLES_KEY, klass);
      expect(roles).toEqual([RoleName.ADMIN, RoleName.SUPER_ADMIN]);
    });

    it.each([
      ['AdminLiveAccountController', AdminLiveAccountController],
      ['AdminAuditController', AdminAuditController],
    ])('%s mounts JwtAuthGuard and RolesGuard (in that order)', (_name, klass) => {
      // GUARDS_METADATA is '__guards__' (not exported publicly — mirror it here)
      const guards: unknown[] = Reflect.getMetadata('__guards__', klass);
      expect(guards).toEqual([JwtAuthGuard, RolesGuard]);
    });

    it('has no handler-level @Roles overrides loosening the class requirement', () => {
      for (const handler of [
        liveController.getOverview,
        liveController.getConnections,
        liveController.getDiscrepancies,
        auditController.getLogs,
      ]) {
        expect(reflector.get(ROLES_KEY, handler)).toBeUndefined();
      }
    });
  });

  describe('RolesGuard actually enforces the class-level requirement', () => {
    const guard = new RolesGuard(reflector);

    const contextFor = (handler: () => unknown, klass: unknown, user: unknown): ExecutionContext =>
      ({
        getHandler: () => handler,
        getClass: () => klass,
        switchToHttp: () => ({ getRequest: () => ({ user }) }),
      }) as unknown as ExecutionContext;

    it('allows ADMIN on GET admin/live-account/overview', () => {
      const ctx = contextFor(liveController.getOverview, AdminLiveAccountController, {
        userId: 'admin-1',
        roles: [RoleName.ADMIN],
      });
      expect(guard.canActivate(ctx)).toBe(true);
    });

    it('allows SUPER_ADMIN on GET admin/audit/logs', () => {
      const ctx = contextFor(auditController.getLogs, AdminAuditController, {
        userId: 'sa-1',
        roles: [RoleName.SUPER_ADMIN],
      });
      expect(guard.canActivate(ctx)).toBe(true);
    });

    it('REJECTS a USER-role request with 403 Forbidden (admin-only surface)', () => {
      const ctx = contextFor(liveController.getConnections, AdminLiveAccountController, {
        userId: 'user-1',
        roles: [RoleName.USER],
      });
      expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
      expect(() => guard.canActivate(ctx)).toThrow('Insufficient permissions');
    });

    it('REJECTS a USER-role request on the audit controller too', () => {
      const ctx = contextFor(auditController.getLogs, AdminAuditController, {
        userId: 'user-1',
        roles: [RoleName.USER],
      });
      expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
    });

    it('REJECTS an unauthenticated request (no principal)', () => {
      const ctx = contextFor(liveController.getOverview, AdminLiveAccountController, undefined);
      expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
      expect(() => guard.canActivate(ctx)).toThrow('Access denied');
    });
  });

  // ─── Query validation + service delegation ────────────────────────────────

  describe('query validation defaults and clamps (validated params to service)', () => {
    it('getOverview takes no client inputs', async () => {
      expect(liveController.getOverview.length).toBe(0);
      await liveController.getOverview();
      expect(service.getOverview).toHaveBeenCalledTimes(1);
      expect(service.getOverview.mock.calls[0]).toHaveLength(0);
    });

    it('getConnections normalizes an invalid filter to ALL and clamps pagination', async () => {
      await liveController.getConnections('NOT_A_FILTER', 999, -5);
      expect(service.getConnections).toHaveBeenCalledWith('ALL', 100, 0);
    });

    it('getConnections keeps a valid filter and normal pagination untouched', async () => {
      await liveController.getConnections('CONNECTED', 50, 0);
      expect(service.getConnections).toHaveBeenCalledWith('CONNECTED', 50, 0);
    });

    it('getDiscrepancies normalizes an invalid filter to ALL and clamps pagination', async () => {
      await liveController.getDiscrepancies('BOGUS', 0, -1);
      expect(service.getDiscrepancies).toHaveBeenCalledWith('ALL', 1, 0);
    });

    it('getDiscrepancies keeps a valid severity filter (implies OPEN server-side)', async () => {
      await liveController.getDiscrepancies('CRITICAL', 25, 50);
      expect(service.getDiscrepancies).toHaveBeenCalledWith('CRITICAL', 25, 50);
    });

    it('getLogs normalizes an invalid filter to ALL and clamps pagination', async () => {
      await auditController.getLogs('INFO', 'actor-1', 'Order', -3, -10);
      expect(service.getAuditLogs).toHaveBeenCalledWith('ALL', 'actor-1', 'Order', 1, 0);
    });

    it('getLogs forwards investigation filters as plain strings for equality-only use', async () => {
      await auditController.getLogs('CRITICAL', 'user-42', 'ExecutionControl', 20, 40);
      expect(service.getAuditLogs).toHaveBeenCalledWith(
        'CRITICAL',
        'user-42',
        'ExecutionControl',
        20,
        40,
      );
      // String arguments only — no object principal can smuggle extra scoping.
      expect(typeof service.getAuditLogs.mock.calls[0][1]).toBe('string');
      expect(typeof service.getAuditLogs.mock.calls[0][2]).toBe('string');
    });

    it('getLogs defaults missing optional query params to null filters', async () => {
      await auditController.getLogs(undefined, undefined, undefined, 50, 0);
      expect(service.getAuditLogs).toHaveBeenCalledWith('ALL', null, null, 50, 0);
    });

    it('returns the service DTO payloads verbatim (thin controllers)', async () => {
      service.getConnections.mockResolvedValue({
        connections: [],
        total: 7,
        limit: 50,
        offset: 0,
      });
      const page = await liveController.getConnections('ALL', 50, 0);
      expect(page).toEqual({ connections: [], total: 7, limit: 50, offset: 0 });

      service.getAuditLogs.mockResolvedValue({ logs: [], total: 3, limit: 50, offset: 0 });
      const auditPage = await auditController.getLogs('ALL', undefined, undefined, 50, 0);
      expect(auditPage).toEqual({ logs: [], total: 3, limit: 50, offset: 0 });
    });
  });

  // ─── DTO mapping applied (service entities → response DTO) ────────────────

  describe('DTO mapping applied (service entities → response DTO)', () => {
    const connection = {
      id: 'conn-1',
      userId: 'user-1',
      brokerId: 'metatrader5',
      brokerName: 'MetaTrader 5',
      displayName: 'Primary account',
      accountId: '1234567890123',
      accountType: BrokerMode.DEMO,
      accountCurrency: 'USD',
      accountLeverage: 100,
      status: BrokerConnectionStatus.CONNECTED,
      authorizationStatus: BrokerAuthorizationStatus.ACTIVE,
      credentialStatus: BrokerCredentialStatus.VERIFIED,
      encryptedCredentials: 'aGVsbG8gd29ybGQgc2VjcmV0IHZhbHVl',
      credentialIv: '001122334455667788990011',
      credentialTag: 'aabbccdd0011223344556677889900aabb',
      encryptionKeyId: 'kms-live-key-42',
      lastHealthCheckAt: new Date('2026-01-15T11:55:00Z'),
      lastSyncAt: new Date('2026-01-15T11:55:00Z'),
      consecutiveFailureCount: 0,
      lastErrorMessage: null,
      demoValidated: true,
      liveTradingEnabled: true,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-15T11:55:00Z'),
    } as unknown as BrokerConnection;

    it('maps a BrokerConnection row to the admin view without raw accountId or credentials', () => {
      const row = toAdminConnectionRowView(connection, true, null, 2);

      expect(row).toMatchObject({
        id: 'conn-1',
        userId: 'user-1',
        brokerId: 'metatrader5',
        brokerName: 'MetaTrader 5',
        maskedAccountId: '•••0123',
        accountType: 'DEMO',
        connectionStatus: 'CONNECTED',
        authorizationStatus: 'ACTIVE',
        credentialStatus: 'VERIFIED',
        executable: true,
        liveTradingEnabled: true,
        openDiscrepancies: 2,
        createdAt: '2026-01-01T00:00:00.000Z',
      });

      const serialized = JSON.stringify(row);
      expect(serialized).not.toContain('1234567890123');
      expect(serialized).not.toContain('accountId');
      expect(serialized).not.toContain('encryptedCredentials');
      expect(serialized).not.toContain('credentialIv');
      expect(serialized).not.toContain('credentialTag');
      expect(serialized).not.toContain('encryptionKeyId');
    });

    it('masks short/absent account identifiers to null', () => {
      expect(maskAccountId(null)).toBeNull();
      expect(maskAccountId('abc')).toBeNull();
      expect(maskAccountId('abcd')).toBe('•••abcd');
    });

    it('maps an AuditLog row to the admin view without metadata/ip/userAgent', () => {
      const entity = {
        id: 'audit-1',
        action: 'EXECUTION_CONTROL_ACTIVATED',
        actorType: 'ADMIN',
        actorUserId: 'admin-1',
        resourceType: 'ExecutionControl',
        resourceId: 'ctl-1',
        correlationId: 'b2c3d4e5-f6a7-8901-bcde-f12345678901',
        ipAddress: '203.0.113.10',
        userAgent: 'Mozilla/5.0',
        metadata: { apiKey: 'secret-never-expose', scope: 'GLOBAL' },
        severity: AuditSeverity.CRITICAL,
        createdAt: new Date('2026-01-15T11:00:00Z'),
      } as unknown as AuditLog;

      const row = toAdminAuditRowView(entity);

      expect(row).toMatchObject({
        id: 'audit-1',
        action: 'EXECUTION_CONTROL_ACTIVATED',
        actorType: 'ADMIN',
        actorUserId: 'admin-1',
        resourceType: 'ExecutionControl',
        resourceId: 'ctl-1',
        correlationId: 'b2c3d4e5-f6a7-8901-bcde-f12345678901',
        severity: 'CRITICAL',
        createdAt: '2026-01-15T11:00:00.000Z',
      });

      const serialized = JSON.stringify(row);
      expect(serialized).not.toContain('metadata');
      expect(serialized).not.toContain('apiKey');
      expect(serialized).not.toContain('ipAddress');
      expect(serialized).not.toContain('203.0.113.10');
      expect(serialized).not.toContain('userAgent');
      expect(serialized).not.toContain('Mozilla');
    });
  });
});
