import type { LivePaperCandleInput } from '../../broker/services/live-paper-market-data.service';

export interface MtfM5Row {
  decision_time: string;
  m5_source_bar_open: string;
  m5_available_at: string;
  m5_open: string;
  m5_high: string;
  m5_low: string;
  m5_close: string;
  m5_spread_price?: string;
}

export interface ReconstructedM5Bar extends LivePaperCandleInput {
  availableAt: Date;
  spreadPrice: number | null;
}

function validDate(value: string): Date {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error('INVALID_M5_ROW');
  return parsed;
}

function validPrice(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error('INVALID_M5_ROW');
  return parsed;
}

function normalizedBar(row: MtfM5Row): ReconstructedM5Bar {
  const decisionAt = validDate(row.decision_time);
  const timestamp = validDate(row.m5_source_bar_open);
  const availableAt = validDate(row.m5_available_at);
  if (decisionAt.getTime() < availableAt.getTime()) throw new Error('M5_BAR_NOT_YET_AVAILABLE');

  const open = validPrice(row.m5_open);
  const high = validPrice(row.m5_high);
  const low = validPrice(row.m5_low);
  const close = validPrice(row.m5_close);
  if (high < Math.max(open, close) || low > Math.min(open, close) || low > high) {
    throw new Error('INVALID_M5_ROW');
  }
  const spreadPrice =
    row.m5_spread_price == null || row.m5_spread_price.trim() === ''
      ? null
      : Number(row.m5_spread_price);
  if (spreadPrice !== null && (!Number.isFinite(spreadPrice) || spreadPrice < 0)) {
    throw new Error('INVALID_M5_ROW');
  }

  return {
    timestamp,
    availableAt,
    open: String(open),
    high: String(high),
    low: String(low),
    close: String(close),
    spreadPrice,
  };
}

function sameBar(a: ReconstructedM5Bar, b: ReconstructedM5Bar): boolean {
  return (
    a.timestamp.getTime() === b.timestamp.getTime() &&
    a.availableAt.getTime() === b.availableAt.getTime() &&
    a.open === b.open &&
    a.high === b.high &&
    a.low === b.low &&
    a.close === b.close &&
    a.spreadPrice === b.spreadPrice
  );
}

export function reconstructClosedM5Bars(rows: readonly MtfM5Row[]): ReconstructedM5Bar[] {
  const byOpen = new Map<number, ReconstructedM5Bar>();
  for (const row of rows) {
    const bar = normalizedBar(row);
    const key = bar.timestamp.getTime();
    const existing = byOpen.get(key);
    if (existing && !sameBar(existing, bar)) throw new Error('INCONSISTENT_M5_DUPLICATE');
    if (!existing) byOpen.set(key, bar);
  }
  return [...byOpen.values()].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
}

import { buildDirectionalCandidates, type Candidate } from '../vps-forex-signal-collector.service';
import { scorePlanBMultimodelShadow, type PlanBEnsembleScore } from '../plan-b-multimodel-shadow';
import type { V8ShadowMetaInput } from '../v8-shadow-meta-scorer';

const M5_BAR_MS = 5 * 60_000;

export interface IntrinsicReplayCandidate {
  candidate: Candidate;
  ensemble: PlanBEnsembleScore;
}

export function candidateToPlanBInput(candidate: Candidate): V8ShadowMetaInput {
  return {
    instrument: candidate.instrument,
    direction: candidate.direction,
    confidence: candidate.confidence,
    extensionAtr: candidate.extensionAtr,
    volatilityScore: candidate.volatilityScore,
    emaSeparation: candidate.emaSeparation,
    mtfStrength: candidate.mtfStrength,
    rsi14: candidate.rsi14,
    shortHorizonMomentumAtr:
      (candidate.direction === 'BUY' ? 1 : -1) * candidate.shortHorizonMomentumAtr,
    scanTime: new Date(candidate.barTime.getTime() + M5_BAR_MS),
  };
}

