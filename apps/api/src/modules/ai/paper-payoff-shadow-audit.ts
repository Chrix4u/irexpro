import { collapseEnsembleOutcomeEpisodes, EnsembleShadowOutcome } from './ensemble-shadow-outcome';

export type Numeric = number | string | null;
export interface PaperTradeAuditRow {
  instrument: string;
  direction: 'BUY' | 'SELL';
  lotSize: Numeric;
  entryPrice: Numeric;
  stopLoss: Numeric;
  initialStopLoss: Numeric;
  takeProfit: Numeric;
  initialTakeProfit: Numeric;
  exitPrice: Numeric;
  realisedPnl: Numeric;
  accountCurrency: string | null;
  commission: Numeric;
  swap: Numeric;
  trailingStopPips: Numeric;
  filledQuantity: Numeric;
  filledEntryPrice: Numeric;
  positionRecordCount: number;
  hasPartialCloseOrder: boolean;
  executionRoute: string | null;
  research: boolean | null;
  policyVersion: string | null;
  modelVersion: string | null;
  costModelVersion: string | null;
  strategyRoute: string | null;
  closeReason: string | null;
}
export interface PaperRiskResult {
  eligible: boolean;
  skipReason: string | null;
  initialRiskUsd: number | null;
  realisedR: number | null;
  binaryAssumedR: number | null;
  targetR: number | null;
}
export interface ShadowAuditRow {
  instrument: string;
  direction: 'BUY' | 'SELL';
  evaluatedAt: Date | string;
  marketBarTime?: Date | string;
  entryPrice: Numeric;
  stopLoss: Numeric;
  brokerSpreadPrice: Numeric;
  paperSpreadPrice: Numeric;
  policyVersion: string | null;
  modelVersion: string | null;
  costModelVersion: string | null;
  strategyRoute: string | null;
  executionRoute: string;
  outcome: EnsembleShadowOutcome | null;
}
export interface AuditCohort {
  policyVersion: string | null;
  modelVersion: string | null;
  costModelVersion: string | null;
  strategyRoute: string | null;
  executionRoute: string;
  accountCurrency?: string | null;
  outcomeVersion?: string | null;
}
export interface ReturnSummary {
  samples: number;
  meanR: number | null;
  sumR: number | null;
  winRate: number | null;
  profitFactor: number | null;
}
export interface RealisedAuditSummary {
  totals: {
    closedTrades: number;
    pnlReportedTrades: number;
    pnlMissingTrades: number;
    reportedRealisedPnl: number | null;
    wins: number;
    losses: number;
    flat: number;
    winRate: number | null;
    grossPositivePnl: number;
    grossNegativePnl: number;
    profitFactor: number | null;
    closeReasons: Record<string, number>;
  };
  payoff: {
    eligibleTrades: number;
    meanRealisedR: number | null;
    meanBinaryAssumedR: number | null;
    binaryOverstatementR: number | null;
    meanWinningR: number | null;
    meanLosingAbsR: number | null;
    realisedBreakEvenWinRate: number | null;
    winRate: number | null;
    profitFactorR: number | null;
    skipReasons: Record<string, number>;
  };
}
export interface RealisedAuditCohort extends RealisedAuditSummary {
  cohort: AuditCohort;
  pairSides: Array<RealisedAuditSummary & { instrument: string; direction: 'BUY' | 'SELL' }>;
}
export interface ExitPolicyAuditSummary {
  code: string;
  matchedEpisodes: number;
  activatedEpisodes: number;
  exitedEarlyEpisodes: number;
  baselineStoredCost: ReturnSummary;
  policyStoredCost: ReturnSummary;
  baselineEffectiveCost: ReturnSummary;
  policyEffectiveCost: ReturnSummary;
  meanDeltaR: number | null;
  skipReasons: Record<string, number>;
}
export interface ExitShadowAuditCohort {
  cohort: AuditCohort;
  instrument: string;
  direction: 'BUY' | 'SELL';
  rows: number;
  unresolvedRows: number;
  ambiguousRows: number;
  invalidRows: number;
  episodeCount: number;
  overlappingRowsCollapsed: number;
  policies: ExitPolicyAuditSummary[];
}

function numeric(value: Numeric | undefined): number | null {
  if (value == null || (typeof value === 'string' && value.trim() === '')) return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}
