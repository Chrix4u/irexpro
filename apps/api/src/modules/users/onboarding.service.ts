import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User, UserStatus } from '../users/entities/user.entity';
import { UserProfile } from '../users/entities/user-profile.entity';
import { RiskProfile } from '../risk/entities/risk-profile.entity';
import { BrokerConnection } from '../broker/entities/broker-connection.entity';
import { BrokerConnectionStatus } from '../broker/interfaces/broker-adapter.interface';
import { BrokerCredentialLifecycle } from '../broker/authorization/broker-credential-status';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../../common/enums/audit-action.enum';
import { EligibilityService } from './eligibility.service';

/**
 * OnboardingService — centralized onboarding/readiness aggregator.
 *
 * Readiness is beginner-first: identity/profile, server-authoritative
 * eligibility/disclosures, and a connected broker are the only user-facing
 * setup gates. Risk limits remain server-managed and are enforced at execution
 * time; users are never required to tune risk parameters or declare trading
 * experience before AI trading can be used.
 */
@Injectable()
export class OnboardingService {
  private readonly logger = new Logger(OnboardingService.name);

  constructor(
    @InjectRepository(User)
    private userRepo: Repository<User>,
    @InjectRepository(UserProfile)
    private profileRepo: Repository<UserProfile>,
    @InjectRepository(RiskProfile)
    private riskProfileRepo: Repository<RiskProfile>,
    @InjectRepository(BrokerConnection)
    private brokerConnectionRepo: Repository<BrokerConnection>,
    private auditService: AuditService,
    private eligibilityService: EligibilityService,
  ) {}

  async getOnboardingStatus(userId: string): Promise<OnboardingStatus> {
    const user = await this.userRepo.findOne({
      where: { id: userId },
      relations: ['profile'],
    });

    if (!user) {
      return {
        profileCompleted: false,
        eligibilityCompleted: false,
        riskProfileCompleted: false,
        brokerConnected: false,
        brokerConnectionStatus: 'NONE' as const,
        canStartTrading: false,
        missingSteps: ['PROFILE', 'ELIGIBILITY', 'BROKER_CONNECTION'],
        blockedReasons: [
          'PROFILE_INCOMPLETE',
          'KYC_REQUIRED',
          'BROKER_DISCONNECTED',
        ] as OnboardingBlockedReason[],
        nextStep: 'PROFILE',
      };
    }

    const profileCompleted = this.isProfileComplete(user);

    // Fail closed: jurisdiction, adult age, KYC, or exact disclosure evidence
    // can independently keep eligibility incomplete.
    const eligibility = await this.eligibilityService.getStatus(userId);
    const eligibilityCompleted = eligibility.canProceed;

    // Risk limits are platform-managed defaults, not an onboarding task.
    // Keep the compatibility field true so older clients do not render a
    // phantom "configure risk" blocker.
    const riskProfile = await this.riskProfileRepo.findOne({ where: { userId } });
    const riskProfileCompleted = true;

    const activeConnection = await this.findActiveBrokerConnection(userId);
    const brokerConnected = !!activeConnection;
    const brokerConnectionStatus: BrokerConnectionStatus | 'NONE' = activeConnection
      ? activeConnection.status
      : 'NONE';

    const killSwitchActive = riskProfile?.killSwitchActive ?? false;
    const userActive = user.status === UserStatus.ACTIVE;

    const missingSteps: OnboardingStep[] = [];
    if (!profileCompleted) missingSteps.push('PROFILE');
    if (!eligibilityCompleted) missingSteps.push('ELIGIBILITY');
    if (!brokerConnected) missingSteps.push('BROKER_CONNECTION');

    // ── Round 6 live-execution completion (§26 / §1d): STABLE
    // machine-readable blockedReasons — every production blocker is named,
    // so `canStartTrading=false` is never presented without its reason(s).
    // The codes are a closed union (OnboardingBlockedReason); web/mobile/admin
    // are display-only consumers of this server-authoritative list.
    const blockedReasons: OnboardingBlockedReason[] = [];
    switch (user.status) {
      case UserStatus.PENDING_VERIFICATION:
        blockedReasons.push('ACCOUNT_PENDING_VERIFICATION');
        break;
      case UserStatus.SUSPENDED:
        blockedReasons.push('ACCOUNT_SUSPENDED');
        break;
      case UserStatus.PERMANENTLY_LOCKED:
        blockedReasons.push('ACCOUNT_LOCKED');
        break;
      case UserStatus.CLOSED:
        blockedReasons.push('ACCOUNT_CLOSED');
        break;
      default:
        break;
    }
    if (!profileCompleted) blockedReasons.push('PROFILE_INCOMPLETE');
    if (!eligibilityCompleted) {
      if (eligibility.jurisdictionStatus !== 'ELIGIBLE') {
        blockedReasons.push('JURISDICTION_INELIGIBLE');
      }
      if (eligibility.ageStatus !== 'ADULT') {
        blockedReasons.push('AGE_NOT_ADULT');
      }
      if (eligibility.kycStatus === 'REJECTED') {
        blockedReasons.push('KYC_REJECTED');
      } else if (eligibility.kycStatus !== 'APPROVED') {
        blockedReasons.push('KYC_REQUIRED');
      }
      if (eligibility.missingConsentKeys.length > 0) {
        blockedReasons.push('DISCLOSURE_OUTSTANDING');
      }
    }
    if (!brokerConnected) {
      blockedReasons.push('BROKER_DISCONNECTED');
    } else if (
      activeConnection?.credentialStatus &&
      !BrokerCredentialLifecycle.isUsable(activeConnection.credentialStatus)
    ) {
      blockedReasons.push('CREDENTIALS_INVALID');
    }
    if (killSwitchActive) {
      blockedReasons.push('KILL_SWITCH_ACTIVE');
    }

    const canStartTrading =
      userActive &&
      profileCompleted &&
      eligibilityCompleted &&
      brokerConnected &&
      !killSwitchActive;

    const nextStep: OnboardingNextStep = canStartTrading ? 'READY' : (missingSteps[0] ?? 'READY');

    if (canStartTrading) {
      await this.auditService
        .log({
          actorUserId: userId,
          action: AuditAction.TRADING_READINESS_CHECKED,
          resourceType: 'User',
          resourceId: userId,
          metadata: {
            canStartTrading: true,
            eligibilityPolicyVersion: eligibility.policyVersion,
            brokerConnectionId: activeConnection?.id,
          },
        })
        .catch(() => {
          /* audit never throws */
        });
    }

    return {
      profileCompleted,
      eligibilityCompleted,
      riskProfileCompleted,
      brokerConnected,
      brokerConnectionStatus,
      canStartTrading,
      missingSteps,
      blockedReasons,
      nextStep,
    };
  }

