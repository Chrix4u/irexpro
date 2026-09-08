import { GitHubApiError, runGate } from './required-ci-gate.mjs';

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BASE_DELAY_SECONDS = 2;
const DEFAULT_MAX_DELAY_SECONDS = 20;
const DEFAULT_OVERALL_TIMEOUT_SECONDS = 2400;

function positiveIntegerEnvironment(name, fallback) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export function isTransientGateError(error) {
  if (error instanceof GitHubApiError) {
    if (error.status === 408 || error.status === 425 || error.status === 429 || error.status >= 500) {
      return true;
    }
    if (
      error.status === 403 &&
      (error.retryAfterSeconds !== null || error.rateLimitRemaining === 0)
    ) {
      return true;
    }
    return false;
  }

  const message = errorMessage(error);
  const statusMatch = message.match(/GitHub API request failed \((\d{3})\)/);
  if (statusMatch) {
    const status = Number.parseInt(statusMatch[1], 10);
    return status === 408 || status === 425 || status === 429 || status >= 500;
  }

  return /(?:fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|UND_ERR_(?:CONNECT|HEADERS|BODY)_TIMEOUT|socket hang up)/i.test(
    message,
  );
}

export function retryDelaySeconds(attempt, baseDelaySeconds, maxDelaySeconds) {
  return Math.min(maxDelaySeconds, baseDelaySeconds * 2 ** Math.max(0, attempt - 1));
}

export function retryHintDelaySeconds(error, nowEpochSeconds = Math.floor(Date.now() / 1000)) {
  if (!(error instanceof GitHubApiError)) return null;
  if (error.retryAfterSeconds !== null && error.retryAfterSeconds >= 0) {
    return error.retryAfterSeconds;
  }
  if (
    error.rateLimitRemaining === 0 &&
    error.rateLimitResetEpochSeconds !== null &&
    error.rateLimitResetEpochSeconds > nowEpochSeconds
  ) {
    return error.rateLimitResetEpochSeconds - nowEpochSeconds + 1;
  }
  return null;
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}

export function runSelfTests() {
  assertEqual(
    isTransientGateError(new GitHubApiError({
      status: 502,
      path: '/actions/runs',
      requestId: 'test',
    })),
    true,
    '502 is transient',
  );
  assertEqual(
    isTransientGateError(new GitHubApiError({
      status: 429,
      path: '/actions/runs',
      requestId: 'test',
      retryAfterSeconds: 4,
    })),
    true,
    '429 is transient',
  );
  assertEqual(
    isTransientGateError(new TypeError('fetch failed: UND_ERR_CONNECT_TIMEOUT')),
    true,
    'network timeout is transient',
  );
  assertEqual(
    isTransientGateError(new GitHubApiError({
      status: 404,
      path: '/pulls/123',
      requestId: 'test',
    })),
    false,
    '404 is not transient',
  );
  assertEqual(
    isTransientGateError(new GitHubApiError({
      status: 403,
      path: '/actions/runs',
      requestId: 'test',
    })),
    false,
    'ordinary 403 is not blindly retried',
  );
  assertEqual(
    isTransientGateError(new GitHubApiError({
      status: 403,
      path: '/actions/runs',
      requestId: 'test',
      rateLimitRemaining: 0,
      rateLimitResetEpochSeconds: 1_700_000_100,
    })),
    true,
    'rate-limited 403 is transient',
  );
  assertEqual(
    retryHintDelaySeconds(new GitHubApiError({
      status: 429,
      path: '/actions/runs',
      requestId: 'test',
      retryAfterSeconds: 7,
    }), 1_700_000_000),
    7,
    'Retry-After hint is honored',
  );
  assertEqual(
    retryHintDelaySeconds(new GitHubApiError({
      status: 403,
      path: '/actions/runs',
      requestId: 'test',
      rateLimitRemaining: 0,
      rateLimitResetEpochSeconds: 1_700_000_010,
    }), 1_700_000_000),
    11,
    'rate-limit reset hint is honored with one-second cushion',
  );
  assertEqual(
    isTransientGateError(new Error('API CI failed the required gate: conclusion=failure')),
    false,
    'real workflow failure is not transient',
  );
  assertEqual(retryDelaySeconds(1, 2, 20), 2, 'attempt 1 delay');
  assertEqual(retryDelaySeconds(2, 2, 20), 4, 'attempt 2 delay');
  assertEqual(retryDelaySeconds(5, 2, 20), 20, 'delay is capped');

  console.log('Required CI gate runner self-tests passed.');
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function runGateWithTransientRetries() {
  const maxAttempts = positiveIntegerEnvironment(
    'REQUIRED_GATE_API_RETRY_ATTEMPTS',
    DEFAULT_MAX_ATTEMPTS,
  );
  const baseDelaySeconds = positiveIntegerEnvironment(
    'REQUIRED_GATE_API_RETRY_BASE_SECONDS',
    DEFAULT_BASE_DELAY_SECONDS,
  );
  const maxDelaySeconds = positiveIntegerEnvironment(
    'REQUIRED_GATE_API_RETRY_MAX_SECONDS',
    DEFAULT_MAX_DELAY_SECONDS,
  );
  const overallTimeoutSeconds = positiveIntegerEnvironment(
    'REQUIRED_WORKFLOW_TIMEOUT_SECONDS',
    DEFAULT_OVERALL_TIMEOUT_SECONDS,
  );

  const originalTimeout = process.env.REQUIRED_WORKFLOW_TIMEOUT_SECONDS;
  const deadline = Date.now() + overallTimeoutSeconds * 1000;

  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const remainingSeconds = Math.floor((deadline - Date.now()) / 1000);
      if (remainingSeconds <= 0) {
        throw new Error(
          `Timed out after ${overallTimeoutSeconds}s while retrying transient GitHub API failures`,
        );
      }

      process.env.REQUIRED_WORKFLOW_TIMEOUT_SECONDS = String(remainingSeconds);

      try {
        await runGate();
        return;
      } catch (error) {
        if (!isTransientGateError(error) || attempt === maxAttempts) {
          throw error;
        }

        const backoffSeconds = retryDelaySeconds(
          attempt,
          baseDelaySeconds,
          maxDelaySeconds,
        );
        const hintedSeconds = retryHintDelaySeconds(error);
        const requestedDelaySeconds = Math.max(backoffSeconds, hintedSeconds ?? 0);
        const delayMilliseconds = Math.min(
          requestedDelaySeconds * 1000,
          Math.max(0, deadline - Date.now()),
        );
        if (delayMilliseconds <= 0) throw error;

        console.warn(
          `Required CI Gate hit a transient GitHub API/network error on attempt ${attempt}/${maxAttempts}: ${errorMessage(error)}. Retrying in ${Math.ceil(delayMilliseconds / 1000)}s.`,
        );
        await sleep(delayMilliseconds);
      }
    }
  } finally {
    if (originalTimeout === undefined) {
      delete process.env.REQUIRED_WORKFLOW_TIMEOUT_SECONDS;
    } else {
      process.env.REQUIRED_WORKFLOW_TIMEOUT_SECONDS = originalTimeout;
    }
  }
}

if (process.argv.includes('--self-test')) {
  runSelfTests();
} else if (import.meta.url === `file://${process.argv[1]}`) {
  runGateWithTransientRetries().catch((error) => {
    console.error(`Required CI Gate failed: ${errorMessage(error)}`);
    process.exit(1);
  });
}
