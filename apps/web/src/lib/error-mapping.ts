/**
 * mapApiError — translates an unknown API/network error into a safe,
 * user-facing message.
 *
 * UX-1 utility.
 *
 * SECURITY: This function may surface a bounded backend message only when it
 * came from a client-action 4xx response and passes the safe-detail filter.
 * SQL errors, stack traces, filesystem paths, credentials, tokens, internal
 * URLs, and server-side 5xx diagnostics remain hidden behind generic copy.
 *
 * Recognized error codes:
 * - TRADING_NOT_READY        → "Your trading setup is not ready." + missingSteps
 * - VALIDATION_ERROR         → "Please check the highlighted fields and try again."
 * - UNAUTHORIZED             → "Your session has expired. Please sign in again."
 * - FORBIDDEN                → safe server detail when available, otherwise permission copy
 * - BROKER_CONNECTION_FAILED → safe server detail when available, otherwise connection copy
 * - BROKER_HEALTH_STALE      → safe server detail when available, otherwise health copy
 * - RISK_LIMIT_EXCEEDED      → safe server detail when available, otherwise risk copy
 * - Network errors           → "Unable to reach the server. Please check your connection."
 * - Unknown safe 4xx         → bounded user-action detail supplied by the API
 * - Everything else         → "Something went wrong. Please try again."
 */

export interface ApiErrorResult {
  message: string;
  code?: string;
  /** Onboarding route paths the user should complete (only set for TRADING_NOT_READY). */
  missingSteps?: string[];
}

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_MESSAGE = 'Something went wrong. Please try again.';
const NETWORK_MESSAGE = 'Unable to reach the server. Please check your connection.';
const SERVER_MESSAGE = 'The server returned an error. Please try again.';
const MAX_SAFE_DETAIL_LENGTH = 500;

/** Map of known error codes → safe user-facing copy. */
const CODE_MESSAGES: Record<string, string> = {
  TRADING_NOT_READY: 'Your trading setup is not ready.',
  VALIDATION_ERROR: 'Please check the highlighted fields and try again.',
  UNAUTHORIZED: 'Your session has expired. Please sign in again.',
  FORBIDDEN: "You don't have permission to perform this action.",
  BROKER_CONNECTION_FAILED:
    'The broker connection test failed. Please check your credentials.',
  BROKER_HEALTH_STALE:
    'Your broker health check is outdated. Please test your connection.',
  RISK_LIMIT_EXCEEDED: 'The requested action exceeds your risk limits.',
  ALLOCATION_BUDGET_UNPROVABLE:
    'Your broker is connected, but its account identity or equity is still unavailable for AI capital allocation. Open Broker Account, refresh/reconnect the account, then retry.',
  ALLOCATION_CURRENCY_MISMATCH:
    'The saved AI allocation currency no longer matches the broker account currency. Review the broker account before continuing.',
  ALLOCATION_INSUFFICIENT_CAPITAL:
    'The requested AI allocation is not available from the broker account.',
};

/**
 * Whitelist of onboarding step keys the backend is allowed to surface. Anything
 * else is silently dropped (we never trust raw user-facing step names from the
 * API — they could be anything).
 *
 * Subscription-retirement (SUBSCRIPTION-RETIREMENT-IMPL):
 *   The dead `subscription: '/payments/success'` entry has been removed. The
 *   subscription onboarding step no longer exists; only profile, broker, and
 *   risk remain as known onboarding steps.
 */
const KNOWN_ONBOARDING_STEPS: Record<string, string> = {
  profile: '/onboarding/profile',
  broker: '/onboarding/broker',
  risk: '/onboarding/risk',
};

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Tests whether an error looks like a network/fetch failure (no HTTP response
 * was received). Covers: TypeError from fetch, ERR_NETWORK, ECONNABORTED,
 * aborted requests, and typical axios `isAxiosError` shapes.
 */
