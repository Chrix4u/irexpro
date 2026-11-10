/**
 * Causal, quote-only research: two consecutive completed M1 close moves in
 * the model's original direction, then a hypothetical entry at the NEXT
 * M1 quote open. Evaluation takes place only after the entire horizon.
 * No execution authority; quote OHLC does not simulate broker fills.
 */
export const DELAY_ENTRY_PARITY_SHADOW_ARTIFACT = 'm1-confirmed-delay-stop-parity-shadow-v1';
export const DELAY_ENTRY_PARITY_HORIZONS = [60, 240] as const;
export type DelayEntryParityHorizon = (typeof DELAY_ENTRY_PARITY_HORIZONS)[number];
export const DELAY_ENTRY_CONFIRMATION_WINDOW_MINUTES = 5;
export const DELAY_ENTRY_STOP_MULTIPLIERS = [1, 1.4] as const;

export interface VerifiedNativeMinute {
  bucket_time: Date | string;
  open: string | number | null;
  high: string | number | null;
  low: string | number | null;
  close: string | number | null;
  sample_count: string | number;
  positive_quote_sample_count: string | number;
  first_sample_at: Date | string | null;
  last_quote_sample_at: Date | string | null;
  spread_close: string | number | null;
  source: string;
}

export interface DelayedStopScenario {
  stopMultiplier: number;
  riskParityLotMultiplier: number;
  stopDistancePips: number;
  targetDistancePips: number;
  targetR: number;
  indicativeStop: number;
  indicativeTarget: number;
  outcome: 'STOP_QUOTE_TOUCH' | 'TARGET_QUOTE_TOUCH' | 'BOTH_IN_BAR' | 'TIME_MARK' | 'DATA_GAP';
  outcomeAt: string | null;
  observedMinutes: number;
  firstMissingMinute: string | null;
  indicativeGrossR: number | null;
  estimatedCommissionR: number | null;
  indicativeNetAfterCommissionR: number | null;
}
export interface DelayedEntryParityResult {
  artifact: typeof DELAY_ENTRY_PARITY_SHADOW_ARTIFACT;
  state: 'CONFIRMED' | 'NO_CONFIRMATION' | 'DATA_GAP' | 'INVALID_GEOMETRY';
  horizonMinutes: DelayEntryParityHorizon;
  confirmationPolicy: 'TWO_CONSECUTIVE_ALIGNED_COMPLETED_M1_CLOSES_WITHIN_5M';
  simulatedEntryAt: string | null;
  indicativeQuoteEntry: number | null;
  originalDirection: 'BUY' | 'SELL';
  originalRiskPips: number | null;
  originalTargetPips: number | null;
  confirmationM1Closes: number[];
  delayMinutesFromOriginalFill: number | null;
  estimatedOriginalRiskAccountCurrency: number | null;
  scenarios: DelayedStopScenario[];
  firstMissingMinute: string | null;
  quotePricingNotExecutable: true;
  noTradeAuthority: true;
  modifiesExecution: false;
  modelTrainingStatus: 'RESEARCH_ONLY';
}

const round = (n: number, digits = 5): number => Number(n.toFixed(digits));

function isVerified(
  row: VerifiedNativeMinute | undefined,
  timeMs: number,
): row is VerifiedNativeMinute {
  if (!row || row.source !== 'ctrader-broker-native') return false;
  if ([row.open, row.high, row.low, row.close].some((x) => x == null)) return false;
  const [open, high, low, close] = [row.open, row.high, row.low, row.close].map(Number);
  const first = row.first_sample_at ? new Date(row.first_sample_at).getTime() : NaN;
  const last = row.last_quote_sample_at ? new Date(row.last_quote_sample_at).getTime() : NaN;
  const total = Number(row.sample_count);
  const positive = Number(row.positive_quote_sample_count);
  return (
    [open, high, low, close].every((x) => Number.isFinite(x) && x > 0) &&
    low <= open &&
    open <= high &&
    low <= close &&
    close <= high &&
    Number.isInteger(total) &&
    total >= 1 &&
    Number.isInteger(positive) &&
    positive >= 1 &&
    positive <= total &&
    Number.isFinite(first) &&
    first >= timeMs &&
    first < timeMs + 60000 &&
    Number.isFinite(last) &&
    last >= timeMs &&
    last < timeMs + 60000
  );
}

