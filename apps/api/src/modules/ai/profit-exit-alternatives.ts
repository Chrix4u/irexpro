/** Read-only comparison of early close, protected runner and partial close.
 * No broker order is created or modified by this module.
 */
// Versioned: v1 contained only barrier outcomes and silently treated profitable
// open-at-horizon paths as UNRESOLVED, hiding genuine recovery evidence.
export const EXIT_ALTERNATIVES_ARTIFACT = 'exit-alternatives-verified-m1-v2';
export type ExitOutcome =
  | 'TP_FIRST'
  | 'STOP_FIRST'
  | 'AMBIGUOUS'
  | 'DATA_GAP'
  | 'UNRESOLVED'
  | 'INELIGIBLE';

export interface ExitCandle {
  bucket_time: Date | string;
  high: number | string;
  low: number | string;
  // Broker-native executable-side quote at the COMPLETE M1 candle close.
  // Required for horizon returns; v1 barrier-only callers may omit them.
  bid_close?: number | string | null;
  ask_close?: number | string | null;
  spread_close?: number | string | null;
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
  holdHorizonSnapshots: ExitHoldHorizonSnapshot[];
}

/** The persisted observation state must describe an evaluated scenario.
 * An unqualified protected runner does NOT invalidate the separately
 * evaluated half-partial scenario. Reporting only; never used for orders.
 */
export function summarizeExitObservation(result: {
  runner: Pick<ExitScenario, 'outcome'>;
  halfPartial: Pick<ExitScenario, 'outcome'>;
}): { state: ExitOutcome; scenario: 'PROTECTED_RUNNER' | 'HALF_PARTIAL' } {
  return result.runner.outcome === 'INELIGIBLE'
    ? { state: result.halfPartial.outcome, scenario: 'HALF_PARTIAL' }
    : { state: result.runner.outcome, scenario: 'PROTECTED_RUNNER' };
}

const numeric = (value: unknown): number | null => {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
const rounded = (value: number): number => Number(value.toFixed(4));

function eligibleBar(raw: ExitCandle): { at: number; high: number; low: number } | null {
  const at = new Date(raw.bucket_time).getTime();
  const observed = raw.last_quote_sample_at ? new Date(raw.last_quote_sample_at).getTime() : NaN;
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
  )
    return null;
  return { at, high, low };
}

