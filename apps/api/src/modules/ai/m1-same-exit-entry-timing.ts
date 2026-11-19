import type { DelayedEntryParityResult, VerifiedNativeMinute } from './m1-delayed-entry-parity-shadow';
import { isVerifiedNativeMinute } from './m1-delayed-entry-parity-shadow';

/** Quote-only paired comparison, matched to the ORIGINAL broker close.
 * Does not assume a hypothetical broker fill, a changed closing decision,
 * or execution authority. Exit-bar OHLC is deliberately excluded.
 */
export const SAME_EXIT_TIMING_ARTIFACT = 'm1-same-exit-entry-timing-research-v2-verified-risk' as const;
export type SameExitState =
  | 'NO_CONFIRMATION' | 'UNVERIFIED_SETTLEMENT' | 'ENTRY_AFTER_ACTUAL_CLOSE'
  | 'CLOSE_IN_ENTRY_MINUTE' | 'DATA_GAP' | 'STOP_TOUCH_BEFORE_ACTUAL_CLOSE'
  | 'TARGET_TOUCH_BEFORE_ACTUAL_CLOSE' | 'BOTH_BARRIERS_IN_MINUTE'
  | 'INDICATIVE_SAME_EXIT';

export interface SameExitTimingResult {
  artifact: typeof SAME_EXIT_TIMING_ARTIFACT;
  state: SameExitState;
  actualCloseAt: string | null;
  indicativeEntryAt: string | null;
  firstBarrierAt: string | null;
  firstMissingMinute: string | null;
  comparedCompletedMinutes: number;
  actualNetAfterFeesR: number | null;
  delayedSameExitNetAfterFeesR: number | null;
  indicativeDeltaNetR: number | null;
  indicativeEntryImprovementPips: number | null;
  maxAdversePipsBeforeActualClose: number | null;
  assumption: 'SAME_EXIT_PRICE_UNCHANGED_VOLUME_ESTIMATED_FEES_NOT_EXECUTABLE';
  originalStopRiskAccountCurrency: number | null;
  grossPerPriceUnitFromActualClose: number | null;
  noTradeAuthority: true;
  modifiesExecution: false;
  modelTrainingStatus: 'RESEARCH_ONLY_NOT_TRAINED';
}

