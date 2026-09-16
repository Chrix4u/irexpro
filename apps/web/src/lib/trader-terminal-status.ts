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
  risk: RiskStatusView;
  session: TradingSessionView | null;
  brokers: TerminalBrokerView[];
  /** Broker bound to the active session, when one exists and is visible. */
  sessionBroker: TerminalBrokerView | null;
  /** Best broker to surface when there is no active-session match. */
  primaryBroker: TerminalBrokerView | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
function isActiveTradingSessionPayload(
  value: unknown,
): value is TradingSessionView | null {
  return value === null || isTradingSession(value);
}

function isTerminalBroker(value: unknown): value is TerminalBrokerView {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.brokerId === 'string' &&
    typeof value.brokerName === 'string' &&
    (value.displayName === null || typeof value.displayName === 'string') &&
    (value.accountType === 'DEMO' || value.accountType === 'LIVE') &&
    isBrokerStatus(value.status) &&
    (value.authorizationStatus === undefined ||
      isTerminalBrokerAuthorizationStatus(value.authorizationStatus)) &&
    typeof value.liveTradingEnabled === 'boolean' &&
    (value.providerBrokerIdentity === undefined ||
      value.providerBrokerIdentity === null ||
      typeof value.providerBrokerIdentity === 'string') &&
    (value.logicalAccountKey === undefined ||
      value.logicalAccountKey === null ||
      typeof value.logicalAccountKey === 'string') &&
    (value.lastHealthCheckAt === null || typeof value.lastHealthCheckAt === 'string') &&
    (value.lastErrorMessage === null || typeof value.lastErrorMessage === 'string')
  );
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
  const [riskPayload, sessionPayload, brokerPayload] = await Promise.all([
    api.request<unknown>('/risk/status'),
    api.request<unknown>('/trading/sessions/active'),
    api.listBrokerConnections(),
  ]);

  if (!isRiskStatus(riskPayload)) {
    throw new Error('Risk status contract mismatch');
  }
  if (!isActiveTradingSessionPayload(sessionPayload)) {
    throw new Error('Trading session contract mismatch');
  }
  if (!Array.isArray(brokerPayload) || !brokerPayload.every(isTerminalBroker)) {
    throw new Error('Broker connection contract mismatch');
  }

  const session = sessionPayload;
  const brokers: TerminalBrokerView[] = brokerPayload;
  const sessionBroker = session
    ? brokers.find((broker) => broker.id === session.brokerConnectionId) ?? null
    : null;

  const primaryBroker =
    sessionBroker ??
    brokers.find((broker) => broker.status === 'CONNECTED') ??
    brokers[0] ??
    null;

  return {
    risk: riskPayload,
    session,
    brokers,
    sessionBroker,
    primaryBroker,
  };
}
