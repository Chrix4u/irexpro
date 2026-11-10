/**
 * Research-only causal cost sensitivity of broker-native quote-based
 * missed-opportunity observations. Not an executable fill simulation.
 */
export const PROBATION_CAUSAL_COST_STRESS_ARTIFACT = 'm1-probation-causal-broker-cost-stress-v1';
export const PROBATION_MIN_PRIOR_FEES = 5;
export const PROBATION_MIN_PRIOR_SPREAD_BARS = 5;
export const PROBATION_SPREAD_STRESS_MULTIPLIER = 1.25;
export const PROBATION_SLIPPAGE_STRESS_PIPS = 0.5;
const SUPPORTED_FOREX_PAIRS = new Set(['AUDUSD', 'EURUSD', 'GBPUSD', 'USDCAD', 'USDCHF', 'USDJPY']);

export type ProbationCostState =
  | 'ESTIMABLE_STRESS_ONLY'
  | 'UNRESOLVED_QUOTE_OUTCOME'
  | 'INSUFFICIENT_CAUSAL_FEES'
  | 'INSUFFICIENT_CAUSAL_SPREAD'
  | 'INVALID_GEOMETRY';

export interface ProbationCostInput {
  instrument: string;
  grossOutcome: string;
  grossR: number | null;
  stopDistance: number;
  feeSamples: number;
  feeP90R: number | null;
  spreadBars: number;
  spreadP90Price: number | null;
}

export interface ProbationCostStressResult {
  artifact: typeof PROBATION_CAUSAL_COST_STRESS_ARTIFACT;
  mode: 'SHADOW_ONLY';
  state: ProbationCostState;
  grossOutcome: string;
  indicativeGrossR: number | null;
  stressedCostAdjustedR: number | null;
  brokerFeePriorFills: number;
  brokerFeeMinimumFills: number;
  brokerFeeP90R: number | null;
  brokerSpreadPriorBars: number;
  brokerSpreadMinimumBars: number;
  brokerSpreadP90Price: number | null;
  spreadStressMultiplier: number;
  spreadStressR: number | null;
  slippageStressPips: number;
  slippageStressR: number | null;
  totalStressCostR: number | null;
  noExecutableFillProof: true;
  executionAuthority: 'NONE';
  modifiesExecution: false;
  modelTrainingStatus: 'RESEARCH_ONLY_NOT_TRAINED';
}

const round = (value: number): number => Number(value.toFixed(5));
const validNumber = (n: number | null): n is number =>
  typeof n === 'number' && Number.isFinite(n) && n >= 0;

/**
 * The quote replay was built from a single OHLC mark stream. The entire
 * P90 round-trip spread, a 25% spread stress margin, and 0.5 pip of
 * hypothetical slippage are therefore conservatively subtracted in addition
 * to actual same-broker/side-independent historical round-trip commissions.
 *
 * None of these costs proves bid/ask fillability or slippage distribution.
 * Missing causal evidence produces a null, never a fabricated net profit.
 */
export function evaluateProbationCausalCostStress(
  input: ProbationCostInput,
): ProbationCostStressResult {
  const result: ProbationCostStressResult = {
    artifact: PROBATION_CAUSAL_COST_STRESS_ARTIFACT,
    mode: 'SHADOW_ONLY',
    state: 'UNRESOLVED_QUOTE_OUTCOME',
    grossOutcome: input.grossOutcome,
    indicativeGrossR: input.grossR,
    stressedCostAdjustedR: null,
    brokerFeePriorFills: input.feeSamples,
    brokerFeeMinimumFills: PROBATION_MIN_PRIOR_FEES,
    brokerFeeP90R: validNumber(input.feeP90R) ? input.feeP90R : null,
    brokerSpreadPriorBars: input.spreadBars,
    brokerSpreadMinimumBars: PROBATION_MIN_PRIOR_SPREAD_BARS,
    brokerSpreadP90Price: validNumber(input.spreadP90Price) ? input.spreadP90Price : null,
    spreadStressMultiplier: PROBATION_SPREAD_STRESS_MULTIPLIER,
    spreadStressR: null,
    slippageStressPips: PROBATION_SLIPPAGE_STRESS_PIPS,
    slippageStressR: null,
    totalStressCostR: null,
    noExecutableFillProof: true,
    executionAuthority: 'NONE',
    modifiesExecution: false,
    modelTrainingStatus: 'RESEARCH_ONLY_NOT_TRAINED',
  };
  if (
    !SUPPORTED_FOREX_PAIRS.has(input.instrument) ||
    !Number.isFinite(input.stopDistance) ||
    input.stopDistance <= 0 ||
    (input.grossR !== null && !Number.isFinite(input.grossR))
  )
    return { ...result, state: 'INVALID_GEOMETRY' };
  // No fixed R can be inferred when the replay has missing market data or
  // unresolved within-minute stop+target ordering.
  if (
    !['TARGET_QUOTE_TOUCH', 'STOP_QUOTE_TOUCH', 'TIME_MARK'].includes(input.grossOutcome) ||
    input.grossR === null
  )
    return result;
  if (
    !Number.isInteger(input.feeSamples) ||
    input.feeSamples < PROBATION_MIN_PRIOR_FEES ||
    !validNumber(input.feeP90R)
  )
    return { ...result, state: 'INSUFFICIENT_CAUSAL_FEES' };
  if (
    !Number.isInteger(input.spreadBars) ||
    input.spreadBars < PROBATION_MIN_PRIOR_SPREAD_BARS ||
    !validNumber(input.spreadP90Price) ||
    input.spreadP90Price <= 0
  )
    return { ...result, state: 'INSUFFICIENT_CAUSAL_SPREAD' };
  const pip = input.instrument.endsWith('JPY') ? 0.01 : 0.0001;
  const spreadStressR =
    (input.spreadP90Price * PROBATION_SPREAD_STRESS_MULTIPLIER) / input.stopDistance;
  const slippageStressR = (pip * PROBATION_SLIPPAGE_STRESS_PIPS) / input.stopDistance;
  const costR = input.feeP90R + spreadStressR + slippageStressR;
  if (
    ![spreadStressR, slippageStressR, costR].every((value) => Number.isFinite(value) && value >= 0)
  ) {
    return { ...result, state: 'INVALID_GEOMETRY' };
  }
  return {
    ...result,
    state: 'ESTIMABLE_STRESS_ONLY',
    spreadStressR: round(spreadStressR),
    slippageStressR: round(slippageStressR),
    totalStressCostR: round(costR),
    stressedCostAdjustedR: round(input.grossR - costR),
  };
}
