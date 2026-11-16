/**
 * Prospective, research-only Pepperstone cTrader DEMO pair/side assessment.
 *
 * The result is written into existing M1 decision governance and MUST NOT
 * influence canExecute, broker authority, position sizing or model promotion.
 * As-of checks are repeated in this pure function to guard against future
 * rows, even when the SQL reader is time-bounded.
 */
export const PEPPERSTONE_PAIR_SIDE_ASOF_SHADOW_ARTIFACT =
  'pepperstone-pair-side-asof-entry-quality-shadow-v1' as const;

export interface PepperstonePairSideAsOfRow {
  closedAt: Date | string;
  netPnl: string | number | null;
  riskAtStop: string | number | null;
}

export type PepperstonePairSideAsOfState =
  | 'UNKNOWN'
  | 'SUPPORTIVE_HISTORICAL_EDGE'
  | 'EDGE_NOT_ESTABLISHED';

export interface PepperstonePairSideAsOfShadowDecision {
  artifact: typeof PEPPERSTONE_PAIR_SIDE_ASOF_SHADOW_ARTIFACT;
  mode: 'RESEARCH_ONLY';
  modifiesExecution: false;
  grantsExecution: false;
  entryVeto: false;
  asOf: string;
  historyClosedTrades: number;
  pricedTrades: number;
  distinctClosingDays: number;
  consecutiveNetLosses: number | null;
  threeLossStreakCaution: boolean | null;
  winRate: number | null;
  profitFactor: number | null;
  meanNetR: number | null;
  state: PepperstonePairSideAsOfState;
  reason:
    | 'INSUFFICIENT_INDEPENDENT_HISTORY'
    | 'INCOMPLETE_PRIOR_BROKER_FEES_OR_RISK'
    | 'HISTORICAL_EDGE_SUPPORTED'
    | 'HISTORICAL_EDGE_NOT_ESTABLISHED'
    | 'HISTORY_LOOKUP_FAILED'
    | 'INVALID_EVALUATION_TIME';
}

function finite(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function rounded(value: number, digits = 4): number {
  return Number(value.toFixed(digits));
}

export function evaluatePepperstonePairSideAsOfShadow(
  rows: readonly PepperstonePairSideAsOfRow[],
  asOf: Date,
): PepperstonePairSideAsOfShadowDecision {
  const at = asOf.getTime();
  const validTime = Number.isFinite(at);
  const result = (overrides: Partial<PepperstonePairSideAsOfShadowDecision>):
    PepperstonePairSideAsOfShadowDecision => ({
      artifact: PEPPERSTONE_PAIR_SIDE_ASOF_SHADOW_ARTIFACT,
      mode: 'RESEARCH_ONLY',
      modifiesExecution: false,
      grantsExecution: false,
      entryVeto: false,
      asOf: validTime ? asOf.toISOString() : 'INVALID',
      historyClosedTrades: 0,
      pricedTrades: 0,
      distinctClosingDays: 0,
      consecutiveNetLosses: null,
      threeLossStreakCaution: null,
      winRate: null,
      profitFactor: null,
      meanNetR: null,
      state: 'UNKNOWN',
      reason: 'INSUFFICIENT_INDEPENDENT_HISTORY',
      ...overrides,
    });
  if (!validTime) return result({ reason: 'INVALID_EVALUATION_TIME' });
  const start = at - 14 * 86_400_000;
  const prior = rows
    .map((row) => ({
      closedAt: new Date(row.closedAt).getTime(),
      net: finite(row.netPnl),
      risk: finite(row.riskAtStop),
    }))
    // Exclude any future, same-timestamp, or out-of-window trade.
    .filter((row) =>
      Number.isFinite(row.closedAt) && row.closedAt < at && row.closedAt >= start)
    .sort((a, b) => a.closedAt - b.closedAt);
  const incomplete = prior.some(row => row.net === null || row.risk === null || row.risk <= 0);
  const priced = prior.filter(
    (row): row is { closedAt: number; net: number; risk: number } =>
      row.net !== null && row.risk !== null && row.risk > 0
  );
  const n = priced.length;
  const days = new Set(
    priced.map(row => new Date(row.closedAt).toISOString().slice(0, 10)),
  ).size;
  // A single incomplete newer trade breaks the ability to prove the current
  // loss-streak and the broader edge: never skip it and infer a clean history.
  let losses = 0;
  if (!incomplete) {
    for (let i = priced.length - 1; i >= 0; i--) {
      if (priced[i].net >= 0) break;
      losses++;
    }
  }
  const positive = priced.filter(row => row.net > 0);
  const negative = priced.filter(row => row.net < 0);
  const profit = positive.reduce((sum, row) => sum + row.net, 0);
  const loss = -negative.reduce((sum, row) => sum + row.net, 0);
  const pf = loss > 0 ? profit / loss : profit > 0 ? null : 0;
  const meanNetR = n
    ? priced.reduce((sum, row) => sum + row.net / row.risk, 0) / n
    : null;
  const hasHistory = n >= 8 && days >= 3;
  const supported = hasHistory && !incomplete && pf !== null &&
    pf >= 1.25 && positive.length / n >= 0.55 &&
    meanNetR !== null && meanNetR > 0.1;
  return result({
    historyClosedTrades: prior.length,
    pricedTrades: n,
    distinctClosingDays: days,
    consecutiveNetLosses: incomplete ? null : losses,
    threeLossStreakCaution: incomplete ? null : losses >= 3,
    winRate: n ? rounded(positive.length / n) : null,
    profitFactor: pf === null ? null : rounded(pf, 3),
    meanNetR: meanNetR === null ? null : rounded(meanNetR, 3),
    state: incomplete || !hasHistory ? 'UNKNOWN' :
      supported ? 'SUPPORTIVE_HISTORICAL_EDGE' : 'EDGE_NOT_ESTABLISHED',
    reason: incomplete ? 'INCOMPLETE_PRIOR_BROKER_FEES_OR_RISK' :
      !hasHistory ? 'INSUFFICIENT_INDEPENDENT_HISTORY' :
      supported ? 'HISTORICAL_EDGE_SUPPORTED' : 'HISTORICAL_EDGE_NOT_ESTABLISHED',
  });
}
