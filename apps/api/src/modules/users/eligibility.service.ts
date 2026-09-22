import { createHash } from 'crypto';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuditAction } from '../../common/enums/audit-action.enum';
import { AuditService } from '../audit/audit.service';
import { AcceptEligibilityDisclosuresDto } from './dto/accept-eligibility-disclosures.dto';
import { ReviewUserEligibilityDto } from './dto/review-user-eligibility.dto';
import { ReviewUserKycDto } from './dto/review-user-kyc.dto';
import {
  EligibilityDisclosureKey,
  UserDisclosureConsent,
} from './entities/user-disclosure-consent.entity';
import {
  EligibilityReviewDecision,
  UserEligibilityReview,
} from './entities/user-eligibility-review.entity';
import { KycReviewDecision, UserKycReview } from './entities/user-kyc-review.entity';
import { KycStatus, UserProfile } from './entities/user-profile.entity';
import { User, UserStatus } from './entities/user.entity';
import { TradingAuthorityService } from '../execution-authority/trading-authority.service';
import { GrantInvalidationService } from '../execution-authority/grant-invalidation.service';

export type EligibilityJurisdictionStatus =
  | 'MISSING_PROFILE'
  | 'REVIEW_REQUIRED'
  | 'ELIGIBLE'
  | 'INELIGIBLE';

export type EligibilityDecisionSource = 'POLICY' | 'ADMIN_REVIEW';
export type EligibilityAgeStatus = 'MISSING_DOB' | 'INVALID_DOB' | 'UNDER_18' | 'ADULT';

export interface EligibilityDisclosureView {
  key: EligibilityDisclosureKey;
  version: string;
  title: string;
  body: string;
  contentSha256: string;
  required: true;
}

export interface EligibilityConsentEvidenceView {
  policyVersion: string;
  policyFingerprint: string;
  key: EligibilityDisclosureKey;
  version: string;
  contentSha256: string;
  acceptedAt: string;
}

export interface EligibilityStatusView {
  policyVersion: string;
  policyFingerprint: string;
  countryCode: string | null;
  jurisdictionStatus: EligibilityJurisdictionStatus;
  decisionSource: EligibilityDecisionSource;
  reasonCode: string;
  reviewedAt: string | null;
  ageStatus: EligibilityAgeStatus;
  kycStatus: KycStatus;
  identityReasonCode: string;
  disclosures: EligibilityDisclosureView[];
  consents: EligibilityConsentEvidenceView[];
  missingConsentKeys: EligibilityDisclosureKey[];
  canProceed: boolean;
}

export interface EligibilityReviewQueueItem {
  userId: string;
  email: string | null;
  countryCode: string;
  policyVersion: string;
  policyFingerprint: string;
  jurisdictionStatus: 'REVIEW_REQUIRED';
  reasonCode: string;
}

export interface KycReviewQueueItem {
  userId: string;
  email: string | null;
  countryCode: string | null;
  dateOfBirth: string;
  ageStatus: 'ADULT';
  kycStatus: KycStatus.NONE | KycStatus.PENDING;
  reasonCode: 'KYC_REQUIRED' | 'KYC_PENDING';
}

interface JurisdictionDecision {
  status: EligibilityJurisdictionStatus;
  source: EligibilityDecisionSource;
  reasonCode: string;
  reviewedAt: Date | null;
}

interface DisclosureDefinition {
  key: EligibilityDisclosureKey;
  version: string;
  title: string;
  body: string;
}

interface ActiveEligibilityPolicy {
  version: string;
  fingerprint: string;
  disclosures: EligibilityDisclosureView[];
  allowedCountries: Set<string>;
  blockedCountries: Set<string>;
  reviewCountries: Set<string>;
}

