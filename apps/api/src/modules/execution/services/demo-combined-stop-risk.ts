import { ExactDecimal } from '../../../common/utils/exact-decimal';

/**
 * Non-guaranteed, account-currency stop exposure estimate. Serialized account
 * allocation checks must run this on all existing committed positions and
 * the proposed position using only as-of broker/ledger evidence.
 */
export function evaluateDemoCombinedStopRisk(input: {
  totalCapital: string;
  brokerEquity: string;
  maxPercent: string;
  observedCommissionPerLot: string;
  proposed: { grossStopRisk: string; lots: string };
  committed: Array<{ grossStopRisk: string; lots: string }>;
}): { allowed: boolean; projectedRisk: string; maxRisk: string } {
  const one = ExactDecimal.parse('1');
  const grossReserve = ExactDecimal.parse('1.2'); // conservative 20% gap/spread headroom; not a maximum loss guarantee
  const total = ExactDecimal.min(
    ExactDecimal.parse(input.totalCapital),
    ExactDecimal.parse(input.brokerEquity),
  );
  const percent = ExactDecimal.parse(input.maxPercent);
  const feePerLot = ExactDecimal.parse(input.observedCommissionPerLot);
  if (!total.isPositive() || !percent.isPositive() || percent.gt(one) || feePerLot.lt(ExactDecimal.ZERO)) {
    throw new Error('DEMO_STOP_RISK_INPUT_UNPROVABLE');
  }
  const riskFor = ({ grossStopRisk, lots }: { grossStopRisk: string; lots: string }) => {
    const gross = ExactDecimal.parse(grossStopRisk);
    const lotCount = ExactDecimal.parse(lots);
    if (!gross.isPositive() || !lotCount.isPositive()) {
      throw new Error('DEMO_STOP_RISK_INPUT_UNPROVABLE');
    }
    return gross.mul(grossReserve).add(lotCount.mul(feePerLot));
  };
  const projected = input.committed.reduce(
    (acc, item) => acc.add(riskFor(item)),
    riskFor(input.proposed),
  );
  const cap = total.mul(percent).divByPowerOfTen(2);
  return {
    allowed: projected.lte(cap),
    projectedRisk: projected.toString(),
    maxRisk: cap.toString(),
  };
}
