/**
 * Owner-only Pepperstone USD DEMO rescue when a Confirmed Reversal trade has
 * reached 0.30-0.50R but never qualified for the 0.50R broker-net giveback
 * lock, and then suffers a independently broker-quoted, persistent reversal.
 *
 * Unlike normal profit harvesting, this is a LOSS-LIMITING intervention: it
 * may realize a small loss and cannot guarantee a fill at the sampled mark.
 * It is never an entry veto, a take-profit modification or LIVE authority.
 */
export const PEPPERSTONE_DEMO_POST_PEAK_ADVERSE_RESCUE_ARTIFACT =
  'pepperstone-owner-demo-confirmed-reversal-post-peak-loss-rescue-v1' as const;

export interface PepperstoneDemoPostPeakRescueInput {
  enabled: boolean;
  brokerId: string;
  accountType: string;
  accountCurrency: string | null;
  ownerUserId: string | null;
  userId: string;
  strategyRoute: string | null;
  isM1Strategy: boolean;
  tradeInstrument: string;
  brokerInstrument: string;
  tradeDirection: 'BUY' | 'SELL';
  brokerDirection: string;
  tradeLots: number | null;
  brokerLots: number | null;
  entryPrice: number | null;
  currentPrice: number | null;
  originalStop: number | null;
  brokerStop: number | null;
  originalTakeProfit: number | null;
  brokerTakeProfit: number | null;
  initialRiskPnl: number | null;
  peakBrokerNetPnl: number;
  currentBrokerNetPnl: number;
  previousObservationCount: number;
  elapsedMinutes: number;
  m1: {
    completedBars: number;
    adverseBars: number;
    liveQuoteBars: number;
    consecutiveLiveQuoteBars: number;
    alignedLatestBodyPressure: number;
    alignedMomentum3: number;
    latestAgeSeconds: number;
    latestLiveSpreadPrice: number | null;
  } | null;
}

export type PepperstoneDemoPostPeakRescueDecision = {
  artifact: typeof PEPPERSTONE_DEMO_POST_PEAK_ADVERSE_RESCUE_ARTIFACT;
  shouldClose: boolean;
  reason:
    | 'DISABLED_OR_NOT_OWNER_CONFIRMED_REVERSAL'
    | 'UNVERIFIED_POSITION_OR_BROKER_BARRIERS'
    | 'PEAK_NOT_IN_UNPROTECTED_BAND'
    | 'NO_QUALIFIED_POST_PEAK_ADVERSE_MOVE'
    | 'INSUFFICIENT_NATIVE_M1_REVERSAL_PROOF'
    | 'POST_PEAK_ADVERSE_LOSS_RESCUE';
  peakR: number | null;
  currentR: number | null;
  noNewOrders: true;
  noBrokerAmendment: true;
  modifiesLive: false;
};