const DISCLOSURES: readonly DisclosureDefinition[] = [
  {
    key: EligibilityDisclosureKey.AUTOMATED_TRADING_RISK,
    version: '1.0',
    title: 'Automated trading risk',
    body: 'Automated trading can result in financial loss. Market conditions, broker availability, model errors, slippage, and execution failures can affect outcomes. Risk controls reduce exposure but cannot eliminate risk.',
  },
  {
    key: EligibilityDisclosureKey.NO_PROFIT_GUARANTEE,
    version: '1.0',
    title: 'No profit guarantee',
    body: 'Historical research, simulations, AI confidence scores, and prior trading results do not guarantee future profits or prevent future losses.',
  },
  {
    key: EligibilityDisclosureKey.BROKER_EXECUTION_AUTHORITY,
    version: '1.0',
    title: 'Broker execution authority',
    body: 'When live automated trading is separately enabled, approved signals may be submitted to the connected broker only through the platform risk and execution controls. The broker remains the venue that accepts or rejects orders.',
  },
  {
    key: EligibilityDisclosureKey.LEGAL_ELIGIBILITY_ATTESTATION,
    version: '1.0',
    title: 'Age and legal eligibility attestation',
    body: 'I confirm that I am at least 18 years old, have the legal capacity to enter into this agreement, and am legally permitted to use automated trading services in the jurisdiction associated with my account.',
  },
] as const;

@Injectable()
export class EligibilityService {
  constructor(
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(UserDisclosureConsent)
    private readonly consentRepo: Repository<UserDisclosureConsent>,
    @InjectRepository(UserEligibilityReview)
    private readonly reviewRepo: Repository<UserEligibilityReview>,
    @InjectRepository(UserKycReview)
    private readonly kycReviewRepo: Repository<UserKycReview>,
    @InjectRepository(UserProfile)
    private readonly profileRepo: Repository<UserProfile>,
    private readonly configService: ConfigService,
    private readonly auditService: AuditService,
    // Round 6 (#300/#363): the unified execution-authority seams (leaf module
    // — no cycle: ExecutionAuthorityModule imports only forFeature + Audit).
    private readonly tradingAuthorityService: TradingAuthorityService,
    private readonly grantInvalidation: GrantInvalidationService,
  ) {}

  async getStatus(userId: string): Promise<EligibilityStatusView> {
    const user = await this.userRepo.findOne({ where: { id: userId }, relations: ['profile'] });
    if (!user) throw new NotFoundException('User not found.');
    return this.buildStatus(user);
  }

  /**
   * Production-LIVE completion round (Phase 9): CONTINUOUS user-eligibility
   * gate for LIVE new exposure.
   *
   * Eligibility (user status, KYC, jurisdiction, disclosures) is enforced at
   * session start via OnboardingService.canStartTrading — but a revocation
   * AFTER a session started must also block the NEXT LIVE new-exposure grant,
   * not just in-flight grants (which die at the commit fence through the
   * authority-generation bump these mutations already perform). The risk
   * pipeline calls this on every LIVE new-exposure evaluation; DEMO/PAPER
   * exposure is unaffected (not real money).
   *
   * Never throws for policy outcomes — a structured ineligible result lets
   * the caller record a typed risk rejection with the machine-readable
   * reason code. `countryCode` is returned alongside so the caller can also
   * enforce provider LIVE region availability for this user.
   */
  async assertUserEligibleForLiveNewExposure(userId: string): Promise<
    | { eligible: true; countryCode: string | null }
    | {
        eligible: false;
        reasonCode: string;
        detail: string;
        countryCode: string | null;
      }
  > {
    const user = await this.userRepo.findOne({ where: { id: userId }, relations: ['profile'] });
    if (!user) {
      return {
        eligible: false,
        reasonCode: 'USER_NOT_FOUND',
        detail: 'user row absent — cannot authorize LIVE new exposure',
        countryCode: null,
      };
    }
    if (user.status !== UserStatus.ACTIVE) {
      return {
        eligible: false,
        reasonCode: `ACCOUNT_${user.status}`,
        detail: `user status is ${user.status} — LIVE new exposure requires an ACTIVE account`,
        countryCode: user.countryCode ?? null,
      };
    }
    const status = await this.buildStatus(user);
    if (!status.canProceed) {
      const reasonCode =
        status.jurisdictionStatus !== 'ELIGIBLE'
          ? `JURISDICTION_${status.jurisdictionStatus}`
          : status.ageStatus !== 'ADULT'
            ? `AGE_${status.ageStatus}`
            : status.kycStatus !== KycStatus.APPROVED
              ? `KYC_${status.kycStatus}`
              : status.missingConsentKeys.length > 0
                ? 'DISCLOSURES_OUTSTANDING'
                : 'ELIGIBILITY_INCOMPLETE';
      return {
        eligible: false,
        reasonCode,
        detail:
          'LIVE new exposure requires current eligibility (jurisdiction, age, KYC, disclosures)',
        countryCode: status.countryCode,
      };
    }
    return { eligible: true, countryCode: status.countryCode };
  }