const rounded = (n: number, digits = 4) => Number(n.toFixed(digits));
export function compareDelayedEntryAtActualExit(input: {
  instrument: string;
  direction: 'BUY' | 'SELL';
  originalFill: number;
  originalStop: number;
  originalTarget: number;
  originalExit: number | null;
  originalClosedAt: Date | null;
  actualGrossPnl: number | null;
  actualCommission: number | null;
  actualSwap: number | null;
  verifiedOriginalRiskAccountCurrency: number | null;
  delayed: DelayedEntryParityResult;
  candles: readonly VerifiedNativeMinute[];
}): SameExitTimingResult {
  const { delayed } = input;
  const closeAt = input.originalClosedAt;
  const enteredAt = delayed.simulatedEntryAt;
  const base = (state: SameExitState): SameExitTimingResult => ({
    artifact: SAME_EXIT_TIMING_ARTIFACT, state,
    actualCloseAt: closeAt && Number.isFinite(closeAt.getTime())
      ? closeAt.toISOString() : null,
    indicativeEntryAt: enteredAt,
    firstBarrierAt: null, firstMissingMinute: null,
    comparedCompletedMinutes: 0,
    actualNetAfterFeesR: null,
    delayedSameExitNetAfterFeesR: null,
    indicativeDeltaNetR: null,
    indicativeEntryImprovementPips: null,
    maxAdversePipsBeforeActualClose: null,
    assumption: 'SAME_EXIT_PRICE_UNCHANGED_VOLUME_ESTIMATED_FEES_NOT_EXECUTABLE',
    originalStopRiskAccountCurrency: null,
    grossPerPriceUnitFromActualClose: null,
    noTradeAuthority: true, modifiesExecution: false,
    modelTrainingStatus: 'RESEARCH_ONLY_NOT_TRAINED',
  });
  if (delayed.state !== 'CONFIRMED' || !enteredAt ||
      delayed.indicativeQuoteEntry == null)
    return base('NO_CONFIRMATION');
  const at = Date.parse(enteredAt);
  const exitAt = closeAt?.getTime() ?? NaN;
  const sign = input.direction === 'BUY' ? 1 : input.direction === 'SELL' ? -1 : NaN;
  const originalRisk = Math.abs(input.originalFill - input.originalStop);
  const originalTarget = Math.abs(input.originalTarget - input.originalFill);
  const quote = delayed.indicativeQuoteEntry;
  const risk = input.verifiedOriginalRiskAccountCurrency;
  const pips = input.instrument.toUpperCase().endsWith('JPY') ? 0.01 : 0.0001;
  if (delayed.originalDirection !== input.direction ||
    (sign === 1
      ? !(input.originalStop < input.originalFill &&
          input.originalFill < input.originalTarget)
      : !(input.originalTarget < input.originalFill &&
          input.originalFill < input.originalStop)) ||
    at % 60_000 !== 0 ||
    ![at,exitAt,sign,originalRisk,originalTarget,quote,
    input.originalFill,input.originalExit,input.actualGrossPnl,
    input.actualCommission,input.actualSwap,risk].every(
      x => typeof x === 'number' && Number.isFinite(x),
    ) || originalRisk <= 0 || originalTarget <= 0 ||
    quote <= 0 || (risk ?? 0) <= 0 || (input.originalExit ?? 0) <= 0 ||
    !Number.isFinite(at) || delayed.quotePricingNotExecutable !== true)
    return base('UNVERIFIED_SETTLEMENT');
  const result = base('INDICATIVE_SAME_EXIT');
  result.originalStopRiskAccountCurrency = rounded(risk!, 2);
  result.indicativeEntryImprovementPips =
    rounded(sign * (input.originalFill - quote) / pips, 2);
  // Never call an entry at or after the actual exit a valid alternative.
  if (at >= exitAt) return { ...result, state: 'ENTRY_AFTER_ACTUAL_CLOSE' };
  const endMinute = Math.floor(exitAt / 60_000) * 60_000;
  if (endMinute <= at) return { ...result, state: 'CLOSE_IN_ENTRY_MINUTE' };

  const lookup = new Map<number, VerifiedNativeMinute>();
  for (const candle of input.candles) {
    const time = new Date(candle.bucket_time).getTime();
    if (Number.isFinite(time) && !lookup.has(time)) lookup.set(time, candle);
  }
  const hypotheticalStop = quote - sign * originalRisk;
  const hypotheticalTarget = quote + sign * originalTarget;
  let peakAdverse = 0;
  for (let minute = at; minute < endMinute; minute += 60_000) {
    const bar = lookup.get(minute);
    if (!isVerifiedNativeMinute(bar, minute)) {
      result.state = 'DATA_GAP';
      result.firstMissingMinute = new Date(minute).toISOString();
      return result;
    }
    result.comparedCompletedMinutes++;
    const high = Number(bar.high);
    const low = Number(bar.low);
    const hitsStop = sign === 1 ? low <= hypotheticalStop : high >= hypotheticalStop;
    const hitsTarget = sign === 1 ? high >= hypotheticalTarget : low <= hypotheticalTarget;
    peakAdverse = Math.max(peakAdverse,
      sign === 1 ? Math.max(0, quote - low) : Math.max(0, high - quote));
    if (hitsStop || hitsTarget) {
      result.firstBarrierAt = new Date(minute).toISOString();
      result.maxAdversePipsBeforeActualClose = rounded(peakAdverse / pips, 2);
      result.state = hitsStop && hitsTarget ? 'BOTH_BARRIERS_IN_MINUTE' :
        hitsStop ? 'STOP_TOUCH_BEFORE_ACTUAL_CLOSE' : 'TARGET_TOUCH_BEFORE_ACTUAL_CLOSE';
      return result;
    }
  }
  result.maxAdversePipsBeforeActualClose = rounded(peakAdverse / pips, 2);
  const fees = input.actualCommission! + input.actualSwap!;
  const originalMovement = sign * (input.originalExit! - input.originalFill);
  const gross = input.actualGrossPnl!;
  // Infer the pip-to-currency conversion only from the original BROKER
  // settlement. Reject an inconsistent broker gross/price-move sign or a
  // near-zero close movement rather than inventing a conversion rate.
  if (Math.abs(originalMovement) <= pips / 10 ||
      gross === 0 || gross * originalMovement <= 0)
    return { ...result, state: 'UNVERIFIED_SETTLEMENT' };
  const grossPerPriceUnit = gross / originalMovement;
  result.grossPerPriceUnitFromActualClose = rounded(grossPerPriceUnit, 4);
  const incrementalGross = sign * (input.originalFill - quote) * grossPerPriceUnit;
  const netActual = (gross + fees) / risk!;
  const netDelayed = (gross + incrementalGross + fees) / risk!;
  // Same broker close and same unchanged volume are counterfactual assumptions,
  // not realizable P&L. Do not infer model fitness from one pair.
  result.actualNetAfterFeesR = rounded(netActual);
  result.delayedSameExitNetAfterFeesR = rounded(netDelayed);
  result.indicativeDeltaNetR = rounded(netDelayed - netActual);
  return result;
}
