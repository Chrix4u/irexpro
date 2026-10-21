import * as Research from './paper-research-throughput';

const baseInput = {
  idleMinutes: 300,
  paperExecutionBlockers: [
    'ENSEMBLE_NOT_PAPER_ADMITTED',
    'ENSEMBLE_NOT_PROMOTABLE_ADMISSION',
    'PAPER_NET_EXPECTED_R',
    'DRIFT_OUT_OF_DISTRIBUTION',
  ],
  consensusPassed: 4,
  consensusRequired: 6,
  eventRisk: 'CLEAR',
  executionCostUsable: true,
  calibration: {
    authoritative: true,
    sourceLevel: 'PAIR_DIRECTION_ROUTE',
    maturity: 'COLLECTING',
    samples: 15,
    calibratedNetExpectedR: 0.173,
    calibratedWinProbability: 0.616,
    profitFactor: 1.82,
    recentDegradation: false,
    blockRecommended: false,
  },
};

function evaluator(): ((input: typeof baseInput) => any) | undefined {
  return (Research as unknown as Record<string, unknown>)['evaluatePaperCalibratedIdleRecovery'] as
    | ((input: typeof baseInput) => any)
    | undefined;
}

describe('PAPER calibrated idle recovery', () => {
  it('is implemented as a pure research safety decision', () => {
    expect(typeof evaluator()).toBe('function');
  });

  it('removes only PAPER_NET_EXPECTED_R after prolonged idle with strong local calibration', () => {
    const evaluate = evaluator();
    expect(typeof evaluate).toBe('function');
    if (!evaluate) return;
    expect(evaluate(baseInput)).toMatchObject({
      eligible: true,
      reason: 'CALIBRATED_IDLE_RECOVERY',
      lotCap: 0.05,
      effectivePaperExecutionBlockers: [
        'ENSEMBLE_NOT_PAPER_ADMITTED',
        'ENSEMBLE_NOT_PROMOTABLE_ADMISSION',
        'DRIFT_OUT_OF_DISTRIBUTION',
      ],
    });
  });

  it('does not unlock before four hours idle', () => {
    const evaluate = evaluator();
    if (!evaluate) return;
    expect(evaluate({ ...baseInput, idleMinutes: 239.9 })).toMatchObject({
      eligible: false,
      reason: 'IDLE_WINDOW_NOT_REACHED',
    });
  });

  it('does not trust broad calibration for execution rescue', () => {
    const evaluate = evaluator();
    if (!evaluate) return;
    expect(
      evaluate({
        ...baseInput,
        calibration: { ...baseInput.calibration, sourceLevel: 'ROUTE' },
      }),
    ).toMatchObject({ eligible: false, reason: 'CALIBRATION_NOT_LOCAL' });
  });

  it('does not bypass a post-loss blocker or other unsafe blocker', () => {
    const evaluate = evaluator();
    if (!evaluate) return;
    expect(
      evaluate({
        ...baseInput,
        paperExecutionBlockers: [
          ...baseInput.paperExecutionBlockers,
          'PAPER_POST_LOSS_DIRECTION_NOT_RECONFIRMED',
        ],
      }),
    ).toMatchObject({ eligible: false, reason: 'UNSAFE_BLOCKER' });
  });

  it('does not rescue weak or degrading calibrated edge', () => {
    const evaluate = evaluator();
    if (!evaluate) return;
    expect(
      evaluate({
        ...baseInput,
        calibration: {
          ...baseInput.calibration,
          calibratedNetExpectedR: 0.05,
          recentDegradation: true,
        },
      }),
    ).toMatchObject({ eligible: false });
  });
});
