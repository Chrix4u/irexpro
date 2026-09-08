import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { FindOperator } from 'typeorm';
import { AuditService } from './audit.service';
import { AuditLog, AuditSeverity } from './entities/audit-log.entity';
import { AuditAction } from '../../common/enums/audit-action.enum';

/**
 * Sprint 55 — AuditService.listUserSecurityEvents (user security-event feed).
 *
 * Verifies:
 *   - ownership: primary filter is the caller's own USER-actor rows, plus the
 *     proven admin-actor status-change rows for the affected user (OR clause);
 *   - the action allowlist is applied SERVER-SIDE inside the repository query
 *     (USER_TOKEN_REFRESHED / ONBOARDING_PROFILE_UPDATED / verification-request
 *     actions can never be returned, not merely absent from fixtures);
 *   - the projection returns EXACTLY id, action, createdAt (ISO-8601), and
 *     severity — ipAddress, userAgent, metadata, correlationId, resourceType,
 *     resourceId, actorType, actorUserId never leave the service;
 *   - pagination: limit+1 fetch with hasMore; defensive clamps.
 */

const USER_ID = '11111111-1111-4111-8111-111111111111';

const mockAuditLogRepo = {
  create: jest.fn(),
  save: jest.fn(),
  find: jest.fn(),
};

function auditRow(overrides: Partial<AuditLog> = {}): AuditLog {
  return {
    id: 'event-1',
    action: AuditAction.USER_LOGIN_SUCCESS,
    createdAt: new Date('2026-09-07T10:30:00.000Z'),
    severity: AuditSeverity.INFO,
    // Sensitive fields that MUST be stripped by the projection:
    actorUserId: USER_ID,
    actorType: 'USER',
    resourceType: 'User',
    resourceId: USER_ID,
    correlationId: '99999999-9999-4999-8999-999999999999',
    ipAddress: '203.0.113.10',
    userAgent: 'Mozilla/5.0 (attacker-fingerprint)',
    metadata: { result: 'success', internalOnly: 'secret-context' },
    ...overrides,
  } as AuditLog;
}

