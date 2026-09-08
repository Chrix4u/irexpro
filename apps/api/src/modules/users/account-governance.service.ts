import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { AuditAction } from '../../common/enums/audit-action.enum';
import { AuditSeverity } from '../audit/entities/audit-log.entity';
import { AuditService } from '../audit/audit.service';
import { isEmail, normalizePhone } from '../auth/utils/phone.util';
import { ResolveAccountAppealDto } from './dto/resolve-account-appeal.dto';
import { SubmitAccountAppealDto } from './dto/submit-account-appeal.dto';
import { AccountStatusAction, UpdateAccountStatusDto } from './dto/update-account-status.dto';
import {
  AccountAppeal,
  AccountAppealDecision,
  AccountAppealStatus,
} from './entities/account-appeal.entity';
import { User, UserStatus } from './entities/user.entity';

export interface PublicAppealResult {
  /** Deliberately invariant: never reveals whether an account or appeal exists. */
  message: string;
}

export interface AccountAppealAdminView {
  id: string;
  userId: string;
  reason: string;
  status: AccountAppealStatus;
  decision: AccountAppealDecision | null;
  reviewerUserId: string | null;
  reviewerNote: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
  user: {
    id: string;
    email: string | null;
    phone: string | null;
    status: UserStatus;
    profile: { firstName: string | null; lastName: string | null } | null;
  } | null;
}

