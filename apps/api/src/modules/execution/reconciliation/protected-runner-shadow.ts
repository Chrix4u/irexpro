/**
 * Read-only prospective protected-runner assessment for cTrader DEMO exits.
 *
 * A candidate is NOT an executable stop modification. Conversion from an
 * account-currency gross P&L floor to a price is approximate (the initial
 * risk allocation's price/P&L slope can differ from the broker's actual fill
 * conversion). Spread, broker stop-distance, financing, gaps and slippage
 * must be checked at order-modification time in any separate future rollout.
 */
export interface ProtectedRunnerShadowInput {
  trendWouldHold: boolean;
  instrument: string;
  direction: 'BUY' | 'SELL';
  grossUnrealisedPnl: number;
  initialRiskPnl: number;
  estimatedBrokerCosts: number | null;
  feeSampleCount: number;
  entryPrice: number | null;
  currentPrice: number | null;
  originalStopPrice: number | null;
  takeProfitPrice: number | null;
  latestLiveSpreadPrice: number | null;
}

export type ProtectedRunnerShadowReason =
  | 'TREND_RECHECK_NOT_ALIGNED'
  | 'INSUFFICIENT_CAUSAL_FEE_SAMPLES'
  | 'INVALID_RISK_OR_PRICE_EVIDENCE'
  | 'NO_PROTECTED_NET_PROFIT'
  | 'NO_TP_UPSIDE_ROOM'
  | 'PROTECTION_STOP_TOO_CLOSE'
  | 'BROKER_VALIDATION_REQUIRED';

export interface ProtectedRunnerShadowAssessment {
  mode: 'SHADOW_ONLY';
  eligibleForFurtherResearch: boolean;
  reason: ProtectedRunnerShadowReason;
  estimatedBrokerCosts: number | null;
  feeSampleCount: number;
  /** Approximate account-currency floor; assumes recorded costs remain representative. */
  proposedNetFloorPnl: number | null;
  proposedGrossFloorPnl: number | null;
  /** Indicative only; NEVER pass directly to the broker as an executable stop. */
  indicativeProtectedStopPrice: number | null;
  stopHeadroomInSpreads: number | null;
  noTradeAuthority: true;
}

export function evaluateProtectedRunnerShadow(
  input: ProtectedRunnerShadowInput,
): ProtectedRunnerShadowAssessment {
  const reject = (
    reason: ProtectedRunnerShadowReason,
    extras: Partial<ProtectedRunnerShadowAssessment> = {},
  ): ProtectedRunnerShadowAssessment => ({
    mode: 'SHADOW_ONLY',
    eligibleForFurtherResearch: false,
    reason,
    estimatedBrokerCosts: input.estimatedBrokerCosts,
    feeSampleCount: input.feeSampleCount,
    proposedNetFloorPnl: null,
    proposedGrossFloorPnl: null,
    indicativeProtectedStopPrice: null,
    stopHeadroomInSpreads: null,
    noTradeAuthority: true,
    ...extras,
  });

  if (!input.trendWouldHold) return reject('TREND_RECHECK_NOT_ALIGNED');
  if (
    !Number.isFinite(input.estimatedBrokerCosts) ||
    input.estimatedBrokerCosts === null ||
    input.estimatedBrokerCosts < 0 ||
    input.feeSampleCount < 5
  ) {
    return reject('INSUFFICIENT_CAUSAL_FEE_SAMPLES');
  }

  const entry = input.entryPrice;
  const current = input.currentPrice;
  const originalStop = input.originalStopPrice;
  const tp = input.takeProfitPrice;
  const spread = input.latestLiveSpreadPrice;
  const symbol = input.instrument.trim().toUpperCase();
  const pip = symbol.endsWith('JPY') ? 0.01 : 0.0001;
  const directionSign = input.direction === 'BUY' ? 1 : -1;
  if (
    !/^[A-Z]{6}$/.test(symbol) ||
    !Number.isFinite(input.grossUnrealisedPnl) ||
    !Number.isFinite(input.initialRiskPnl) ||
    input.initialRiskPnl <= 0 ||
    entry === null ||
    current === null ||
    originalStop === null ||
    tp === null ||
    spread === null ||
    ![entry, current, originalStop, tp, spread].every(Number.isFinite) ||
    entry <= 0 ||
    current <= 0 ||
    originalStop <= 0 ||
    tp <= 0 ||
    spread <= 0 ||
    directionSign * (entry - originalStop) <= 0 ||
    directionSign * (current - entry) <= 0
  ) {
    return reject('INVALID_RISK_OR_PRICE_EVIDENCE');
  }
  const costs = input.estimatedBrokerCosts;
  const estimatedNetNow = input.grossUnrealisedPnl - costs;
  if (estimatedNetNow <= 0) return reject('NO_PROTECTED_NET_PROFIT');

  // Avoid the earlier naive runner that protected gross P&L while ignoring fees.
  // 0.10R is a research floor; 60% of the *estimated net* currently on offer
  // avoids completely relinquishing a substantial realized opportunity.
  const netFloor = Math.max(0.1 * input.initialRiskPnl, 0.6 * estimatedNetNow);
  const grossFloor = netFloor + costs;
  if (grossFloor >= input.grossUnrealisedPnl) {
    return reject('NO_PROTECTED_NET_PROFIT', {
      proposedNetFloorPnl: netFloor,
      proposedGrossFloorPnl: grossFloor,
    });
  }

  // Keep a meaningful TP upside, measured against the observed current mark.
  if (directionSign * (tp - current) <= Math.max(pip, 2 * spread)) {
    return reject('NO_TP_UPSIDE_ROOM', {
      proposedNetFloorPnl: netFloor,
      proposedGrossFloorPnl: grossFloor,
    });
  }

  const originalPriceRisk = Math.abs(entry - originalStop);
  const tentativeStop =
    entry + directionSign * originalPriceRisk * (grossFloor / input.initialRiskPnl);
  const headroom = directionSign * (current - tentativeStop);
  if (
    !Number.isFinite(tentativeStop) ||
    directionSign * (tentativeStop - entry) <= 0 ||
    headroom <= Math.max(2 * spread, 0.5 * pip)
  ) {
    return reject('PROTECTION_STOP_TOO_CLOSE', {
      proposedNetFloorPnl: netFloor,
      proposedGrossFloorPnl: grossFloor,
      stopHeadroomInSpreads: Number.isFinite(headroom) ? headroom / spread : null,
    });
  }

  return {
    mode: 'SHADOW_ONLY',
    eligibleForFurtherResearch: true,
    reason: 'BROKER_VALIDATION_REQUIRED',
    estimatedBrokerCosts: costs,
    feeSampleCount: input.feeSampleCount,
    proposedNetFloorPnl: netFloor,
    proposedGrossFloorPnl: grossFloor,
    indicativeProtectedStopPrice: Number(tentativeStop.toFixed(8)),
    stopHeadroomInSpreads: headroom / spread,
    noTradeAuthority: true,
  };
}
