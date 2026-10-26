export const PAPER_CHAMPION_DIRECTION_PRIOR_ARTIFACT = 'paper-champion-direction-prior-v1';
export const PAPER_CHAMPION_DIRECTION_PRIOR_MIN_TRADES = 8;
export const PAPER_CHAMPION_DIRECTION_PRIOR_MIN_PROFIT_FACTOR = 1.15;

export interface PaperChampionDirectionEvidence {
  trades: number;
  grossProfit: number;
  grossLoss: number;
  netPnl: number;
}

export interface PaperChampionDirectionPriorInput {
  instrument: string;
  direction: 'BUY' | 'SELL';
  evidence?: PaperChampionDirectionEvidence | null;
}

export type PaperChampionDirectionPriorReason =
  | 'CHAMPION_DIRECTION_SUPPORTED'
  | 'INSUFFICIENT_CHAMPION_DIRECTION_EVIDENCE'
  | 'CHAMPION_DIRECTION_NET_PNL_NOT_POSITIVE'
  | 'CHAMPION_DIRECTION_PROFIT_FACTOR_TOO_LOW'
  | 'CHAMPION_DIRECTION_EVIDENCE_INVALID';

export interface PaperChampionDirectionPriorDecision {
  artifact: typeof PAPER_CHAMPION_DIRECTION_PRIOR_ARTIFACT;
  instrument: string;
  direction: 'BUY' | 'SELL';
  supported: boolean;
  reason: PaperChampionDirectionPriorReason;
  trades: number;
  profitFactor: number | null;
  netPnl: number;
}

export function evaluatePaperChampionDirectionPrior(
  input: PaperChampionDirectionPriorInput,
): PaperChampionDirectionPriorDecision {
  const evidence = input.evidence ?? null;
  const valid =
    evidence != null &&
    Number.isFinite(evidence.trades) &&
    Number.isFinite(evidence.grossProfit) &&
    Number.isFinite(evidence.grossLoss) &&
    Number.isFinite(evidence.netPnl) &&
    evidence.trades >= 0 &&
    evidence.grossProfit >= 0 &&
    evidence.grossLoss >= 0;
  const trades = valid ? Math.max(0, Math.trunc(evidence!.trades)) : 0;
  const netPnl = valid ? evidence!.netPnl : 0;
  const profitFactor =
    valid && evidence!.grossLoss > 0 ? evidence!.grossProfit / evidence!.grossLoss : null;
  const base = {
    artifact: PAPER_CHAMPION_DIRECTION_PRIOR_ARTIFACT,
    instrument: input.instrument.trim().toUpperCase(),
    direction: input.direction,
    trades,
    profitFactor,
    netPnl,
  } as const;

  if (!valid) {
    return { ...base, supported: false, reason: 'CHAMPION_DIRECTION_EVIDENCE_INVALID' };
  }
  if (trades < PAPER_CHAMPION_DIRECTION_PRIOR_MIN_TRADES) {
    return {
      ...base,
      supported: false,
      reason: 'INSUFFICIENT_CHAMPION_DIRECTION_EVIDENCE',
    };
  }
  if (netPnl <= 0) {
    return {
      ...base,
      supported: false,
      reason: 'CHAMPION_DIRECTION_NET_PNL_NOT_POSITIVE',
    };
  }
  if (
    profitFactor !== null &&
    (!Number.isFinite(profitFactor) ||
      profitFactor < PAPER_CHAMPION_DIRECTION_PRIOR_MIN_PROFIT_FACTOR)
  ) {
    return {
      ...base,
      supported: false,
      reason: 'CHAMPION_DIRECTION_PROFIT_FACTOR_TOO_LOW',
    };
  }
  return { ...base, supported: true, reason: 'CHAMPION_DIRECTION_SUPPORTED' };
}

export const PAPER_CHAMPION_DIRECTION_RISK_CAP_ARTIFACT =
  'paper-champion-direction-risk-cap-v1' as const;
export const PAPER_CHAMPION_DIRECTION_WEAK_RISK_MULTIPLIER_CAP = 0.5;

export type PaperChampionDirectionRiskCapReason =
  | 'NON_NORMAL_PAPER_ROUTE'
  | 'CHAMPION_DIRECTION_PRIOR_UNAVAILABLE'
  | 'CHAMPION_DIRECTION_NOT_MATURE'
  | 'CHAMPION_DIRECTION_SUPPORTED'
  | 'MATURE_CHAMPION_DIRECTION_WEAK'
  | 'CHAMPION_DIRECTION_EVIDENCE_INVALID';

export interface PaperChampionDirectionRiskCapDecision {
  artifact: typeof PAPER_CHAMPION_DIRECTION_RISK_CAP_ARTIFACT;
  active: boolean;
  reason: PaperChampionDirectionRiskCapReason;
  multiplierCap: number | null;
  rawMultiplier: number;
  effectiveMultiplier: number;
  priorReason: PaperChampionDirectionPriorReason | null;
  trades: number;
  profitFactor: number | null;
  netPnl: number;
}

export function applyPaperChampionDirectionRiskCap(input: {
  executionRoute: string;
  rawMultiplier: number;
  prior?: PaperChampionDirectionPriorDecision | null;
}): PaperChampionDirectionRiskCapDecision {
  const prior = input.prior ?? null;
  const base = {
    artifact: PAPER_CHAMPION_DIRECTION_RISK_CAP_ARTIFACT,
    active: false,
    multiplierCap: null,
    rawMultiplier: input.rawMultiplier,
    effectiveMultiplier: input.rawMultiplier,
    priorReason: prior?.reason ?? null,
    trades: prior?.trades ?? 0,
    profitFactor: prior?.profitFactor ?? null,
    netPnl: prior?.netPnl ?? 0,
  } as const;

  if (input.executionRoute !== 'NORMAL_PAPER') {
    return { ...base, reason: 'NON_NORMAL_PAPER_ROUTE' };
  }
  if (!prior) {
    return { ...base, reason: 'CHAMPION_DIRECTION_PRIOR_UNAVAILABLE' };
  }
  if (prior.reason === 'CHAMPION_DIRECTION_EVIDENCE_INVALID') {
    return { ...base, reason: 'CHAMPION_DIRECTION_EVIDENCE_INVALID' };
  }
  if (prior.trades < PAPER_CHAMPION_DIRECTION_PRIOR_MIN_TRADES) {
    return { ...base, reason: 'CHAMPION_DIRECTION_NOT_MATURE' };
  }
  if (prior.supported) {
    return { ...base, reason: 'CHAMPION_DIRECTION_SUPPORTED' };
  }
  if (
    prior.reason !== 'CHAMPION_DIRECTION_NET_PNL_NOT_POSITIVE' &&
    prior.reason !== 'CHAMPION_DIRECTION_PROFIT_FACTOR_TOO_LOW'
  ) {
    return { ...base, reason: 'CHAMPION_DIRECTION_EVIDENCE_INVALID' };
  }

  const effectiveMultiplier = Math.min(
    input.rawMultiplier,
    PAPER_CHAMPION_DIRECTION_WEAK_RISK_MULTIPLIER_CAP,
  );
  return {
    ...base,
    active: true,
    reason: 'MATURE_CHAMPION_DIRECTION_WEAK',
    multiplierCap: PAPER_CHAMPION_DIRECTION_WEAK_RISK_MULTIPLIER_CAP,
    effectiveMultiplier,
  };
}
