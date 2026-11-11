/**
 * Offline/DEMO research primitives for actual cTrader Open API (2145/2146)
 * historical ticks. NO broker order entry, account mutation or AI authority.
 *
 * cTrader returns NEWEST-FIRST ticks: the first timestamp is absolute Unix
 * milliseconds, each subsequent timestamp is a positive time *difference*
 * from the previous, newer tick. Tick price is integer price × 100000.
 *
 * IMPORTANT: A hasMore page is incomplete and must NEVER be used to declare
 * stop-first or target-first. Separate BID/ASK streams do not establish
 * order between distinct quotes with the SAME millisecond timestamp.
 */
export type CtraderHistoricalQuoteSide = 'BID' | 'ASK';
export type CtraderTickResearchOutcome =
  | 'TARGET_FIRST'
  | 'STOP_FIRST'
  | 'NEITHER_WITHIN_HORIZON'
  | 'AMBIGUOUS_SAME_MILLISECOND'
  | 'INSUFFICIENT_TICK_EVIDENCE';

export interface CtraderResearchTick {
  atMs: number;
  price: number;
}

export interface CtraderFirstHitResearchResult {
  outcome: CtraderTickResearchOutcome;
  atMs: number | null;
  entryAtMs: number | null;
  entryBid: number | null;
  entryAsk: number | null;
  observedTickCount: number;
}

const MAX_TICKS_PER_SIDE = 100_000;
const MAX_RESEARCH_TICK_WINDOW_MS = 12 * 60_000;

function exactSafeInt(value: unknown): number {
  if (typeof value !== 'number' && typeof value !== 'string') {
    throw new Error('INVALID_CTRADER_TICK_INTEGER');
  }
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('INVALID_CTRADER_TICK_INTEGER');
  return n;
}

export function validateCtraderResearchTickWindow(fromMs: number, toMs: number): void {
  if (
    !Number.isSafeInteger(fromMs) ||
    !Number.isSafeInteger(toMs) ||
    fromMs <= 0 ||
    toMs <= fromMs ||
    toMs - fromMs > MAX_RESEARCH_TICK_WINDOW_MS ||
    toMs > Date.now() - 2_000
  ) {
    throw new Error('INVALID_BOUNDED_HISTORICAL_TICK_WINDOW');
  }
}

export function decodeCtraderHistoricalTickSide(
  payload: { tickData?: unknown; hasMore?: unknown },
  fromMs: number,
  toMs: number,
): CtraderResearchTick[] {
  validateCtraderResearchTickWindow(fromMs, toMs);
  if (payload?.hasMore !== false) throw new Error('INCOMPLETE_CTRADER_TICK_HISTORY_PAGE');
  const rows = payload.tickData;
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > MAX_TICKS_PER_SIDE) {
    throw new Error('INVALID_CTRADER_TICK_PAGE_SIZE');
  }
  const reversed: CtraderResearchTick[] = [];
  let lastTime = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as Record<string, unknown> | null;
    if (!row || typeof row !== 'object') throw new Error('INVALID_CTRADER_TICK_ROW');
    const timeValue = exactSafeInt(row.timestamp);
    const rawPrice = exactSafeInt(row.tick);
    if (rawPrice <= 0) throw new Error('INVALID_CTRADER_TICK_PRICE');
    if (i === 0) {
      lastTime = timeValue;
    } else {
      // Reverse chronology: timestamp encodes delta from PRIOR NEWER tick.
      if (timeValue > lastTime) throw new Error('INVALID_CTRADER_RELATIVE_TIME');
      lastTime -= timeValue;
    }
    if (lastTime < fromMs || lastTime > toMs) {
      throw new Error('CTRADER_TICK_OUTSIDE_REQUEST_WINDOW');
    }
    reversed.push({ atMs: lastTime, price: rawPrice / 100_000 });
  }
  // Reverse without sorting, preserving provider order within equal-ms ticks.
  return reversed.reverse();
}

function insufficient(count = 0): CtraderFirstHitResearchResult {
  return {
    outcome: 'INSUFFICIENT_TICK_EVIDENCE',
    atMs: null,
    entryAtMs: null,
    entryBid: null,
    entryAsk: null,
    observedTickCount: count,
  };
}