  async acceptDisclosures(
    userId: string,
    dto: AcceptEligibilityDisclosuresDto,
  ): Promise<EligibilityStatusView> {
    const user = await this.userRepo.findOne({ where: { id: userId }, relations: ['profile'] });
    if (!user) throw new NotFoundException('User not found.');

    const policy = this.currentPolicy();
    if (dto.policyVersion !== policy.version || dto.policyFingerprint !== policy.fingerprint) {
      throw new BadRequestException(
        'Eligibility policy changed. Refresh the current disclosures before recording consent.',
      );
    }

    const definitionsByKey = new Map(policy.disclosures.map((item) => [item.key, item]));
    const seen = new Set<EligibilityDisclosureKey>();
    const accepted: Array<{ key: EligibilityDisclosureKey; version: string }> = [];

    for (const acceptance of dto.acceptances) {
      if (seen.has(acceptance.key)) {
        throw new BadRequestException(`Duplicate disclosure acceptance: ${acceptance.key}`);
      }
      seen.add(acceptance.key);

      const definition = definitionsByKey.get(acceptance.key);
      if (
        !definition ||
        definition.version !== acceptance.version ||
        definition.contentSha256 !== acceptance.contentSha256
      ) {
        throw new BadRequestException(
          `Disclosure ${acceptance.key} does not match the current required version. Refresh eligibility disclosures and try again.`,
        );
      }

      const existing = await this.consentRepo.findOne({
        where: {
          userId,
          policyVersion: policy.version,
          policyFingerprint: policy.fingerprint,
          disclosureKey: acceptance.key,
          disclosureVersion: acceptance.version,
          contentSha256: acceptance.contentSha256,
        },
      });

      if (!existing) {
        await this.consentRepo.save(
          this.consentRepo.create({
            userId,
            policyVersion: policy.version,
            policyFingerprint: policy.fingerprint,
            disclosureKey: acceptance.key,
            disclosureVersion: acceptance.version,
            contentSha256: acceptance.contentSha256,
            acceptedAt: new Date(),
          }),
        );
      }

      accepted.push({ key: acceptance.key, version: acceptance.version });
    }

    await this.auditService.log({
      actorUserId: userId,
      action: AuditAction.ELIGIBILITY_DISCLOSURES_ACCEPTED,
      resourceType: 'UserEligibility',
      resourceId: userId,
      metadata: {
        policyVersion: policy.version,
        policyFingerprint: policy.fingerprint,
        disclosures: accepted,
      },
    });

    return this.buildStatus(user);
  }

  async submitKyc(userId: string): Promise<EligibilityStatusView> {
    const user = await this.userRepo.findOne({ where: { id: userId }, relations: ['profile'] });
    if (!user) throw new NotFoundException('User not found.');

    const profile = user.profile;
    if (!profile?.dateOfBirth) {
      throw new BadRequestException(
        'Complete your identity profile and date of birth before submitting KYC.',
      );
    }
    if (!user.countryCode) {
      throw new BadRequestException('Complete your country information before submitting KYC.');
    }
    if (this.evaluateAge(profile.dateOfBirth) !== 'ADULT') {
      throw new BadRequestException(
        'KYC submission is available only when the adult-age requirement is met.',
      );
    }

    const currentStatus = await this.resolveKycStatus(
      user.id,
      profile.dateOfBirth,
      profile.kycStatus,
    );

    if (currentStatus === KycStatus.APPROVED || currentStatus === KycStatus.PENDING) {
      return this.buildStatus(user);
    }
    if (currentStatus === KycStatus.REJECTED) {
      throw new BadRequestException(
        'KYC was rejected for the current identity record. Update the required identity information or contact support before submitting again.',
      );
    }

    profile.kycStatus = KycStatus.PENDING;
    profile.kycSubmittedAt = new Date();
    profile.kycApprovedAt = null;
    await this.profileRepo.save(profile);

    await this.auditService.log({
      actorUserId: userId,
      action: AuditAction.USER_KYC_SUBMITTED,
      resourceType: 'UserProfile',
      resourceId: profile.id,
      metadata: {
        dateOfBirthBound: true,
        countryCode: user.countryCode.toUpperCase(),
      },
    });

    return this.buildStatus(user);
  }

