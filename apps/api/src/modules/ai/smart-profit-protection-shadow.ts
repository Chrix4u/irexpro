/**
 * Causal, BROKER-NATIVE, read-only post-entry exit comparison.
 *
 * A bar's close becomes visible ONLY after its full timeframe has elapsed.
 * Alternative exits are filled hypothetically at the NEXT validated M1
 * bid/ask CLOSE (not the trigger close). The broker may not actually fill at
 * these prices. This is a research comparison, never broker stop or order logic.
 *
 * Settled commissions/swaps are used ONLY to SCORE completed scenarios.
 * They are not read in entry or exit signal decisions (avoids fee look-ahead).
 */
export const SMART_PROTECTION_SHADOW_VERSION = 'smart-protection-replay-v1' as const;
export const SMART_PROTECTION_POLICIES = [
  'SIMPLE_FULL_TRAIL',
  'QUARTER_PARTIAL_RUNNER',
  'CONFIRMED_TREND_EXIT',
  'STAGED_PARTIAL_TREND_RUNNER',
] as const;
export type SmartProtectionPolicy = (typeof SMART_PROTECTION_POLICIES)[number];

export interface SmartProtectionCandle {
  timeframe: 'M1' | 'M5' | 'M15';
  bucket_time: Date | string;
  source: string;
  close: string | number | null;
  bid_close: string | number | null;
  ask_close: string | number | null;
  sample_count: number | string;
  positive_quote_sample_count: number | string;
  last_quote_sample_at: Date | string | null;
}

export interface SmartProtectionTrade {
  instrument: string;
  direction: 'BUY' | 'SELL';
  strategyRoute: string | null;
  openedAt: Date;
  closedAt: Date;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  exitPrice: number;
  initialRiskCash: number;
  settledGrossPnl: number;
  settledCommission: number;
  settledSwap: number;
  candles: SmartProtectionCandle[];
}

export interface SmartProtectionCounterfactual {
  policy: SmartProtectionPolicy;
  action: 'NO_SIGNAL' | 'FULL_EXIT' | 'PARTIAL_AND_HOLD' | 'PARTIAL_AND_EXIT';
  firstActionAt: string | null;
  hypotheticalFillAt: string | null;
  /** The simulation values only validated completed bid/ask M1 bar closes. */
  hypotheticalNetPnl: number;
  deltaVsActualNet: number;
  truncatedActualTpWinner: boolean;
  improvedActualNetLoser: boolean;
  noFillSignals: number;
}

export interface SmartProtectionReplayResult {
  version: typeof SMART_PROTECTION_SHADOW_VERSION;
  executionAuthority: 'NONE';
  modifiesExecution: false;
  promotionEligible: false;
  instrument: string;
  direction: 'BUY' | 'SELL';
  strategyRoute: string | null;
  dataQuality:
    | 'COMPLETE'
    | 'PARTIAL_QUOTE_COVERAGE'
    | 'INSUFFICIENT_CAUSAL_MARKS'
    | 'INVALID_TRADE';
  quoteCoverage: number;
  causalM1Marks: number;
  missingM1Minutes: number;
  contextualM5Bars: number;
  contextualM15Bars: number;
  actualNetPnl: number;
  actualTpWinner: boolean;
  /** Not proof a live stop or partial close could be filled. */
  alternatives: SmartProtectionCounterfactual[];
}

interface Mark {
  at: number;
  price: number;
  r: number;
}
interface Context {
  at: number;
  close: number;
}
interface Fill {
  at: number;
  signalAt: number;
  r: number;
}
const ONE_MINUTE = 60_000;
const contextMs = { M5: 5 * ONE_MINUTE, M15: 15 * ONE_MINUTE } as const;

function positiveFinite(value: unknown): number | null {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}
function time(value: Date | string | null): number {
  if (value == null) return NaN;
  return new Date(value).getTime();
}
function round(value: number): number {
  const rounded = Math.round((value + Number.EPSILON) * 100) / 100;
  return Object.is(rounded, -0) ? 0 : rounded;
}
function priceDirection(direction: 'BUY' | 'SELL'): number {
  return direction === 'BUY' ? 1 : -1;
}