function sameNumber(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-8;
}
function mean(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}
function counts(keys: string[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const key of keys) result[key] = (result[key] ?? 0) + 1;
  return result;
}
function grouped<T>(values: T[], key: (value: T) => string): T[][] {
  const groups = new Map<string, T[]>();
  for (const value of values) {
    const groupKey = key(value);
    const group = groups.get(groupKey) ?? [];
    group.push(value);
    groups.set(groupKey, group);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, rows]) => rows);
}
function returns(values: number[]): ReturnSummary {
  const positive = values.filter((value) => value > 0).reduce((a, b) => a + b, 0);
  const negative = -values.filter((value) => value < 0).reduce((a, b) => a + b, 0);
  return {
    samples: values.length,
    meanR: mean(values),
    sumR: values.length ? values.reduce((a, b) => a + b, 0) : null,
    winRate: values.length ? values.filter((value) => value > 0).length / values.length : null,
    profitFactor: negative > 0 ? positive / negative : null,
  };
}

export function classifyPaperRoute(route: string | null, research: boolean | null): string {
  const known = route?.trim().toUpperCase();
  if (research === true && known && known !== 'PAPER_RESEARCH_THROUGHPUT') {
    return 'CONFLICTING_ROUTE';
  }
  if (research === false && known === 'PAPER_RESEARCH_THROUGHPUT') return 'CONFLICTING_ROUTE';
  if (research === true) return 'PAPER_RESEARCH_THROUGHPUT';
  if (
    known === 'NORMAL_PAPER' ||
    known === 'REJECTED_EDGE_CANARY' ||
    known === 'PAPER_RESEARCH_THROUGHPUT'
  )
    return known;
  return 'UNKNOWN_ROUTE';
}

/**
 * Reconstruction, not an invented risk estimate. Intent protective prices are
 * immutable provenance; current prices must agree. Fill quantity/price, unique
 * position identity, no partial-close order and full-size exit P&L must agree.
 * USD-base FX is converted at the stop, matching PAPER's conversion at exit.
 * Cent-rounded realised P&L makes R approximate. Missing/nonzero cost accounting
 * is excluded rather than guessing whether realised_pnl already includes fees.
 */
export function derivePaperInitialRisk(row: PaperTradeAuditRow): PaperRiskResult {
  const skip = (reason: string): PaperRiskResult => ({
    eligible: false,
    skipReason: reason,
    initialRiskUsd: null,
    realisedR: null,
    binaryAssumedR: null,
    targetR: null,
  });
  if (row.accountCurrency !== 'USD') return skip('ACCOUNT_CURRENCY_UNSUPPORTED');
  const symbol = row.instrument.trim().toUpperCase();
  if (
    !/^[A-Z]{6}$/.test(symbol) ||
    (!symbol.endsWith('USD') && !symbol.startsWith('USD')) ||
    symbol === 'USDUSD'
  ) {
    return skip('CONVERSION_UNPROVEN');
  }
  const initialStop = numeric(row.initialStopLoss);
  if (initialStop == null || initialStop <= 0) return skip('ORIGINAL_STOP_UNPROVEN');
  const stop = numeric(row.stopLoss);
  if (stop == null || !sameNumber(initialStop, stop)) return skip('STOP_MODIFIED');
  if (row.trailingStopPips != null) return skip('TRAILING_STOP');
  if (row.positionRecordCount !== 1) return skip('POSITION_NOT_UNIQUE');
  if (row.hasPartialCloseOrder) return skip('PARTIAL_CLOSE');
  if (numeric(row.commission) !== 0 || numeric(row.swap) !== 0) return skip('NET_COSTS_UNPROVEN');
  const entry = numeric(row.entryPrice),
    exit = numeric(row.exitPrice);
  const lot = numeric(row.lotSize),
    pnl = numeric(row.realisedPnl);
  const filledQuantity = numeric(row.filledQuantity),
    filledEntry = numeric(row.filledEntryPrice);
  if (
    entry == null ||
    entry <= 0 ||
    lot == null ||
    lot <= 0 ||
    filledQuantity == null ||
    filledEntry == null ||
    !sameNumber(lot, filledQuantity) ||
    !sameNumber(entry, filledEntry)
  ) {
    return skip('FULL_FILL_UNPROVEN');
  }
  const target = numeric(row.takeProfit),
    originalTarget = numeric(row.initialTakeProfit);
  if (target == null || originalTarget == null || !sameNumber(target, originalTarget)) {
    return skip('ORIGINAL_TARGET_UNPROVEN');
  }
  const sign = row.direction === 'BUY' ? 1 : row.direction === 'SELL' ? -1 : 0;
  if (!sign || sign * (entry - stop) <= 0 || target <= 0 || sign * (target - entry) <= 0) {
    return skip('PROTECTIVE_GEOMETRY_INVALID');
  }
  if (exit == null || exit <= 0 || pnl == null) return skip('FULL_CLOSE_PNL_UNPROVEN');
  const units = lot * 100000;
  const usd = (quoteAmount: number, at: number): number =>
    symbol.endsWith('USD') ? quoteAmount : quoteAmount / at;
  const fullSizePnl = usd(sign * (exit - entry) * units, exit);
  // PAPER money is rounded to cents; allow at most half a cent, plus FP error.
  if (Math.abs(fullSizePnl - pnl) > 0.0050001) return skip('FULL_CLOSE_PNL_UNPROVEN');
  const initialRiskUsd = usd(Math.abs(entry - stop) * units, stop);
  const targetR = usd(sign * (target - entry) * units, target) / initialRiskUsd;
  return {
    eligible: true,
    skipReason: null,
    initialRiskUsd,
    realisedR: pnl / initialRiskUsd,
    targetR,
    binaryAssumedR: pnl > 0 ? targetR : pnl < 0 ? -1 : 0,
  };
}

