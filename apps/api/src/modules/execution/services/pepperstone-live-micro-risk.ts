import { ExactDecimal } from '../../../common/utils/exact-decimal';

/**
 * Account-scoped Pepperstone LIVE lot-range policy. A user can prefer
 * 0.10–1.00 lots, but the broker's real symbol minimum/step is the ONLY
 * executable floor. Smaller sizes are valid when proven affordable.
 * Never round UP beyond an equity, leverage, stop or margin limit.
 * This policy NEVER authorizes production-LIVE order execution.
 */
export const PEPPERSTONE_LIVE_PILOT_LOT_CEILING = '1';
export const PEPPERSTONE_LIVE_PILOT_EQUITY_RISK_PERCENT = '2';
/** Conservative screening estimate, not an attested broker commission tariff. */
export const PEPPERSTONE_LIVE_PILOT_COST_RESERVE_PER_LOT_USD = '8';
export const PEPPERSTONE_LIVE_PILOT_FIXED_SLIPPAGE_RESERVE_USD = '0.20';
export const PEPPERSTONE_LIVE_PILOT_STOP_BUFFER_MULTIPLIER = '1.20';

export function pepperstoneLivePilotIsScoped(input: {
  brokerId: string; accountType: string; accountCurrency: string;
}): boolean {
  return input.brokerId === 'pepperstone-ctrader' &&
    input.accountType === 'LIVE' &&
    input.accountCurrency === 'USD';
}

export function evaluatePepperstoneLiveMicroRisk(input: {
  equityUsd: string;
  lots: string;
  brokerMinimumLots: string;
  grossRiskAtStopUsd: string;
}): {
  allowed: boolean;
  code: 'LIVE_LOT_BROKER_MIN_TOO_LARGE' | 'LIVE_LOT_RANGE_LIMIT' |
    'LIVE_COST_INCLUSIVE_RISK_LIMIT' | null;
  projectedCostInclusiveRiskUsd: string;
  maximumRiskUsd: string;
} {
  const maxLot = ExactDecimal.parse(PEPPERSTONE_LIVE_PILOT_LOT_CEILING);
  const equity = ExactDecimal.parse(input.equityUsd);
  const lots = ExactDecimal.parse(input.lots);
  const brokerMin = ExactDecimal.parse(input.brokerMinimumLots);
  const grossRisk = ExactDecimal.parse(input.grossRiskAtStopUsd);
  if (!equity.isPositive() || !lots.isPositive() || !brokerMin.isPositive() ||
      !grossRisk.isPositive()) {
    throw new Error('LIVE_LOT_INPUT_UNPROVABLE');
  }
  // Equity-proportional cap: $1 at $50 equity, $20 at $1,000 equity.
  const riskCap = equity
    .mul(ExactDecimal.parse(PEPPERSTONE_LIVE_PILOT_EQUITY_RISK_PERCENT))
    .divByPowerOfTen(2);
  const projected = grossRisk
    .mul(ExactDecimal.parse(PEPPERSTONE_LIVE_PILOT_STOP_BUFFER_MULTIPLIER))
    .add(lots.mul(ExactDecimal.parse(PEPPERSTONE_LIVE_PILOT_COST_RESERVE_PER_LOT_USD)))
    .add(ExactDecimal.parse(PEPPERSTONE_LIVE_PILOT_FIXED_SLIPPAGE_RESERVE_USD));
  const code = brokerMin.gt(maxLot)
    ? 'LIVE_LOT_BROKER_MIN_TOO_LARGE'
    : lots.gt(maxLot) || lots.lt(brokerMin)
      ? 'LIVE_LOT_RANGE_LIMIT'
      : projected.gt(riskCap)
        ? 'LIVE_COST_INCLUSIVE_RISK_LIMIT'
        : null;
  return {
    allowed: code === null,
    code,
    projectedCostInclusiveRiskUsd: projected.toString(),
    maximumRiskUsd: riskCap.toString(),
  };
}

/**
 * Auto-downsize a proposed LIVE position using broker volume STEP and the
 * remaining fee-inclusive single-trade risk envelope. This never rounds up
 * to a preferred lot target or assumes broker minimum 0.01 universally.
 * The account-level combined-risk gate runs independently afterward.
 */
