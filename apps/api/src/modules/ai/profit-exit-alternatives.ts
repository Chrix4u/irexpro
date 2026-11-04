/** Read-only comparison of early close, protected runner and partial close.
 * No broker order is created or modified by this module.
 */
export const EXIT_ALTERNATIVES_ARTIFACT = 'exit-alternatives-verified-m1-v1';
export type ExitOutcome = 'TP_FIRST' | 'STOP_FIRST' | 'AMBIGUOUS' | 'DATA_GAP' | 'UNRESOLVED' | 'INELIGIBLE';

export interface ExitCandle {
  bucket_time: Date | string;
  high: number | string;
  low: number | string;
  sample_count: number | string;
  positive_quote_sample_count: number | string;
  last_quote_sample_at: Date | string | null;
  source: string;
}
export interface ExitScenario {
  outcome: ExitOutcome;
  eventAt: string | null;
  observedBars: number;
  netPnlProxy: number | null;
  deltaVsOriginal: number | null;
}
export interface ExitScenarioInput {
  direction: 'BUY' | 'SELL';
  closeAt: Date;
  entryPrice: number;
  exitPrice: number;
  stopPrice: number;
  takeProfitPrice: number;
  runnerStopPrice: number | null;
  runnerEligible: boolean;
  grossPnl: number;
  commission: number;
  swap: number;
  candles: ExitCandle[];
}

export interface ExitAlternativesReport {
  mode: 'SHADOW_ONLY';
  modifiesExecution: false;
  originalNetPnl: number;
  recordedCosts: number;
  extraPartialCostAllowance: number;
  runner: ExitScenario;
  halfPartial: ExitScenario;
  methodology: 'CONTIGUOUS_LIVE_QUOTE_M1_MIDPOINT_PROXY';
}

