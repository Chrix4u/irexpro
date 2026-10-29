export type LiveScanStageId =
  | 'IDLE'
  | 'MARKET_FEED'
  | 'FEATURES'
  | 'MODELS'
  | 'RISK_DRIFT'
  | 'EXECUTION_GATE';

export interface LiveScanStage {
  id: LiveScanStageId;
  label: string;
  detail: string;
}

export const LIVE_SCAN_STAGES: readonly LiveScanStage[] = [
  {
    id: 'MARKET_FEED',
    label: 'Market feed',
    detail: 'Reading broker-native quotes and the newest M1 evidence.',
  },
  {
    id: 'FEATURES',
    label: 'Feature extraction',
    detail: 'Updating momentum, volatility, structure and multi-timeframe context.',
  },
  {
    id: 'MODELS',
    label: 'Model routes',
    detail: 'Scoring transition, continuation and reversal candidates.',
  },
  {
    id: 'RISK_DRIFT',
    label: 'Risk & drift',
    detail: 'Checking expectancy, reliability, drift and account protection gates.',
  },
  {
    id: 'EXECUTION_GATE',
    label: 'Execution gate',
    detail: 'Confirming whether the current setup is eligible for dispatch.',
  },
] as const;

const IDLE_STAGE: LiveScanStage = {
  id: 'IDLE',
  label: 'Scanner idle',
  detail: 'Start AI Trading to begin continuous market evaluation.',
};

export interface LiveScanFrame {
  stage: LiveScanStage;
  stageIndex: number;
  sweepPercent: number;
}

export function deriveLiveScanFrame({
  tick,
  automationOn,
}: {
  tick: number;
  automationOn: boolean;
}): LiveScanFrame {
  if (!automationOn) {
    return { stage: IDLE_STAGE, stageIndex: -1, sweepPercent: 0 };
  }

  const safeTick = Math.max(0, Math.floor(Number.isFinite(tick) ? tick : 0));
  const stageIndex = safeTick % LIVE_SCAN_STAGES.length;
  const sweepCycle = safeTick % 20;
  const sweepPercent = sweepCycle <= 10 ? sweepCycle * 10 : (20 - sweepCycle) * 10;

  return {
    stage: LIVE_SCAN_STAGES[stageIndex]!,
    stageIndex,
    sweepPercent,
  };
}

const MIN_VISIBLE_CANDLES = 20;
const ZOOM_STEP = 10;

export function zoomChartWindow(
  currentVisible: number,
  direction: 'IN' | 'OUT',
  available: number,
): number {
  const safeAvailable = Math.max(MIN_VISIBLE_CANDLES, Math.floor(available || 0));
  const current = Math.max(
    MIN_VISIBLE_CANDLES,
    Math.min(safeAvailable, Math.floor(currentVisible || MIN_VISIBLE_CANDLES)),
  );
  const next = direction === 'IN' ? current - ZOOM_STEP : current + ZOOM_STEP;
  return Math.max(MIN_VISIBLE_CANDLES, Math.min(safeAvailable, next));
}

export function shiftChartWindow(
  currentOffset: number,
  direction: 'BACK' | 'FORWARD',
  visible: number,
  available: number,
): number {
  const maxOffset = Math.max(0, Math.floor(available) - Math.max(1, Math.floor(visible)));
  const current = Math.max(0, Math.min(maxOffset, Math.floor(currentOffset || 0)));
  const next = direction === 'BACK' ? current + ZOOM_STEP : current - ZOOM_STEP;
  return Math.max(0, Math.min(maxOffset, next));
}

export function selectChartWindow<T>(
  rows: readonly T[],
  visible: number,
  offsetFromLatest: number,
): T[] {
  if (!rows.length) return [];
  const safeVisible = Math.max(1, Math.min(rows.length, Math.floor(visible || rows.length)));
  const maxOffset = Math.max(0, rows.length - safeVisible);
  const safeOffset = Math.max(0, Math.min(maxOffset, Math.floor(offsetFromLatest || 0)));
  const end = rows.length - safeOffset;
  const start = Math.max(0, end - safeVisible);
  return rows.slice(start, end);
}

export interface LiveChartCandle {
  timestamp: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}

export interface LiveChartQuote {
  bid: string;
  ask: string;
  timestamp: string;
}

const TIMEFRAME_MS: Readonly<Record<string, number>> = Object.freeze({
  M1: 60_000,
  M5: 5 * 60_000,
  M15: 15 * 60_000,
  H1: 60 * 60_000,
  H4: 4 * 60 * 60_000,
});

function decimalPlaces(value: string): number {
  const dot = value.indexOf('.');
  return dot < 0 ? 0 : value.length - dot - 1;
}

function quoteMid(quote: LiveChartQuote): string | null {
  const bid = Number(quote.bid);
  const ask = Number(quote.ask);
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || ask < bid) return null;
  const precision = Math.max(decimalPlaces(quote.bid), decimalPlaces(quote.ask));
  return ((bid + ask) / 2).toFixed(precision);
}

function timeframeBucket(timestampMs: number, timeframe: string): number | null {
  const interval = TIMEFRAME_MS[timeframe];
  if (!interval || !Number.isFinite(timestampMs)) return null;
  return Math.floor(timestampMs / interval) * interval;
}

/**
 * Adds a presentation-only forming candle from the freshest broker quote.
 *
 * The AI execution engine continues to use its own completed-candle feature
 * pipeline. This helper is deliberately confined to the web chart so a moving
 * candle cannot be mistaken for authoritative M5 reversal confirmation.
 */
export function mergeLiveQuoteIntoCandles(
  candles: readonly LiveChartCandle[],
  quote: LiveChartQuote | null | undefined,
  timeframe: string,
): LiveChartCandle[] {
  const rows = candles.map((candle) => ({ ...candle }));
  if (!quote) return rows;

  const quoteTimestamp = Date.parse(quote.timestamp);
  const quoteBucket = timeframeBucket(quoteTimestamp, timeframe);
  const mid = quoteMid(quote);
  if (quoteBucket == null || mid == null) return rows;

  const last = rows.at(-1);
  if (!last) {
    return [
      {
        timestamp: new Date(quoteBucket).toISOString(),
        open: mid,
        high: mid,
        low: mid,
        close: mid,
        volume: '0',
      },
    ];
  }

  const lastTimestamp = Date.parse(last.timestamp);
  const lastBucket = timeframeBucket(lastTimestamp, timeframe);
  if (lastBucket == null || quoteBucket < lastBucket) return rows;

  if (quoteBucket > lastBucket) {
    rows.push({
      timestamp: new Date(quoteBucket).toISOString(),
      open: mid,
      high: mid,
      low: mid,
      close: mid,
      volume: '0',
    });
    return rows;
  }

  const open = Number(last.open);
  const high = Number(last.high);
  const low = Number(last.low);
  const currentMid = Number(mid);
  if (![open, high, low, currentMid].every(Number.isFinite)) return rows;

  const precision = Math.max(
    decimalPlaces(last.open),
    decimalPlaces(last.high),
    decimalPlaces(last.low),
    decimalPlaces(mid),
  );
  rows[rows.length - 1] = {
    ...last,
    high: Math.max(high, currentMid).toFixed(precision),
    low: Math.min(low, currentMid).toFixed(precision),
    close: currentMid.toFixed(precision),
  };
  return rows;
}
