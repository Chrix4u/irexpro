/**
 * Research-only: inspect 60 minutes of independently quoted broker-native
 * M1 CLOSE prices AFTER a DEMO drawdown-guard exit.
 *
 * Never claim a counterfactual broker stop would execute at its level:
 * touch ordering within each minute and intrabar liquidity are unknown.
 * Missing quotes before the first observed threshold crossing invalidate
 * any "first" classification.
 */
export const DEMO_DRAWDOWN_EXIT_AUDIT_ARTIFACT = 'demo-drawdown-after-exit-m1-close-v1';
export const DEMO_DRAWDOWN_EXIT_AUDIT_HORIZON_MINUTES = 60;

export interface AfterExitQuoteBar {
  bucket_time: Date | string;
  source: string;
  bid_close: string | number | null;
  ask_close: string | number | null;
  sample_count: string | number;
  positive_quote_sample_count: string | number;
  last_quote_sample_at: Date | string | null;
}

export interface AfterExitTrade {
  instrument: string;
  direction: 'BUY' | 'SELL';
  closedAt: Date;
  stopLoss: number;
  takeProfit: number;
}

export type AfterExitClassification =
  | 'ORIGINAL_SL_CROSSED_FIRST'
  | 'ORIGINAL_TP_CROSSED_FIRST'
  | 'BOTH_CROSSED_SAME_BAR'
  | 'NEITHER_CROSSED_IN_FULL_WINDOW'
  | 'INSUFFICIENT_QUOTE_COVERAGE'
  | 'INVALID_TRADE'
  | 'AWAITING_FULL_HORIZON';

export interface AfterExitAssessment {
  artifact: typeof DEMO_DRAWDOWN_EXIT_AUDIT_ARTIFACT;
  executionAuthority: 'NONE';
  modifiesExecution: false;
  horizonMinutes: typeof DEMO_DRAWDOWN_EXIT_AUDIT_HORIZON_MINUTES;
  classification: AfterExitClassification;
  validQuoteBars: number;
  expectedBars: number;
  quoteCoverage: number;
  firstStopQuoteCloseAt: string | null;
  firstTakeProfitQuoteCloseAt: string | null;
  assumption: 'OBSERVED_BID_ASK_M1_CLOSE_NOT_BROKER_FILL';
}

const MINUTE_MS = 60_000;
const HORIZON_MS = DEMO_DRAWDOWN_EXIT_AUDIT_HORIZON_MINUTES * MINUTE_MS;

function positive(value: unknown): number | null {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}
function validTime(value: Date | string | null): number {
  if (value == null) return NaN;
  return new Date(value).getTime();
}

