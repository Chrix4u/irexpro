/**
 * z.ai P1: research preflight for a DEMO-only confirmed-reversal partial exit.
 * This is an as-of-profit-protection observation, never a broker command.
 * Current execution aggregate models CLOSE_POSITION as full, terminal CLOSE;
 * do not permit half-close orders until a durable partial-fill ledger,
 * accounting and reconciliation are certified end to end.
 */
export const ZAI_P1_REVERSAL_DEMO_PREFLIGHT_ARTIFACT = 'zai-p1-reversal-demo-preflight-v1' as const;

export type ZaiP1DemoCandidateReason =
  | 'NOT_CTRADER_DEMO'
  | 'NOT_CONFIRMED_REVERSAL'
  | 'TREND_RECHECK_FAILED'
  | 'NO_VERIFIED_BROKER_FEE_ESTIMATE'
  | 'INVALID_ENTRY_OR_BARRIERS'
  | 'NOT_POSITIVE_AFTER_COST'
  | 'PROVIDER_LOT_SPLIT_UNSUPPORTED'
  | 'PARTIAL_EXECUTION_LIFECYCLE_UNCERTIFIED';

export interface ZaiP1ReversalDemoPreflightInput {
  brokerId: string;
  accountType: string;
  strategyRoute: string | null;
  confirmedFreshTrend: boolean;
  direction: 'BUY' | 'SELL';
  initialLot: string | number | null;
  initialRiskPnl: number;
  currentGrossPnl: number;
  estimateRoundTripFee: number | null;
  historicalFeeSamples: number;
  entryPrice: number | null;
  currentPrice: number | null;
  originalStopPrice: number | null;
  originalTakeProfitPrice: number | null;
}

export interface ZaiP1ReversalDemoPreflightDecision {
  artifact: typeof ZAI_P1_REVERSAL_DEMO_PREFLIGHT_ARTIFACT;
  mode: 'DEMO_RESEARCH_ONLY';
  researchEligible: boolean;
  reason: ZaiP1DemoCandidateReason;
  partialCloseLots: string | null;
  runnerLots: string | null;
  runnerOriginalStopPreserved: true;
  runnerOriginalTakeProfitPreserved: true;
  estimatedCurrentNetR: number | null;
  canSendPartialClose: false;
  canModifyOrder: false;
  modifiesExecution: false;
}

/** Deterministic decimal-4 split; never round to a larger/smaller position. */
export function exactHalfLotSplit(
  lot: string | number | null,
): { half: string; runner: string } | null {
  const raw = String(lot ?? '');
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,4})?$/.test(raw)) return null;
  const [major = '0', fractional = ''] = raw.split('.');
  const lotTenThousandths = Number(major) * 10_000 + Number(fractional.padEnd(4, '0'));
  if (!Number.isSafeInteger(lotTenThousandths) || lotTenThousandths < 200) return null;
  if (lotTenThousandths % 200 !== 0) return null; // each half must be 0.01-lot multiple
  const half = lotTenThousandths / 2;
  if (half < 100) return null;
  const shown = (n: number) => (n / 10_000).toFixed(4);
  return { half: shown(half), runner: shown(half) };
}

export function evaluateZaiP1ReversalDemoPreflight(
  input: ZaiP1ReversalDemoPreflightInput,
): ZaiP1ReversalDemoPreflightDecision {
  const base = (
    reason: ZaiP1DemoCandidateReason,
    split: ReturnType<typeof exactHalfLotSplit> = null,
    estimatedCurrentNetR: number | null = null,
  ): ZaiP1ReversalDemoPreflightDecision => ({
    artifact: ZAI_P1_REVERSAL_DEMO_PREFLIGHT_ARTIFACT,
    mode: 'DEMO_RESEARCH_ONLY',
    researchEligible: reason === 'PARTIAL_EXECUTION_LIFECYCLE_UNCERTIFIED',
    reason,
    partialCloseLots: split?.half ?? null,
    runnerLots: split?.runner ?? null,
    runnerOriginalStopPreserved: true,
    runnerOriginalTakeProfitPreserved: true,
    estimatedCurrentNetR,
    canSendPartialClose: false,
    canModifyOrder: false,
    modifiesExecution: false,
  });
  if (input.brokerId.toLowerCase() !== 'ctrader' || input.accountType.toUpperCase() !== 'DEMO') {
    return base('NOT_CTRADER_DEMO');
  }
  if (input.strategyRoute !== 'CONFIRMED_REVERSAL') return base('NOT_CONFIRMED_REVERSAL');
  if (!input.confirmedFreshTrend) return base('TREND_RECHECK_FAILED');
  if (
    !Number.isFinite(input.estimateRoundTripFee) ||
    input.estimateRoundTripFee === null ||
    input.estimateRoundTripFee < 0 ||
    input.historicalFeeSamples < 5
  ) {
    return base('NO_VERIFIED_BROKER_FEE_ESTIMATE');
  }
  const directionSign = input.direction === 'BUY' ? 1 : -1;
  const entry = input.entryPrice;
  const current = input.currentPrice;
  const sl = input.originalStopPrice;
  const tp = input.originalTakeProfitPrice;
  if (
    [input.initialRiskPnl, input.currentGrossPnl, entry, current, sl, tp].some(
      (n) => typeof n !== 'number' || !Number.isFinite(n),
    ) ||
    input.initialRiskPnl <= 0 ||
    entry === null ||
    current === null ||
    sl === null ||
    tp === null ||
    Math.min(entry, current, sl, tp) <= 0 ||
    directionSign * (entry - sl) <= 0 ||
    directionSign * (tp - entry) <= 0 ||
    directionSign * (current - entry) <= 0 ||
    directionSign * (tp - current) <= 0
  ) {
    return base('INVALID_ENTRY_OR_BARRIERS');
  }
  const netR = (input.currentGrossPnl - input.estimateRoundTripFee) / input.initialRiskPnl;
  if (netR <= 0.1) return base('NOT_POSITIVE_AFTER_COST', null, Number(netR.toFixed(6)));
  const split = exactHalfLotSplit(input.initialLot);
  if (!split) return base('PROVIDER_LOT_SPLIT_UNSUPPORTED', null, Number(netR.toFixed(6)));
  // Historical policy improvement is conditional on already profit-protected trades.
  // Future accounting/reconciliation must be broker-confirmed for both legs.
  return base('PARTIAL_EXECUTION_LIFECYCLE_UNCERTIFIED', split, Number(netR.toFixed(6)));
}
