import { ExactDecimal } from '../../../common/utils/exact-decimal';

/**
 * Conservative PREPARATION for the first Pepperstone USD LIVE micro-account
 * pilot. This does NOT authorize LIVE execution or bypass broker verification.
 * It is applied only after authoritative broker min-lot / stop / FX data.
 * Fee/slippage reserve is deliberately conservative, not a broker guarantee.
 */
export const PEPPERSTONE_LIVE_PILOT_LOT_CEILING = '0.01';
export const PEPPERSTONE_LIVE_PILOT_EQUITY_RISK_PERCENT = '2';
export const PEPPERSTONE_LIVE_PILOT_ABSOLUTE_RISK_USD = '1';
export const PEPPERSTONE_LIVE_PILOT_COST_RESERVE_USD = '0.20';
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
  code: 'LIVE_MICRO_BROKER_MIN_TOO_LARGE' | 'LIVE_MICRO_LOT_LIMIT' |
    'LIVE_MICRO_COST_INCLUSIVE_RISK_LIMIT' | null;
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
    throw new Error('LIVE_MICRO_INPUT_UNPROVABLE');
  }
  const riskCap = ExactDecimal.min(
    equity.mul(ExactDecimal.parse(PEPPERSTONE_LIVE_PILOT_EQUITY_RISK_PERCENT))
      .divByPowerOfTen(2),
    ExactDecimal.parse(PEPPERSTONE_LIVE_PILOT_ABSOLUTE_RISK_USD),
  );
  const projected = grossRisk
    .mul(ExactDecimal.parse(PEPPERSTONE_LIVE_PILOT_STOP_BUFFER_MULTIPLIER))
    .add(ExactDecimal.parse(PEPPERSTONE_LIVE_PILOT_COST_RESERVE_USD));
  const code = brokerMin.gt(maxLot)
    ? 'LIVE_MICRO_BROKER_MIN_TOO_LARGE'
    : lots.gt(maxLot) || lots.lt(brokerMin)
      ? 'LIVE_MICRO_LOT_LIMIT'
      : projected.gt(riskCap)
        ? 'LIVE_MICRO_COST_INCLUSIVE_RISK_LIMIT'
        : null;
  return {
    allowed: code === null,
    code,
    projectedCostInclusiveRiskUsd: projected.toString(),
    maximumRiskUsd: riskCap.toString(),
  };
}
