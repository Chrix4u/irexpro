'use strict';
/**
 * Conservative research-only M1 barrier review. Price ranges are midpoint
 * samples, not historical bid/ask extremes or ordered broker fills.
 */
const {validQuote} = require('./audit-pepperstone-alternative-route-opportunities.cjs');
const MS = 60000;
const n = x => x === null || x === undefined || x === '' ? null :
  Number.isFinite(Number(x)) ? Number(x) : null;
function analyzeM1Barriers(episode, quotes, minutes, side) {
  if (!['BUY','SELL'].includes(side) || !Number.isInteger(minutes) || minutes < 1)
    return {status:'INVALID_ARGUMENTS'};
  const startTime = new Date(episode.evaluated_at).getTime();
  const risk = n(episode.stop_distance), reward = n(episode.target_distance);
  if (!Number.isFinite(startTime) || !(risk > 0 && reward > 0))
    return {status:'UNKNOWN_RISK_OR_TIME'};
  const entryTime = Math.floor(startTime / MS) * MS + MS;
  const series = quotes.get(episode.instrument);
  const entryBar = series?.get(entryTime);
  if (!validQuote(entryBar)) return {status:'UNKNOWN_ENTRY_QUOTE'};
  const buy = side === 'BUY';
  const fillProxy = n(buy ? entryBar.ask_close : entryBar.bid_close);
  const stopPrice = fillProxy + (buy ? -risk : risk);
  const targetPrice = fillProxy + (buy ? reward : -reward);
  // The entry-minute high/low cannot be used, since it contains movement
  // prior to this next-minute quote. We start at the next complete minute.
  for (let j = 1; j <= minutes; j++) {
    const barTime = entryTime + j * MS;
    const quote = series?.get(barTime);
    if (!validQuote(quote)) return {
      status:'UNKNOWN_MISSING_PATH',
      inspectedMinutes:j-1,
      incompleteAt:new Date(barTime).toISOString(),
    };
    const high = n(quote.high), low = n(quote.low);
    const spread = n(quote.last_positive_spread);
    if (high === null || low === null || spread === null ||
        low <= 0 || high < low || spread <= 0) return {
      status:'UNKNOWN_BAR_RANGE',
      incompleteAt:new Date(barTime).toISOString(),
    };
    // Extremes come from MIDPOINT samples. Last spread is only a proxy
    // and was not necessarily observed at those extrema.
    const exitHighProxy = buy ? high - spread/2 : high + spread/2;
    const exitLowProxy = buy ? low - spread/2 : low + spread/2;
    const stopPossible = buy ? exitLowProxy <= stopPrice : exitHighProxy >= stopPrice;
    const targetPossible = buy ? exitHighProxy >= targetPrice : exitLowProxy <= targetPrice;
    // The mark at this horizon comes from a last-positive quote within
    // the exit minute. A candle-wide extreme in that same exit minute
    // may have happened AFTER the mark. Never assert stop/target-first.
    if (j===minutes && (stopPossible || targetPossible)) return {
      status:'UNKNOWN_EXIT_MINUTE_ORDER',
      firstPossibleAt:new Date(barTime).toISOString(),
      inspectedMinutes:j,entryMinuteUnchecked:true,
      rangeIsMidpointProxy:true,exactFillVerified:false,
    };
    if (stopPossible || targetPossible) return {
      status:stopPossible && targetPossible ? 'AMBIGUOUS_BOTH_POSSIBLE' :
        stopPossible ? 'POSSIBLE_STOP_BEFORE_TARGET' : 'POSSIBLE_TARGET_BEFORE_STOP',
      firstPossibleAt:new Date(barTime).toISOString(),
      inspectedMinutes:j,
      entryMinuteUnchecked:true,
      rangeIsMidpointProxy:true,
      exactFillVerified:false,
    };
  }
  return {
    status:'NO_POSSIBLE_TOUCH_IN_INSPECTED_BARS',
    inspectedMinutes:minutes,
    entryMinuteUnchecked:true,
    exactFillVerified:false,
  };
}
module.exports={analyzeM1Barriers};
