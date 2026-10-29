import type { LivePaperCandleInput } from '../broker/services/live-paper-market-data.service';
import { adaptiveMarketSession, type AdaptiveMarketSession } from './adaptive-market-state';

export const M1_TACTICAL_FEATURE_ARTIFACT = 'm1-tactical-features-v1';

export interface M1TacticalFeatureInput {
  instrument: string;
  decisionTime: Date;
  m1: LivePaperCandleInput[];
  m5: LivePaperCandleInput[];
  m15: LivePaperCandleInput[];
  h1: LivePaperCandleInput[];
  h4: LivePaperCandleInput[];
}

export interface M1TacticalFeatureSnapshot {
  artifact: typeof M1_TACTICAL_FEATURE_ARTIFACT;
  instrument: string;
  decisionTime: Date;
  latestM1OpenTime: Date;
  price: number;
  atr14: number;
  rsi14: number;
  bodyRangeRatio: number;
  upperWickRatio: number;
  lowerWickRatio: number;
  closeLocation: number;
  ema9: number;
  ema21: number;
  emaSeparationAtr: number;
  emaSlopeAtr: number;
  momentum1Atr: number;
  momentum3Atr: number;
  momentum5Atr: number;
  m5BodyPressure3: number;
  m5Momentum1Atr: number;
  m5Momentum3Atr: number;
  breakoutUpAtr: number;
  breakoutDownAtr: number;
  failedBreakoutUp: boolean;
  failedBreakoutDown: boolean;
  efficiency5: number;
  volatilityChange: number;
  extensionAtr: number;
  volatilityScore: number;
  session: AdaptiveMarketSession;
  alignment: {
    m5: number;
    m15: number;
    h1: number;
    h4: number;
  };
  higherTimeframeAgreement: number;
}

const MIN_M1_BARS = 30;
const MIN_CONTEXT_BARS = 22;
const BREAKOUT_LOOKBACK = 20;
const MINUTE_MS = 60_000;
const MAX_DERIVED_NO_TICK_MINUTES = 10;
const M1_FEATURE_HISTORY_BARS = 60;

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

function numbers(row: LivePaperCandleInput): [number, number, number, number] {
  return [Number(row.open), Number(row.high), Number(row.low), Number(row.close)];
}

function validSeries(rows: LivePaperCandleInput[]): boolean {
  let previous = Number.NEGATIVE_INFINITY;
  for (const row of rows) {
    const timestamp = new Date(row.timestamp).getTime();
    const [open, high, low, close] = numbers(row);
    if (
      !Number.isFinite(timestamp) ||
      timestamp <= previous ||
      ![open, high, low, close].every((value) => Number.isFinite(value) && value > 0) ||
      high < Math.max(open, close) ||
      low > Math.min(open, close) ||
      high < low
    ) {
      return false;
    }
    previous = timestamp;
  }
  return true;
}

function completed(
  rows: LivePaperCandleInput[],
  minutes: number,
  decisionTime: Date,
): LivePaperCandleInput[] | null {
  if (!validSeries(rows)) return null;
  const decisionMs = decisionTime.getTime();
  if (!Number.isFinite(decisionMs)) return null;
  const durationMs = minutes * MINUTE_MS;
  return rows.filter((row) => new Date(row.timestamp).getTime() + durationMs <= decisionMs);
}

/**
 * cTrader only creates a trend bar when at least one tick arrived in that
 * period. Small timestamp gaps are therefore legitimate no-tick intervals,
 * not necessarily missing provider data. For feature calculation only, carry
 * the last observed broker close across at most ten missing minutes so the
 * one-minute feature grid remains time-consistent. These derived bars are
 * never persisted as broker evidence and never provide spread evidence.
 *
 * A larger gap is treated as a data outage/session discontinuity. Evidence
 * before that gap is discarded; at least MIN_M1_BARS must exist after the
 * discontinuity before the model can become ready again.
 */
function normalizeM1NoTickGaps(rows: LivePaperCandleInput[]): LivePaperCandleInput[] | null {
  if (rows.length === 0) return [];
  const normalized: LivePaperCandleInput[] = [{ ...rows[0]!, timestamp: new Date(rows[0]!.timestamp) }];

  for (let index = 1; index < rows.length; index += 1) {
    const current = rows[index]!;
    const previousRaw = rows[index - 1]!;
    const currentMs = new Date(current.timestamp).getTime();
    const previousMs = new Date(previousRaw.timestamp).getTime();
    const deltaMs = currentMs - previousMs;
    if (!Number.isFinite(deltaMs) || deltaMs <= 0 || deltaMs % MINUTE_MS !== 0) return null;

    const missingMinutes = deltaMs / MINUTE_MS - 1;
    if (missingMinutes > MAX_DERIVED_NO_TICK_MINUTES) {
      normalized.length = 0;
      normalized.push({ ...current, timestamp: new Date(current.timestamp) });
      continue;
    }

    const previousClose = previousRaw.close;
    for (let minute = 1; minute <= missingMinutes; minute += 1) {
      normalized.push({
        timestamp: new Date(previousMs + minute * MINUTE_MS),
        open: previousClose,
        high: previousClose,
        low: previousClose,
        close: previousClose,
      });
    }
    normalized.push({ ...current, timestamp: new Date(current.timestamp) });
  }

  return normalized.slice(-M1_FEATURE_HISTORY_BARS);
}

