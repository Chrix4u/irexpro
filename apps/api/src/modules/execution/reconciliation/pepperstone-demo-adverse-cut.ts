/**
 * Owner-only Pepperstone cTrader DEMO loss-control pilot.
 *
 * A broker stop remains authoritative. This never changes SL/TP, entries,
 * live accounts, or previously protected winners. Two complete consecutive
 * broker-native M1 candles must show material persistent opposition while the
 * existing position is still above its original protective stop.
 *
 * A closed trade may later recover; the criterion is a bounded, prospective
 * risk intervention, not a promise of improved P&L.
 */
export const PEPPERSTONE_DEMO_ADVERSE_CUT_ARTIFACT =
  'pepperstone-demo-persistent-adverse-m1-cut-v1';

export interface PepperstoneDemoAdverseM1Evidence {
  completedBars: number;
  adverseBars: number;
  consecutiveLiveQuoteBars?: number;
  alignedLatestBodyPressure: number;
  alignedMomentum3: number;
  latestAgeSeconds: number;
  latestLiveSpreadPrice?: number | null;
}

export interface PepperstoneDemoAdverseCutInput {
  enabled: boolean;
  brokerId: string;
  accountType: string;
  accountCurrency: string | null;
  ownerUserId: string;
  userId: string;
  isM1Strategy: boolean;
  strategyRoute: string | null;
  tradeInstrument: string;
  brokerInstrument: string;
  tradeDirection: 'BUY' | 'SELL';
  brokerDirection: 'BUY' | 'SELL';
  tradeLotSize: number | null;
  brokerLotSize: number | null;
  entryPrice: number | null;
  currentPrice: number | null;
  authoritativeStop: number | null;
  brokerStop: number | null;
  initialRiskPnl: number | null;
  currentBrokerNetPnl: number;
  maxFavorableBrokerNetPnl: number;
  elapsedMinutes: number;
  priorObservationCount: number;
  m1: PepperstoneDemoAdverseM1Evidence | null;
}

export type PepperstoneDemoAdverseCutDecision = {
  shouldClose: boolean;
  reason:
    | 'DISABLED_OR_OUT_OF_SCOPE'
    | 'UNVERIFIED_POSITION'
    | 'UNVERIFIED_RISK_OR_BARRIERS'
    | 'UNQUALIFIED_LOSS'
    | 'INSUFFICIENT_BROKER_M1_PROOF'
    | 'PERSISTENT_ADVERSE_M1_CUT';
  currentRiskMultiple: number | null;
};

export function evaluatePepperstoneDemoAdverseCut(
  input: PepperstoneDemoAdverseCutInput,
): PepperstoneDemoAdverseCutDecision {
  const hold = (
    reason: Exclude<PepperstoneDemoAdverseCutDecision['reason'], 'PERSISTENT_ADVERSE_M1_CUT'>,
    currentRiskMultiple: number | null = null,
  ): PepperstoneDemoAdverseCutDecision => ({ shouldClose: false, reason, currentRiskMultiple });
  if (
    !input.enabled ||
    input.brokerId !== 'pepperstone-ctrader' ||
    input.accountType !== 'DEMO' ||
    input.accountCurrency !== 'USD' ||
    !input.ownerUserId ||
    input.ownerUserId !== input.userId ||
    !input.isM1Strategy ||
    (input.strategyRoute !== 'EARLY_TRANSITION' && input.strategyRoute !== 'CONFIRMED_REVERSAL')
  )
    return hold('DISABLED_OR_OUT_OF_SCOPE');
  if (
    !input.tradeInstrument ||
    input.tradeInstrument.toUpperCase() !== input.brokerInstrument.toUpperCase() ||
    input.tradeDirection !== input.brokerDirection ||
    input.tradeLotSize === null ||
    !Number.isFinite(input.tradeLotSize) ||
    input.tradeLotSize <= 0 ||
    input.brokerLotSize === null ||
    !Number.isFinite(input.brokerLotSize) ||
    input.brokerLotSize <= 0 ||
    Math.abs(input.tradeLotSize - input.brokerLotSize) > 1e-4
  )
    return hold('UNVERIFIED_POSITION');
  const { entryPrice: entry, currentPrice: mark, authoritativeStop: stop, brokerStop } = input;
  const risk = input.initialRiskPnl;
  if (
    entry === null ||
    mark === null ||
    stop === null ||
    brokerStop === null ||
    risk === null ||
    ![
      entry,
      mark,
      stop,
      brokerStop,
      risk,
      input.currentBrokerNetPnl,
      input.maxFavorableBrokerNetPnl,
      input.elapsedMinutes,
    ].every(Number.isFinite) ||
    entry <= 0 ||
    mark <= 0 ||
    stop <= 0 ||
    brokerStop <= 0 ||
    risk <= 0 ||
    Math.abs(stop - brokerStop) > Math.max(0.00001, stop * 1e-7) ||
    (input.tradeDirection === 'BUY'
      ? !(stop < mark && mark < entry)
      : !(entry < mark && mark < stop))
  )
    return hold('UNVERIFIED_RISK_OR_BARRIERS');
  const currentR = input.currentBrokerNetPnl / risk;
  // Avoid premature cuts during the early noise/recovery window and never
  // reassign protection of a previously meaningful favorable excursion.
  if (
    input.currentBrokerNetPnl >= 0 ||
    currentR > -0.45 ||
    input.maxFavorableBrokerNetPnl >= risk * 0.15 ||
    input.elapsedMinutes < 2 ||
    !Number.isInteger(input.priorObservationCount) ||
    input.priorObservationCount < 12
  )
    return hold('UNQUALIFIED_LOSS', currentR);
  const m1 = input.m1;
  const maxSpread = Math.abs(entry - stop) * 0.25;
  if (
    !m1 ||
    !Number.isInteger(m1.completedBars) ||
    m1.completedBars < 2 ||
    !Number.isInteger(m1.consecutiveLiveQuoteBars) ||
    (m1.consecutiveLiveQuoteBars ?? 0) < 2 ||
    !Number.isInteger(m1.adverseBars) ||
    m1.adverseBars < 2 ||
    !Number.isFinite(m1.latestAgeSeconds) ||
    m1.latestAgeSeconds < 0 ||
    m1.latestAgeSeconds > 75 ||
    !Number.isFinite(m1.alignedLatestBodyPressure) ||
    m1.alignedLatestBodyPressure > -0.35 ||
    !Number.isFinite(m1.alignedMomentum3) ||
    m1.alignedMomentum3 > -0.15 ||
    m1.latestLiveSpreadPrice == null ||
    !Number.isFinite(m1.latestLiveSpreadPrice) ||
    m1.latestLiveSpreadPrice <= 0 ||
    m1.latestLiveSpreadPrice > maxSpread
  )
    return hold('INSUFFICIENT_BROKER_M1_PROOF', currentR);
  return { shouldClose: true, reason: 'PERSISTENT_ADVERSE_M1_CUT', currentRiskMultiple: currentR };
}
