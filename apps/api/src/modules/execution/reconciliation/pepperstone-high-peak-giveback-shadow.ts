/**
 * Research-only high-peak profit-giveback confirmation for EXISTING
 * Pepperstone cTrader DEMO M1 continuation trades.
 *
 * The enabled Pepperstone early-net-profit lock explicitly excludes peaks
 * >= 0.5R to preserve full-TP winners. This independent prospective
 * observer addresses that blind spot WITHOUT opening or closing an order.
 *
 * Evidence requirements deliberately exceed an ordinary trailing stop:
 * broker-owned verified barriers/size, fresh completed broker M1 candles,
 * adverse momentum, causal prior closed-trade costs, and remaining broker
 * net profit after an extra conservative close-cost reserve.
 */
export const PEPPERSTONE_HIGH_PEAK_GIVEBACK_ARTIFACT =
  'pepperstone-ctrader-demo-high-peak-giveback-confirmation-shadow-v1' as const;

export type HighPeakGivebackReason =
  | 'OUTSIDE_OWNED_DEMO'
  | 'POSITION_IDENTITY_UNVERIFIED'
  | 'NOT_M1_CONTINUATION'
  | 'INITIAL_RISK_UNAVAILABLE'
  | 'OBSERVATIONS_NOT_MATURE'
  | 'BROKER_BARRIERS_UNVERIFIED'
  | 'NO_ESTABLISHED_HIGH_PEAK'
  | 'NO_DEEP_POSITIVE_GIVEBACK'
  | 'MISSING_CAUSAL_CLOSE_COSTS'
  | 'NO_POST_RESERVE_PROFIT'
  | 'CLOSE_PRICE_NOT_FAVORABLE'
  | 'DIRECTIONAL_REVERSAL_NOT_VERIFIED'
  | 'QUALIFIED_SHADOW_GIVEBACK';

export interface HighPeakM1QuoteEvidence {
  completedBars: number;
  adverseBars: number;
  liveQuoteBars: number;
  consecutiveLiveQuoteBars: number;
  alignedLatestBodyPressure: number;
  alignedMomentum3: number;
  latestAgeSeconds: number;
}

export interface PepperstoneHighPeakGivebackInput {
  brokerId: string;
  accountType: string;
  accountCurrency: string | null;
  tradeInstrument: string;
  brokerInstrument: string;
  tradeDirection: 'BUY' | 'SELL';
  brokerDirection: 'BUY' | 'SELL';
  tradeLotSize: number;
  brokerLotSize: number;
  strategyRoute: string | null;
  isM1Strategy: boolean;
  initialRiskPnl: number | null;
  previousPeakPnl: number;
  previousObservedPnl: number;
  currentBrokerNetPnl: number;
  previousObservationCount: number;
  elapsedMinutes: number;
  openedAt: Date | null;
  observedAt: Date;
  previousObservationAt: Date | null;
  brokerEntryPrice: number | null;
  currentPrice: number | null;
  authoritativeStop: number | null;
  brokerStop: number | null;
  authoritativeTakeProfit: number | null;
  brokerTakeProfit: number | null;
  conservativeExtraExitCost: number | null;
  causalFeeSampleCount: number;
  m1: HighPeakM1QuoteEvidence | null;
}

