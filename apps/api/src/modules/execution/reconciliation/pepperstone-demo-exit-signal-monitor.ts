/**
 * Prospective, broker-verified existing-position exit intelligence.
 * This is a DEMO-only diagnostic. An M1 direction vote need not pass NEW-ORDER
 * admission to inform a position that is already open, but it cannot override
 * the live profit lock, broker SL/TP, or issue a new order.
 */
export const PEPPERSTONE_DEMO_EXIT_INTELLIGENCE_ARTIFACT =
  'pepperstone-owner-demo-exit-intelligence-monitor-v1' as const;

export interface PepperstoneDemoExitMonitorInput {
  enabled: boolean;
  ownerPepperstoneUsdDemoVerified: boolean;
  route: string | null;
  direction: 'BUY' | 'SELL';
  brokerDirection: string;
  instrument: string;
  brokerInstrument: string;
  tradeLots: number | null;
  brokerLots: number | null;
  initialRiskPnl: number | null;
  peakBrokerNetPnl: number;
  currentBrokerNetPnl: number;
  entryPrice: number | null;
  brokerStop: number | null;
  authoritativeStop: number | null;
  brokerTakeProfit: number | null;
  authoritativeTakeProfit: number | null;
  currentPrice: number | null;
  observedAt: Date;
  sameSideContinuationAt: Date | null;
  oppositeExecutableReversal: boolean;
  m1: {
    completedBars: number;
    liveQuoteBars: number;
    /** Verified consecutive independently-quoted completed M1 bars. */
    consecutiveLiveQuoteBars?: number;
    latestAgeSeconds: number;
    adverseBars: number;
    alignedLatestBodyPressure: number;
    alignedMomentum3: number;
  } | null;
}

export type PepperstoneDemoExitMonitorDecision = {
  artifact: typeof PEPPERSTONE_DEMO_EXIT_INTELLIGENCE_ARTIFACT;
  mode: 'SHADOW_ONLY';
  recommendation:
    | 'UNVERIFIED_NO_INFERENCE'
    | 'NOT_MEANINGFUL_PROFIT'
    | 'STALE_OR_INCOMPLETE_CANDLE_EVIDENCE'
    | 'DETERIORATION_REVIEW_NOW'
    | 'HEALTHY_CONTINUATION_RESEARCH'
    | 'INDETERMINATE_KEEP_PROTECTION';
  reason: string;
  /** Standalone candlestick evidence is research only, never order authority. */
  continuationEvidence: 'TACTICAL_SAME_SIDE_VOTE' | 'INDEPENDENT_BROKER_M1' | null;
  currentR: number | null;
  peakR: number | null;
  givebackFraction: number | null;
  existingBrokerProfitStopVerified: boolean;
  hypotheticalGraceEligibleOnlyIfProtected: boolean;
  closeOrders: 0;
  stopAmendments: 0;
  newOrders: 0;
  changesLive: false;
  changesExecution: false;
};