export function scoreIntrinsicM5Snapshot(
  instrument: string,
  candles: readonly LivePaperCandleInput[],
): IntrinsicReplayCandidate[] {
  const mutableCandles = candles.map((candle) => ({ ...candle }));
  return buildDirectionalCandidates(instrument, mutableCandles).map((candidate) => ({
    candidate,
    ensemble: scorePlanBMultimodelShadow(candidateToPlanBInput(candidate), []),
  }));
}

export function selectIntrinsicPaperSide(
  candidates: readonly IntrinsicReplayCandidate[],
): IntrinsicReplayCandidate | null {
  const eligible = candidates
    .filter((entry) => entry.ensemble.paperAdmitted)
    .sort((a, b) => b.candidate.score - a.candidate.score);
  if (eligible.length === 0) return null;
  if (
    eligible.length > 1 &&
    Math.abs(eligible[0]!.candidate.score - eligible[1]!.candidate.score) <= Number.EPSILON
  ) {
    return null;
  }
  return eligible[0]!;
}

import { PAPER_MARKET_SPECS } from '../../broker/services/paper-market-spec';
import {
  evaluatePaperProfitLock,
  evaluatePaperTimeToWork,
} from '../../broker/adapters/paper-broker.adapter';

export interface ReplayQuote {
  observedAt: Date;
  mid: number;
  spread: number;
}

export interface ExecutableReplayQuote extends ReplayQuote {
  executable: number;
}

export type ReplayExitReason =
  | 'STOP_LOSS'
  | 'TAKE_PROFIT'
  | 'PROFIT_LOCK'
  | 'FAILED_TO_WORK_5M'
  | 'FAILED_TO_WORK_15M'
  | 'FAILED_TO_WORK_30M'
  | 'FAILED_TO_WORK_60M'
  | 'DATA_GAP'
  | 'TIMEBOX_12H'
  | 'DATA_END';

export interface ReplayEpisode {
  instrument: string;
  direction: 'BUY' | 'SELL';
  openedAt: Date;
  exitAt: Date;
  entryPrice: number;
  exitPrice: number;
  initialRiskPrice: number;
  r: number;
  maxFavorableR: number;
  exitReason: ReplayExitReason;
}

function finitePositive(value: number, code: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(code);
  return value;
}

export function buildExecutableReplayQuote(
  instrument: string,
  direction: 'BUY' | 'SELL',
  mid: number,
  observedSpread: number,
  observedAt = new Date(0),
): ExecutableReplayQuote {
  const spec = PAPER_MARKET_SPECS[instrument];
  if (!spec) throw new Error('UNSUPPORTED_REPLAY_INSTRUMENT');
  finitePositive(mid, 'INVALID_REPLAY_QUOTE');
  const corpusSpread = Number.isFinite(observedSpread) && observedSpread >= 0 ? observedSpread : 0;
  const spread = Math.max(corpusSpread, spec.spread);
  return {
    observedAt: new Date(observedAt),
    mid,
    spread,
    executable: direction === 'BUY' ? mid + spread / 2 : mid - spread / 2,
  };
}

function currentR(
  direction: 'BUY' | 'SELL',
  entryPrice: number,
  executable: number,
  initialRiskPrice: number,
): number {
  return direction === 'BUY'
    ? (executable - entryPrice) / initialRiskPrice
    : (entryPrice - executable) / initialRiskPrice;
}

function closeEpisode(
  candidate: Candidate,
  openedAt: Date,
  entryPrice: number,
  initialRiskPrice: number,
  quote: ExecutableReplayQuote,
  maxFavorableR: number,
  exitReason: ReplayExitReason,
): ReplayEpisode {
  return {
    instrument: candidate.instrument,
    direction: candidate.direction,
    openedAt: new Date(openedAt),
    exitAt: new Date(quote.observedAt),
    entryPrice,
    exitPrice: quote.executable,
    initialRiskPrice,
    r: currentR(candidate.direction, entryPrice, quote.executable, initialRiskPrice),
    maxFavorableR,
    exitReason,
  };
}

