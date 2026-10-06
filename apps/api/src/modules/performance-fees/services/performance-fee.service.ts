import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, FindOptionsWhere, In, IsNull, Repository } from 'typeorm';
import { isSupportedCurrency } from '../../broker-reconciliation/services/currency-minor-units';
import { PerformanceFeePolicy } from '../entities/performance-fee-policy.entity';
import { TradingAccountPerformance } from '../entities/trading-account-performance.entity';
import {
  PerformanceFeeAssessment,
  AssessmentStatus,
} from '../entities/performance-fee-assessment.entity';
import {
  PerformanceFeeLedgerEntry,
  LedgerEntryType,
} from '../entities/performance-fee-ledger-entry.entity';
import { Invoice, InvoiceStatus } from '../../payments/entities/invoice.entity';
import {
  PaymentTransaction,
  PaymentPurpose,
  PaymentTransactionStatus,
} from '../../payments/entities/payment-transaction.entity';
import { AuditService } from '../../audit/audit.service';
import { AuditAction } from '../../../common/enums/audit-action.enum';
import { AuditSeverity } from '../../audit/entities/audit-log.entity';
import { CreatePolicyDto } from '../dto/create-policy.dto';
import { ReplacePolicyDto } from '../dto/replace-policy.dto';
import { CreateLedgerEntryDto } from '../dto/create-ledger-entry.dto';

/**
 * Compute fee amount using integer arithmetic to avoid floating-point errors.
 *
 * feePercent is a human-readable percentage (e.g. 20.0000 = 20%).
 * profitMinorUnits is the profit above HWM in minor currency units (as bigint string).
 *
 * Formula: feeAmount = floor(profit * feePercent / 100)
 *
 * Calculation avoids Number precision loss for large values by:
 *   1. Scaling feePercent to an integer (× 10000) for BigInt multiplication
 *   2. Dividing by 1000000 at the end (100 × 10000)
 */
function computeFeeAmount(profitMinorUnits: string, feePercent: string): string {
  const profit = BigInt(profitMinorUnits);
  if (profit <= 0n) return '0';
  // Scale feePercent to avoid fractional BigInt (4 decimal places → multiply by 10000)
  const feePercentScaled = BigInt(Math.round(parseFloat(feePercent) * 10000));
  const fee = (profit * feePercentScaled) / 1_000_000n; // divide by 100 * 10000
  return fee.toString();
}

/**
 * GATE-3 BLOCKER 3 — validate and normalize a currency code for assessment.
 */
const GLOBAL_POLICY_CREATION_LOCK_KEY = '2515617064791485889';

function validateAndNormalizeCurrency(currency: string | null | undefined): string {
  if (currency === null || currency === undefined) {
    throw new BadRequestException('Currency is required for a performance-fee assessment.');
  }
  const trimmed = String(currency).trim();
  if (trimmed === '') {
    throw new BadRequestException('Currency is required (empty value rejected).');
  }
  const upper = trimmed.toUpperCase();
  if (!isSupportedCurrency(upper)) {
    throw new BadRequestException(
      `Unsupported currency '${upper}' for performance-fee assessment.`,
    );
  }
  return upper;
}

/**
 * PerformanceFeeService
 *
 * Implements the High-Water Mark performance fee engine.
 *
 * KEY RULES (enforced at this service boundary):
 * 1. Fee applies ONLY to realised closed-trade profit above the previous high-water mark.
 * 2. Deposits and top-ups are EXCLUDED from the fee basis.
 * 3. Unrealised / floating P&L is NEVER counted.
 * 4. Demo, paper, or backtest results are NEVER included.
 * 5. No automatic broker withdrawal — invoice only.
 * 6. High-water mark updates ONLY after fee is paid (status = PAID).
 * 7. Duplicate assessments for same user/broker/period are rejected unless DRAFT.
 * 8. No invoice created when feeAmount = 0.
 * 9. No fee assessed without a valid active global performance fee policy.
 */
@Injectable()
export class PerformanceFeeService {
  private readonly logger = new Logger(PerformanceFeeService.name);

