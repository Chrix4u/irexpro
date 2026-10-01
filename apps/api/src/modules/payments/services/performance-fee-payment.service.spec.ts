import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
import { PerformanceFeePaymentService } from './performance-fee-payment.service';
import { InvoiceStatus } from '../entities/invoice.entity';
import { PaymentPurpose, PaymentTransactionStatus } from '../entities/payment-transaction.entity';
import { AssessmentStatus } from '../../performance-fees/entities/performance-fee-assessment.entity';

const OWNER = 'user-1';
const ADMIN = 'admin-1';

function makeInvoice(overrides: Record<string, unknown> = {}) {
  return {
    id: 'invoice-1',
    userId: OWNER,
    invoiceNumber: 'PF-123',
    status: InvoiceStatus.ISSUED,
    currency: 'USD',
    totalAmount: '100000',
    dueDate: new Date('2026-07-10T00:00:00Z'),
    paidAt: null,
    metadata: { type: 'PERFORMANCE_FEE', assessmentId: 'assessment-1' },
    createdAt: new Date('2026-06-01T00:00:00Z'),
    ...overrides,
  };
}

function makeAssessment(overrides: Record<string, unknown> = {}) {
  return {
    id: 'assessment-1',
    userId: OWNER,
    invoiceId: 'invoice-1',
    status: AssessmentStatus.INVOICED,
    currency: 'USD',
    feeAmount: '100000',
    ...overrides,
  };
}

function makeTransaction(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tx-1',
    userId: OWNER,
    invoiceId: 'invoice-1',
    provider: 'manual',
    providerTransactionReference: null,
    paymentPurpose: PaymentPurpose.PERFORMANCE_FEE,
    status: PaymentTransactionStatus.PENDING,
    currency: 'USD',
    amountMinor: '100000',
    providerPayloadSummary: { type: 'PERFORMANCE_FEE' },
    ...overrides,
  };
}

function makeOwner(overrides: Record<string, unknown> = {}) {
  return { id: OWNER, email: 'owner@example.com', countryCode: 'US', ...overrides };
}

let invoiceRepo: any;
let transactionRepo: any;
let assessmentRepo: any;
let userRepo: any;
let routingService: any;
let auditService: any;
let mockProvider: any;
let service: PerformanceFeePaymentService;

beforeEach(() => {
  jest.clearAllMocks();

  invoiceRepo = {
    findOne: jest.fn(async () => makeInvoice()),
    find: jest.fn(async () => [makeInvoice()]),
    update: jest.fn(async () => undefined),
  };
  transactionRepo = {
    findOne: jest.fn(async () => makeTransaction()),
    update: jest.fn(async () => ({ affected: 1 })),
  };
  assessmentRepo = {
    findOne: jest.fn(async () => makeAssessment()),
  };
  userRepo = {
    findOne: jest.fn(async () => makeOwner()),
  };
  mockProvider = {
    providerId: 'stripe',
    createCheckoutSession: jest.fn(async () => ({
      sessionId: 'sess_123',
      checkoutUrl: 'https://pay.stripe.test/sess_123',
      providerTransactionReference: 'pi_123',
      provider: 'stripe',
    })),
  };
  routingService = {
    routeForCheckout: jest.fn(async () => ({ provider: mockProvider, reason: 'country_config' })),
  };
  auditService = { log: jest.fn(async () => undefined) };

  service = new PerformanceFeePaymentService(
    invoiceRepo,
    transactionRepo,
    assessmentRepo,
    userRepo,
    routingService,
    auditService,
  );
});