export function effectiveShadowCostR(
  entry: Numeric,
  stop: Numeric,
  broker: Numeric,
  paper: Numeric,
): number | null {
  const e = numeric(entry),
    s = numeric(stop),
    b = numeric(broker),
    p = numeric(paper);
  if (
    e == null ||
    s == null ||
    e <= 0 ||
    s <= 0 ||
    e === s ||
    b == null ||
    b <= 0 ||
    p == null ||
    p <= 0
  )
    return null;
  return (1.25 * Math.max(b, p)) / Math.abs(e - s);
}

function realisedCohort(row: PaperTradeAuditRow): AuditCohort {
  return {
    policyVersion: row.policyVersion,
    modelVersion: row.modelVersion,
    costModelVersion: row.costModelVersion,
    strategyRoute: row.strategyRoute,
    executionRoute: classifyPaperRoute(row.executionRoute, row.research),
    accountCurrency: row.accountCurrency,
  };
}
function realisedSummary(rows: PaperTradeAuditRow[]): RealisedAuditSummary {
  const pnl = rows.map((row) => numeric(row.realisedPnl)).filter((v): v is number => v != null);
  const positive = pnl.filter((value) => value > 0),
    negative = pnl.filter((value) => value < 0);
  const grossPositivePnl = positive.reduce((a, b) => a + b, 0);
  const grossNegativePnl = -negative.reduce((a, b) => a + b, 0);
  const risks = rows.map(derivePaperInitialRisk);
  const eligible = risks.filter((risk) => risk.eligible);
  const realised = eligible.map((risk) => risk.realisedR!);
  const binary = eligible.map((risk) => risk.binaryAssumedR!);
  const meanWinningR = mean(realised.filter((value) => value > 0));
  const meanLosingAbsR = mean(realised.filter((value) => value < 0).map((value) => -value));
  const meanRealisedR = mean(realised),
    meanBinaryAssumedR = mean(binary);
  return {
    totals: {
      closedTrades: rows.length,
      pnlReportedTrades: pnl.length,
      pnlMissingTrades: rows.length - pnl.length,
      reportedRealisedPnl: pnl.length ? pnl.reduce((a, b) => a + b, 0) : null,
      wins: positive.length,
      losses: negative.length,
      flat: pnl.filter((v) => v === 0).length,
      winRate: pnl.length ? positive.length / pnl.length : null,
      grossPositivePnl,
      grossNegativePnl,
      profitFactor: grossNegativePnl > 0 ? grossPositivePnl / grossNegativePnl : null,
      closeReasons: counts(rows.map((row) => row.closeReason ?? 'UNKNOWN')),
    },
    payoff: {
      eligibleTrades: eligible.length,
      meanRealisedR,
      meanBinaryAssumedR,
      binaryOverstatementR:
        meanRealisedR != null && meanBinaryAssumedR != null
          ? meanBinaryAssumedR - meanRealisedR
          : null,
      meanWinningR,
      meanLosingAbsR,
      realisedBreakEvenWinRate:
        meanWinningR != null && meanLosingAbsR != null
          ? meanLosingAbsR / (meanWinningR + meanLosingAbsR)
          : null,
      winRate: returns(realised).winRate,
      profitFactorR: returns(realised).profitFactor,
      skipReasons: counts(risks.filter((risk) => !risk.eligible).map((risk) => risk.skipReason!)),
    },
  };
}