function emaSeries(values: number[], period: number): number[] {
  if (values.length === 0) return [];
  const alpha = 2 / (period + 1);
  const result = [values[0]!];
  for (let index = 1; index < values.length; index += 1) {
    result.push(values[index]! * alpha + result[index - 1]! * (1 - alpha));
  }
  return result;
}

function rsi(values: number[], period = 14): number {
  if (values.length <= period) return Number.NaN;
  let gain = 0;
  let loss = 0;
  for (let index = 1; index <= period; index += 1) {
    const delta = values[index]! - values[index - 1]!;
    if (delta >= 0) gain += delta;
    else loss -= delta;
  }
  gain /= period;
  loss /= period;
  for (let index = period + 1; index < values.length; index += 1) {
    const delta = values[index]! - values[index - 1]!;
    gain = (gain * (period - 1) + Math.max(0, delta)) / period;
    loss = (loss * (period - 1) + Math.max(0, -delta)) / period;
  }
  if (loss === 0) return gain > 0 ? 100 : 50;
  const rs = gain / loss;
  return 100 - 100 / (1 + rs);
}

function atr(rows: LivePaperCandleInput[], period = 14): number {
  if (rows.length <= period) return Number.NaN;
  const ranges: number[] = [];
  for (let index = 1; index < rows.length; index += 1) {
    const [, high, low] = numbers(rows[index]!);
    const previousClose = Number(rows[index - 1]!.close);
    ranges.push(
      Math.max(high - low, Math.abs(high - previousClose), Math.abs(low - previousClose)),
    );
  }
  if (ranges.length < period) return Number.NaN;
  let value = ranges.slice(0, period).reduce((sum, current) => sum + current, 0) / period;
  for (let index = period; index < ranges.length; index += 1) {
    value = (value * (period - 1) + ranges[index]!) / period;
  }
  return value;
}

function trendAlignment(rows: LivePaperCandleInput[]): number {
  const closes = rows.map((row) => Number(row.close));
  const localAtr = atr(rows, 14);
  if (!Number.isFinite(localAtr) || localAtr <= 0) return Number.NaN;
  const ema9 = emaSeries(closes, 9).at(-1)!;
  const ema21 = emaSeries(closes, 21).at(-1)!;
  return clamp((ema9 - ema21) / localAtr, -1, 1);
}

function averageRange(rows: LivePaperCandleInput[]): number {
  if (rows.length === 0) return 0;
  return (
    rows.reduce((sum, row) => {
      const [, high, low] = numbers(row);
      return sum + (high - low);
    }, 0) / rows.length
  );
}

function averageSignedBodyPressure(rows: LivePaperCandleInput[]): number {
  if (rows.length === 0) return 0;
  const pressure = rows.reduce((sum, row) => {
    const [open, high, low, close] = numbers(row);
    const range = high - low;
    return sum + (range > 0 ? clamp((close - open) / range, -1, 1) : 0);
  }, 0);
  return clamp(pressure / rows.length, -1, 1);
}

