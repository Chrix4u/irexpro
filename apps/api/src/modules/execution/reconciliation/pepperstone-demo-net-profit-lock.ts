/**
 * Narrow, cost-aware, EXPLICITLY FLAGGED Pepperstone cTrader DEMO closing rule.
 *
 * Designed for a small but meaningful broker-observed profitable excursion
 * that is being given back BEFORE a conservative extra close-cost reserve
 * is exhausted. CTraderAdapter.BrokerPosition.unrealisedPnl is derived from
 * ProtoOA netUnrealizedPnL (ALREADY net as reported by cTrader). We purposely
 * reserve an ADDITIONAL full historical round-trip fee as a worst-case buffer
 * for unbooked closing charges/slippage, NOT because the broker mark is gross.
 * This does NOT guarantee a fill or an amount of realized P&L.
 *
 * Applies only to previously authorized, verified, existing M1 positions on
 * Pepperstone DEMO, NEVER new orders, paper simulation or LIVE accounts.
 * The two alternate routes have an explicit positive-after-fee giveback band
 * at 0.50R+, separate from the legacy continuation-only early-peak policy.
 */
export const PEPPERSTONE_DEMO_NET_LOCK_ARTIFACT =
  'pepperstone-demo-positive-after-fee-giveback-lock-v3-tiered-owner-demo' as const;

/**
 * Causal, broker-net PEAK retention for independently admitted Pepperstone
 * USD DEMO reversal/transition entries. This is not a model forecast; the
 * higher peak-R bands reserve more of an already observed excursion.
 * Below 0.50R this helper is not an entry/exit authorization.
 *
 * Retain 65% between 0.50R–0.75R; 75% from 0.75R–1.00R; 80% at
 * >=1.00R. The 85% volatility-adjusted extension stays UNIMPLEMENTED
 * until fresh, broker-native volatility evidence is proven and tested.
 */
export function pepperstoneDemoTieredPeakRetention(peakR: number): number {
  if (!Number.isFinite(peakR) || peakR < 0.5) return 0.55;
  if (peakR < 0.75) return 0.65;
  if (peakR < 1) return 0.75;
  return 0.80;
}


export type PepperstoneDemoNetLockReason =
  | 'OUT_OF_SCOPE'
  | 'UNVERIFIED_POSITION'
  | 'UNVERIFIED_BROKER_BARRIERS'
  | 'INSUFFICIENT_OBSERVATIONS'
  | 'INVALID_RISK_OR_FEE'
  | 'INSUFFICIENT_PRIOR_FEE_SAMPLES'
  | 'NO_MEANINGFUL_NET_PEAK'
  | 'ESTABLISHED_HIGH_PEAK_RUNNER_UNCHANGED'
  | 'NO_PROTECTED_GIVEBACK'
  | 'GROSS_PNL_NOT_DECLINING'
  | 'NO_REMAINING_POSITIVE_NET'
  | 'PROTECTED_POSITIVE_NET_PROFIT';

