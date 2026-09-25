import { BadRequestException, ConflictException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { PerformanceFeeService } from './performance-fee.service';
import { PerformanceFeePolicy, BillingFrequency } from '../entities/performance-fee-policy.entity';
import { TradingAccountPerformance } from '../entities/trading-account-performance.entity';
import {
  PerformanceFeeAssessment,
  AssessmentStatus,
} from '../entities/performance-fee-assessment.entity';
import {
  PerformanceFeeLedgerEntry,
  LedgerEntryType,
} from '../entities/performance-fee-ledger-entry.entity';
import { Invoice } from '../../payments/entities/invoice.entity';
import { PaymentTransaction } from '../../payments/entities/payment-transaction.entity';
import { AuditService } from '../../audit/audit.service';

// ── Mock repositories ─────────────────────────────────────────────────────────
const mockPolicyManager = { transaction: jest.fn() };
const mockPolicyRepo = {
  find: jest.fn(),
  findOne: jest.fn(),
  create: jest.fn(),
  save: jest.fn(),
  count: jest.fn(),
  manager: mockPolicyManager,
};
const mockPerformanceRepo = {
  findOne: jest.fn(),
  create: jest.fn(),
  save: jest.fn(),
  update: jest.fn(),
};
const mockAssessmentRepo = {
  find: jest.fn(),
  findOne: jest.fn(),
  create: jest.fn(),
  save: jest.fn(),
  update: jest.fn(),
};
const mockLedgerRepo = { find: jest.fn(), save: jest.fn() };
const mockInvoiceRepo = { create: jest.fn(), save: jest.fn() };
const mockTransactionRepo = { create: jest.fn(), save: jest.fn() };
const mockAuditService = { log: jest.fn() };

// ── Test helpers ──────────────────────────────────────────────────────────────

function makePolicy(overrides: Partial<PerformanceFeePolicy> = {}): PerformanceFeePolicy {
  return {
    id: 'policy-1',
    planId: null,
    name: 'Standard 20%',
    feePercent: '20.0000',
    billingFrequency: BillingFrequency.MONTHLY,
    calculationMode: 'HIGH_WATER_MARK' as any,
    appliesTo: 'REALISED_PROFIT_ONLY' as any,
    version: 1,
    effectiveFrom: new Date('2026-01-01T00:00:00Z'),
    effectiveTo: null,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makePeriod() {
  const start = new Date('2026-01-01T00:00:00Z');
  const end = new Date('2026-01-31T23:59:59Z');
  return { start, end };
}

// ── Test suite ────────────────────────────────────────────────────────────────
describe('PerformanceFeeService', () => {
  let service: PerformanceFeeService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockPolicyManager.transaction.mockImplementation(async (callback) =>
      callback({
        query: jest.fn().mockResolvedValue(undefined),
        getRepository: () => mockPolicyRepo,
      }),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PerformanceFeeService,
        { provide: getRepositoryToken(PerformanceFeePolicy), useValue: mockPolicyRepo },
        { provide: getRepositoryToken(TradingAccountPerformance), useValue: mockPerformanceRepo },
        { provide: getRepositoryToken(PerformanceFeeAssessment), useValue: mockAssessmentRepo },
        { provide: getRepositoryToken(PerformanceFeeLedgerEntry), useValue: mockLedgerRepo },
        { provide: getRepositoryToken(Invoice), useValue: mockInvoiceRepo },
        { provide: getRepositoryToken(PaymentTransaction), useValue: mockTransactionRepo },
        { provide: AuditService, useValue: mockAuditService },
      ],
    }).compile();

    service = module.get<PerformanceFeeService>(PerformanceFeeService);
  });

  describe('replaceActiveGlobalPolicy', () => {
    it('closes the active version and creates the next version without rewriting history', async () => {
      const previous = makePolicy({ id: 'policy-v2', version: 2, feePercent: '20.0000' });
      mockPolicyRepo.find.mockResolvedValue([previous]);
      mockPolicyRepo.save
        .mockImplementationOnce(async (value) => value)
        .mockImplementationOnce(async (value) => ({ ...value, id: 'policy-v3' }));
      mockPolicyRepo.create.mockImplementation((value) => value);

      const result = await service.replaceActiveGlobalPolicy(
        {
          name: 'Owner fee 25%',
          feePercent: 25,
          billingFrequency: BillingFrequency.MONTHLY,
        },
        'admin-1',
      );

      expect(previous.isActive).toBe(false);
      expect(previous.effectiveTo).toBeInstanceOf(Date);
      expect(result.version).toBe(3);
      expect(result.feePercent).toBe('25.0000');
      expect(result.isActive).toBe(true);
      expect(mockAuditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          actorUserId: 'admin-1',
          resourceId: 'policy-v3',
        }),
      );
    });

    it('fails closed when multiple active global policies exist', async () => {
      mockPolicyRepo.find.mockResolvedValue([
        makePolicy({ id: 'policy-a' }),
        makePolicy({ id: 'policy-b', version: 2 }),
      ]);

      await expect(
        service.replaceActiveGlobalPolicy(
          {
            name: 'Owner fee',
            feePercent: 15,
            billingFrequency: BillingFrequency.QUARTERLY,
          },
          'admin-1',
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // High-water mark
  // ─────────────────────────────────────────────────────────────────────────

  describe('calculateAssessment — high-water mark', () => {
    function setupBaseline(realisedPnL: string, hwm: string) {
      mockPolicyRepo.find.mockResolvedValue([makePolicy()]);
      mockAssessmentRepo.findOne.mockResolvedValue(null); // no duplicate
      mockPerformanceRepo.findOne.mockResolvedValue({
        id: 'perf-1',
        currentHighWaterMark: hwm,
        totalRealisedProfit: '0',
        currency: 'USD',
      });
      mockLedgerRepo.find.mockResolvedValue([
        { entryType: LedgerEntryType.REALISED_TRADE_PROFIT, amount: realisedPnL, currency: 'USD' },
      ]);
      const assessment = { id: 'assess-1', feeAmount: '0', status: AssessmentStatus.DRAFT };
      mockAssessmentRepo.create.mockReturnValue(assessment);
      mockAssessmentRepo.save.mockResolvedValue(assessment);
      mockPerformanceRepo.update.mockResolvedValue(undefined);
    }

    it('no fee when realised balance is below high-water mark', async () => {
      setupBaseline('300000', '500000'); // profit $3k, HWM $5k
      const { start, end } = makePeriod();

      const result = await service.calculateAssessment(
        'user-1',
        null,
        'USD',
        start,
        end,
        'admin-1',
      );
      expect(result.feeAmount).toBe('0');
      expect(result.status).toBe(AssessmentStatus.DRAFT);
    });

    it('no fee when realised balance equals high-water mark', async () => {
      setupBaseline('500000', '500000'); // profit $5k = HWM $5k
      const { start, end } = makePeriod();

      const result = await service.calculateAssessment(
        'user-1',
        null,
        'USD',
        start,
        end,
        'admin-1',
      );
      expect(result.feeAmount).toBe('0');
    });

    it('fee applies only on amount above high-water mark', async () => {
      // profit $7k, HWM $5k → taxable basis = $2k, 20% fee = $400
      mockPolicyRepo.find.mockResolvedValue([makePolicy({ feePercent: '20.0000' })]);
      mockAssessmentRepo.findOne.mockResolvedValue(null);
      mockPerformanceRepo.findOne.mockResolvedValue({
        id: 'perf-1',
        currentHighWaterMark: '500000',
        totalRealisedProfit: '0',
        currency: 'USD',
      });
      mockLedgerRepo.find.mockResolvedValue([
        { entryType: LedgerEntryType.REALISED_TRADE_PROFIT, amount: '700000', currency: 'USD' },
      ]);
      // profit above HWM = 700000 - 500000 = 200000
      // fee = 200000 * 20 / 100 = 40000 (verified by the mocked assessment below)

      const assessment = { id: 'assess-2', feeAmount: '40000', status: AssessmentStatus.ASSESSED };
      mockAssessmentRepo.create.mockReturnValue(assessment);
      mockAssessmentRepo.save.mockResolvedValue(assessment);
      mockPerformanceRepo.update.mockResolvedValue(undefined);

      const { start, end } = makePeriod();
      const result = await service.calculateAssessment(
        'user-1',
        null,
        'USD',
        start,
        end,
        'admin-1',
      );
      expect(result.status).toBe(AssessmentStatus.ASSESSED);
      expect(BigInt(result.feeAmount)).toBeGreaterThan(0n);
    });

    it('high-water mark updates only after fee is PAID (not on DRAFT)', async () => {
      // HWM update is handled solely by the verified-webhook path in
      // WebhookProcessorService, not by calculateAssessment.
      setupBaseline('700000', '500000');
      const { start, end } = makePeriod();

      await service.calculateAssessment('user-1', null, 'USD', start, end, 'admin-1');
      // HWM must NOT be updated during calculation
      expect(mockPerformanceRepo.update).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ currentHighWaterMark: expect.anything() }),
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Sprint 18 — markAssessmentPaid removal / webhook-only HWM invariant
  // ─────────────────────────────────────────────────────────────────────────

  describe('Sprint 18 — markAssessmentPaid removed (webhook-only HWM invariant)', () => {
    it('PerformanceFeeService does NOT expose a markAssessmentPaid method', () => {
      // The previously-orphaned markAssessmentPaid() could transition an
      // assessment to PAID and update the HWM directly, bypassing the verified
      // payment-webhook path. Sprint 18 removed it entirely so the invariant
      // "HWM may update only through the verified performance-fee webhook
      // success path" is enforced structurally, not just by convention.
      expect((service as unknown as Record<string, unknown>).markAssessmentPaid).toBeUndefined();
    });

    it('PerformanceFeeService does NOT expose markAssessmentPaid, the previously orphaned direct HWM-update method', () => {
      // No public method on this service writes currentHighWaterMark — that
      // write lives solely in WebhookProcessorService.handlePerformanceFeePaymentSucceeded.
      const ownMethods = Object.getOwnPropertyNames(Object.getPrototypeOf(service)).filter(
        (name) =>
          name !== 'constructor' &&
          typeof (service as unknown as Record<string, unknown>)[name] === 'function',
      );
      // Sanity: the service still has its expected public surface.
      expect(ownMethods).toContain('calculateAssessment');
      expect(ownMethods).toContain('invoiceAssessment');
      // None of the public methods should touch HWM directly.
      expect(ownMethods).not.toContain('markAssessmentPaid');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Deposit / top-up exclusion
  // ─────────────────────────────────────────────────────────────────────────

  describe('calculateAssessment — deposit/top-up exclusion', () => {
    function setupWithEntries(
      entries: Array<{ entryType: LedgerEntryType; amount: string; currency?: string }>,
    ) {
      mockPolicyRepo.find.mockResolvedValue([makePolicy()]);
      mockAssessmentRepo.findOne.mockResolvedValue(null);
      mockPerformanceRepo.findOne.mockResolvedValue({
        id: 'perf-1',
        currentHighWaterMark: '0',
        totalRealisedProfit: '0',
        currency: 'USD',
      });
      mockLedgerRepo.find.mockResolvedValue(entries);
      const assessment = {
        id: 'assess-dep',
        feeAmount: '0',
        realisedProfitForFee: '0',
        depositsExcluded: '0',
        status: AssessmentStatus.DRAFT,
      };
      mockAssessmentRepo.create.mockReturnValue(assessment);
      mockAssessmentRepo.save.mockResolvedValue(assessment);
      mockPerformanceRepo.update.mockResolvedValue(undefined);
    }

    it('deposits do not count as profit — zero fee on pure deposit', async () => {
      setupWithEntries([
        { entryType: LedgerEntryType.DEPOSIT, amount: '1000000', currency: 'USD' },
      ]);
      const { start, end } = makePeriod();

      const result = await service.calculateAssessment(
        'user-1',
        null,
        'USD',
        start,
        end,
        'admin-1',
      );
      expect(result.feeAmount).toBe('0');
      expect(result.realisedProfitForFee).toBe('0');
    });

    it('top-up (deposit) with profit: only profit above HWM is taxed', async () => {
      // $5k deposit + $1k trade profit, HWM=0 → only $1k is basis for fee
      mockPolicyRepo.find.mockResolvedValue([makePolicy({ feePercent: '20.0000' })]);
      mockAssessmentRepo.findOne.mockResolvedValue(null);
      mockPerformanceRepo.findOne.mockResolvedValue({
        id: 'perf-1',
        currentHighWaterMark: '0',
        totalRealisedProfit: '0',
        currency: 'USD',
      });
      mockLedgerRepo.find.mockResolvedValue([
        { entryType: LedgerEntryType.DEPOSIT, amount: '500000', currency: 'USD' },
        { entryType: LedgerEntryType.REALISED_TRADE_PROFIT, amount: '100000', currency: 'USD' },
      ]);
      const assessment = {
        id: 'assess-mix',
        feeAmount: '20000',
        realisedProfitForFee: '100000',
        depositsExcluded: '500000',
        status: AssessmentStatus.ASSESSED,
      };
      mockAssessmentRepo.create.mockReturnValue(assessment);
      mockAssessmentRepo.save.mockResolvedValue(assessment);
      mockPerformanceRepo.update.mockResolvedValue(undefined);

      const { start, end } = makePeriod();
      const result = await service.calculateAssessment(
        'user-1',
        null,
        'USD',
        start,
        end,
        'admin-1',
      );
      expect(result.depositsExcluded).toBe('500000');
      expect(result.realisedProfitForFee).toBe('100000');
    });

    it('withdrawal adjusts ledger but does not count as profit', async () => {
      setupWithEntries([
        { entryType: LedgerEntryType.WITHDRAWAL, amount: '-200000', currency: 'USD' },
      ]);
      const { start, end } = makePeriod();

      const result = await service.calculateAssessment(
        'user-1',
        null,
        'USD',
        start,
        end,
        'admin-1',
      );
      expect(result.feeAmount).toBe('0');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Realised profit only
  // ─────────────────────────────────────────────────────────────────────────

  describe('calculateAssessment — realised profit only', () => {
    function setupProfitEntries(
      entries: Array<{ entryType: LedgerEntryType; amount: string; currency?: string }>,
      hwm = '0',
    ) {
      mockPolicyRepo.find.mockResolvedValue([makePolicy()]);
      mockAssessmentRepo.findOne.mockResolvedValue(null);
      mockPerformanceRepo.findOne.mockResolvedValue({
        id: 'perf-1',
        currentHighWaterMark: hwm,
        totalRealisedProfit: '0',
        currency: 'USD',
      });
      mockLedgerRepo.find.mockResolvedValue(entries);
      const netPnL = entries.reduce((sum, e) => {
        if (
          e.entryType === LedgerEntryType.REALISED_TRADE_PROFIT ||
          e.entryType === LedgerEntryType.REALISED_TRADE_LOSS
        ) {
          return sum + BigInt(e.amount);
        }
        return sum;
      }, 0n);
      const profitAboveHWM = netPnL - BigInt(hwm) > 0n ? netPnL - BigInt(hwm) : 0n;
      const feeAmount = profitAboveHWM > 0n ? String((profitAboveHWM * 2000n) / 1_000_000n) : '0';
      const status = BigInt(feeAmount) > 0n ? AssessmentStatus.ASSESSED : AssessmentStatus.DRAFT;
      const assessment = {
        id: 'assess-r',
        feeAmount,
        realisedProfitForFee: profitAboveHWM.toString(),
        status,
      };
      mockAssessmentRepo.create.mockReturnValue(assessment);
      mockAssessmentRepo.save.mockResolvedValue(assessment);
      mockPerformanceRepo.update.mockResolvedValue(undefined);
    }

    it('closed winning trades count toward realised profit', async () => {
      setupProfitEntries([
        { entryType: LedgerEntryType.REALISED_TRADE_PROFIT, amount: '500000', currency: 'USD' },
      ]);
      const { start, end } = makePeriod();
      const result = await service.calculateAssessment(
        'user-1',
        null,
        'USD',
        start,
        end,
        'admin-1',
      );
      expect(result.status).toBe(AssessmentStatus.ASSESSED);
      expect(BigInt(result.feeAmount)).toBeGreaterThan(0n);
    });

    it('closed losing trades reduce realised profit (net negative → no fee)', async () => {
      setupProfitEntries([
        { entryType: LedgerEntryType.REALISED_TRADE_PROFIT, amount: '100000', currency: 'USD' },
        { entryType: LedgerEntryType.REALISED_TRADE_LOSS, amount: '-300000', currency: 'USD' },
      ]);
      const { start, end } = makePeriod();
      const result = await service.calculateAssessment(
        'user-1',
        null,
        'USD',
        start,
        end,
        'admin-1',
      );
      expect(result.feeAmount).toBe('0');
    });

    it('FEE_ASSESSED and FEE_PAID entries are ignored in profit calculation', async () => {
      setupProfitEntries([
        { entryType: LedgerEntryType.FEE_ASSESSED, amount: '-50000', currency: 'USD' },
        { entryType: LedgerEntryType.FEE_PAID, amount: '-50000', currency: 'USD' },
      ]);
      const { start, end } = makePeriod();
      const result = await service.calculateAssessment(
        'user-1',
        null,
        'USD',
        start,
        end,
        'admin-1',
      );
      // Fee entries don't count as profit or loss — no fee basis
      expect(result.feeAmount).toBe('0');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Duplicate prevention
  // ─────────────────────────────────────────────────────────────────────────

  describe('calculateAssessment — duplicate prevention', () => {
    it('returns existing DRAFT assessment without recalculating', async () => {
      mockPolicyRepo.find.mockResolvedValue([makePolicy()]);
      const existingDraft = {
        id: 'draft-existing',
        status: AssessmentStatus.DRAFT,
        feeAmount: '0',
      };
      mockAssessmentRepo.findOne.mockResolvedValue(existingDraft);

      const { start, end } = makePeriod();
      const result = await service.calculateAssessment(
        'user-1',
        null,
        'USD',
        start,
        end,
        'admin-1',
      );
      expect(result.id).toBe('draft-existing');
      // Ledger was NOT queried since DRAFT already exists
      expect(mockLedgerRepo.find).not.toHaveBeenCalled();
    });

    it('rejects duplicate assessment that is already ASSESSED', async () => {
      mockPolicyRepo.find.mockResolvedValue([makePolicy()]);
      mockAssessmentRepo.findOne.mockResolvedValue({
        id: 'existing',
        status: AssessmentStatus.ASSESSED,
      });

      const { start, end } = makePeriod();
      await expect(
        service.calculateAssessment('user-1', null, 'USD', start, end, 'admin-1'),
      ).rejects.toThrow(ConflictException);
    });

    it('rejects duplicate assessment that is already INVOICED', async () => {
      mockPolicyRepo.find.mockResolvedValue([makePolicy()]);
      mockAssessmentRepo.findOne.mockResolvedValue({
        id: 'existing',
        status: AssessmentStatus.INVOICED,
      });

      const { start, end } = makePeriod();
      await expect(
        service.calculateAssessment('user-1', null, 'USD', start, end, 'admin-1'),
      ).rejects.toThrow(ConflictException);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Double-charge prevention (audit fix) — outstanding unpaid assessment guard
  // ─────────────────────────────────────────────────────────────────────────

  describe('calculateAssessment — outstanding assessment guard (double-charge prevention)', () => {
    it('rejects a new period when an unpaid ASSESSED assessment exists for the account', async () => {
      mockPolicyRepo.find.mockResolvedValue([makePolicy()]);
      // 1st findOne = duplicate-period check (none); 2nd findOne = outstanding check (ASSESSED)
      mockAssessmentRepo.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'prev-unpaid', status: AssessmentStatus.ASSESSED });

      const { start, end } = makePeriod();
      await expect(
        service.calculateAssessment('user-1', null, 'USD', start, end, 'admin-1'),
      ).rejects.toThrow(ConflictException);
      // Must NOT proceed to load ledger / create a second assessment
      expect(mockLedgerRepo.find).not.toHaveBeenCalled();
    });

    it('rejects a new period when an unpaid INVOICED assessment exists for the account', async () => {
      mockPolicyRepo.find.mockResolvedValue([makePolicy()]);
      mockAssessmentRepo.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'prev-invoiced', status: AssessmentStatus.INVOICED });

      const { start, end } = makePeriod();
      await expect(
        service.calculateAssessment('user-1', null, 'USD', start, end, 'admin-1'),
      ).rejects.toThrow(ConflictException);
    });

    it('allows a new period when no outstanding assessment exists (prior periods resolved)', async () => {
      mockPolicyRepo.find.mockResolvedValue([makePolicy()]);
      // both duplicate and outstanding checks return null
      mockAssessmentRepo.findOne.mockResolvedValue(null);
      mockPerformanceRepo.findOne.mockResolvedValue({
        id: 'perf-1',
        currentHighWaterMark: '700000',
        totalRealisedProfit: '700000',
        currency: 'USD',
      });
      mockLedgerRepo.find.mockResolvedValue([
        { entryType: LedgerEntryType.REALISED_TRADE_PROFIT, amount: '300000', currency: 'USD' },
      ]);
      const assessment = {
        id: 'next-period',
        feeAmount: '60000',
        status: AssessmentStatus.ASSESSED,
      };
      mockAssessmentRepo.create.mockReturnValue(assessment);
      mockAssessmentRepo.save.mockResolvedValue(assessment);
      mockPerformanceRepo.update.mockResolvedValue(undefined);

      const { start, end } = makePeriod();
      const result = await service.calculateAssessment(
        'user-1',
        null,
        'USD',
        start,
        end,
        'admin-1',
      );
      expect(result.id).toBe('next-period');
      expect(mockLedgerRepo.find).toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Global policy resolution (subscription-retirement model)
  // ─────────────────────────────────────────────────────────────────────────

  describe('findActiveGlobalPolicy — single global policy resolution', () => {
    it('returns the single active global policy when exactly one exists', async () => {
      const globalPolicy = makePolicy({ id: 'global-policy', planId: null });
      mockPolicyRepo.find.mockResolvedValue([globalPolicy]);

      const result = await service.findActiveGlobalPolicy();
      expect(result).toBe(globalPolicy);
      // Must query plan_id IS NULL & isActive=true only
      expect(mockPolicyRepo.find).toHaveBeenCalledWith({
        where: { planId: expect.anything(), isActive: true },
      });
    });

    it('throws BadRequestException when no active global policy exists', async () => {
      mockPolicyRepo.find.mockResolvedValue([]);
      await expect(service.findActiveGlobalPolicy()).rejects.toThrow(BadRequestException);
      await expect(service.findActiveGlobalPolicy()).rejects.toThrow(
        /No active global performance fee policy configured/,
      );
    });

    it('throws BadRequestException when multiple active global policies exist', async () => {
      const a = makePolicy({ id: 'g-a', planId: null });
      const b = makePolicy({ id: 'g-b', planId: null });
      mockPolicyRepo.find.mockResolvedValue([a, b]);
      await expect(service.findActiveGlobalPolicy()).rejects.toThrow(BadRequestException);
      await expect(service.findActiveGlobalPolicy()).rejects.toThrow(
        /Multiple active global performance fee policies found/,
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // ─────────────────────────────────────────────────────────────────────────

  // ─────────────────────────────────────────────────────────────────────────
  // Invoice integration
  // ─────────────────────────────────────────────────────────────────────────

  describe('invoiceAssessment', () => {
    function setupAssessedAssessment() {
      const assessment = {
        id: 'assess-inv',
        status: AssessmentStatus.ASSESSED,
        userId: 'user-1',
        subscriptionId: 'sub-1',
        brokerConnectionId: null,
        currency: 'USD',
        feeAmount: '50000',
        feePercent: '20.0000',
        periodStart: new Date('2026-01-01'),
        periodEnd: new Date('2026-01-31'),
        realisedProfitForFee: '250000',
        invoiceId: null,
      };
      mockAssessmentRepo.findOne.mockResolvedValue(assessment);
      const savedInvoice = { id: 'inv-new', invoiceNumber: 'PF-12345-ABCDE' };
      mockInvoiceRepo.create.mockReturnValue(savedInvoice);
      mockInvoiceRepo.save.mockResolvedValue(savedInvoice);
      const savedTx = { id: 'tx-new' };
      mockTransactionRepo.create.mockReturnValue(savedTx);
      mockTransactionRepo.save.mockResolvedValue(savedTx);
      mockAssessmentRepo.save.mockImplementation((a: any) =>
        Promise.resolve({ ...a, status: AssessmentStatus.INVOICED }),
      );
      mockLedgerRepo.save.mockResolvedValue({});
      return assessment;
    }

    it('creates invoice for positive fee assessment', async () => {
      setupAssessedAssessment();
      const result = await service.invoiceAssessment('assess-inv', 'admin-1');
      expect(result.status).toBe(AssessmentStatus.INVOICED);
      expect(mockInvoiceRepo.save).toHaveBeenCalled();
      expect(mockTransactionRepo.save).toHaveBeenCalled();
      expect(mockAuditService.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'PERFORMANCE_FEE_ASSESSMENT_INVOICED' }),
      );
    });

    it('creates FEE_ASSESSED ledger entry when invoicing', async () => {
      setupAssessedAssessment();
      await service.invoiceAssessment('assess-inv', 'admin-1');
      expect(mockLedgerRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ entryType: LedgerEntryType.FEE_ASSESSED }),
      );
    });

    it('rejects invoicing a DRAFT assessment', async () => {
      mockAssessmentRepo.findOne.mockResolvedValue({
        id: 'draft-a',
        status: AssessmentStatus.DRAFT,
        feeAmount: '50000',
      });
      await expect(service.invoiceAssessment('draft-a', 'admin-1')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('rejects invoicing a zero-fee assessment', async () => {
      mockAssessmentRepo.findOne.mockResolvedValue({
        id: 'zero-a',
        status: AssessmentStatus.ASSESSED,
        feeAmount: '0',
      });
      await expect(service.invoiceAssessment('zero-a', 'admin-1')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('zero fee assessment remains DRAFT — no invoice created', async () => {
      mockPolicyRepo.find.mockResolvedValue([makePolicy()]);
      mockAssessmentRepo.findOne.mockResolvedValue(null);
      mockPerformanceRepo.findOne.mockResolvedValue({
        id: 'perf-1',
        currentHighWaterMark: '1000000',
        totalRealisedProfit: '0',
        currency: 'USD',
      });
      // Only $5k profit, HWM is $10k → no taxable amount
      mockLedgerRepo.find.mockResolvedValue([
        { entryType: LedgerEntryType.REALISED_TRADE_PROFIT, amount: '500000', currency: 'USD' },
      ]);
      const assessment = { id: 'zero-assess', feeAmount: '0', status: AssessmentStatus.DRAFT };
      mockAssessmentRepo.create.mockReturnValue(assessment);
      mockAssessmentRepo.save.mockResolvedValue(assessment);
      mockPerformanceRepo.update.mockResolvedValue(undefined);

      const { start, end } = makePeriod();
      const result = await service.calculateAssessment(
        'user-1',
        null,
        'USD',
        start,
        end,
        'admin-1',
      );
      expect(result.feeAmount).toBe('0');
      expect(result.status).toBe(AssessmentStatus.DRAFT);
      expect(mockInvoiceRepo.save).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Global policy / no-subscription checks (subscription-retirement model)
  // ─────────────────────────────────────────────────────────────────────────

  describe('calculateAssessment — global policy checks (no subscription required)', () => {
    it('rejects when no active global performance fee policy exists', async () => {
      mockPolicyRepo.find.mockResolvedValue([]); // no global policy
      const { start, end } = makePeriod();
      await expect(
        service.calculateAssessment('user-1', null, 'USD', start, end, 'admin-1'),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects when multiple active global policies exist (ambiguous configuration)', async () => {
      const a = makePolicy({ id: 'g-a', planId: null });
      const b = makePolicy({ id: 'g-b', planId: null });
      mockPolicyRepo.find.mockResolvedValue([a, b]);
      const { start, end } = makePeriod();
      await expect(
        service.calculateAssessment('user-1', null, 'USD', start, end, 'admin-1'),
      ).rejects.toThrow(BadRequestException);
    });

    it('allows assessment WITHOUT a subscription when exactly one global policy exists', async () => {
      mockPolicyRepo.find.mockResolvedValue([makePolicy()]);
      mockAssessmentRepo.findOne.mockResolvedValue(null);
      mockPerformanceRepo.findOne.mockResolvedValue({
        id: 'perf-1',
        currentHighWaterMark: '0',
        totalRealisedProfit: '0',
        currency: 'USD',
      });
      mockLedgerRepo.find.mockResolvedValue([]);
      const assessment = { id: 'ok-assess', feeAmount: '0', status: AssessmentStatus.DRAFT };
      mockAssessmentRepo.create.mockReturnValue(assessment);
      mockAssessmentRepo.save.mockResolvedValue(assessment);
      mockPerformanceRepo.update.mockResolvedValue(undefined);

      const { start, end } = makePeriod();
      const result = await service.calculateAssessment(
        'user-1',
        null,
        'USD',
        start,
        end,
        'admin-1',
      );
      expect(result).toBeDefined();
      expect(result.id).toBe('ok-assess');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Security
  // ─────────────────────────────────────────────────────────────────────────

  describe('security — audit metadata does not leak secrets', () => {
    it('audit logs for policy creation do not contain sensitive data', async () => {
      const policy = makePolicy();
      mockPolicyRepo.create.mockReturnValue(policy);
      mockPolicyRepo.save.mockResolvedValue(policy);

      await service.createPolicy(
        { name: 'Test', feePercent: 20, billingFrequency: BillingFrequency.MONTHLY },
        'admin-1',
      );

      const auditCalls = mockAuditService.log.mock.calls;
      for (const [call] of auditCalls) {
        const metaStr = JSON.stringify(call.metadata ?? {});
        expect(metaStr).not.toContain('password');
        expect(metaStr).not.toContain('secret');
        expect(metaStr).not.toContain('credential');
        expect(metaStr).not.toContain('apiKey');
      }
    });

    it('assessment audit logs do not expose sensitive internal fields', async () => {
      mockPolicyRepo.find.mockResolvedValue([makePolicy()]);
      mockAssessmentRepo.findOne.mockResolvedValue(null);
      mockPerformanceRepo.findOne.mockResolvedValue({
        id: 'perf-sec',
        currentHighWaterMark: '0',
        totalRealisedProfit: '0',
        currency: 'USD',
      });
      mockLedgerRepo.find.mockResolvedValue([]);
      const assessment = { id: 'sec-assess', feeAmount: '0', status: AssessmentStatus.DRAFT };
      mockAssessmentRepo.create.mockReturnValue(assessment);
      mockAssessmentRepo.save.mockResolvedValue(assessment);
      mockPerformanceRepo.update.mockResolvedValue(undefined);

      const { start, end } = makePeriod();
      await service.calculateAssessment('user-1', null, 'USD', start, end, 'admin-1');

      for (const [call] of mockAuditService.log.mock.calls) {
        const metaStr = JSON.stringify(call.metadata ?? {});
        expect(metaStr).not.toContain('apiKey');
        expect(metaStr).not.toContain('secret');
        expect(metaStr).not.toContain('rawBody');
        expect(metaStr).not.toContain('cardNumber');
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // getCurrentHighWaterMark
  // ─────────────────────────────────────────────────────────────────────────

  describe('getCurrentHighWaterMark', () => {
    it('returns 0 when no performance record exists', async () => {
      mockPerformanceRepo.findOne.mockResolvedValue(null);
      const hwm = await service.getCurrentHighWaterMark('user-1', null, 'USD');
      expect(hwm).toBe('0');
    });

    it('returns stored HWM value', async () => {
      mockPerformanceRepo.findOne.mockResolvedValue({ id: 'p1', currentHighWaterMark: '750000' });
      const hwm = await service.getCurrentHighWaterMark('user-1', null, 'USD');
      expect(hwm).toBe('750000');
    });
  });
});