const numeric = (value: unknown): number | null => {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
const rounded = (value: number): number => Number(value.toFixed(4));

function eligibleBar(raw: ExitCandle): { at: number; high: number; low: number } | null {
  const at = new Date(raw.bucket_time).getTime();
  const observed = raw.last_quote_sample_at
    ? new Date(raw.last_quote_sample_at).getTime()
    : NaN;
  const high = numeric(raw.high);
  const low = numeric(raw.low);
  const sampled = numeric(raw.sample_count);
  const live = numeric(raw.positive_quote_sample_count);
  if (
    !Number.isFinite(at) ||
    !Number.isFinite(observed) ||
    observed < at ||
    observed >= at + 60_000 ||
    high == null ||
    low == null ||
    high < low ||
    sampled == null ||
    sampled <= 0 ||
    live == null ||
    live <= 0 ||
    live > sampled ||
    raw.source !== 'ctrader-broker-native'
  ) return null;
  return { at, high, low };
}

function firstBarrier(input: ExitScenarioInput, stopPrice: number): ExitScenario {
  const empty = (outcome: ExitOutcome, observedBars: number): ExitScenario => ({
    outcome, eventAt: null, observedBars, netPnlProxy: null, deltaVsOriginal: null,
  });
  const bars = new Map<number, ReturnType<typeof eligibleBar>>();
  for (const row of input.candles) {
    const time = new Date(row.bucket_time).getTime();
    if (!Number.isFinite(time)) continue;
    if (bars.has(time)) {
      bars.set(time, null);
    } else {
      bars.set(time, eligibleBar(row));
    }
  }
  const start = Math.floor(input.closeAt.getTime() / 60_000) * 60_000 + 60_000;
  const horizon = input.closeAt.getTime() + 60 * 60_000;
  let observedBars = 0;
  for (let at = start; at + 60_000 <= horizon; at += 60_000) {
    const bar = bars.get(at);
    if (!bar) return empty('DATA_GAP', observedBars);
    observedBars++;
    const tp = input.direction === 'BUY'
      ? bar.high >= input.takeProfitPrice
      : bar.low <= input.takeProfitPrice;
    const stop = input.direction === 'BUY'
      ? bar.low <= stopPrice
      : bar.high >= stopPrice;
    if (tp && stop) return empty('AMBIGUOUS', observedBars);
    if (!tp && !stop) continue;
    return {
      outcome: tp ? 'TP_FIRST' : 'STOP_FIRST',
      eventAt: new Date(at).toISOString(),
      observedBars,
      netPnlProxy: null,
      deltaVsOriginal: null,
    };
  }
  return empty('UNRESOLVED', observedBars);
}

/**
 * The P&L/price relationship is only an estimated linear proxy.
 * Broker-side bid/ask fills, stop distance, commissions, FX and gaps can
 * materially change outcomes. This must never grant execution authority.
 */
export function compareExitAlternatives(input: ExitScenarioInput): ExitAlternativesReport {
  const costs = Math.abs(input.commission) - input.swap;
  const originalNet = input.grossPnl - costs;
  const extraPartialCost = Math.abs(input.commission) * 0.25;
  const none = (): ExitScenario => ({
    outcome: 'INELIGIBLE',
    eventAt: null,
    observedBars: 0,
    netPnlProxy: null,
    deltaVsOriginal: null,
  });
  const out: ExitAlternativesReport = {
    mode: 'SHADOW_ONLY',
    modifiesExecution: false,
    originalNetPnl: rounded(originalNet),
    recordedCosts: rounded(costs),
    extraPartialCostAllowance: rounded(extraPartialCost),
    runner: none(),
    halfPartial: none(),
    methodology: 'CONTIGUOUS_LIVE_QUOTE_M1_MIDPOINT_PROXY',
  };
  const sign = input.direction === 'BUY' ? 1 : -1;
  if (
    !Number.isFinite(input.closeAt.getTime()) ||
    ![
      input.entryPrice, input.exitPrice, input.stopPrice, input.takeProfitPrice,
      input.grossPnl, input.commission, input.swap,
    ].every(Number.isFinite) ||
    input.entryPrice <= 0 ||
    input.exitPrice <= 0 ||
    input.takeProfitPrice <= 0 ||
    input.stopPrice <= 0 ||
    input.grossPnl <= 0 ||
    sign * (input.exitPrice - input.entryPrice) <= 0 ||
    sign * (input.takeProfitPrice - input.exitPrice) <= 0 ||
    sign * (input.entryPrice - input.stopPrice) <= 0
  ) return out;
  const pnlAt = (price: number): number =>
    input.grossPnl * (price - input.entryPrice) / (input.exitPrice - input.entryPrice);
  const grade = (stopPrice: number, partial: boolean): ExitScenario => {
    const first = firstBarrier(input, stopPrice);
    if (first.outcome !== 'TP_FIRST' && first.outcome !== 'STOP_FIRST') return first;
    const price = first.outcome === 'TP_FIRST' ? input.takeProfitPrice : stopPrice;
    const gross = partial
      ? 0.5 * input.grossPnl + 0.5 * pnlAt(price)
      : pnlAt(price);
    const net = gross - costs - (partial ? extraPartialCost : 0);
    return {
      ...first,
      netPnlProxy: rounded(net),
      deltaVsOriginal: rounded(net - originalNet),
    };
  };

  // A hypothetical 50% early close and 50% remaining at the ORIGINAL SL/TP.
  out.halfPartial = grade(input.stopPrice, true);

  // A proposed runner is valid for research only when the earlier prospective
  // decision had explicitly qualified a net-positive protected price.
  const runnerStop = input.runnerStopPrice;
  if (
    input.runnerEligible &&
    runnerStop != null &&
    Number.isFinite(runnerStop) &&
    runnerStop > 0 &&
    sign * (runnerStop - input.entryPrice) > 0 &&
    sign * (input.exitPrice - runnerStop) > 0
  ) {
    out.runner = grade(runnerStop, false);
  }
  return out;
}