export function assessDemoDrawdownAfterExit(
  trade: AfterExitTrade,
  bars: AfterExitQuoteBar[],
  observedAt = new Date(),
): AfterExitAssessment {
  const output: AfterExitAssessment = {
    artifact: DEMO_DRAWDOWN_EXIT_AUDIT_ARTIFACT,
    executionAuthority: 'NONE',
    modifiesExecution: false,
    horizonMinutes: DEMO_DRAWDOWN_EXIT_AUDIT_HORIZON_MINUTES,
    classification: 'INVALID_TRADE',
    validQuoteBars: 0,
    expectedBars: DEMO_DRAWDOWN_EXIT_AUDIT_HORIZON_MINUTES,
    quoteCoverage: 0,
    firstStopQuoteCloseAt: null,
    firstTakeProfitQuoteCloseAt: null,
    assumption: 'OBSERVED_BID_ASK_M1_CLOSE_NOT_BROKER_FILL',
  };
  const closed = trade.closedAt.getTime();
  if (
    !Number.isFinite(closed) ||
    !Number.isFinite(observedAt.getTime()) ||
    !/^[A-Z]{6}$/.test(trade.instrument) ||
    !['BUY', 'SELL'].includes(trade.direction) ||
    !positive(trade.stopLoss) ||
    !positive(trade.takeProfit) ||
    (trade.direction === 'BUY' && trade.stopLoss >= trade.takeProfit) ||
    (trade.direction === 'SELL' && trade.stopLoss <= trade.takeProfit)
  )
    return output;

  if (observedAt.getTime() < closed + HORIZON_MS) {
    return { ...output, classification: 'AWAITING_FULL_HORIZON' };
  }

  // Fully closed quote candles only. The minute of the actual broker exit
  // is excluded, since its quote samples may precede the closing deal.
  const firstCompleteBarAt = Math.ceil(closed / MINUTE_MS) * MINUTE_MS;
  const latestAllowedClose = closed + HORIZON_MS;
  const valid = new Map<number, { stop: boolean; tp: boolean }>();
  for (const bar of bars) {
    const start = validTime(bar.bucket_time);
    const quoteAt = validTime(bar.last_quote_sample_at);
    const close = start + MINUTE_MS;
    const bid = positive(bar.bid_close);
    const ask = positive(bar.ask_close);
    const totalSamples = Number(bar.sample_count);
    const liveSamples = Number(bar.positive_quote_sample_count);
    if (
      bar.source !== 'ctrader-broker-native' ||
      !Number.isFinite(start) ||
      start % MINUTE_MS !== 0 ||
      start < firstCompleteBarAt ||
      close > latestAllowedClose ||
      !Number.isFinite(quoteAt) ||
      quoteAt < start ||
      quoteAt >= close ||
      !Number.isSafeInteger(totalSamples) ||
      totalSamples <= 0 ||
      !Number.isSafeInteger(liveSamples) ||
      liveSamples <= 0 ||
      liveSamples > totalSamples ||
      bid === null ||
      ask === null ||
      bid > ask ||
      valid.has(start)
    )
      continue;
    const executable = trade.direction === 'BUY' ? bid : ask;
    valid.set(start, {
      stop: trade.direction === 'BUY' ? executable <= trade.stopLoss : executable >= trade.stopLoss,
      tp:
        trade.direction === 'BUY' ? executable >= trade.takeProfit : executable <= trade.takeProfit,
    });
  }
  const ordered = [...valid.entries()].sort((a, b) => a[0] - b[0]);
  const expectedBars = Math.floor((latestAllowedClose - firstCompleteBarAt) / MINUTE_MS);
  const base = {
    ...output,
    expectedBars,
    validQuoteBars: ordered.length,
    quoteCoverage:
      expectedBars > 0 ? Math.round(((100 * ordered.length) / expectedBars) * 100) / 100 : 0,
  };
  let stopAt: number | null = null;
  let tpAt: number | null = null;
  let missingBeforeFirst = false;
  let expectedStart = firstCompleteBarAt;
  for (const [started, threshold] of ordered) {
    if (started !== expectedStart && stopAt === null && tpAt === null) {
      missingBeforeFirst = true;
    }
    expectedStart = started + MINUTE_MS;
    if (threshold.stop && stopAt === null) stopAt = started + MINUTE_MS;
    if (threshold.tp && tpAt === null) tpAt = started + MINUTE_MS;
  }
  const evidence = {
    ...base,
    firstStopQuoteCloseAt: stopAt == null ? null : new Date(stopAt).toISOString(),
    firstTakeProfitQuoteCloseAt: tpAt == null ? null : new Date(tpAt).toISOString(),
  };
  if (missingBeforeFirst || expectedBars < 45 || ordered.length < 0.9 * expectedBars) {
    return { ...evidence, classification: 'INSUFFICIENT_QUOTE_COVERAGE' };
  }
  if (stopAt !== null && tpAt !== null) {
    return {
      ...evidence,
      classification:
        stopAt < tpAt
          ? 'ORIGINAL_SL_CROSSED_FIRST'
          : stopAt > tpAt
            ? 'ORIGINAL_TP_CROSSED_FIRST'
            : 'BOTH_CROSSED_SAME_BAR',
    };
  }
  if (stopAt !== null) return { ...evidence, classification: 'ORIGINAL_SL_CROSSED_FIRST' };
  if (tpAt !== null) return { ...evidence, classification: 'ORIGINAL_TP_CROSSED_FIRST' };
  return {
    ...evidence,
    classification:
      ordered.length === expectedBars
        ? 'NEITHER_CROSSED_IN_FULL_WINDOW'
        : 'INSUFFICIENT_QUOTE_COVERAGE',
  };
}