  constructor(
    @InjectRepository(PerformanceFeePolicy)
    private readonly policyRepo: Repository<PerformanceFeePolicy>,
    @InjectRepository(TradingAccountPerformance)
    private readonly performanceRepo: Repository<TradingAccountPerformance>,
    @InjectRepository(PerformanceFeeAssessment)
    private readonly assessmentRepo: Repository<PerformanceFeeAssessment>,
    @InjectRepository(PerformanceFeeLedgerEntry)
    private readonly ledgerRepo: Repository<PerformanceFeeLedgerEntry>,
    @InjectRepository(Invoice)
    private readonly invoiceRepo: Repository<Invoice>,
    @InjectRepository(PaymentTransaction)
    private readonly transactionRepo: Repository<PaymentTransaction>,
    private readonly auditService: AuditService,
  ) {}

  // -------------------------------------------------------------------------
  // Policies
  // -------------------------------------------------------------------------

  async getPolicies(): Promise<PerformanceFeePolicy[]> {
    return this.policyRepo.find({
      where: { planId: IsNull() },
      order: { version: 'DESC', createdAt: 'DESC' },
    });
  }

  async createPolicy(
    dto: CreatePolicyDto,
    adminId: string,
    ipAddress?: string,
  ): Promise<PerformanceFeePolicy> {
    // GATE-3 BLOCKER 4 — new policies must be GLOBAL (planId = null).
    if (dto.planId !== undefined && dto.planId !== null) {
      throw new BadRequestException(
        'Subscription-plan-linked performance fee policies are retired. New policies must be GLOBAL (omit planId).',
      );
    }
    // Architect final correction — serialize active-global creation so two
    // concurrent admin requests cannot both observe count=0 and persist two
    // active global policies. This is a short DB-only transaction; audit I/O
    // happens only after commit.
    const saved = await this.policyRepo.manager.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock($1)', [GLOBAL_POLICY_CREATION_LOCK_KEY]);
      const policyRepo = tx.getRepository(PerformanceFeePolicy);
      const existingActiveGlobal = await policyRepo.count({
        where: { planId: IsNull(), isActive: true },
      });
      if (existingActiveGlobal > 0) {
        throw new BadRequestException(
          'An active global performance fee policy already exists. Deactivate it before creating a new one.',
        );
      }
      const policy = policyRepo.create({
        planId: null,
        name: dto.name,
        feePercent: dto.feePercent.toFixed(4),
        billingFrequency: dto.billingFrequency,
        version: 1,
        effectiveFrom: new Date(),
        effectiveTo: null,
        isActive: true,
      });
      return policyRepo.save(policy);
    });

    await this.auditService.log({
      actorUserId: adminId,
      actorType: 'ADMIN',
      action: AuditAction.PERFORMANCE_FEE_POLICY_CREATED,
      resourceType: 'PerformanceFeePolicy',
      resourceId: saved.id,
      ipAddress,
      metadata: {
        name: dto.name,
        feePercent: dto.feePercent,
        billingFrequency: dto.billingFrequency,
        planId: null,
      },
      severity: AuditSeverity.INFO,
    });

    return saved;
  }

  /**
   * Atomically replace the currently active global policy.
   *
   * Existing policy rows are never edited in place beyond closing their
   * effective window. Historical assessments already snapshot feePercent and
   * calculation metadata, so a replacement can never retroactively alter an
   * assessment that has already been calculated.
   */
  async replaceActiveGlobalPolicy(
    dto: ReplacePolicyDto,
    adminId: string,
    ipAddress?: string,
  ): Promise<PerformanceFeePolicy> {
    const changedAt = new Date();

    const result = await this.policyRepo.manager.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock($1)', [GLOBAL_POLICY_CREATION_LOCK_KEY]);
      const policyRepo = tx.getRepository(PerformanceFeePolicy);
      const active = await policyRepo.find({
        where: { planId: IsNull(), isActive: true },
        order: { version: 'DESC' },
      });

      if (active.length > 1) {
        throw new BadRequestException(
          'Multiple active global performance fee policies found. Resolve the configuration before changing the fee.',
        );
      }

      const previous = active[0] ?? null;
      const previousVersion = previous?.version ?? 0;

      if (previous) {
        previous.isActive = false;
        previous.effectiveTo = changedAt;
        await policyRepo.save(previous);
      }

      const next = policyRepo.create({
        planId: null,
        name: dto.name.trim(),
        feePercent: dto.feePercent.toFixed(4),
        billingFrequency: dto.billingFrequency,
        version: previousVersion + 1,
        effectiveFrom: changedAt,
        effectiveTo: null,
        isActive: true,
      });

      return {
        previous,
        saved: await policyRepo.save(next),
      };
    });

    await this.auditService.log({
      actorUserId: adminId,
      actorType: 'ADMIN',
      action: AuditAction.PERFORMANCE_FEE_POLICY_REPLACED,
      resourceType: 'PerformanceFeePolicy',
      resourceId: result.saved.id,
      ipAddress,
      metadata: {
        previousPolicyId: result.previous?.id ?? null,
        previousVersion: result.previous?.version ?? null,
        previousFeePercent: result.previous?.feePercent ?? null,
        name: result.saved.name,
        version: result.saved.version,
        feePercent: result.saved.feePercent,
        billingFrequency: result.saved.billingFrequency,
        effectiveFrom: result.saved.effectiveFrom.toISOString(),
      },
      severity: AuditSeverity.INFO,
    });

    return result.saved;
  }

  // -------------------------------------------------------------------------
  // User summary
  // -------------------------------------------------------------------------

  async getUserSummary(userId: string): Promise<{
    performance: TradingAccountPerformance | null;
    assessments: PerformanceFeeAssessment[];
  }> {
    const [performance, assessments] = await Promise.all([
      this.performanceRepo.findOne({ where: { userId } }),
      this.assessmentRepo.find({
        where: { userId },
        order: { periodStart: 'DESC' },
        take: 20,
      }),
    ]);
    return { performance, assessments };
  }

  // -------------------------------------------------------------------------
  // Assessments (admin list)
  // -------------------------------------------------------------------------

  async getAssessments(userId?: string): Promise<PerformanceFeeAssessment[]> {
    const where = userId ? { userId } : {};
    return this.assessmentRepo.find({ where, order: { createdAt: 'DESC' }, take: 100 });
  }

  // -------------------------------------------------------------------------
  // Calculate assessment
  // -------------------------------------------------------------------------

  /**
   * Calculate a performance fee assessment for the given user/period.
   *
   * Subscription-retirement model: assessment requires only a single active
   * GLOBAL performance fee policy (plan_id IS NULL & isActive = true). The
   * legacy subscription-gated lookup has been removed — users no longer need
   * an active subscription to be assessed.
   * Uses ledger entries to compute realised profit — NOT live broker balance.
   * Returns DRAFT assessment even if feeAmount = 0 (no invoice will be created).
   * Returns existing DRAFT if one already exists for the same user/broker/period.
   * Rejects if a non-DRAFT assessment already exists for the period.
   */
  async calculateAssessment(
    userId: string,
    brokerConnectionId: string | null,
    currency: string,
    periodStart: Date,
    periodEnd: Date,
    adminId: string,
    ipAddress?: string,
  ): Promise<PerformanceFeeAssessment> {
    // 0. (GATE-3 BLOCKER 3) Validate + normalize the requested currency.
    const authoritativeCurrency = validateAndNormalizeCurrency(currency);
    // 1. Resolve the single active global performance fee policy.
    const policy = await this.findActiveGlobalPolicy();

    // 2. Check for duplicate assessment (same user/broker/period)
    const existing = await this.findExistingAssessment(
      userId,
      brokerConnectionId,
      periodStart,
      periodEnd,
    );
    if (existing) {
      if (existing.status === AssessmentStatus.DRAFT) {
        this.logger.log(
          `[PerfFee] Returning existing DRAFT assessment ${existing.id} for user ${userId}`,
        );
        return existing;
      }
      throw new ConflictException(
        `An assessment in status ${existing.status} already exists for this user/broker/period`,
      );
    }

    // 2b. Prevent stacking unpaid assessments against a stale high-water mark.
    //
    // The HWM only advances after a fee is PAID, but `totalRealisedProfit` advances
    // at calculation time. If a second assessment is calculated while a prior one is
    // still ASSESSED or INVOICED (i.e. not yet PAID), both would be computed against
    // the SAME starting HWM and would re-charge the same realised profit — a double
    // charge. We therefore require each outstanding assessment to be resolved
    // (PAID / WAIVED / CANCELLED) before a new period can be calculated.
    const outstanding = await this.findOutstandingAssessment(userId, brokerConnectionId);
    if (outstanding) {
      throw new ConflictException(
        `An outstanding ${outstanding.status} assessment (${outstanding.id}) must be resolved ` +
          `(paid, waived, or cancelled) before calculating a new assessment for this account`,
      );
    }

    // 3. (GATE-3 BLOCKER 3) Bind currency to existing performance record.
    const existingPerf = await this.performanceRepo.findOne({
      where: {
        userId,
        brokerConnectionId: this.brokerScope(brokerConnectionId),
      } as FindOptionsWhere<TradingAccountPerformance>,
    });
    if (existingPerf && existingPerf.currency !== authoritativeCurrency) {
      throw new BadRequestException(
        `Currency mismatch: requested '${authoritativeCurrency}' but the existing ` +
          `trading-account performance record uses '${existingPerf.currency}'.`,
      );
    }
    // 4. Load or create TradingAccountPerformance
    const performance = existingPerf
      ? existingPerf
      : await this.getOrCreatePerformance(userId, brokerConnectionId, authoritativeCurrency);

    // 5. Load ledger entries for the period (broker-scoped)
    const ledgerEntries = await this.ledgerRepo.find({
      where: {
        userId,
        brokerConnectionId: this.brokerScope(brokerConnectionId),
        occurredAt: Between(periodStart, periodEnd),
      } as FindOptionsWhere<PerformanceFeeLedgerEntry>,
      order: { occurredAt: 'ASC' },
    });

    // 5b. (GATE-3 BLOCKER 3) Every ledger entry MUST use the same currency.
    for (const entry of ledgerEntries) {
      if (entry.currency !== authoritativeCurrency) {
        throw new BadRequestException(
          `Currency mismatch in ledger entry ${entry.id}: entry currency '${entry.currency}' does not match assessment currency '${authoritativeCurrency}'.`,
        );
      }
    }

    // 6. Compute realised P&L (closed trades only — exclude deposits, withdrawals, fee entries)
    let periodRealisedPnL = 0n;
    let depositsExcluded = 0n;
    let withdrawalsAdjusted = 0n;

    for (const entry of ledgerEntries) {
      const amount = BigInt(entry.amount);
      if (entry.entryType === LedgerEntryType.REALISED_TRADE_PROFIT) {
        periodRealisedPnL += amount;
      } else if (entry.entryType === LedgerEntryType.REALISED_TRADE_LOSS) {
        periodRealisedPnL += amount; // losses are stored as negative
      } else if (entry.entryType === LedgerEntryType.DEPOSIT) {
        depositsExcluded += amount;
      } else if (entry.entryType === LedgerEntryType.WITHDRAWAL) {
        withdrawalsAdjusted += amount; // withdrawals are stored as negative
      }
      // FEE_ASSESSED, FEE_PAID, ADJUSTMENT are ignored in period P&L calculation
    }

    // 7. Compute cumulative realised balance for the period
    // Ending realised balance = total realised profit tracked in performance record
    // plus any new realised P&L in this period not yet counted
    const currentTotalRealised = BigInt(performance.totalRealisedProfit) + periodRealisedPnL;
    const startingHWM = BigInt(performance.currentHighWaterMark);

    // 8. Profit above HWM is the only amount subject to fee
    const profitAboveHWM = currentTotalRealised - startingHWM;
    const realisedProfitForFee = profitAboveHWM > 0n ? profitAboveHWM : 0n;

    // 9. Compute fee
    const feeAmount =
      realisedProfitForFee > 0n
        ? computeFeeAmount(realisedProfitForFee.toString(), policy.feePercent)
        : '0';

    // 10. Create assessment (starts as DRAFT, promoted to ASSESSED if feeAmount > 0)
    const status = BigInt(feeAmount) > 0n ? AssessmentStatus.ASSESSED : AssessmentStatus.DRAFT;

    const assessment = this.assessmentRepo.create({
      userId,
      brokerConnectionId,
      subscriptionId: null,
      invoiceId: null,
      currency: authoritativeCurrency,
      periodStart,
      periodEnd,
      startingHighWaterMark: startingHWM.toString(),
      endingRealisedBalance: currentTotalRealised.toString(),
      depositsExcluded: depositsExcluded.toString(),
      withdrawalsAdjusted: withdrawalsAdjusted.toString(),
      realisedProfitForFee: realisedProfitForFee.toString(),
      feePercent: policy.feePercent,
      feeAmount,
      status,
      calculationMetadata: {
        policyId: policy.id,
        policyName: policy.name,
        policyVersion: policy.version,
        policyEffectiveFrom: policy.effectiveFrom.toISOString(),
        billingFrequency: policy.billingFrequency,
        calculationMode: policy.calculationMode,
        periodLedgerEntryCount: ledgerEntries.length,
        periodRealisedPnL: periodRealisedPnL.toString(),
        calculatedAt: new Date().toISOString(),
      },
    });

    const saved = await this.assessmentRepo.save(assessment);

    // 11. Update running totals in TradingAccountPerformance
    await this.performanceRepo.update(performance.id, {
      totalRealisedProfit: currentTotalRealised.toString(),
      lastRealisedBalance: currentTotalRealised.toString(),
      lastCalculationAt: new Date(),
    });

    await this.auditService.log({
      actorUserId: adminId,
      actorType: 'ADMIN',
      action: AuditAction.PERFORMANCE_FEE_ASSESSMENT_CALCULATED,
      resourceType: 'PerformanceFeeAssessment',
      resourceId: saved.id,
      ipAddress,
      metadata: {
        targetUserId: userId,
        brokerConnectionId,
        currency,
        periodStart: periodStart.toISOString(),
        periodEnd: periodEnd.toISOString(),
        startingHWM: startingHWM.toString(),
        realisedProfitForFee: realisedProfitForFee.toString(),
        feePercent: policy.feePercent,
        feeAmount,
        status,
      },
      severity: AuditSeverity.INFO,
    });

    this.logger.log(
      `[PerfFee] Assessment ${saved.id} calculated for user ${userId}: feeAmount=${feeAmount}, status=${status}`,
    );
    return saved;
  }

  // -------------------------------------------------------------------------
  // Invoice assessment
  // -------------------------------------------------------------------------

  /**
   * Create an Invoice and PaymentTransaction for an ASSESSED performance fee.
   * Sets assessment status to INVOICED.
   *
   * RULES:
   * - Only assessments with status = ASSESSED can be invoiced.
   * - feeAmount must be > 0 (zero-fee assessments must not be invoiced).
   * - Does NOT mark paid — payment happens via verified webhook flow.
   * - Does NOT auto-withdraw from broker account.
   */
  async invoiceAssessment(
    assessmentId: string,
    adminId: string,
    ipAddress?: string,
  ): Promise<PerformanceFeeAssessment> {
    const assessment = await this.assessmentRepo.findOne({ where: { id: assessmentId } });
    if (!assessment) throw new NotFoundException('Assessment not found');

    if (assessment.status !== AssessmentStatus.ASSESSED) {
      throw new BadRequestException(
        `Assessment status is ${assessment.status}; only ASSESSED assessments can be invoiced`,
      );
    }

    if (BigInt(assessment.feeAmount) <= 0n) {
      throw new BadRequestException('Cannot invoice an assessment with zero fee amount');
    }

    // Create Invoice
    const invoiceNumber = `PF-${Date.now()}-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;
    const invoice = this.invoiceRepo.create({
      userId: assessment.userId,
      subscriptionId: null,
      invoiceNumber,
      status: InvoiceStatus.ISSUED,
      currency: assessment.currency,
      subtotalAmount: assessment.feeAmount,
      taxAmount: '0',
      totalAmount: assessment.feeAmount,
      dueDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 day payment window
      metadata: {
        type: 'PERFORMANCE_FEE',
        assessmentId: assessment.id,
        periodStart: assessment.periodStart.toISOString(),
        periodEnd: assessment.periodEnd.toISOString(),
        realisedProfitForFee: assessment.realisedProfitForFee,
        feePercent: assessment.feePercent,
      },
    });
    const savedInvoice = await this.invoiceRepo.save(invoice);

    // Create PaymentTransaction (PENDING — payment happens via webhook)
    const transaction = this.transactionRepo.create({
      userId: assessment.userId,
      subscriptionId: null,
      invoiceId: savedInvoice.id,
      provider: 'manual', // Provider selected by admin/user at payment time
      paymentPurpose: PaymentPurpose.PERFORMANCE_FEE,
      status: PaymentTransactionStatus.PENDING,
      currency: assessment.currency,
      amountMinor: assessment.feeAmount,
      countryCode: null,
      providerPayloadSummary: {
        assessmentId: assessment.id,
        invoiceId: savedInvoice.id,
        type: 'PERFORMANCE_FEE',
      },
    });
    await this.transactionRepo.save(transaction);

    // Update assessment
    assessment.invoiceId = savedInvoice.id;
    assessment.status = AssessmentStatus.INVOICED;
    const updatedAssessment = await this.assessmentRepo.save(assessment);

    // Add FEE_ASSESSED ledger entry
    await this.ledgerRepo.save({
      userId: assessment.userId,
      assessmentId: assessment.id,
      brokerConnectionId: assessment.brokerConnectionId,
      entryType: LedgerEntryType.FEE_ASSESSED,
      currency: assessment.currency,
      amount: `-${assessment.feeAmount}`, // negative — fee is a deduction
      sourceReference: assessment.id,
      occurredAt: new Date(),
      metadata: { invoiceId: savedInvoice.id, invoiceNumber },
    });

    await this.auditService.log({
      actorUserId: adminId,
      actorType: 'ADMIN',
      action: AuditAction.PERFORMANCE_FEE_ASSESSMENT_INVOICED,
      resourceType: 'PerformanceFeeAssessment',
      resourceId: assessment.id,
      ipAddress,
      metadata: {
        targetUserId: assessment.userId,
        invoiceId: savedInvoice.id,
        invoiceNumber,
        feeAmount: assessment.feeAmount,
        currency: assessment.currency,
      },
      severity: AuditSeverity.INFO,
    });

    await this.auditService.log({
      actorUserId: adminId,
      actorType: 'ADMIN',
      action: AuditAction.INVOICE_CREATED,
      resourceType: 'Invoice',
      resourceId: savedInvoice.id,
      ipAddress,
      metadata: {
        targetUserId: assessment.userId,
        type: 'PERFORMANCE_FEE',
        assessmentId: assessment.id,
        totalAmount: assessment.feeAmount,
        currency: assessment.currency,
      },
      severity: AuditSeverity.INFO,
    });

    this.logger.log(`[PerfFee] Assessment ${assessmentId} invoiced: invoice=${savedInvoice.id}`);
    return updatedAssessment;
  }

  // -------------------------------------------------------------------------
  // PAID-state + high-water-mark transition (Sprint 18 safety hardening)
  // -------------------------------------------------------------------------
  //
  // Sprint 18 removed the previously-orphaned `markAssessmentPaid(invoiceId)`
  // method from this service. That method transitioned an assessment to PAID
  // and updated the high-water mark directly, bypassing the payment-webhook
  // path. It had NO production callers (the webhook processor inlines its own
  // HWM logic in WebhookProcessorService.handlePerformanceFeePaymentSucceeded),
  // but its mere existence was a latent safety hazard: a future developer
  // could have wired it into a non-webhook flow and silently violated the
  // "HWM may update only through the verified performance-fee webhook success
  // path" invariant.
  //
  // The invariant is now enforced structurally:
  //   - This service does NOT expose any method that transitions an assessment
  //     to PAID or updates the high-water mark.
  //   - The ONLY production write path to assessment.status = PAID and to
  //     TradingAccountPerformance.currentHighWaterMark lives in
  //     WebhookProcessorService.handlePerformanceFeePaymentSucceeded, which
  //     runs exclusively after: verified provider webhook signature → matching
  //     amount → matching currency → transaction SUCCEEDED → invoice PAID.
  //   - The HWM update at that single site uses max(oldHWM, endingRealisedBalance)
  //     so the high-water mark can never regress.
  //
  // Do NOT reintroduce a direct markAssessmentPaid() / HWM-update method here.

  // -------------------------------------------------------------------------
  // Ledger entries
  // -------------------------------------------------------------------------

  /**
   * Record a manual ledger entry.
   *
   * RULES:
   * - Admin only.
   * - Must not record demo/paper/backtest entries.
   * - Losses should be passed as negative amounts.
   */
  async recordLedgerEntry(
    dto: CreateLedgerEntryDto,
    adminId: string,
    ipAddress?: string,
  ): Promise<PerformanceFeeLedgerEntry> {
    const entry = this.ledgerRepo.create({
      userId: dto.userId,
      assessmentId: dto.assessmentId ?? null,
      brokerConnectionId: dto.brokerConnectionId ?? null,
      entryType: dto.entryType,
      currency: dto.currency,
      amount: dto.amount,
      sourceReference: dto.sourceReference ?? null,
      occurredAt: new Date(dto.occurredAt),
      metadata: null,
    });
    const saved = await this.ledgerRepo.save(entry);

    await this.auditService.log({
      actorUserId: adminId,
      actorType: 'ADMIN',
      action: AuditAction.PERFORMANCE_FEE_LEDGER_ENTRY_CREATED,
      resourceType: 'PerformanceFeeLedgerEntry',
      resourceId: saved.id,
      ipAddress,
      metadata: {
        targetUserId: dto.userId,
        entryType: dto.entryType,
        currency: dto.currency,
        amount: dto.amount,
        brokerConnectionId: dto.brokerConnectionId ?? null,
        occurredAt: dto.occurredAt,
      },
      severity: AuditSeverity.INFO,
    });

    return saved;
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  async getCurrentHighWaterMark(
    userId: string,
    brokerConnectionId: string | null,
    _currency: string,
  ): Promise<string> {
    const performance = await this.performanceRepo.findOne({
      where: {
        userId,
        brokerConnectionId: this.brokerScope(brokerConnectionId),
      } as FindOptionsWhere<TradingAccountPerformance>,
    });
    return performance?.currentHighWaterMark ?? '0';
  }

  private async getOrCreatePerformance(
    userId: string,
    brokerConnectionId: string | null,
    currency: string,
  ): Promise<TradingAccountPerformance> {
    const existing = await this.performanceRepo.findOne({
      where: {
        userId,
        brokerConnectionId: this.brokerScope(brokerConnectionId),
      } as FindOptionsWhere<TradingAccountPerformance>,
    });
    if (existing) return existing;

    const perf = this.performanceRepo.create({ userId, brokerConnectionId, currency });
    return this.performanceRepo.save(perf);
  }

  /**
   * Resolve the single active GLOBAL performance fee policy.
   *
   * Subscription-retirement invariant: assessment is decoupled from any user
   * subscription. The system MUST have exactly ONE active global policy
   * (plan_id IS NULL & isActive = true) before any assessment can run. This
   * method is the single source of truth for that lookup and fails loudly when
   * the configuration is missing or ambiguous so the operator can fix it before
   * billing proceeds.
   *
   * Throws:
   *   - BadRequestException when no active global policy exists.
   *   - BadRequestException when more than one active global policy exists
   *     (ambiguous configuration — could charge the wrong fee percent).
   */
  async findActiveGlobalPolicy(): Promise<PerformanceFeePolicy> {
    const globalPolicies = await this.policyRepo.find({
      where: { planId: IsNull(), isActive: true },
    });

    if (globalPolicies.length === 0) {
      throw new BadRequestException(
        'No active global performance fee policy configured — cannot assess ' +
          'performance fee. Configure one before enabling billing.',
      );
    }

    if (globalPolicies.length > 1) {
      throw new BadRequestException(
        'Multiple active global performance fee policies found — ambiguous ' +
          'configuration. Ensure exactly one active global policy exists.',
      );
    }

    return globalPolicies[0];
  }

  /**
   * Build a broker-scoped where filter.
   * For a null brokerConnectionId we must use IsNull() so the query targets the
   * exact (user, no-broker) row. TypeORM strips `undefined`, which would
   * incorrectly match ANY of the user's broker accounts.
   */
  private brokerScope(brokerConnectionId: string | null): string | ReturnType<typeof IsNull> {
    return brokerConnectionId === null ? IsNull() : brokerConnectionId;
  }

  private async findExistingAssessment(
    userId: string,
    brokerConnectionId: string | null,
    periodStart: Date,
    periodEnd: Date,
  ): Promise<PerformanceFeeAssessment | null> {
    return this.assessmentRepo.findOne({
      where: {
        userId,
        brokerConnectionId: this.brokerScope(brokerConnectionId),
        periodStart,
        periodEnd,
      } as FindOptionsWhere<PerformanceFeeAssessment>,
    });
  }

  /**
   * Find any unresolved (ASSESSED or INVOICED) assessment for this user/broker.
   * Used to prevent stacking unpaid assessments against a stale high-water mark.
   */
  private async findOutstandingAssessment(
    userId: string,
    brokerConnectionId: string | null,
  ): Promise<PerformanceFeeAssessment | null> {
    return this.assessmentRepo.findOne({
      where: {
        userId,
        brokerConnectionId: this.brokerScope(brokerConnectionId),
        status: In([AssessmentStatus.ASSESSED, AssessmentStatus.INVOICED]),
      } as FindOptionsWhere<PerformanceFeeAssessment>,
    });
  }
}