describe('Sprint 55 — AuditService.listUserSecurityEvents', () => {
  let module: TestingModule;
  let service: AuditService;

  beforeEach(async () => {
    jest.clearAllMocks();

    module = await Test.createTestingModule({
      providers: [
        AuditService,
        { provide: getRepositoryToken(AuditLog), useValue: mockAuditLogRepo },
      ],
    }).compile();

    service = module.get<AuditService>(AuditService);
    mockAuditLogRepo.find.mockResolvedValue([]);
  });

  afterEach(async () => {
    await module.close();
  });

  it('queries only the caller own USER-actor rows plus the proven admin status-change rows', async () => {
    await service.listUserSecurityEvents(USER_ID, { limit: 20, offset: 0 });

    expect(mockAuditLogRepo.find).toHaveBeenCalledTimes(1);
    const findOptions = mockAuditLogRepo.find.mock.calls[0][0];

    const [ownRows, statusChangeRows] = findOptions.where;
    // Primary ownership filter: rows the user performed themselves.
    expect(ownRows).toEqual({
      actorUserId: USER_ID,
      actorType: 'USER',
      action: expect.any(FindOperator),
    });
    // OR clause: governance rows proven to carry resourceType='User' and
    // resourceId = the affected user's id with an ADMIN actor.
    expect(statusChangeRows).toEqual({
      actorType: 'ADMIN',
      resourceType: 'User',
      resourceId: USER_ID,
      action: expect.any(FindOperator),
    });
  });

  it('enforces the security-action allowlist server-side inside the query', async () => {
    await service.listUserSecurityEvents(USER_ID);

    const [ownRows] = mockAuditLogRepo.find.mock.calls[0][0].where;
    const allowedActions = (ownRows.action as FindOperator<string[]>).value as string[];

    // Allowlist members (spot-check every family):
    expect(allowedActions).toEqual(
      expect.arrayContaining([
        AuditAction.USER_REGISTERED,
        AuditAction.USER_LOGIN_SUCCESS,
        AuditAction.USER_LOGIN_FAILED,
        AuditAction.USER_LOGOUT,
        AuditAction.USER_PASSWORD_RESET_REQUESTED,
        AuditAction.USER_PASSWORD_RESET_COMPLETED,
        AuditAction.USER_PASSWORD_CHANGED,
        AuditAction.USER_PASSWORD_CHANGE_FAILED,
        AuditAction.USER_MFA_SETUP_STARTED,
        AuditAction.USER_MFA_CHALLENGE_FAILED,
        AuditAction.USER_MFA_ENABLED,
        AuditAction.USER_MFA_DISABLED,
        AuditAction.USER_EMAIL_VERIFIED,
        AuditAction.USER_PHONE_VERIFIED,
        AuditAction.USER_PHONE_VERIFICATION_FAILED,
        AuditAction.USER_SESSIONS_REVOKED_OTHERS,
        AuditAction.USER_SUSPENDED,
        AuditAction.USER_REACTIVATED,
        AuditAction.USER_PERMANENTLY_LOCKED,
        AuditAction.USER_CLOSED,
        AuditAction.ACCOUNT_APPEAL_SUBMITTED,
        AuditAction.ACCOUNT_APPEAL_RESOLVED,
      ]),
    );
    expect(allowedActions).toHaveLength(22);

    // Deliberately excluded noise — enforced in the query, not by fixtures:
    expect(allowedActions).not.toContain(AuditAction.USER_TOKEN_REFRESHED);
    expect(allowedActions).not.toContain(AuditAction.ONBOARDING_PROFILE_UPDATED);
    expect(allowedActions).not.toContain(AuditAction.USER_EMAIL_VERIFICATION_REQUESTED);
    expect(allowedActions).not.toContain(AuditAction.USER_PHONE_VERIFICATION_REQUESTED);
    expect(allowedActions).not.toContain(AuditAction.USER_PROFILE_UPDATED);
  });

  it('scopes the admin-actor OR clause to the four proven status-change actions', async () => {
    await service.listUserSecurityEvents(USER_ID);

    const [, statusChangeRows] = mockAuditLogRepo.find.mock.calls[0][0].where;
    const statusActions = (statusChangeRows.action as FindOperator<string[]>).value as string[];

    expect(statusActions).toEqual([
      AuditAction.USER_SUSPENDED,
      AuditAction.USER_REACTIVATED,
      AuditAction.USER_PERMANENTLY_LOCKED,
      AuditAction.USER_CLOSED,
    ]);
  });

  it('projects EXACTLY id, action, createdAt (ISO-8601), and severity — never audit context', async () => {
    mockAuditLogRepo.find.mockResolvedValueOnce([
      auditRow(),
      auditRow({
        id: 'event-2',
        action: AuditAction.USER_SUSPENDED,
        severity: AuditSeverity.WARNING,
      }),
    ]);

    const result = await service.listUserSecurityEvents(USER_ID);

    expect(result.events).toHaveLength(2);
    for (const event of result.events) {
      expect(Object.keys(event).sort()).toEqual(['action', 'createdAt', 'id', 'severity']);
    }
    expect(result.events[0]).toEqual({
      id: 'event-1',
      action: AuditAction.USER_LOGIN_SUCCESS,
      createdAt: '2026-09-07T10:30:00.000Z',
      severity: AuditSeverity.INFO,
    });

    // Sensitive audit context must never be serialized into the feed.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('ipAddress');
    expect(serialized).not.toContain('203.0.113.10');
    expect(serialized).not.toContain('userAgent');
    expect(serialized).not.toContain('attacker-fingerprint');
    expect(serialized).not.toContain('metadata');
    expect(serialized).not.toContain('secret-context');
    expect(serialized).not.toContain('correlationId');
    expect(serialized).not.toContain('resourceType');
    expect(serialized).not.toContain('resourceId');
    expect(serialized).not.toContain('actorType');
    expect(serialized).not.toContain('actorUserId');
  });

  it('selects only the projected columns at the repository boundary', async () => {
    await service.listUserSecurityEvents(USER_ID);

    expect(mockAuditLogRepo.find.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        select: { id: true, action: true, createdAt: true, severity: true },
      }),
    );
  });

  it('orders createdAt DESC and fetches limit+1 rows to compute hasMore', async () => {
    mockAuditLogRepo.find.mockResolvedValueOnce(
      Array.from({ length: 21 }, (_, i) => auditRow({ id: `event-${i}` })),
    );

    const result = await service.listUserSecurityEvents(USER_ID, { limit: 20, offset: 0 });

    expect(mockAuditLogRepo.find).toHaveBeenCalledWith(
      expect.objectContaining({
        order: { createdAt: 'DESC' },
        take: 21,
        skip: 0,
      }),
    );
    expect(result.events).toHaveLength(20);
    expect(result.hasMore).toBe(true);
  });

  it('forwards offset and reports hasMore=false when no extra row exists', async () => {
    mockAuditLogRepo.find.mockResolvedValueOnce(
      Array.from({ length: 5 }, (_, i) => auditRow({ id: `event-${i}` })),
    );

    const result = await service.listUserSecurityEvents(USER_ID, { limit: 5, offset: 40 });

    expect(mockAuditLogRepo.find).toHaveBeenCalledWith(
      expect.objectContaining({ take: 6, skip: 40 }),
    );
    expect(result.events).toHaveLength(5);
    expect(result.hasMore).toBe(false);
  });

  it('returns an empty page for a user with no security events', async () => {
    mockAuditLogRepo.find.mockResolvedValueOnce([]);

    const result = await service.listUserSecurityEvents(USER_ID);

    expect(result).toEqual({ events: [], hasMore: false });
  });

  it('applies defense-in-depth paging clamps', async () => {
    await service.listUserSecurityEvents(USER_ID, { limit: 500, offset: 0 });
    expect(mockAuditLogRepo.find).toHaveBeenCalledWith(
      expect.objectContaining({ take: 101, skip: 0 }),
    );

    await service.listUserSecurityEvents(USER_ID, { limit: 0, offset: -5 });
    expect(mockAuditLogRepo.find).toHaveBeenLastCalledWith(
      expect.objectContaining({ take: 2, skip: 0 }),
    );

    // Non-finite input (only reachable by bypassing the validated DTO) falls
    // back to the defaults instead of producing NaN pagination.
    await service.listUserSecurityEvents(USER_ID, { limit: Number.NaN, offset: Number.NaN });
    expect(mockAuditLogRepo.find).toHaveBeenLastCalledWith(
      expect.objectContaining({ take: 21, skip: 0 }),
    );
  });

  it('defaults to limit 20, offset 0', async () => {
    await service.listUserSecurityEvents(USER_ID);

    expect(mockAuditLogRepo.find).toHaveBeenCalledWith(
      expect.objectContaining({ take: 21, skip: 0 }),
    );
  });
});