function isNetworkError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;

  const anyErr = err as Record<string, unknown>;

  // fetch() throws a TypeError on network failure.
  if (err instanceof TypeError) return true;

  // Axios-style: { isAxiosError: true, request: {...}, response: undefined }
  if (anyErr.isAxiosError === true && anyErr.response === undefined && anyErr.request !== undefined) {
    return true;
  }

  const message = typeof anyErr.message === 'string' ? anyErr.message.toLowerCase() : '';
  if (
    message.includes('network error') ||
    message.includes('failed to fetch') ||
    message.includes('err_network') ||
    message.includes('econnaborted') ||
    message.includes('timeout') ||
    message.includes('internet connection') ||
    message.includes('network request failed')
  ) {
    return true;
  }

  // fetch-style aborts / DOMExceptions.
  if (anyErr.name === 'AbortError') return true;

  return false;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

/**
 * ApiClientError stores the parsed API body under `.raw`. Other callers may
 * surface axios/fetch-like shapes. Resolve the HTTP status without trusting a
 * single transport implementation.
 */
function extractStatus(err: unknown): number | undefined {
  const anyErr = asRecord(err);
  if (!anyErr) return undefined;

  const response = asRecord(anyErr.response);
  const data = asRecord(anyErr.data);
  const raw = asRecord(anyErr.raw);
  const candidates = [anyErr.statusCode, anyErr.status, response?.status, data?.statusCode, data?.status, raw?.statusCode, raw?.status];

  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isInteger(candidate) && candidate >= 0 && candidate <= 599) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Safely extracts a `code` string from a backend error body. Includes the
 * shared ApiClientError `.raw` body in addition to common HTTP-client shapes.
 */
function extractCode(err: unknown): string | undefined {
  const anyErr = asRecord(err);
  if (!anyErr) return undefined;

  const response = asRecord(anyErr.response);
  const responseData = asRecord(response?.data);
  const data = asRecord(anyErr.data);
  const body = asRecord(anyErr.body);
  const nestedError = asRecord(anyErr.error);
  const responseError = asRecord(responseData?.error);
  const raw = asRecord(anyErr.raw);
  const rawError = asRecord(raw?.error);
  const rawMessage = asRecord(raw?.message);
  const responseMessage = asRecord(responseData?.message);
  const dataMessage = asRecord(data?.message);
  const bodyMessage = asRecord(body?.message);

  const candidates: unknown[] = [
    anyErr.code,
    responseData?.code,
    data?.code,
    body?.code,
    nestedError?.code,
    responseError?.code,
    raw?.code,
    rawError?.code,
    rawMessage?.code,
    responseMessage?.code,
    dataMessage?.code,
    bodyMessage?.code,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0 && candidate.length <= 128) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Extracts the list of missing onboarding steps for TRADING_NOT_READY, mapping
 * each to a known onboarding path. Unknown / suspicious step keys are dropped.
 */
function extractMissingSteps(err: unknown): string[] | undefined {
  const anyErr = asRecord(err);
  if (!anyErr) return undefined;

  const response = asRecord(anyErr.response);
  const responseData = asRecord(response?.data);
  const data = asRecord(anyErr.data);
  const raw = asRecord(anyErr.raw);

  const candidates: unknown[] = [
    responseData?.missingSteps,
    responseData?.missing_steps,
    data?.missingSteps,
    data?.missing_steps,
    anyErr.missingSteps,
    anyErr.missing_steps,
    raw?.missingSteps,
    raw?.missing_steps,
  ];

  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    const mapped: string[] = [];
    for (const step of candidate) {
      if (typeof step !== 'string') continue;
      const key = step.toLowerCase().trim();
      const path = KNOWN_ONBOARDING_STEPS[key];
      if (path && !mapped.includes(path)) mapped.push(path);
    }
    if (mapped.length > 0) return mapped;
  }

  return undefined;
}

/**
 * Return a backend detail only when it is suitable for direct presentation.
 * This is deliberately conservative: only 4xx client-action responses qualify,
 * the message is bounded, and strings that look like diagnostics or secrets
 * are rejected. 5xx messages are never surfaced.
 */