export function evaluatePepperstoneHighPeakGivebackShadow(
  input: PepperstoneHighPeakGivebackInput,
) {
  const risk = input.initialRiskPnl;
  const peakR = risk !== null && Number.isFinite(risk) && risk > 0
    ? input.previousPeakPnl / risk : null;
  const nowR = risk !== null && Number.isFinite(risk) && risk > 0
    ? input.currentBrokerNetPnl / risk : null;
  const report = (reason: HighPeakGivebackReason) => ({
    artifact: PEPPERSTONE_HIGH_PEAK_GIVEBACK_ARTIFACT,
    mode: 'RESEARCH_ONLY' as const,
    modifiesExecution: false as const,
    grantsExecution: false as const,
    promotionEligible: false as const,
    wouldProtectIfIndependentlyQualified: reason === 'QUALIFIED_SHADOW_GIVEBACK',
    reason,
    peakR,
    currentR: nowR,
    estimatedNetAfterExtraCost: input.conservativeExtraExitCost !== null
      ? input.currentBrokerNetPnl - input.conservativeExtraExitCost : null,
  });
  if (
    input.brokerId !== 'pepperstone-ctrader' ||
    input.accountType.toUpperCase() !== 'DEMO' ||
    input.accountCurrency?.toUpperCase() !== 'USD'
  ) return report('OUTSIDE_OWNED_DEMO');

  if (
    input.tradeInstrument.trim().toUpperCase() !== input.brokerInstrument.trim().toUpperCase() ||
    input.tradeDirection !== input.brokerDirection ||
    !Number.isFinite(input.tradeLotSize) || input.tradeLotSize <= 0 ||
    !Number.isFinite(input.brokerLotSize) ||
    Math.abs(input.tradeLotSize - input.brokerLotSize) > 1e-4
  ) return report('POSITION_IDENTITY_UNVERIFIED');

  if (!input.isM1Strategy || input.strategyRoute !== 'TREND_CONTINUATION')
    return report('NOT_M1_CONTINUATION');

  if (
    risk === null || !Number.isFinite(risk) || risk <= 0 ||
    ![input.previousPeakPnl, input.previousObservedPnl, input.currentBrokerNetPnl].every(Number.isFinite)
  ) return report('INITIAL_RISK_UNAVAILABLE');

  const age = input.elapsedMinutes;
  const previousAge = input.previousObservationAt
    ? (input.observedAt.getTime() - input.previousObservationAt.getTime()) / 1000 : NaN;
  if (
    !Number.isFinite(age) || age < 3 ||
    !input.openedAt || !Number.isFinite(input.openedAt.getTime()) ||
    !Number.isFinite(input.observedAt.getTime()) ||
    !Number.isFinite(previousAge) || previousAge < 0 || previousAge > 60 ||
    !Number.isInteger(input.previousObservationCount) ||
    input.previousObservationCount < 12
  ) return report('OBSERVATIONS_NOT_MATURE');

  const stop = input.authoritativeStop, brokerStop = input.brokerStop;
  const tp = input.authoritativeTakeProfit, brokerTp = input.brokerTakeProfit;
  const entry = input.brokerEntryPrice, mark = input.currentPrice;
  if (
    [stop, brokerStop, tp, brokerTp, entry, mark].some(
      x => x === null || !Number.isFinite(x) || x <= 0,
    ) ||
    Math.abs(stop! - brokerStop!) > Math.max(0.00001, stop! * 1e-7) ||
    Math.abs(tp! - brokerTp!) > Math.max(0.00001, tp! * 1e-7) ||
    (input.tradeDirection === 'BUY'
      ? !(stop! < entry! && entry! < mark! && mark! < tp!)
      : !(tp! < mark! && mark! < entry! && entry! < stop!))
  ) return report('BROKER_BARRIERS_UNVERIFIED');

  if (peakR === null || peakR < 1)
    return report('NO_ESTABLISHED_HIGH_PEAK');

  if (
    nowR === null || nowR <= 0 ||
    nowR > Math.min(0.4, peakR * 0.35) ||
    input.previousPeakPnl - input.currentBrokerNetPnl < Math.max(risk * 0.65, input.previousPeakPnl * 0.65) ||
    input.previousObservedPnl - input.currentBrokerNetPnl < Math.max(1, risk * 0.01)
  ) return report('NO_DEEP_POSITIVE_GIVEBACK');

  const fee = input.conservativeExtraExitCost;
  if (
    fee === null || !Number.isFinite(fee) || fee <= 0 ||
    !Number.isInteger(input.causalFeeSampleCount) || input.causalFeeSampleCount < 8
  ) return report('MISSING_CAUSAL_CLOSE_COSTS');

  if (input.currentBrokerNetPnl - fee < Math.max(1, risk * 0.05))
    return report('NO_POST_RESERVE_PROFIT');

  if (input.tradeDirection === 'BUY' ? !(mark! > entry!) : !(mark! < entry!))
    return report('CLOSE_PRICE_NOT_FAVORABLE');

  const m1 = input.m1;
  if (
    !m1 || m1.completedBars < 2 || m1.adverseBars < 2 ||
    m1.liveQuoteBars < 2 || m1.consecutiveLiveQuoteBars < 2 ||
    !Number.isFinite(m1.latestAgeSeconds) ||
    m1.latestAgeSeconds < 0 || m1.latestAgeSeconds > 90 ||
    !Number.isFinite(m1.alignedLatestBodyPressure) ||
    !Number.isFinite(m1.alignedMomentum3) ||
    m1.alignedLatestBodyPressure > -0.2 ||
    m1.alignedMomentum3 > -0.15
  ) return report('DIRECTIONAL_REVERSAL_NOT_VERIFIED');

  return report('QUALIFIED_SHADOW_GIVEBACK');
}
