/**
 * Pepperstone cTrader DEMO hypothesis: after an established >=0.50R peak,
 * reduce a later confirmed trend-failure drawdown before the full broker SL.
 *
 * This is NOT the ordinary 0.395R-armed profit-lock: it is designed to
 * avoid harvesting a temporarily retracing TP winner. The caller must use
 * this as SHADOW until independent after-fee/future holdout validation.
 * A deploy does not grant broker close authority.
 */
export const PEPPERSTONE_PEAK_LOSS_RESCUE_ARTIFACT =
  'pepperstone-demo-confirmed-peak-loss-rescue-shadow-v1' as const;

export interface PepperstoneRescueM1Evidence {
  completedBars: number;
  adverseBars: number;
  liveQuoteBars: number;
  consecutiveLiveQuoteBars: number;
  alignedLatestBodyPressure: number;
  alignedMomentum3: number;
  latestAgeSeconds: number;
}

export type PepperstonePeakLossReason =
  | 'OUTSIDE_PEPPERSTONE_DEMO'
  | 'INSTRUMENT_OR_DIRECTION_MISMATCH'
  | 'UNSUPPORTED_STRATEGY_ROUTE'
  | 'NO_RELIABLE_INITIAL_RISK'
  | 'INSUFFICIENT_BROKER_OBSERVATIONS'
  | 'POSITION_TOO_YOUNG'
  | 'NO_MEANINGFUL_PROFIT_PEAK'
  | 'STILL_WITHIN_RECOVERY_BAND'
  | 'BROKER_STOP_ALREADY_BREACHED'
  | 'BROKER_PRICE_NOT_ADVERSE'
  | 'BROKER_STOP_NOT_VERIFIED'
  | 'STALE_OR_INSUFFICIENT_M1_QUOTES'
  | 'DIRECTIONAL_REVERSAL_UNCONFIRMED'
  | 'CONFIRMED_PEAK_TO_LOSS_CANDIDATE';

export function evaluatePepperstonePeakLossRescue(input: {
  brokerId: string;
  accountType: string;
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
  currentPnl: number;
  previousObservationCount: number;
  elapsedMinutes: number;
  authoritativeStop: number | null;
  brokerStop: number | null;
  currentPrice: number | null;
  brokerEntryPrice: number | null;
  m1: PepperstoneRescueM1Evidence | null;
}): {
  artifact: typeof PEPPERSTONE_PEAK_LOSS_RESCUE_ARTIFACT;
  mode: 'SHADOW_ONLY';
  modifiesExecution: false;
  grantsExecution: false;
  productionEligible: false;
  wouldReduceDrawdown: boolean;
  reason: PepperstonePeakLossReason;
  peakR: number | null;
  currentR: number | null;
} {
  const report = (
    reason: PepperstonePeakLossReason,
    peakR: number | null,
    currentR: number | null,
  ) => ({
    artifact: PEPPERSTONE_PEAK_LOSS_RESCUE_ARTIFACT,
    mode: 'SHADOW_ONLY' as const,
    modifiesExecution: false as const,
    grantsExecution: false as const,
    productionEligible: false as const,
    wouldReduceDrawdown: reason === 'CONFIRMED_PEAK_TO_LOSS_CANDIDATE',
    reason,
    peakR,
    currentR,
  });
  if (input.brokerId !== 'pepperstone-ctrader' || input.accountType !== 'DEMO') {
    return report('OUTSIDE_PEPPERSTONE_DEMO', null, null);
  }
  if (
    input.tradeInstrument.trim().toUpperCase() !== input.brokerInstrument.trim().toUpperCase() ||
    input.tradeDirection !== input.brokerDirection ||
    !Number.isFinite(input.tradeLotSize) ||
    input.tradeLotSize <= 0 ||
    !Number.isFinite(input.brokerLotSize) ||
    Math.abs(input.tradeLotSize - input.brokerLotSize) > 0.0001
  ) {
    return report('INSTRUMENT_OR_DIRECTION_MISMATCH', null, null);
  }
  if (!input.isM1Strategy || input.strategyRoute !== 'TREND_CONTINUATION') {
    return report('UNSUPPORTED_STRATEGY_ROUTE', null, null);
  }
  const risk = input.initialRiskPnl;
  if (
    risk === null ||
    !Number.isFinite(risk) ||
    risk <= 0 ||
    !Number.isFinite(input.previousPeakPnl) ||
    !Number.isFinite(input.currentPnl)
  ) {
    return report('NO_RELIABLE_INITIAL_RISK', null, null);
  }
  const peakR = input.previousPeakPnl / risk;
  const currentR = input.currentPnl / risk;
  if (
    !Number.isFinite(input.previousObservationCount) ||
    input.previousObservationCount < 12
  ) {
    return report('INSUFFICIENT_BROKER_OBSERVATIONS', peakR, currentR);
  }
  if (!Number.isFinite(input.elapsedMinutes) || input.elapsedMinutes < 3) {
    return report('POSITION_TOO_YOUNG', peakR, currentR);
  }
  if (peakR < 0.5) return report('NO_MEANINGFUL_PROFIT_PEAK', peakR, currentR);
  // A normal profit retracement, even from a >1R peak, is NOT sufficient
  // to rescue: the trade must first turn into a meaningful gross loss.
  // At <-0.85R, broker SL is likely imminent; never race the broker.
  if (currentR > -0.25 || currentR <= -0.85) {
    return report('STILL_WITHIN_RECOVERY_BAND', peakR, currentR);
  }
  if (
    input.authoritativeStop === null ||
    input.brokerStop === null ||
    input.currentPrice === null ||
    input.brokerEntryPrice === null ||
    ![input.authoritativeStop, input.brokerStop, input.currentPrice, input.brokerEntryPrice].every(
      (value) => Number.isFinite(value) && value > 0,
    ) ||
    Math.abs(input.brokerStop - input.authoritativeStop) >
      Math.max(0.00001, input.authoritativeStop * 1e-7)
  ) {
    return report('BROKER_STOP_NOT_VERIFIED', peakR, currentR);
  }
  const breached =
    input.tradeDirection === 'BUY'
      ? input.currentPrice <= input.authoritativeStop
      : input.currentPrice >= input.authoritativeStop;
  if (breached) return report('BROKER_STOP_ALREADY_BREACHED', peakR, currentR);
  const adversePrice = input.tradeDirection === 'BUY'
    ? input.currentPrice < input.brokerEntryPrice
    : input.currentPrice > input.brokerEntryPrice;
  if (!adversePrice) return report('BROKER_PRICE_NOT_ADVERSE', peakR, currentR);

  const m1 = input.m1;
  if (
    !m1 ||
    !Number.isFinite(m1.latestAgeSeconds) ||
    m1.latestAgeSeconds < 0 ||
    m1.latestAgeSeconds > 90 ||
    m1.completedBars < 2 ||
    m1.liveQuoteBars < 2 ||
    m1.consecutiveLiveQuoteBars < 2 ||
    !Number.isFinite(m1.alignedLatestBodyPressure) ||
    !Number.isFinite(m1.alignedMomentum3)
  ) {
    return report('STALE_OR_INSUFFICIENT_M1_QUOTES', peakR, currentR);
  }
  if (
    m1.adverseBars < 2 ||
    m1.alignedLatestBodyPressure > -0.2 ||
    m1.alignedMomentum3 > -0.15
  ) {
    return report('DIRECTIONAL_REVERSAL_UNCONFIRMED', peakR, currentR);
  }
  return report('CONFIRMED_PEAK_TO_LOSS_CANDIDATE', peakR, currentR);
}