function firstBarrier(input: ExitScenarioInput, stopPrice: number): ExitScenario {
  const empty = (outcome: ExitOutcome, observedBars: number): ExitScenario => ({
    outcome,
    eventAt: null,
    observedBars,
    netPnlProxy: null,
    deltaVsOriginal: null,
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
    const tp =
      input.direction === 'BUY'
        ? bar.high >= input.takeProfitPrice
        : bar.low <= input.takeProfitPrice;
    const stop = input.direction === 'BUY' ? bar.low <= stopPrice : bar.high >= stopPrice;
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
 * A completed-candle mark-to-market continuation, NOT a fill.
 * Horizon is counted as 15/30/60 complete M1 candle buckets strictly
 * AFTER the exit minute. Intra-minute bid/ask extrema aren't archived, so
 * ambiguous midpoint+spread SL/TP touches censor price-path returns.
 */
export interface ExitHoldHorizonSnapshot {
  completedBars: 15 | 30 | 60;
  state:
    | 'OPEN_AT_HORIZON'
    | 'POSSIBLE_STOP_FIRST'
    | 'POSSIBLE_TARGET_FIRST'
    | 'SAME_BAR_AMBIGUITY'
    | 'DATA_GAP'
    | 'MONEY_CONVERSION_UNAVAILABLE';
  quoteAt: string | null;
  executableSidePrice: number | null;
  indicativeNetPnl: number | null;
  deltaVsActualClose: number | null;
  actualNetPnl: number | null;
  providerFillCertified: false;
}

export function evaluatePostExitHoldHorizons(
  input: Omit<ExitScenarioInput, 'runnerStopPrice' | 'runnerEligible'>,
): ExitHoldHorizonSnapshot[] {
  const sign = input.direction === 'BUY' ? 1 : -1;
  const actualNet = [input.grossPnl, input.commission, input.swap].every(Number.isFinite)
    ? rounded(input.grossPnl - Math.abs(input.commission) + input.swap)
    : null;
  const make = (
    completedBars: 15 | 30 | 60,
    state: ExitHoldHorizonSnapshot['state'],
    quoteAt: string | null = null,
    executableSidePrice: number | null = null,
    indicativeNetPnl: number | null = null,
  ): ExitHoldHorizonSnapshot => ({
    completedBars,
    state,
    quoteAt,
    executableSidePrice,
    indicativeNetPnl,
    deltaVsActualClose:
      actualNet !== null && indicativeNetPnl !== null
        ? rounded(indicativeNetPnl - actualNet)
        : null,
    actualNetPnl: actualNet,
    providerFillCertified: false,
  });
  if (
    !Number.isFinite(input.closeAt.getTime()) ||
    ![
      input.entryPrice,
      input.exitPrice,
      input.stopPrice,
      input.takeProfitPrice,
      input.grossPnl,
      input.commission,
      input.swap,
    ].every(Number.isFinite) ||
    input.entryPrice <= 0 ||
    input.exitPrice <= 0 ||
    input.stopPrice <= 0 ||
    input.takeProfitPrice <= 0 ||
    sign * (input.entryPrice - input.stopPrice) <= 0 ||
    sign * (input.takeProfitPrice - input.entryPrice) <= 0
  ) {
    return ([15, 30, 60] as const).map((n) => make(n, 'DATA_GAP'));
  }
  const observed = new Map<number, ExitCandle | null>();
  for (const candle of input.candles) {
    const at = new Date(candle.bucket_time).getTime();
    if (!Number.isFinite(at)) continue;
    // Duplicates must never be selected as whichever price looks favorable.
    observed.set(at, observed.has(at) ? null : candle);
  }
  const firstBucket = Math.floor(input.closeAt.getTime() / 60_000) * 60_000 + 60_000;
  const snapshots: ExitHoldHorizonSnapshot[] = [];
  // Historical gross conversion per unit of price movement is indicative:
  // keep lot size and the original realized broker FX conversion fixed.
  const realisedPriceMove = sign * (input.exitPrice - input.entryPrice);
  const moneyPerPriceUnit =
    Math.abs(realisedPriceMove) >= 0.000001 &&
    Math.abs(input.grossPnl) >= 0.05 &&
    input.grossPnl * realisedPriceMove > 0
      ? input.grossPnl / realisedPriceMove
      : null;
  let censored: ExitHoldHorizonSnapshot['state'] | null = null;
  let gap = false;
  for (let n = 1; n <= 60; n++) {
    const at = firstBucket + (n - 1) * 60_000;
    const candle = observed.get(at);
    if (!candle) {
      gap = true;
    } else if (!gap && !censored) {
      const checked = eligibleBar(candle);
      const bid = numeric(candle.bid_close);
      const ask = numeric(candle.ask_close);
      const spread = numeric(candle.spread_close);
      if (
        !checked ||
        checked.at !== at ||
        bid === null ||
        ask === null ||
        spread === null ||
        !Number.isFinite(spread) ||
        bid <= 0 ||
        ask < bid ||
        spread < 0 ||
        spread > Math.max(0.0001, bid * 0.002)
      ) {
        gap = true;
      } else {
        // If bid/ask high/low is not available, widen the midpoint by
        // observed positive spread. Better to censor an ambiguous recovery
        // than invent one where the broker stop might have been triggered.
        const possibleStop =
          input.direction === 'BUY'
            ? checked.low - Math.max(spread, ask - bid) <= input.stopPrice
            : checked.high + Math.max(spread, ask - bid) >= input.stopPrice;
        const possibleTarget =
          input.direction === 'BUY'
            ? checked.high >= input.takeProfitPrice
            : checked.low <= input.takeProfitPrice;
        if (possibleStop && possibleTarget) censored = 'SAME_BAR_AMBIGUITY';
        else if (possibleStop) censored = 'POSSIBLE_STOP_FIRST';
        else if (possibleTarget) censored = 'POSSIBLE_TARGET_FIRST';
      }
    }
    if (n !== 15 && n !== 30 && n !== 60) continue;
    const horizon = n as 15 | 30 | 60;
    if (gap) {
      snapshots.push(make(horizon, 'DATA_GAP'));
      continue;
    }
    if (censored) {
      snapshots.push(make(horizon, censored));
      continue;
    }
    const horizonCandle = observed.get(at);
    if (!horizonCandle) {
      snapshots.push(make(horizon, 'DATA_GAP'));
      continue;
    }
    const bid = numeric(horizonCandle.bid_close);
    const ask = numeric(horizonCandle.ask_close);
    if (bid === null || ask === null || !horizonCandle.last_quote_sample_at) {
      snapshots.push(make(horizon, 'DATA_GAP'));
      continue;
    }
    const price = input.direction === 'BUY' ? bid : ask;
    const quoteAt = new Date(horizonCandle.last_quote_sample_at).toISOString();
    if (moneyPerPriceUnit === null) {
      snapshots.push(make(horizon, 'MONEY_CONVERSION_UNAVAILABLE', quoteAt, price));
      continue;
    }
    const hypotheticalNet =
      moneyPerPriceUnit * sign * (price - input.entryPrice) -
      Math.abs(input.commission) +
      input.swap;
    snapshots.push(make(horizon, 'OPEN_AT_HORIZON', quoteAt, price, rounded(hypotheticalNet)));
  }
  return snapshots;
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
    holdHorizonSnapshots: evaluatePostExitHoldHorizons(input),
  };
  const sign = input.direction === 'BUY' ? 1 : -1;
  if (
    !Number.isFinite(input.closeAt.getTime()) ||
    ![
      input.entryPrice,
      input.exitPrice,
      input.stopPrice,
      input.takeProfitPrice,
      input.grossPnl,
      input.commission,
      input.swap,
    ].every(Number.isFinite) ||
    input.entryPrice <= 0 ||
    input.exitPrice <= 0 ||
    input.takeProfitPrice <= 0 ||
    input.stopPrice <= 0 ||
    input.grossPnl <= 0 ||
    sign * (input.exitPrice - input.entryPrice) <= 0 ||
    sign * (input.takeProfitPrice - input.exitPrice) <= 0 ||
    sign * (input.entryPrice - input.stopPrice) <= 0
  )
    return out;
  const pnlAt = (price: number): number =>
    (input.grossPnl * (price - input.entryPrice)) / (input.exitPrice - input.entryPrice);
  const grade = (stopPrice: number, partial: boolean): ExitScenario => {
    const first = firstBarrier(input, stopPrice);
    if (first.outcome !== 'TP_FIRST' && first.outcome !== 'STOP_FIRST') return first;
    const price = first.outcome === 'TP_FIRST' ? input.takeProfitPrice : stopPrice;
    const gross = partial ? 0.5 * input.grossPnl + 0.5 * pnlAt(price) : pnlAt(price);
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

/**
 * Causal research of DEMO adverse-thesis AI exits after the actual provider
 * CLOSE has been confirmed. The continuation path always begins with the
 * *next completed* broker-native M1 bucket, never a quote from before exit.
 * A midpoint candle touch is NOT a certifiable broker bid/ask TP/SL fill.
 */
export const ADVERSE_EXIT_COUNTERFACTUAL_ARTIFACT = 'adverse-thesis-exit-verified-m1-v3' as const;

export type AdverseExitCounterfactualInput = Omit<
  ExitScenarioInput,
  'runnerStopPrice' | 'runnerEligible'
>;
export interface AdverseExitCounterfactualReport {
  mode: 'SHADOW_ONLY';
  modifiesExecution: false;
  methodology: 'CONTIGUOUS_LIVE_QUOTE_M1_MIDPOINT_PROXY';
  originalNetPnl: number | null;
  recordedCommission: number | null;
  originalNetCostsComplete: boolean;
  originalSlTpHold: ExitScenario;
  brokerFillCertified: false;
  forecastAtEntry: false;
  holdHorizonSnapshots: ExitHoldHorizonSnapshot[];
}

export function compareAdverseExitCounterfactual(
  input: AdverseExitCounterfactualInput,
): AdverseExitCounterfactualReport {
  const invalid = (): ExitScenario => ({
    outcome: 'INELIGIBLE',
    eventAt: null,
    observedBars: 0,
    netPnlProxy: null,
    deltaVsOriginal: null,
  });
  const sign = input.direction === 'BUY' ? 1 : -1;
  const finite = [
    input.entryPrice,
    input.exitPrice,
    input.stopPrice,
    input.takeProfitPrice,
    input.grossPnl,
    input.commission,
    input.swap,
  ].every(Number.isFinite);
  const valid =
    finite &&
    Number.isFinite(input.closeAt.getTime()) &&
    input.entryPrice > 0 &&
    input.exitPrice > 0 &&
    input.stopPrice > 0 &&
    input.takeProfitPrice > 0 &&
    input.grossPnl < 0 &&
    sign * (input.exitPrice - input.entryPrice) < 0 &&
    sign * (input.entryPrice - input.stopPrice) > 0 &&
    sign * (input.takeProfitPrice - input.entryPrice) > 0;
  const originalNet = finite
    ? rounded(input.grossPnl - Math.abs(input.commission) + input.swap)
    : null;
  const report: AdverseExitCounterfactualReport = {
    mode: 'SHADOW_ONLY',
    modifiesExecution: false,
    methodology: 'CONTIGUOUS_LIVE_QUOTE_M1_MIDPOINT_PROXY',
    originalNetPnl: originalNet,
    recordedCommission: Number.isFinite(input.commission)
      ? rounded(Math.abs(input.commission))
      : null,
    originalNetCostsComplete: finite,
    originalSlTpHold: invalid(),
    brokerFillCertified: false,
    forecastAtEntry: false,
    holdHorizonSnapshots: evaluatePostExitHoldHorizons(input),
  };
  if (!valid) return report;

  const first = firstBarrier(
    { ...input, runnerStopPrice: null, runnerEligible: false },
    input.stopPrice,
  );
  if (first.outcome !== 'TP_FIRST' && first.outcome !== 'STOP_FIRST') {
    report.originalSlTpHold = first;
    return report;
  }
  // Only an indicative linear market-price-to-P&L scenario. Same notional,
  // recorded commission/swap held fixed; extra slippage, financing, gaps,
  // future bid/ask and provider actual fills are UNKNOWN, not implied.
  const eventPrice = first.outcome === 'TP_FIRST' ? input.takeProfitPrice : input.stopPrice;
  const grossProxy =
    (input.grossPnl * (eventPrice - input.entryPrice)) / (input.exitPrice - input.entryPrice);
  const netProxy = grossProxy - Math.abs(input.commission) + input.swap;
  report.originalSlTpHold = {
    ...first,
    netPnlProxy: rounded(netProxy),
    deltaVsOriginal: rounded(netProxy - (originalNet ?? 0)),
  };
  return report;
}
