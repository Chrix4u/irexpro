import type { BrokerConnectionView } from '@irexpro/types';
import type {
  TradingSessionStatus,
  TradingSessionView,
} from '@irexpro/types/execution';
import { api } from '@/lib/api';

// The authoritative session contract now lives in the shared types package
// (Sprint 56 correction round 5 — issues #292/#293/#295/#298): the session
// carries the durable executionMode + authorityGeneration, and
// GET /trading/sessions/active returns the `{ session }` envelope.
// `TradingSessionStatusView` keeps the historical web-local name for callers.
export type { TradingSessionStatus as TradingSessionStatusView, TradingSessionView };

/** GET /risk/status — authoritative risk-gate summary. */
export interface RiskStatusView {
  killSwitchActive: boolean;
  brokerConnected: boolean;
  canTrade: boolean;
  limits: {
    maxDailyLossPercent: string;
    maxDrawdownPercent: string;
    maxOpenTrades: number;
    maxPositionSizeLot: string;
    allowedInstruments: string[] | 'ALL';
    maxVolatilityScore: string;
  };
}

/**
 * Broker fields the terminal is allowed to consume. This intentionally omits
 * the historical frontend type's userId assumption because the backend's
 * BrokerConnectionResponseDto does not expose userId.
 *
 * `liveTradingEnabled` stays in the Pick only as a COMPATIBILITY MIRROR —
 * it is never the authoritative trading state (the session executionMode +
 * authorization/executable gates are). `authorizationStatus` and the
 * identity fields feed the execution-authority truthfulness UI (Sprint 56
 * correction round 5).
 */
export type TerminalBrokerView = Pick<
  BrokerConnectionView,
  | 'id'
  | 'brokerId'
  | 'brokerName'
  | 'displayName'
  | 'accountType'
  | 'status'
  | 'authorizationStatus'
  | 'liveTradingEnabled'
  | 'providerBrokerIdentity'
  | 'logicalAccountKey'
  | 'lastHealthCheckAt'
  | 'lastErrorMessage'
>;

export interface TraderTerminalStatus {
  /** Null means the authoritative risk read could not be validated. */
  risk: RiskStatusView | null;
  /**
   * Null means the API authoritatively reported no active session only when
   * sessionStateKnown=true. If false, null means unknown and MUST fail closed.
   */
  session: TradingSessionView | null;
  sessionStateKnown: boolean;
  brokers: TerminalBrokerView[];
  /** Broker bound to the active session, when one exists and is visible. */
  sessionBroker: TerminalBrokerView | null;
  /** Best broker to surface when there is no active-session match. */
  primaryBroker: TerminalBrokerView | null;
  /** Non-fatal control-state failures that must not erase broker identity. */
  controlWarnings: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNetworkReadFailure(error: unknown): boolean {
  if (!isRecord(error)) return false;
  if (error.statusCode === 0) return true;
  const message = typeof error.message === 'string' ? error.message.toLowerCase() : '';
  return (
    message.includes('network error contacting api') ||
    message.includes('failed to fetch') ||
    message.includes('network request failed')
  );
}

async function readWithSingleNetworkRetry<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (!isNetworkReadFailure(error)) throw error;
    await new Promise((resolve) => setTimeout(resolve, 150));
    return read();
  }
}

function isTradingSessionStatus(value: unknown): value is TradingSessionView['status'] {
  return (
    value === 'ACTIVE' ||
    value === 'PAUSED' ||
    value === 'SUSPENDED_RISK_LIMIT' ||
    value === 'SUSPENDED_BROKER' ||
    value === 'ENDED'
  );
}

function isExecutionMode(value: unknown): value is TradingSessionView['executionMode'] {
  return value === 'PAPER_ONLY' || value === 'SEMI_AUTO' || value === 'FULL_AUTO';
}

function isBrokerStatus(value: unknown): value is TerminalBrokerView['status'] {
  return (
    value === 'CONNECTING' ||
    value === 'CONNECTED' ||
    value === 'DISCONNECTED' ||
    value === 'ERROR' ||
    value === 'SUSPENDED'
  );
}

function isRiskStatus(value: unknown): value is RiskStatusView {
  if (!isRecord(value) || !isRecord(value.limits)) return false;
  const limits = value.limits;
  const allowed = limits.allowedInstruments;
  const allowedIsValid =
    allowed === 'ALL' ||
    (Array.isArray(allowed) && allowed.every((instrument) => typeof instrument === 'string'));

  return (
    typeof value.killSwitchActive === 'boolean' &&
    typeof value.brokerConnected === 'boolean' &&
    typeof value.canTrade === 'boolean' &&
    typeof limits.maxDailyLossPercent === 'string' &&
    typeof limits.maxDrawdownPercent === 'string' &&
    typeof limits.maxOpenTrades === 'number' &&
    typeof limits.maxPositionSizeLot === 'string' &&
    allowedIsValid &&
    typeof limits.maxVolatilityScore === 'string'
  );
}

function isTradingSession(value: unknown): value is TradingSessionView {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.brokerConnectionId === 'string' &&
    isExecutionMode(value.executionMode) &&
    typeof value.authorityGeneration === 'number' &&
    Number.isInteger(value.authorityGeneration) &&
    value.authorityGeneration >= 1 &&
    isTradingSessionStatus(value.status) &&
    typeof value.startedAt === 'string'
  );
}

/**
 * Guard the GET /trading/sessions/active payload.
 *
 * The API returns the session DTO DIRECTLY (bare object) — null when no
 * session is active. Any other shape fails CLOSED: the cockpit would
 * rather show a contract error than trust an unknown shape.
 */
