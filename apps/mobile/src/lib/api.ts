import type { ApiClient } from '@irexpro/api-client';
import { createApiClient } from '@irexpro/api-client';
import type { BrokerRegistryCatalog, PaymentProviderInfo } from '@irexpro/types';

export interface PerformanceFeeAccountPerformance {
  id: string;
  currency: string;
  currentHighWaterMark: string;
  totalRealisedProfit: string;
  totalFeesCharged: string;
  lastCalculationAt: string | null;
}

export interface PerformanceFeeAssessmentView {
  id: string;
  currency: string;
  periodStart: string;
  periodEnd: string;
  startingHighWaterMark: string;
  endingRealisedBalance: string;
  realisedProfitForFee: string;
  feePercent: string;
  feeAmount: string;
  status: 'DRAFT' | 'ASSESSED' | 'INVOICED' | 'WAIVED' | 'PAID' | 'CANCELLED';
  invoiceId: string | null;
  createdAt: string;
}

export interface PerformanceFeeSummaryView {
  performance: PerformanceFeeAccountPerformance | null;
  assessments: PerformanceFeeAssessmentView[];
}

export interface PerformanceFeeInvoiceView {
  invoiceId: string;
  userId: string;
  invoiceNumber: string;
  status: 'DRAFT' | 'ISSUED' | 'PAID' | 'VOID' | 'OVERDUE' | 'CANCELLED';
  currency: string;
  totalAmount: string;
  dueDate: string | null;
  paidAt: string | null;
  assessmentId: string | null;
  assessmentStatus: PerformanceFeeAssessmentView['status'] | null;
  paymentStatus: 'PENDING' | 'PROCESSING' | 'SUCCEEDED' | 'FAILED' | 'REFUNDED' | 'CANCELLED' | 'NONE';
  provider: string | null;
  checkoutSessionId: string | null;
  manual: boolean;
  createdAt: string;
}

export interface PerformanceFeeCheckoutResult {
  invoiceId: string;
  invoiceNumber: string;
  transactionId: string;
  provider: string;
  paymentStatus: string;
  checkoutUrl?: string;
  sessionId?: string;
  providerReference?: string;
  reusedExistingSession: boolean;
}

/**
 * Shared API client for the mobile app.
 *
 * Reads EXPO_PUBLIC_API_BASE_URL from env (Expo inlines EXPO_PUBLIC_* vars at
 * build time). NEVER hardcodes localhost or a domain. The mobile app never
 * calls the AI engine — it is internal-only.
 *
 * Mobile typically does NOT use cookie credentials; it attaches the access
 * token via the Authorization header via getAccessToken.
 */
const baseUrl = process.env.EXPO_PUBLIC_API_BASE_URL;

if (!baseUrl) {
  throw new Error(
    'EXPO_PUBLIC_API_BASE_URL is not set. Copy apps/mobile/.env.example to .env.',
  );
}

let cachedAccessToken: string | null = null;

export function setAccessToken(token: string | null): void {
  cachedAccessToken = token;
}

/**
 * Read the current in-memory access token for the realtime auth handshake.
 * Reconnects call this getter again so token rotation is never captured stale.
 */
export function getAccessTokenValue(): string | null {
  return cachedAccessToken;
}

export interface MobileApiClient extends ApiClient {
  /** GET /broker/registry → server-authoritative catalog wrapper. */
  getBrokerRegistry(): Promise<BrokerRegistryCatalog>;
  /** User-owned high-water-mark and performance-fee assessment summary. */
  getPerformanceFeeSummary(): Promise<PerformanceFeeSummaryView>;
  /** User-owned performance-fee invoices. */
  listPerformanceFeeInvoices(): Promise<PerformanceFeeInvoiceView[]>;
  /** Start provider checkout; verified webhook remains payment truth. */
  checkoutPerformanceFeeInvoice(invoiceId: string): Promise<PerformanceFeeCheckoutResult>;
  /** Read provider-verified payment status for one invoice. */
  getPerformanceFeePaymentStatus(invoiceId: string): Promise<PerformanceFeeInvoiceView>;
  /** Public provider capabilities, authenticated so routing state is user-visible. */
  listPaymentProviders(): Promise<PaymentProviderInfo[]>;
}

/**
 * Build the mobile API facade on top of the shared transport.
 * Exported so contract tests can validate the mobile-only registry extension
 * without mutating or widening the shared ApiClient interface.
 */
export function createMobileApiClient(apiBaseUrl: string): MobileApiClient {
  const baseApi = createApiClient({
    baseUrl: apiBaseUrl,
    includeCredentials: false,
    getAccessToken: () => cachedAccessToken,
  });

  return Object.assign(baseApi, {
    getBrokerRegistry: () =>
      baseApi.request<BrokerRegistryCatalog>('/broker/registry'),
    getPerformanceFeeSummary: () =>
      baseApi.request<PerformanceFeeSummaryView>('/performance-fees/me/summary'),
    listPerformanceFeeInvoices: () =>
      baseApi.request<PerformanceFeeInvoiceView[]>('/performance-fees/invoices'),
    checkoutPerformanceFeeInvoice: (invoiceId: string) =>
      baseApi.request<PerformanceFeeCheckoutResult>(
        `/performance-fees/invoices/${encodeURIComponent(invoiceId)}/checkout`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        },
      ),
    getPerformanceFeePaymentStatus: (invoiceId: string) =>
      baseApi.request<PerformanceFeeInvoiceView>(
        `/performance-fees/invoices/${encodeURIComponent(invoiceId)}/payment-status`,
      ),
    listPaymentProviders: () => baseApi.listProviders(),
  });
}

export const api: MobileApiClient = createMobileApiClient(baseUrl);