/**
 * Evaluates one as-of M1 BUY/SELL candidate against complete native bid/ask
 * tick pages, with *existing as-of* absolute stop/target prices. Do not
 * synthesize stops or claim broker fill. Actual stop-trigger methods can differ
 * from default bid-for-BUY and ask-for-SELL conditions; certify separately.
 */
export function evaluateCtraderTickFirstHitResearch(input: {
  direction: 'BUY' | 'SELL';
  decisionAtMs: number;
  horizonMinutes: 1 | 3 | 5 | 10;
  stopLoss: number;
  takeProfit: number;
  bidTicks: readonly CtraderResearchTick[];
  askTicks: readonly CtraderResearchTick[];
  maxEntrySideGapMs?: number;
}): CtraderFirstHitResearchResult {
  const allCount = input.bidTicks.length + input.askTicks.length;
  const maxGap = input.maxEntrySideGapMs ?? 1_500;
  if (
    !Number.isSafeInteger(input.decisionAtMs) ||
    input.decisionAtMs <= 0 ||
    ![1, 3, 5, 10].includes(input.horizonMinutes) ||
    !Number.isFinite(input.stopLoss) ||
    !Number.isFinite(input.takeProfit) ||
    input.stopLoss <= 0 ||
    input.takeProfit <= 0 ||
    !Number.isFinite(maxGap) ||
    maxGap < 0 ||
    maxGap > 5_000
  ) {
    return insufficient(allCount);
  }
  const good = (x: CtraderResearchTick) =>
    Number.isSafeInteger(x.atMs) && Number.isFinite(x.price) && x.price > 0;
  for (const arr of [input.bidTicks, input.askTicks]) {
    let last = -Infinity;
    for (const x of arr) {
      if (!good(x) || x.atMs < last) return insufficient(allCount);
      last = x.atMs;
    }
  }
  // Both quote sides must have been observed AFTER signal persistence.
  const bid = input.bidTicks.find((x) => x.atMs >= input.decisionAtMs);
  const ask = input.askTicks.find((x) => x.atMs >= input.decisionAtMs);
  if (!bid || !ask || Math.abs(bid.atMs - ask.atMs) > maxGap || ask.price < bid.price)
    return insufficient(allCount);
  const entryAtMs = Math.max(bid.atMs, ask.atMs);
  const entryPrice = input.direction === 'BUY' ? ask.price : bid.price;
  if (
    input.direction === 'BUY'
      ? !(input.stopLoss < entryPrice && input.takeProfit > entryPrice)
      : !(input.stopLoss > entryPrice && input.takeProfit < entryPrice)
  ) {
    return insufficient(allCount);
  }
  const endAt = entryAtMs + input.horizonMinutes * 60_000;
  // To evaluate a BUY exit, use executable BID ticks. SELL exit uses ASK.
  const side = input.direction === 'BUY' ? input.bidTicks : input.askTicks;
  const ticks = side.filter((x) => x.atMs > entryAtMs && x.atMs <= endAt);
  if (ticks.length === 0) return insufficient(allCount);
  let hitAt: number | null = null;
  let hitTarget = false;
  let hitStop = false;
  for (const x of ticks) {
    if (hitAt !== null && x.atMs !== hitAt) break;
    const target =
      input.direction === 'BUY' ? x.price >= input.takeProfit : x.price <= input.takeProfit;
    const stop = input.direction === 'BUY' ? x.price <= input.stopLoss : x.price >= input.stopLoss;
    if (!target && !stop) continue;
    if (hitAt === null) hitAt = x.atMs;
    if (x.atMs !== hitAt) break;
    hitTarget ||= target;
    hitStop ||= stop;
  }
  return {
    outcome:
      hitTarget && hitStop
        ? 'AMBIGUOUS_SAME_MILLISECOND'
        : hitTarget
          ? 'TARGET_FIRST'
          : hitStop
            ? 'STOP_FIRST'
            : 'NEITHER_WITHIN_HORIZON',
    atMs: hitAt,
    entryAtMs,
    entryBid: bid.price,
    entryAsk: ask.price,
    observedTickCount: allCount,
  };
}
