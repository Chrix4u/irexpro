import type {
  ApiError,
  AuthActionResponse,
  AuthTokens,
  AuthUser,
  BrokerConnectionView,
  BrokerTestResult,
  CreateBrokerConnectionRequest,
  ForgotPasswordRequest,
  ForgotPasswordResponse,
  HealthResponse,
  Invoice,
  LoginRequest,
  LogoutResponse,
  MfaSetupResponse,
  OnboardingStatus,
  PaymentProviderInfo,
  PaymentTransaction,
  RefreshRequest,
  RegisterRequest,
  ResetPasswordRequest,
  ResetPasswordResponse,
  AccountAppealAdminView,
  AccountAppealStatus,
  AdminAccountStatusView,
  ResolveAccountAppealRequest,
  SubmitAccountAppealRequest,
  SubmitAccountAppealResponse,
  UpdateAccountStatusRequest,
  RiskProfile,
  SupportedBroker,
  UpdateMyProfileRequest,
  UpdateRiskProfileRequest,
} from '@irexpro/types';

/**
 * Options for the shared API client.
 *
 * `baseUrl` is the FULL API base URL (e.g. "https://irexpro.lightworldtech.com/api/v1"
 * or "http://127.0.0.1:3010/api/v1"). It MUST be supplied by each app from its
 * own env config — the shared client NEVER hardcodes localhost or any domain.
 *
 * `getAccessToken` is an optional getter used to attach the `Authorization:
 * Bearer <token>` header to authenticated requests. Each app supplies its own
 * token-storage strategy (in-memory for web/admin production, secure storage
 * for mobile). The shared client never reads env directly and never stores
 * tokens itself.
 *
 * The backend is token-based (NOT httpOnly-cookie-based): /auth/login and
 * /auth/register return `{ accessToken, refreshToken }` in the JSON body. The
 * app is responsible for storing these securely and passing the access token
 * back via `getAccessToken`. `includeCredentials` is kept for same-origin
 * cookie scenarios but is not the primary auth mechanism.
 */
export interface CreateApiClientOptions {
  baseUrl: string;
  includeCredentials?: boolean;
  /** Optional token getter — used to attach Authorization: Bearer <token>. */
  getAccessToken?: () => string | null | undefined;
}

export interface ApiClient {
  readonly baseUrl: string;

  // Health
  health(): Promise<HealthResponse>;

  // Auth — matches the verified backend (apps/api/src/modules/auth/auth.controller.ts)
  /** POST /auth/register → { accessToken, refreshToken } */
  register(body: RegisterRequest): Promise<AuthTokens>;
  /** POST /auth/login → { accessToken, refreshToken }; optional mfaCode when enabled. */
  login(body: LoginRequest): Promise<AuthTokens>;
  /**
   * POST /auth/refresh → { accessToken, refreshToken }
   * Sprint 25 hybrid: if refreshToken is provided (mobile), it goes in the JSON
   * body. If omitted (web/admin), the request relies on the httpOnly refresh
   * cookie sent automatically via credentials:'include'.
   */
  refresh(refreshToken?: string): Promise<AuthTokens>;
  /** POST /auth/logout (requires Authorization: Bearer) → { message } */
  logout(): Promise<LogoutResponse>;
  /** GET /auth/me (requires Authorization: Bearer) → current user */
  me(): Promise<AuthUser>;
  /** Begin TOTP enrollment after current-password re-authentication. Returned secret/URI must remain memory-only. */
  beginMfaSetup(password: string): Promise<MfaSetupResponse>;
  /** Verify a six-digit TOTP and enable MFA. Existing sessions are revoked. */
  enableMfa(code: string): Promise<AuthActionResponse>;
  /** Disable MFA with current password + six-digit TOTP. Existing sessions are revoked. */
  disableMfa(code: string, password: string): Promise<AuthActionResponse>;
  /** Send a single-use email verification link for the current account. */
  requestEmailVerification(): Promise<AuthActionResponse>;
  /** Public confirmation of a single-use email verification token. */
  confirmEmailVerification(token: string): Promise<AuthActionResponse>;
  /** Send a single-use phone verification code for the current account. */
  requestPhoneVerification(): Promise<AuthActionResponse>;
  /** Confirm the current account's six-digit phone verification code. */
  confirmPhoneVerification(code: string): Promise<AuthActionResponse>;

  // ── Sprint 28: Password reset ────────────────────────────────────────────
  /** POST /auth/forgot-password → always returns a generic message (no account enumeration). */
  forgotPassword(body: ForgotPasswordRequest): Promise<ForgotPasswordResponse>;
  /** POST /auth/reset-password → reset password using token (email) or code (phone). */
  resetPassword(body: ResetPasswordRequest): Promise<ResetPasswordResponse>;