export function buildM1TacticalFeatures(
  input: M1TacticalFeatureInput,
): M1TacticalFeatureSnapshot | null {
  const instrument = input.instrument.trim().toUpperCase();
  if (!instrument || !Number.isFinite(input.decisionTime.getTime())) return null;

  const completedM1 = completed(input.m1, 1, input.decisionTime);
  const m1 = completedM1 ? normalizeM1NoTickGaps(completedM1) : null;
  const m5 = completed(input.m5, 5, input.decisionTime);
  const m15 = completed(input.m15, 15, input.decisionTime);
  const h1 = completed(input.h1, 60, input.decisionTime);
  const h4 = completed(input.h4, 240, input.decisionTime);
  if (!m1 || !m5 || !m15 || !h1 || !h4) return null;
  if (
    m1.length < MIN_M1_BARS ||
    m5.length < MIN_CONTEXT_BARS ||
    m15.length < MIN_CONTEXT_BARS ||
    h1.length < MIN_CONTEXT_BARS ||
    h4.length < MIN_CONTEXT_BARS
  ) {
    return null;
  }

  const closes = m1.map((row) => Number(row.close));
  const localAtr = atr(m1, 14);
  const localRsi = rsi(closes, 14);
  const ema9Series = emaSeries(closes, 9);
  const ema21Series = emaSeries(closes, 21);
  const ema9 = ema9Series.at(-1)!;
  const ema21 = ema21Series.at(-1)!;
  if (![localAtr, localRsi, ema9, ema21].every(Number.isFinite) || localAtr <= 0) return null;

  const latest = m1.at(-1)!;
  const [open, high, low, close] = numbers(latest);
  const range = high - low;
  if (!Number.isFinite(range) || range < 0) return null;

  const previousTwenty = m1.slice(-(BREAKOUT_LOOKBACK + 1), -1);
  if (previousTwenty.length < BREAKOUT_LOOKBACK) return null;
  const priorHigh = Math.max(...previousTwenty.map((row) => Number(row.high)));
  const priorLow = Math.min(...previousTwenty.map((row) => Number(row.low)));
  const breakoutUpAtr = Math.max(0, (close - priorHigh) / localAtr);
  const breakoutDownAtr = Math.max(0, (priorLow - close) / localAtr);

  const momentum = (bars: number): number => {
    const prior = closes[closes.length - 1 - bars];
    return prior == null ? Number.NaN : (close - prior) / localAtr;
  };
  const momentum1Atr = momentum(1);
  const momentum3Atr = momentum(3);
  const momentum5Atr = momentum(5);

  const m5Closes = m5.map((row) => Number(row.close));
  const m5Atr = atr(m5, 14);
  if (!Number.isFinite(m5Atr) || m5Atr <= 0) return null;
  const m5Momentum = (bars: number): number => {
    const current = m5Closes.at(-1);
    const prior = m5Closes[m5Closes.length - 1 - bars];
    return current == null || prior == null ? Number.NaN : (current - prior) / m5Atr;
  };
  const m5Momentum1Atr = m5Momentum(1);
  const m5Momentum3Atr = m5Momentum(3);
  const m5BodyPressure3 = averageSignedBodyPressure(m5.slice(-3));

  const efficiencyCloses = closes.slice(-6);
  const path = efficiencyCloses
    .slice(1)
    .reduce((sum, value, index) => sum + Math.abs(value - efficiencyCloses[index]!), 0);
  const displacement = Math.abs(efficiencyCloses.at(-1)! - efficiencyCloses[0]!);
  const efficiency5 = path > 0 ? clamp(displacement / path, 0, 1) : 0;

  const recentRange = averageRange(m1.slice(-5));
  const previousRange = averageRange(m1.slice(-10, -5));
  const volatilityChange = previousRange > 0 ? clamp(recentRange / previousRange - 1, -2, 2) : 0;

  const alignment = {
    m5: trendAlignment(m5),
    m15: trendAlignment(m15),
    h1: trendAlignment(h1),
    h4: trendAlignment(h4),
  };
  if (!Object.values(alignment).every(Number.isFinite)) return null;

  const upperWick = high - Math.max(open, close);
  const lowerWick = Math.min(open, close) - low;
  const flatLatestBar = range === 0;
  const emaSlopeAtr = (ema9Series.at(-1)! - ema9Series.at(-2)!) / localAtr;
  const emaSeparationAtr = (ema9 - ema21) / localAtr;
  const higherTimeframeAgreement = clamp(
    (alignment.m5 + alignment.m15 + alignment.h1 + alignment.h4) / 4,
    -1,
    1,
  );

  const finiteOutputs = [
    momentum1Atr,
    momentum3Atr,
    momentum5Atr,
    m5BodyPressure3,
    m5Momentum1Atr,
    m5Momentum3Atr,
    efficiency5,
    volatilityChange,
    emaSlopeAtr,
    emaSeparationAtr,
    higherTimeframeAgreement,
  ];
  if (!finiteOutputs.every(Number.isFinite)) return null;

  return {
    artifact: M1_TACTICAL_FEATURE_ARTIFACT,
    instrument,
    decisionTime: new Date(input.decisionTime),
    latestM1OpenTime: new Date(latest.timestamp),
    price: close,
    atr14: localAtr,
    rsi14: localRsi,
    bodyRangeRatio: flatLatestBar ? 0 : Math.abs(close - open) / range,
    upperWickRatio: flatLatestBar ? 0 : Math.max(0, upperWick) / range,
    lowerWickRatio: flatLatestBar ? 0 : Math.max(0, lowerWick) / range,
    closeLocation: flatLatestBar ? 0.5 : clamp((close - low) / range, 0, 1),
    ema9,
    ema21,
    emaSeparationAtr,
    emaSlopeAtr,
    momentum1Atr,
    momentum3Atr,
    momentum5Atr,
    m5BodyPressure3,
    m5Momentum1Atr,
    m5Momentum3Atr,
    breakoutUpAtr,
    breakoutDownAtr,
    failedBreakoutUp: high > priorHigh && close < priorHigh,
    failedBreakoutDown: low < priorLow && close > priorLow,
    efficiency5,
    volatilityChange,
    extensionAtr: Math.abs(close - ema21) / localAtr,
    volatilityScore: clamp(localAtr / close / 0.0015, 0, 1),
    session: adaptiveMarketSession(input.decisionTime),
    alignment,
    higherTimeframeAgreement,
  };
}