export function summarizeRealisedPaperTrades(rows: PaperTradeAuditRow[]): RealisedAuditCohort[] {
  return grouped(rows, (row) => JSON.stringify(realisedCohort(row))).map((group) => ({
    cohort: realisedCohort(group[0]),
    ...realisedSummary(group),
    pairSides: grouped(group, (row) => `${row.instrument}/${row.direction}`).map((pair) => ({
      instrument: pair[0].instrument,
      direction: pair[0].direction,
      ...realisedSummary(pair),
    })),
  }));
}

const EXIT_CODES = [
  'CLOSE_LOCK_050_GIVEBACK_040',
  'CLOSE_LOCK_075_GIVEBACK_050',
  'CLOSE_LOCK_100_GIVEBACK_050',
] as const;
function shadowCohort(row: ShadowAuditRow): AuditCohort {
  return {
    policyVersion: row.policyVersion,
    modelVersion: row.modelVersion,
    costModelVersion: row.costModelVersion,
    strategyRoute: row.strategyRoute,
    executionRoute: row.executionRoute,
    outcomeVersion: row.outcome?.version ?? null,
  };
}

/** Matched hypothetical completed-M5 policies only; never dollar broker returns. */
export function summarizePaperExitShadows(rows: ShadowAuditRow[]): ExitShadowAuditCohort[] {
  // Unresolved rows have no outcome version yet. Keep them with the other rows
  // from their exact decision cohort when exactly one outcome model is present.
  const versions = new Map<string, Set<string>>();
  const withoutVersion = (row: ShadowAuditRow): string =>
    JSON.stringify({
      ...shadowCohort(row),
      outcomeVersion: undefined,
      instrument: row.instrument,
      direction: row.direction,
    });
  for (const row of rows) {
    if (!row.outcome?.version) continue;
    const key = withoutVersion(row),
      set = versions.get(key) ?? new Set<string>();
    set.add(row.outcome.version);
    versions.set(key, set);
  }
  const cohort = (row: ShadowAuditRow): AuditCohort => {
    const c = shadowCohort(row),
      known = versions.get(withoutVersion(row));
    if (!c.outcomeVersion && known?.size === 1) c.outcomeVersion = [...known][0];
    return c;
  };
  return grouped(rows, (row) =>
    JSON.stringify({ ...cohort(row), instrument: row.instrument, direction: row.direction }),
  ).map((group) => {
    const valid = group.filter(
      (row) =>
        row.outcome &&
        Number.isFinite(new Date(row.evaluatedAt).getTime()) &&
        Number.isFinite(new Date(row.outcome.resolvedAt).getTime()) &&
        new Date(row.outcome.resolvedAt).getTime() >= new Date(row.evaluatedAt).getTime(),
    );
    // Include ambiguous episodes in collapse so a known overlapping first-hit
    // episode cannot be counted through an ambiguous earlier candidate.
    const episodes = collapseEnsembleOutcomeEpisodes(
      valid.map((row) => ({
        evaluatedAt: row.evaluatedAt,
        outcome: row.outcome,
      })),
    );
    const retained = new Map(valid.map((row) => [row.outcome!, row]));
    const policies = EXIT_CODES.map((code): ExitPolicyAuditSummary => {
      const matched: Array<{
        baseStored: number;
        policyStored: number;
        base: number;
        policy: number;
        activated: boolean;
        exitedEarly: boolean;
      }> = [];
      const skipped: string[] = [];
      for (const base of episodes) {
        if (
          base.status === 'AMBIGUOUS' ||
          numeric(base.grossR) == null ||
          numeric(base.netR) == null
        ) {
          skipped.push('BASELINE_OUTCOME_UNUSABLE');
          continue;
        }
        const cf = base.postEntryTelemetry?.profitProtectionCounterfactuals?.filter(
          (v) => v.code === code,
        );
        if (
          !cf ||
          cf.length !== 1 ||
          numeric(cf[0].grossR) == null ||
          numeric(cf[0].netR) == null
        ) {
          skipped.push('POLICY_OUTCOME_MISSING');
          continue;
        }
        if (
          base.postEntryTelemetry?.methodology !== 'COMPLETED_M5_BARS_BEFORE_EXIT_CONSERVATIVE_V1'
        ) {
          skipped.push('POLICY_METHODOLOGY_UNSUPPORTED');
          continue;
        }
        const row = retained.get(base)!;
        const cost = effectiveShadowCostR(
          row.entryPrice,
          row.stopLoss,
          row.brokerSpreadPrice,
          row.paperSpreadPrice,
        );
        if (cost == null) {
          skipped.push('EXECUTION_COST_UNPROVEN');
          continue;
        }
        matched.push({
          baseStored: base.netR!,
          policyStored: cf[0].netR,
          base: base.grossR! - cost,
          policy: cf[0].grossR - cost,
          activated: cf[0].activated,
          exitedEarly: cf[0].exitedEarly,
        });
      }
      return {
        code,
        matchedEpisodes: matched.length,
        activatedEpisodes: matched.filter((v) => v.activated).length,
        exitedEarlyEpisodes: matched.filter((v) => v.exitedEarly).length,
        baselineStoredCost: returns(matched.map((v) => v.baseStored)),
        policyStoredCost: returns(matched.map((v) => v.policyStored)),
        baselineEffectiveCost: returns(matched.map((v) => v.base)),
        policyEffectiveCost: returns(matched.map((v) => v.policy)),
        meanDeltaR: mean(matched.map((v) => v.policy - v.base)),
        skipReasons: counts(skipped),
      };
    });
    return {
      cohort: cohort(group[0]),
      instrument: group[0].instrument,
      direction: group[0].direction,
      rows: group.length,
      unresolvedRows: group.filter((row) => !row.outcome).length,
      ambiguousRows: group.filter((row) => row.outcome?.status === 'AMBIGUOUS').length,
      invalidRows: group.filter((row) => row.outcome != null).length - valid.length,
      episodeCount: episodes.length,
      overlappingRowsCollapsed: valid.length - episodes.length,
      policies,
    };
  });
}

