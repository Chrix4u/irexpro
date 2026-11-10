/**
 * Read-only replay for otherwise-qualified M1 DEMO candidates held solely
 * by the primary-only probation switch. Historical quote levels do not prove
 * executable entries, fillable TP/SL or the correct path within one OHLC bar.
 */
export const M1_PROBATION_MISSED_OPPORTUNITY_ARTIFACT =
  'm1-primary-probation-missed-opportunity-60m-v1';
export const M1_PROBATION_MISSED_HORIZON = 60;
export const M1_PROBATION_EPISODE_MINUTES = 30;

export interface ProbationBrokerM1 {
  bucket_time: Date | string;
  open: string | number | null;
  high: string | number | null;
  low: string | number | null;
  close: string | number | null;
  source: string;
  sample_count: number | string;
  positive_quote_sample_count: number | string;
  first_sample_at: Date | string | null;
  last_quote_sample_at: Date | string | null;
}

export interface ProbationMissedOpportunityResult {
  artifact: typeof M1_PROBATION_MISSED_OPPORTUNITY_ARTIFACT;
  state:
    | 'STOP_QUOTE_TOUCH'
    | 'TARGET_QUOTE_TOUCH'
    | 'BOTH_IN_BAR'
    | 'TIME_MARK'
    | 'DATA_GAP'
    | 'INVALID_GEOMETRY';
  entryQuoteAt: string | null;
  indicativeQuoteEntry: number | null;
  indicativeStop: number | null;
  indicativeTarget: number | null;
  stopDistancePips: number | null;
  targetDistancePips: number | null;
  observedMinutes: number;
  firstMissingMinute: string | null;
  eventMinute: string | null;
  indicativeGrossR: number | null;
  maxAdversePipsBeforeDecision: number | null;
  method: 'NEXT_FULL_M1_OPEN_FIXED_STOP_TARGET_GROSS_ONLY';
  feesModeled: false;
  executionAuthority: 'NONE';
  modifiesExecution: false;
  modelTrainingStatus: 'RESEARCH_ONLY_NOT_TRAINED';
}

const round = (n: number, d = 5) => Number(n.toFixed(d));
const validM1 = (row: ProbationBrokerM1 | undefined, atMs: number): row is ProbationBrokerM1 => {
  if (!row || row.source !== 'ctrader-broker-native') return false;
  if ([row.open, row.high, row.low, row.close].some((v) => v === null || v === undefined)) {
    return false;
  }
  const open = Number(row.open);
  const high = Number(row.high);
  const low = Number(row.low);
  const close = Number(row.close);
  const firstMs = row.first_sample_at ? new Date(row.first_sample_at).getTime() : NaN;
  const lastMs = row.last_quote_sample_at ? new Date(row.last_quote_sample_at).getTime() : NaN;
  const count = Number(row.sample_count);
  const positive = Number(row.positive_quote_sample_count);
  return (
    [open, high, low, close].every((v) => Number.isFinite(v) && v > 0) &&
    low <= open &&
    open <= high &&
    low <= close &&
    close <= high &&
    Number.isInteger(count) &&
    count > 0 &&
    Number.isInteger(positive) &&
    positive > 0 &&
    positive <= count &&
    Number.isFinite(firstMs) &&
    firstMs >= atMs &&
    firstMs < atMs + 60000 &&
    Number.isFinite(lastMs) &&
    lastMs >= atMs &&
    lastMs < atMs + 60000
  );
};

/** Selection occurs only from pre-existing decision fields; future quotes are
 * used solely to score and never to decide whether to select the candidate.
 */