export function evaluatePepperstoneDemoExitMonitor(
  i: PepperstoneDemoExitMonitorInput,
): PepperstoneDemoExitMonitorDecision {
  const finite = (v: number | null): v is number => v !== null && Number.isFinite(v);
  const risk = i.initialRiskPnl ?? Number.NaN;
  const validRisk = Number.isFinite(risk) && risk > 0;
  const currentR = validRisk ? i.currentBrokerNetPnl / risk : null;
  const peakR = validRisk ? i.peakBrokerNetPnl / risk : null;
  const givebackFraction =
    i.peakBrokerNetPnl > 0
      ? Math.max(0, i.peakBrokerNetPnl - i.currentBrokerNetPnl) / i.peakBrokerNetPnl
      : null;
  const stopVerified =
    finite(i.entryPrice) &&
    finite(i.brokerStop) &&
    finite(i.authoritativeStop) &&
    finite(i.currentPrice) &&
    Math.abs(i.authoritativeStop - i.brokerStop) <=
      Math.max(0.0000001, Math.abs(i.brokerStop) * 1e-8) &&
    (i.direction === 'BUY'
      ? i.entryPrice < i.brokerStop && i.brokerStop < i.currentPrice
      : i.currentPrice < i.brokerStop && i.brokerStop < i.entryPrice);
  const reply = (
    recommendation: PepperstoneDemoExitMonitorDecision['recommendation'],
    reason: string,
    grace = false,
    continuationEvidence: PepperstoneDemoExitMonitorDecision['continuationEvidence'] = null,
  ): PepperstoneDemoExitMonitorDecision => ({
    artifact: PEPPERSTONE_DEMO_EXIT_INTELLIGENCE_ARTIFACT,
    mode: 'SHADOW_ONLY',
    recommendation,
    reason,
    continuationEvidence,
    currentR,
    peakR,
    givebackFraction,
    existingBrokerProfitStopVerified: !!stopVerified,
    hypotheticalGraceEligibleOnlyIfProtected: grace && !!stopVerified,
    closeOrders: 0,
    stopAmendments: 0,
    newOrders: 0,
    changesLive: false,
    changesExecution: false,
  });
  const routes = ['TREND_CONTINUATION', 'EARLY_TRANSITION', 'CONFIRMED_REVERSAL'];
  const values = [
    i.tradeLots,
    i.brokerLots,
    i.entryPrice,
    i.brokerStop,
    i.authoritativeStop,
    i.brokerTakeProfit,
    i.authoritativeTakeProfit,
    i.currentPrice,
  ];
  if (
    !i.enabled ||
    !i.ownerPepperstoneUsdDemoVerified ||
    !routes.includes(i.route ?? '') ||
    !validRisk ||
    !Number.isFinite(i.observedAt.getTime()) ||
    !Number.isFinite(i.peakBrokerNetPnl) ||
    !Number.isFinite(i.currentBrokerNetPnl) ||
    values.some((v) => !finite(v) || v <= 0) ||
    i.tradeLots! <= 0 ||
    Math.abs(i.tradeLots! - i.brokerLots!) > 0.0001 ||
    i.instrument !== i.brokerInstrument ||
    i.direction !== i.brokerDirection ||
    Math.abs(i.authoritativeTakeProfit! - i.brokerTakeProfit!) >
      Math.max(0.0000001, Math.abs(i.brokerTakeProfit!) * 1e-8)
  )
    return reply('UNVERIFIED_NO_INFERENCE', 'BROKER_OWNER_POSITION_OR_RISK_UNVERIFIED');
  // Even before the first meaningful profitable excursion, observe M1
  // deterioration: new-entry qualification is NOT required to warn that an
  // existing position's thesis is weakening. A warning has no close authority.
  const m = i.m1;
  if (
    !m ||
    m.completedBars < 2 ||
    m.liveQuoteBars < 2 ||
    !Number.isFinite(m.latestAgeSeconds) ||
    m.latestAgeSeconds < 0 ||
    m.latestAgeSeconds > 90 ||
    !Number.isFinite(m.alignedMomentum3) ||
    !Number.isFinite(m.alignedLatestBodyPressure) ||
    !Number.isInteger(m.adverseBars) ||
    m.adverseBars < 0
  )
    return reply('STALE_OR_INCOMPLETE_CANDLE_EVIDENCE', 'NO_FRESH_INDEPENDENT_M1');
  // Consider real adverse confirmation, not a single red candle.
  if (
    i.oppositeExecutableReversal ||
    (m.adverseBars >= 2 && m.alignedMomentum3 <= -0.15 && m.alignedLatestBodyPressure <= -0.35) ||
    (givebackFraction !== null &&
      givebackFraction >= 0.45 &&
      m.alignedMomentum3 <= -0.1 &&
      m.alignedLatestBodyPressure < 0)
  )
    return reply(
      'DETERIORATION_REVIEW_NOW',
      i.oppositeExecutableReversal
        ? 'EXECUTABLE_OPPOSITE_REVERSAL'
        : 'REPEATED_ADVERSE_BROKER_M1_AND_GIVEBACK',
    );
  if (i.peakBrokerNetPnl < risk * 0.25) return reply('NOT_MEANINGFUL_PROFIT', 'PEAK_BELOW_0_25R');
  const age = i.sameSideContinuationAt
    ? (i.observedAt.getTime() - i.sameSideContinuationAt.getTime()) / 1000
    : null;
  const tacticalContinuation =
    age !== null &&
    Number.isFinite(age) &&
    age >= 0 &&
    age <= 180 &&
    m.adverseBars <= 1 &&
    m.alignedMomentum3 >= 0.1 &&
    m.alignedLatestBodyPressure >= 0.15 &&
    i.currentBrokerNetPnl >= risk * 0.4 &&
    (givebackFraction === null || givebackFraction <= 0.4);
  // The M1 candle expert can independently support an ALREADY OPEN trade
  // even if a NEW ENTRY has no executable tactical continuation vote.
  // Stronger thresholds + consecutive quote confirmation prevent turning
  // mere noisy momentum into presumed profitability. SHADOW_ONLY always.
  const independentNativeCandles =
    m.completedBars >= 3 &&
    m.liveQuoteBars >= 3 &&
    (m.consecutiveLiveQuoteBars ?? 0) >= 2 &&
    m.adverseBars === 0 &&
    m.alignedMomentum3 >= 0.2 &&
    m.alignedLatestBodyPressure >= 0.3 &&
    i.currentBrokerNetPnl >= risk * 0.4 &&
    (givebackFraction === null || givebackFraction <= 0.35);
  if (tacticalContinuation || independentNativeCandles)
    return reply(
      'HEALTHY_CONTINUATION_RESEARCH',
      stopVerified
        ? 'SUPPORTIVE_NATIVE_M1_WITH_VERIFIED_POSITIVE_BROKER_STOP'
        : 'SUPPORTIVE_NATIVE_M1_BUT_NO_VERIFIED_POSITIVE_BROKER_STOP',
      true,
      tacticalContinuation ? 'TACTICAL_SAME_SIDE_VOTE' : 'INDEPENDENT_BROKER_M1',
    );
  return reply('INDETERMINATE_KEEP_PROTECTION', 'NO_CONFIRMED_CONTINUATION_OR_REVERSAL');
}