export interface PaperExecutionRouteLink {
  instrument: string;
  direction: 'BUY' | 'SELL';
  marketBarTime: Date | string | null;
  policyVersion: string | null;
  costModelVersion: string | null;
  executionRoute: string | null;
  research: boolean | null;
}
export function attachPaperExecutionRoutes(
  rows: ShadowAuditRow[],
  links: PaperExecutionRouteLink[],
): ShadowAuditRow[] {
  const timestamp = (value: Date | string | null | undefined): number | null => {
    if (value == null) return null;
    const parsed = new Date(value).getTime();
    return Number.isFinite(parsed) ? parsed : null;
  };

  return rows.map((row) => {
    const rowBarTime = timestamp(row.marketBarTime);
    if (rowBarTime == null) return { ...row, executionRoute: 'SHADOW_UNLINKED' };

    const matchedRoutes = new Set(
      links
        .filter(
          (link) =>
            link.instrument.trim().toUpperCase() === row.instrument.trim().toUpperCase() &&
            link.direction === row.direction &&
            link.policyVersion === row.policyVersion &&
            link.costModelVersion === row.costModelVersion &&
            timestamp(link.marketBarTime) === rowBarTime,
        )
        .map((link) => classifyPaperRoute(link.executionRoute, link.research)),
    );

    return {
      ...row,
      executionRoute:
        matchedRoutes.size === 0
          ? 'SHADOW_UNLINKED'
          : matchedRoutes.size === 1
            ? [...matchedRoutes][0]!
            : 'MULTIPLE_EXECUTION_ROUTES',
    };
  });
}
