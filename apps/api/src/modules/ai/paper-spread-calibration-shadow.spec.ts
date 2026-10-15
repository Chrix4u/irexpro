import {
  classifyPaperSpreadSession,
  evaluatePaperSpreadCalibrationShadow,
} from './paper-spread-calibration-shadow';

describe('paper spread calibration shadow', () => {
  it('uses conservative broker P95 when same-session history is mature', () => {
    expect(
      evaluatePaperSpreadCalibrationShadow({
        instrument: 'AUDUSD',
        evaluatedAt: new Date('2026-10-15T14:30:00Z'),
        fixedSpreadPrice: 0.0001,
        stopDistancePrice: 0.0005,
        history: { sampleCount: 640, p95SpreadPrice: 0.00002 },
      }),
    ).toMatchObject({
      artifact: 'paper-spread-calibration-shadow-v1',
      session: 'NEW_YORK',
      fixedSpreadPrice: 0.0001,
      calibratedSpreadPrice: 0.000025,
      reason: 'CALIBRATED_P95_WITH_FLOOR',
      executionAuthority: 'NONE',
      modifiesExecution: false,
      qualificationEvidence: false,
      fixedCostR: 0.25,
      calibratedCostR: 0.0625,
      costReductionR: 0.1875,
    });
  });

  it('falls back to fixed spread when history is sparse', () => {
    expect(
      evaluatePaperSpreadCalibrationShadow({
        instrument: 'EURUSD',
        evaluatedAt: new Date('2026-10-15T08:00:00Z'),
        fixedSpreadPrice: 0.0001,
        stopDistancePrice: 0.0005,
        history: { sampleCount: 99, p95SpreadPrice: 0.00002 },
      }),
    ).toMatchObject({
      calibratedSpreadPrice: 0.0001,
      reason: 'SPARSE_HISTORY_FIXED_FALLBACK',
      modifiesExecution: false,
    });
  });

  it('falls back to fixed spread for invalid broker statistics', () => {
    expect(
      evaluatePaperSpreadCalibrationShadow({
        instrument: 'GBPUSD',
        evaluatedAt: new Date('2026-10-15T08:00:00Z'),
        fixedSpreadPrice: 0.00012,
        stopDistancePrice: 0.0005,
        history: { sampleCount: 500, p95SpreadPrice: 0 },
      }),
    ).toMatchObject({
      calibratedSpreadPrice: 0.00012,
      reason: 'INVALID_HISTORY_FIXED_FALLBACK',
    });
  });

  it('never calibrates below one quarter of the executable fixed PAPER spread', () => {
    const result = evaluatePaperSpreadCalibrationShadow({
      instrument: 'USDCAD',
      evaluatedAt: new Date('2026-10-15T14:00:00Z'),
      fixedSpreadPrice: 0.00012,
      stopDistancePrice: 0.0005,
      history: { sampleCount: 500, p95SpreadPrice: 0.000001 },
    });
    expect(result.minimumSpreadFloorPrice).toBeCloseTo(0.00003, 10);
    expect(result.calibratedSpreadPrice).toBeCloseTo(0.00003, 10);
  });

  it('classifies UTC session buckets deterministically', () => {
    expect(classifyPaperSpreadSession(new Date('2026-10-15T00:00:00Z'))).toBe('ASIA');
    expect(classifyPaperSpreadSession(new Date('2026-10-15T07:00:00Z'))).toBe('LONDON');
    expect(classifyPaperSpreadSession(new Date('2026-10-15T13:00:00Z'))).toBe('NEW_YORK');
    expect(classifyPaperSpreadSession(new Date('2026-10-15T21:00:00Z'))).toBe('ROLLOVER');
  });
});