  // ── Sprint 43: Account governance ───────────────────────────────────────
  /** Public, generic-response account-access appeal request. */
  submitAccountAppeal(body: SubmitAccountAppealRequest): Promise<SubmitAccountAppealResponse>;
  /** Admin-only appeal queue. */
  listAccountAppeals(status?: AccountAppealStatus): Promise<AccountAppealAdminView[]>;
  /** Admin-only review decision. */
  resolveAccountAppeal(
    appealId: string,
    body: ResolveAccountAppealRequest,
  ): Promise<AccountAppealAdminView>;
  /** Admin-only account-access action. */
  updateAccountStatus(userId: string, body: UpdateAccountStatusRequest): Promise<AdminAccountStatusView>;

  // ── Sprint 29: Users / onboarding / risk / broker ─────────────────────────
  /** GET /users/me → current user profile (full entity with profile relation). */
  getMyProfile(): Promise<unknown>;
  /** PATCH /users/me → update profile fields (onboarding). */
  updateMyProfile(body: UpdateMyProfileRequest): Promise<unknown>;
  /** GET /users/me/onboarding-status → onboarding checklist status. */
  getOnboardingStatus(): Promise<OnboardingStatus>;
  /** GET /risk/profile → user risk profile (auto-created with defaults). */
  getRiskProfile(): Promise<RiskProfile>;
  /** PATCH /risk/profile → update risk profile + risk acknowledgement. */
  updateRiskProfile(body: UpdateRiskProfileRequest): Promise<RiskProfile>;
  /** GET /broker/connections/supported → list of supported brokers. */
  listSupportedBrokers(): Promise<SupportedBroker[]>;
  /** GET /broker/connections → user's broker connections (no credentials). */
  listBrokerConnections(): Promise<BrokerConnectionView[]>;
  /** POST /broker/connections → create a new broker connection (encrypts credentials). */
  createBrokerConnection(body: CreateBrokerConnectionRequest): Promise<BrokerConnectionView>;
  /** POST /broker/connections/test → test credentials without saving (returns success/error). */
  testBrokerCredentials(body: CreateBrokerConnectionRequest): Promise<BrokerTestResult>;
  /** POST /broker/connections/:id/connect → connect (set status to CONNECTED). */
  connectBroker(connectionId: string): Promise<BrokerConnectionView>;
  /** POST /broker/connections/:id/disconnect → disconnect. */
  disconnectBroker(connectionId: string): Promise<void>;

  // Payments
  listProviders(): Promise<PaymentProviderInfo[]>;
  getInvoice(invoiceId: string): Promise<Invoice>;
  getTransactionStatus(transactionId: string): Promise<PaymentTransaction>;

  /** Low-level fetch for app-specific endpoints. */
  request<T>(path: string, init?: RequestInit): Promise<T>;
}

export class ApiClientError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly raw?: unknown,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

/**
 * Create a typed API client bound to a base URL.
 *
 * The caller is responsible for reading the base URL from the correct env var
 * for its platform:
 *   - Next.js web/admin: process.env.NEXT_PUBLIC_API_BASE_URL
 *   - Expo mobile:       process.env.EXPO_PUBLIC_API_BASE_URL
 *
 * The shared client itself never reads env directly, so it stays
 * platform-agnostic and never hardcodes a URL.
 */