function timeline(trade: SmartProtectionTrade) {
  const direction = priceDirection(trade.direction);
  const priceRisk = direction * (trade.entryPrice - trade.stopLoss);
  if (
    !Number.isFinite(trade.openedAt.getTime()) ||
    !Number.isFinite(trade.closedAt.getTime()) ||
    trade.closedAt <= trade.openedAt ||
    !/^[A-Z]{6}$/.test(trade.instrument) ||
    !Number.isFinite(trade.entryPrice) ||
    !Number.isFinite(trade.stopLoss) ||
    !Number.isFinite(trade.exitPrice) ||
    !Number.isFinite(trade.takeProfit) ||
    !Number.isFinite(trade.initialRiskCash) ||
    !Number.isFinite(trade.settledGrossPnl) ||
    !Number.isFinite(trade.settledCommission) ||
    !Number.isFinite(trade.settledSwap) ||
    trade.entryPrice <= 0 ||
    trade.stopLoss <= 0 ||
    trade.takeProfit <= 0 ||
    trade.initialRiskCash <= 0 ||
    priceRisk <= 0 ||
    direction * (trade.takeProfit - trade.entryPrice) <= 0
  ) {
    return null;
  }
  const marks: Mark[] = [];
  const context = { M5: [] as Context[], M15: [] as Context[] };
  const seen = new Set<string>();
  for (const candle of trade.candles) {
    if (candle.source !== 'ctrader-broker-native') continue;
    const started = time(candle.bucket_time);
    const period = candle.timeframe === 'M1' ? ONE_MINUTE : contextMs[candle.timeframe];
    const closed = started + period;
    if (
      !Number.isFinite(started) ||
      started % ONE_MINUTE !== 0 ||
      (candle.timeframe === 'M1' && closed <= trade.openedAt.getTime()) ||
      closed >= trade.closedAt.getTime() ||
      seen.has(`${candle.timeframe}:${started}`)
    )
      continue;
    const samples = Number(candle.sample_count);
    if (!Number.isSafeInteger(samples) || samples <= 0) continue;
    if (candle.timeframe !== 'M1') {
      const close = positiveFinite(candle.close);
      if (close == null) continue;
      context[candle.timeframe].push({ at: closed, close });
      seen.add(`${candle.timeframe}:${started}`);
      continue;
    }
    const quotes = Number(candle.positive_quote_sample_count);
    const lastSample = time(candle.last_quote_sample_at);
    const bid = positiveFinite(candle.bid_close);
    const ask = positiveFinite(candle.ask_close);
    if (
      !Number.isSafeInteger(quotes) ||
      quotes <= 0 ||
      quotes > samples ||
      !Number.isFinite(lastSample) ||
      lastSample < started ||
      lastSample >= closed ||
      bid == null ||
      ask == null ||
      ask < bid
    )
      continue;
    const price = trade.direction === 'BUY' ? bid : ask;
    const r = (direction * (price - trade.entryPrice)) / priceRisk;
    if (!Number.isFinite(r)) continue;
    marks.push({ at: closed, price, r });
    seen.add(`M1:${started}`);
  }
  marks.sort((a, b) => a.at - b.at);
  context.M5.sort((a, b) => a.at - b.at);
  context.M15.sort((a, b) => a.at - b.at);
  const firstWholeMinute = Math.ceil(trade.openedAt.getTime() / ONE_MINUTE) * ONE_MINUTE;
  const lastWholeMinute = Math.floor(trade.closedAt.getTime() / ONE_MINUTE) * ONE_MINUTE;
  const possibleBars = Math.max(0, (lastWholeMinute - firstWholeMinute) / ONE_MINUTE);
  const quoteCoverage = possibleBars ? Math.min(1, marks.length / possibleBars) : 0;
  return { marks, context, quoteCoverage, possibleBars, direction, priceRisk };
}

