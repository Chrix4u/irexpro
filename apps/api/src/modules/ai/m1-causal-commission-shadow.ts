import { ENSEMBLE_COST_MODEL_VERSION } from './ensemble-governance';

export const M1_CAUSAL_COMMISSION_SHADOW_ARTIFACT = 'm1-causal-commission-shadow-v1';
export const M1_CAUSAL_COMMISSION_MIN_PRIOR_TRADES = 5;
export const M1_CAUSAL_COMMISSION_PERCENTILE = 0.9;

export interface M1CausalCommissionEvidence {
  /** Completed broker trades observed before the current decision; never future fills. */
  sampleCount: number;
  p90FeeR: number | null;
}

export interface M1CausalCommissionShadow {
  artifact: typeof M1_CAUSAL_COMMISSION_SHADOW_ARTIFACT;
  mode: 'SHADOW_ONLY';
  noTradeAuthority: true;
  modifiesExecution: false;
  source: 'SAME_DEMO_CONNECTION_SYMBOL_CURRENCY_PRIOR_CLOSED_TRADES';
  costModelVersion: typeof ENSEMBLE_COST_MODEL_VERSION;
  observedAt: string;
  reason:
    | 'CAUSAL_FEE_EVIDENCE_READY'
    | 'INSUFFICIENT_PRIOR_CLOSED_TRADES'
    | 'INVALID_FEE_EVIDENCE'
    | 'FEE_LOOKUP_UNAVAILABLE'
    | 'INVALID_SPREAD_ONLY_EXPECTANCY';
  sampleCount: number;
  percentile: typeof M1_CAUSAL_COMMISSION_PERCENTILE;
  minimumSamples: typeof M1_CAUSAL_COMMISSION_MIN_PRIOR_TRADES;
  spreadOnlyCostR: number | null;
  originalNetExpectedR: number | null;
  p90AdditionalCommissionAndAdverseFinancingR: number | null;
  estimatedNetAfterFeeR: number | null;
  /** Research hypothesis only; never an order-admission flag. */
  hypotheticalNetFloorPassed: boolean | null;
}

function finite(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function rounded(value: number): number {
  return Number(value.toFixed(6));
}

/**
 * Deliberately additive: the current governance v5 cost formula is
 * (1.25 × observed spread)/stop distance and does not include commission.
 *
 * No trade gate or broker adapter reads this diagnostic. Historical risk
 * normalisation is approximate; a broker-executable model must separately
 * validate per-lot size, account-currency conversion and stop geometry.
 */
export function evaluateM1CausalCommissionShadow(input: {
  observedAt: Date;
  originalNetExpectedR: number;
  spreadOnlyCostR: number;
  minimumRequiredNetR: number;
  evidence: M1CausalCommissionEvidence | null;
  lookupFailed?: boolean;
}): M1CausalCommissionShadow {
  const baseline = finite(input.originalNetExpectedR);
  const spread = finite(input.spreadOnlyCostR);
  const minimumNet = finite(input.minimumRequiredNetR);
  const count = Math.max(0, Math.floor(finite(input.evidence?.sampleCount) ?? 0));
  const p90 = finite(input.evidence?.p90FeeR);
  const validInputs =
    Number.isFinite(input.observedAt.getTime()) &&
    baseline !== null &&
    spread !== null &&
    spread >= 0 &&
    minimumNet !== null &&
    minimumNet >= 0;
  const reason: M1CausalCommissionShadow['reason'] = !validInputs
    ? 'INVALID_SPREAD_ONLY_EXPECTANCY'
    : input.lookupFailed
      ? 'FEE_LOOKUP_UNAVAILABLE'
      : count < M1_CAUSAL_COMMISSION_MIN_PRIOR_TRADES
        ? 'INSUFFICIENT_PRIOR_CLOSED_TRADES'
        : p90 === null || p90 < 0
          ? 'INVALID_FEE_EVIDENCE'
          : 'CAUSAL_FEE_EVIDENCE_READY';
  const ready = reason === 'CAUSAL_FEE_EVIDENCE_READY';
  const adjustedNet = ready ? rounded(baseline! - p90!) : null;
  return {
    artifact: M1_CAUSAL_COMMISSION_SHADOW_ARTIFACT,
    mode: 'SHADOW_ONLY',
    noTradeAuthority: true,
    modifiesExecution: false,
    source: 'SAME_DEMO_CONNECTION_SYMBOL_CURRENCY_PRIOR_CLOSED_TRADES',
    costModelVersion: ENSEMBLE_COST_MODEL_VERSION,
    observedAt: Number.isFinite(input.observedAt.getTime())
      ? input.observedAt.toISOString()
      : 'INVALID_DECISION_TIME',
    reason,
    sampleCount: count,
    percentile: M1_CAUSAL_COMMISSION_PERCENTILE,
    minimumSamples: M1_CAUSAL_COMMISSION_MIN_PRIOR_TRADES,
    spreadOnlyCostR: spread !== null && spread >= 0 ? rounded(spread) : null,
    originalNetExpectedR: baseline === null ? null : rounded(baseline),
    p90AdditionalCommissionAndAdverseFinancingR: ready ? rounded(p90!) : null,
    estimatedNetAfterFeeR: adjustedNet,
    hypotheticalNetFloorPassed: adjustedNet === null ? null : adjustedNet >= minimumNet!,
  };
}