export function evaluateDelayedEntryParity(input: {
  instrument: string;
  direction: 'BUY' | 'SELL';
  openedAt: Date;
  originalFill: number;
  originalStop: number;
  originalTarget: number;
  originalExit: number | null;
  actualGrossPnl: number | null;
  actualCommission: number | null;
  horizonMinutes: DelayEntryParityHorizon;
  candles: VerifiedNativeMinute[];
}): DelayedEntryParityResult {
  const empty = (
    state: DelayedEntryParityResult['state'],
    missing: string | null = null,
  ): DelayedEntryParityResult => ({
    artifact: DELAY_ENTRY_PARITY_SHADOW_ARTIFACT,
    state,
    horizonMinutes: input.horizonMinutes,
    confirmationPolicy: 'TWO_CONSECUTIVE_ALIGNED_COMPLETED_M1_CLOSES_WITHIN_5M',
    simulatedEntryAt: null,
    indicativeQuoteEntry: null,
    originalDirection: input.direction,
    originalRiskPips: null,
    originalTargetPips: null,
    confirmationM1Closes: [],
    delayMinutesFromOriginalFill: null,
    estimatedOriginalRiskAccountCurrency: null,
    scenarios: [],
    firstMissingMinute: missing,
    quotePricingNotExecutable: true,
    noTradeAuthority: true,
    modifiesExecution: false,
    modelTrainingStatus: 'RESEARCH_ONLY',
  });
  const { originalFill: fill, originalStop: stop, originalTarget: target, direction } = input;
  if (
    !Number.isFinite(input.openedAt.getTime()) ||
    !DELAY_ENTRY_PARITY_HORIZONS.includes(input.horizonMinutes) ||
    (direction !== 'BUY' && direction !== 'SELL') ||
    ![fill, stop, target].every((x) => Number.isFinite(x) && x > 0) ||
    (direction === 'BUY' ? !(stop < fill && fill < target) : !(target < fill && fill < stop))
  )
    return empty('INVALID_GEOMETRY');

  const sign = direction === 'BUY' ? 1 : -1;
  const pip = input.instrument.toUpperCase().endsWith('JPY') ? 0.01 : 0.0001;
  const riskDistance = Math.abs(fill - stop);
  const targetDistance = Math.abs(target - fill);
  const startMs = (Math.floor(input.openedAt.getTime() / 60000) + 1) * 60000;
  const lookup = new Map<number, VerifiedNativeMinute>();
  for (const bar of input.candles) {
    const time = new Date(bar.bucket_time).getTime();
    if (Number.isFinite(time) && !lookup.has(time)) lookup.set(time, bar);
  }

  // Nothing after a confirmation bar may affect the decision to enter.
  const alignedCloses: number[] = [];
  let signalIndex: number | null = null;
  for (let i = 0; i < DELAY_ENTRY_CONFIRMATION_WINDOW_MINUTES; i++) {
    const time = startMs + i * 60000;
    const row = lookup.get(time);
    if (!isVerified(row, time)) return empty('DATA_GAP', new Date(time).toISOString());
    alignedCloses.push(Number(row.close));
    if (
      i >= 2 &&
      sign * (alignedCloses[i - 1] - alignedCloses[i - 2]) > 0 &&
      sign * (alignedCloses[i] - alignedCloses[i - 1]) > 0
    ) {
      signalIndex = i;
      break;
    }
  }
  if (signalIndex === null) {
    const result = empty('NO_CONFIRMATION');
    result.originalRiskPips = round(riskDistance / pip, 2);
    result.originalTargetPips = round(targetDistance / pip, 2);
    result.confirmationM1Closes = alignedCloses;
    return result;
  }
  const entryMs = startMs + (signalIndex + 1) * 60000;
  const entryBar = lookup.get(entryMs);
  if (!isVerified(entryBar, entryMs)) return empty('DATA_GAP', new Date(entryMs).toISOString());
  const quoteEntry = Number(entryBar.open);
  const result = empty('CONFIRMED');
  result.simulatedEntryAt = new Date(entryMs).toISOString();
  result.indicativeQuoteEntry = quoteEntry;
  result.originalRiskPips = round(riskDistance / pip, 2);
  result.originalTargetPips = round(targetDistance / pip, 2);
  result.confirmationM1Closes = alignedCloses;
  result.delayMinutesFromOriginalFill = round((entryMs - input.openedAt.getTime()) / 60000, 2);

  // Only the *already known* broker economics estimate a fee-to-risk ratio.
  // P&L currency conversion / fee amount may change in a hypothetical fill.
  const realisedMovement =
    input.originalExit != null && Number.isFinite(input.originalExit)
      ? sign * (input.originalExit - fill)
      : NaN;
  const gross = input.actualGrossPnl;
  const commission = input.actualCommission;
  const validRisk =
    gross != null &&
    Number.isFinite(gross) &&
    gross !== 0 &&
    Number.isFinite(realisedMovement) &&
    Math.abs(realisedMovement) > pip / 10 &&
    Math.sign(realisedMovement) === Math.sign(gross)
      ? riskDistance * Math.abs(gross / realisedMovement)
      : null;
  result.estimatedOriginalRiskAccountCurrency = validRisk == null ? null : round(validRisk, 2);

  // Two fixed pre-registered scenarios; widened stop never increases the
  // amount-at-risk because the hypothetical volume shrinks proportionally.
  for (const multiple of DELAY_ENTRY_STOP_MULTIPLIERS) {
    const scenarioStopDistance = riskDistance * multiple;
    const riskParity = 1 / multiple;
    const hypotheticalStop = quoteEntry - sign * scenarioStopDistance;
    const hypotheticalTarget = quoteEntry + sign * targetDistance;
    const targetR = targetDistance / scenarioStopDistance;
    const commissionR =
      validRisk != null && validRisk > 0 && commission != null && Number.isFinite(commission)
        ? (Math.abs(commission) / validRisk) * riskParity
        : null;

    let outcome: DelayedStopScenario['outcome'] = 'TIME_MARK';
    let eventAt: string | null = null;
    let lastClose: number | null = null;
    let observed = 0;
    let missing: string | null = null;
    for (let i = 0; i < input.horizonMinutes; i++) {
      const time = entryMs + i * 60000;
      const row = lookup.get(time);
      if (!isVerified(row, time)) {
        outcome = 'DATA_GAP';
        missing = new Date(time).toISOString();
        break;
      }
      observed++;
      lastClose = Number(row.close);
      const hitStop =
        direction === 'BUY'
          ? Number(row.low) <= hypotheticalStop
          : Number(row.high) >= hypotheticalStop;
      const hitTarget =
        direction === 'BUY'
          ? Number(row.high) >= hypotheticalTarget
          : Number(row.low) <= hypotheticalTarget;
      if (hitStop || hitTarget) {
        outcome =
          hitStop && hitTarget
            ? 'BOTH_IN_BAR'
            : hitStop
              ? 'STOP_QUOTE_TOUCH'
              : 'TARGET_QUOTE_TOUCH';
        eventAt = new Date(time).toISOString();
        break;
      }
    }
    const indicativeGrossR =
      outcome === 'STOP_QUOTE_TOUCH'
        ? -1
        : outcome === 'TARGET_QUOTE_TOUCH'
          ? targetR
          : outcome === 'TIME_MARK' && lastClose != null
            ? (sign * (lastClose - quoteEntry)) / scenarioStopDistance
            : null;
    const estimatedNetR =
      indicativeGrossR != null && commissionR != null ? indicativeGrossR - commissionR : null;
    result.scenarios.push({
      stopMultiplier: multiple,
      riskParityLotMultiplier: round(riskParity, 5),
      stopDistancePips: round(scenarioStopDistance / pip, 2),
      targetDistancePips: round(targetDistance / pip, 2),
      targetR: round(targetR, 4),
      indicativeStop: round(
        hypotheticalStop,
        input.instrument.toUpperCase().endsWith('JPY') ? 5 : 7,
      ),
      indicativeTarget: round(
        hypotheticalTarget,
        input.instrument.toUpperCase().endsWith('JPY') ? 5 : 7,
      ),
      outcome,
      outcomeAt: eventAt,
      observedMinutes: observed,
      firstMissingMinute: missing,
      indicativeGrossR: indicativeGrossR == null ? null : round(indicativeGrossR, 4),
      estimatedCommissionR: commissionR == null ? null : round(commissionR, 4),
      indicativeNetAfterCommissionR: estimatedNetR == null ? null : round(estimatedNetR, 4),
    });
  }
  return result;
}
