import { ExactDecimal } from '../../../common/utils/exact-decimal';

export type DrawdownRiskMultiplier = '0.25' | '0.5' | '0.75' | '1';

export interface DrawdownRiskAdjustment {
  currentDrawdownPercent: string | null;
  maxDrawdownPercent: string | null;
  multiplier: DrawdownRiskMultiplier;
}

/**
 * Soft sizing guard that de-risks BEFORE the hard RiskService drawdown limit.
 *
 * Bands are relative to the user's configured maximum drawdown:
 *   <25% used  -> 1.00x risk
 *   >=25% used -> 0.75x risk
 *   >=50% used -> 0.50x risk
 *   >=75% used -> 0.25x risk
 *
 * This helper can only reduce position risk. Missing/legacy peak evidence is
 * neutral here because the authoritative RiskService independently fails
 * closed when its required session baseline cannot be proven.
 */
export function drawdownRiskAdjustment(input: {
  equity: ExactDecimal;
  sessionPeakEquity: string | null | undefined;
  maxDrawdownPercent: string | null | undefined;
}): DrawdownRiskAdjustment {
  const peak = ExactDecimal.tryParse(input.sessionPeakEquity ?? '');
  const maxDrawdown = ExactDecimal.tryParse(input.maxDrawdownPercent ?? '');
  if (!peak?.isPositive() || !maxDrawdown?.isPositive()) {
    return {
      currentDrawdownPercent: null,
      maxDrawdownPercent: maxDrawdown?.isPositive() ? maxDrawdown.toString() : null,
      multiplier: '1',
    };
  }

  const drawdownAmount = peak.sub(input.equity);
  if (!drawdownAmount.isPositive()) {
    return {
      currentDrawdownPercent: '0',
      maxDrawdownPercent: maxDrawdown.toString(),
      multiplier: '1',
    };
  }

  // Round drawdown UP for reporting/safety so an inexact quotient can never
  // postpone a de-risking boundary. Band comparisons below stay exact.
  const currentDrawdownPercent = drawdownAmount.mul(ExactDecimal.HUNDRED).divUp(peak, 8);

  // Compare exact cross-products instead of dividing by maxDrawdown.
  // 75% band: currentDD >= maxDD * 3/4
  if (
    currentDrawdownPercent
      .mul(ExactDecimal.parse('4'))
      .gte(maxDrawdown.mul(ExactDecimal.parse('3')))
  ) {
    return {
      currentDrawdownPercent: currentDrawdownPercent.toString(),
      maxDrawdownPercent: maxDrawdown.toString(),
      multiplier: '0.25',
    };
  }
  // 50% band: currentDD >= maxDD / 2
  if (currentDrawdownPercent.mul(ExactDecimal.parse('2')).gte(maxDrawdown)) {
    return {
      currentDrawdownPercent: currentDrawdownPercent.toString(),
      maxDrawdownPercent: maxDrawdown.toString(),
      multiplier: '0.5',
    };
  }
  // 25% band: currentDD >= maxDD / 4
  if (currentDrawdownPercent.mul(ExactDecimal.parse('4')).gte(maxDrawdown)) {
    return {
      currentDrawdownPercent: currentDrawdownPercent.toString(),
      maxDrawdownPercent: maxDrawdown.toString(),
      multiplier: '0.75',
    };
  }

  return {
    currentDrawdownPercent: currentDrawdownPercent.toString(),
    maxDrawdownPercent: maxDrawdown.toString(),
    multiplier: '1',
  };
}
