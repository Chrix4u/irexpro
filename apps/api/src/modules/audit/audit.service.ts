import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { AuditLog, AuditSeverity } from './entities/audit-log.entity';
import { AuditAction } from '../../common/enums/audit-action.enum';
import { redactSensitive } from '../../common/utils/redact-sensitive.util';
import { getCorrelationId } from '../../common/utils/request-correlation.util';

const AI_SIGNAL_LIFECYCLE_ACTIONS: AuditAction[] = [
  AuditAction.AI_SIGNAL_RECEIVED,
  AuditAction.AI_SIGNAL_IGNORED,
  AuditAction.AI_SIGNAL_RISK_APPROVED,
  AuditAction.AI_SIGNAL_RISK_REJECTED,
  AuditAction.AI_SIGNAL_EXECUTED,
  AuditAction.AI_SIGNAL_EXECUTION_FAILED,
];

/**
 * Sprint 55 — server-side allowlist for the user-facing security-event feed.
 * Only these audit actions may EVER be returned by listUserSecurityEvents.
 *
 * Deliberately EXCLUDED (noise, not user-relevant account security):
 *   USER_TOKEN_REFRESHED and the verification-REQUEST actions
 *   (USER_EMAIL_VERIFICATION_REQUESTED / USER_PHONE_VERIFICATION_REQUESTED),
 *   ONBOARDING_PROFILE_UPDATED and other profile/onboarding churn.
 */
const USER_SECURITY_EVENT_ACTIONS: AuditAction[] = [
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
];

/**
 * Sprint 55 — account-status changes emitted by AccountGovernanceService with
 * actorType='ADMIN', resourceType='User', and resourceId = the AFFECTED user's
 * id (verified by code reading of logAccountStatusChange). Those rows are
 * additionally visible to the affected user via an OR clause so users can see
 * their own suspension/reactivation/lock/closure.
 *
 * ACCOUNT_APPEAL_RESOLVED is deliberately NOT in this list: account governance
 * emits it with resourceType='AccountAppeal' and resourceId = the appeal id
 * (not the user id), so the user-shaped ownership filter does not match it and
 * it stays admin-actor-only (invisible to the affected user).
 */
const ADMIN_ACTOR_USER_STATUS_ACTIONS: AuditAction[] = [
  AuditAction.USER_SUSPENDED,
  AuditAction.USER_REACTIVATED,
  AuditAction.USER_PERMANENTLY_LOCKED,
  AuditAction.USER_CLOSED,
];

export interface CreateAuditLogDto {
  actorUserId?: string;
  actorType?: string;
  action: AuditAction | string;
  resourceType?: string;
  resourceId?: string;
  correlationId?: string;
  ipAddress?: string;
  userAgent?: string;
  metadata?: Record<string, unknown>;
  severity?: AuditSeverity;
}

/** Privacy-safe projection of one audit row for the user security-event feed. */
export interface UserSecurityEvent {
  id: string;
  action: string;
  /** ISO-8601 timestamp. */
  createdAt: string;
  severity: AuditSeverity;
}

export interface UserSecurityEventPage {
  events: UserSecurityEvent[];
  /** True when at least one further allowlisted row exists beyond this page. */
  hasMore: boolean;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(
    @InjectRepository(AuditLog)
    private readonly auditLogRepo: Repository<AuditLog>,
  ) {}

  async log(dto: CreateAuditLogDto): Promise<void> {
    try {
      // A live HTTP request always uses its server-owned AsyncLocalStorage ID.
      // Explicit IDs are accepted only when no request context exists, which
      // keeps background/queue jobs correlatable without allowing HTTP callers
      // or intermediate services to override request provenance.
      const correlationId = getCorrelationId() ?? dto.correlationId ?? null;
      const safeMetadata = dto.metadata ? redactSensitive(dto.metadata) : null;

      const entry = this.auditLogRepo.create({
        actorUserId: dto.actorUserId ?? null,
        actorType: dto.actorType ?? 'USER',
        action: dto.action,
        resourceType: dto.resourceType ?? null,
        resourceId: dto.resourceId ?? null,
        correlationId,
        ipAddress: dto.ipAddress ?? null,
        userAgent: dto.userAgent ?? null,
        metadata: safeMetadata,
        severity: dto.severity ?? AuditSeverity.INFO,
      });
      await this.auditLogRepo.save(entry);
    } catch (err) {
      // Audit logging must never throw and disrupt the main flow.
      this.logger.error('Failed to write audit log', err);
    }
  }

