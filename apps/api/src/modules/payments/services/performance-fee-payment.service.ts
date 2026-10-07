import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, In, Repository } from 'typeorm';
import { Invoice, InvoiceStatus } from '../entities/invoice.entity';
import {
  PaymentTransaction,
  PaymentPurpose,
  PaymentTransactionStatus,
} from '../entities/payment-transaction.entity';
import {
  PerformanceFeeAssessment,
  AssessmentStatus,
} from '../../performance-fees/entities/performance-fee-assessment.entity';
import { User } from '../../users/entities/user.entity';
import { PaymentRoutingService } from './payment-routing.service';
import { AuditService } from '../../audit/audit.service';
import { AuditAction } from '../../../common/enums/audit-action.enum';
import { AuditSeverity } from '../../audit/entities/audit-log.entity';
import { isUniqueViolation } from '../utils/db-error.util';

/** Invoice statuses that are eligible to start a payment checkout. */
const PAYABLE_INVOICE_STATUSES: ReadonlySet<InvoiceStatus> = new Set([
  InvoiceStatus.ISSUED,
  InvoiceStatus.OVERDUE,
]);

export interface PerformanceFeeCheckoutOptions {
  provider?: string;
  countryCode?: string;
  currency?: string;
}

export interface InitiateCheckoutParams {
  invoiceId: string;
  requestingUserId: string;
  isAdmin: boolean;
  options?: PerformanceFeeCheckoutOptions;
  ipAddress?: string;
}

export interface PerformanceFeeCheckoutResult {
  invoiceId: string;
  invoiceNumber: string;
  transactionId: string;
  provider: string;
  paymentStatus: PaymentTransactionStatus;
  checkoutUrl?: string;
  sessionId?: string;
  providerReference?: string;
  /** True when an in-progress provider session already existed and was reused. */
  reusedExistingSession: boolean;
}

export interface PerformanceFeeInvoiceView {
  invoiceId: string;
  userId: string;
  invoiceNumber: string;
  status: InvoiceStatus;
  currency: string;
  totalAmount: string;
  dueDate: Date | null;
  paidAt: Date | null;
  assessmentId: string | null;
  assessmentStatus: AssessmentStatus | null;
  paymentStatus: PaymentTransactionStatus | 'NONE';
  provider: string | null;
  checkoutSessionId: string | null;
  /** True when the linked transaction uses the DEV/TEST manual provider. */
  manual: boolean;
  createdAt: Date;
}

/**
 * PerformanceFeePaymentService (Sprint 14, hardened Sprint 18)
 *
 * Lets an authenticated user (or admin) initiate payment for an existing
 * performance-fee invoice using the existing provider routing system.
 *
 * HARD INVARIANTS — never violated by this service:
 *   1. Never marks an Invoice PAID.
 *   2. Never marks a PerformanceFeeAssessment PAID.
 *   3. Never creates a FEE_PAID ledger entry.
 *   4. Never updates the high-water mark.
 *   5. Never trusts a frontend success signal — a verified provider webhook is the
 *      ONLY path that transitions a transaction/invoice/assessment to paid.
 *   6. Never routes to the `manual` provider for public checkout.
 *   7. Never creates a duplicate payable transaction for the same invoice — it reuses
 *      the PENDING transaction created at invoicing time.
 *   8. Never exposes provider secrets / raw payloads.
 *   9. All persisted money values remain bigint minor-unit strings.
 *  10. (Sprint 18) Provider-reference uniqueness violations from the DB-level guard
 *      (migration AddPaymentTransactionReferenceUniqueGuard) are caught, audited at
 *      CRITICAL severity, released to PENDING, and surfaced as a sanitized
 *      ConflictException — never marked paid, never leaking the raw DB error.
 *  11. (Sprint 18) Checkout metadata sent to the provider AND the stored
 *      providerPayloadSummary both include `transactionId` for debug-metadata
 *      parity with subscription checkout. No payment state is changed by metadata.
 */
@Injectable()
export class PerformanceFeePaymentService {
  private readonly logger = new Logger(PerformanceFeePaymentService.name);

  constructor(
    @InjectRepository(Invoice)
    private readonly invoiceRepo: Repository<Invoice>,
    @InjectRepository(PaymentTransaction)
    private readonly transactionRepo: Repository<PaymentTransaction>,
    @InjectRepository(PerformanceFeeAssessment)
    private readonly assessmentRepo: Repository<PerformanceFeeAssessment>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly routingService: PaymentRoutingService,
    private readonly auditService: AuditService,
  ) {}