export function evaluatePepperstoneDemoNetProfitLock(input: {
  brokerId: string;
  accountType: string;
  tradeInstrument: string;
  brokerInstrument: string;
  tradeDirection: 'BUY' | 'SELL';
  brokerDirection: 'BUY' | 'SELL';
  tradeLotSize: number;
  brokerLotSize: number;
  isM1Strategy: boolean;
  strategyRoute: string | null;
  /** Immutable owner-scoped entry lineage, not an unverified runtime claim. */
  guardedPullbackContinuation?: boolean;
  /** Separate opt-in and service-verified Pepperstone USD DEMO-only rollout. */
  tieredRetentionEnabled?: boolean;
  initialRiskPnl: number | null;
  brokerEntryPrice: number | null;
  currentPrice: number | null;
  authoritativeStop: number | null;
  brokerStop: number | null;
  authoritativeTakeProfit: number | null;
  brokerTakeProfit: number | null;
  openedAt: Date | null;
  previousObservationAt: Date | null;
  observedAt: Date;
  previousObservationCount: number;
  previousObservedBrokerNetPnl: number;
  maxFavorableBrokerNetPnl: number;
  currentBrokerNetPnl: number;
  conservativeExitReserve: number | null;
  feeSampleCount: number;
  feeEvidenceSource: 'SAME_SYMBOL' | 'SAME_ACCOUNT_FX_MAJORS' | null;
}): {
  artifact: typeof PEPPERSTONE_DEMO_NET_LOCK_ARTIFACT;
  shouldClose: boolean;
  reason: PepperstoneDemoNetLockReason;
  protectedBrokerNetFloor: number | null;
  estimatedProtectedAfterReserveFloor: number | null;
  estimatedNetAfterReserve: number | null;
  observedPeakR: number | null;
  retentionFraction: number | null;
  tieredRetentionActive: boolean;
} {
  // An opt-in alone must not grant authority: these exact two routes are
  // the only ones with the new tiers. Untagged trend continuation keeps its
  // established behavior, including the >0.50R runner exemption.
  const tieredRetentionActive =
    input.tieredRetentionEnabled === true &&
    input.brokerId === 'pepperstone-ctrader' &&
    input.accountType === 'DEMO' &&
    input.isM1Strategy &&
    (input.strategyRoute === 'EARLY_TRANSITION' ||
      input.strategyRoute === 'CONFIRMED_REVERSAL');
  const reply = (
    reason: PepperstoneDemoNetLockReason,
    grossFloor: number | null = null,
    netFloor: number | null = null,
    net: number | null = null,
    peakR: number | null = null,
    retentionFraction: number | null = null,
  ) => ({
    artifact: PEPPERSTONE_DEMO_NET_LOCK_ARTIFACT,
    shouldClose: reason === 'PROTECTED_POSITIVE_NET_PROFIT',
    reason,
    protectedBrokerNetFloor: grossFloor,
    estimatedProtectedAfterReserveFloor: netFloor,
    estimatedNetAfterReserve: net,
    observedPeakR: peakR,
    retentionFraction,
    tieredRetentionActive,
  });
  if (
    input.brokerId !== 'pepperstone-ctrader' ||
    input.accountType !== 'DEMO' ||
    !input.isM1Strategy ||
    !['TREND_CONTINUATION', 'EARLY_TRANSITION', 'CONFIRMED_REVERSAL'].includes(
      input.strategyRoute ?? '',
    )
  )
    return reply('OUT_OF_SCOPE');
  if (
    input.tradeInstrument.toUpperCase() !== input.brokerInstrument.toUpperCase() ||
    input.tradeDirection !== input.brokerDirection ||
    !Number.isFinite(input.tradeLotSize) ||
    input.tradeLotSize <= 0 ||
    !Number.isFinite(input.brokerLotSize) ||
    Math.abs(input.tradeLotSize - input.brokerLotSize) > 1e-4
  )
    return reply('UNVERIFIED_POSITION');
  const stop = input.authoritativeStop;
  const brokerStop = input.brokerStop;
  const tp = input.authoritativeTakeProfit;
  const brokerTp = input.brokerTakeProfit;
  const mark = input.currentPrice;
  const open = input.brokerEntryPrice;
  if (
    stop === null ||
    brokerStop === null ||
    tp === null ||
    brokerTp === null ||
    mark === null ||
    open === null ||
    ![stop, brokerStop, tp, brokerTp, mark, open].every((x) => Number.isFinite(x) && x > 0) ||
    Math.abs(stop - brokerStop) > Math.max(0.00001, stop * 1e-7) ||
    Math.abs(tp - brokerTp) > Math.max(0.00001, tp * 1e-7) ||
    (input.tradeDirection === 'BUY'
      ? !(stop < open && open < tp && open < mark && mark < tp)
      : !(tp < open && open < stop && tp < mark && mark < open))
  )
    return reply('UNVERIFIED_BROKER_BARRIERS');
  const ageSeconds = input.openedAt
    ? (input.observedAt.getTime() - input.openedAt.getTime()) / 1000
    : NaN;
  const lastAgeSeconds = input.previousObservationAt
    ? (input.observedAt.getTime() - input.previousObservationAt.getTime()) / 1000
    : NaN;
  if (
    !Number.isFinite(ageSeconds) ||
    ageSeconds < 15 ||
    !Number.isFinite(lastAgeSeconds) ||
    lastAgeSeconds < 0 ||
    lastAgeSeconds > 60 ||
    !Number.isInteger(input.previousObservationCount) ||
    input.previousObservationCount < 3
  )
    return reply('INSUFFICIENT_OBSERVATIONS');
  const risk = input.initialRiskPnl;
  const fee = input.conservativeExitReserve;
  if (
    risk === null ||
    !Number.isFinite(risk) ||
    risk <= 0 ||
    fee === null ||
    !Number.isFinite(fee) ||
    fee <= 0 ||
    ![
      input.previousObservedBrokerNetPnl,
      input.maxFavorableBrokerNetPnl,
      input.currentBrokerNetPnl,
    ].every(Number.isFinite)
  )
    return reply('INVALID_RISK_OR_FEE');
  const required =
    input.feeEvidenceSource === 'SAME_SYMBOL'
      ? 5
      : input.feeEvidenceSource === 'SAME_ACCOUNT_FX_MAJORS'
        ? 8
        : Infinity;
  if (!Number.isInteger(input.feeSampleCount) || input.feeSampleCount < required) {
    return reply('INSUFFICIENT_PRIOR_FEE_SAMPLES');
  }
  const peak = Math.max(0, input.maxFavorableBrokerNetPnl);
  const peakR = peak / risk;
  // At a verified >=0.50R peak the existing broker-net AFTER-FEE safeguards
  // remain mandatory. When separately enabled for the two owner-DEMO
  // alternate routes, retention grows 65% -> 75% -> 80% as PEAK/R increases.
  // Untagged continuation and guarded-pullback retain their previous policy.
  // The independent expert and live trend recheck remain audit-only: without
  // a broker-confirmed positive stop, forecast confidence cannot veto a due
  // protective close or guarantee a specific fill.
  const alternateRoute =
    input.strategyRoute === 'EARLY_TRANSITION' ||
    input.strategyRoute === 'CONFIRMED_REVERSAL' ||
    (input.strategyRoute === 'TREND_CONTINUATION' &&
      input.guardedPullbackContinuation === true);
  const minimumPeak = alternateRoute
    ? Math.max(risk * 0.5, fee * 1.8, fee + risk * 0.15)
    : Math.max(risk * 0.2, fee * 1.65, fee + risk * 0.1);
  if (peak < minimumPeak) return reply('NO_MEANINGFUL_NET_PEAK', null, null, null, peakR);
  // Legacy continuation positions retain the pre-existing <0.50R pilot cap;
  // only immutable guarded-pullback DEMO fills receive the 0.50R+ rule.
  if (!alternateRoute && peakR >= 0.5)
    return reply('ESTABLISHED_HIGH_PEAK_RUNNER_UNCHANGED', null, null, null, peakR);
  const retentionFraction = tieredRetentionActive
    ? pepperstoneDemoTieredPeakRetention(peakR)
    : 0.55;
  const minNetBuffer = Math.max(0.5, risk * 0.035, fee * 0.2);
  const executionAllowance = Math.max(risk * 0.02, fee * 0.25);
  const grossFloor = Math.max(
    fee + minNetBuffer + executionAllowance,
    peak * retentionFraction,
  );
  const netFloor = grossFloor - fee;
  const net = input.currentBrokerNetPnl - fee;
  if (peak - grossFloor < Math.max(risk * 0.03, fee * 0.25)) {
    return reply('NO_MEANINGFUL_NET_PEAK', grossFloor, netFloor, net, peakR, retentionFraction);
  }
  if (input.currentBrokerNetPnl > grossFloor) {
    return reply('NO_PROTECTED_GIVEBACK', grossFloor, netFloor, net, peakR, retentionFraction);
  }
  if (
    input.previousObservedBrokerNetPnl - input.currentBrokerNetPnl <
    Math.max(0.5, risk * 0.005)
  ) {
    return reply('GROSS_PNL_NOT_DECLINING', grossFloor, netFloor, net, peakR, retentionFraction);
  }
  // No broker close is advertised as protected-positive after the broker
  // net mark loses the ADDITIONAL historical fee reserve and slippage buffer.
  if (net < Math.max(0.5, fee * 0.2, risk * 0.02)) {
    return reply('NO_REMAINING_POSITIVE_NET', grossFloor, netFloor, net, peakR, retentionFraction);
  }
  return reply('PROTECTED_POSITIVE_NET_PROFIT', grossFloor, netFloor, net, peakR, retentionFraction);
}