export function evaluateM1ProbationMissedOpportunity(input: {
  instrument: string;
  direction: 'BUY' | 'SELL';
  decisionTime: Date;
  stopDistance: number;
  targetDistance: number;
  bars: ProbationBrokerM1[];
}): ProbationMissedOpportunityResult {
  const result: ProbationMissedOpportunityResult = {
    artifact: M1_PROBATION_MISSED_OPPORTUNITY_ARTIFACT,
    state: 'DATA_GAP',
    entryQuoteAt: null,
    indicativeQuoteEntry: null,
    indicativeStop: null,
    indicativeTarget: null,
    stopDistancePips: null,
    targetDistancePips: null,
    observedMinutes: 0,
    firstMissingMinute: null,
    eventMinute: null,
    indicativeGrossR: null,
    maxAdversePipsBeforeDecision: null,
    method: 'NEXT_FULL_M1_OPEN_FIXED_STOP_TARGET_GROSS_ONLY',
    feesModeled: false,
    executionAuthority: 'NONE',
    modifiesExecution: false,
    modelTrainingStatus: 'RESEARCH_ONLY_NOT_TRAINED',
  };
  if (
    !Number.isFinite(input.decisionTime.getTime()) ||
    !['BUY', 'SELL'].includes(input.direction) ||
    !/^[A-Z]{6}$/.test(input.instrument) ||
    ![input.stopDistance, input.targetDistance].every((v) => Number.isFinite(v) && v > 0)
  ) {
    return { ...result, state: 'INVALID_GEOMETRY' };
  }
  const pip = input.instrument.endsWith('JPY') ? 0.01 : 0.0001;
  const sign = input.direction === 'BUY' ? 1 : -1;
  // Deliberately exclude the M1 bar covering the decision timestamp; we
  // cannot reconstruct how much of that bar was known at decision time.
  const firstMs = (Math.floor(input.decisionTime.getTime() / 60000) + 1) * 60000;
  const byMinute = new Map<number, ProbationBrokerM1>();
  for (const bar of input.bars) {
    const at = new Date(bar.bucket_time).getTime();
    if (Number.isFinite(at) && !byMinute.has(at)) byMinute.set(at, bar);
  }
  let entry: number | null = null;
  let stop: number | null = null;
  let target: number | null = null;
  let worstAdverse = 0;
  let lastClose: number | null = null;
  for (let i = 0; i < M1_PROBATION_MISSED_HORIZON; i++) {
    const at = firstMs + i * 60000;
    const candle = byMinute.get(at);
    if (!validM1(candle, at)) {
      result.firstMissingMinute = new Date(at).toISOString();
      return result;
    }
    if (entry === null) {
      entry = Number(candle.open);
      stop = entry - sign * input.stopDistance;
      target = entry + sign * input.targetDistance;
      result.entryQuoteAt = new Date(at).toISOString();
      result.indicativeQuoteEntry = entry;
      result.indicativeStop = round(stop, 7);
      result.indicativeTarget = round(target, 7);
      result.stopDistancePips = round(input.stopDistance / pip, 2);
      result.targetDistancePips = round(input.targetDistance / pip, 2);
    }
    result.observedMinutes++;
    lastClose = Number(candle.close);
    const adverse =
      sign === 1
        ? Math.max(0, entry - Number(candle.low))
        : Math.max(0, Number(candle.high) - entry);
    const hitsStop = sign === 1 ? Number(candle.low) <= stop! : Number(candle.high) >= stop!;
    const hitsTarget = sign === 1 ? Number(candle.high) >= target! : Number(candle.low) <= target!;
    if (hitsStop || hitsTarget) {
      result.state =
        hitsStop && hitsTarget
          ? 'BOTH_IN_BAR'
          : hitsStop
            ? 'STOP_QUOTE_TOUCH'
            : 'TARGET_QUOTE_TOUCH';
      result.eventMinute = new Date(at).toISOString();
      // Do not order intraminute adverse extremes relative to a TP/SL touch.
      // Only prior fully completed M1 candles contribute to this measurement.
      result.maxAdversePipsBeforeDecision = round(worstAdverse / pip, 2);
      result.indicativeGrossR =
        result.state === 'BOTH_IN_BAR'
          ? null
          : hitsStop
            ? -1
            : round(input.targetDistance / input.stopDistance, 4);
      return result;
    }
    worstAdverse = Math.max(worstAdverse, adverse);
  }
  result.state = 'TIME_MARK';
  result.maxAdversePipsBeforeDecision = round(worstAdverse / pip, 2);
  result.indicativeGrossR =
    lastClose === null || entry === null
      ? null
      : round((sign * (lastClose - entry)) / input.stopDistance, 4);
  return result;
}