/** Time-causal last-three-completed-bars direction. No in-progress HTF bar. */
function contextState(
  frame: Context[],
  at: number,
  direction: number,
): 'ALIGNED' | 'ADVERSE' | 'UNKNOWN' {
  const prior = frame.filter((c) => c.at <= at);
  if (prior.length < 3) return 'UNKNOWN';
  const recent = prior.slice(-3);
  if (at - recent[2]!.at > 2 * (recent[2]!.at - recent[1]!.at)) return 'UNKNOWN';
  const slope = direction * (recent[2]!.close - recent[0]!.close);
  if (slope < 0) return 'ADVERSE';
  return 'ALIGNED';
}

function nextFill(marks: Mark[], triggerIndex: number): Fill | null {
  const current = marks[triggerIndex];
  const next = marks[triggerIndex + 1];
  if (!current || !next || next.at <= current.at || next.at - current.at > 90_000) {
    return null;
  }
  return { at: next.at, signalAt: current.at, r: next.r };
}

export function replaySmartProfitProtection(
  trade: SmartProtectionTrade,
): SmartProtectionReplayResult {
  const actualNetPnl = round(trade.settledGrossPnl + trade.settledCommission + trade.settledSwap);
  const priceTolerance = trade.instrument.endsWith('JPY') ? 0.001 : 0.00001;
  const actualTpWinner =
    trade.settledGrossPnl > 0 &&
    Number.isFinite(trade.exitPrice) &&
    (trade.direction === 'BUY'
      ? trade.exitPrice >= trade.takeProfit - priceTolerance
      : trade.exitPrice <= trade.takeProfit + priceTolerance);
  const parsed = timeline(trade);
  const quality: SmartProtectionReplayResult['dataQuality'] = !parsed
    ? 'INVALID_TRADE'
    : parsed.marks.length < 5
      ? 'INSUFFICIENT_CAUSAL_MARKS'
      : parsed.quoteCoverage < 0.95
        ? 'PARTIAL_QUOTE_COVERAGE'
        : 'COMPLETE';
  const marks = parsed?.marks ?? [];
  const context = parsed?.context ?? { M5: [], M15: [] };
  const fills: Partial<Record<SmartProtectionPolicy, Fill>> = {};
  let highest = 0;
  let partialTriggered = false;
  let consecutiveAdverseM1 = 0;
  const noFill: Record<SmartProtectionPolicy, number> = {
    SIMPLE_FULL_TRAIL: 0,
    QUARTER_PARTIAL_RUNNER: 0,
    CONFIRMED_TREND_EXIT: 0,
    STAGED_PARTIAL_TREND_RUNNER: 0,
  };
  // Each decision uses only this or preceding *fully closed* M1/HTF bars.
  // A hypothetical action may fill ONLY at the next fully closed quoted M1.
  for (let i = 0; i < marks.length; i += 1) {
    const mark = marks[i]!;
    const previous = marks[i - 1];
    highest = Math.max(highest, mark.r);
    if (previous && mark.at - previous.at === ONE_MINUTE && previous.r - mark.r >= 0.02) {
      consecutiveAdverseM1 += 1;
    } else {
      consecutiveAdverseM1 = 0;
    }
    if (!partialTriggered && highest >= 0.5) {
      partialTriggered = true;
      const fill = nextFill(marks, i);
      if (fill) fills.QUARTER_PARTIAL_RUNNER = fill;
      else noFill.QUARTER_PARTIAL_RUNNER += 1;
    }
    if (!fills.SIMPLE_FULL_TRAIL && highest >= 0.5 && mark.r <= 0.25) {
      const fill = nextFill(marks, i);
      if (fill) fills.SIMPLE_FULL_TRAIL = fill;
      else noFill.SIMPLE_FULL_TRAIL += 1;
    }
    if (
      !fills.CONFIRMED_TREND_EXIT &&
      highest >= 0.5 &&
      highest - mark.r >= 0.25 &&
      consecutiveAdverseM1 >= 2 &&
      contextState(context.M5, mark.at, parsed!.direction) === 'ADVERSE' &&
      contextState(context.M15, mark.at, parsed!.direction) === 'ADVERSE'
    ) {
      const fill = nextFill(marks, i);
      if (fill) fills.CONFIRMED_TREND_EXIT = fill;
      else noFill.CONFIRMED_TREND_EXIT += 1;
    }
  }
  const partial = fills.QUARTER_PARTIAL_RUNNER;
  const trend = fills.CONFIRMED_TREND_EXIT;
  if (partial && trend && trend.at > partial.at) {
    fills.STAGED_PARTIAL_TREND_RUNNER = trend;
  }
  const alternatives: SmartProtectionCounterfactual[] = SMART_PROTECTION_POLICIES.map((policy) => {
    let action: SmartProtectionCounterfactual['action'] = 'NO_SIGNAL';
    let signal: Fill | undefined;
    let gross = trade.settledGrossPnl;
    if (quality !== 'INVALID_TRADE' && marks.length >= 5) {
      if (policy === 'SIMPLE_FULL_TRAIL') {
        signal = fills.SIMPLE_FULL_TRAIL;
        if (signal) {
          action = 'FULL_EXIT';
          gross = signal.r * trade.initialRiskCash;
        }
      } else if (policy === 'QUARTER_PARTIAL_RUNNER') {
        signal = partial;
        if (signal) {
          action = 'PARTIAL_AND_HOLD';
          gross = 0.25 * signal.r * trade.initialRiskCash + 0.75 * trade.settledGrossPnl;
        }
      } else if (policy === 'CONFIRMED_TREND_EXIT') {
        signal = trend;
        if (signal) {
          action = 'FULL_EXIT';
          gross = signal.r * trade.initialRiskCash;
        }
      } else if (policy === 'STAGED_PARTIAL_TREND_RUNNER') {
        signal = partial;
        if (partial) {
          action = 'PARTIAL_AND_HOLD';
          gross = 0.25 * partial.r * trade.initialRiskCash + 0.75 * trade.settledGrossPnl;
          if (fills.STAGED_PARTIAL_TREND_RUNNER) {
            const exit = fills.STAGED_PARTIAL_TREND_RUNNER!;
            action = 'PARTIAL_AND_EXIT';
            gross =
              0.25 * partial.r * trade.initialRiskCash + 0.75 * exit.r * trade.initialRiskCash;
            signal = exit;
          }
        }
      }
    }
    const hypotheticalNetPnl = round(gross + trade.settledCommission + trade.settledSwap);
    const fullExit = action === 'FULL_EXIT' || action === 'PARTIAL_AND_EXIT';
    return {
      policy,
      action,
      firstActionAt:
        policy === 'STAGED_PARTIAL_TREND_RUNNER' && partial
          ? new Date(partial.signalAt).toISOString()
          : signal
            ? new Date(signal.signalAt).toISOString()
            : null,
      hypotheticalFillAt: signal ? new Date(signal.at).toISOString() : null,
      hypotheticalNetPnl,
      deltaVsActualNet: round(hypotheticalNetPnl - actualNetPnl),
      truncatedActualTpWinner: Boolean(fullExit && actualTpWinner),
      improvedActualNetLoser: actualNetPnl < 0 && hypotheticalNetPnl > actualNetPnl,
      noFillSignals: noFill[policy],
    };
  });
  return {
    version: SMART_PROTECTION_SHADOW_VERSION,
    executionAuthority: 'NONE',
    modifiesExecution: false,
    promotionEligible: false,
    instrument: trade.instrument,
    direction: trade.direction,
    strategyRoute: trade.strategyRoute,
    dataQuality: quality,
    quoteCoverage: round((parsed?.quoteCoverage ?? 0) * 100) / 100,
    causalM1Marks: marks.length,
    missingM1Minutes: parsed ? Math.max(0, parsed.possibleBars - marks.length) : 0,
    contextualM5Bars: context.M5.length,
    contextualM15Bars: context.M15.length,
    actualNetPnl,
    actualTpWinner,
    alternatives,
  };
}