function extractSafeBackendMessage(err: unknown): string | undefined {
  const status = extractStatus(err);
  if (status === undefined || status < 400 || status >= 500) return undefined;

  const anyErr = asRecord(err);
  if (!anyErr) return undefined;
  const response = asRecord(anyErr.response);
  const responseData = asRecord(response?.data);
  const data = asRecord(anyErr.data);
  const body = asRecord(anyErr.body);
  const raw = asRecord(anyErr.raw);
  const rawMessage = asRecord(raw?.message);
  const responseMessage = asRecord(responseData?.message);
  const dataMessage = asRecord(data?.message);
  const bodyMessage = asRecord(body?.message);

  const candidates: unknown[] = [
    rawMessage?.message,
    responseMessage?.message,
    dataMessage?.message,
    bodyMessage?.message,
    raw?.message,
    responseData?.message,
    data?.message,
    body?.message,
    anyErr.message,
  ];

  const unsafePattern =
    /(queryfailederror|typeorm|prisma|postgres|sqlstate|stack\s*trace|\/node_modules\/|\/home\/|[a-z]:\\|\bselect\b.+\bfrom\b|\binsert\s+into\b|\bdelete\s+from\b|\brelation\s+["'`]|\bbearer\s+[a-z0-9._~-]+|(?:api[_-]?key|api[_-]?secret|client[_-]?secret|access[_-]?token|refresh[_-]?token|password)\s*[:=])/i;
  const internalUrlPattern = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|[^\s/]*\.internal)(?::\d+)?/i;

  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const normalized = candidate.replace(/\s+/g, ' ').trim();
    if (!normalized || normalized.length > MAX_SAFE_DETAIL_LENGTH) continue;
    if (unsafePattern.test(normalized) || internalUrlPattern.test(normalized)) continue;
    return normalized;
  }

  return undefined;
}

/**
 * Determines whether the HTTP status code suggests an auth/network failure we
 * should special-case. Returns the matching message or undefined.
 */
function messageForStatus(err: unknown): string | undefined {
  const status = extractStatus(err);
  if (status === undefined) return undefined;

  if (status === 401) return CODE_MESSAGES.UNAUTHORIZED;
  if (status === 403) return extractSafeBackendMessage(err) ?? CODE_MESSAGES.FORBIDDEN;
  if (status === 0) return NETWORK_MESSAGE;
  if (status >= 500) return SERVER_MESSAGE;
  if (status >= 400) return extractSafeBackendMessage(err) ?? DEFAULT_MESSAGE;
  return undefined;
}

// ── Public API ───────────────────────────────────────────────────────────────

export function mapApiError(error: unknown): ApiErrorResult {
  // 1. Network errors (no HTTP response).
  if (isNetworkError(error)) {
    return { message: NETWORK_MESSAGE };
  }

  // 2. Recognized backend error code.
  const code = extractCode(error);
  if (code && Object.prototype.hasOwnProperty.call(CODE_MESSAGES, code)) {
    const baseMessage = CODE_MESSAGES[code];
    // Keep validation/auth messages intentionally generic; they may contain
    // sensitive field-level details. Other 4xx domain errors may surface the
    // server's bounded, sanitized explanation so the toast is actionable.
    const safeDetail =
      code === 'VALIDATION_ERROR' || code === 'UNAUTHORIZED'
        ? undefined
        : extractSafeBackendMessage(error);
    const result: ApiErrorResult = { message: safeDetail ?? baseMessage, code };
    if (code === 'TRADING_NOT_READY') {
      const steps = extractMissingSteps(error);
      // If the API didn't surface specific steps, default to all onboarding
      // routes — the user can complete whichever they haven't done yet.
      result.missingSteps = steps ?? [
        KNOWN_ONBOARDING_STEPS.profile,
        KNOWN_ONBOARDING_STEPS.broker,
        KNOWN_ONBOARDING_STEPS.risk,
      ];
    }
    return result;
  }

  // 3. Status-code-based inference. Safe 4xx domain messages are retained;
  // auth and server failures remain generic/fail-closed.
  const statusMessage = messageForStatus(error);
  if (statusMessage) {
    return { message: statusMessage, ...(code ? { code } : {}) };
  }

  // 4. Default — never leak raw error details without a qualifying 4xx status.
  return { message: DEFAULT_MESSAGE };
}

export default mapApiError;