export interface ReplayEpisodeState {
  candidate: Candidate;
  entry: ExecutableReplayQuote;
  previous: ExecutableReplayQuote;
  initialRiskPrice: number;
  maxFavorableR: number;
}

export function startReplayPaperEpisode(
  candidate: Candidate,
  entryQuote: ReplayQuote,
): ReplayEpisodeState {
  const entry = buildExecutableReplayQuote(
    candidate.instrument,
    candidate.direction,
    entryQuote.mid,
    entryQuote.spread,
    entryQuote.observedAt,
  );
  const stopLoss = finitePositive(candidate.stopLoss, 'INVALID_REPLAY_STOP');
  finitePositive(candidate.takeProfit, 'INVALID_REPLAY_TARGET');
  const initialRiskPrice =
    candidate.direction === 'BUY' ? entry.executable - stopLoss : stopLoss - entry.executable;
  finitePositive(initialRiskPrice, 'INVALID_REPLAY_ENTRY_GEOMETRY');
  return {
    candidate,
    entry,
    previous: entry,
    initialRiskPrice,
    maxFavorableR: 0,
  };
}

export function finishReplayPaperEpisode(
  state: ReplayEpisodeState,
  reason: ReplayExitReason = 'DATA_END',
): ReplayEpisode {
  return closeEpisode(
    state.candidate,
    state.entry.observedAt,
    state.entry.executable,
    state.initialRiskPrice,
    state.previous,
    state.maxFavorableR,
    reason,
  );
}

export function advanceReplayPaperEpisode(
  state: ReplayEpisodeState,
  rawQuote: ReplayQuote,
): { state: ReplayEpisodeState; closed: ReplayEpisode | null } {
  const observedAt = new Date(rawQuote.observedAt);
  if (
    !Number.isFinite(observedAt.getTime()) ||
    observedAt.getTime() <= state.previous.observedAt.getTime()
  ) {
    throw new Error('INVALID_REPLAY_QUOTE_TIME');
  }
  if (observedAt.getTime() - state.previous.observedAt.getTime() !== 60_000) {
    return { state, closed: finishReplayPaperEpisode(state, 'DATA_GAP') };
  }

  const quote = buildExecutableReplayQuote(
    state.candidate.instrument,
    state.candidate.direction,
    rawQuote.mid,
    rawQuote.spread,
    observedAt,
  );
  const r = currentR(
    state.candidate.direction,
    state.entry.executable,
    quote.executable,
    state.initialRiskPrice,
  );
  const maxFavorableR = Math.max(state.maxFavorableR, r);
  const nextState: ReplayEpisodeState = { ...state, previous: quote, maxFavorableR };

  const stopTouched =
    state.candidate.direction === 'BUY'
      ? quote.executable <= state.candidate.stopLoss
      : quote.executable >= state.candidate.stopLoss;
  if (stopTouched)
    return { state: nextState, closed: finishReplayPaperEpisode(nextState, 'STOP_LOSS') };

  const targetTouched =
    state.candidate.direction === 'BUY'
      ? quote.executable >= state.candidate.takeProfit
      : quote.executable <= state.candidate.takeProfit;
  if (targetTouched)
    return { state: nextState, closed: finishReplayPaperEpisode(nextState, 'TAKE_PROFIT') };

  const riskUnit = '1.00000000';
  const currentPnl = r.toFixed(8);
  const maxFavorablePnl = maxFavorableR.toFixed(8);
  const profitLock = evaluatePaperProfitLock({
    maxFavorablePnl,
    currentPnl,
    initialRiskPnl: riskUnit,
  });
  if (profitLock.shouldClose) {
    return { state: nextState, closed: finishReplayPaperEpisode(nextState, 'PROFIT_LOCK') };
  }

  const elapsedMinutes = (quote.observedAt.getTime() - state.entry.observedAt.getTime()) / 60_000;
  const timeToWork = evaluatePaperTimeToWork({
    elapsedMinutes,
    maxFavorablePnl,
    currentPnl,
    initialRiskPnl: riskUnit,
    minimumHoldMinutes: 20,
  });
  if (timeToWork.shouldClose) {
    return {
      state: nextState,
      closed: finishReplayPaperEpisode(nextState, timeToWork.reason as ReplayExitReason),
    };
  }
  if (elapsedMinutes >= 12 * 60) {
    return { state: nextState, closed: finishReplayPaperEpisode(nextState, 'TIMEBOX_12H') };
  }
  return { state: nextState, closed: null };
}

