import {
  M1_CAUSAL_COMMISSION_MIN_PRIOR_TRADES,
  M1_CAUSAL_COMMISSION_PERCENTILE,
  type M1CausalCommissionEvidence,
} from './m1-causal-commission-shadow';
import {
  ENSEMBLE_EARLY_TRANSITION_PAPER_NET_EXPECTED_R_FLOOR,
  ENSEMBLE_NET_EXPECTED_R_FLOOR,
} from './ensemble-governance';

export const DEMO_BROKER_COMMISSION_ENTRY_GATE_ARTIFACT = 'demo-broker-commission-entry-gate-v1';
export type DemoBrokerCommissionEntryGateReason =
  | 'NOT_ENABLED'
  | 'NOT_PRIMARY_PLAN_B'
  | 'FEE_LOOKUP_UNAVAILABLE'
  | 'INSUFFICIENT_SAME_ACCOUNT_PRIOR_FILLS'
  | 'INVALID_BROKER_FEE_EVIDENCE'
  | 'INVALID_PRE_FEE_EXPECTANCY'
  | 'AFTER_BROKER_FEES_BELOW_FLOOR'
  | 'AFTER_BROKER_FEES_ELIGIBLE';

/** A one-way veto for an already-qualified primary DEMO candidate. No independent authority. */
export interface DemoBrokerCommissionEntryGateDecision {
  artifact: typeof DEMO_BROKER_COMMISSION_ENTRY_GATE_ARTIFACT;
  source: 'SAME_DEMO_USER_CONNECTION_PAIR_CURRENCY_PRIOR_CLOSED_FILLS';
  enabled: boolean;
  selectedPrimary: boolean;
  blocked: boolean;
  reason: DemoBrokerCommissionEntryGateReason;
  sampleCount: number;
  minimumSamples: typeof M1_CAUSAL_COMMISSION_MIN_PRIOR_TRADES;
  percentile: typeof M1_CAUSAL_COMMISSION_PERCENTILE;
  preFeeNetExpectedR: number | null;
  brokerFeeP90R: number | null;
  afterFeeExpectedR: number | null;
  minimumAfterFeeR: number;
  grantsExecution: false;
  modifiesOpenPositions: false;
}

const finite = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

export function evaluateDemoBrokerCommissionEntryGate(input: {
  enabled: boolean;
  selectedPrimary: boolean;
  preFeeNetExpectedR: number | null;
  strategyRoute: 'EARLY_TRANSITION' | 'TREND_CONTINUATION' | 'CONFIRMED_REVERSAL' | null;
  evidence: M1CausalCommissionEvidence | null;
  lookupFailed?: boolean;
}): DemoBrokerCommissionEntryGateDecision {
  const n = input.evidence?.sampleCount;
  const sampleCount = Number.isInteger(n) && n! >= 0 ? n! : 0;
  const feeR = finite(input.evidence?.p90FeeR);
  const preFeeR = finite(input.preFeeNetExpectedR);
  const floor =
    input.strategyRoute === 'EARLY_TRANSITION'
      ? ENSEMBLE_EARLY_TRANSITION_PAPER_NET_EXPECTED_R_FLOOR
      : ENSEMBLE_NET_EXPECTED_R_FLOOR;
  const reason: DemoBrokerCommissionEntryGateReason = !input.enabled
    ? 'NOT_ENABLED'
    : !input.selectedPrimary
      ? 'NOT_PRIMARY_PLAN_B'
      : input.lookupFailed
        ? 'FEE_LOOKUP_UNAVAILABLE'
        : sampleCount < M1_CAUSAL_COMMISSION_MIN_PRIOR_TRADES
          ? 'INSUFFICIENT_SAME_ACCOUNT_PRIOR_FILLS'
          : feeR === null || feeR < 0
            ? 'INVALID_BROKER_FEE_EVIDENCE'
            : preFeeR === null || input.strategyRoute === null
              ? 'INVALID_PRE_FEE_EXPECTANCY'
              : preFeeR - feeR < floor
                ? 'AFTER_BROKER_FEES_BELOW_FLOOR'
                : 'AFTER_BROKER_FEES_ELIGIBLE';
  const measured =
    sampleCount >= M1_CAUSAL_COMMISSION_MIN_PRIOR_TRADES &&
    feeR !== null &&
    feeR >= 0 &&
    preFeeR !== null &&
    input.strategyRoute !== null;
  return {
    artifact: DEMO_BROKER_COMMISSION_ENTRY_GATE_ARTIFACT,
    source: 'SAME_DEMO_USER_CONNECTION_PAIR_CURRENCY_PRIOR_CLOSED_FILLS',
    enabled: input.enabled,
    selectedPrimary: input.selectedPrimary,
    blocked: input.enabled && input.selectedPrimary && reason !== 'AFTER_BROKER_FEES_ELIGIBLE',
    reason,
    sampleCount,
    minimumSamples: M1_CAUSAL_COMMISSION_MIN_PRIOR_TRADES,
    percentile: M1_CAUSAL_COMMISSION_PERCENTILE,
    preFeeNetExpectedR: preFeeR,
    brokerFeeP90R: measured ? feeR : null,
    afterFeeExpectedR: measured ? Number((preFeeR! - feeR!).toFixed(6)) : null,
    minimumAfterFeeR: floor,
    grantsExecution: false,
    modifiesOpenPositions: false,
  };
}
