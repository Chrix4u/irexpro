import { buildValidationPipelineCandidate } from './validation-pipeline';

const thresholds = {
  candidateConfidenceFloor: 0.64,
  metaProbabilityFloor: 0.6,
};

function row(overrides: Record<string, unknown> = {}) {
  return {
    instrument: 'EURUSD',
    direction: 'BUY' as const,
    market_bar_time: new Date('2026-10-21T19:20:00.000Z'),
    evaluated_at: new Date('2026-10-21T19:20:10.000Z'),
    confidence: 0.72,
    regime: 'TREND_HEALTHY',
    regime_allowed: true,
    ensemble_score: 0.74,
    meta_probability: 0.68,
    expected_r: 0.22,
    consensus_passed: 6,
    consensus_required: 6,
    admitted: true,
    reasons: [],
    components: {
      strategyRoute: 'TREND_CONTINUATION',
      directionQuality: 0.7,
      tradeQuality: 0.66,
      exitQuality: 0.64,
      governance: {
        netExpectedR: 0.11,
        paperNetExpectedRPassed: true,
        paperDriftPassed: true,
        eventRisk: 'CLEAR',
        paperExecutionCostUsable: true,
        paperExecutionEligible: true,
        paperExecutionBlockers: [],
        blockers: [],
      },
    },
    ...overrides,
  };
}

describe('buildValidationPipelineCandidate', () => {
  it('marks every validation stage passed only when backend evidence is positive', () => {
    const candidate = buildValidationPipelineCandidate(row(), thresholds);

    expect(candidate.instrument).toBe('EURUSD');
    expect(candidate.direction).toBe('BUY');
    expect(candidate.status).toBe('READY');
    expect(candidate.passedGates).toBe(candidate.totalGates);
    expect(candidate.gates.map((gate) => [gate.code, gate.state])).toEqual([
      ['MARKET_DATA', 'PASS'],
      ['REGIME', 'PASS'],
      ['MODEL_QUALITY', 'PASS'],
      ['CONSENSUS', 'PASS'],
      ['NET_EDGE', 'PASS'],
      ['DRIFT', 'PASS'],
      ['EVENT_RISK', 'PASS'],
      ['PAPER_EXECUTION', 'PASS'],
    ]);
    expect(candidate.primaryBlocker).toBeNull();
  });

  it('shows the first failed validation stage and preserves backend blocker evidence', () => {
    const candidate = buildValidationPipelineCandidate(
      row({
        confidence: 0.58,
        regime: 'TREND_WEAK',
        regime_allowed: false,
        consensus_passed: 4,
        admitted: false,
        reasons: ['REGIME_TREND_WEAK', 'CONFIDENCE_FLOOR', 'META_EXPECTED_VALUE'],
        components: {
          strategyRoute: 'TREND_CONTINUATION',
          directionQuality: 0.42,
          tradeQuality: 0.44,
          exitQuality: 0.46,
          governance: {
            netExpectedR: -0.12,
            paperNetExpectedRPassed: false,
            paperDriftPassed: false,
            eventRisk: 'HIGH_IMPACT_BLOCK',
            paperExecutionCostUsable: true,
            paperExecutionEligible: false,
            paperExecutionBlockers: ['PAPER_NET_EXPECTED_R', 'DRIFT_OUT_OF_DISTRIBUTION'],
            blockers: ['HIGH_IMPACT_EVENT'],
          },
        },
      }),
      thresholds,
    );

    expect(candidate.status).toBe('BLOCKED');
    expect(candidate.primaryBlocker).toContain('Regime');
    expect(candidate.blockers).toEqual(
      expect.arrayContaining([
        'REGIME_TREND_WEAK',
        'CONFIDENCE_FLOOR',
        'PAPER_NET_EXPECTED_R',
        'DRIFT_OUT_OF_DISTRIBUTION',
        'HIGH_IMPACT_EVENT',
      ]),
    );
    expect(candidate.gates.find((gate) => gate.code === 'MODEL_QUALITY')?.state).toBe('BLOCKED');
    expect(candidate.gates.find((gate) => gate.code === 'NET_EDGE')?.state).toBe('BLOCKED');
    expect(candidate.gates.find((gate) => gate.code === 'DRIFT')?.state).toBe('BLOCKED');
    expect(candidate.gates.find((gate) => gate.code === 'EVENT_RISK')?.state).toBe('BLOCKED');
    expect(candidate.gates.find((gate) => gate.code === 'PAPER_EXECUTION')?.state).toBe('BLOCKED');
  });

  it('never converts missing governance evidence into a passed execution gate', () => {
    const candidate = buildValidationPipelineCandidate(
      row({ components: { strategyRoute: 'EARLY_TRANSITION' } }),
      thresholds,
    );

    expect(candidate.status).toBe('WAITING');
    expect(candidate.gates.find((gate) => gate.code === 'NET_EDGE')?.state).toBe('WAITING');
    expect(candidate.gates.find((gate) => gate.code === 'DRIFT')?.state).toBe('WAITING');
    expect(candidate.gates.find((gate) => gate.code === 'EVENT_RISK')?.state).toBe('WAITING');
    expect(candidate.gates.find((gate) => gate.code === 'PAPER_EXECUTION')?.state).toBe('WAITING');
  });
});
