import type { ProtectedRunnerShadowAssessment } from './protected-runner-shadow';

/**
 * Prospective cTrader owner-DEMO stop validation, not an order amendment.
 * Live bid/ask and broker barriers must be proven independently of the
 * approximate P&L/price conversion. A cTrader provider recheck, instrument
 * tick/minimum stop distance and a broker-acknowledged persisted amendment
 * would STILL be required before any future executable implementation.
 */
export const VERIFIED_PROTECTED_RUNNER_ARTIFACT =
  'irexpro-owner-demo-broker-verified-protected-runner-shadow-v1';

export interface VerifiedProtectedRunnerStopInput {
  brokerId: string;
  accountType: string;
  currency: string | null;
  ownerUserId: string | null;
  userId: string;
  isM1Strategy: boolean;
  route: string | null;
  instrument: string;
  brokerInstrument: string;
  direction: 'BUY' | 'SELL';
  brokerDirection: 'BUY' | 'SELL';
  tradeLots: number | null;
  brokerLots: number | null;
  entry: number | null;
  mark: number | null;
  originalStop: number | null;
  brokerStop: number | null;
  takeProfit: number | null;
  brokerTakeProfit: number | null;
  brokerNetPnl: number;
  initialRiskPnl: number;
  estimatedExtraExitReserve: number | null;
  historicalFeeSamples: number;
  observedAt: Date;
  lastBid: number | null;
  lastAsk: number | null;
  quoteObservedAt: Date | null;
  runner: ProtectedRunnerShadowAssessment;
}

export type VerifiedProtectedRunnerStopAssessment = {
  artifact: typeof VERIFIED_PROTECTED_RUNNER_ARTIFACT;
  mode: 'SHADOW_ONLY';
  eligibleForIndependentProviderValidation: boolean;
  reason:
    | 'OWNER_SCOPE_OR_MODEL_NOT_VERIFIED'
    | 'POSITION_OR_BROKER_BARRIERS_UNVERIFIED'
    | 'STALE_OR_UNVERIFIED_NATIVE_BID_ASK'
    | 'UNQUALIFIED_PREVIOUS_RUNNER_SHADOW'
    | 'INVALID_STOP_PRICE_OR_SPREAD_HEADROOM'
    | 'INSUFFICIENT_PROTECTED_AFTER_RESERVE_PROFIT'
    | 'REQUIRES_BROKER_TICK_MIN_STOP_AND_AMENDMENT_VERIFICATION';
  proposedStopForResearchOnly: number | null;
  estimatedNetAtStopAfterReserve: number | null;
  quoteAgeSeconds: number | null;
  brokerStopUnchanged: true;
  noTradeAuthority: true;
  modifiesExecution: false;
};

