export const PAPER_CHAMPION_EVIDENCE_ARTIFACT = 'friday-champion-evidence-v1' as const;
export const PAPER_CHAMPION_MIN_TRADES = 50;
export const PAPER_CHAMPION_MIN_PROFIT_FACTOR = 1.15;
export const PAPER_CHAMPION_MIN_POSITIVE_INSTRUMENT_FRACTION = 0.67;
export const PAPER_COMPATIBLE_SLEEVE_MIN_TRADES = 8;
export const PAPER_COMPATIBLE_SLEEVE_MIN_PROFIT_FACTOR = 1.0;

export interface PaperChampionTradeEvidenceRow {
  instrument: string;
  direction: 'BUY' | 'SELL';
  timeframe: string;
  modelVersion: string;
  strategyRoute: string | null;
  decisionPolicyVersion: string | null;
  realisedPnl: number;
  openedAt: string | Date;
}

export interface PaperChampionRealisedMetrics {
  trades: number;
  wins: number;
  losses: number;
  breakeven: number;
  grossProfit: number;
  grossLoss: number;
  netPnl: number;
  profitFactor: number | null;
  winRate: number | null;
}

export interface PaperChampionGroupedMetrics extends PaperChampionRealisedMetrics {
  modelVersion?: string;
  strategyRoute?: string;
  instrument?: string;
  direction?: 'BUY' | 'SELL';
}

export type CompatibleSleeveState =
  | 'COLLECTING_COMPATIBLE_SLEEVE'
  | 'MATURE_HEALTHY_COMPATIBLE_SLEEVE'
  | 'MATURE_WEAK_COMPATIBLE_SLEEVE';

export interface CompatibleSleeveEvidence extends PaperChampionRealisedMetrics {
  instrument: string;
  direction: 'BUY' | 'SELL';
  strategyRoute: string;
  state: CompatibleSleeveState;
  executionVetoRecommended: boolean;
}

export interface PaperChampionEvidence {
  artifact: typeof PAPER_CHAMPION_EVIDENCE_ARTIFACT;
  modifiesExecution: false;
  approvedForDemo: false;
  approvedForLive: false;
  champion: {
    modelVersion: string;
    metrics: PaperChampionRealisedMetrics;
    positiveInstrumentFraction: number;
    checks: {
      tradesGte50: boolean;
      positiveNetPnl: boolean;
      profitFactorGte1_15: boolean;
      positiveInstrumentFractionGte0_67: boolean;
    };
    status: 'PROVISIONAL_FORWARD_CHAMPION' | 'INSUFFICIENT_FORWARD_EVIDENCE';
  };
  descriptive: {
    byModel: PaperChampionGroupedMetrics[];
    byRoute: PaperChampionGroupedMetrics[];
    byInstrument: PaperChampionGroupedMetrics[];
    byPairSide: PaperChampionGroupedMetrics[];
    byRoutePairSide: PaperChampionGroupedMetrics[];
  };
  compatibleSleeves: CompatibleSleeveEvidence[];
  compatibleMatureWeakSleeves: CompatibleSleeveEvidence[];
}

interface BuildPaperChampionEvidenceOptions {
  championModelVersion: string;
  expectedInstruments: string[];
  compatiblePolicyVersions: string[];
}

function normalizedRoute(value: string | null): string {
  const route = value?.trim();
  return route ? route : 'UNKNOWN';
}

function finitePnl(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function summarize(rows: PaperChampionTradeEvidenceRow[]): PaperChampionRealisedMetrics {
  let wins = 0;
  let losses = 0;
  let breakeven = 0;
  let grossProfit = 0;
  let grossLoss = 0;

  for (const row of rows) {
    const pnl = finitePnl(row.realisedPnl);
    if (pnl > 0) {
      wins += 1;
      grossProfit += pnl;
    } else if (pnl < 0) {
      losses += 1;
      grossLoss += -pnl;
    } else {
      breakeven += 1;
    }
  }

  const trades = rows.length;
  const netPnl = grossProfit - grossLoss;
  return {
    trades,
    wins,
    losses,
    breakeven,
    grossProfit,
    grossLoss,
    netPnl,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
    winRate: trades > 0 ? wins / trades : null,
  };
}

function groupRows(
  rows: PaperChampionTradeEvidenceRow[],
  keyOf: (row: PaperChampionTradeEvidenceRow) => string,
  decorate: (row: PaperChampionTradeEvidenceRow) => Partial<PaperChampionGroupedMetrics>,
): PaperChampionGroupedMetrics[] {
  const groups = new Map<string, PaperChampionTradeEvidenceRow[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, group]) => ({ ...decorate(group[0]!), ...summarize(group) }));
}

function isWeakCompatibleSleeve(metrics: PaperChampionRealisedMetrics): boolean {
  if (metrics.trades < PAPER_COMPATIBLE_SLEEVE_MIN_TRADES) return false;
  if (metrics.losses === 0) return false;
  if (metrics.grossProfit <= 0) return true;
  return (
    metrics.profitFactor !== null &&
    metrics.profitFactor < PAPER_COMPATIBLE_SLEEVE_MIN_PROFIT_FACTOR
  );
}