export interface AccountAppealListResponse {
  items: AccountAppealAdminView[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface AdminAccountStatusView {
  id: string;
  status: UserStatus;
  deletedAt: string | null;
}

const PUBLIC_APPEAL_MESSAGE =
  'If an eligible account exists, the request has been received for review.';

/**
 * Account Governance — safe administrative account controls.
 *
 * This service owns only account access and review evidence. It does not
 * perform broker, risk, payment, or execution operations.
 */
@Injectable()
export class AccountGovernanceService {
  constructor(
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(AccountAppeal)
    private readonly appealRepo: Repository<AccountAppeal>,
    private readonly auditService: AuditService,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Public and enumeration-safe. We only persist an appeal when an existing,
   * non-active account is eligible for review; all other paths return exactly
   * the same response.
   */
  async submitAppeal(
    dto: SubmitAccountAppealDto,
    meta?: { ipAddress?: string; userAgent?: string },
  ): Promise<PublicAppealResult> {
    const trimmedReason = dto.reason.trim();
    // ValidationPipe checks the submitted length, but the public endpoint must
    // also defend against whitespace-only input after normalization. Keep the
    // same generic response so invalid input cannot become an enumeration aid.
    if (trimmedReason.length < 20) {
      return { message: PUBLIC_APPEAL_MESSAGE };
    }

    const user = await this.findUserByIdentifier(dto.identifier, true);

    if (!user || !this.canAppeal(user.status)) {
      return { message: PUBLIC_APPEAL_MESSAGE };
    }

    const existing = await this.appealRepo.findOne({
      where: { userId: user.id, status: AccountAppealStatus.PENDING },
    });
    if (existing) {
      return { message: PUBLIC_APPEAL_MESSAGE };
    }

    try {
      const appeal = await this.appealRepo.save(
        this.appealRepo.create({
          userId: user.id,
          reason: trimmedReason,
          status: AccountAppealStatus.PENDING,
          decision: null,
          reviewerUserId: null,
          reviewerNote: null,
          resolvedAt: null,
        }),
      );

      // Never copy appeal text or the supplied identifier into audit metadata.
      await this.auditService.log({
        actorUserId: user.id,
        actorType: 'PUBLIC',
        action: AuditAction.ACCOUNT_APPEAL_SUBMITTED,
        resourceType: 'AccountAppeal',
        resourceId: appeal.id,
        ipAddress: meta?.ipAddress,
        userAgent: meta?.userAgent,
        metadata: { accountStatus: user.status, reasonProvided: true },
        severity: AuditSeverity.WARNING,
      });
    } catch (err) {
      // A database unique index is the concurrency backstop for the one-pending
      // appeal rule. Preserve the generic response for duplicate races too.
      if (!this.isUniqueViolation(err)) throw err;
    }

    return { message: PUBLIC_APPEAL_MESSAGE };
  }

  async listAppeals(
    status?: AccountAppealStatus,
    requestedPage = 1,
    requestedLimit = 20,
  ): Promise<AccountAppealListResponse> {
    const { page, limit, skip } = this.normalizeAppealPagination(requestedPage, requestedLimit);
    const [appeals, total] = await this.appealRepo.findAndCount({
      where: status ? { status } : {},
      relations: ['user', 'user.profile'],
      withDeleted: true,
      order: { createdAt: 'ASC', id: 'ASC' },
      skip,
      take: limit,
    });

    return {
      items: appeals.map((appeal) => this.toAdminAppealView(appeal)),
      page,
      limit,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / limit),
    };
  }

  async resolveAppeal(
    appealId: string,
    reviewerUserId: string,
    dto: ResolveAccountAppealDto,
  ): Promise<AccountAppealAdminView> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    let resolvedAppeal: AccountAppeal;
    let targetUser: User;
    try {
      const appeal = await queryRunner.manager.findOne(AccountAppeal, {
        where: { id: appealId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!appeal) throw new NotFoundException('Account appeal not found');
      if (appeal.status !== AccountAppealStatus.PENDING) {
        throw new ConflictException('Account appeal has already been resolved');
      }

      const foundTargetUser = await queryRunner.manager.findOne(User, {
        where: { id: appeal.userId },
        withDeleted: true,
        lock: { mode: 'pessimistic_write' },
      });
      if (!foundTargetUser) throw new NotFoundException('Appeal account not found');
      targetUser = foundTargetUser;

      this.applyAppealDecision(targetUser, dto.decision);
      appeal.status = AccountAppealStatus.RESOLVED;
      appeal.decision = dto.decision;
      appeal.reviewerUserId = reviewerUserId;
      appeal.reviewerNote = dto.reviewerNote?.trim() || null;
      appeal.resolvedAt = new Date();

      await queryRunner.manager.save(User, targetUser);
      resolvedAppeal = await queryRunner.manager.save(AccountAppeal, appeal);
      await queryRunner.commitTransaction();
    } catch (err) {
      await queryRunner.rollbackTransaction();
      throw err;
    } finally {
      await queryRunner.release();
    }

    await this.auditService.log({
      actorUserId: reviewerUserId,
      actorType: 'ADMIN',
      action: AuditAction.ACCOUNT_APPEAL_RESOLVED,
      resourceType: 'AccountAppeal',
      resourceId: resolvedAppeal.id,
      metadata: {
        decision: resolvedAppeal.decision,
        targetUserId: targetUser.id,
        reviewerNoteProvided: Boolean(resolvedAppeal.reviewerNote),
      },
      severity: AuditSeverity.WARNING,
    });
    await this.logAccountStatusChange(reviewerUserId, targetUser, resolvedAppeal.decision!);
    const appealWithUser = await this.appealRepo.findOne({
      where: { id: resolvedAppeal.id },
      relations: ['user', 'user.profile'],
      withDeleted: true,
    });
    if (!appealWithUser) throw new NotFoundException('Resolved account appeal not found');
    return this.toAdminAppealView(appealWithUser);
  }

  async applyAdminAction(
    targetUserId: string,
    actorUserId: string,
    dto: UpdateAccountStatusDto,
  ): Promise<AdminAccountStatusView> {
    if (targetUserId === actorUserId) {
      throw new ForbiddenException('Administrators cannot change their own account access');
    }
    const trimmedReason = dto.reason.trim();
    if (trimmedReason.length < 5) {
      throw new BadRequestException('An account-access reason is required');
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    let targetUser: User;
    try {
      const foundTargetUser = await queryRunner.manager.findOne(User, {
        where: { id: targetUserId },
        withDeleted: true,
        lock: { mode: 'pessimistic_write' },
      });
      if (!foundTargetUser) throw new NotFoundException('User not found');
      targetUser = foundTargetUser;
      if (!this.canApplyAdminStatusAction(targetUser.status, dto.action)) {
        throw new ConflictException(
          'This account state can only change through an approved review',
        );
      }
      this.applyAdminStatusAction(targetUser, dto.action);
      await queryRunner.manager.save(User, targetUser);
      await queryRunner.commitTransaction();
    } catch (err) {
      await queryRunner.rollbackTransaction();
      throw err;
    } finally {
      await queryRunner.release();
    }

    await this.logAccountStatusChange(actorUserId, targetUser, dto.action, trimmedReason);
    return this.toAdminAccountStatusView(targetUser);
  }

  private async findUserByIdentifier(
    identifier: string,
    withDeleted = false,
  ): Promise<User | null> {
    const trimmed = identifier.trim();
    const emailLogin = isEmail(trimmed);
    const phoneLookup = emailLogin ? null : normalizePhone(trimmed);
    return this.userRepo.findOne({
      where: emailLogin ? { email: trimmed.toLowerCase() } : { phone: phoneLookup ?? '' },
      withDeleted,
    });
  }

  private canAppeal(status: UserStatus): boolean {
    return [UserStatus.SUSPENDED, UserStatus.PERMANENTLY_LOCKED, UserStatus.CLOSED].includes(
      status,
    );
  }

  private applyAppealDecision(user: User, decision: AccountAppealDecision): void {
    switch (decision) {
      case AccountAppealDecision.REACTIVATE:
        // Reactivation must not reset or roll back the session generation.
        // The generation was already advanced when the restrictive state was
        // entered, so every pre-restriction token stays revoked.
        user.status = UserStatus.ACTIVE;
        user.deletedAt = null;
        return;
      case AccountAppealDecision.PERMANENTLY_LOCK:
        this.advanceSessionVersion(user);
        user.status = UserStatus.PERMANENTLY_LOCKED;
        return;
      case AccountAppealDecision.DELETE:
        this.advanceSessionVersion(user);
        user.status = UserStatus.CLOSED;
        user.deletedAt = new Date();
        return;
    }
  }

  private applyAdminStatusAction(user: User, action: AccountStatusAction): void {
    switch (action) {
      case AccountStatusAction.DEACTIVATE:
        this.advanceSessionVersion(user);
        user.status = UserStatus.SUSPENDED;
        return;
      case AccountStatusAction.PERMANENTLY_LOCK:
        this.advanceSessionVersion(user);
        user.status = UserStatus.PERMANENTLY_LOCKED;
        return;
      case AccountStatusAction.DELETE:
        this.advanceSessionVersion(user);
        user.status = UserStatus.CLOSED;
        user.deletedAt = new Date();
        return;
    }
  }

  /**
   * Advance the token generation before persisting any restrictive account
   * state. JwtStrategy and refresh rotation both compare the token-carried
   * generation with this value, so advancing it revokes all existing sessions.
   * The containing governance transaction persists status + generation
   * atomically.
   */
  private advanceSessionVersion(user: User): void {
    const currentVersion = Number.isInteger(user.sessionVersion) ? user.sessionVersion : 0;
    user.sessionVersion = currentVersion + 1;
  }

  /** Prevent direct controls from weakening a locked or closed account state. */
  private canApplyAdminStatusAction(status: UserStatus, action: AccountStatusAction): boolean {
    if (status === UserStatus.CLOSED) return false;
    if (status === UserStatus.PERMANENTLY_LOCKED) {
      return action === AccountStatusAction.DELETE;
    }
    if (status === UserStatus.SUSPENDED) {
      return action !== AccountStatusAction.DEACTIVATE;
    }
    return true;
  }

  private async logAccountStatusChange(
    actorUserId: string,
    targetUser: User,
    action: AccountAppealDecision | AccountStatusAction,
    reason?: string,
  ): Promise<void> {
    const auditAction =
      action === AccountAppealDecision.REACTIVATE
        ? AuditAction.USER_REACTIVATED
        : action === AccountAppealDecision.PERMANENTLY_LOCK ||
            action === AccountStatusAction.PERMANENTLY_LOCK
          ? AuditAction.USER_PERMANENTLY_LOCKED
          : action === AccountAppealDecision.DELETE || action === AccountStatusAction.DELETE
            ? AuditAction.USER_CLOSED
            : AuditAction.USER_SUSPENDED;

    await this.auditService.log({
      actorUserId,
      actorType: 'ADMIN',
      action: auditAction,
      resourceType: 'User',
      resourceId: targetUser.id,
      metadata: {
        resultingStatus: targetUser.status,
        softDeleted: Boolean(targetUser.deletedAt),
        reasonProvided: Boolean(reason),
      },
      severity: AuditSeverity.WARNING,
    });
  }

  private isUniqueViolation(err: unknown): boolean {
    return (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as { code?: unknown }).code === '23505'
    );
  }

  /**
   * Normalize pagination at the service boundary as defense in depth. HTTP
   * validation rejects malformed query values, but direct/internal callers
   * must never be able to produce negative, fractional, non-finite, or
   * overflow-scale TypeORM offsets.
   */
  private normalizeAppealPagination(
    requestedPage: number,
    requestedLimit: number,
  ): { page: number; limit: number; skip: number } {
    const limitCandidate = Number.isFinite(requestedLimit) ? Math.trunc(requestedLimit) : 20;
    const limit = Math.min(100, Math.max(1, limitCandidate));

    const pageCandidate = Number.isFinite(requestedPage) ? Math.trunc(requestedPage) : 1;
    const positivePage = Math.max(1, pageCandidate);
    const maxPageForSafeOffset = Math.floor(Number.MAX_SAFE_INTEGER / limit) + 1;
    const page = Math.min(positivePage, maxPageForSafeOffset);
    const skip = (page - 1) * limit;

    return { page, limit, skip };
  }

  /** Explicit allowlist for admin browser responses; never serialize entities. */
  private toAdminAppealView(appeal: AccountAppeal): AccountAppealAdminView {
    const profile = appeal.user?.profile;
    return {
      id: appeal.id,
      userId: appeal.userId,
      reason: appeal.reason,
      status: appeal.status,
      decision: appeal.decision,
      reviewerUserId: appeal.reviewerUserId,
      reviewerNote: appeal.reviewerNote,
      resolvedAt: appeal.resolvedAt?.toISOString() ?? null,
      createdAt: appeal.createdAt.toISOString(),
      updatedAt: appeal.updatedAt.toISOString(),
      user: appeal.user
        ? {
            id: appeal.user.id,
            email: appeal.user.email,
            phone: appeal.user.phone,
            status: appeal.user.status,
            profile: profile ? { firstName: profile.firstName, lastName: profile.lastName } : null,
          }
        : null,
    };
  }

  private toAdminAccountStatusView(user: User): AdminAccountStatusView {
    return {
      id: user.id,
      status: user.status,
      deletedAt: user.deletedAt?.toISOString() ?? null,
    };
  }
}
