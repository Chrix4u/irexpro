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

export function replayPaperEpisode(
  candidate: Candidate,
  entryQuote: ReplayQuote,
  futureQuotes: readonly ReplayQuote[],
): ReplayEpisode {
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

  let maxFavorableR = 0;
  let previous = entry;
  for (const rawQuote of futureQuotes) {
    const observedAt = new Date(rawQuote.observedAt);
    if (
      !Number.isFinite(observedAt.getTime()) ||
      observedAt.getTime() <= previous.observedAt.getTime()
    ) {
      throw new Error('INVALID_REPLAY_QUOTE_TIME');
    }
    if (observedAt.getTime() - previous.observedAt.getTime() !== 60_000) {
      return closeEpisode(
        candidate,
        entry.observedAt,
        entry.executable,
        initialRiskPrice,
        previous,
        maxFavorableR,
        'DATA_GAP',
      );
    }
    const quote = buildExecutableReplayQuote(
      candidate.instrument,
      candidate.direction,
      rawQuote.mid,
      rawQuote.spread,
      observedAt,
    );
    const r = currentR(candidate.direction, entry.executable, quote.executable, initialRiskPrice);
    maxFavorableR = Math.max(maxFavorableR, r);

    const stopTouched =
      candidate.direction === 'BUY'
        ? quote.executable <= candidate.stopLoss
        : quote.executable >= candidate.stopLoss;
    if (stopTouched) {
      return closeEpisode(
        candidate,
        entry.observedAt,
        entry.executable,
        initialRiskPrice,
        quote,
        maxFavorableR,
        'STOP_LOSS',
      );
    }
    const targetTouched =
      candidate.direction === 'BUY'
        ? quote.executable >= candidate.takeProfit
        : quote.executable <= candidate.takeProfit;
    if (targetTouched) {
      return closeEpisode(
        candidate,
        entry.observedAt,
        entry.executable,
        initialRiskPrice,
        quote,
        maxFavorableR,
        'TAKE_PROFIT',
      );
    }

    const riskUnit = '1.00000000';
    const currentPnl = r.toFixed(8);
    const maxFavorablePnl = maxFavorableR.toFixed(8);
    const profitLock = evaluatePaperProfitLock({
      maxFavorablePnl,
      currentPnl,
      initialRiskPnl: riskUnit,
    });
    if (profitLock.shouldClose) {
      return closeEpisode(
        candidate,
        entry.observedAt,
        entry.executable,
        initialRiskPrice,
        quote,
        maxFavorableR,
        'PROFIT_LOCK',
      );
    }

    const elapsedMinutes = (quote.observedAt.getTime() - entry.observedAt.getTime()) / 60_000;
    const timeToWork = evaluatePaperTimeToWork({
      elapsedMinutes,
      maxFavorablePnl,
      currentPnl,
      initialRiskPnl: riskUnit,
      minimumHoldMinutes: 20,
    });
    if (timeToWork.shouldClose) {
      return closeEpisode(
        candidate,
        entry.observedAt,
        entry.executable,
        initialRiskPrice,
        quote,
        maxFavorableR,
        timeToWork.reason as ReplayExitReason,
      );
    }
    if (elapsedMinutes >= 12 * 60) {
      return closeEpisode(
        candidate,
        entry.observedAt,
        entry.executable,
        initialRiskPrice,
        quote,
        maxFavorableR,
        'TIMEBOX_12H',
      );
    }
    previous = quote;
  }

  return closeEpisode(
    candidate,
    entry.observedAt,
    entry.executable,
    initialRiskPrice,
    previous,
    maxFavorableR,
    'DATA_END',
  );
}