export function replayPaperEpisode(
  candidate: Candidate,
  entryQuote: ReplayQuote,
  futureQuotes: readonly ReplayQuote[],
): ReplayEpisode {
  let state = startReplayPaperEpisode(candidate, entryQuote);
  for (const rawQuote of futureQuotes) {
    const advanced = advanceReplayPaperEpisode(state, rawQuote);
    state = advanced.state;
    if (advanced.closed) return advanced.closed;
  }
  return finishReplayPaperEpisode(state, 'DATA_END');
}

export interface ReplayEvidenceEpisode extends ReplayEpisode {
  strategyRoute: string;
  confidence: number;
}

export interface ReplayEpisodeMetrics {
  episodes: number;
  wins: number;
  losses: number;
  breakeven: number;
  netR: number;
  averageR: number | null;
  grossPositiveR: number;
  grossNegativeR: number;
  profitFactor: number | null;
  episodeSharpe: number | null;
  maxDrawdownR: number;
  positiveInstrumentFraction: number;
}

function sampleEpisodeSharpe(values: readonly number[]): number | null {
  if (values.length < 2) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  const std = Math.sqrt(variance);
  if (!Number.isFinite(std) || std <= 0) return mean > 0 ? null : mean < 0 ? null : 0;
  return (mean / std) * Math.sqrt(values.length);
}

function maximumDrawdownR(values: readonly number[]): number {
  let cumulative = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const value of values) {
    cumulative += value;
    peak = Math.max(peak, cumulative);
    maxDrawdown = Math.max(maxDrawdown, peak - cumulative);
  }
  return maxDrawdown;
}

export function summarizeReplayEpisodes(
  episodes: readonly ReplayEvidenceEpisode[],
  expectedInstruments: readonly string[],
): ReplayEpisodeMetrics {
  const returns = episodes.map((episode) => episode.r);
  const wins = returns.filter((value) => value > 0).length;
  const losses = returns.filter((value) => value < 0).length;
  const breakeven = returns.length - wins - losses;
  const grossPositiveR = returns
    .filter((value) => value > 0)
    .reduce((sum, value) => sum + value, 0);
  const grossNegativeR = -returns
    .filter((value) => value < 0)
    .reduce((sum, value) => sum + value, 0);
  const netR = grossPositiveR - grossNegativeR;
  const byInstrument = new Map<string, number>();
  for (const episode of episodes) {
    byInstrument.set(episode.instrument, (byInstrument.get(episode.instrument) ?? 0) + episode.r);
  }
  const positiveInstrumentFraction =
    expectedInstruments.length === 0
      ? 0
      : expectedInstruments.filter((instrument) => (byInstrument.get(instrument) ?? 0) > 0).length /
        expectedInstruments.length;
  return {
    episodes: episodes.length,
    wins,
    losses,
    breakeven,
    netR,
    averageR: episodes.length > 0 ? netR / episodes.length : null,
    grossPositiveR,
    grossNegativeR,
    profitFactor: grossNegativeR > 0 ? grossPositiveR / grossNegativeR : null,
    episodeSharpe: sampleEpisodeSharpe(returns),
    maxDrawdownR: maximumDrawdownR(returns),
    positiveInstrumentFraction,
  };
}

