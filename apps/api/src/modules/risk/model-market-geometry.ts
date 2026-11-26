import { ExactDecimal } from '../../common/utils/exact-decimal';

/**
 * Pure model geometry calculation, separated from account sizing and authority.
 * This preserves the existing allocation-aware DEMO/PAPER calculation exactly.
 * It does not validate freshness, broker rules, risk budgets, or grant authority.
 * LIVE call sites must not use this as an authorization or validation shortcut.
 */
export function rebaseModelMarketGeometry(input: {
  direction: 'BUY' | 'SELL';
  referenceEntry: string;
  stopLoss: string;
  takeProfit: string;
  executableEntry: ExactDecimal;
}): { stopLoss: string; takeProfit: string } | null {
  const referenceEntry = ExactDecimal.tryParse(input.referenceEntry);
  const originalStop = ExactDecimal.tryParse(input.stopLoss);
  const originalTake = ExactDecimal.tryParse(input.takeProfit);
  if (!referenceEntry?.isPositive() || !originalStop?.isPositive() || !originalTake?.isPositive()) {
    return null;
  }
  const stopDistance = referenceEntry.sub(originalStop).abs();
  const targetDistance = originalTake.sub(referenceEntry).abs();
  const validDirection =
    input.direction === 'BUY'
      ? originalStop.lt(referenceEntry) && originalTake.gt(referenceEntry)
      : originalStop.gt(referenceEntry) && originalTake.lt(referenceEntry);
  if (!validDirection || !stopDistance.isPositive() || !targetDistance.isPositive()) {
    return null;
  }
  return {
    stopLoss:
      input.direction === 'BUY'
        ? input.executableEntry.sub(stopDistance).toString()
        : input.executableEntry.add(stopDistance).toString(),
    takeProfit:
      input.direction === 'BUY'
        ? input.executableEntry.add(targetDistance).toString()
        : input.executableEntry.sub(targetDistance).toString(),
  };
}
