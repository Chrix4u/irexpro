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
 * Applies only to previously authorized, verified, existing M1 continuation
 * positions, NEVER new orders, paper simulation or LIVE accounts.
 */
export const PEPPERSTONE_DEMO_NET_LOCK_ARTIFACT =
  'pepperstone-demo-positive-after-fee-giveback-lock-v1' as const;

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
} {
  const reply = (
    reason: PepperstoneDemoNetLockReason,
    grossFloor: number | null = null,
    netFloor: number | null = null,
    net: number | null = null,
    peakR: number | null = null,
  ) => ({
    artifact: PEPPERSTONE_DEMO_NET_LOCK_ARTIFACT,
    shouldClose: reason === 'PROTECTED_POSITIVE_NET_PROFIT',
    reason,
    protectedBrokerNetFloor: grossFloor,
    estimatedProtectedAfterReserveFloor: netFloor,
    estimatedNetAfterReserve: net,
    observedPeakR: peakR,
  });
  if (
    input.brokerId !== 'pepperstone-ctrader' ||
    input.accountType !== 'DEMO' ||
    !input.isM1Strategy ||
    input.strategyRoute !== 'TREND_CONTINUATION'
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
  // Require a nontrivial, fee-covered peak. Not armed on tiny green ticks.
  const minimumPeak = Math.max(risk * 0.2, fee * 1.65, fee + risk * 0.1);
  if (peak < minimumPeak) return reply('NO_MEANINGFUL_NET_PEAK', null, null, null, peakR);
  // Limit this first DEMO pilot to the two observed stopout geometries: both
  // peaked below 0.50R. A genuine AUDUSD TP winner went far past 1R then
  // recovered from a deep drawdown. Never truncate an established >=0.50R
  // runner through this *early-peak* experiment.
  if (peakR >= 0.5) return reply('ESTABLISHED_HIGH_PEAK_RUNNER_UNCHANGED', null, null, null, peakR);
  // The early-peak giveback floor is intentionally wider than a standard
  // 70–90% trailing lock; high-TP runners may need room to retrace.
  const minNetBuffer = Math.max(3, risk * 0.035, fee * 0.2);
  // A 5-second polling gap can cross the floor. Leave an actionable price
  // window above the minimum net-positive exit margin.
  const executionAllowance = Math.max(risk * 0.02, fee * 0.25);
  const grossFloor = Math.max(fee + minNetBuffer + executionAllowance, peak * 0.55);
  const netFloor = grossFloor - fee;
  const net = input.currentBrokerNetPnl - fee;
  if (peak - grossFloor < Math.max(risk * 0.03, fee * 0.25)) {
    return reply('NO_MEANINGFUL_NET_PEAK', grossFloor, netFloor, net, peakR);
  }
  if (input.currentBrokerNetPnl > grossFloor) {
    return reply('NO_PROTECTED_GIVEBACK', grossFloor, netFloor, net, peakR);
  }
  if (
    input.previousObservedBrokerNetPnl - input.currentBrokerNetPnl <
    Math.max(0.5, risk * 0.005)
  ) {
    return reply('GROSS_PNL_NOT_DECLINING', grossFloor, netFloor, net, peakR);
  }
  // No broker close is advertised as protected-positive after the broker
  // net mark loses the ADDITIONAL historical fee reserve and slippage buffer.
  if (net < Math.max(3, fee * 0.2, risk * 0.02)) {
    return reply('NO_REMAINING_POSITIVE_NET', grossFloor, netFloor, net, peakR);
  }
  return reply('PROTECTED_POSITIVE_NET_PROFIT', grossFloor, netFloor, net, peakR);
}