export function summarizeReplaySleeves(episodes: readonly ReplayEvidenceEpisode[]) {
  const groups = new Map<string, ReplayEvidenceEpisode[]>();
  for (const episode of episodes) {
    const key = `${episode.instrument}|${episode.direction}`;
    const group = groups.get(key) ?? [];
    group.push(episode);
    groups.set(key, group);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, group]) => ({
      key,
      ...summarizeReplayEpisodes(group, [group[0]!.instrument]),
    }));
}

export function buildChronologicalReplayFolds(
  episodes: readonly ReplayEvidenceEpisode[],
  foldCount = 3,
): ReplayEvidenceEpisode[][] {
  if (!Number.isInteger(foldCount) || foldCount <= 0) throw new Error('INVALID_REPLAY_FOLD_COUNT');
  const ordered = [...episodes].sort(
    (left, right) =>
      left.openedAt.getTime() - right.openedAt.getTime() ||
      left.instrument.localeCompare(right.instrument),
  );
  const uniqueTimes = [...new Set(ordered.map((episode) => episode.openedAt.getTime()))];
  const foldByTime = new Map<number, number>();
  uniqueTimes.forEach((time, index) => {
    const fold =
      uniqueTimes.length === 0
        ? 0
        : Math.min(foldCount - 1, Math.floor((index * foldCount) / uniqueTimes.length));
    foldByTime.set(time, fold);
  });
  const folds = Array.from({ length: foldCount }, () => [] as ReplayEvidenceEpisode[]);
  for (const episode of ordered) {
    folds[foldByTime.get(episode.openedAt.getTime()) ?? 0]!.push(episode);
  }
  return folds;
}

interface BuildReplayStressReportOptions {
  sourceCommit: string;
  corpusLabel: string;
  observedTradingDays: number;
  expectedInstruments: string[];
}

export function buildReplayStressReport(
  episodes: readonly ReplayEvidenceEpisode[],
  options: BuildReplayStressReportOptions,
) {
  const folds = buildChronologicalReplayFolds(episodes, 3);
  const foldMetrics = folds.map((fold, index) => ({
    fold: index + 1,
    ...summarizeReplayEpisodes(fold, options.expectedInstruments),
  }));
  const positiveFoldFraction =
    foldMetrics.filter((fold) => fold.netR > 0).length / Math.max(1, foldMetrics.length);
  const aggregate = summarizeReplayEpisodes(episodes, options.expectedInstruments);
  const pfPass =
    aggregate.grossNegativeR === 0
      ? aggregate.grossPositiveR > 0
      : aggregate.profitFactor !== null && aggregate.profitFactor >= 1.15;
  const measurableChecks = {
    profitFactorGte1_15: pfPass,
    episodeSharpeGte1: aggregate.episodeSharpe !== null && aggregate.episodeSharpe >= 1,
    maxDrawdownRLe12: aggregate.maxDrawdownR <= 12,
    positiveFoldFractionGte0_60: positiveFoldFraction >= 0.6,
    positiveInstrumentFractionGte0_67: aggregate.positiveInstrumentFraction >= 0.67,
  };
  return {
    artifact: 'friday-champion-100k-replay-v1',
    classification: 'HISTORICAL_ARCHITECTURE_STRESS_REPLAY' as const,
    sourceCommit: options.sourceCommit,
    corpusLabel: options.corpusLabel,
    observedTradingDays: options.observedTradingDays,
    aggregate,
    opportunityRatePerObservedDay:
      options.observedTradingDays > 0 ? episodes.length / options.observedTradingDays : null,
    folds: foldMetrics,
    positiveFoldFraction,
    measurableChecks,
    stressChecksPassed: Object.values(measurableChecks).every(Boolean),
    balancedAccuracy: null,
    maxDrawdownAccountPercent: null,
    approvedForPaper: false,
    approvedForDemo: false,
    approvedForLive: false,
    note: 'Historical architecture stress only; no model fitting or promotion authority.',
  };
}