export function affordablePepperstoneLiveLots(input: {
  equityUsd: string;
  proposedLots: string;
  brokerLotStep: string;
  stopRiskPerLotUsd: string;
}): string {
  const equity = ExactDecimal.parse(input.equityUsd);
  const proposed = ExactDecimal.parse(input.proposedLots);
  const step = ExactDecimal.parse(input.brokerLotStep);
  const stopRiskPerLot = ExactDecimal.parse(input.stopRiskPerLotUsd);
  if (!equity.isPositive() || !proposed.isPositive() || !step.isPositive() ||
      !stopRiskPerLot.isPositive()) throw new Error('LIVE_LOT_EVIDENCE_UNPROVABLE');
  const cap = equity.mul(ExactDecimal.parse(PEPPERSTONE_LIVE_PILOT_EQUITY_RISK_PERCENT))
    .divByPowerOfTen(2);
  const remaining = cap.sub(ExactDecimal.parse(PEPPERSTONE_LIVE_PILOT_FIXED_SLIPPAGE_RESERVE_USD));
  const perLot = stopRiskPerLot
    .mul(ExactDecimal.parse(PEPPERSTONE_LIVE_PILOT_STOP_BUFFER_MULTIPLIER))
    .add(ExactDecimal.parse(PEPPERSTONE_LIVE_PILOT_COST_RESERVE_PER_LOT_USD));
  const raw = remaining.isPositive()
    ? remaining.divDown(perLot, 8)
    : ExactDecimal.ZERO;
  const normalized = raw.divDown(step, 0).mul(step);
  return ExactDecimal.min(
    ExactDecimal.min(proposed, normalized),
    ExactDecimal.parse(PEPPERSTONE_LIVE_PILOT_LOT_CEILING),
  ).toString();
}

/**
 * Exact multi-position risk proof, evaluated inside one serialized account
 * allocation transaction with provider-position parity. No future data.
 * Maximum open positions comes from the existing risk-profile setting,
 * never a new hardcoded limit. Provider/ledger parity still required.
 */
export function evaluatePepperstoneLivePortfolioBudget(input: {
  equityUsd: string;
  proposedCostInclusiveRiskUsd: string;
  existingCostInclusiveRisksUsd: string[];
  providerOpenPositions: number;
  locallyProvenOpenPositions: number;
  pendingOrUncertainOrders: boolean;
  maxOpenPositions: number;
  maxEffectiveLeverage: string;
  proposedNotionalUsd: string;
  existingNotionalsUsd: string[];
}): {
  allowed: boolean;
  reason: 'LIVE_POSITION_COUNT_UNPROVABLE' | 'LIVE_POSITION_LIMIT' |
    'LIVE_PORTFOLIO_STOP_RISK_LIMIT' | 'LIVE_PORTFOLIO_LEVERAGE_LIMIT' | null;
  projectedTotalRiskUsd: string;
  riskCapUsd: string;
} {
  const equity = ExactDecimal.parse(input.equityUsd);
  const proposed = ExactDecimal.parse(input.proposedCostInclusiveRiskUsd);
  const proposedNotional = ExactDecimal.parse(input.proposedNotionalUsd);
  const maxLeverage = ExactDecimal.parse(input.maxEffectiveLeverage);
  if (!equity.isPositive() || !proposedNotional.isPositive() || !maxLeverage.isPositive() || !proposed.isPositive() ||
      !Number.isInteger(input.providerOpenPositions) ||
      !Number.isInteger(input.locallyProvenOpenPositions) ||
      input.providerOpenPositions < 0 || input.locallyProvenOpenPositions < 0 ||
      input.existingCostInclusiveRisksUsd.length !== input.locallyProvenOpenPositions ||
      input.existingNotionalsUsd.length !== input.locallyProvenOpenPositions ||
      !Number.isInteger(input.maxOpenPositions) || input.maxOpenPositions < 1 ||
      input.maxOpenPositions > 100) {
    throw new Error('LIVE_PORTFOLIO_EVIDENCE_UNPROVABLE');
  }
  const cap = equity.mul(ExactDecimal.parse(PEPPERSTONE_LIVE_PILOT_EQUITY_RISK_PERCENT))
    .divByPowerOfTen(2);
  const total = input.existingCostInclusiveRisksUsd.reduce((sum, risk) => {
    const value = ExactDecimal.parse(risk);
    if (!value.isPositive()) throw new Error('LIVE_PORTFOLIO_EVIDENCE_UNPROVABLE');
    return sum.add(value);
  }, proposed);
  const combinedNotional = input.existingNotionalsUsd.reduce((sum, notional) => {
    const value = ExactDecimal.parse(notional);
    if (!value.isPositive()) throw new Error('LIVE_PORTFOLIO_EVIDENCE_UNPROVABLE');
    return sum.add(value);
  }, proposedNotional);
  const totalLeverageCap = equity.mul(maxLeverage);
  const reason = input.pendingOrUncertainOrders ||
      input.providerOpenPositions !== input.locallyProvenOpenPositions
    ? 'LIVE_POSITION_COUNT_UNPROVABLE'
    : input.locallyProvenOpenPositions >= input.maxOpenPositions
      ? 'LIVE_POSITION_LIMIT'
      : combinedNotional.gte(totalLeverageCap)
        ? 'LIVE_PORTFOLIO_LEVERAGE_LIMIT'
        : total.gt(cap)
          ? 'LIVE_PORTFOLIO_STOP_RISK_LIMIT'
          : null;
  return {
    allowed: reason === null,
    reason,
    projectedTotalRiskUsd: total.toString(),
    riskCapUsd: cap.toString(),
  };
}