  async canStartTrading(
    userId: string,
  ): Promise<{ allowed: boolean; missingSteps: OnboardingStep[] }> {
    const status = await this.getOnboardingStatus(userId);
    return {
      allowed: status.canStartTrading,
      missingSteps: status.missingSteps,
    };
  }

  private isProfileComplete(user: User): boolean {
    const profile = user.profile;
    if (!profile) return false;
    return !!(
      profile.firstName &&
      profile.lastName &&
      profile.dateOfBirth &&
      user.countryCode &&
      user.timezone &&
      user.preferredCurrency
    );
  }

  /**
   * Select only the fields needed for readiness; credentials and provider
   * secrets are never loaded. Query failures fail closed to no connection.
   */
  private async findActiveBrokerConnection(
    userId: string,
  ): Promise<Pick<
    BrokerConnection,
    | 'id'
    | 'status'
    | 'lastHealthCheckAt'
    | 'consecutiveFailureCount'
    | 'liveTradingEnabled'
    | 'credentialStatus'
  > | null> {
    try {
      const connection = await this.brokerConnectionRepo
        .createQueryBuilder('conn')
        .select([
          'conn.id',
          'conn.status',
          'conn.lastHealthCheckAt',
          'conn.consecutiveFailureCount',
          'conn.liveTradingEnabled',
          'conn.credentialStatus',
        ])
        .where('conn.userId = :userId', { userId })
        .andWhere('conn.status = :status', { status: BrokerConnectionStatus.CONNECTED })
        .getOne();

      return connection as Pick<
        BrokerConnection,
        | 'id'
        | 'status'
        | 'lastHealthCheckAt'
        | 'consecutiveFailureCount'
        | 'liveTradingEnabled'
        | 'credentialStatus'
      > | null;
    } catch (err) {
      this.logger.error(
        `Failed to query broker connection for onboarding status (user ${userId}): ${(err as Error).message}`,
      );
      return null;
    }
  }
}

export type OnboardingStep = 'PROFILE' | 'ELIGIBILITY' | 'RISK_PROFILE' | 'BROKER_CONNECTION';
export type OnboardingNextStep = OnboardingStep | 'READY';

/**
 * Round 6 live-execution completion (§26 / §1d): the STABLE, closed set of
 * server-derived account-readiness blocked reason codes. `canStartTrading =
 * false` is NEVER presented without at least one of these codes. The
 * execution-time blockers (SESSION_*, SNAPSHOT_*, PROVIDER_UNVERIFIED,
 * EXECUTION_CONTROL_BLOCKED, RECONFIRMATION_REQUIRED, ...) live where they
 * are decided — the risk pipeline's RiskRejectionCode and the final dispatch
 * boundary's FinalDispatchBlockedReason unions (also machine-readable).
 */
export type OnboardingBlockedReason =
  | 'ACCOUNT_PENDING_VERIFICATION'
  | 'ACCOUNT_SUSPENDED'
  | 'ACCOUNT_LOCKED'
  | 'ACCOUNT_CLOSED'
  | 'PROFILE_INCOMPLETE'
  | 'JURISDICTION_INELIGIBLE'
  | 'AGE_NOT_ADULT'
  | 'KYC_REQUIRED'
  | 'KYC_REJECTED'
  | 'DISCLOSURE_OUTSTANDING'
  | 'RISK_PROFILE_MISSING'
  | 'RISK_ACK_REQUIRED'
  | 'KILL_SWITCH_ACTIVE'
  | 'BROKER_DISCONNECTED'
  | 'CREDENTIALS_INVALID';

export interface OnboardingStatus {
  profileCompleted: boolean;
  eligibilityCompleted: boolean;
  riskProfileCompleted: boolean;
  brokerConnected: boolean;
  brokerConnectionStatus: BrokerConnectionStatus | 'NONE';
  canStartTrading: boolean;
  missingSteps: OnboardingStep[];
  /** §26: stable machine-readable reasons for EVERY production blocker. */
  blockedReasons: OnboardingBlockedReason[];
  nextStep: OnboardingNextStep;
}
