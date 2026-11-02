import { evaluateCalibrationBidirectionalConflict } from './calibration-bidirectional-conflict';

const calibration = (blockRecommended: boolean) => ({
  blockRecommended,
  reason: blockRecommended ? 'CALIBRATED_EDGE_UNFAVOURABLE' : 'CALIBRATION_APPLIED',
  sourceLevel: 'PAIR_DIRECTION_ROUTE' as const,
  maturity: blockRecommended ? ('DEGRADED' as const) : ('MATURE' as const),
  samples: 16,
  calibratedNetExpectedR: blockRecommended ? -0.18 : 0.22,
  calibratedWinProbability: blockRecommended ? 0.34 : 0.61,
});

const paired = (buy: number, sell: number) => ({
  buyDirectionalProbability: buy,
  sellDirectionalProbability: sell,
  preferredDirection:
    buy >= 0.64 || sell >= 0.64 ? (buy >= sell ? ('BUY' as const) : ('SELL' as const)) : null,
  preferredAbsoluteProbability: Math.max(buy, sell),
  directionalEdge: Math.abs(buy - sell),
  reason: 'DIRECTION_EDGE_TOO_SMALL' as const,
});

describe('evaluateCalibrationBidirectionalConflict', () => {
  it('reports no conflict when calibration does not recommend a block', () => {
    const result = evaluateCalibrationBidirectionalConflict({
      candidateDirection: 'BUY',
      strategyRoute: 'TREND_CONTINUATION',
      adaptiveState: 'DISLOCATED',
      calibration: calibration(false),
      paired: paired(0.72, 0.28),
    });

    expect(result.state).toBe('NO_CALIBRATION_BLOCK');
    expect(result.reason).toBe('CALIBRATION_NOT_BLOCKED');
    expect(result.executionAuthority).toBe('NONE');
    expect(result.modifiesExecution).toBe(false);
  });

  it('records calibration block while the current side is favored by paired probabilities', () => {
    const result = evaluateCalibrationBidirectionalConflict({
      candidateDirection: 'SELL',
      strategyRoute: 'TREND_CONTINUATION',
      adaptiveState: 'DISLOCATED',
      calibration: calibration(true),
      paired: paired(0.31, 0.69),
    });

    expect(result.state).toBe('BLOCK_CURRENT_SIDE_FAVORED');
    expect(result.reason).toBe('CALIBRATION_BLOCK_CURRENT_SIDE_FAVORED');
    expect(result.candidateDirectionalProbability).toBeCloseTo(0.69, 8);
    expect(result.oppositeDirectionalProbability).toBeCloseTo(0.31, 8);
    expect(result.rawPreferredDirection).toBe('SELL');
  });

  it('records calibration block while the opposite side is favored by paired probabilities', () => {
    const result = evaluateCalibrationBidirectionalConflict({
      candidateDirection: 'BUY',
      strategyRoute: 'TREND_CONTINUATION',
      adaptiveState: 'DISLOCATED',
      calibration: calibration(true),
      paired: paired(0.42, 0.58),
    });

    expect(result.state).toBe('BLOCK_OPPOSITE_SIDE_FAVORED');
    expect(result.reason).toBe('CALIBRATION_BLOCK_OPPOSITE_SIDE_FAVORED');
    expect(result.rawPreferredDirection).toBe('SELL');
  });

  it('treats exactly balanced paired probabilities as balanced telemetry', () => {
    const result = evaluateCalibrationBidirectionalConflict({
      candidateDirection: 'BUY',
      strategyRoute: 'TREND_CONTINUATION',
      adaptiveState: 'DISLOCATED',
      calibration: calibration(true),
      paired: paired(0.5, 0.5),
    });

    expect(result.state).toBe('BLOCK_PAIRED_BALANCED');
    expect(result.reason).toBe('CALIBRATION_BLOCK_PAIRED_BALANCED');
    expect(result.rawPreferredDirection).toBeNull();
  });

  it('fails safe to invalid telemetry for non-finite paired probabilities', () => {
    const result = evaluateCalibrationBidirectionalConflict({
      candidateDirection: 'SELL',
      strategyRoute: 'TREND_CONTINUATION',
      adaptiveState: 'DISLOCATED',
      calibration: calibration(true),
      paired: paired(Number.NaN, 0.7),
    });

    expect(result.state).toBe('BLOCK_PAIRED_INVALID');
    expect(result.reason).toBe('CALIBRATION_BLOCK_PAIRED_INVALID');
    expect(result.rawPreferredDirection).toBeNull();
    expect(result.executionAuthority).toBe('NONE');
    expect(result.modifiesExecution).toBe(false);
  });
});
