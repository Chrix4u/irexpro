import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AuditService } from '../audit/audit.service';
import { BrokerConnection } from '../broker/entities/broker-connection.entity';
import { BrokerConnectionStatus } from '../broker/interfaces/broker-adapter.interface';
import { RiskProfile } from '../risk/entities/risk-profile.entity';
import { EligibilityService } from './eligibility.service';
import { BrokerConnection as BrokerConnectionEntity } from '../broker/entities/broker-connection.entity';
import { UserProfile, TradingExperienceLevel } from './entities/user-profile.entity';
import { User, UserStatus } from './entities/user.entity';
import { OnboardingService } from './onboarding.service';

describe('OnboardingService readiness gate', () => {
  let service: OnboardingService;
  let module: TestingModule;

  const mockUserRepo = { findOne: jest.fn() };
  const mockProfileRepo = { findOne: jest.fn() };
  const mockRiskProfileRepo = { findOne: jest.fn() };
  const mockBrokerQb = {
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getOne: jest.fn(),
  };
  const mockBrokerConnectionRepo = {
    createQueryBuilder: jest.fn().mockReturnValue(mockBrokerQb),
  };
  const mockAuditService = { log: jest.fn().mockResolvedValue(undefined) };
  const eligibleStatus = {
    policyVersion: 'eligibility.v1',
    countryCode: 'GH',
    jurisdictionStatus: 'ELIGIBLE' as const,
    decisionSource: 'POLICY' as const,
    reasonCode: 'POLICY_ALLOWED',
    reviewedAt: null,
    ageStatus: 'ADULT' as const,
    kycStatus: 'APPROVED' as const,
    identityReasonCode: 'KYC_APPROVED',
    disclosures: [],
    consents: [],
    missingConsentKeys: [],
    canProceed: true,
  };
  const mockEligibilityService = {
    getStatus: jest.fn().mockResolvedValue(eligibleStatus),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockBrokerQb.select.mockReturnThis();
    mockBrokerQb.where.mockReturnThis();
    mockBrokerQb.andWhere.mockReturnThis();
    mockBrokerQb.getOne.mockResolvedValue(null);
    mockBrokerConnectionRepo.createQueryBuilder.mockReturnValue(mockBrokerQb);
    mockEligibilityService.getStatus.mockResolvedValue(eligibleStatus);

    module = await Test.createTestingModule({
      providers: [
        OnboardingService,
        { provide: getRepositoryToken(User), useValue: mockUserRepo },
        { provide: getRepositoryToken(UserProfile), useValue: mockProfileRepo },
        { provide: getRepositoryToken(RiskProfile), useValue: mockRiskProfileRepo },
        { provide: getRepositoryToken(BrokerConnection), useValue: mockBrokerConnectionRepo },
        { provide: AuditService, useValue: mockAuditService },
        { provide: EligibilityService, useValue: mockEligibilityService },
      ],
    }).compile();

    service = module.get(OnboardingService);
  });

  afterEach(async () => module.close());

  function completeUser(): User {
    return {
      id: 'user-complete',
      email: 'complete@example.com',
      phone: null,
      passwordHash: 'hash',
      status: UserStatus.ACTIVE,
      emailVerifiedAt: null,
      phoneVerifiedAt: null,
      lastLoginAt: null,
      countryCode: 'GH',
      timezone: 'Africa/Accra',
      preferredCurrency: 'USD',
      mfaEnabled: false,
      mfaSecret: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
      profile: {
        id: 'profile-1',
        userId: 'user-complete',
        firstName: 'John',
        lastName: 'Doe',
        displayName: null,
        dateOfBirth: '1990-01-01',
        addressLine1: null,
        addressLine2: null,
        addressCity: null,
        addressState: null,
        addressPostalCode: null,
        addressCountry: null,
        kycStatus: 'NONE' as never,
        kycSubmittedAt: null,
        kycApprovedAt: null,
        riskDisclosureAccepted: false,
        riskDisclosureAcceptedAt: null,
        tradingExperienceLevel: TradingExperienceLevel.INTERMEDIATE,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as unknown as UserProfile,
      userRoles: [],
    } as unknown as User;
  }

  function completeRisk(): RiskProfile {
    return {
      id: 'risk-1',
      userId: 'user-complete',
      killSwitchActive: false,
      killSwitchReason: null,
      maxDailyLossPercent: '5.00',
      maxDrawdownPercent: '10.00',
      maxOpenTrades: 3,
      maxDailyTrades: 10,
      maxPositionSizeLot: '0.1000',
      minStopLossPips: '5.00',
      allowedInstruments: null,
      maxVolatilityScore: '0.85',
      rejectLowLiquidity: true,
      riskAcknowledgementAccepted: true,
      riskAcknowledgementAcceptedAt: new Date(),
      maxTradeRiskPercent: '2.00',
      maxLeverageAllowed: 30,
      allowedTradingModes: 'PAPER_ONLY' as never,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as unknown as RiskProfile;
  }

  function connectedBroker(): Partial<BrokerConnectionEntity> {
    return {
      id: 'broker-1',
      status: BrokerConnectionStatus.CONNECTED,
      liveTradingEnabled: false,
    };
  }

  it('returns all four steps incomplete for a new user', async () => {
    mockUserRepo.findOne.mockResolvedValue({
      id: 'new-user',
      status: UserStatus.ACTIVE,
      countryCode: null,
      timezone: null,
      preferredCurrency: null,
      profile: { firstName: null, lastName: null, tradingExperienceLevel: null },
    });
    mockEligibilityService.getStatus.mockResolvedValue({
      ...eligibleStatus,
      countryCode: null,
      jurisdictionStatus: 'MISSING_PROFILE',
      reasonCode: 'COUNTRY_REQUIRED',
      canProceed: false,
    });
    mockRiskProfileRepo.findOne.mockResolvedValue(null);

    const status = await service.getOnboardingStatus('new-user');

    expect(status.profileCompleted).toBe(false);
    expect(status.eligibilityCompleted).toBe(false);
    expect(status.canStartTrading).toBe(false);
    expect(status.missingSteps).toEqual([
      'PROFILE',
      'ELIGIBILITY',
      'RISK_PROFILE',
      'BROKER_CONNECTION',
    ]);
    expect(status.nextStep).toBe('PROFILE');
  });

  it('fails closed when eligibility review or current disclosure evidence is incomplete', async () => {
    mockUserRepo.findOne.mockResolvedValue(completeUser());
    mockEligibilityService.getStatus.mockResolvedValue({
      ...eligibleStatus,
      jurisdictionStatus: 'REVIEW_REQUIRED',
      reasonCode: 'UNCLASSIFIED_JURISDICTION',
      canProceed: false,
    });
    mockRiskProfileRepo.findOne.mockResolvedValue(completeRisk());
    mockBrokerQb.getOne.mockResolvedValue(connectedBroker());

    const status = await service.getOnboardingStatus('user-complete');

    expect(status.profileCompleted).toBe(true);
    expect(status.eligibilityCompleted).toBe(false);
    expect(status.riskProfileCompleted).toBe(true);
    expect(status.brokerConnected).toBe(true);
    expect(status.canStartTrading).toBe(false);
    expect(status.missingSteps).toEqual(['ELIGIBILITY']);
    expect(status.nextStep).toBe('ELIGIBILITY');
  });

  it('allows readiness only when profile, eligibility, risk, broker and kill switch gates pass', async () => {
    mockUserRepo.findOne.mockResolvedValue(completeUser());
    mockRiskProfileRepo.findOne.mockResolvedValue(completeRisk());
    mockBrokerQb.getOne.mockResolvedValue(connectedBroker());

    const status = await service.getOnboardingStatus('user-complete');

    expect(status).toEqual(
      expect.objectContaining({
        profileCompleted: true,
        eligibilityCompleted: true,
        riskProfileCompleted: true,
        brokerConnected: true,
        canStartTrading: true,
        missingSteps: [],
        nextStep: 'READY',
      }),
    );
    expect(mockAuditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: 'user-complete',
        action: 'TRADING_READINESS_CHECKED',
        metadata: expect.objectContaining({
          canStartTrading: true,
          eligibilityPolicyVersion: 'eligibility.v1',
        }),
      }),
    );
  });

  it('blocks readiness when the risk acknowledgement is missing', async () => {
    const risk = completeRisk();
    risk.riskAcknowledgementAccepted = false;
    mockUserRepo.findOne.mockResolvedValue(completeUser());
    mockRiskProfileRepo.findOne.mockResolvedValue(risk);
    mockBrokerQb.getOne.mockResolvedValue(connectedBroker());

    const status = await service.getOnboardingStatus('user-complete');

    expect(status.canStartTrading).toBe(false);
    expect(status.missingSteps).toEqual(['RISK_PROFILE']);
  });

  it('blocks readiness when the broker is unavailable', async () => {
    mockUserRepo.findOne.mockResolvedValue(completeUser());
    mockRiskProfileRepo.findOne.mockResolvedValue(completeRisk());
    mockBrokerQb.getOne.mockResolvedValue(null);

    const status = await service.getOnboardingStatus('user-complete');

    expect(status.brokerConnectionStatus).toBe('NONE');
    expect(status.canStartTrading).toBe(false);
    expect(status.missingSteps).toEqual(['BROKER_CONNECTION']);
  });

  it('fails closed without throwing when broker lookup fails', async () => {
    mockUserRepo.findOne.mockResolvedValue(completeUser());
    mockRiskProfileRepo.findOne.mockResolvedValue(completeRisk());
    mockBrokerQb.getOne.mockRejectedValue(new Error('database unavailable'));

    const status = await service.getOnboardingStatus('user-complete');

    expect(status.brokerConnected).toBe(false);
    expect(status.brokerConnectionStatus).toBe('NONE');
    expect(status.canStartTrading).toBe(false);
  });

  it('blocks readiness when the kill switch is active even with no missing onboarding steps', async () => {
    const risk = completeRisk();
    risk.killSwitchActive = true;
    mockUserRepo.findOne.mockResolvedValue(completeUser());
    mockRiskProfileRepo.findOne.mockResolvedValue(risk);
    mockBrokerQb.getOne.mockResolvedValue(connectedBroker());

    const status = await service.getOnboardingStatus('user-complete');

    expect(status.missingSteps).toEqual([]);
    expect(status.canStartTrading).toBe(false);
    expect(status.nextStep).toBe('READY');
  });

  it('blocks readiness for a suspended account', async () => {
    const user = completeUser();
    user.status = UserStatus.SUSPENDED;
    mockUserRepo.findOne.mockResolvedValue(user);
    mockRiskProfileRepo.findOne.mockResolvedValue(completeRisk());
    mockBrokerQb.getOne.mockResolvedValue(connectedBroker());

    expect((await service.getOnboardingStatus('user-complete')).canStartTrading).toBe(false);
  });

  it('selects only broker readiness fields and never credential/provider account fields', async () => {
    mockUserRepo.findOne.mockResolvedValue(completeUser());
    mockRiskProfileRepo.findOne.mockResolvedValue(completeRisk());
    mockBrokerQb.getOne.mockResolvedValue(connectedBroker());

    const status = await service.getOnboardingStatus('user-complete');
    const selectCall = mockBrokerQb.select.mock.calls[0][0];

    expect(selectCall).toEqual([
      'conn.id',
      'conn.status',
      'conn.lastHealthCheckAt',
      'conn.consecutiveFailureCount',
      'conn.liveTradingEnabled',
      // Round 6 live-execution completion (§1d): the credential STATUS enum
      // (never the credential material) feeds the CREDENTIALS_INVALID
      // blockedReason code.
      'conn.credentialStatus',
    ]);
    expect(JSON.stringify(status)).not.toMatch(
      /encryptedCredentials|credentialIv|credentialTag|providerAccountId|apiSecret/,
    );
  });

  it('returns a fully fail-closed status when the user no longer exists', async () => {
    mockUserRepo.findOne.mockResolvedValue(null);

    const status = await service.getOnboardingStatus('missing-user');

    expect(status.eligibilityCompleted).toBe(false);
    expect(status.canStartTrading).toBe(false);
    expect(status.missingSteps).toEqual([
      'PROFILE',
      'ELIGIBILITY',
      'RISK_PROFILE',
      'BROKER_CONNECTION',
    ]);
    expect(mockEligibilityService.getStatus).not.toHaveBeenCalled();
  });

  it('canStartTrading returns the same centralized eligibility boundary', async () => {
    mockUserRepo.findOne.mockResolvedValue(completeUser());
    mockRiskProfileRepo.findOne.mockResolvedValue(completeRisk());
    mockBrokerQb.getOne.mockResolvedValue(connectedBroker());
    mockEligibilityService.getStatus.mockResolvedValue({
      ...eligibleStatus,
      missingConsentKeys: ['NO_PROFIT_GUARANTEE'],
      canProceed: false,
    });

    const result = await service.canStartTrading('user-complete');

    expect(result).toEqual({ allowed: false, missingSteps: ['ELIGIBILITY'] });
  });

  // ─── Round 6 live-execution completion (§26/§1d): stable blockedReasons ───

  it('§1d: returns machine-readable blockedReasons for EVERY blocker (kyc + jurisdiction + age + disclosure)', async () => {
    mockUserRepo.findOne.mockResolvedValue(completeUser());
    mockRiskProfileRepo.findOne.mockResolvedValue(completeRisk());
    mockBrokerQb.getOne.mockResolvedValue(connectedBroker());
    mockEligibilityService.getStatus.mockResolvedValue({
      ...eligibleStatus,
      jurisdictionStatus: 'INELIGIBLE' as never,
      ageStatus: 'UNKNOWN' as never,
      kycStatus: 'REJECTED' as never,
      canProceed: false,
    });

    const status = await service.getOnboardingStatus('user-complete');

    expect(status.canStartTrading).toBe(false);
    expect(status.blockedReasons).toEqual(
      expect.arrayContaining(['JURISDICTION_INELIGIBLE', 'AGE_NOT_ADULT', 'KYC_REJECTED']),
    );
  });

  it('§1d: KYC_REQUIRED when KYC is not submitted/pending', async () => {
    mockUserRepo.findOne.mockResolvedValue(completeUser());
    mockRiskProfileRepo.findOne.mockResolvedValue(completeRisk());
    mockBrokerQb.getOne.mockResolvedValue(connectedBroker());
    mockEligibilityService.getStatus.mockResolvedValue({
      ...eligibleStatus,
      kycStatus: 'PENDING' as never,
      canProceed: false,
    });

    const status = await service.getOnboardingStatus('user-complete');
    expect(status.blockedReasons).toContain('KYC_REQUIRED');
    expect(status.blockedReasons).not.toContain('KYC_REJECTED');
  });

  it('§1d: DISCLOSURE_OUTSTANDING maps from missing consent keys', async () => {
    mockUserRepo.findOne.mockResolvedValue(completeUser());
    mockRiskProfileRepo.findOne.mockResolvedValue(completeRisk());
    mockBrokerQb.getOne.mockResolvedValue(connectedBroker());
    mockEligibilityService.getStatus.mockResolvedValue({
      ...eligibleStatus,
      missingConsentKeys: ['NO_PROFIT_GUARANTEE'],
      canProceed: false,
    });

    const status = await service.getOnboardingStatus('user-complete');
    expect(status.blockedReasons).toContain('DISCLOSURE_OUTSTANDING');
  });

  it('§1d: user-status blockers map to stable account codes', async () => {
    for (const [status, code] of [
      ['SUSPENDED', 'ACCOUNT_SUSPENDED'],
      ['PERMANENTLY_LOCKED', 'ACCOUNT_LOCKED'],
      ['CLOSED', 'ACCOUNT_CLOSED'],
      ['PENDING_VERIFICATION', 'ACCOUNT_PENDING_VERIFICATION'],
    ] as const) {
      mockUserRepo.findOne.mockResolvedValue({ ...completeUser(), status });
      mockRiskProfileRepo.findOne.mockResolvedValue(completeRisk());
      mockBrokerQb.getOne.mockResolvedValue(connectedBroker());
      mockEligibilityService.getStatus.mockResolvedValue(eligibleStatus);

      const result = await service.getOnboardingStatus('user-complete');
      expect(result.blockedReasons).toContain(code);
      expect(result.canStartTrading).toBe(false);
    }
  });

  it('§1d: risk/broker blockers — RISK_ACK_REQUIRED, RISK_PROFILE_MISSING, BROKER_DISCONNECTED, CREDENTIALS_INVALID, KILL_SWITCH_ACTIVE', async () => {
    // No risk profile at all
    mockUserRepo.findOne.mockResolvedValue(completeUser());
    mockRiskProfileRepo.findOne.mockResolvedValue(null);
    mockBrokerQb.getOne.mockResolvedValue(null);
    mockEligibilityService.getStatus.mockResolvedValue(eligibleStatus);

    let status = await service.getOnboardingStatus('user-complete');
    expect(status.blockedReasons).toEqual(
      expect.arrayContaining(['RISK_PROFILE_MISSING', 'BROKER_DISCONNECTED']),
    );

    // Risk profile without acknowledgement + connected broker with INVALID creds
    mockRiskProfileRepo.findOne.mockResolvedValue({
      ...completeRisk(),
      riskAcknowledgementAccepted: false,
    });
    mockBrokerQb.getOne.mockResolvedValue({ ...connectedBroker(), credentialStatus: 'INVALID' });
    status = await service.getOnboardingStatus('user-complete');
    expect(status.blockedReasons).toEqual(
      expect.arrayContaining(['RISK_ACK_REQUIRED', 'CREDENTIALS_INVALID']),
    );

    // Kill switch
    mockRiskProfileRepo.findOne.mockResolvedValue({ ...completeRisk(), killSwitchActive: true });
    mockBrokerQb.getOne.mockResolvedValue(connectedBroker());
    status = await service.getOnboardingStatus('user-complete');
    expect(status.blockedReasons).toContain('KILL_SWITCH_ACTIVE');
    expect(status.canStartTrading).toBe(false);
  });

  it('§1d: a READY account has an EMPTY blockedReasons list (never READY with blockers)', async () => {
    mockUserRepo.findOne.mockResolvedValue(completeUser());
    mockRiskProfileRepo.findOne.mockResolvedValue(completeRisk());
    mockBrokerQb.getOne.mockResolvedValue(connectedBroker());
    mockEligibilityService.getStatus.mockResolvedValue(eligibleStatus);

    const status = await service.getOnboardingStatus('user-complete');
    expect(status.canStartTrading).toBe(true);
    expect(status.blockedReasons).toEqual([]);
  });

  it('§1d: the fail-closed no-user status carries honest blockedReasons', async () => {
    mockUserRepo.findOne.mockResolvedValue(null);

    const status = await service.getOnboardingStatus('ghost');
    expect(status.canStartTrading).toBe(false);
    expect(status.blockedReasons).toEqual([
      'PROFILE_INCOMPLETE',
      'KYC_REQUIRED',
      'RISK_PROFILE_MISSING',
      'BROKER_DISCONNECTED',
    ]);
  });
});