  async listReviewQueue(): Promise<EligibilityReviewQueueItem[]> {
    const policy = this.currentPolicy();
    const users = await this.userRepo.find({
      where: { status: UserStatus.ACTIVE },
      order: { createdAt: 'ASC' },
      take: 200,
    });

    const queue: EligibilityReviewQueueItem[] = [];
    for (const user of users) {
      if (user.status !== UserStatus.ACTIVE || !user.countryCode) continue;

      const decision = await this.evaluateJurisdiction(user.id, user.countryCode, policy);
      if (decision.status !== 'REVIEW_REQUIRED') continue;

      queue.push({
        userId: user.id,
        email: user.email,
        countryCode: user.countryCode.toUpperCase(),
        policyVersion: policy.version,
        policyFingerprint: policy.fingerprint,
        jurisdictionStatus: 'REVIEW_REQUIRED',
        reasonCode: decision.reasonCode,
      });
    }
    return queue;
  }

  async listKycReviewQueue(): Promise<KycReviewQueueItem[]> {
    const users = await this.userRepo.find({
      where: { status: UserStatus.ACTIVE },
      relations: ['profile'],
      order: { createdAt: 'ASC' },
      take: 200,
    });

    const queue: KycReviewQueueItem[] = [];
    for (const user of users) {
      const profile = user.profile;
      if (user.status !== UserStatus.ACTIVE || !profile?.dateOfBirth) continue;
      if (this.evaluateAge(profile.dateOfBirth) !== 'ADULT') continue;

      const kycStatus = await this.resolveKycStatus(
        user.id,
        profile.dateOfBirth,
        profile.kycStatus,
      );
      // Only an explicit user submission enters the administrator review
      // queue. Merely having a complete profile must not silently opt a user
      // into identity review.
      if (kycStatus !== KycStatus.PENDING) continue;

      queue.push({
        userId: user.id,
        email: user.email,
        countryCode: user.countryCode?.toUpperCase() ?? null,
        dateOfBirth: profile.dateOfBirth,
        ageStatus: 'ADULT',
        kycStatus,
        reasonCode: kycStatus === KycStatus.PENDING ? 'KYC_PENDING' : 'KYC_REQUIRED',
      });
    }

    return queue;
  }

  async reviewUser(
    userId: string,
    reviewerUserId: string,
    dto: ReviewUserEligibilityDto,
  ): Promise<EligibilityStatusView> {
    const user = await this.userRepo.findOne({ where: { id: userId }, relations: ['profile'] });
    if (!user) throw new NotFoundException('User not found.');
    if (!user.countryCode) {
      throw new BadRequestException('The user must complete country information before review.');
    }

    const policy = this.currentPolicy();
    if (dto.policyVersion !== policy.version || dto.policyFingerprint !== policy.fingerprint) {
      throw new BadRequestException(
        'Eligibility policy changed. Refresh the review queue before recording a jurisdiction decision.',
      );
    }

    const countryCode = user.countryCode.toUpperCase();
    const baseDecision = this.evaluatePolicy(countryCode, policy);
    if (baseDecision.status === 'ELIGIBLE') {
      throw new BadRequestException('This jurisdiction is already allowed by the active policy.');
    }
    if (baseDecision.status === 'INELIGIBLE') {
      throw new BadRequestException(
        'This jurisdiction is explicitly blocked by the active policy and cannot be overridden by review.',
      );
    }

    const review = await this.reviewRepo.manager.transaction(async (em) => {
      const saved = await em.getRepository(UserEligibilityReview).save(
        this.reviewRepo.create({
          userId,
          countryCode,
          policyVersion: policy.version,
          policyFingerprint: policy.fingerprint,
          decision: dto.decision,
          reasonCode: dto.reasonCode.trim().toUpperCase(),
          reviewerUserId,
          reviewerNote: dto.reviewerNote?.trim() || null,
        }),
      );
      // Round 6 (#2/#300): a jurisdiction decision replaces previously usable
      // eligibility evidence — the authority bump + NEW-exposure invalidation
      // commit ATOMICALLY with the review fact (never best-effort later).
      await this.tradingAuthorityService.bumpGeneration(
        userId,
        'JURISDICTION_DECISION_CHANGED',
        em,
      );
      await this.grantInvalidation.invalidateUserNewExposureAuthority(
        userId,
        'JURISDICTION_DECISION_CHANGED',
        em,
      );
      return saved;
    });

    await this.auditService.log({
      actorUserId: reviewerUserId,
      action: AuditAction.ELIGIBILITY_REVIEW_RECORDED,
      resourceType: 'UserEligibilityReview',
      resourceId: review.id,
      metadata: {
        userId,
        countryCode,
        policyVersion: review.policyVersion,
        policyFingerprint: review.policyFingerprint,
        decision: review.decision,
        reasonCode: review.reasonCode,
      },
    });

    return this.buildStatus(user);
  }