  async listRecentAiSignalReceipts(userId: string, limit = 25): Promise<AuditLog[]> {
    const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 100);
    return this.auditLogRepo.find({
      where: {
        actorUserId: userId,
        action: AuditAction.AI_SIGNAL_RECEIVED,
        resourceType: 'AiSignal',
      },
      order: { createdAt: 'DESC' },
      take: safeLimit,
    });
  }

  async listAiSignalLifecycle(userId: string, signalIds: string[]): Promise<AuditLog[]> {
    if (signalIds.length === 0) return [];

    return this.auditLogRepo
      .createQueryBuilder('audit')
      .where('audit.actor_user_id = :userId', { userId })
      .andWhere('audit.action IN (:...actions)', { actions: AI_SIGNAL_LIFECYCLE_ACTIONS })
      .andWhere(
        `(
          (audit.resource_type = :signalResourceType AND audit.resource_id IN (:...signalIds))
          OR (audit.metadata->>'signalId') IN (:...signalIds)
        )`,
        { signalResourceType: 'AiSignal', signalIds },
      )
      .orderBy('audit.created_at', 'ASC')
      .getMany();
  }

  /**
   * Sprint 55 — user-facing security-event feed (GET /auth/security-events).
   *
   * Ownership is fail-closed and two-shaped:
   *   1. primary: rows the user performed themselves
   *      (actor_user_id = userId AND actor_type = 'USER');
   *   2. OR-clause: admin-emitted account-status changes proven to carry
   *      resourceType='User' AND resourceId = the affected user's id
   *      (see ADMIN_ACTOR_USER_STATUS_ACTIONS), so users see their own
   *      suspension/reactivation/lock/closure.
   *
   * The action allowlist is enforced SERVER-SIDE (inside the query), never by
   * filtering client-side. The projection returns ONLY id, action, createdAt,
   * and severity — ipAddress, userAgent, metadata, correlationId, resourceType,
   * resourceId, actorType, and actorUserId NEVER leave this method.
   *
   * An extra row (limit + 1) is fetched to compute hasMore without exposing
   * total row counts.
   */
  async listUserSecurityEvents(
    userId: string,
    paging: { limit?: number; offset?: number } = {},
  ): Promise<UserSecurityEventPage> {
    // Defense-in-depth clamps; the route's query DTO already enforces 1–100
    // and >= 0 via the global ValidationPipe. Non-finite input (only reachable
    // if a future caller bypasses the DTO) falls back to the defaults instead
    // of producing a NaN LIMIT/OFFSET.
    const requestedLimit = Number.isFinite(paging.limit) ? paging.limit! : 20;
    const requestedOffset = Number.isFinite(paging.offset) ? paging.offset! : 0;
    const limit = Math.min(Math.max(Math.trunc(requestedLimit), 1), 100);
    const offset = Math.max(Math.trunc(requestedOffset), 0);

    const rows = await this.auditLogRepo.find({
      select: { id: true, action: true, createdAt: true, severity: true },
      where: [
        {
          actorUserId: userId,
          actorType: 'USER',
          action: In(USER_SECURITY_EVENT_ACTIONS),
        },
        {
          actorType: 'ADMIN',
          resourceType: 'User',
          resourceId: userId,
          action: In(ADMIN_ACTOR_USER_STATUS_ACTIONS),
        },
      ],
      order: { createdAt: 'DESC' },
      take: limit + 1,
      skip: offset,
    });

    const hasMore = rows.length > limit;
    return {
      events: rows.slice(0, limit).map((row) => ({
        id: row.id,
        action: row.action,
        createdAt: row.createdAt.toISOString(),
        severity: row.severity,
      })),
      hasMore,
    };
  }
}
