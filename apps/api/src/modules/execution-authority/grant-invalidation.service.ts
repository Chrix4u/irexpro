import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { RiskGrant } from '../execution/entities/risk-grant.entity';
import { ExecutionConfirmation } from '../execution/entities/execution-confirmation.entity';
import {
  ExecutionConfirmationStatus,
  RiskGrantStatus,
} from '../execution/interfaces/execution-authority';

/** Result of a user-scoped NEW-exposure authority invalidation. */
export interface UserAuthorityInvalidationResult {
  /** ACTIVE grants CAS-transitioned to INVALIDATED for the user. */
  invalidatedGrants: number;
  /** PENDING confirmations CAS-transitioned to REVOKED for the user. */
  revokedConfirmations: number;
}

/**
 * GrantInvalidationService — Round 6 (#299/#2/#15): the SINGLE tenant-scoped
 * seam for invalidating a user's NEW-exposure authority.
 *
 * When a safety-relevant authority fact changes (kill switch, material
 * risk-profile edit, KYC/jurisdiction decision, account governance
 * transition, broker authorization change), the affected user's still-ACTIVE
 * grants AND still-PENDING confirmations must stop being usable ATOMICALLY
 * with the fact. Both writes are affected-rows CAS transitions — terminal
 * rows (CONSUMED/EXPIRED/INVALIDATED confirmations/grants) are never
 * rewritten, and everything is scoped by user_id (issue #364: no cross-tenant
 * reachability, not even through invalidation).
 *
 * Lives in ExecutionAuthorityModule (a LEAF module — imports only
 * TypeOrmModule.forFeature + AuditModule-free) so RiskModule, BrokerModule
 * and the governance services can all consume it WITHOUT creating module
 * cycles. Every method accepts an OPTIONAL EntityManager so the caller can
 * fold the invalidation into the SAME transaction as the authority-changing
 * fact (the forbidden pattern is: save fact → commit → best-effort
 * invalidation later — that leaves an execution race).
 */
@Injectable()
export class GrantInvalidationService {
  private readonly logger = new Logger(GrantInvalidationService.name);

  constructor(
    @InjectRepository(RiskGrant)
    private readonly grantRepo: Repository<RiskGrant>,
    @InjectRepository(ExecutionConfirmation)
    private readonly confirmationRepo: Repository<ExecutionConfirmation>,
  ) {}

  /**
   * Invalidate ALL of a user's NEW-exposure authority: still-ACTIVE grants →
   * INVALIDATED (reason recorded) and still-PENDING confirmations → REVOKED.
   * Tenant-scoped; CAS on the non-terminal statuses only. Pass the caller's
   * EntityManager to commit atomically with the authority-changing fact.
   */
  async invalidateUserNewExposureAuthority(
    userId: string,
    reason: string,
    entityManager?: EntityManager,
  ): Promise<UserAuthorityInvalidationResult> {
    const grants = entityManager ? entityManager.getRepository(RiskGrant) : this.grantRepo;
    const confirmations = entityManager
      ? entityManager.getRepository(ExecutionConfirmation)
      : this.confirmationRepo;
    const now = new Date();
    const slicedReason = reason.slice(0, 200);

    const grantUpdate = await grants
      .createQueryBuilder()
      .update()
      .set({
        status: RiskGrantStatus.INVALIDATED,
        invalidatedAt: now,
        invalidationReason: slicedReason,
      })
      .where('user_id = :userId AND status = :active', {
        userId,
        active: RiskGrantStatus.ACTIVE,
      })
      .execute();

    const confirmationUpdate = await confirmations
      .createQueryBuilder()
      .update()
      .set({ status: ExecutionConfirmationStatus.REVOKED, revokedAt: now })
      .where('user_id = :userId AND status = :pending', {
        userId,
        pending: ExecutionConfirmationStatus.PENDING,
      })
      .execute();

    const result: UserAuthorityInvalidationResult = {
      invalidatedGrants: grantUpdate.affected ?? 0,
      revokedConfirmations: confirmationUpdate.affected ?? 0,
    };

    if (result.invalidatedGrants > 0 || result.revokedConfirmations > 0) {
      this.logger.warn(
        `Invalidated NEW-exposure authority for user ${userId}: ` +
          `${result.invalidatedGrants} grant(s), ${result.revokedConfirmations} confirmation(s) — ${slicedReason}`,
      );
    }
    return result;
  }

  /**
   * Revoke the still-PENDING confirmation(s) bound to ONE grant (supersession
   * path — the grant id is already tenant-scoped by the caller). CAS on
   * status = PENDING only.
   */
  async revokePendingConfirmationsForGrant(
    grantId: string,
    entityManager?: EntityManager,
  ): Promise<number> {
    const confirmations = entityManager
      ? entityManager.getRepository(ExecutionConfirmation)
      : this.confirmationRepo;
    const result = await confirmations
      .createQueryBuilder()
      .update()
      .set({ status: ExecutionConfirmationStatus.REVOKED, revokedAt: new Date() })
      .where('risk_grant_id = :grantId AND status = :pending', {
        grantId,
        pending: ExecutionConfirmationStatus.PENDING,
      })
      .execute();
    return result.affected ?? 0;
  }
}