  async reviewKyc(
    userId: string,
    reviewerUserId: string,
    dto: ReviewUserKycDto,
  ): Promise<EligibilityStatusView> {
    const user = await this.userRepo.findOne({ where: { id: userId }, relations: ['profile'] });
    if (!user) throw new NotFoundException('User not found.');
    if (!user.profile?.dateOfBirth) {
      throw new BadRequestException('The user must provide a date of birth before KYC review.');
    }

    const ageStatus = this.evaluateAge(user.profile.dateOfBirth);
    if (ageStatus !== 'ADULT') {
      throw new BadRequestException(
        'KYC approval is not available unless the adult-age requirement is met.',
      );
    }

    const review = await this.kycReviewRepo.save(
      this.kycReviewRepo.create({
        userId,
        dateOfBirth: user.profile.dateOfBirth,
        decision: dto.decision,
        reasonCode: dto.reasonCode.trim().toUpperCase(),
        reviewerUserId,
        reviewerNote: dto.reviewerNote?.trim() || null,
      }),
    );

    const reviewedAt = review.createdAt ?? new Date();
    user.profile.kycSubmittedAt = user.profile.kycSubmittedAt ?? reviewedAt;
    if (dto.decision === KycReviewDecision.APPROVED) {
      user.profile.kycStatus = KycStatus.APPROVED;
      user.profile.kycApprovedAt = reviewedAt;
    } else {
      user.profile.kycStatus = KycStatus.REJECTED;
      user.profile.kycApprovedAt = null;
    }
    await this.userRepo.manager.transaction(async (em) => {
      await em.getRepository(User).save(user);
      // Round 6 (#2/#300): APPROVED/REJECTED replaces previously usable KYC
      // evidence — atomic authority bump + NEW-exposure invalidation.
      await this.tradingAuthorityService.bumpGeneration(userId, 'KYC_REVIEW_DECIDED', em);
      await this.grantInvalidation.invalidateUserNewExposureAuthority(
        userId,
        'KYC_REVIEW_DECIDED',
        em,
      );
    });

    await this.auditService.log({
      actorUserId: reviewerUserId,
      action: AuditAction.ADMIN_ACTION,
      resourceType: 'UserKycReview',
      resourceId: review.id,
      metadata: {
        actionType: 'KYC_REVIEW_RECORDED',
        userId,
        decision: review.decision,
        reasonCode: review.reasonCode,
      },
    });

    return this.buildStatus(user);
  }

