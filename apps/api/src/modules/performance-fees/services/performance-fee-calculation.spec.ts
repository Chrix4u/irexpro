import { calculateHighWaterMarkFee, computeFeeAmount } from './performance-fee-calculation';

describe('performance fee calculation', () => {
  it('calculates the same 20% fee used by the LIVE engine', () => {
    expect(computeFeeAmount('50000', '20.0000')).toBe('10000');
  });

  it('charges only cumulative realised profit above the high-water mark', () => {
    expect(
      calculateHighWaterMarkFee({
        cumulativeRealisedMinor: '75000',
        startingHighWaterMarkMinor: '50000',
        feePercent: '20.0000',
      }),
    ).toEqual({
      cumulativeRealisedMinor: '75000',
      startingHighWaterMarkMinor: '50000',
      realisedProfitForFeeMinor: '25000',
      feeAmountMinor: '5000',
    });
  });

  it('produces no fee below the high-water mark', () => {
    const result = calculateHighWaterMarkFee({
      cumulativeRealisedMinor: '-6530',
      startingHighWaterMarkMinor: '0',
      feePercent: '20.0000',
    });
    expect(result.realisedProfitForFeeMinor).toBe('0');
    expect(result.feeAmountMinor).toBe('0');
  });
});