export function buildPaperChampionEvidence(
  rows: PaperChampionTradeEvidenceRow[],
  options: BuildPaperChampionEvidenceOptions,
): PaperChampionEvidence {
  const championRows = rows.filter(
    (row) => row.timeframe === 'M5' && row.modelVersion === options.championModelVersion,
  );
  const championMetrics = summarize(championRows);
  const championByInstrument = groupRows(
    championRows,
    (row) => row.instrument.trim().toUpperCase(),
    (row) => ({ instrument: row.instrument.trim().toUpperCase() }),
  );
  const positiveInstruments = new Set(
    championByInstrument.filter((group) => group.netPnl > 0).map((group) => group.instrument),
  );
  const positiveInstrumentFraction =
    options.expectedInstruments.length > 0
      ? options.expectedInstruments.filter((instrument) => positiveInstruments.has(instrument))
          .length / options.expectedInstruments.length
      : 0;
  const profitFactorPass =
    championMetrics.grossLoss === 0
      ? championMetrics.grossProfit > 0
      : championMetrics.profitFactor !== null &&
        championMetrics.profitFactor >= PAPER_CHAMPION_MIN_PROFIT_FACTOR;
  const checks = {
    tradesGte50: championMetrics.trades >= PAPER_CHAMPION_MIN_TRADES,
    positiveNetPnl: championMetrics.netPnl > 0,
    profitFactorGte1_15: profitFactorPass,
    positiveInstrumentFractionGte0_67:
      positiveInstrumentFraction >= PAPER_CHAMPION_MIN_POSITIVE_INSTRUMENT_FRACTION,
  };

  const compatiblePolicies = new Set(options.compatiblePolicyVersions);
  const compatibleRows = championRows.filter(
    (row) =>
      row.decisionPolicyVersion !== null && compatiblePolicies.has(row.decisionPolicyVersion),
  );
  const compatibleGroups = new Map<string, PaperChampionTradeEvidenceRow[]>();
  for (const row of compatibleRows) {
    const instrument = row.instrument.trim().toUpperCase();
    const route = normalizedRoute(row.strategyRoute);
    const key = `${route}|${instrument}|${row.direction}`;
    const group = compatibleGroups.get(key) ?? [];
    group.push({ ...row, instrument, strategyRoute: route });
    compatibleGroups.set(key, group);
  }
  const compatibleSleeves: CompatibleSleeveEvidence[] = [...compatibleGroups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, group]) => {
      const metrics = summarize(group);
      const weak = isWeakCompatibleSleeve(metrics);
      const mature = metrics.trades >= PAPER_COMPATIBLE_SLEEVE_MIN_TRADES;
      return {
        instrument: group[0]!.instrument,
        direction: group[0]!.direction,
        strategyRoute: normalizedRoute(group[0]!.strategyRoute),
        ...metrics,
        state: weak
          ? 'MATURE_WEAK_COMPATIBLE_SLEEVE'
          : mature
            ? 'MATURE_HEALTHY_COMPATIBLE_SLEEVE'
            : 'COLLECTING_COMPATIBLE_SLEEVE',
        executionVetoRecommended: weak,
      };
    });

  const descriptive = {
    byModel: groupRows(
      rows,
      (row) => row.modelVersion,
      (row) => ({ modelVersion: row.modelVersion }),
    ),
    byRoute: groupRows(
      championRows,
      (row) => normalizedRoute(row.strategyRoute),
      (row) => ({ strategyRoute: normalizedRoute(row.strategyRoute) }),
    ),
    byInstrument: championByInstrument,
    byPairSide: groupRows(
      championRows,
      (row) => `${row.instrument.trim().toUpperCase()}|${row.direction}`,
      (row) => ({ instrument: row.instrument.trim().toUpperCase(), direction: row.direction }),
    ),
    byRoutePairSide: groupRows(
      championRows,
      (row) =>
        `${normalizedRoute(row.strategyRoute)}|${row.instrument.trim().toUpperCase()}|${row.direction}`,
      (row) => ({
        strategyRoute: normalizedRoute(row.strategyRoute),
        instrument: row.instrument.trim().toUpperCase(),
        direction: row.direction,
      }),
    ),
  };

  const championPassed = Object.values(checks).every(Boolean);
  return {
    artifact: PAPER_CHAMPION_EVIDENCE_ARTIFACT,
    modifiesExecution: false,
    approvedForDemo: false,
    approvedForLive: false,
    champion: {
      modelVersion: options.championModelVersion,
      metrics: championMetrics,
      positiveInstrumentFraction,
      checks,
      status: championPassed ? 'PROVISIONAL_FORWARD_CHAMPION' : 'INSUFFICIENT_FORWARD_EVIDENCE',
    },
    descriptive,
    compatibleSleeves,
    compatibleMatureWeakSleeves: compatibleSleeves.filter(
      (sleeve) => sleeve.state === 'MATURE_WEAK_COMPATIBLE_SLEEVE',
    ),
  };
}
