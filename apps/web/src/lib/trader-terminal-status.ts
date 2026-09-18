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

function decimalAsString(value: unknown): string | null {
  if (typeof value === 'string' && value.trim() !== '') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function integerAsNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function normalizeRiskStatus(value: unknown): RiskStatusView | null {
  if (!isRecord(value) || !isRecord(value.limits)) return null;
  const limits = value.limits;
  const allowed = limits.allowedInstruments;
  const allowedIsValid =
    allowed === 'ALL' ||
    (Array.isArray(allowed) && allowed.every((instrument) => typeof instrument === 'string'));
  const maxDailyLossPercent = decimalAsString(limits.maxDailyLossPercent);
  const maxDrawdownPercent = decimalAsString(limits.maxDrawdownPercent);
  const maxOpenTrades = integerAsNumber(limits.maxOpenTrades);
  const maxPositionSizeLot = decimalAsString(limits.maxPositionSizeLot);
  const maxVolatilityScore = decimalAsString(limits.maxVolatilityScore);

  if (
    typeof value.killSwitchActive !== 'boolean' ||
    typeof value.brokerConnected !== 'boolean' ||
    typeof value.canTrade !== 'boolean' ||
    maxDailyLossPercent === null ||
    maxDrawdownPercent === null ||
    maxOpenTrades === null ||
    maxPositionSizeLot === null ||
    !allowedIsValid ||
    maxVolatilityScore === null
  ) {
    return null;
  }

  return {
    killSwitchActive: value.killSwitchActive,
    brokerConnected: value.brokerConnected,
    canTrade: value.canTrade,
    limits: {
      maxDailyLossPercent,
      maxDrawdownPercent,
      maxOpenTrades,
      maxPositionSizeLot,
      allowedInstruments: allowed as string[] | 'ALL',
      maxVolatilityScore,
    },
  };
}

function normalizeTradingSession(value: unknown): TradingSessionView | null {
  if (!isRecord(value)) return null;
  const authorityGeneration = integerAsNumber(value.authorityGeneration);
  if (
    typeof value.id !== 'string' ||
    typeof value.brokerConnectionId !== 'string' ||
    !isExecutionMode(value.executionMode) ||
    authorityGeneration === null ||
    authorityGeneration < 1 ||
    !isTradingSessionStatus(value.status) ||
    typeof value.startedAt !== 'string'
  ) {
    return null;
  }

  return {
    ...(value as unknown as TradingSessionView),
    authorityGeneration,
  };
}

function normalizeActiveTradingSessionPayload(
  value: unknown,
): { valid: true; session: TradingSessionView | null } | { valid: false } {
  if (value === null) return { valid: true, session: null };
  const session = normalizeTradingSession(value);
  return session ? { valid: true, session } : { valid: false };
}

function normalizeTerminalBroker(value: unknown): TerminalBrokerView | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.id !== 'string' ||
    typeof value.brokerId !== 'string' ||
    typeof value.brokerName !== 'string' ||
    (value.accountType !== 'DEMO' && value.accountType !== 'LIVE') ||
    !isBrokerStatus(value.status)
  ) {
    return null;
  }

  return {
    id: value.id,
    brokerId: value.brokerId,
    brokerName: value.brokerName,
    displayName: typeof value.displayName === 'string' ? value.displayName : null,
    accountType: value.accountType,
    status: value.status,
    authorizationStatus: isTerminalBrokerAuthorizationStatus(value.authorizationStatus)
      ? value.authorizationStatus
      : 'NOT_CONNECTED',
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

/** Load only broker state so the UI can preserve a valid connected account
 * even when another core read is temporarily incompatible/unavailable. */
export async function loadTraderBrokerConnections(): Promise<TerminalBrokerView[]> {
  const brokerPayload = await readWithSingleNetworkRetry(() => api.listBrokerConnections());
  if (!Array.isArray(brokerPayload)) {
    throw new Error('Broker connection contract mismatch');
  }
  const brokers = brokerPayload.map(normalizeTerminalBroker);
  if (brokers.some((broker) => broker === null)) {
    throw new Error('Broker connection contract mismatch');
  }
  return brokers as TerminalBrokerView[];
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
  const [riskPayload, sessionPayload, brokers] = await Promise.all([
    readWithSingleNetworkRetry(() => api.request<unknown>('/risk/status')),
    readWithSingleNetworkRetry(() => api.request<unknown>('/trading/sessions/active')),
    loadTraderBrokerConnections(),
  ]);

  const risk = normalizeRiskStatus(riskPayload);
  if (!risk) {
    throw new Error('Risk status contract mismatch');
  }
  const normalizedSession = normalizeActiveTradingSessionPayload(sessionPayload);
  if (!normalizedSession.valid) {
    throw new Error('Trading session contract mismatch');
  }

  const session = normalizedSession.session;
  const sessionBroker = session
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
    brokers,
    sessionBroker,
    primaryBroker,
  };
}