  private async buildStatus(user: User): Promise<EligibilityStatusView> {
    const policy = this.currentPolicy();
    const countryCode = user.countryCode?.toUpperCase() ?? null;
    const decision = await this.evaluateJurisdiction(user.id, countryCode, policy);
    const consentRows = await this.consentRepo.find({
      where: { userId: user.id },
      order: { acceptedAt: 'ASC' },
    });

    const currentConsentByKey = new Map<EligibilityDisclosureKey, UserDisclosureConsent>();
    for (const disclosure of policy.disclosures) {
      const match = consentRows.find(
        (row) =>
          row.policyVersion === policy.version &&
          row.policyFingerprint === policy.fingerprint &&
          row.disclosureKey === disclosure.key &&
          row.disclosureVersion === disclosure.version &&
          row.contentSha256 === disclosure.contentSha256,
      );
      if (match) currentConsentByKey.set(disclosure.key, match);
    }

    const missingConsentKeys = policy.disclosures
      .filter((item) => !currentConsentByKey.has(item.key))
      .map((item) => item.key);

    const consents = policy.disclosures.flatMap((item) => {
      const row = currentConsentByKey.get(item.key);
      return row
        ? [
            {
              policyVersion: row.policyVersion,
              policyFingerprint: row.policyFingerprint,
              key: row.disclosureKey,
              version: row.disclosureVersion,
              contentSha256: row.contentSha256,
              acceptedAt: row.acceptedAt.toISOString(),
            },
          ]
        : [];
    });

    const dateOfBirth = user.profile?.dateOfBirth ?? null;
    const ageStatus = this.evaluateAge(dateOfBirth);
    const kycStatus = await this.resolveKycStatus(
      user.id,
      dateOfBirth,
      user.profile?.kycStatus ?? KycStatus.NONE,
    );
    const identityReasonCode = this.identityReason(ageStatus, kycStatus);

    return {
      policyVersion: policy.version,
      policyFingerprint: policy.fingerprint,
      countryCode,
      jurisdictionStatus: decision.status,
      decisionSource: decision.source,
      reasonCode: decision.reasonCode,
      reviewedAt: decision.reviewedAt?.toISOString() ?? null,
      ageStatus,
      kycStatus,
      identityReasonCode,
      disclosures: policy.disclosures,
      consents,
      missingConsentKeys,
      canProceed:
        decision.status === 'ELIGIBLE' &&
        ageStatus === 'ADULT' &&
        kycStatus === KycStatus.APPROVED &&
        missingConsentKeys.length === 0,
    };
  }

  private async resolveKycStatus(
    userId: string,
    dateOfBirth: string | null,
    profileStatus: KycStatus,
  ): Promise<KycStatus> {
    if (!dateOfBirth) return KycStatus.NONE;

    const review = await this.kycReviewRepo.findOne({
      where: { userId, dateOfBirth },
      order: { createdAt: 'DESC' },
    });

    if (!review) {
      // A mutable APPROVED flag without immutable evidence is never trusted.
      // Other non-approved states remain fail-closed and may continue through
      // the normal review workflow.
      return profileStatus === KycStatus.APPROVED ? KycStatus.NONE : profileStatus;
    }

    return review.decision === KycReviewDecision.APPROVED ? KycStatus.APPROVED : KycStatus.REJECTED;
  }

  private async evaluateJurisdiction(
    userId: string,
    countryCode: string | null,
    policy: ActiveEligibilityPolicy,
  ): Promise<JurisdictionDecision> {
    if (!countryCode) {
      return {
        status: 'MISSING_PROFILE',
        source: 'POLICY',
        reasonCode: 'COUNTRY_REQUIRED',
        reviewedAt: null,
      };
    }

    const normalized = countryCode.toUpperCase();
    const policyDecision = this.evaluatePolicy(normalized, policy);
    if (policyDecision.status !== 'REVIEW_REQUIRED') return policyDecision;

    const review = await this.reviewRepo.findOne({
      where: {
        userId,
        countryCode: normalized,
        policyVersion: policy.version,
        policyFingerprint: policy.fingerprint,
      },
      order: { createdAt: 'DESC' },
    });

    if (!review) return policyDecision;
    return review.decision === EligibilityReviewDecision.APPROVED
      ? {
          status: 'ELIGIBLE',
          source: 'ADMIN_REVIEW',
          reasonCode: review.reasonCode,
          reviewedAt: review.createdAt,
        }
      : {
          status: 'INELIGIBLE',
          source: 'ADMIN_REVIEW',
          reasonCode: review.reasonCode,
          reviewedAt: review.createdAt,
        };
  }

  private evaluatePolicy(
    countryCode: string,
    policy: ActiveEligibilityPolicy,
  ): JurisdictionDecision {
    if (policy.blockedCountries.has(countryCode)) {
      return {
        status: 'INELIGIBLE',
        source: 'POLICY',
        reasonCode: 'POLICY_BLOCKED',
        reviewedAt: null,
      };
    }

    if (policy.allowedCountries.has(countryCode)) {
      return {
        status: 'ELIGIBLE',
        source: 'POLICY',
        reasonCode: 'POLICY_ALLOWED',
        reviewedAt: null,
      };
    }

    return {
      status: 'REVIEW_REQUIRED',
      source: 'POLICY',
      reasonCode: policy.reviewCountries.has(countryCode)
        ? 'POLICY_REVIEW_REQUIRED'
        : 'UNCLASSIFIED_JURISDICTION',
      reviewedAt: null,
    };
  }