export function createApiClient(options: CreateApiClientOptions): ApiClient {
  const { baseUrl, includeCredentials = false, getAccessToken } = options;

  if (!baseUrl) {
    throw new Error(
      'ApiClient: baseUrl is required. Pass the API base URL from your app env config.',
    );
  }

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const url = `${baseUrl}${path}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...((init?.headers as Record<string, string>) ?? {}),
    };

    const token = getAccessToken?.();
    if (token && !headers['Authorization']) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    let res: Response;
    try {
      res = await fetch(url, {
        ...init,
        headers,
        credentials: includeCredentials ? 'include' : 'same-origin',
      });
    } catch (err) {
      throw new ApiClientError(
        0,
        `Network error contacting API: ${(err as Error).message}`,
      );
    }

    if (!res.ok) {
      let body: ApiError | null = null;
      try {
        body = (await res.json()) as ApiError;
      } catch {
        /* non-JSON error */
      }
      throw new ApiClientError(
        res.status,
        body?.message ?? res.statusText,
        body,
      );
    }

    if (res.status === 204) {
      return undefined as T;
    }
    return (await res.json()) as T;
  }

  return {
    baseUrl,

    health: () => request<HealthResponse>('/health'),

    register: (body) =>
      request<AuthTokens>('/auth/register', {
        method: 'POST',
        body: JSON.stringify(body),
      }),

    login: (body) =>
      request<AuthTokens>('/auth/login', {
        method: 'POST',
        body: JSON.stringify(body),
      }),

    refresh: (refreshToken?: string) =>
      request<AuthTokens>('/auth/refresh', {
        method: 'POST',
        // Sprint 25: if refreshToken is provided (mobile), send it in the body.
        // If omitted (web/admin), send '{}' as the body — the httpOnly cookie
        // is sent automatically via credentials:'include' set in request().
        // Hotfix: send '{}' instead of undefined. With Content-Type:
        // application/json set, an undefined body can cause some NestJS
        // ValidationPipe configurations to fail body parsing. Sending '{}'
        // guarantees a parseable JSON body (RefreshTokenDto.refreshToken is
        // @IsOptional, so '{}' is valid) and lets the controller fall back to
        // the cookie.
        body: refreshToken
          ? JSON.stringify({ refreshToken } satisfies RefreshRequest)
          : JSON.stringify({}),
      }),

    logout: () =>
      request<LogoutResponse>('/auth/logout', { method: 'POST' }),

    me: () => request<AuthUser>('/auth/me'),

    beginMfaSetup: (password) =>
      request<MfaSetupResponse>('/auth/mfa/setup', {
        method: 'POST',
        body: JSON.stringify({ password }),
      }),

    enableMfa: (code) =>
      request<AuthActionResponse>('/auth/mfa/enable', {
        method: 'POST',
        body: JSON.stringify({ code }),
      }),

    disableMfa: (code, password) =>
      request<AuthActionResponse>('/auth/mfa/disable', {
        method: 'POST',
        body: JSON.stringify({ code, password }),
      }),

    requestEmailVerification: () =>
      request<AuthActionResponse>('/auth/verification/email/request', { method: 'POST' }),

    confirmEmailVerification: (token) =>
      request<AuthActionResponse>('/auth/verification/email/confirm', {
        method: 'POST',
        body: JSON.stringify({ token }),
      }),

    requestPhoneVerification: () =>
      request<AuthActionResponse>('/auth/verification/phone/request', { method: 'POST' }),

    confirmPhoneVerification: (code) =>
      request<AuthActionResponse>('/auth/verification/phone/confirm', {
        method: 'POST',
        body: JSON.stringify({ code }),
      }),

    // Sprint 28: password reset
    forgotPassword: (body) =>
      request<ForgotPasswordResponse>('/auth/forgot-password', {
        method: 'POST',
        body: JSON.stringify(body),
      }),

    resetPassword: (body) =>
      request<ResetPasswordResponse>('/auth/reset-password', {
        method: 'POST',
        body: JSON.stringify(body),
      }),

    // Sprint 43: account governance
    submitAccountAppeal: (body) =>
      request<SubmitAccountAppealResponse>('/account-appeals', {
        method: 'POST',
        body: JSON.stringify(body),
      }),

    listAccountAppeals: (status?: AccountAppealStatus) =>
      request<AccountAppealAdminView[]>(
        status ? `/admin/account-appeals?status=${encodeURIComponent(status)}` : '/admin/account-appeals',
      ),

    resolveAccountAppeal: (appealId, body) =>
      request<AccountAppealAdminView>(`/admin/account-appeals/${encodeURIComponent(appealId)}/resolve`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),

    updateAccountStatus: (userId, body) =>
      request<AdminAccountStatusView>(`/admin/users/${encodeURIComponent(userId)}/account-status`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),

    // Sprint 29: users / onboarding / risk / broker
    getMyProfile: () => request<unknown>('/users/me'),

    updateMyProfile: (body) =>
      request<unknown>('/users/me', {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),

    getOnboardingStatus: () =>
      request<OnboardingStatus>('/users/me/onboarding-status'),

    getRiskProfile: () => request<RiskProfile>('/risk/profile'),

    updateRiskProfile: (body) =>
      request<RiskProfile>('/risk/profile', {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),

    listSupportedBrokers: () =>
      request<SupportedBroker[]>('/broker/connections/supported'),

    listBrokerConnections: () =>
      request<BrokerConnectionView[]>('/broker/connections'),

    createBrokerConnection: (body) =>
      request<BrokerConnectionView>('/broker/connections', {
        method: 'POST',
        body: JSON.stringify(body),
      }),

    testBrokerCredentials: (body) =>
      request<BrokerTestResult>('/broker/connections/test', {
        method: 'POST',
        body: JSON.stringify(body),
      }),

    connectBroker: (connectionId) =>
      request<BrokerConnectionView>(`/broker/connections/${connectionId}/connect`, {
        method: 'POST',
      }),

    disconnectBroker: (connectionId) =>
      request<void>(`/broker/connections/${connectionId}/disconnect`, {
        method: 'POST',
      }),

    listProviders: () =>
      request<PaymentProviderInfo[]>('/payments/providers'),

    getInvoice: (invoiceId) =>
      request<Invoice>(`/payments/invoices/${invoiceId}`),

    getTransactionStatus: (transactionId) =>
      request<PaymentTransaction>(
        `/payments/transactions/${transactionId}/status`,
      ),

    request,
  };
}