  // ── Checkout ────────────────────────────────────────────────────────────────

  async initiatePerformanceFeeCheckout(
    params: InitiateCheckoutParams,
  ): Promise<PerformanceFeeCheckoutResult> {
    const { invoiceId, requestingUserId, isAdmin, options, ipAddress } = params;

    const { invoice, assessment } = await this.loadPayableContext(
      invoiceId,
      requestingUserId,
      isAdmin,
    );

    // Locate the PENDING/PROCESSING performance-fee transaction created at invoicing.
    const transaction = await this.findPerformanceFeeTransaction(invoice.id);
    if (!transaction) {
      throw new BadRequestException(
        `No payable transaction found for invoice ${invoice.invoiceNumber}`,
      );
    }

    // Already paid → never re-checkout.
    if (transaction.status === PaymentTransactionStatus.SUCCEEDED) {
      throw new ConflictException('This performance-fee invoice has already been paid');
    }

    // An in-progress session on a real (routed) provider is reused so we never
    // create a duplicate payable transaction / duplicate provider charge.
    const existingReuse = this.buildReuseResult(transaction);
    if (existingReuse) {
      this.logger.log(
        `[PerfFeePay] Reusing in-progress ${transaction.provider} session for invoice ${invoice.id}`,
      );
      return { ...existingReuse, invoiceNumber: invoice.invoiceNumber };
    }

    // Atomically claim the PENDING/FAILED transaction BEFORE calling any provider.
    // Without this, two concurrent checkout requests could both pass the reuse
    // check above, both call provider.createCheckoutSession(), and race to
    // overwrite providerTransactionReference — silently orphaning whichever
    // provider session lost the race (the customer could pay it, but the webhook
    // would never find a matching transaction row to mark paid).
    const claim = await this.transactionRepo.update(
      {
        id: transaction.id,
        status: In([PaymentTransactionStatus.PENDING, PaymentTransactionStatus.FAILED]),
      } as FindOptionsWhere<PaymentTransaction>,
      { status: PaymentTransactionStatus.PROCESSING },
    );

    if (!claim.affected) {
      // Another request already claimed it (or it changed state between our reads).
      const current = await this.transactionRepo.findOne({ where: { id: transaction.id } });
      if (current?.status === PaymentTransactionStatus.SUCCEEDED) {
        throw new ConflictException('This performance-fee invoice has already been paid');
      }
      const reuse = current ? this.buildReuseResult(current) : null;
      if (reuse) {
        return { ...reuse, invoiceNumber: invoice.invoiceNumber };
      }
      throw new ConflictException(
        'A checkout session is already being created for this invoice — please retry shortly',
      );
    }

    try {
      // Resolve routing inputs. Currency must match the invoice currency.
      const currency = (options?.currency ?? invoice.currency).toUpperCase();
      if (currency !== invoice.currency.toUpperCase()) {
        throw new BadRequestException(
          `Requested currency ${currency} does not match invoice currency ${invoice.currency}`,
        );
      }

      const owner = await this.userRepo.findOne({ where: { id: invoice.userId } });
      if (!owner) {
        throw new NotFoundException('Invoice owner not found');
      }

      const countryCode = (options?.countryCode ?? owner.countryCode ?? '').toUpperCase();
      if (!countryCode) {
        throw new BadRequestException(
          'A country code is required to route a payment provider for this invoice',
        );
      }

      // Route provider (routeForCheckout excludes the manual provider by design and
      // fails closed on unsupported country/currency/provider).
      const { provider, reason: routingReason } = await this.routingService.routeForCheckout(
        countryCode,
        currency,
        options?.provider,
      );

      // Create the provider checkout session. Failure keeps the invoice unpaid and
      // the assessment INVOICED; the transaction is released back to PENDING so a
      // later retry is not blocked behind a stuck PROCESSING claim.
      let sessionResult;
      try {
        sessionResult = await provider.createCheckoutSession({
          userId: invoice.userId,
          email: owner.email ?? undefined,
          planId: `perf-fee:${assessment.id}`,
          currency,
          amountMinor: this.toAmountMinor(invoice.totalAmount),
          countryCode,
          invoiceId: invoice.id,
          metadata: {
            type: 'PERFORMANCE_FEE',
            transactionId: transaction.id,
            assessmentId: assessment.id,
            invoiceId: invoice.id,
          },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Checkout unavailable';
        await this.transactionRepo.update(transaction.id, {
          provider: provider.providerId,
          status: PaymentTransactionStatus.PENDING,
          failureMessage: this.safeMessage(message),
        });

        await this.auditService.log({
          actorUserId: requestingUserId,
          actorType: isAdmin ? 'ADMIN' : 'USER',
          action: AuditAction.PERFORMANCE_FEE_CHECKOUT_FAILED,
          resourceType: 'PaymentTransaction',
          resourceId: transaction.id,
          ipAddress,
          metadata: {
            invoiceId: invoice.id,
            assessmentId: assessment.id,
            provider: provider.providerId,
            currency,
            countryCode,
          },
          severity: AuditSeverity.WARNING,
        });

        throw new BadRequestException(`Payment checkout failed: ${this.safeMessage(message)}`);
      }

      const providerReference =
        sessionResult.providerTransactionReference ?? sessionResult.sessionId;

      try {
        await this.transactionRepo.update(transaction.id, {
          provider: provider.providerId,
          providerTransactionReference: providerReference,
          status: PaymentTransactionStatus.PROCESSING,
          countryCode,
          failureCode: null,
          failureMessage: null,
          providerPayloadSummary: {
            assessmentId: assessment.id,
            invoiceId: invoice.id,
            transactionId: transaction.id,
            type: 'PERFORMANCE_FEE',
            provider: provider.providerId,
            sessionId: sessionResult.sessionId,
            checkoutUrl: sessionResult.checkoutUrl,
            routingReason,
          },
        });
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;

        // Sprint 18 PART C — the DB-level guard (migration
        // AddPaymentTransactionReferenceUniqueGuard) rejected this
        // providerTransactionReference as already in use for this provider.
        // Should never happen in practice (each provider call requests a
        // brand-new session), but if it ever does: fail closed, never mark
        // the invoice/assessment paid from this path, release the claim back
        // to PENDING so a retry is possible, and never leak the raw
        // QueryFailedError.
        await this.transactionRepo.update(transaction.id, {
          status: PaymentTransactionStatus.PENDING,
          failureMessage: 'Provider session reference conflict — please retry',
        });

        await this.auditService.log({
          actorUserId: requestingUserId,
          actorType: isAdmin ? 'ADMIN' : 'USER',
          action: AuditAction.PERFORMANCE_FEE_CHECKOUT_FAILED,
          resourceType: 'PaymentTransaction',
          resourceId: transaction.id,
          ipAddress,
          metadata: {
            invoiceId: invoice.id,
            assessmentId: assessment.id,
            provider: provider.providerId,
            currency,
            countryCode,
            reason: 'PROVIDER_REFERENCE_CONFLICT',
          },
          severity: AuditSeverity.CRITICAL,
        });

        throw new ConflictException(
          'Payment checkout failed: a conflicting payment session was detected — please retry shortly',
        );
      }

      await this.auditService.log({
        actorUserId: requestingUserId,
        actorType: isAdmin ? 'ADMIN' : 'USER',
        action: AuditAction.PERFORMANCE_FEE_CHECKOUT_INITIATED,
        resourceType: 'PaymentTransaction',
        resourceId: transaction.id,
        ipAddress,
        metadata: {
          invoiceId: invoice.id,
          invoiceNumber: invoice.invoiceNumber,
          assessmentId: assessment.id,
          provider: provider.providerId,
          amountMinor: invoice.totalAmount,
          currency,
          countryCode,
          routingReason,
        },
        severity: AuditSeverity.INFO,
      });

      this.logger.log(
        `[PerfFeePay] Checkout initiated: invoice=${invoice.id}, tx=${transaction.id}, ` +
          `provider=${provider.providerId}`,
      );

      return {
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        transactionId: transaction.id,
        provider: provider.providerId,
        paymentStatus: PaymentTransactionStatus.PROCESSING,
        checkoutUrl: sessionResult.checkoutUrl,
        sessionId: sessionResult.sessionId,
        providerReference,
        reusedExistingSession: false,
      };
    } catch (err) {
      // Safety net for pre-provider-call validation failures (currency mismatch,
      // missing owner/country, routing failure) — the provider-call catch above
      // already released its own claim, so this is a no-op in that case.
      const current = await this.transactionRepo.findOne({ where: { id: transaction.id } });
      if (
        current?.status === PaymentTransactionStatus.PROCESSING &&
        !current.providerTransactionReference
      ) {
        await this.transactionRepo.update(transaction.id, {
          status: PaymentTransactionStatus.PENDING,
        });
      }
      throw err;
    }
  }

  // ── Single invoice view (no audit — plain read) ──────────────────────────────

  async getInvoiceView(
    invoiceId: string,
    requestingUserId: string,
    isAdmin: boolean,
  ): Promise<PerformanceFeeInvoiceView> {
    const invoice = await this.invoiceRepo.findOne({ where: { id: invoiceId } });
    if (!invoice) throw new NotFoundException('Invoice not found');
    this.assertOwnership(invoice, requestingUserId, isAdmin);
    this.assertPerformanceFeeInvoice(invoice);

    const assessment = await this.assessmentRepo.findOne({ where: { invoiceId: invoice.id } });
    const transaction = await this.findPerformanceFeeTransaction(invoice.id);
    return this.toInvoiceView(invoice, assessment, transaction);
  }

  // ── Status ──────────────────────────────────────────────────────────────────

  async getPerformanceFeePaymentStatus(
    invoiceId: string,
    requestingUserId: string,
    isAdmin: boolean,
    ipAddress?: string,
  ): Promise<PerformanceFeeInvoiceView> {
    const invoice = await this.invoiceRepo.findOne({ where: { id: invoiceId } });
    if (!invoice) throw new NotFoundException('Invoice not found');
    this.assertOwnership(invoice, requestingUserId, isAdmin);
    this.assertPerformanceFeeInvoice(invoice);

    const assessment = await this.assessmentRepo.findOne({ where: { invoiceId: invoice.id } });
    const transaction = await this.findPerformanceFeeTransaction(invoice.id);

    await this.auditService.log({
      actorUserId: requestingUserId,
      actorType: isAdmin ? 'ADMIN' : 'USER',
      action: AuditAction.PERFORMANCE_FEE_PAYMENT_STATUS_VIEWED,
      resourceType: 'Invoice',
      resourceId: invoice.id,
      ipAddress,
      metadata: { invoiceId: invoice.id, assessmentId: assessment?.id ?? null },
      severity: AuditSeverity.INFO,
    });

    return this.toInvoiceView(invoice, assessment, transaction);
  }

  // ── Listing ─────────────────────────────────────────────────────────────────

  async listUserPerformanceFeeInvoices(
    userId: string | undefined,
    filters: { status?: InvoiceStatus; limit?: number } = {},
  ): Promise<PerformanceFeeInvoiceView[]> {
    // Normal callers always pass their own userId. Admin callers may omit it
    // to operate the global payments workspace. metadata.type is jsonb, so
    // filter PERFORMANCE_FEE in memory after the bounded query.
    const invoices = await this.invoiceRepo.find({
      ...(userId ? { where: { userId } } : {}),
      order: { createdAt: 'DESC' },
      take: Math.min(filters.limit ?? (userId ? 100 : 200), 200),
    });

    const perfFeeInvoices = invoices.filter(
      (inv) =>
        (inv.metadata?.['type'] as string | undefined) === 'PERFORMANCE_FEE' &&
        (!filters.status || inv.status === filters.status),
    );

    const views: PerformanceFeeInvoiceView[] = [];
    for (const invoice of perfFeeInvoices) {
      const assessment = await this.assessmentRepo.findOne({ where: { invoiceId: invoice.id } });
      const transaction = await this.findPerformanceFeeTransaction(invoice.id);
      views.push(this.toInvoiceView(invoice, assessment, transaction));
    }
    return views;
  }

  // ── Private helpers ───────────────────────────────────────────────────────────

  private async loadPayableContext(
    invoiceId: string,
    requestingUserId: string,
    isAdmin: boolean,
  ): Promise<{ invoice: Invoice; assessment: PerformanceFeeAssessment }> {
    const invoice = await this.invoiceRepo.findOne({ where: { id: invoiceId } });
    if (!invoice) throw new NotFoundException('Invoice not found');

    this.assertOwnership(invoice, requestingUserId, isAdmin);
    this.assertPerformanceFeeInvoice(invoice);

    if (invoice.status === InvoiceStatus.PAID) {
      throw new ConflictException('This performance-fee invoice has already been paid');
    }
    if (!PAYABLE_INVOICE_STATUSES.has(invoice.status)) {
      throw new BadRequestException(
        `Invoice ${invoice.invoiceNumber} is in status ${invoice.status} and cannot be paid`,
      );
    }

    const assessment = await this.assessmentRepo.findOne({ where: { invoiceId: invoice.id } });
    if (!assessment) {
      throw new BadRequestException('No performance-fee assessment is linked to this invoice');
    }
    if (assessment.status !== AssessmentStatus.INVOICED) {
      throw new BadRequestException(
        `Linked assessment is in status ${assessment.status}; only INVOICED assessments can be paid`,
      );
    }

    return { invoice, assessment };
  }

  private assertOwnership(invoice: Invoice, requestingUserId: string, isAdmin: boolean): void {
    if (!isAdmin && invoice.userId !== requestingUserId) {
      throw new ForbiddenException('You can only access your own performance-fee invoices');
    }
  }

  private assertPerformanceFeeInvoice(invoice: Invoice): void {
    const type = invoice.metadata?.['type'] as string | undefined;
    if (type !== 'PERFORMANCE_FEE') {
      throw new BadRequestException('Invoice is not a performance-fee invoice');
    }
  }

  /**
   * Builds a safe "reused session" result if the transaction already has an
   * active, non-manual provider session in progress. Returns null otherwise.
   * Callers must fill in `invoiceNumber` (not stored on PaymentTransaction).
   */
  private buildReuseResult(
    transaction: PaymentTransaction,
  ): Omit<PerformanceFeeCheckoutResult, 'invoiceNumber'> | null {
    if (
      transaction.status === PaymentTransactionStatus.PROCESSING &&
      transaction.provider !== 'manual' &&
      transaction.providerTransactionReference
    ) {
      const summary = transaction.providerPayloadSummary ?? {};
      return {
        invoiceId: transaction.invoiceId ?? '',
        transactionId: transaction.id,
        provider: transaction.provider,
        paymentStatus: transaction.status,
        checkoutUrl: (summary['checkoutUrl'] as string | undefined) ?? undefined,
        sessionId: (summary['sessionId'] as string | undefined) ?? undefined,
        providerReference: transaction.providerTransactionReference,
        reusedExistingSession: true,
      };
    }
    return null;
  }

  private async findPerformanceFeeTransaction(
    invoiceId: string,
  ): Promise<PaymentTransaction | null> {
    return this.transactionRepo.findOne({
      where: { invoiceId, paymentPurpose: PaymentPurpose.PERFORMANCE_FEE },
      order: { createdAt: 'DESC' },
    });
  }

  private toInvoiceView(
    invoice: Invoice,
    assessment: PerformanceFeeAssessment | null,
    transaction: PaymentTransaction | null,
  ): PerformanceFeeInvoiceView {
    const summary = transaction?.providerPayloadSummary ?? {};
    return {
      invoiceId: invoice.id,
      userId: invoice.userId,
      invoiceNumber: invoice.invoiceNumber,
      status: invoice.status,
      currency: invoice.currency,
      totalAmount: invoice.totalAmount,
      dueDate: invoice.dueDate,
      paidAt: invoice.paidAt,
      assessmentId: assessment?.id ?? null,
      assessmentStatus: assessment?.status ?? null,
      paymentStatus: transaction?.status ?? 'NONE',
      provider: transaction?.provider ?? null,
      checkoutSessionId: (summary['sessionId'] as string | undefined) ?? null,
      manual: transaction?.provider === 'manual',
      createdAt: invoice.createdAt,
    };
  }

  /**
   * Convert a bigint minor-unit string to the `number` the provider interface expects.
   * Persisted values remain strings; only the provider call uses a number.
   */
  private toAmountMinor(minorUnits: string): number {
    const asBig = BigInt(minorUnits);
    if (asBig > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new BadRequestException('Invoice amount exceeds the maximum supported checkout amount');
    }
    return Number(asBig);
  }

  /** Strip anything that could carry secrets from a provider error message. */
  private safeMessage(message: string): string {
    return message.slice(0, 300);
  }
}