export function evaluatePepperstoneDemoPostPeakAdverseRescue(
  i: PepperstoneDemoPostPeakRescueInput,
): PepperstoneDemoPostPeakRescueDecision {
  const risk = i.initialRiskPnl;
  const peakR =
    risk !== null && Number.isFinite(risk) && risk > 0 ? i.peakBrokerNetPnl / risk : null;
  const currentR =
    risk !== null && Number.isFinite(risk) && risk > 0 ? i.currentBrokerNetPnl / risk : null;
  const answer = (
    reason: PepperstoneDemoPostPeakRescueDecision['reason'],
  ): PepperstoneDemoPostPeakRescueDecision => ({
    artifact: PEPPERSTONE_DEMO_POST_PEAK_ADVERSE_RESCUE_ARTIFACT,
    shouldClose: reason === 'POST_PEAK_ADVERSE_LOSS_RESCUE',
    reason,
    peakR,
    currentR,
    noNewOrders: true,
    noBrokerAmendment: true,
    modifiesLive: false,
  });
  if (
    !i.enabled ||
    i.brokerId !== 'pepperstone-ctrader' ||
    i.accountType !== 'DEMO' ||
    i.accountCurrency !== 'USD' ||
    !i.ownerUserId ||
    i.userId !== i.ownerUserId ||
    i.strategyRoute !== 'CONFIRMED_REVERSAL' ||
    !i.isM1Strategy
  )
    return answer('DISABLED_OR_NOT_OWNER_CONFIRMED_REVERSAL');

  const needed = [
    i.tradeLots,
    i.brokerLots,
    i.entryPrice,
    i.currentPrice,
    i.originalStop,
    i.brokerStop,
    i.originalTakeProfit,
    i.brokerTakeProfit,
    i.initialRiskPnl,
    i.peakBrokerNetPnl,
    i.currentBrokerNetPnl,
    i.elapsedMinutes,
    i.previousObservationCount,
  ];
  if (
    i.tradeInstrument !== i.brokerInstrument ||
    i.tradeDirection !== i.brokerDirection ||
    needed.some((x) => x === null || !Number.isFinite(x)) ||
    (i.tradeLots ?? 0) <= 0 ||
    (i.brokerLots ?? 0) <= 0 ||
    Math.abs(i.tradeLots! - i.brokerLots!) > 0.0001 ||
    (i.entryPrice ?? 0) <= 0 ||
    (i.currentPrice ?? 0) <= 0 ||
    (i.originalStop ?? 0) <= 0 ||
    (i.brokerStop ?? 0) <= 0 ||
    (i.originalTakeProfit ?? 0) <= 0 ||
    (i.brokerTakeProfit ?? 0) <= 0 ||
    (i.initialRiskPnl ?? 0) <= 0 ||
    Math.abs(i.originalStop! - i.brokerStop!) > Math.max(0.000001, i.originalStop! * 1e-7) ||
    Math.abs(i.originalTakeProfit! - i.brokerTakeProfit!) >
      Math.max(0.000001, i.originalTakeProfit! * 1e-7) ||
    !(i.tradeDirection === 'BUY'
      ? i.originalStop! < i.currentPrice! &&
        i.currentPrice! < i.entryPrice! &&
        i.entryPrice! < i.originalTakeProfit!
      : i.originalTakeProfit! < i.entryPrice! &&
        i.entryPrice! < i.currentPrice! &&
        i.currentPrice! < i.originalStop!)
  )
    return answer('UNVERIFIED_POSITION_OR_BROKER_BARRIERS');

  // Only the exact gap exposed by the owner EURUSD loss. Once >=0.50R,
  // the existing tiered broker-net profit protector retains authority.
  if (peakR === null || peakR < 0.3 || peakR >= 0.5) return answer('PEAK_NOT_IN_UNPROTECTED_BAND');
  // Require that the trade has genuinely given back its previous peak and
  // is LOSING, but the broker hard stop has not already been approached.
  // No action on a temporary positive pullback or first few quote ticks.
  if (
    currentR === null ||
    currentR > 0 ||
    currentR <= -0.7 ||
    i.peakBrokerNetPnl - i.currentBrokerNetPnl < i.initialRiskPnl! * 0.3 ||
    !Number.isInteger(i.previousObservationCount) ||
    i.previousObservationCount < 12 ||
    i.elapsedMinutes < 2
  )
    return answer('NO_QUALIFIED_POST_PEAK_ADVERSE_MOVE');

  const m = i.m1;
  const stopRisk = Math.abs(i.entryPrice! - i.originalStop!);
  if (
    !m ||
    !Number.isInteger(m.completedBars) ||
    m.completedBars < 3 ||
    !Number.isInteger(m.adverseBars) ||
    m.adverseBars < 3 ||
    !Number.isInteger(m.liveQuoteBars) ||
    m.liveQuoteBars < 2 ||
    !Number.isInteger(m.consecutiveLiveQuoteBars) ||
    m.consecutiveLiveQuoteBars < 2 ||
    !Number.isFinite(m.latestAgeSeconds) ||
    m.latestAgeSeconds < 0 ||
    m.latestAgeSeconds > 75 ||
    !Number.isFinite(m.alignedMomentum3) ||
    m.alignedMomentum3 > -0.3 ||
    !Number.isFinite(m.alignedLatestBodyPressure) ||
    m.alignedLatestBodyPressure > -0.35 ||
    m.latestLiveSpreadPrice === null ||
    !Number.isFinite(m.latestLiveSpreadPrice) ||
    m.latestLiveSpreadPrice <= 0 ||
    m.latestLiveSpreadPrice > stopRisk * 0.25
  )
    return answer('INSUFFICIENT_NATIVE_M1_REVERSAL_PROOF');

  return answer('POST_PEAK_ADVERSE_LOSS_RESCUE');
}
