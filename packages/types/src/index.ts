/**
 * @irexpro/types — shared frontend-safe TypeScript types.
 *
 * These types are intentionally a CLEAN, frontend-facing contract. They do NOT
 * import backend entities (TypeORM @Entity classes) or backend secrets, to
 * avoid leaking implementation details or pulling server-only code into the
 * client bundle. Backend and frontend types may diverge; this package is the
 * authoritative source for what the frontend may assume about API responses.
 *
 * All money values are integer minor-unit strings (e.g. "5000" = $50.00),
 * matching the backend's bigint-at-rest convention. The frontend must never
 * use floating-point for money at API boundaries.
 */

// ── Auth ────────────────────────────────────────────────────────────────────
//
// These types match the verified backend auth contract (apps/api/src/modules/auth):
//   POST /auth/register → { accessToken, refreshToken } + sets httpOnly refresh cookie
//   POST /auth/login    → { accessToken, refreshToken } + sets httpOnly refresh cookie
//   POST /auth/refresh  → cookie (web/admin) OR body { refreshToken } (mobile) → { accessToken, refreshToken }
//   POST /auth/logout   → requires Authorization: Bearer → clears refresh cookie
//   GET  /auth/me       → requires Authorization: Bearer → AuthUser (frontend-safe DTO with roles)
//
// Sprint 25 hybrid session strategy:
//   - Web/admin: access token in memory (NOT localStorage); refresh token in
//     httpOnly cookie set by the backend. Sessions survive page refresh via
//     /auth/refresh (cookie sent automatically with credentials:'include').
//   - Mobile: access + refresh tokens in Expo SecureStore (NOT AsyncStorage).
//     Sessions survive app restarts. Mobile sends refreshToken in the JSON
//     body to /auth/refresh.
//
// Sprint 25 /auth/me contract: the backend now returns a frontend-safe
// AuthUserDto (not the raw User entity). It includes roles (from the JWT
// payload) and firstName/lastName (from the UserProfile relation). Sensitive
// fields (passwordHash, mfaSecret, deletedAt, profile PII, userRoles) are
// never included.

export type UserRole = 'SUPER_ADMIN' | 'ADMIN' | 'USER';

export type UserStatus =
  | 'PENDING_VERIFICATION'
  | 'ACTIVE'
  | 'SUSPENDED'
  | 'PERMANENTLY_LOCKED'
  | 'CLOSED';

/**
 * The user object returned by GET /auth/me (Sprint 25 — frontend-safe DTO).
 * Matches the backend AuthUserDto (apps/api/src/modules/auth/dto/auth-user.dto.ts).
 * Only frontend-safe fields are included; sensitive fields are never present.
 */
