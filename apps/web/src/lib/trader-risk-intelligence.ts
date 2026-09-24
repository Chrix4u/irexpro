import { createRiskIntelligenceApi } from '@irexpro/api-client/risk-intelligence';
import type {
  RiskIntelligenceView,
  RiskRejectionCodeView,
  RiskTradingMode,
  RiskViolationSummaryView,
} from '@irexpro/types/risk-intelligence';
import { api } from '@/lib/api';

const riskIntelligenceApi = createRiskIntelligenceApi(api);

const REJECTION_CODES = new Set<RiskRejectionCodeView>([
  'KILL_SWITCH_ACTIVE',
  'SESSION_NOT_ACTIVE',
  'BROKER_DISCONNECTED',
  'DAILY_LOSS_LIMIT_REACHED',
  'MAX_DRAWDOWN_REACHED',
  'INSUFFICIENT_MARGIN',
  'MAX_CONCURRENT_TRADES',
  'MAX_DAILY_TRADES',
  'POSITION_SIZE_EXCEEDED',
  'MISSING_STOP_LOSS',
  'MISSING_TAKE_PROFIT',
  'INVALID_SL_DISTANCE',
  'INVALID_TP_DIRECTION',
  'LEVERAGE_EXCEEDED',
  'INSTRUMENT_NOT_ALLOWED',
  'HIGH_VOLATILITY',
  'LOW_LIQUIDITY_REGIME',
  'DUPLICATE_SIGNAL',
  'RISK_ENGINE_ERROR',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const allowed = [...expected].sort();
  return keys.length === allowed.length && keys.every((key, index) => key === allowed[index]);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isIsoDateString(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  return !Number.isNaN(new Date(value).getTime());
}

function isTradingMode(value: unknown): value is RiskTradingMode {
  return value === 'PAPER_ONLY' || value === 'SEMI_AUTO' || value === 'FULL_AUTO';
}

function isRejectionCode(value: unknown): value is RiskRejectionCodeView {
  return typeof value === 'string' && REJECTION_CODES.has(value as RiskRejectionCodeView);
}

function isViolation(value: unknown): value is RiskViolationSummaryView {
  if (!isRecord(value)) return false;
  if (!hasExactKeys(value, ['id', 'rejectionCode', 'rejectionReason', 'evaluatedAt'])) {
    return false;
  }

  return (
    typeof value.id === 'string' &&
    isRejectionCode(value.rejectionCode) &&
    typeof value.rejectionReason === 'string' &&
    isIsoDateString(value.evaluatedAt)
  );
}

export function isRiskIntelligenceView(value: unknown): value is RiskIntelligenceView {
  if (!isRecord(value)) return false;
  if (!hasExactKeys(value, ['engine', 'policy', 'execution', 'portfolio', 'recentViolations'])) {
    return false;
  }

  const { engine, policy, execution, portfolio, recentViolations } = value;
  if (!isRecord(engine) || !hasExactKeys(engine, ['killSwitchActive', 'brokerConnected'])) {
    return false;
  }
  if (
    typeof engine.killSwitchActive !== 'boolean' ||
    typeof engine.brokerConnected !== 'boolean'
  ) {
    return false;
  }

  if (!isRecord(policy) || !hasExactKeys(policy, ['riskAcknowledgementAccepted', 'allowedTradingMode', 'limits'])) {
    return false;
  }
  if (
    typeof policy.riskAcknowledgementAccepted !== 'boolean' ||
    !isTradingMode(policy.allowedTradingMode) ||
    !isRecord(policy.limits)
  ) {
    return false;
  }

  const limits = policy.limits;
  if (
    !hasExactKeys(limits, [
      'maxDailyLossPercent',
      'maxDrawdownPercent',
      'maxOpenTrades',
      'maxPositionSizeLot',
      'minStopLossPips',
      'maxVolatilityScore',
      'maxTradeRiskPercent',
      'maxLeverageAllowed',
      'allowedInstruments',
      'rejectLowLiquidity',
    ]) ||
    typeof limits.maxDailyLossPercent !== 'string' ||
    typeof limits.maxDrawdownPercent !== 'string' ||
    !isNonNegativeInteger(limits.maxOpenTrades) ||
    typeof limits.maxPositionSizeLot !== 'string' ||
    typeof limits.minStopLossPips !== 'string' ||
    typeof limits.maxVolatilityScore !== 'string' ||
    typeof limits.maxTradeRiskPercent !== 'string' ||
    !isNonNegativeInteger(limits.maxLeverageAllowed) ||
    !(
      limits.allowedInstruments === null ||
      (Array.isArray(limits.allowedInstruments) &&
        limits.allowedInstruments.every((instrument) => typeof instrument === 'string'))
    ) ||
    typeof limits.rejectLowLiquidity !== 'boolean'
  ) {
    return false;
  }

  if (
    !isRecord(execution) ||
    !hasExactKeys(execution, [
      'openPositions',
      'maxOpenPositions',
      'openPositionSlotsRemaining',
      'todayTrades',
      'dailyTradeCountPolicy',
    ]) ||
    !isNonNegativeInteger(execution.openPositions) ||
    !isNonNegativeInteger(execution.maxOpenPositions) ||
    !isNonNegativeInteger(execution.openPositionSlotsRemaining) ||
    !isNonNegativeInteger(execution.todayTrades) ||
    execution.dailyTradeCountPolicy !== 'UNBOUNDED'
  ) {
    return false;
  }

  if (
    !isRecord(portfolio) ||
    !hasExactKeys(portfolio, [
      'totalAccounts',
      'connectedAccounts',
      'freshSnapshots',
      'staleSnapshots',
      'unavailableSnapshots',
    ]) ||
    !isNonNegativeInteger(portfolio.totalAccounts) ||
    !isNonNegativeInteger(portfolio.connectedAccounts) ||
    !isNonNegativeInteger(portfolio.freshSnapshots) ||
    !isNonNegativeInteger(portfolio.staleSnapshots) ||
    !isNonNegativeInteger(portfolio.unavailableSnapshots)
  ) {
    return false;
  }

  return Array.isArray(recentViolations) && recentViolations.every(isViolation);
}

/**
 * Load the server-authoritative risk intelligence snapshot.
 *
 * Any unexpected field or malformed value rejects the entire snapshot. The
 * browser never infers hidden risk state or reconstructs financial exposure.
 */
export async function loadTraderRiskIntelligence(): Promise<RiskIntelligenceView> {
  const snapshot = await riskIntelligenceApi.getSnapshot();
  if (!isRiskIntelligenceView(snapshot)) {
    throw new Error('Risk intelligence contract mismatch');
  }
  return snapshot;
}