describe('initiatePerformanceFeeCheckout', () => {
  const base = { invoiceId: 'invoice-1', requestingUserId: OWNER, isAdmin: false };

  it('user can initiate checkout for own invoice; assigns routed provider and returns checkout url', async () => {
    const result = await service.initiatePerformanceFeeCheckout(base);

    expect(routingService.routeForCheckout).toHaveBeenCalledWith('US', 'USD', undefined);
    expect(mockProvider.createCheckoutSession).toHaveBeenCalledTimes(1);
    expect(transactionRepo.update).toHaveBeenCalledWith(
      'tx-1',
      expect.objectContaining({
        provider: 'stripe',
        providerTransactionReference: 'pi_123',
        status: PaymentTransactionStatus.PROCESSING,
      }),
    );
    expect(result.checkoutUrl).toBe('https://pay.stripe.test/sess_123');
    expect(result.provider).toBe('stripe');
    expect(result.reusedExistingSession).toBe(false);
    // Never mark paid
    expect(invoiceRepo.update).not.toHaveBeenCalled();
  });

  it('never marks invoice or assessment PAID and never touches HWM (no perf repo dependency)', async () => {
    await service.initiatePerformanceFeeCheckout(base);
    // Invoice not updated to PAID
    expect(invoiceRepo.update).not.toHaveBeenCalled();
    // Assessment repo is read-only in this service (no update method wired)
    expect((assessmentRepo as { update?: unknown }).update).toBeUndefined();
  });

  it('normal user cannot initiate checkout for another user invoice (403)', async () => {
    invoiceRepo.findOne.mockResolvedValueOnce(makeInvoice({ userId: 'other-user' }));
    await expect(
      service.initiatePerformanceFeeCheckout({ ...base, requestingUserId: OWNER }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(mockProvider.createCheckoutSession).not.toHaveBeenCalled();
  });

  it('admin can initiate checkout for any user invoice', async () => {
    invoiceRepo.findOne.mockResolvedValueOnce(makeInvoice({ userId: 'other-user' }));
    userRepo.findOne.mockResolvedValueOnce(makeOwner({ id: 'other-user' }));
    const result = await service.initiatePerformanceFeeCheckout({
      invoiceId: 'invoice-1',
      requestingUserId: ADMIN,
      isAdmin: true,
    });
    expect(result.provider).toBe('stripe');
  });

  it('rejects a paid invoice', async () => {
    invoiceRepo.findOne.mockResolvedValueOnce(makeInvoice({ status: InvoiceStatus.PAID }));
    await expect(service.initiatePerformanceFeeCheckout(base)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('rejects a void/cancelled invoice', async () => {
    invoiceRepo.findOne.mockResolvedValueOnce(makeInvoice({ status: InvoiceStatus.VOID }));
    await expect(service.initiatePerformanceFeeCheckout(base)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rejects a non-performance-fee invoice', async () => {
    invoiceRepo.findOne.mockResolvedValueOnce(makeInvoice({ metadata: { type: 'SUBSCRIPTION' } }));
    await expect(service.initiatePerformanceFeeCheckout(base)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rejects when assessment is missing', async () => {
    assessmentRepo.findOne.mockResolvedValueOnce(null);
    await expect(service.initiatePerformanceFeeCheckout(base)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rejects when assessment is not INVOICED', async () => {
    assessmentRepo.findOne.mockResolvedValueOnce(makeAssessment({ status: AssessmentStatus.PAID }));
    await expect(service.initiatePerformanceFeeCheckout(base)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('reuses an in-progress non-manual provider session without duplicating the transaction', async () => {
    transactionRepo.findOne.mockResolvedValueOnce(
      makeTransaction({
        provider: 'stripe',
        status: PaymentTransactionStatus.PROCESSING,
        providerTransactionReference: 'pi_existing',
        providerPayloadSummary: {
          type: 'PERFORMANCE_FEE',
          sessionId: 'sess_existing',
          checkoutUrl: 'https://pay.stripe.test/sess_existing',
        },
      }),
    );

    const result = await service.initiatePerformanceFeeCheckout(base);

    expect(result.reusedExistingSession).toBe(true);
    expect(result.providerReference).toBe('pi_existing');
    expect(mockProvider.createCheckoutSession).not.toHaveBeenCalled();
    expect(routingService.routeForCheckout).not.toHaveBeenCalled();
  });

  it('rejects checkout when transaction already SUCCEEDED', async () => {
    transactionRepo.findOne.mockResolvedValueOnce(
      makeTransaction({ status: PaymentTransactionStatus.SUCCEEDED }),
    );
    await expect(service.initiatePerformanceFeeCheckout(base)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('provider failure keeps invoice unpaid, records failure, does not mark paid', async () => {
    mockProvider.createCheckoutSession.mockRejectedValueOnce(new Error('gateway down'));
    await expect(service.initiatePerformanceFeeCheckout(base)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(invoiceRepo.update).not.toHaveBeenCalled();
    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'PERFORMANCE_FEE_CHECKOUT_FAILED' }),
    );
  });

  it('provider failure releases the claimed transaction back to PENDING so a retry is possible', async () => {
    mockProvider.createCheckoutSession.mockRejectedValueOnce(new Error('gateway down'));
    await expect(service.initiatePerformanceFeeCheckout(base)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(transactionRepo.update).toHaveBeenCalledWith(
      'tx-1',
      expect.objectContaining({ status: PaymentTransactionStatus.PENDING }),
    );
  });

  it('concurrent checkout race: second request detects the first request already claimed the transaction and safely reuses its session instead of creating a duplicate provider session', async () => {
    // Simulate: request A already atomically claimed tx-1 (PENDING/FAILED -> PROCESSING)
    // and obtained a provider session, right before request B's own claim attempt runs.
    transactionRepo.update.mockResolvedValueOnce({ affected: 0 });
    transactionRepo.findOne
      .mockResolvedValueOnce(makeTransaction()) // initial lookup (still PENDING from B's view)
      .mockResolvedValueOnce(
        makeTransaction({
          status: PaymentTransactionStatus.PROCESSING,
          provider: 'stripe',
          providerTransactionReference: 'pi_winner',
          providerPayloadSummary: {
            sessionId: 'sess_winner',
            checkoutUrl: 'https://pay.stripe.test/sess_winner',
          },
        }),
      );

    const result = await service.initiatePerformanceFeeCheckout(base);

    expect(result.reusedExistingSession).toBe(true);
    expect(result.providerReference).toBe('pi_winner');
    // Request B must never call the provider itself — that would create a second session.
    expect(mockProvider.createCheckoutSession).not.toHaveBeenCalled();
    expect(routingService.routeForCheckout).not.toHaveBeenCalled();
  });

  it('concurrent checkout race: claim lost while the winner has not yet obtained a provider session returns a safe conflict instead of duplicating', async () => {
    transactionRepo.update.mockResolvedValueOnce({ affected: 0 });
    transactionRepo.findOne
      .mockResolvedValueOnce(makeTransaction())
      .mockResolvedValueOnce(makeTransaction({ status: PaymentTransactionStatus.PROCESSING }));

    await expect(service.initiatePerformanceFeeCheckout(base)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(mockProvider.createCheckoutSession).not.toHaveBeenCalled();
    expect(routingService.routeForCheckout).not.toHaveBeenCalled();
  });

  it('concurrent checkout race: claim lost after the invoice was already paid by the winner rejects with Conflict', async () => {
    transactionRepo.update.mockResolvedValueOnce({ affected: 0 });
    transactionRepo.findOne
      .mockResolvedValueOnce(makeTransaction())
      .mockResolvedValueOnce(makeTransaction({ status: PaymentTransactionStatus.SUCCEEDED }));

    await expect(service.initiatePerformanceFeeCheckout(base)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(mockProvider.createCheckoutSession).not.toHaveBeenCalled();
  });

  it('propagates routing failure (unsupported provider/country)', async () => {
    routingService.routeForCheckout.mockRejectedValueOnce(new BadRequestException('no provider'));
    await expect(service.initiatePerformanceFeeCheckout(base)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(mockProvider.createCheckoutSession).not.toHaveBeenCalled();
  });

  it('rejects when currency does not match the invoice', async () => {
    await expect(
      service.initiatePerformanceFeeCheckout({ ...base, options: { currency: 'EUR' } }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects when no country code can be resolved', async () => {
    userRepo.findOne.mockResolvedValueOnce(makeOwner({ countryCode: null }));
    await expect(service.initiatePerformanceFeeCheckout(base)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rejects an invoice amount that overflows the provider interface number conversion, without calling the provider or marking paid', async () => {
    // Number.MAX_SAFE_INTEGER = 9007199254740991 (minor units) — one above that must be rejected.
    invoiceRepo.findOne.mockResolvedValueOnce(makeInvoice({ totalAmount: '9007199254740992' }));
    await expect(service.initiatePerformanceFeeCheckout(base)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(mockProvider.createCheckoutSession).not.toHaveBeenCalled();
    expect(invoiceRepo.update).not.toHaveBeenCalled();
  });

  it('passes the provider request amount exactly matching the invoice totalAmount (no rounding/fees applied)', async () => {
    invoiceRepo.findOne.mockResolvedValueOnce(makeInvoice({ totalAmount: '123456' }));
    await service.initiatePerformanceFeeCheckout(base);
    expect(mockProvider.createCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({ amountMinor: 123456, currency: 'USD' }),
    );
  });

  it('audit metadata contains no secrets', async () => {
    await service.initiatePerformanceFeeCheckout(base);
    const initiated = auditService.log.mock.calls
      .map((c: any[]) => c[0])
      .find((e: any) => e.action === 'PERFORMANCE_FEE_CHECKOUT_INITIATED');
    const serialized = JSON.stringify(initiated);
    expect(serialized).not.toMatch(/secret|token|password|apiKey|authorization|pin/i);
  });

  // ── Sprint 18: metadata consistency hardening ─────────────────────────────
  it('Sprint 18 — checkout metadata sent to the provider includes transactionId', async () => {
    await service.initiatePerformanceFeeCheckout(base);
    expect(mockProvider.createCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          transactionId: 'tx-1',
          invoiceId: 'invoice-1',
          assessmentId: 'assessment-1',
          type: 'PERFORMANCE_FEE',
        }),
      }),
    );
  });

  it('Sprint 18 — stored providerPayloadSummary includes transactionId for debug parity with subscription checkout', async () => {
    await service.initiatePerformanceFeeCheckout(base);
    const updateCall = transactionRepo.update.mock.calls.find(
      (c: any[]) => c[0] === 'tx-1' && c[1]?.providerTransactionReference,
    );
    expect(updateCall).toBeDefined();
    expect(updateCall[1].providerPayloadSummary).toEqual(
      expect.objectContaining({
        transactionId: 'tx-1',
        invoiceId: 'invoice-1',
        assessmentId: 'assessment-1',
      }),
    );
  });

  // ── Sprint 18 PART C: duplicate provider-reference (23505) handling ───────
  it('Sprint 18 — DB unique-violation on providerTransactionReference is caught, never marks paid, releases claim, audits CRITICAL, and throws sanitized ConflictException', async () => {
    // Simulate the DB-level guard (AddPaymentTransactionReferenceUniqueGuard)
    // rejecting the providerTransactionReference as a duplicate for this provider.
    // Must be a real QueryFailedError with code='23505' so isUniqueViolation() recognises it.
    const uniqueViolation = new QueryFailedError(
      'duplicate key value violates unique constraint "ux_payment_transactions_provider_reference"',
      [],
      new Error('duplicate key'),
    );
    (uniqueViolation as unknown as { code: string }).code = '23505';
    transactionRepo.update.mockImplementation(async (id: any, patch: any) => {
      // First update = the atomic claim (PENDING/FAILED -> PROCESSING): succeeds.
      if (
        patch.status === PaymentTransactionStatus.PROCESSING &&
        !patch.providerTransactionReference
      ) {
        return { affected: 1 };
      }
      // Second update = writing the provider reference: throws 23505.
      if (patch.providerTransactionReference) {
        throw uniqueViolation;
      }
      // Any subsequent release-to-PENDING update: succeeds.
      return { affected: 1 };
    });

    await expect(service.initiatePerformanceFeeCheckout(base)).rejects.toBeInstanceOf(
      ConflictException,
    );

    // Never marked paid: invoice/assessment never touched.
    expect(invoiceRepo.update).not.toHaveBeenCalled();
    // The claim was released back to PENDING so a retry is possible.
    expect(transactionRepo.update).toHaveBeenCalledWith(
      'tx-1',
      expect.objectContaining({
        status: PaymentTransactionStatus.PENDING,
        failureMessage: 'Provider session reference conflict — please retry',
      }),
    );
    // Audited at CRITICAL severity with the conflict reason.
    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'PERFORMANCE_FEE_CHECKOUT_FAILED',
        severity: 'CRITICAL',
        metadata: expect.objectContaining({
          reason: 'PROVIDER_REFERENCE_CONFLICT',
          provider: 'stripe',
        }),
      }),
    );
    // The raw QueryFailedError / constraint name is never leaked to the caller.
    const thrown = await service.initiatePerformanceFeeCheckout(base).catch((e: unknown) => e);
    const thrownStr =
      thrown instanceof Error
        ? `${thrown.message} ${JSON.stringify((thrown as { response?: unknown }).response ?? {})}`
        : String(thrown);
    expect(thrownStr).not.toMatch(/ux_payment_transactions|QueryFailedError|23505|duplicate key/i);
  });
});

describe('getPerformanceFeePaymentStatus', () => {
  it('returns a safe view and audits the view', async () => {
    const view = await service.getPerformanceFeePaymentStatus('invoice-1', OWNER, false);
    expect(view.invoiceId).toBe('invoice-1');
    expect(view.paymentStatus).toBe(PaymentTransactionStatus.PENDING);
    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'PERFORMANCE_FEE_PAYMENT_STATUS_VIEWED' }),
    );
    const serialized = JSON.stringify(view);
    expect(serialized).not.toMatch(/secret|token|password|authorization|pin/i);
  });

  it('normal user cannot view another user invoice (403)', async () => {
    invoiceRepo.findOne.mockResolvedValueOnce(makeInvoice({ userId: 'other-user' }));
    await expect(
      service.getPerformanceFeePaymentStatus('invoice-1', OWNER, false),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('throws NotFound for a missing invoice', async () => {
    invoiceRepo.findOne.mockResolvedValueOnce(null);
    await expect(
      service.getPerformanceFeePaymentStatus('missing', OWNER, false),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('listUserPerformanceFeeInvoices', () => {
  it('returns only performance-fee invoices', async () => {
    invoiceRepo.find.mockResolvedValueOnce([
      makeInvoice({ id: 'inv-pf' }),
      makeInvoice({ id: 'inv-sub', metadata: { type: 'SUBSCRIPTION' } }),
    ]);
    const list = await service.listUserPerformanceFeeInvoices(OWNER, {});
    expect(list).toHaveLength(1);
    expect(list[0].invoiceId).toBe('inv-pf');
    expect(list[0].userId).toBe(OWNER);
  });

  it('supports a bounded admin-wide listing when userId is omitted', async () => {
    invoiceRepo.find.mockResolvedValueOnce([
      makeInvoice({ id: 'inv-a', userId: 'user-a' }),
      makeInvoice({ id: 'inv-b', userId: 'user-b' }),
    ]);
    const list = await service.listUserPerformanceFeeInvoices(undefined, {});
    expect(invoiceRepo.find).toHaveBeenCalledWith(
      expect.objectContaining({ order: { createdAt: 'DESC' }, take: 200 }),
    );
    expect(invoiceRepo.find.mock.calls[0][0]).not.toHaveProperty('where');
    expect(list.map((row) => row.userId)).toEqual(['user-a', 'user-b']);
  });
});
