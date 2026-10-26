export const PAPER_SCOUT_REALISED_PAYOFF_ARTIFACT = 'paper-scout-realised-payoff-v1';
export const PAPER_SCOUT_REALISED_PAYOFF_MIN_TRADES = 6;
export const PAPER_SCOUT_REALISED_PAYOFF_REDUCE_PF = 1.0;
export const PAPER_SCOUT_REALISED_PAYOFF_SHADOW_PF = 0.75;
export const PAPER_SCOUT_REALISED_PAYOFF_REDUCED_LOT_CAP = 0.05;

export interface PaperScoutRealisedPayoffEvidence {
  closedTrades: number;
  grossProfit: number;
  grossLoss: number;
  netPnl: number;
}

export type PaperScoutRealisedPayoffState =
  | 'COLLECTING'
  | 'HEALTHY'
  | 'REDUCED'
  | 'SHADOW_ONLY';

export interface PaperScoutRealisedPayoffDecision {
  artifact: typeof PAPER_SCOUT_REALISED_PAYOFF_ARTIFACT;
  state: PaperScoutRealisedPayoffState;
  executionAuthority: 'PAPER' | 'SHADOW_ONLY';
  maxLotCap: number | null;
  closedTrades: number;
  grossProfit: number;
  grossLoss: number;
  netPnl: number;
  profitFactor: number | null;
  reason:
    | 'INSUFFICIENT_SCOUT_REALISED_EVIDENCE'
    | 'SCOUT_REALISED_PAYOFF_HEALTHY'
    | 'SCOUT_REALISED_PAYOFF_MARGINAL'
    | 'SCOUT_REALISED_PAYOFF_NEGATIVE';
}

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

export function evaluatePaperScoutRealisedPayoff(
  input: PaperScoutRealisedPayoffEvidence,
): PaperScoutRealisedPayoffDecision {
  const closedTrades = Number.isFinite(input.closedTrades)
    ? Math.max(0, Math.trunc(input.closedTrades))
    : 0;
  const grossProfit = finiteNonNegative(input.grossProfit);
  const grossLoss = finiteNonNegative(input.grossLoss);
  const netPnl = Number.isFinite(input.netPnl) ? input.netPnl : grossProfit - grossLoss;
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : null;
  const base = {
    artifact: PAPER_SCOUT_REALISED_PAYOFF_ARTIFACT,
    closedTrades,
    grossProfit,
    grossLoss,
    netPnl,
    profitFactor,
  } as const;

  if (closedTrades < PAPER_SCOUT_REALISED_PAYOFF_MIN_TRADES) {
    return {
      ...base,
      state: 'COLLECTING',
      executionAuthority: 'PAPER',
      maxLotCap: null,
      reason: 'INSUFFICIENT_SCOUT_REALISED_EVIDENCE',
    };
  }

  if (
    netPnl < 0 &&
    profitFactor !== null &&
    profitFactor < PAPER_SCOUT_REALISED_PAYOFF_SHADOW_PF
  ) {
    return {
      ...base,
      state: 'SHADOW_ONLY',
      executionAuthority: 'SHADOW_ONLY',
      maxLotCap: 0,
      reason: 'SCOUT_REALISED_PAYOFF_NEGATIVE',
    };
  }

  if (
    netPnl < 0 &&
    profitFactor !== null &&
    profitFactor < PAPER_SCOUT_REALISED_PAYOFF_REDUCE_PF
  ) {
    return {
      ...base,
      state: 'REDUCED',
      executionAuthority: 'PAPER',
      maxLotCap: PAPER_SCOUT_REALISED_PAYOFF_REDUCED_LOT_CAP,
      reason: 'SCOUT_REALISED_PAYOFF_MARGINAL',
    };
  }

  return {
    ...base,
    state: 'HEALTHY',
    executionAuthority: 'PAPER',
    maxLotCap: null,
    reason: 'SCOUT_REALISED_PAYOFF_HEALTHY',
  };
}
