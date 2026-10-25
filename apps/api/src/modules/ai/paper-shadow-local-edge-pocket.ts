export const PAPER_SHADOW_LOCAL_EDGE_POCKET_ARTIFACT = 'paper-shadow-local-edge-pocket-v1';
export const PAPER_SHADOW_LOCAL_EDGE_MIN_SAMPLES = 20;
export const PAPER_SHADOW_LOCAL_EDGE_MIN_PROFIT_FACTOR = 1.2;
export const PAPER_SHADOW_LOCAL_EDGE_MIN_AVERAGE_R = 0.1;
export const PAPER_SHADOW_LOCAL_EDGE_RECENT_WINDOW = 8;
export const PAPER_SHADOW_LOCAL_EDGE_MIN_RECENT_WINS = 5;

export interface PaperShadowLocalEdgePocketEvidence {
  samples: number;
  wins: number;
  losses: number;
  grossProfitR: number;
  grossLossR: number;
  netR: number;
  averageNetR: number;
  profitFactor: number;
  recentSamples: number;
  recentWins: number;
  recentNetR: number;
  latestResolvedAt: string | null;
}

export type PaperShadowLocalEdgePocketState =
  | 'UNAVAILABLE'
  | 'COLLECTING'
  | 'WEAK'
  | 'DEGRADED'
  | 'SUPPORTED';

export type PaperShadowLocalEdgePocketReason =
  | 'LOCAL_EDGE_EVIDENCE_INVALID'
  | 'INSUFFICIENT_LOCAL_EDGE_SAMPLES'
  | 'LOCAL_EDGE_PROFIT_FACTOR_TOO_LOW'
  | 'LOCAL_EDGE_AVERAGE_R_TOO_LOW'
  | 'LOCAL_EDGE_RECENT_EVIDENCE_INSUFFICIENT'
  | 'LOCAL_EDGE_RECENT_DEGRADATION'
  | 'LOCAL_EDGE_POCKET_SUPPORTED';

export interface PaperShadowLocalEdgePocketDecision
  extends PaperShadowLocalEdgePocketEvidence {
  artifact: typeof PAPER_SHADOW_LOCAL_EDGE_POCKET_ARTIFACT;
  state: PaperShadowLocalEdgePocketState;
  reason: PaperShadowLocalEdgePocketReason;
  supported: boolean;
  winRate: number;
}

function finite(value: number): boolean {
  return Number.isFinite(value);
}

function base(
  evidence: PaperShadowLocalEdgePocketEvidence,
): Omit<PaperShadowLocalEdgePocketDecision, 'state' | 'reason' | 'supported'> {
  return {
    artifact: PAPER_SHADOW_LOCAL_EDGE_POCKET_ARTIFACT,
    ...evidence,
    winRate: evidence.samples > 0 ? evidence.wins / evidence.samples : 0,
  };
}

export function evaluatePaperShadowLocalEdgePocket(
  evidence: PaperShadowLocalEdgePocketEvidence,
): PaperShadowLocalEdgePocketDecision {
  const metrics = [
    evidence.samples,
    evidence.wins,
    evidence.losses,
    evidence.grossProfitR,
    evidence.grossLossR,
    evidence.netR,
    evidence.averageNetR,
    evidence.profitFactor,
    evidence.recentSamples,
    evidence.recentWins,
    evidence.recentNetR,
  ];
  const common = base(evidence);
  if (
    metrics.some((value) => !finite(value)) ||
    evidence.samples < 0 ||
    evidence.wins < 0 ||
    evidence.losses < 0 ||
    evidence.recentSamples < 0 ||
    evidence.recentWins < 0 ||
    evidence.wins + evidence.losses > evidence.samples ||
    evidence.recentWins > evidence.recentSamples
  ) {
    return {
      ...common,
      state: 'UNAVAILABLE',
      reason: 'LOCAL_EDGE_EVIDENCE_INVALID',
      supported: false,
    };
  }
  if (evidence.samples < PAPER_SHADOW_LOCAL_EDGE_MIN_SAMPLES) {
    return {
      ...common,
      state: 'COLLECTING',
      reason: 'INSUFFICIENT_LOCAL_EDGE_SAMPLES',
      supported: false,
    };
  }
  if (evidence.profitFactor < PAPER_SHADOW_LOCAL_EDGE_MIN_PROFIT_FACTOR) {
    return {
      ...common,
      state: 'WEAK',
      reason: 'LOCAL_EDGE_PROFIT_FACTOR_TOO_LOW',
      supported: false,
    };
  }
  if (evidence.averageNetR < PAPER_SHADOW_LOCAL_EDGE_MIN_AVERAGE_R) {
    return {
      ...common,
      state: 'WEAK',
      reason: 'LOCAL_EDGE_AVERAGE_R_TOO_LOW',
      supported: false,
    };
  }
  if (evidence.recentSamples < PAPER_SHADOW_LOCAL_EDGE_RECENT_WINDOW) {
    return {
      ...common,
      state: 'COLLECTING',
      reason: 'LOCAL_EDGE_RECENT_EVIDENCE_INSUFFICIENT',
      supported: false,
    };
  }
  if (
    evidence.recentWins < PAPER_SHADOW_LOCAL_EDGE_MIN_RECENT_WINS ||
    evidence.recentNetR <= 0
  ) {
    return {
      ...common,
      state: 'DEGRADED',
      reason: 'LOCAL_EDGE_RECENT_DEGRADATION',
      supported: false,
    };
  }
  return {
    ...common,
    state: 'SUPPORTED',
    reason: 'LOCAL_EDGE_POCKET_SUPPORTED',
    supported: true,
  };
}
