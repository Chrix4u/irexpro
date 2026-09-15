import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AuditService } from '../audit/audit.service';
import { EligibilityService } from './eligibility.service';
import { TradingAuthorityService } from '../execution-authority/trading-authority.service';
import { GrantInvalidationService } from '../execution-authority/grant-invalidation.service';
import {
  EligibilityDisclosureKey,
  UserDisclosureConsent,
} from './entities/user-disclosure-consent.entity';
import {
  EligibilityReviewDecision,
  UserEligibilityReview,
} from './entities/user-eligibility-review.entity';
import { KycReviewDecision, UserKycReview } from './entities/user-kyc-review.entity';
import { KycStatus } from './entities/user-profile.entity';
import { User, UserStatus } from './entities/user.entity';

describe('EligibilityService', () => {
  let service: EligibilityService;
  let module: TestingModule;
  let consentRows: UserDisclosureConsent[];
  let reviewRows: UserEligibilityReview[];
  let kycReviewRows: UserKycReview[];
  let config: Record<string, string>;

  const user = {
    id: 'user-1',
    email: 'trader@example.com',
    countryCode: 'GH',
    status: UserStatus.ACTIVE,
    createdAt: new Date('2026-08-31T00:00:00Z'),
    profile: {
      userId: 'user-1',
      dateOfBirth: '1990-01-01',
      kycStatus: KycStatus.APPROVED,
      kycSubmittedAt: new Date('2026-08-30T00:00:00Z'),
      kycApprovedAt: new Date('2026-08-31T00:00:00Z'),
    },
  } as User;

  const userRepo = {
    findOne: jest.fn(),
    find: jest.fn(),
    save: jest.fn(async (value) => value),
    // Round 6 (#2): reviewKyc commits the KYC fact + authority bump inside
    // userRepo.manager.transaction — the mock EM delegates back to this repo.
    manager: {
      transaction: jest.fn(async (cb: (em: unknown) => Promise<unknown>) =>
        cb({ getRepository: () => userRepo }),
      ),
    },
  };
  const consentRepo = {
    find: jest.fn(),
    findOne: jest.fn(),
    create: jest.fn((value) => value),
    save: jest.fn(),
  };
  const reviewRepo = {
    findOne: jest.fn(),
    create: jest.fn((value) => value),
    save: jest.fn(),
    // Round 6 (#2): reviewUser commits the jurisdiction fact + authority bump
    // inside reviewRepo.manager.transaction — the mock EM delegates back.
    manager: {
      transaction: jest.fn(async (cb: (em: unknown) => Promise<unknown>) =>
        cb({ getRepository: () => reviewRepo }),
      ),
    },
  };
  const kycReviewRepo = {
    findOne: jest.fn(),
    create: jest.fn((value) => value),
    save: jest.fn(),
  };
  const configService = {
    get: jest.fn((key: string) => config[key]),
  };
  const auditService = { log: jest.fn().mockResolvedValue(undefined) };

  beforeEach(async () => {
    jest.clearAllMocks();
    consentRows = [];
    reviewRows = [];
    kycReviewRows = [
      {
        id: 'kyc-review-seed',
        userId: user.id,
        dateOfBirth: '1990-01-01',
        decision: KycReviewDecision.APPROVED,
        reasonCode: 'MANUAL_IDENTITY_VERIFIED',
        reviewerUserId: 'admin-seed',
        reviewerNote: null,
        createdAt: new Date('2026-08-31T00:30:00Z'),
      } as UserKycReview,
    ];
    config = {
      ELIGIBILITY_POLICY_VERSION: 'eligibility.2026-08',
      ELIGIBILITY_ALLOWED_COUNTRY_CODES: 'GH,GB',
      ELIGIBILITY_BLOCKED_COUNTRY_CODES: 'XX',
      ELIGIBILITY_REVIEW_COUNTRY_CODES: 'NG',
    };

    userRepo.findOne.mockResolvedValue(user);
    userRepo.find.mockResolvedValue([user]);
    consentRepo.find.mockImplementation(async () => [...consentRows]);
    consentRepo.findOne.mockImplementation(
      async ({ where }) =>
        consentRows.find(
          (row) =>
            row.userId === where.userId &&
            row.policyVersion === where.policyVersion &&
            row.policyFingerprint === where.policyFingerprint &&
            row.disclosureKey === where.disclosureKey &&
            row.disclosureVersion === where.disclosureVersion &&
            row.contentSha256 === where.contentSha256,
        ) ?? null,
    );
    consentRepo.save.mockImplementation(async (row) => {
      const saved = {
        ...row,
        id: `consent-${consentRows.length + 1}`,
        acceptedAt: row.acceptedAt ?? new Date('2026-08-31T01:00:00Z'),
        createdAt: new Date('2026-08-31T01:00:00Z'),
      } as UserDisclosureConsent;
      consentRows.push(saved);
      return saved;
    });
    reviewRepo.findOne.mockImplementation(async ({ where }) => {
      const matches = reviewRows.filter(
        (row) =>
          row.userId === where.userId &&
          row.countryCode === where.countryCode &&
          row.policyVersion === where.policyVersion &&
          row.policyFingerprint === where.policyFingerprint,
      );
      return matches.at(-1) ?? null;
    });
    reviewRepo.save.mockImplementation(async (row) => {
      const saved = {
        ...row,
        id: `review-${reviewRows.length + 1}`,
        createdAt: new Date(`2026-08-31T0${reviewRows.length + 1}:30:00Z`),
      } as UserEligibilityReview;
      reviewRows.push(saved);
      return saved;
    });
    kycReviewRepo.findOne.mockImplementation(async ({ where }) => {
      const matches = kycReviewRows.filter(
        (row) => row.userId === where.userId && row.dateOfBirth === where.dateOfBirth,
      );
      return matches.at(-1) ?? null;
    });
    kycReviewRepo.save.mockImplementation(async (row) => {
      const saved = {
        ...row,
        id: `kyc-review-${kycReviewRows.length + 1}`,
        createdAt: new Date(`2026-08-31T1${kycReviewRows.length}:30:00Z`),
      } as UserKycReview;
      kycReviewRows.push(saved);
      return saved;
    });

    module = await Test.createTestingModule({
      providers: [
        EligibilityService,
        { provide: getRepositoryToken(User), useValue: userRepo },
        { provide: getRepositoryToken(UserDisclosureConsent), useValue: consentRepo },
        { provide: getRepositoryToken(UserEligibilityReview), useValue: reviewRepo },
        { provide: getRepositoryToken(UserKycReview), useValue: kycReviewRepo },
        { provide: ConfigService, useValue: configService },
        { provide: AuditService, useValue: auditService },
        // Round 6 (#300): the unified execution-authority seams (mocked —
        // the bump matrices live in the execution-authority suites).
        {
          provide: TradingAuthorityService,
          useValue: {
            bumpGeneration: jest.fn().mockResolvedValue(2),
            getCurrentGeneration: jest.fn().mockResolvedValue(1),
          },
        },
        {
          provide: GrantInvalidationService,
          useValue: {
            invalidateUserNewExposureAuthority: jest
              .fn()
              .mockResolvedValue({ invalidatedGrants: 0, revokedConfirmations: 0 }),
          },
        },
      ],
    }).compile();

    service = module.get(EligibilityService);
  });

  afterEach(async () => module.close());

  function acceptanceRequest(status: Awaited<ReturnType<EligibilityService['getStatus']>>) {
    return {
      policyVersion: status.policyVersion,
      policyFingerprint: status.policyFingerprint,
      acceptances: status.disclosures.map((item) => ({
        key: item.key,
        version: item.version,
        contentSha256: item.contentSha256,
      })),
    };
  }

  function reviewRequest(
    status: Awaited<ReturnType<EligibilityService['getStatus']>>,
    decision: EligibilityReviewDecision,
    reasonCode: string,
  ) {
    return {
      policyVersion: status.policyVersion,
      policyFingerprint: status.policyFingerprint,
      decision,
      reasonCode,
    };
  }

  it('allows a policy-allowed adult with approved KYC only after every exact disclosure is accepted', async () => {
    const initial = await service.getStatus(user.id);

    expect(initial.jurisdictionStatus).toBe('ELIGIBLE');
    expect(initial.ageStatus).toBe('ADULT');
    expect(initial.kycStatus).toBe('APPROVED');
    expect(initial.identityReasonCode).toBe('IDENTITY_APPROVED');
    expect(initial.policyFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(initial.disclosures).toHaveLength(4);
    expect(initial.missingConsentKeys).toEqual([
      EligibilityDisclosureKey.AUTOMATED_TRADING_RISK,
      EligibilityDisclosureKey.NO_PROFIT_GUARANTEE,
      EligibilityDisclosureKey.BROKER_EXECUTION_AUTHORITY,
      EligibilityDisclosureKey.LEGAL_ELIGIBILITY_ATTESTATION,
    ]);
    expect(initial.canProceed).toBe(false);

    const accepted = await service.acceptDisclosures(user.id, acceptanceRequest(initial));

    expect(accepted.missingConsentKeys).toEqual([]);
    expect(accepted.consents).toHaveLength(4);
    expect(
      accepted.consents.every((item) => item.policyFingerprint === initial.policyFingerprint),
    ).toBe(true);
    expect(accepted.canProceed).toBe(true);
    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'ELIGIBILITY_DISCLOSURES_ACCEPTED',
        metadata: expect.objectContaining({
          policyVersion: initial.policyVersion,
          policyFingerprint: initial.policyFingerprint,
        }),
      }),
    );
  });

  it('normalizes policy inputs before fingerprinting', async () => {
    const first = await service.getStatus(user.id);
    config.ELIGIBILITY_ALLOWED_COUNTRY_CODES = ' gb , GH,GH ';
    config.ELIGIBILITY_BLOCKED_COUNTRY_CODES = 'xx';
    config.ELIGIBILITY_REVIEW_COUNTRY_CODES = ' ng ';

    const second = await service.getStatus(user.id);

    expect(second.policyFingerprint).toBe(first.policyFingerprint);
  });

  it('invalidates consent when policy configuration changes without a version bump', async () => {
    const initial = await service.getStatus(user.id);
    const accepted = await service.acceptDisclosures(user.id, acceptanceRequest(initial));
    expect(accepted.canProceed).toBe(true);

    config.ELIGIBILITY_ALLOWED_COUNTRY_CODES = 'GH,GB,CA';
    const changed = await service.getStatus(user.id);

    expect(changed.policyVersion).toBe(initial.policyVersion);
    expect(changed.policyFingerprint).not.toBe(initial.policyFingerprint);
    expect(changed.missingConsentKeys).toHaveLength(4);
    expect(changed.consents).toEqual([]);
    expect(changed.canProceed).toBe(false);
  });

  it('rejects a stale consent submission when policy configuration changes after rendering', async () => {
    const rendered = await service.getStatus(user.id);
    config.ELIGIBILITY_REVIEW_COUNTRY_CODES = 'NG,ZA';

    await expect(service.acceptDisclosures(user.id, acceptanceRequest(rendered))).rejects.toThrow(
      /policy changed/i,
    );
    expect(consentRows).toHaveLength(0);
  });

  it('requires an explicit 18+ age and legal eligibility attestation', async () => {
    const status = await service.getStatus(user.id);
    const attestation = status.disclosures.find(
      (item) => item.key === EligibilityDisclosureKey.LEGAL_ELIGIBILITY_ATTESTATION,
    );

    expect(attestation).toBeDefined();
    expect(attestation?.title).toMatch(/age and legal eligibility/i);
    expect(attestation?.body).toMatch(/at least 18 years old/i);
    expect(attestation?.body).toMatch(/legally permitted/i);
  });

  it('fails closed when DOB is missing even if jurisdiction and KYC state are otherwise acceptable', async () => {
    userRepo.findOne.mockResolvedValue({
      ...user,
      profile: { ...user.profile, dateOfBirth: null },
    });

    const status = await service.getStatus(user.id);

    expect(status.ageStatus).toBe('MISSING_DOB');
    expect(status.identityReasonCode).toBe('DOB_REQUIRED');
    expect(status.canProceed).toBe(false);
  });

  it('does not trust a mutable APPROVED flag without immutable evidence for the current DOB', async () => {
    kycReviewRows = [
      {
        ...kycReviewRows[0],
        dateOfBirth: '1980-01-01',
      },
    ];

    const status = await service.getStatus(user.id);

    expect(user.profile.kycStatus).toBe(KycStatus.APPROVED);
    expect(status.kycStatus).toBe(KycStatus.NONE);
    expect(status.identityReasonCode).toBe('KYC_REQUIRED');
    expect(status.canProceed).toBe(false);
  });

  it('fails closed for an under-18 profile and refuses KYC approval', async () => {
    const year = new Date().getUTCFullYear() - 10;
    const underage = {
      ...user,
      profile: {
        ...user.profile,
        dateOfBirth: `${year}-01-01`,
        kycStatus: KycStatus.NONE,
        kycSubmittedAt: null,
        kycApprovedAt: null,
      },
    } as User;
    userRepo.findOne.mockResolvedValue(underage);

    const status = await service.getStatus(user.id);
    expect(status.ageStatus).toBe('UNDER_18');
    expect(status.identityReasonCode).toBe('AGE_REQUIREMENT_NOT_MET');
    expect(status.canProceed).toBe(false);

    await expect(
      service.reviewKyc(user.id, 'admin-1', {
        decision: KycReviewDecision.APPROVED,
        reasonCode: 'MANUAL_IDENTITY_VERIFIED',
      }),
    ).rejects.toThrow(/adult-age requirement/i);
    expect(kycReviewRepo.save).not.toHaveBeenCalled();
  });

  it('queues adult users without current approval evidence and records immutable approval evidence', async () => {
    const awaiting = {
      ...user,
      id: 'awaiting-kyc',
      profile: {
        ...user.profile,
        userId: 'awaiting-kyc',
        dateOfBirth: '1992-05-15',
        kycStatus: KycStatus.NONE,
        kycSubmittedAt: null,
        kycApprovedAt: null,
      },
    } as User;
    const pending = {
      ...user,
      id: 'pending-kyc',
      profile: {
        ...user.profile,
        userId: 'pending-kyc',
        dateOfBirth: '1988-09-10',
        kycStatus: KycStatus.PENDING,
      },
    } as User;
    const legacyApprovedWithoutEvidence = {
      ...user,
      id: 'approved-kyc',
      profile: { ...user.profile, userId: 'approved-kyc' },
    } as User;
    userRepo.find.mockResolvedValue([awaiting, pending, legacyApprovedWithoutEvidence]);

    const queue = await service.listKycReviewQueue();
    expect(queue.map((item) => item.userId)).toEqual([
      'awaiting-kyc',
      'pending-kyc',
      'approved-kyc',
    ]);
    expect(queue.at(-1)).toEqual(
      expect.objectContaining({
        userId: 'approved-kyc',
        kycStatus: KycStatus.NONE,
        reasonCode: 'KYC_REQUIRED',
      }),
    );
    expect(JSON.stringify(queue)).not.toMatch(/passwordHash|reviewerNote|brokerConnectionId/);

    userRepo.findOne.mockResolvedValue(awaiting);
    const reviewed = await service.reviewKyc(awaiting.id, 'admin-1', {
      decision: KycReviewDecision.APPROVED,
      reasonCode: 'manual identity verified',
      reviewerNote: 'Verified through the approved compliance process.',
    });

    const recorded = kycReviewRows.find((row) => row.userId === awaiting.id);
    expect(recorded).toEqual(
      expect.objectContaining({
        userId: awaiting.id,
        dateOfBirth: '1992-05-15',
        decision: KycReviewDecision.APPROVED,
        reasonCode: 'MANUAL IDENTITY VERIFIED',
      }),
    );
    expect(awaiting.profile.kycStatus).toBe(KycStatus.APPROVED);
    expect(reviewed.ageStatus).toBe('ADULT');
    expect(reviewed.kycStatus).toBe('APPROVED');
    expect(reviewed.identityReasonCode).toBe('IDENTITY_APPROVED');
  });

  it('rejects a stale, modified, or fabricated disclosure hash', async () => {
    const status = await service.getStatus(user.id);
    const disclosure = status.disclosures[0];

    await expect(
      service.acceptDisclosures(user.id, {
        policyVersion: status.policyVersion,
        policyFingerprint: status.policyFingerprint,
        acceptances: [
          {
            key: disclosure.key,
            version: disclosure.version,
            contentSha256: '0'.repeat(64),
          },
        ],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(consentRows).toHaveLength(0);
  });

  it('rejects duplicate keys inside one consent submission', async () => {
    const status = await service.getStatus(user.id);
    const disclosure = status.disclosures[0];
    const acceptance = {
      key: disclosure.key,
      version: disclosure.version,
      contentSha256: disclosure.contentSha256,
    };

    await expect(
      service.acceptDisclosures(user.id, {
        policyVersion: status.policyVersion,
        policyFingerprint: status.policyFingerprint,
        acceptances: [acceptance, acceptance],
      }),
    ).rejects.toThrow(/Duplicate disclosure acceptance/);
  });

  it('is idempotent for already-recorded exact consent evidence', async () => {
    const status = await service.getStatus(user.id);
    const disclosure = status.disclosures[0];
    const dto = {
      policyVersion: status.policyVersion,
      policyFingerprint: status.policyFingerprint,
      acceptances: [
        {
          key: disclosure.key,
          version: disclosure.version,
          contentSha256: disclosure.contentSha256,
        },
      ],
    };

    await service.acceptDisclosures(user.id, dto);
    await service.acceptDisclosures(user.id, dto);

    expect(consentRows).toHaveLength(1);
  });

  it('fails closed for an unclassified jurisdiction', async () => {
    userRepo.findOne.mockResolvedValue({ ...user, countryCode: 'ZZ' });

    const status = await service.getStatus(user.id);

    expect(status.jurisdictionStatus).toBe('REVIEW_REQUIRED');
    expect(status.reasonCode).toBe('UNCLASSIFIED_JURISDICTION');
    expect(status.canProceed).toBe(false);
  });

  it('fails closed when country information is missing', async () => {
    userRepo.findOne.mockResolvedValue({ ...user, countryCode: null });

    const status = await service.getStatus(user.id);

    expect(status.jurisdictionStatus).toBe('MISSING_PROFILE');
    expect(status.reasonCode).toBe('COUNTRY_REQUIRED');
    expect(status.canProceed).toBe(false);
  });

  it('never permits an admin review to override an explicitly blocked jurisdiction', async () => {
    userRepo.findOne.mockResolvedValue({ ...user, countryCode: 'XX' });
    const status = await service.getStatus(user.id);

    await expect(
      service.reviewUser(
        user.id,
        'admin-1',
        reviewRequest(status, EligibilityReviewDecision.APPROVED, 'OVERRIDE_ATTEMPT'),
      ),
    ).rejects.toThrow(/cannot be overridden/);

    expect(reviewRows).toHaveLength(0);
  });

  it('does not create redundant review evidence for policy-allowed countries', async () => {
    const status = await service.getStatus(user.id);

    await expect(
      service.reviewUser(
        user.id,
        'admin-1',
        reviewRequest(status, EligibilityReviewDecision.APPROVED, 'NOT_NEEDED'),
      ),
    ).rejects.toThrow(/already allowed/);
  });

  it('rejects a stale jurisdiction review when policy changes after the queue snapshot was rendered', async () => {
    userRepo.findOne.mockResolvedValue({ ...user, countryCode: 'NG' });
    const rendered = await service.getStatus(user.id);
    config.ELIGIBILITY_REVIEW_COUNTRY_CODES = 'NG,ZA';

    await expect(
      service.reviewUser(
        user.id,
        'admin-1',
        reviewRequest(rendered, EligibilityReviewDecision.APPROVED, 'REVIEW_APPROVED'),
      ),
    ).rejects.toThrow(/policy changed/i);
    expect(reviewRows).toHaveLength(0);
  });

  it('applies the latest matching immutable admin review only to the exact policy fingerprint', async () => {
    userRepo.findOne.mockResolvedValue({ ...user, countryCode: 'NG' });
    const reviewContext = await service.getStatus(user.id);

    await service.reviewUser(
      user.id,
      'admin-1',
      reviewRequest(reviewContext, EligibilityReviewDecision.DENIED, 'REVIEW_DENIED'),
    );
    expect((await service.getStatus(user.id)).jurisdictionStatus).toBe('INELIGIBLE');

    await service.reviewUser(
      user.id,
      'admin-2',
      reviewRequest(reviewContext, EligibilityReviewDecision.APPROVED, 'REVIEW_APPROVED'),
    );
    const approved = await service.getStatus(user.id);
    expect(approved.jurisdictionStatus).toBe('ELIGIBLE');
    expect(approved.decisionSource).toBe('ADMIN_REVIEW');
    expect(approved.reasonCode).toBe('REVIEW_APPROVED');
    expect(reviewRows.at(-1)?.policyFingerprint).toBe(approved.policyFingerprint);

    config.ELIGIBILITY_REVIEW_COUNTRY_CODES = 'NG,ZA';
    const afterSameVersionPolicyChange = await service.getStatus(user.id);
    expect(afterSameVersionPolicyChange.policyVersion).toBe(approved.policyVersion);
    expect(afterSameVersionPolicyChange.policyFingerprint).not.toBe(approved.policyFingerprint);
    expect(afterSameVersionPolicyChange.jurisdictionStatus).toBe('REVIEW_REQUIRED');
    expect(afterSameVersionPolicyChange.decisionSource).toBe('POLICY');

    config.ELIGIBILITY_POLICY_VERSION = 'eligibility.2026-09';
    const afterPolicyVersionChange = await service.getStatus(user.id);
    expect(afterPolicyVersionChange.jurisdictionStatus).toBe('REVIEW_REQUIRED');
    expect(afterPolicyVersionChange.decisionSource).toBe('POLICY');
  });

  it('queues only active users whose current jurisdiction requires review', async () => {
    const allowed = { ...user, id: 'allowed', countryCode: 'GH' };
    const review = { ...user, id: 'review', countryCode: 'NG' };
    const unknown = { ...user, id: 'unknown', countryCode: 'ZZ' };
    const suspended = {
      ...user,
      id: 'suspended',
      countryCode: 'NG',
      status: UserStatus.SUSPENDED,
    };
    userRepo.find.mockResolvedValue([allowed, review, unknown, suspended]);

    const queue = await service.listReviewQueue();

    expect(queue.map((item) => item.userId)).toEqual(['review', 'unknown']);
    expect(queue.every((item) => /^[a-f0-9]{64}$/.test(item.policyFingerprint))).toBe(true);
    expect(JSON.stringify(queue)).not.toMatch(/passwordHash|brokerConnectionId|providerAccountId/);
  });
});
