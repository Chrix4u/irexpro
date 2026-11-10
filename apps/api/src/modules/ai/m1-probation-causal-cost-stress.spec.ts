import {
  PROBATION_CAUSAL_COST_STRESS_ARTIFACT,
  evaluateProbationCausalCostStress,
} from './m1-probation-causal-cost-stress';

const score = (input: Partial<Parameters<typeof evaluateProbationCausalCostStress>[0]> = {}) =>
  evaluateProbationCausalCostStress({
    instrument: 'AUDUSD',
    grossOutcome: 'TARGET_QUOTE_TOUCH',
    grossR: 1.6,
    stopDistance: 0.0005,
    feeSamples: 5,
    feeP90R: 0.12,
    spreadBars: 12,
    spreadP90Price: 0.00003,
    ...input,
  });

describe('probation causal cost stress research', () => {
  it('reduces quote-only gross R with causal broker P90 fee, stressed spread and slippage', () => {
    const result = score();
    expect(result).toMatchObject({
      artifact: PROBATION_CAUSAL_COST_STRESS_ARTIFACT,
      state: 'ESTIMABLE_STRESS_ONLY',
      indicativeGrossR: 1.6,
      brokerFeeP90R: 0.12,
      spreadStressMultiplier: 1.25,
      spreadStressR: 0.075,
      slippageStressPips: 0.5,
      slippageStressR: 0.1,
      totalStressCostR: 0.295,
      stressedCostAdjustedR: 1.305,
      executionAuthority: 'NONE',
      modifiesExecution: false,
      noExecutableFillProof: true,
    });
    expect(score({ grossOutcome: 'STOP_QUOTE_TOUCH', grossR: -1 }).stressedCostAdjustedR).toBe(
      -1.295,
    );
  });
  it('does not manufacture net profitability without at least five historical same-pair broker fills', () => {
    for (const fees of [0, 1, 3, 4]) {
      expect(score({ feeSamples: fees, feeP90R: 0.12 })).toMatchObject({
        state: 'INSUFFICIENT_CAUSAL_FEES',
        stressedCostAdjustedR: null,
      });
    }
    expect(score({ feeSamples: 10, feeP90R: null }).state).toBe('INSUFFICIENT_CAUSAL_FEES');
    expect(score({ feeSamples: 10, feeP90R: -1 }).state).toBe('INSUFFICIENT_CAUSAL_FEES');
  });
  it('does not manufacture net profitability without enough previously observed spread', () => {
    expect(score({ spreadBars: 3 }).state).toBe('INSUFFICIENT_CAUSAL_SPREAD');
    expect(score({ spreadP90Price: null }).state).toBe('INSUFFICIENT_CAUSAL_SPREAD');
    expect(score({ spreadP90Price: 0 }).state).toBe('INSUFFICIENT_CAUSAL_SPREAD');
  });
  it('does not turn data gaps or same-bar uncertainty into cost-adjusted wins', () => {
    for (const state of ['DATA_GAP', 'BOTH_IN_BAR', 'INVALID_GEOMETRY']) {
      expect(score({ grossOutcome: state, grossR: null })).toMatchObject({
        state: 'UNRESOLVED_QUOTE_OUTCOME',
        stressedCostAdjustedR: null,
      });
    }
  });
  it('uses JPY pips and never assumes USDJPY has 0.0001 pip precision', () => {
    expect(
      score({
        instrument: 'USDJPY',
        stopDistance: 0.05,
        spreadP90Price: 0.004,
        feeP90R: 0.19,
      }),
    ).toMatchObject({
      state: 'ESTIMABLE_STRESS_ONLY',
      spreadStressR: 0.1,
      slippageStressR: 0.1,
      totalStressCostR: 0.39,
      stressedCostAdjustedR: 1.21,
    });
  });
  it('rejects impossible geometry and non-finite gross R', () => {
    expect(score({ stopDistance: 0 }).state).toBe('INVALID_GEOMETRY');
    expect(score({ grossR: Infinity }).state).toBe('INVALID_GEOMETRY');
    expect(score({ instrument: 'XAUUSD' }).state).toBe('INVALID_GEOMETRY');
    expect(score({ stopDistance: NaN }).state).toBe('INVALID_GEOMETRY');
  });
});