  private evaluateAge(dateOfBirth: string | null): EligibilityAgeStatus {
    if (!dateOfBirth) return 'MISSING_DOB';

    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateOfBirth);
    if (!match) return 'INVALID_DOB';

    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const dob = new Date(Date.UTC(year, month - 1, day));
    if (
      dob.getUTCFullYear() !== year ||
      dob.getUTCMonth() !== month - 1 ||
      dob.getUTCDate() !== day
    ) {
      return 'INVALID_DOB';
    }

    const now = new Date();
    let age = now.getUTCFullYear() - year;
    const monthDelta = now.getUTCMonth() - (month - 1);
    if (monthDelta < 0 || (monthDelta === 0 && now.getUTCDate() < day)) age -= 1;
    return age >= 18 ? 'ADULT' : 'UNDER_18';
  }

  private identityReason(ageStatus: EligibilityAgeStatus, kycStatus: KycStatus): string {
    if (ageStatus === 'MISSING_DOB') return 'DOB_REQUIRED';
    if (ageStatus === 'INVALID_DOB') return 'DOB_INVALID';
    if (ageStatus === 'UNDER_18') return 'AGE_REQUIREMENT_NOT_MET';
    if (kycStatus === KycStatus.APPROVED) return 'IDENTITY_APPROVED';
    if (kycStatus === KycStatus.PENDING) return 'KYC_PENDING';
    if (kycStatus === KycStatus.REJECTED) return 'KYC_REJECTED';
    return 'KYC_REQUIRED';
  }

  private currentDisclosures(): EligibilityDisclosureView[] {
    return DISCLOSURES.map((item) => ({
      ...item,
      contentSha256: createHash('sha256').update(item.body, 'utf8').digest('hex'),
      required: true as const,
    }));
  }

  /**
   * Round 6 (#363): the ACTIVE embedded trading-policy fingerprint — consumed
   * by the deployment bootstrap (SharedControlPlaneBootstrap) to seed/advance
   * the shared cross-replica trading-policy revision. Public + read-only.
   */
  getActivePolicyFingerprint(): { version: string; fingerprint: string } {
    const policy = this.currentPolicy();
    return { version: policy.version, fingerprint: policy.fingerprint };
  }

  private currentPolicy(): ActiveEligibilityPolicy {
    const version = this.policyVersion();
    const disclosures = this.currentDisclosures();
    const allowedCountries = this.countrySet('ELIGIBILITY_ALLOWED_COUNTRY_CODES');
    const blockedCountries = this.countrySet('ELIGIBILITY_BLOCKED_COUNTRY_CODES');
    const reviewCountries = this.countrySet('ELIGIBILITY_REVIEW_COUNTRY_CODES');

    const fingerprintPayload = {
      version,
      allowedCountryCodes: [...allowedCountries].sort(),
      blockedCountryCodes: [...blockedCountries].sort(),
      reviewCountryCodes: [...reviewCountries].sort(),
      disclosures: disclosures
        .map((item) => ({
          key: item.key,
          version: item.version,
          contentSha256: item.contentSha256,
        }))
        .sort((left, right) => left.key.localeCompare(right.key)),
    };

    return {
      version,
      fingerprint: createHash('sha256')
        .update(JSON.stringify(fingerprintPayload), 'utf8')
        .digest('hex'),
      disclosures,
      allowedCountries,
      blockedCountries,
      reviewCountries,
    };
  }

  private policyVersion(): string {
    return this.configService.get<string>('ELIGIBILITY_POLICY_VERSION')?.trim() || 'eligibility.v1';
  }

  private countrySet(key: string): Set<string> {
    const raw = this.configService.get<string>(key) ?? '';
    return new Set(
      raw
        .split(',')
        .map((item) => item.trim().toUpperCase())
        .filter((item) => /^[A-Z]{2}$/.test(item)),
    );
  }
}
