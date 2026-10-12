import {
  evaluatePairedDirectionReversal,
  PAIRED_REVERSAL_MIN_ABSOLUTE_PROBABILITY,
  PAIRED_REVERSAL_MIN_DIRECTION_PROBABILITY,
} from './paired-direction-reversal';

const base = {
  primaryDirection: 'BUY' as const,
  buyProbability: 0.4,
  sellProbability: 0.58,
  rawMomentumAtr: -0.4,
  baseRegime: 'TREND_WEAK' as const,
  executionCostR: 0.08,
  targetRMultiple: 2.5 / 1.5,
};

describe('paired direction reversal', () => {
  it('derives complementary directional probabilities from equal independent evidence', () => {
    const result = evaluatePairedDirectionReversal({
      ...base,
      buyProbability: 0.5,
      sellProbability: 0.5,
    });

    expect(result.buyDirectionalProbability).toBeCloseTo(0.5, 12);
    expect(result.sellDirectionalProbability).toBeCloseTo(0.5, 12);
    expect(result.buyDirectionalProbability + result.sellDirectionalProbability).toBeCloseTo(1, 12);
    expect(result.preferredDirection).toBeNull();
    expect(result.reversalCandidate).toBe(false);
    expect(result.reason).toBe('DIRECTION_EDGE_TOO_SMALL');
  });

  it('is symmetric when BUY and SELL evidence are swapped', () => {
    const sellPreferred = evaluatePairedDirectionReversal(base);
    const buyPreferred = evaluatePairedDirectionReversal({
      ...base,
      primaryDirection: 'SELL',
      buyProbability: base.sellProbability,
      sellProbability: base.buyProbability,
      rawMomentumAtr: -base.rawMomentumAtr,
    });

    expect(sellPreferred.preferredDirection).toBe('SELL');
    expect(buyPreferred.preferredDirection).toBe('BUY');
    expect(sellPreferred.sellDirectionalProbability).toBeCloseTo(
      buyPreferred.buyDirectionalProbability,
      12,
    );
    expect(sellPreferred.buyDirectionalProbability).toBeCloseTo(
      buyPreferred.sellDirectionalProbability,
      12,
    );
  });

  it('turns a failed BUY thesis into a SELL reversal candidate when opposite evidence is strong and economical', () => {
    const result = evaluatePairedDirectionReversal(base);

    expect(result.preferredDirection).toBe('SELL');
    expect(result.sellDirectionalProbability).toBeGreaterThanOrEqual(
      PAIRED_REVERSAL_MIN_DIRECTION_PROBABILITY,
    );
    expect(result.preferredAbsoluteProbability).toBeGreaterThanOrEqual(
      PAIRED_REVERSAL_MIN_ABSOLUTE_PROBABILITY,
    );
    expect(result.alignedMomentumAtr).toBeCloseTo(0.4, 12);
    expect(result.researchNetExpectedR).toBeGreaterThan(0);
    expect(result.reversalCandidate).toBe(true);
    expect(result.reason).toBe('PAIRED_REVERSAL_CANDIDATE');
  });

  it('does not manufacture tradability from relative odds when both absolute models are weak', () => {
    const result = evaluatePairedDirectionReversal({
      ...base,
      buyProbability: 0.1,
      sellProbability: 0.25,
    });

    expect(result.sellDirectionalProbability).toBeGreaterThan(
      PAIRED_REVERSAL_MIN_DIRECTION_PROBABILITY,
    );
    expect(result.reversalCandidate).toBe(false);
    expect(result.reason).toBe('ABSOLUTE_TRADABILITY_TOO_LOW');
  });

  it('abstains when the preferred opposite side cannot clear execution costs', () => {
    const result = evaluatePairedDirectionReversal({
      ...base,
      executionCostR: 1.2,
    });

    expect(result.preferredDirection).toBe('SELL');
    expect(result.researchNetExpectedR).toBeLessThanOrEqual(0);
    expect(result.reversalCandidate).toBe(false);
    expect(result.reason).toBe('RESEARCH_NET_EXPECTED_R_TOO_LOW');
  });

  it('requires direction-aligned reversal momentum rather than blindly taking the opposite side', () => {
    const result = evaluatePairedDirectionReversal({
      ...base,
      rawMomentumAtr: 0.25,
    });

    expect(result.preferredDirection).toBe('SELL');
    expect(result.alignedMomentumAtr).toBeLessThan(0);
    expect(result.reversalCandidate).toBe(false);
    expect(result.reason).toBe('REVERSAL_MOMENTUM_NOT_CONFIRMED');
  });

  it('keeps healthy continuation evidence out of the reversal route', () => {
    const result = evaluatePairedDirectionReversal({
      ...base,
      baseRegime: 'TREND_HEALTHY',
    });

    expect(result.reversalCandidate).toBe(false);
    expect(result.reason).toBe('REVERSAL_REGIME_NOT_SUPPORTED');
  });

  it.each([
    { buyProbability: Number.NaN },
    { sellProbability: 1.1 },
    { executionCostR: -0.01 },
    { targetRMultiple: 0 },
    { rawMomentumAtr: Number.POSITIVE_INFINITY },
  ])('fails closed on invalid numeric evidence %#', (patch) => {
    const result = evaluatePairedDirectionReversal({ ...base, ...patch });
    expect(result.reversalCandidate).toBe(false);
    expect(result.reason).toBe('INVALID_INPUT');
  });
});
