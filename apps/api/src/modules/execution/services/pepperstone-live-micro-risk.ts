import { ExactDecimal } from '../../../common/utils/exact-decimal';

/**
 * Account-scoped Pepperstone LIVE 0.01–1.00 lot range. The broker minimum
 * (currently 0.01) is the executable floor, not a forced preferred size.
 * Risk, actual free margin and stop+cost geometry always decide size.
 * This policy NEVER authorizes production-LIVE order execution.
 */
/** User-preferred AI size, NEVER a hard executable minimum. */
export const PEPPERSTONE_LIVE_PILOT_PREFERRED_MIN_LOTS = '0.10';
/** Broker executable floor (per-instrument broker minimum may be higher). */
export const PEPPERSTONE_LIVE_PILOT_MIN_LOTS = '0.01';
export const PEPPERSTONE_LIVE_PILOT_LOT_CEILING = '1';
export const PEPPERSTONE_LIVE_PILOT_EQUITY_RISK_PERCENT = '2';
/** Conservative screening estimate, not an attested broker commission tariff. */
export const PEPPERSTONE_LIVE_PILOT_COST_RESERVE_PER_LOT_USD = '8';
export const PEPPERSTONE_LIVE_PILOT_FIXED_SLIPPAGE_RESERVE_USD = '0.20';
export const PEPPERSTONE_LIVE_PILOT_STOP_BUFFER_MULTIPLIER = '1.20';

export function pepperstoneLivePilotIsScoped(input: {
  brokerId: string;
  accountType: string;
  accountCurrency: string;
}): boolean {
  return (
    input.brokerId === 'pepperstone-ctrader' &&
    input.accountType === 'LIVE' &&
    input.accountCurrency === 'USD'
  );
}

export function evaluatePepperstoneLiveMicroRisk(input: {
  equityUsd: string;
  lots: string;
  brokerMinimumLots: string;
  grossRiskAtStopUsd: string;
}): {
  allowed: boolean;
  code:
    | 'LIVE_LOT_BROKER_MIN_TOO_LARGE'
    | 'LIVE_LOT_RANGE_LIMIT'
    | 'LIVE_MIN_LOT_NOT_AFFORDABLE'
    | 'LIVE_COST_INCLUSIVE_RISK_LIMIT'
    | null;
  projectedCostInclusiveRiskUsd: string;
  maximumRiskUsd: string;
} {
  const maxLot = ExactDecimal.parse(PEPPERSTONE_LIVE_PILOT_LOT_CEILING);
  const requestedMinLot = ExactDecimal.parse(PEPPERSTONE_LIVE_PILOT_MIN_LOTS);
  const equity = ExactDecimal.parse(input.equityUsd);
  const lots = ExactDecimal.parse(input.lots);
  const brokerMin = ExactDecimal.parse(input.brokerMinimumLots);
  const grossRisk = ExactDecimal.parse(input.grossRiskAtStopUsd);
  if (
    !equity.isPositive() ||
    !lots.isPositive() ||
    !brokerMin.isPositive() ||
    !grossRisk.isPositive()
  ) {
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
      : lots.lt(requestedMinLot)
        ? 'LIVE_MIN_LOT_NOT_AFFORDABLE'
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
