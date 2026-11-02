export const SIDE_SELECTION_PATTERN_TELEMETRY_ARTIFACT =
  'side-selection-pattern-telemetry-v1' as const;

type Direction = 'BUY' | 'SELL';

export interface PatternCandle {
  timestamp: Date | string;
  open: string | number;
  high: string | number;
  low: string | number;
  close: string | number;
}

export interface PatternInput {
  candles: PatternCandle[];
  direction: Direction;
  atr: number;
  decisionBarTime: Date | string;
  mtfStrength: number;
  h1Alignment: number;
  h4Alignment: number;
}

interface Bar {
  timestamp: Date;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface SideSelectionPatternTelemetry {
  artifact: typeof SIDE_SELECTION_PATTERN_TELEMETRY_ARTIFACT;
  available: boolean;
  reason: 'OK' | 'INVALID_ATR' | 'INVALID_DECISION_TIME' | 'INSUFFICIENT_CLOSED_CANDLES';
  executionAuthority: 'NONE';
  modifiesExecution: false;
  decisionBarTime: string | null;
  baseBarsUsed: number;
  raw: null | Record<string, number>;
  aligned: null | Record<string, number>;
  context: { mtfStrength: number; h1Alignment: number; h4Alignment: number };
}

const finite = (value: unknown): number | null => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const safe = (value: number) => (Number.isFinite(value) ? value : 0);

function ema(values: number[], period: number): number {
  const k = 2 / (period + 1);
  let value = values[0]!;
  for (let index = 1; index < values.length; index += 1) {
    value = values[index]! * k + value * (1 - k);
  }
  return value;
}
function normalize(rows: PatternCandle[], decisionMs: number): Bar[] {
  return rows
    .map((row) => {
      const timestamp = new Date(row.timestamp);
      const open = finite(row.open);
      const high = finite(row.high);
      const low = finite(row.low);
      const close = finite(row.close);
      if (
        !Number.isFinite(timestamp.getTime()) ||
        timestamp.getTime() > decisionMs ||
        open == null ||
        high == null ||
        low == null ||
        close == null ||
        high < Math.max(open, close) ||
        low > Math.min(open, close)
      ) {
        return null;
      }
      return { timestamp, open, high, low, close };
    })
    .filter((row): row is Bar => row !== null)
    .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
}

function pressure(rows: Bar[], bars: number, atr: number): number {
  return rows.slice(-bars).reduce((sum, row) => sum + row.close - row.open, 0) / (bars * atr);
}

function directionalRun(rows: Bar[]): number {
  const latest = rows.at(-1)!;
  const sign = Math.sign(latest.close - latest.open);
  if (!sign) return 0;
  let count = 0;
  for (let index = rows.length - 1; index >= 0 && count < 6; index -= 1) {
    if (Math.sign(rows[index]!.close - rows[index]!.open) !== sign) break;
    count += 1;
  }
  return sign * count;
}

function pathEfficiency(rows: Bar[]): number {
  const tail = rows.slice(-7);
  const net = tail.at(-1)!.close - tail[0]!.close;
  let travelled = 0;
  for (let index = 1; index < tail.length; index += 1) {
    travelled += Math.abs(tail[index]!.close - tail[index - 1]!.close);
  }
  return travelled > 0 ? clamp(net / travelled, -1, 1) : 0;
}

function unavailable(
  input: PatternInput,
  reason: Exclude<SideSelectionPatternTelemetry['reason'], 'OK'>,
  decisionBarTime: string | null,
  baseBarsUsed = 0,
): SideSelectionPatternTelemetry {
  return {
    artifact: SIDE_SELECTION_PATTERN_TELEMETRY_ARTIFACT,
    available: false,
    reason,
    executionAuthority: 'NONE',
    modifiesExecution: false,
    decisionBarTime,
    baseBarsUsed,
    raw: null,
    aligned: null,
    context: {
      mtfStrength: safe(input.mtfStrength),
      h1Alignment: safe(input.h1Alignment),
      h4Alignment: safe(input.h4Alignment),
    },
  };
}
export function buildSideSelectionPatternTelemetry(
  input: PatternInput,
): SideSelectionPatternTelemetry {
  if (!Number.isFinite(input.atr) || input.atr <= 0) {
    return unavailable(input, 'INVALID_ATR', null);
  }
  const decisionBarTime = new Date(input.decisionBarTime);
  if (!Number.isFinite(decisionBarTime.getTime())) {
    return unavailable(input, 'INVALID_DECISION_TIME', null);
  }
  const decisionIso = decisionBarTime.toISOString();
  const rows = normalize(input.candles, decisionBarTime.getTime());
  if (rows.length < 21) {
    return unavailable(input, 'INSUFFICIENT_CLOSED_CANDLES', decisionIso, rows.length);
  }

  const closes = rows.map((row) => row.close);
  const latest = rows.at(-1)!;
  const latestRange = Math.max(0, latest.high - latest.low);
  const safeRange = latestRange > 0 ? latestRange : input.atr;
  const priorRanges = rows.slice(-7, -1).map((row) => Math.max(0, row.high - row.low));
  const averagePriorRange = priorRanges.reduce((sum, value) => sum + value, 0) / priorRanges.length;
  const priorBreakout = rows.slice(-13, -1);
  const priorHigh = Math.max(...priorBreakout.map((row) => row.high));
  const priorLow = Math.min(...priorBreakout.map((row) => row.low));
  const upperWick = Math.max(0, latest.high - Math.max(latest.open, latest.close));
  const lowerWick = Math.max(0, Math.min(latest.open, latest.close) - latest.low);
  const raw = {
    momentum1Atr: (latest.close - closes.at(-2)!) / input.atr,
    momentum3Atr: (latest.close - closes.at(-4)!) / input.atr,
    momentum6Atr: (latest.close - closes.at(-7)!) / input.atr,
    emaSeparationAtr: (ema(closes, 9) - ema(closes, 21)) / input.atr,
    ema9SlopeAtr: (ema(closes, 9) - ema(closes.slice(0, -1), 9)) / input.atr,
    latestBodyAtr: (latest.close - latest.open) / input.atr,
    latestRangeAtr: latestRange / input.atr,
    closeLocation: clamp((latest.close - latest.low) / safeRange, 0, 1),
    upperWickRatio: clamp(upperWick / safeRange, 0, 1),
    lowerWickRatio: clamp(lowerWick / safeRange, 0, 1),
    bodyPressure3: pressure(rows, 3, input.atr),
    bodyPressure6: pressure(rows, 6, input.atr),
    directionalRun: directionalRun(rows),
    pathEfficiency6: pathEfficiency(rows),
    rangeExpansionRatio:
      averagePriorRange > 0 ? latestRange / averagePriorRange : latestRange / input.atr,
    breakoutUpAtr: (latest.close - priorHigh) / input.atr,
    breakoutDownAtr: (priorLow - latest.close) / input.atr,
  };
  const sign = input.direction === 'BUY' ? 1 : -1;
  const aligned = {
    momentum1Atr: sign * raw.momentum1Atr,
    momentum3Atr: sign * raw.momentum3Atr,
    momentum6Atr: sign * raw.momentum6Atr,
    emaSeparationAtr: sign * raw.emaSeparationAtr,
    ema9SlopeAtr: sign * raw.ema9SlopeAtr,
    bodyPressure3: sign * raw.bodyPressure3,
    bodyPressure6: sign * raw.bodyPressure6,
    directionalRun: sign * raw.directionalRun,
    pathEfficiency6: sign * raw.pathEfficiency6,
    closePressure: sign * ((raw.closeLocation - 0.5) * 2),
    wickSupport: sign * (raw.lowerWickRatio - raw.upperWickRatio),
    breakoutAtr: input.direction === 'BUY' ? raw.breakoutUpAtr : raw.breakoutDownAtr,
  };

  return {
    artifact: SIDE_SELECTION_PATTERN_TELEMETRY_ARTIFACT,
    available: true,
    reason: 'OK',
    executionAuthority: 'NONE',
    modifiesExecution: false,
    decisionBarTime: decisionIso,
    baseBarsUsed: rows.length,
    raw,
    aligned,
    context: {
      mtfStrength: safe(input.mtfStrength),
      h1Alignment: safe(input.h1Alignment),
      h4Alignment: safe(input.h4Alignment),
    },
  };
}