function normalizeActiveTradingSessionPayload(
  value: unknown,
): { known: true; session: TradingSessionView | null } | null {
  if (value === null) {
    return { known: true, session: null };
  }

  if (isTradingSession(value)) {
    return { known: true, session: value };
  }

  // Rolling-deploy compatibility: older/shared-client documentation and some
  // intermediate builds used a { session } envelope while the current API
  // returns the session DTO directly. Accept either transport shape, but only
  // after validating the exact same authoritative session fields. Unknown
  // shapes still fail closed.
  if (isRecord(value) && Object.prototype.hasOwnProperty.call(value, 'session')) {
    const nested = value.session;
    if (nested === null) {
      return { known: true, session: null };
    }
    if (isTradingSession(nested)) {
      return { known: true, session: nested };
    }
  }

  return null;
}

function normalizeTerminalBroker(value: unknown): TerminalBrokerView | null {
  if (!isRecord(value)) return null;

  // Security/identity-critical fields must be present and valid. We never
  // fabricate a broker identity, account environment, or connection state.
  if (
    typeof value.id !== 'string' ||
    typeof value.brokerId !== 'string' ||
    typeof value.brokerName !== 'string' ||
    (value.accountType !== 'DEMO' && value.accountType !== 'LIVE') ||
    !isBrokerStatus(value.status)
  ) {
    return null;
  }

  const authorizationStatus = isTerminalBrokerAuthorizationStatus(value.authorizationStatus)
    ? value.authorizationStatus
    : 'NOT_CONNECTED';

  // Historical/rolling-deploy rows may omit non-authoritative presentation
  // metadata. Normalize those fields instead of rejecting the entire broker
  // collection. Missing execution metadata always degrades fail-closed.
  return {
    id: value.id,
    brokerId: value.brokerId,
    brokerName: value.brokerName,
    displayName: typeof value.displayName === 'string' ? value.displayName : null,
    accountType: value.accountType,
    status: value.status,
    authorizationStatus,
    liveTradingEnabled:
      typeof value.liveTradingEnabled === 'boolean' ? value.liveTradingEnabled : false,
    providerBrokerIdentity:
      typeof value.providerBrokerIdentity === 'string' ? value.providerBrokerIdentity : null,
    logicalAccountKey:
      typeof value.logicalAccountKey === 'string' ? value.logicalAccountKey : null,
    lastHealthCheckAt:
      typeof value.lastHealthCheckAt === 'string' ? value.lastHealthCheckAt : null,
    lastErrorMessage:
      typeof value.lastErrorMessage === 'string' ? value.lastErrorMessage : null,
  };
}

function isTerminalBrokerAuthorizationStatus(
  value: unknown,
): value is TerminalBrokerView['authorizationStatus'] {
  return (
    value === 'NOT_CONNECTED' ||
    value === 'CONNECTING' ||
    value === 'CONNECTED' ||
    value === 'VERIFYING' ||
    value === 'AUTHORIZATION_REQUIRED' ||
    value === 'AUTHORIZED' ||
    value === 'READY' ||
    value === 'ACTIVE' ||
    value === 'SUSPENDED' ||
    value === 'REVOKED' ||
    value === 'ERROR' ||
    value === 'DISCONNECTED'
  );
}

/**
 * Compose existing authoritative API contracts for the trading workspace.
 *
 * This function does not infer balances, P&L, positions, AI confidence, market
 * regime, or execution quality. Those values remain absent until dedicated
 * backend contracts exist. Runtime checks fail closed when an API response does
 * not match the expected frontend-safe contract.
 */
export async function loadTraderTerminalStatus(): Promise<TraderTerminalStatus> {
  const [riskResult, sessionResult, brokerResult] = await Promise.allSettled([
    readWithSingleNetworkRetry(() => api.request<unknown>('/risk/status')),
    readWithSingleNetworkRetry(() => api.request<unknown>('/trading/sessions/active')),
    readWithSingleNetworkRetry(() => api.listBrokerConnections()),
  ]);

  // Broker inventory is independently meaningful. If it cannot be loaded or
  // validated we have no truthful broker state and the page may fail normally.
  if (brokerResult.status === 'rejected') {
    throw brokerResult.reason;
  }
  if (!Array.isArray(brokerResult.value)) {
    throw new Error('Broker connection contract mismatch');
  }

  const normalized = brokerResult.value.map(normalizeTerminalBroker);
  if (normalized.some((broker) => broker === null)) {
    throw new Error('Broker connection contract mismatch');
  }
  const brokers = normalized as TerminalBrokerView[];

  const controlWarnings: string[] = [];

  let risk: RiskStatusView | null = null;
  if (riskResult.status === 'fulfilled' && isRiskStatus(riskResult.value)) {
    risk = riskResult.value;
  } else {
    controlWarnings.push(
      'Risk protection status could not be verified. AI Trading controls are temporarily disabled.',
    );
  }

  let session: TradingSessionView | null = null;
  let sessionStateKnown = false;
  const normalizedSession =
    sessionResult.status === 'fulfilled'
      ? normalizeActiveTradingSessionPayload(sessionResult.value)
      : null;

  if (normalizedSession) {
    session = normalizedSession.session;
    sessionStateKnown = normalizedSession.known;
  } else {
    controlWarnings.push(
      'AI session status could not be verified. Start/Stop is temporarily disabled.',
    );
  }

  const sessionBroker =
    sessionStateKnown && session
      ? brokers.find((broker) => broker.id === session.brokerConnectionId) ?? null
      : null;

  const primaryBroker =
    sessionBroker ??
    brokers.find((broker) => broker.status === 'CONNECTED') ??
    brokers[0] ??
    null;

  return {
    risk,
    session,
    sessionStateKnown,
    brokers,
    sessionBroker,
    primaryBroker,
    controlWarnings,
  };
}