export interface AuthUser {
  id: string;
  email: string | null;
  phone: string | null;
  firstName: string | null;
  lastName: string | null;
  countryCode: string | null;
  status: UserStatus;
  /** Roles from the JWT payload — always present in the Sprint 25 /auth/me response. */
  roles: UserRole[];
  mfaEnabled: boolean;
  /**
   * Frontend-safe verification state. Sprint 49 API responses always include
   * these booleans; optional typing keeps older deterministic fixtures and
   * independently deployed clients backward-compatible during rollout.
   */
  emailVerified?: boolean;
  phoneVerified?: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface LoginRequest {
  identifier: string;
  password: string;
  /** Optional 6-digit TOTP. Required by the backend only when MFA is enabled. */
  mfaCode?: string;
  rememberMe?: boolean;
}

export interface RegisterRequest {
  email?: string;
  phone?: string;
  password: string;
  countryCode?: string;
  firstName?: string;
  lastName?: string;
  rememberMe?: boolean;
}

export interface RefreshRequest {
  refreshToken: string;
}

/** The token pair returned by /auth/login, /auth/register, and /auth/refresh. */
export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface LogoutResponse {
  message: string;
}

/** Generic response for authenticated identity-security actions. */
export interface AuthActionResponse {
  message: string;
}

/** One-time TOTP enrollment material. Must never be persisted by clients. */
export interface MfaSetupResponse {
  secret: string;
  otpauthUri: string;
}

// ── Sprint 28: Password reset ───────────────────────────────────────────────

/** POST /auth/forgot-password request body. */
export interface ForgotPasswordRequest {
  /** Email address or international phone number (e.g. +233241234567). */
  identifier: string;
}

/**
 * POST /auth/forgot-password response.
 *
 * ALWAYS the same generic message — does NOT reveal whether the account exists.
 * This prevents account enumeration.
 */
export interface ForgotPasswordResponse {
  message: string;
}

/**
 * POST /auth/reset-password request body.
 *
 * Supports two flows:
 *   1. Email token: { token, password }
 *   2. Phone code: { identifier, code, password }
 *
 * The controller routes to the appropriate service method based on which
 * fields are present.
 */
export interface ResetPasswordRequest {
  /** Raw reset token from the email reset link (email flow). */
  token?: string;
  /** Phone number or email (phone code flow). */
  identifier?: string;
  /** 6-digit numeric code sent via SMS (phone code flow). */
  code?: string;
  /** New password (min 12 chars, must contain letters + numbers). */
  password: string;
}

export interface ResetPasswordResponse {
  message: string;
}

/**
 * Convenience: an authenticated session = the access token + the current user.
 * The frontend assembles this by calling /auth/login (or /auth/refresh) then
 * /auth/me with the returned access token.
 */
export interface AuthSession {
  user: AuthUser;
  accessToken: string;
  refreshToken: string;
}

// ── Sprint 43: Account governance ─────────────────────────────────────────

// Public, generic-response account-access appeal request.
export interface SubmitAccountAppealRequest {
  identifier: string;
  reason: string;
}

// This response is intentionally invariant to prevent account enumeration.
export interface SubmitAccountAppealResponse {
  message: string;
}

export type AccountAppealStatus = 'PENDING' | 'RESOLVED';
export type AccountAppealDecision = 'REACTIVATE' | 'PERMANENTLY_LOCK' | 'DELETE';
export type AccountStatusAction = 'DEACTIVATE' | 'PERMANENTLY_LOCK' | 'DELETE';

// Admin-only, frontend-safe view. No credentials, session tokens, or broker data.
export interface AccountAppealAdminView {
  id: string;
  userId: string;
  reason: string;
  status: AccountAppealStatus;
  decision: AccountAppealDecision | null;
  reviewerUserId: string | null;
  reviewerNote: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
  user: {
    id: string;
    email: string | null;
    phone: string | null;
    status: UserStatus;
    profile: { firstName: string | null; lastName: string | null } | null;
  } | null;
}

export interface AccountAppealListResponse {
  items: AccountAppealAdminView[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface ResolveAccountAppealRequest {
  decision: AccountAppealDecision;
  reviewerNote?: string;
}

export interface UpdateAccountStatusRequest {
  action: AccountStatusAction;
  reason: string;
}

export interface AdminAccountStatusView {
  id: string;
  status: UserStatus;
  deletedAt: string | null;
}

// ── Sprint 55: Account security center ──────────────────────────────────────
//
// Contracts pinned by the Phase A audit for the account & security center
// (mobile-first, shared by every client). The backend implements to match
// these — they are the source of truth:
//   POST /auth/change-password        (JWT) → AuthActionResponse. Revokes ALL
//                                     sessions + retires pending MFA (same as
//                                     reset-password). 401 = wrong current
//                                     password; 400 = weak new password.
//   POST /auth/sessions/revoke-others (JWT) → bumps the global sessionVersion
//                                     (CAS) and immediately re-issues a fresh
//                                     token pair to the CALLER. Body transport
//                                     (mobile) returns AuthTokens; browser
//                                     cookie transport (?refreshTransport=cookie
//                                     + trusted origin) returns { accessToken }
//                                     with the rotated refresh cookie.
//   GET  /auth/security-events        (JWT) → SecurityEventListResponse — ONLY
//                                     the caller's own audit rows, filtered to
//                                     a server-side security-action allowlist.
//   GET  /users/me                    (JWT) → MyProfileView (typed view — was
//                                     `unknown` in api-client). PATCH /users/me
//                                     keeps UpdateMyProfileRequest (extended
//                                     with dateOfBirth below).
//
// Deliberately NOT added: RevokeOtherSessionsResponse (the api-client method
// reuses AuthTokens) and AccountSessionView / MobileAccountProfile /
// AccountSecurityStatus (sessions are client-derived; AuthUser already covers
// security status).

/**
 * POST /auth/change-password request body (JWT-authenticated).
 *
 * Password policy is identical to reset-password: newPassword is 12–128
 * characters and must contain at least one letter and one number;
 * currentPassword is 1–128 characters. On success the backend revokes ALL
 * of the user's sessions (sessionVersion bump) and retires any pending MFA
 * enrollment — the caller is signed out everywhere and must log in again.
 *
 * SECURITY: both fields are secrets. Clients MUST never log, persist, or
 * cache either value beyond the in-flight request.
 */
export interface ChangePasswordRequest {
  /** Current account password (1–128 characters). Wrong value → 401. */
  currentPassword: string;
  /** New password (12–128 chars, ≥1 letter, ≥1 number). Weak value → 400. */
  newPassword: string;
}

/**
 * GET /users/me response view (frontend-safe, account-center projection).
 *
 * Narrow, deliberately privacy-safe subset of the serialized user + profile:
 * NO secrets (passwordHash, mfaSecret), NO deletedAt, NO roles (userRoles),
 * NO address fields — only what the account center renders. Pins the typed
 * contract the api-client previously returned as `unknown`.
 */
export interface MyProfileView {
  id: string;
  /** Contact email; null when the account was registered by phone. */
  email: string | null;
  /** Contact phone in international format (e.g. +233241234567); null if unset. */
  phone: string | null;
  status: UserStatus;
  /** ISO-8601 timestamp of email verification; null when not yet verified. */
  emailVerifiedAt: string | null;
  /** ISO-8601 timestamp of phone verification; null when not yet verified. */
  phoneVerifiedAt: string | null;
  /** ISO-3166-1 alpha-2 country code, uppercase (e.g. "GH"); null if unset. */
  countryCode: string | null;
  /** IANA timezone name (e.g. "Africa/Accra"); null if unset. */
  timezone: string | null;
  /** ISO-4217 alpha-3 preferred currency (e.g. "USD"); null if unset. */
  preferredCurrency: string | null;
  /** Whether TOTP multi-factor authentication is currently enabled. */
  mfaEnabled: boolean;
  /** ISO-8601 timestamp of the most recent successful login; null if never. */
  lastLoginAt: string | null;
  /** ISO-8601 account creation timestamp. */
  createdAt: string;
  /** Self-reported onboarding profile details. */
  profile: {
    /** Legal first name; null if unset. */
    firstName: string | null;
    /** Legal last name; null if unset. */
    lastName: string | null;
    /** Date of birth in YYYY-MM-DD calendar format; null if unset. */
    dateOfBirth: string | null;
    /** Self-reported trading experience level; null if unset. */
    tradingExperienceLevel: TradingExperienceLevel | null;
    /** KYC review state; "NONE" means never submitted. */
    kycStatus: 'NONE' | 'PENDING' | 'APPROVED' | 'REJECTED';
  };
}

/** Severity classification for user-facing security events. */
export type SecurityEventSeverity = 'INFO' | 'WARNING' | 'CRITICAL';

/**
 * One privacy-safe row from GET /auth/security-events.
 *
 * The backend returns ONLY the caller's own audit rows, filtered to a
 * server-side security-action allowlist. This is a deliberate privacy-safe
 * projection: ipAddress, userAgent, metadata, and correlationId are NEVER
 * included.
 */
export interface SecurityEventView {
  id: string;
  /**
   * Server-defined audit action name from the security allowlist (e.g.
   * "LOGIN_SUCCESS", "PASSWORD_CHANGED"). Clients map known actions to
   * friendly labels; UNKNOWN actions must render generically — never error
   * or assume meaning.
   */
  action: string;
  /** ISO-8601 timestamp of when the event was recorded. */
  createdAt: string;
  /** Severity hint for visual treatment; absent on rows without one. */
  severity?: SecurityEventSeverity;
}

/**
 * GET /auth/security-events response.
 *
 * Paginated via `limit` (1–100, default 20) + `offset` query parameters.
 * Events are ordered createdAt DESC. `hasMore` is true when at least one
 * further row exists beyond the returned page.
 */
export interface SecurityEventListResponse {
  events: SecurityEventView[];
  /** True when more rows exist beyond this page (fetch with offset). */
  hasMore: boolean;
}

// ── Subscriptions / plans ───────────────────────────────────────────────────
//
// Subscription-retirement (SUBSCRIPTION-RETIREMENT-IMPL):
// The types in this section are DEPRECATED. The subscription billing model
// has been retired — iRexPro now operates on a performance-fee-only model.
// These types are retained for historical/compatibility reasons (existing
// migrations, existing API client method signatures) but should NOT be used
// by new code. New code should reference the performance-fee types instead.

/**
 * @deprecated Subscription-retirement (SUBSCRIPTION-RETIREMENT-IMPL):
 *   Subscriptions are no longer sold. Retained for historical compatibility
 *   with existing database rows and migrations only.
 */
export type BillingInterval = 'MONTHLY' | 'QUARTERLY' | 'ANNUAL';

/**
 * @deprecated Subscription-retirement (SUBSCRIPTION-RETIREMENT-IMPL):
 *   Subscription plans are no longer sold. Retained for historical
 *   compatibility only — do not use in new code.
 */
export interface SubscriptionPlan {
  id: string;
  name: string;
  billingInterval: BillingInterval;
  amountCents: string;
  currency: string;
  isActive: boolean;
}

/**
 * @deprecated Subscription-retirement (SUBSCRIPTION-RETIREMENT-IMPL):
 *   Subscription status is no longer used by the live billing flow. Retained
 *   for historical compatibility only — do not use in new code.
 */
export type SubscriptionStatus =
  | 'ACTIVE'
  | 'TRIAL'
  | 'PAST_DUE'
  | 'CANCELLED'
  | 'EXPIRED';

/**
 * @deprecated Subscription-retirement (SUBSCRIPTION-RETIREMENT-IMPL):
 *   User subscriptions are no longer created. Retained for historical
 *   compatibility only — existing rows remain in the database for audit but
 *   no new subscriptions can be created. Use the performance-fee flow instead.
 */
export interface UserSubscription {
  id: string;
  userId: string;
  planId: string;
  planName?: string;
  status: SubscriptionStatus;
  paymentProvider?: string | null;
  currentPeriodEnd: string;
  startedAt: string;
}

// ── Payments / invoices ─────────────────────────────────────────────────────

export type PaymentProvider =
  | 'stripe'
  | 'paystack'
  | 'flutterwave'
  | 'hubtel'
  | 'paypal'
  | 'wise'
  | 'manual';

export type PaymentPurpose =
  | 'SUBSCRIPTION_INITIAL'
  | 'SUBSCRIPTION_RENEWAL'
  | 'PERFORMANCE_FEE';

export type PaymentTransactionStatus =
  | 'PENDING'
  | 'PROCESSING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'CANCELLED'
  | 'REFUNDED';

export type InvoiceStatus =
  | 'DRAFT'
  | 'ISSUED'
  | 'OVERDUE'
  | 'PAID'
  | 'VOID';

export interface Invoice {
  id: string;
  invoiceNumber: string;
  userId: string;
  status: InvoiceStatus;
  currency: string;
  totalAmount: string;
  dueDate: string | null;
  paidAt: string | null;
  createdAt: string;
}

export interface PaymentTransaction {
  id: string;
  invoiceId: string | null;
  userId: string;
  provider: PaymentProvider;
  providerTransactionReference: string | null;
  paymentPurpose: PaymentPurpose;
  status: PaymentTransactionStatus;
  amountMinor: string;
  currency: string;
  createdAt: string;
}

/**
 * @deprecated Subscription-retirement (SUBSCRIPTION-RETIREMENT-IMPL):
 *   Subscription checkout is no longer performed. Retained for historical
 *   compatibility with the API client signature only — new code should
 *   use the performance-fee checkout flow instead.
 */
export interface CheckoutResult {
  invoiceId: string;
  transactionId: string;
  provider: PaymentProvider;
  checkoutUrl?: string;
  providerReference?: string;
  reusedExistingSession: boolean;
}

export interface PaymentProviderInfo {
  id: PaymentProvider;
  displayName: string;
  isLive: boolean;
  isSandbox: boolean;
  supportedCountries: string[];
  supportedCurrencies: string[];
}

// ── Broker (frontend-safe view — no credentials) ────────────────────────────

/**
 * Sprint 29 amendment: updated to match the backend's 5-status enum
 * (apps/api/src/modules/broker/interfaces/broker-adapter.interface.ts).
 */
export type BrokerConnectionStatus =
  | 'CONNECTING'
  | 'CONNECTED'
  | 'DISCONNECTED'
  | 'ERROR'
  | 'SUSPENDED';

/**
 * Sprint 50 — authorization state machine (Directive §15).
 * ACTIVE is the ONLY state where automation/execution is permitted.
 * Backend-authoritative: frontend state can never enable execution.
 */
export type BrokerAuthorizationStatus =
  | 'NOT_CONNECTED'
  | 'CONNECTING'
  | 'CONNECTED'
  | 'VERIFYING'
  | 'AUTHORIZATION_REQUIRED'
  | 'AUTHORIZED'
  | 'READY'
  | 'ACTIVE'
  | 'SUSPENDED'
  | 'REVOKED'
  | 'ERROR'
  | 'DISCONNECTED';

/**
 * Sprint 50 — credential lifecycle (Directive §14). Metadata only;
 * never carries credential material.
 */
export type BrokerCredentialStatus =
  | 'CREATED'
  | 'VERIFIED'
  | 'ROTATED'
  | 'REVOKED'
  | 'EXPIRED'
  | 'INVALID';

export interface BrokerConnectionView {
  id: string;
  userId: string;
  brokerId: string;
  brokerName: string;
  displayName: string | null;
  accountId: string | null;
  accountType: 'DEMO' | 'LIVE';
  accountCurrency: string | null;
  accountLeverage: number | null;
  status: BrokerConnectionStatus;
  /** Sprint 50 — authoritative automation gate (only ACTIVE executes). */
  authorizationStatus: BrokerAuthorizationStatus;
  /** Sprint 50 — credential lifecycle metadata (no secrets). */
  credentialStatus: BrokerCredentialStatus;
  authorizedAt: string | null;
  authorizationRevokedAt: string | null;
  demoValidated: boolean;
  /**
   * COMPATIBILITY MIRROR ONLY (Sprint 56 correction round 5, #292/#298):
   * never present this as the authoritative current trading state. The
   * authoritative execution state is the TradingSession executionMode +
   * status + authorityGeneration, the connection authorization/executable
   * gates, and the provider verification taxonomy.
   */
  liveTradingEnabled: boolean;
  /**
   * Provider-side broker identity string for this connection (e.g. the
   * cTrader brokerTitleShort). Server-reported; null when the provider has
   * not reported one. Optional: absent on payloads emitted before this field
   * existed. (Sprint 56 correction round 5.)
   */
  providerBrokerIdentity?: string | null;
  /**
   * Server-derived canonical logical-account key (aliases of one provider
   * account normalize to the same key). null until the server has derived
   * it. Optional for wire compatibility with older payloads.
   */
  logicalAccountKey?: string | null;
  lastHealthCheckAt: string | null;
  lastSyncAt: string | null;
  lastErrorMessage: string | null;
  /** Broker credentials are NEVER included in frontend responses. */
  createdAt: string;
  updatedAt: string;
}

/** Supported broker info (GET /broker/connections/supported). */
export interface SupportedBroker {
  brokerId: string;
  brokerName: string;
  supportsDemo: boolean;
  supportsLive: boolean;
}

// ── Sprint 56 correction round 1: cTrader OAuth connection flow ─────────────

/**
 * OAuth authorization channel (Sprint 56 correction round 2 / architect
 * finding 4). "web" (server default) uses the registered HTTPS web callback
 * page; "mobile" claims a server-assigned HTTPS callback slot so the provider
 * authorization code is exchanged by the SERVER — the app only ever receives
 * a one-time handoff token via the deep link.
 */
export type BrokerOAuthChannel = 'web' | 'mobile';

/** POST /broker/connections/oauth/authorize request body. */
export interface BrokerOAuthStartRequest {
  brokerId: string;
  /** Callback-slot channel selection (see BrokerOAuthChannel). */
  channel?: BrokerOAuthChannel;
}

/** A cTID account discovered for an authorized OAuth token (GET 2149 result). */
export interface BrokerOAuthAccount {
  /** Global cTrader account id (string form of the int64 id — not a secret). */
  ctidTraderAccountId: string;
  /** Server-reported environment of the account (DEMO/LIVE boundary). */
  isLive: boolean;
  traderLogin?: number;
  brokerTitleShort?: string;
}

/** POST /broker/connections/oauth/authorize response. */
export interface BrokerOAuthStartResult {
  /** Official id.ctrader.com consent URL — open in an EXTERNAL browser. */
  authorizationUrl: string;
  /**
   * Server-side single-use flow correlation id. Web: kept locally and
   * presented with the code on complete. Mobile: kept for state only — the
   * handoff response returns the AUTHORITATIVE flowId.
   */
  flowId: string;
  expiresAt: string;
}

/**
 * POST /broker/connections/oauth/complete and
 * POST /broker/connections/oauth/handoff response (NO token material).
 */
export interface BrokerOAuthAccountsResult {
  flowId: string;
  accounts: BrokerOAuthAccount[];
}

/** POST /broker/connections/oauth/complete request body (web channel). */
export interface CompleteBrokerOAuthRequest {
  flowId: string;
  /** Single-use authorization code delivered by the Spotware redirect (60 s TTL). */
  code: string;
}

/**
 * POST /broker/connections/oauth/handoff request body (Sprint 56 correction
 * round 2 / architect finding 4 — mobile callback boundary).
 */
export interface ExchangeBrokerOAuthHandoffRequest {
  /**
   * Opaque one-time handoff token delivered by the SERVER callback redirect
   * (irexpro://broker/oauth/handoff?token=…). User-bound, single-use,
   * short-TTL — NOT the provider authorization code, carries no token
   * material, and is useless to interceptors.
   */
  handoffToken: string;
}

/** POST /broker/connections/oauth/link request body. */
export interface LinkBrokerOAuthRequest {
  flowId: string;
  ctidTraderAccountId: string;
  displayName?: string;
}

/** Request body for POST /broker/connections (create connection). */
export interface CreateBrokerConnectionRequest {
  brokerId: string;
  accountType: 'DEMO' | 'LIVE';
  accountId: string;
  apiKey?: string;
  apiSecret?: string;
  serverUrl?: string;
  displayName?: string;
}

/** Result of POST /broker/connections/test (no persistence). */
export interface BrokerTestResult {
  success: boolean;
  accountId?: string;
  errorMessage?: string;
}

// ── Sprint 29: Onboarding + Risk Profile ─────────────────────────────────────

/** Onboarding step identifiers. */
export type OnboardingStep = 'PROFILE' | 'RISK_PROFILE' | 'BROKER_CONNECTION';
export type OnboardingNextStep = OnboardingStep | 'READY';

/** GET /users/me/onboarding-status response. */
export interface OnboardingStatus {
  profileCompleted: boolean;
  riskProfileCompleted: boolean;
  brokerConnected: boolean;
  brokerConnectionStatus: BrokerConnectionStatus;
  canStartTrading: boolean;
  missingSteps: OnboardingStep[];
  nextStep: OnboardingNextStep;
}

/** Self-reported trading experience level. */
export type TradingExperienceLevel = 'BEGINNER' | 'INTERMEDIATE' | 'ADVANCED' | 'PROFESSIONAL';

/** PATCH /users/me request body (onboarding profile update). */
export interface UpdateMyProfileRequest {
  firstName?: string;
  lastName?: string;
  /**
   * Date of birth in YYYY-MM-DD calendar format (valid past date).
   * Changing an already-set DOB resets the account's KYC status
   * server-side — the profile must pass KYC review again.
   */
  dateOfBirth?: string;
  countryCode?: string;
  timezone?: string;
  preferredCurrency?: string;
  tradingExperienceLevel?: TradingExperienceLevel;
}

/** Allowed trading mode (Sprint 29). */
export type AllowedTradingMode = 'PAPER_ONLY' | 'SEMI_AUTO' | 'FULL_AUTO';

/** GET /risk/profile response (frontend-safe — no secrets). */
export interface RiskProfile {
  id: string;
  userId: string;
  killSwitchActive: boolean;
  killSwitchReason: string | null;
  maxDailyLossPercent: string;
  maxDrawdownPercent: string;
  maxOpenTrades: number;
  maxDailyTrades: number;
  maxPositionSizeLot: string;
  minStopLossPips: string;
  allowedInstruments: string[] | null;
  maxVolatilityScore: string;
  rejectLowLiquidity: boolean;
  // Sprint 29 fields:
  riskAcknowledgementAccepted: boolean;
  riskAcknowledgementAcceptedAt: string | null;
  maxTradeRiskPercent: string;
  maxLeverageAllowed: number;
  allowedTradingModes: AllowedTradingMode;
  createdAt: string;
  updatedAt: string;
}

/** PATCH /risk/profile request body. */
export interface UpdateRiskProfileRequest {
  maxDailyLossPercent?: number;
  maxDrawdownPercent?: number;
  maxOpenTrades?: number;
  maxDailyTrades?: number;
  maxPositionSizeLot?: number;
  minStopLossPips?: number;
  allowedInstruments?: string[] | null;
  maxVolatilityScore?: number;
  rejectLowLiquidity?: boolean;
  // Sprint 29:
  maxTradeRiskPercent?: number;
  maxLeverageAllowed?: number;
  allowedTradingModes?: AllowedTradingMode;
  riskAcknowledgementAccepted?: boolean;
}

// ── Health ──────────────────────────────────────────────────────────────────

export interface HealthResponse {
  status: 'ok' | 'degraded';
  timestamp: string;
  environment: string;
  version: string;
  database: 'connected' | 'disconnected';
}

// ── API error ───────────────────────────────────────────────────────────────

export interface ApiError {
  statusCode: number;
  message: string;
  error?: string;
}

// ── Presentation: enum/label humanization ────────────────────────────────────
//
// Presentation-only utility for rendering backend enum values as human-readable
// labels in the UI. This is PURELY presentational: it does NOT modify any enum
// value, API payload, database value, CHECK constraint, role constant,
// RolesGuard expectation, permission check, route guard, or test that validates
// raw API/domain values.
//
// Example: SUPER_ADMIN → "Super Admin", PENDING_REVIEW → "Pending Review".
//
// Behavior:
//   - null/undefined/empty → '' (safe for optional fields)
//   - splits on underscores, then title-cases each word
//   - preserves already-human-readable text (e.g. "Active" stays "Active")
//   - does NOT alter identifiers; only the rendered label changes
//
// Why this lives here: every frontend app (web, admin, mobile) imports from
// @irexpro/types for the enum/string-literal contracts. Co-locating the
// presentation formatter avoids duplicated `.replace('_', ' ')` calls across
// components and keeps a single authoritative humanization rule.
/**
 * Format a backend enum string as a human-readable label.
 *
 * `SUPER_ADMIN` → `Super Admin`
 * `PENDING_REVIEW` → `Pending Review`
 * `BROKER_CONNECTED` → `Broker Connected`
 *
 * Safely handles null/undefined/empty (returns ''). Preserves
 * already-human-readable text. Does NOT alter the input value or any
 * backend/domain enum.
 */
export function formatEnumLabel(value: string | null | undefined): string {
  if (!value) return '';
  // Split on underscores, trim, and title-case each token.
  return value
    .split('_')
    .map((word) => word.trim())
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}