export function evaluateVerifiedProtectedRunnerStopShadow(
  i: VerifiedProtectedRunnerStopInput,
): VerifiedProtectedRunnerStopAssessment {
  const result = (
    reason: VerifiedProtectedRunnerStopAssessment['reason'],
    stop: number | null = null,
    net: number | null = null,
    age: number | null = null,
  ): VerifiedProtectedRunnerStopAssessment => ({
    artifact: VERIFIED_PROTECTED_RUNNER_ARTIFACT,
    mode: 'SHADOW_ONLY',
    eligibleForIndependentProviderValidation:
      reason === 'REQUIRES_BROKER_TICK_MIN_STOP_AND_AMENDMENT_VERIFICATION',
    reason,
    proposedStopForResearchOnly: stop,
    estimatedNetAtStopAfterReserve: net,
    quoteAgeSeconds: age,
    brokerStopUnchanged: true,
    noTradeAuthority: true,
    modifiesExecution: false,
  });
  if (
    i.brokerId !== 'pepperstone-ctrader' ||
    i.accountType !== 'DEMO' ||
    i.currency !== 'USD' ||
    !i.ownerUserId ||
    i.ownerUserId !== i.userId ||
    !i.isM1Strategy ||
    (i.route !== 'EARLY_TRANSITION' && i.route !== 'CONFIRMED_REVERSAL')
  )
    return result('OWNER_SCOPE_OR_MODEL_NOT_VERIFIED');

  const values = [
    i.tradeLots,
    i.brokerLots,
    i.entry,
    i.mark,
    i.originalStop,
    i.brokerStop,
    i.takeProfit,
    i.brokerTakeProfit,
    i.initialRiskPnl,
    i.brokerNetPnl,
  ];
  if (
    !i.instrument ||
    i.instrument !== i.brokerInstrument ||
    i.direction !== i.brokerDirection ||
    values.some((v) => v === null || !Number.isFinite(v)) ||
    (i.tradeLots ?? 0) <= 0 ||
    (i.brokerLots ?? 0) <= 0 ||
    Math.abs(i.tradeLots! - i.brokerLots!) > 0.00001 ||
    i.entry! <= 0 ||
    i.mark! <= 0 ||
    i.originalStop! <= 0 ||
    i.brokerStop! <= 0 ||
    i.takeProfit! <= 0 ||
    i.brokerTakeProfit! <= 0 ||
    i.initialRiskPnl <= 0 ||
    Math.abs(i.originalStop! - i.brokerStop!) > Math.max(0.00000001, i.originalStop! * 1e-8) ||
    Math.abs(i.takeProfit! - i.brokerTakeProfit!) > Math.max(0.00000001, i.takeProfit! * 1e-8)
  )
    return result('POSITION_OR_BROKER_BARRIERS_UNVERIFIED');

  const side = i.direction === 'BUY' ? 1 : -1;
  const riskDistance = side * (i.entry! - i.originalStop!);
  const upsideDistance = side * (i.takeProfit! - i.entry!);
  if (riskDistance <= 0 || upsideDistance <= 0 || side * (i.mark! - i.entry!) <= 0) {
    return result('POSITION_OR_BROKER_BARRIERS_UNVERIFIED');
  }

  const at = i.observedAt.getTime();
  const qt = i.quoteObservedAt?.getTime() ?? NaN;
  const ageSeconds = (at - qt) / 1000;
  const spread = i.lastAsk !== null && i.lastBid !== null ? i.lastAsk - i.lastBid : NaN;
  if (
    !Number.isFinite(ageSeconds) ||
    ageSeconds < 0 ||
    ageSeconds > 15 ||
    !Number.isFinite(spread) ||
    spread <= 0 ||
    i.lastBid! <= 0 ||
    i.lastAsk! <= 0 ||
    spread >= 0.2 * riskDistance ||
    Math.abs(i.mark! - (i.direction === 'BUY' ? i.lastBid! : i.lastAsk!)) >
      Math.max(spread * 3, riskDistance * 0.15)
  )
    return result(
      'STALE_OR_UNVERIFIED_NATIVE_BID_ASK',
      null,
      null,
      Number.isFinite(ageSeconds) ? ageSeconds : null,
    );

  const r = i.runner;
  if (
    !r ||
    r.mode !== 'SHADOW_ONLY' ||
    !r.noTradeAuthority ||
    !r.eligibleForFurtherResearch ||
    r.indicativeProtectedStopPrice === null ||
    r.proposedNetFloorPnl === null ||
    r.proposedGrossFloorPnl === null ||
    !Number.isFinite(r.indicativeProtectedStopPrice) ||
    !Number.isFinite(r.proposedNetFloorPnl) ||
    !Number.isFinite(r.proposedGrossFloorPnl) ||
    !Number.isFinite(i.estimatedExtraExitReserve) ||
    (i.estimatedExtraExitReserve ?? -1) <= 0 ||
    !Number.isInteger(i.historicalFeeSamples) ||
    i.historicalFeeSamples < 5
  )
    return result('UNQUALIFIED_PREVIOUS_RUNNER_SHADOW', null, null, ageSeconds);

  const stop = r.indicativeProtectedStopPrice;
  const tickProvisional = i.instrument.endsWith('JPY') ? 0.001 : 0.00001;
  const requiredHeadroom = Math.max(spread * 3, tickProvisional * 3);
  if (
    side * (stop - i.brokerStop!) <= 0 ||
    side * (stop - i.entry!) <= 0 ||
    side * (i.mark! - stop) <= requiredHeadroom ||
    side * (i.takeProfit! - i.mark!) <= requiredHeadroom
  )
    return result('INVALID_STOP_PRICE_OR_SPREAD_HEADROOM', stop, null, ageSeconds);

  // Not a guaranteed fill: conservative price-to-P&L slope is derived from
  // original risk distance and checked against the real current broker mark.
  const slope = i.initialRiskPnl / riskDistance;
  const priceGiveback = side * (i.mark! - stop) * slope;
  const extraSpreadAndSlip = Math.max(i.initialRiskPnl * 0.02, spread * slope);
  const estimatedNet =
    i.brokerNetPnl - priceGiveback - i.estimatedExtraExitReserve! - extraSpreadAndSlip;
  if (
    !Number.isFinite(estimatedNet) ||
    estimatedNet < Math.max(0.1 * i.initialRiskPnl, 0.2 * i.estimatedExtraExitReserve!)
  ) {
    return result(
      'INSUFFICIENT_PROTECTED_AFTER_RESERVE_PROFIT',
      stop,
      Number.isFinite(estimatedNet) ? estimatedNet : null,
      ageSeconds,
    );
  }
  return result(
    'REQUIRES_BROKER_TICK_MIN_STOP_AND_AMENDMENT_VERIFICATION',
    stop,
    estimatedNet,
    ageSeconds,
  );
}
