export interface HighWaterMarkCalculationInput {
  cumulativeRealisedMinor: string;
  startingHighWaterMarkMinor: string;
  feePercent: string;
}

export interface HighWaterMarkCalculationResult {
  cumulativeRealisedMinor: string;
  startingHighWaterMarkMinor: string;
  realisedProfitForFeeMinor: string;
  feeAmountMinor: string;
}

export function computeFeeAmount(profitMinorUnits: string, feePercent: string): string {
  const profit = BigInt(profitMinorUnits);
  if (profit <= 0n) return '0';

  const percent = Number.parseFloat(feePercent);
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
    throw new Error(`Invalid performance fee percentage: ${feePercent}`);
  }

  const feePercentScaled = BigInt(Math.round(percent * 10_000));
  return ((profit * feePercentScaled) / 1_000_000n).toString();
}
export function calculateHighWaterMarkFee(
  input: HighWaterMarkCalculationInput,
): HighWaterMarkCalculationResult {
  const cumulativeRealised = BigInt(input.cumulativeRealisedMinor);
  const startingHighWaterMark = BigInt(input.startingHighWaterMarkMinor);
  const delta = cumulativeRealised - startingHighWaterMark;
  const realisedProfitForFee = delta > 0n ? delta : 0n;

  return {
    cumulativeRealisedMinor: cumulativeRealised.toString(),
    startingHighWaterMarkMinor: startingHighWaterMark.toString(),
    realisedProfitForFeeMinor: realisedProfitForFee.toString(),
    feeAmountMinor: computeFeeAmount(realisedProfitForFee.toString(), input.feePercent),
  };
}
